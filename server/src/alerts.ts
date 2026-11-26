// The watcher behind phone alerts. Every minute it looks at what Launchpad already checks for
// the page (health warnings, containers, the disk) and tells the phone (notify.ts) when a
// problem starts and when it clears. A problem counts once it's there on two checks in a row,
// and has cleared once it's gone on two, so a blip or a quick restart stays quiet. What the
// phone was last told is kept, so a missed or capped alert goes out later, and only if it's
// still true then.
import { config } from './config';
import { containers } from './docker';
import { diskHealth } from './disks';
import { driveOn } from './drive';
import { currentWarnings } from './health';
import { deliver, kindOn, memory, saveMemory, topicUrl, type AlertMemory } from './notify';
import { checkDb } from './store';
import { sourceOn } from './sync';
import { dataDisk } from './system';
import type { AlertKind, ContainerInfo, DisksReport, HealthWarning, ServerStats, SourceKey } from '../../shared/types';

const MIN = 60_000;
export const CHECK_EVERY = MIN;
/** Checks in a row a problem has to be there (or gone) before the phone hears. */
export const CONFIRM = 2;
/** A container restarting this often in RESTART_WINDOW keeps restarting. */
export const RESTARTS = 3;
export const RESTART_WINDOW = 30 * MIN;
/** The disk is nearly full from this much used, and fine again below CLEAR_FULL. */
export const NEARLY_FULL = 90;
export const CLEAR_FULL = 87;

export interface Problem {
  /** Names the problem, e.g. "container:plex:stopped". The same key is the same problem. */
  key: string;
  kind: AlertKind;
  title: string;
  body?: string;
  /** What to say when it clears. */
  clear: string;
}

export interface Check {
  problems: Problem[];
  /** Keys that couldn't be looked at this time; one ending in ':' covers every key it starts. Their problems stay as they were. */
  unknown: string[];
  /** For problems now gone: what to say instead of their `clear`, or null to drop it without a word (a sync switched off isn't fixed). */
  cleared: Record<string, string | null>;
}

const empty = (): Check => ({ problems: [], unknown: [], cleared: {} });

export const isUnknown = (key: string, unknown: string[]) => unknown.some((u) => (u.endsWith(':') ? key.startsWith(u) : key === u));

function merge(...checks: Check[]): Check {
  return {
    problems: checks.flatMap((c) => c.problems),
    unknown: checks.flatMap((c) => c.unknown),
    cleared: Object.assign({}, ...checks.map((c) => c.cleared)),
  };
}

// ---------- health warnings ----------

// Not Google Tasks or the carriers: they were retired with their panels (sync.ts, enabled).
const SYNCS: SourceKey[] = ['calendar', 'gmail', 'digest', 'inbox', 'weather', 'speedtest', 'hevy'];

/**
 * What health.ts warns about, as problems. Only Launchpad's own wording goes in the message, not
 * the error behind it, which can hold an address or worse. `off` says a sync (or Drive) is
 * switched off now, so its warning going away isn't news.
 */
export function healthCheck(warnings: HealthWarning[], off: (key: HealthWarning['key']) => boolean): Check {
  const c = empty();
  for (const w of warnings) {
    c.problems.push({ key: `health:${w.key}`, kind: 'health', title: `${w.name}: ${w.text}`, body: 'Launchpad’s Server view has the details.', clear: `${w.name}: back to normal` });
  }
  for (const k of [...SYNCS, 'drive'] as const) if (off(k)) c.cleared[`health:${k}`] = null;
  // Retired syncs (Google Tasks, the carriers) and the news sync that became the digest's: a warning
  // still open for one goes without a word.
  c.cleared['health:tasks'] = null;
  c.cleared['health:carriers'] = null;
  c.cleared['health:news'] = null;
  return c;
}

function readHealth(): Check {
  try {
    return healthCheck(currentWarnings(), (k) => (k === 'drive' ? !driveOn() : SYNCS.includes(k as SourceKey) && !sourceOn(k as SourceKey)));
  } catch {
    // The store itself can't be read: say so, and leave the rest as they were.
    const err = checkDb();
    const c = empty();
    c.unknown.push('health:');
    if (err) c.problems.push({ key: 'health:database', kind: 'health', title: 'Database: Can’t be read', body: 'Launchpad’s Server view has the details.', clear: 'Database: back to normal' });
    return c;
  }
}

// ---------- containers ----------

/**
 * At most how many seconds a container has been up, from Docker's wording ("Up 5 seconds",
 * "Up About a minute (healthy)"). Null when it isn't up, or it's been up too long to matter.
 */
export function upAtMost(status: string): number | null {
  const m = /^Up (Less than a second|(\d+) seconds?|About a minute|(\d+) minutes?)\b/.exec(status);
  if (!m) return null;
  if (m[1] === 'Less than a second') return 1;
  if (m[2]) return Number(m[2]) + 1;
  if (m[1] === 'About a minute') return 120;
  return (Number(m[3]) + 1) * 60;
}

export interface ContainerWatch {
  list: ContainerInfo[] | null;
  error: string | null;
  /** DOCKER_HOST is set. */
  configured: boolean;
  /** When the last check was, and which containers it saw; null on the first check since starting. */
  last: { at: number; names: Set<string> } | null;
}

/**
 * Containers that stopped (after being seen running), turned unhealthy or keep restarting.
 * A restart is seen as the state "restarting", or as a container that's been up for less time
 * than since the last check. Launchpad's own container is left out: it can't report itself.
 */
export function containerCheck(w: ContainerWatch, mem: AlertMemory['containers'], isOpen: (key: string) => boolean, now: number): { check: Check; memory: AlertMemory['containers'] } {
  const c = empty();
  if (!w.configured) return { check: { ...c, unknown: ['container:'] }, memory: mem };
  if (!w.list) {
    c.unknown.push('container:');
    c.problems.push({ key: 'container:docker', kind: 'containers', title: 'Can’t reach Docker', body: 'The container list isn’t coming through, so containers aren’t being watched.', clear: 'Docker is reachable again' });
    return { check: c, memory: mem };
  }
  const list = w.list.filter((x) => !x.self);
  const names = new Set(list.map((x) => x.name));
  const running = new Set(mem.running.filter((n) => names.has(n)));
  const restarts: Record<string, number[]> = {};
  const since = w.last ? (now - w.last.at) / 1000 : null;
  for (const x of list) {
    const up = upAtMost(x.status);
    const restarted = x.state === 'restarting' || (x.state === 'running' && since !== null && up !== null && up <= since && !!w.last?.names.has(x.name));
    const times = (mem.restarts[x.name] ?? []).filter((t) => now - t < RESTART_WINDOW);
    if (restarted) times.push(now);
    if (times.length) restarts[x.name] = times;

    if (x.state === 'running' || x.state === 'restarting') running.add(x.name);
    if ((x.state === 'exited' || x.state === 'dead') && running.has(x.name)) {
      c.problems.push({ key: `container:${x.name}:stopped`, kind: 'containers', title: `${x.name} stopped`, body: `Docker says: ${x.status}.`, clear: `${x.name} is running again` });
    }
    if (/\(unhealthy\)/.test(x.status)) {
      c.problems.push({ key: `container:${x.name}:unhealthy`, kind: 'containers', title: `${x.name} is unhealthy`, body: 'Its health check keeps failing.', clear: `${x.name} is healthy again` });
    }
    const key = `container:${x.name}:restarting`;
    if (times.length >= (isOpen(key) ? 1 : RESTARTS)) {
      c.problems.push({ key, kind: 'containers', title: `${x.name} keeps restarting`, body: `${times.length} restart${times.length === 1 ? '' : 's'} in the last ${RESTART_WINDOW / MIN} minutes.`, clear: `${x.name} has stopped restarting` });
    }
  }
  return { check: c, memory: { running: [...running].sort(), restarts } };
}

/** For problems about containers no longer in the list: they were removed, not fixed. */
function removedNote(open: string[], list: ContainerInfo[] | null): Record<string, string> {
  if (!list) return {};
  const names = new Set(list.map((x) => x.name));
  const out: Record<string, string> = {};
  for (const key of open) {
    const m = /^container:(.+):(stopped|unhealthy|restarting)$/.exec(key);
    if (m && !names.has(m[1])) out[key] = `${m[1]} was removed`;
  }
  return out;
}

// ---------- disks ----------

const fmtBytes = (b: number) => (b >= 1e12 ? `${(b / 1e12).toFixed(1)} TB` : b >= 1e9 ? `${Math.round(b / 1e9)} GB` : `${Math.max(0, Math.round(b / 1e6))} MB`);

/** The disk Launchpad's data is on nearly full, and disks whose SMART says they're failing. */
export function diskCheck(space: ServerStats['disk'], smart: DisksReport | null, isOpen: (key: string) => boolean): Check {
  const c = empty();
  if (!space || !space.totalBytes) c.unknown.push('disk:space');
  else {
    const pct = Math.round((space.usedBytes / space.totalBytes) * 100);
    const free = space.totalBytes - space.usedBytes;
    if (pct >= (isOpen('disk:space') ? CLEAR_FULL : NEARLY_FULL)) {
      c.problems.push({ key: 'disk:space', kind: 'disks', title: `Disk nearly full: ${pct}% used`, body: `${fmtBytes(free)} left on the disk Launchpad’s data is on.`, clear: 'Disk space is fine again' });
    } else c.cleared['disk:space'] = `Disk space is fine again: ${pct}% used, ${fmtBytes(free)} free`;
  }
  if (!smart || smart.status !== 'ok') c.unknown.push('disk:smart:');
  else {
    for (const d of smart.disks) {
      const key = `disk:smart:${d.name}`;
      if (d.level === 'unknown') c.unknown.push(key);
      else if (d.level === 'bad') {
        c.problems.push({ key, kind: 'disks', title: `${d.name}${d.model ? ` (${d.model})` : ''} is failing`, body: d.problems.slice(0, 3).join(' '), clear: `${d.name} looks healthy again` });
      }
    }
  }
  return c;
}

// ---------- deciding what to send ----------

/** How many checks in a row each problem has been there, or gone. Kept in memory only. */
export type Counters = Map<string, { seen: number; gone: number }>;

export interface Plan {
  start: Problem[];
  clear: { key: string; kind: AlertKind; title: string }[];
  /** Open problems to drop without a word: their kind was switched off, or they went away in a way that isn't news. */
  forget: string[];
}

/** What a check means for the phone, given what it was last told (`open`). Updates `counters`. */
export function plan(check: Check, open: AlertMemory['open'], counters: Counters, on: (kind: AlertKind) => boolean): Plan {
  const out: Plan = { start: [], clear: [], forget: [] };
  const present = new Map(check.problems.filter((p) => on(p.kind)).map((p) => [p.key, p]));
  for (const [key, p] of present) {
    const n = counters.get(key) ?? { seen: 0, gone: 0 };
    n.seen++;
    n.gone = 0;
    counters.set(key, n);
    if (!open[key] && n.seen >= CONFIRM) out.start.push(p);
  }
  for (const [key, o] of Object.entries(open)) {
    if (present.has(key)) continue;
    if (!on(o.kind)) {
      out.forget.push(key);
      counters.delete(key);
      continue;
    }
    if (isUnknown(key, check.unknown)) continue;
    const n = counters.get(key) ?? { seen: 0, gone: 0 };
    n.gone++;
    n.seen = 0;
    counters.set(key, n);
    if (n.gone < CONFIRM) continue;
    const said = check.cleared[key];
    if (said === null) out.forget.push(key);
    else out.clear.push({ key, kind: o.kind, title: said ?? o.clear });
  }
  // Problems seen once and gone again before they counted.
  for (const key of [...counters.keys()]) if (!present.has(key) && !open[key] && !isUnknown(key, check.unknown)) counters.delete(key);
  return out;
}

/** Tell the phone what the plan says, new problems first, stopping at the first send that doesn't go. */
export async function carryOut(p: Plan): Promise<void> {
  const m = memory();
  if (p.forget.length) {
    for (const k of p.forget) delete m.open[k];
    saveMemory();
  }
  const stop = (r: string) => r === 'failed' || r === 'waiting' || r === 'no-topic';
  for (const s of p.start) {
    const r = await deliver({ key: s.key, kind: s.kind, type: 'problem', title: s.title, body: s.body }, (mm) => {
      mm.open[s.key] = { kind: s.kind, title: s.title, clear: s.clear, at: new Date().toISOString() };
    });
    if (stop(r)) return;
  }
  for (const c of p.clear) {
    const was = m.open[c.key]?.title;
    const r = await deliver({ key: c.key, kind: c.kind, type: 'fixed', title: c.title, body: was ? `It was: ${was}` : undefined }, (mm) => {
      delete mm.open[c.key];
    });
    if (stop(r)) return;
  }
}

// ---------- the loop ----------

const counters: Counters = new Map();
let last: ContainerWatch['last'] = null;
let checking = false;

/** Give up on a source that takes longer than this; its problems stay as they were. */
const SOURCE_TIMEOUT = 45_000;
const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), SOURCE_TIMEOUT).unref())]);

/** One look at everything, and whatever it means for the phone. Nothing happens until a topic is set. */
export async function checkNow(): Promise<void> {
  if (checking || !topicUrl()) return;
  checking = true;
  try {
    const m = memory();
    const now = Date.now();
    const isOpen = (k: string) => !!m.open[k];
    const docker = await within(containers(), { list: null, error: 'Timed out' });
    const watch: ContainerWatch = { ...docker, configured: !!config.dockerHost, last };
    const cont = containerCheck(watch, m.containers, isOpen, now);
    // SMART runs over SSH, so only when disk alerts are on; diskHealth keeps it for 30 minutes.
    const smart = kindOn('disks') ? await within(diskHealth(), null) : null;
    const check = merge(readHealth(), cont.check, diskCheck(dataDisk(), smart, isOpen), { ...empty(), cleared: removedNote(Object.keys(m.open), docker.list) });
    if (docker.list) last = { at: now, names: new Set(docker.list.map((x) => x.name)) };
    if (JSON.stringify(cont.memory) !== JSON.stringify(m.containers)) {
      m.containers = cont.memory;
      saveMemory();
    }
    await carryOut(plan(check, m.open, counters, kindOn));
  } catch (e) {
    console.error('[alerts] check failed:', (e as Error).message);
  } finally {
    checking = false;
  }
}

let started = false;
export function startAlerts(): void {
  if (started) return;
  started = true;
  setInterval(() => void checkNow(), CHECK_EVERY).unref();
}

/** For tests: start counting afresh. */
export function resetWatchForTests(): void {
  counters.clear();
  last = null;
  checking = false;
}
