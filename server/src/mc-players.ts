// The Minecraft tab's Players and meters. Who's online comes from a Server List Ping,
// the same question the multiplayer screen asks, sent from the host itself through the
// SSH connection (so it works with the port closed to the outside), or straight to the
// SSH host when the connection won't forward. When the ping doesn't name everyone (it
// shows at most 12, and servers can hide them), the console's `list` fills in, read
// back from the log. Ops and the whitelist come from ops.json and whitelist.json.
//
// The meters are the Java process's memory and CPU from /proc, and TPS/MSPT where the
// server can say: Spark's `spark tps`, Paper and Spigot's `tps` and `mspt`, or vanilla
// 1.20.3+'s `tick query`. Those are typed into the console, so they're asked at most
// every couple of minutes; a server that can't answer is left alone for a while.
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { config } from './config';
import { askConsole, findMc, plainLog, readSmall, serverFacts, ssh, typeInto } from './minecraft';
import { FileError, sftpSession } from './shell';
import type { McMeters, McPlayer, McPlayerAction, McPlayers, McStatus } from '../../shared/types';


// ---------- Server List Ping ----------

export function varint(n: number): Buffer {
  const out: number[] = [];
  let v = n >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

/** A varint at `at`, or null when the buffer ends first. */
export function readVarint(buf: Buffer, at: number): { value: number; size: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buf.length) return null;
    const b = buf[at + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value: value >>> 0, size: i + 1 };
  }
  throw new Error('That isn’t a Minecraft server’s answer.');
}

const packet = (id: number, body: Buffer) => {
  const data = Buffer.concat([varint(id), body]);
  return Buffer.concat([varint(data.length), data]);
};

/** Handshake (next state: status), then the status request. */
export function pingRequest(host: string, port: number): Buffer {
  const h = Buffer.from(host, 'utf8');
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port);
  // Protocol -1: "whatever you speak", which every server since 1.7 answers.
  const handshake = packet(0x00, Buffer.concat([varint(-1), varint(h.length), h, portBuf, varint(1)]));
  return Buffer.concat([handshake, packet(0x00, Buffer.alloc(0))]);
}

/** The status JSON once a whole response packet is in `buf`; null while more is to come. */
export function readPingResponse(buf: Buffer): unknown | null {
  const len = readVarint(buf, 0);
  if (!len || buf.length < len.size + len.value) return null;
  let at = len.size;
  const id = readVarint(buf, at);
  if (!id || id.value !== 0) throw new Error('That isn’t a Minecraft server’s answer.');
  at += id.size;
  const strLen = readVarint(buf, at);
  if (!strLen) throw new Error('That isn’t a Minecraft server’s answer.');
  at += strLen.size;
  return JSON.parse(buf.subarray(at, at + strLen.value).toString('utf8'));
}

export interface Ping {
  online: number;
  max: number;
  /** Real players the ping named; servers hiding them send none or "Anonymous Player". */
  sample: { name: string; uuid: string | null }[];
  version: string | null;
}

export const PLAYER_NAME = /^[.*]?[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const NIL = /^0{8}-?0{4}-?0{4}-?0{4}-?0{12}$/;

/** "0123…" → "0123…-…" with dashes, or null. */
export const dashed = (u: unknown): string | null => {
  if (typeof u !== 'string' || !UUID.test(u) || NIL.test(u)) return null;
  const h = u.replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

export function parsePing(v: unknown): Ping {
  const o = (v ?? {}) as { players?: { online?: unknown; max?: unknown; sample?: unknown }; version?: { name?: unknown } };
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.round(x) : 0);
  const sample = Array.isArray(o.players?.sample) ? o.players!.sample : [];
  return {
    online: num(o.players?.online),
    max: num(o.players?.max),
    // Some servers put lines of text in the sample instead of players; those have no real id.
    sample: sample.flatMap((p: { name?: unknown; id?: unknown }) => (typeof p?.name === 'string' && PLAYER_NAME.test(p.name) && dashed(p.id) ? [{ name: p.name, uuid: dashed(p.id) }] : [])),
    version: typeof o.version?.name === 'string' ? plainLog(o.version.name).slice(0, 80) : null,
  };
}

/** A stream from the host to host:port through the SSH connection. */
async function forward(host: string, port: number): Promise<Duplex> {
  const { conn } = await sftpSession();
  return new Promise((resolve, reject) => conn.forwardOut('127.0.0.1', 0, host, port, (e, ch) => (e ? reject(e) : resolve(ch))));
}

function direct(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

export function askPing(stream: Duplex, host: string, port: number, timeoutMs: number): Promise<Ping> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (e: Error | null, p?: Ping) => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      if (e) reject(e);
      else resolve(p!);
    };
    const timer = setTimeout(() => done(new Error('The server didn’t answer the ping.')), timeoutMs);
    stream.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length > 1024 * 1024) return done(new Error('The server’s answer was too long.'));
      try {
        const json = readPingResponse(buf);
        if (json !== null) done(null, parsePing(json));
      } catch (e) {
        done(e as Error);
      }
    });
    stream.on('error', (e: Error) => done(e));
    stream.on('close', () => done(new Error('The server closed the connection.')));
    stream.write(pingRequest(host, port));
  });
}

/** Ping the server: from the host through SSH, or straight to the SSH host when forwarding is off. */
export async function ping(ip: string | null, port: number, timeoutMs = 4000): Promise<Ping> {
  const host = ip ?? '127.0.0.1';
  try {
    return await askPing(await forward(host, port), host, port, timeoutMs);
  } catch (e) {
    // "administratively prohibited": AllowTcpForwarding is off. Try the host's own address.
    if (!/prohibited|open failed|forward/i.test((e as Error).message)) throw e;
    const to = ip ?? config.ssh.host;
    return askPing(await direct(to, port), to, port, timeoutMs);
  }
}

// ---------- the console's list ----------

/** The answer to `list` in the console's lines: vanilla, Paper and Fabric, older Bukkit, and EssentialsX. */
export function parseList(msgs: string[]): { online: number; max: number; names: string[] } | null {
  const HEAD = /There (?:are|is) (\d+)(?: of a max(?:imum)? of | out of maximum |\/)(\d+) players? online[.:]?\s*(.*)$/i;
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i--) if (HEAD.test(msgs[i])) { at = i; break; }
  if (at < 0) return null;
  const m = HEAD.exec(msgs[at])!;
  const online = Number(m[1]);
  const max = Number(m[2]);
  const names: string[] = [];
  const take = (text: string) => {
    // EssentialsX lists by group, "Admins: Steve, [AFK]Alex", and marks nicknames with ~.
    const body = /^[A-Za-z0-9 _-]{1,32}:\s/.test(text) ? text.replace(/^[^:]*:\s*/, '') : text;
    for (const raw of body.split(',')) {
      const n = raw.replace(/\[[^\]]*\]/g, '').replace(/\s*\([0-9a-f-]{32,36}\)\s*$/i, '').replace(/^[~\s]+|\s+$/g, '');
      if (PLAYER_NAME.test(n) && !names.includes(n)) names.push(n);
    }
  };
  if (m[3].trim()) take(m[3]);
  // Names on the lines that follow (Bukkit, Essentials), until there are enough.
  for (let i = at + 1; i < msgs.length && i <= at + 12 && names.length < online; i++) {
    if (HEAD.test(msgs[i])) break;
    take(msgs[i]);
  }
  return { online, max, names };
}

// ---------- ops and the whitelist ----------

export function parseJsonList(text: string | null): { name: string; uuid: string | null }[] {
  if (!text) return [];
  try {
    const v = JSON.parse(text);
    if (!Array.isArray(v)) return [];
    return v.flatMap((x) => (x && typeof x.name === 'string' && PLAYER_NAME.test(x.name) ? [{ name: x.name, uuid: dashed(x.uuid) }] : []));
  } catch {
    return [];
  }
}

async function jsonLists(s: McStatus) {
  const { sftp } = await sftpSession();
  const read = (f: string, max?: number) => readSmall(sftp, path.posix.join(s.dir, f), max).catch(() => null);
  const [ops, whitelist, cache] = await Promise.all([read('ops.json'), read('whitelist.json'), read('usercache.json', 2 * 1024 * 1024)]);
  return { ops: parseJsonList(ops), whitelist: parseJsonList(whitelist), known: parseJsonList(cache) };
}

const lower = (s: string) => s.toLowerCase();

/**
 * The console's last answer to `list`, so a server whose ping hides names is only asked
 * again when the ping's count changes, and one that doesn't answer pings at most once a minute.
 */
const lastList = new Map<string, { at: number; online: number; max: number; names: string[] }>();
const LIST_AGAIN = 60_000;

export async function players(id: string, fresh: boolean): Promise<McPlayers> {
  const s = await findMc(id);
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder. Save it with its folder to see its players.`, 409);
  const [facts, lists] = await Promise.all([serverFacts(s), jsonLists(s)]);
  const ops = new Set(lists.ops.map((p) => lower(p.name)));
  const white = new Set(lists.whitelist.map((p) => lower(p.name)));
  const uuidOf = (name: string) => [...lists.known, ...lists.ops, ...lists.whitelist].find((p) => lower(p.name) === lower(name))?.uuid ?? null;
  const base = { running: s.running, whitelist: lists.whitelist, whitelistOn: facts.whitelistOn, at: Date.now() };
  if (!s.running) return { ...base, online: null, max: null, players: [], version: null, note: null };

  let p: Ping | null = null;
  let pingError = '';
  try {
    p = await ping(facts.ip, facts.port);
  } catch (e) {
    pingError = (e as Error).message;
  }
  let names = p?.sample.map((x) => x.name) ?? [];
  let note: string | null = null;
  const short = !p || p.sample.length < p.online;
  if (short && s.attached) {
    const prev = lastList.get(id);
    const still = prev && (p ? prev.online === p.online : Date.now() - prev.at < LIST_AGAIN);
    if (!fresh && prev && still) {
      names = prev.names;
      p ??= { online: prev.online, max: prev.max, sample: [], version: null };
    } else {
      const got = parseList(await askConsole(s, 'list', (m) => !!parseList(m) && parseList(m)!.names.length >= parseList(m)!.online, 3000).catch(() => []));
      if (got) {
        names = got.names;
        p ??= { online: got.online, max: got.max, sample: [], version: null };
        lastList.set(id, { at: Date.now(), online: got.online, max: got.max, names });
      }
    }
  }
  if (!p) note = `The server didn’t answer a ping on port ${facts.port}${pingError ? ` (${pingError})` : ''}${s.attached ? ', or its list.' : ', and it isn’t in tmux or screen, so Launchpad can’t ask its console.'}`;
  else if (names.length < p.online) note = s.attached ? `The server named ${names.length} of the ${p.online} players online.` : `The server only shares ${names.length} of ${p.online} names, and it isn’t in tmux or screen, so Launchpad can’t ask its console for the rest.`;
  const sampleIds = new Map(p?.sample.map((x) => [lower(x.name), x.uuid]) ?? []);
  const list: McPlayer[] = names.map((name) => ({ name, uuid: sampleIds.get(lower(name)) ?? uuidOf(name), op: ops.has(lower(name)), whitelisted: white.has(lower(name)) }));
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { ...base, online: p?.online ?? null, max: p?.max ?? null, players: list, version: p?.version ?? null, note };
}

/** The console command for a button on a player. Names are checked, so nothing else can ride along. */
export function playerCommand(action: unknown, name: unknown, to?: unknown): string {
  if (typeof name !== 'string' || !PLAYER_NAME.test(name)) throw new FileError('That isn’t a player’s name.');
  switch (action as McPlayerAction) {
    case 'kick':
      return `kick ${name}`;
    case 'op':
      return `op ${name}`;
    case 'deop':
      return `deop ${name}`;
    case 'whitelist-add':
      return `whitelist add ${name}`;
    case 'whitelist-remove':
      return `whitelist remove ${name}`;
    case 'tp':
      if (typeof to !== 'string' || !PLAYER_NAME.test(to)) throw new FileError('Pick who to teleport.');
      if (lower(to) === lower(name)) throw new FileError('Pick someone else to teleport there.');
      return `tp ${to} ${name}`;
    default:
      throw new FileError('Launchpad doesn’t know that action.');
  }
}

export async function playerAction(id: string, body: { action?: unknown; name?: unknown; to?: unknown }): Promise<void> {
  const cmd = playerCommand(body.action, body.name, body.to);
  const s = await findMc(id);
  await typeInto(s, cmd);
  lastList.delete(id);
}

// ---------- meters ----------

/** The process's memory, two CPU readings a second apart, and how long it has been up. */
export function metersScript(pid: number): string {
  const p = String(Math.floor(pid));
  const cpu = `sed 's/^.*) //' /proc/${p}/stat 2>/dev/null | cut -d' ' -f12,13`;
  return [
    `[ -r /proc/${p}/stat ] || { echo gone; exit 0; }`,
    `echo "rss $(ps -o rss= -p ${p} 2>/dev/null | tr -d ' ')"`,
    `echo "up $(ps -o etimes= -p ${p} 2>/dev/null | tr -d ' ')"`,
    `echo "a $(date +%s%N) $(${cpu})"`,
    'sleep 1',
    `echo "b $(date +%s%N) $(${cpu})"`,
    'echo "hz $(getconf CLK_TCK 2>/dev/null)"',
    'echo "cores $(nproc 2>/dev/null)"',
  ].join('\n');
}

export function parseMeters(out: string): Pick<McMeters, 'rss' | 'cpu' | 'cores' | 'uptime'> | null {
  if (/^gone$/m.test(out)) return null;
  const v: Record<string, string[]> = {};
  for (const l of out.split('\n')) {
    const [k, ...rest] = l.trim().split(/\s+/);
    if (k) v[k] = rest;
  }
  const n = (x: string | undefined) => (x !== undefined && /^\d+$/.test(x) ? Number(x) : null);
  const rss = n(v.rss?.[0]);
  const up = n(v.up?.[0]);
  const hz = n(v.hz?.[0]) || 100;
  const cores = n(v.cores?.[0]);
  let cpu: number | null = null;
  const [t1, u1, s1] = (v.a ?? []).map(n);
  const [t2, u2, s2] = (v.b ?? []).map(n);
  if (u1 !== null && s1 !== null && u2 !== null && s2 !== null && u1 !== undefined && u2 !== undefined) {
    // date +%N isn't everywhere (busybox prints N): then the second it slept.
    const secs = t1 && t2 && t2 > t1 && String(v.a[0]).length > 12 ? (t2 - t1) / 1e9 : 1;
    const used = (u2 + s2! - (u1 + s1!)) / hz;
    cpu = Math.max(0, Math.min(100, (used / secs / (cores || 1)) * 100));
    cpu = Math.round(cpu * 10) / 10;
  }
  return { rss: rss === null ? null : rss * 1024, cpu, cores, uptime: up };
}

/** TPS and MSPT from what the console answered to spark tps, tps and mspt, or tick query. */
export function parseTps(msgs: string[], from: 'spark' | 'paper' | 'vanilla'): { tps: number | null; mspt: number | null } {
  const text = msgs.map((m) => m.replace(/^\[⚡\]\s*/, '')).join('\n');
  const num = (s: string | undefined) => (s === undefined ? null : Number(s.replace(/^\*/, '')));
  if (from === 'spark') {
    const tps = /TPS from last[^\n]*:\s*\n?\s*\*?([\d.]+)/i.exec(text);
    // Newer Spark: min/med/95%ile/max (the median is the one to show); older: avg/min/max.
    const durations = /Tick durations\s*\(([^)]*)\)[^\n]*:\s*\n?\s*([\d./]+)/i.exec(text);
    const cols = durations?.[1].split('/') ?? [];
    const vals = durations?.[2].split('/') ?? [];
    const pick = cols.findIndex((c) => /^(med|avg)/i.test(c.trim()));
    return { tps: num(tps?.[1]), mspt: pick >= 0 ? num(vals[pick]) : null };
  }
  if (from === 'paper') {
    const tps = /TPS from last[^:]*:\s*\*?([\d.]+)/i.exec(text);
    // mspt: "◴ 1.4/0.9/5.6, …" – average, min, max of the last 5 seconds.
    const mspt = /(?:^|\n)\D{0,3}?([\d.]+)\/[\d.]+\/[\d.]+\s*,/.exec(text);
    return { tps: num(tps?.[1]), mspt: num(mspt?.[1]) };
  }
  const rate = /Target tick rate:\s*([\d.]+)/i.exec(text);
  const avg = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(text);
  const mspt = num(avg?.[1]);
  const target = num(rate?.[1]) ?? 20;
  return { tps: mspt === null ? null : Math.round(Math.min(target, 1000 / Math.max(mspt, 0.001)) * 10) / 10, mspt };
}

const UNKNOWN = /Unknown or incomplete command|Unknown command|Incorrect argument for command/i;

/** How often TPS is asked, and how long a server that can't answer is left alone. */
const TPS_EVERY = 2 * 60_000;
const TPS_UNKNOWN_FOR = 30 * 60_000;

interface TpsState {
  at: number;
  tps: number | null;
  mspt: number | null;
  from: McMeters['tpsFrom'];
  /** Can't answer until then. */
  quietUntil: number;
  asking: boolean;
}
const tpsState = new Map<string, TpsState>();

async function askTps(s: McStatus): Promise<void> {
  const st = tpsState.get(s.id) ?? { at: 0, tps: null, mspt: null, from: null, quietUntil: 0, asking: false };
  if (st.asking) return;
  tpsState.set(s.id, { ...st, asking: true });
  let next: TpsState = { ...st, asking: false, at: Date.now() };
  try {
    const facts = await serverFacts(s);
    const from: 'spark' | 'paper' | 'vanilla' = facts.spark ? 'spark' : facts.bukkit ? 'paper' : 'vanilla';
    let got: { tps: number | null; mspt: number | null } = { tps: null, mspt: null };
    let unknown = false;
    if (from === 'spark') {
      const m = await askConsole(s, 'spark tps', (x) => UNKNOWN.test(x.join('\n')) || parseTps(x, 'spark').mspt !== null, 5000);
      unknown = UNKNOWN.test(m.join('\n'));
      got = parseTps(m, 'spark');
    } else if (from === 'paper') {
      const m = await askConsole(s, 'tps', (x) => UNKNOWN.test(x.join('\n')) || parseTps(x, 'paper').tps !== null, 4000);
      unknown = UNKNOWN.test(m.join('\n'));
      got = parseTps(m, 'paper');
      // mspt is Paper's own; Spigot doesn't have it.
      if (facts.paper && got.tps !== null) {
        const m2 = await askConsole(s, 'mspt', (x) => UNKNOWN.test(x.join('\n')) || parseTps(x, 'paper').mspt !== null, 4000);
        got.mspt = parseTps(m2, 'paper').mspt;
      }
    } else {
      const m = await askConsole(s, 'tick query', (x) => UNKNOWN.test(x.join('\n')) || parseTps(x, 'vanilla').mspt !== null, 4000);
      unknown = UNKNOWN.test(m.join('\n'));
      got = parseTps(m, 'vanilla');
    }
    if (got.tps === null && got.mspt === null) next = { ...next, tps: null, mspt: null, from: null, quietUntil: Date.now() + (unknown ? TPS_UNKNOWN_FOR : TPS_EVERY * 3) };
    else next = { ...next, ...got, from };
  } catch {
    next = { ...next, quietUntil: Date.now() + TPS_EVERY };
  }
  tpsState.set(s.id, next);
}

export async function meters(id: string, wantTps: boolean): Promise<McMeters> {
  const s = await findMc(id);
  const empty: McMeters = { running: s.running, rss: null, cpu: null, cores: null, uptime: null, online: null, max: null, tps: null, mspt: null, tpsFrom: null, tpsAt: null, at: Date.now() };
  if (!s.running || !s.pid) return empty;
  const [proc, count] = await Promise.all([
    ssh(metersScript(s.pid), 10_000, `Reading ${s.name}’s memory and CPU`).then((r) => parseMeters(r.stdout)),
    s.dir ? serverFacts(s).then((f) => ping(f.ip, f.port, 2500)).catch(() => null) : Promise.resolve(null),
  ]);
  // TPS is typed into the console, so only for a server that's been up a minute, and not too often.
  const st = tpsState.get(s.id);
  const now = Date.now();
  if (wantTps && s.attached && s.dir && (proc?.uptime ?? 0) > 60 && (!st || (now - st.at > TPS_EVERY && now > st.quietUntil))) void askTps(s);
  const fresh = st && st.from && now - st.at < TPS_EVERY * 3 ? st : null;
  return {
    ...empty,
    ...(proc ?? {}),
    online: count?.online ?? null,
    max: count?.max ?? null,
    tps: fresh?.tps ?? null,
    mspt: fresh?.mspt ?? null,
    tpsFrom: fresh?.from ?? null,
    tpsAt: fresh?.at ?? null,
  };
}


