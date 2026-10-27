// Background sync: pulls Google data and carrier status on a schedule and
// records success/failure per source for the sync dot.
import { randomUUID } from 'node:crypto';
import { googleConfigured } from './config';
import { fetchCalendar, fetchTasks, GoogleError, scanGmail } from './google';
import { store, updatePackages } from './store';
import { canTrack, track, TrackingUnavailable } from './tracking';
import type { Package, SourceKey } from '../../shared/types';

const MIN = 60_000;
const EVERY: Record<SourceKey, number> = {
  calendar: 5 * MIN,
  tasks: 2 * MIN,
  gmail: 10 * MIN,
  carriers: 20 * MIN,
};
const ARCHIVE_AFTER = 3 * 24 * 60 * MIN;

const running = new Map<SourceKey, Promise<void>>();

function enabled(key: SourceKey): boolean {
  if (key === 'carriers') return true;
  return googleConfigured() && !!store.google() && store.prefs().sources[key];
}

async function runCalendar() {
  store.setCalendar(await fetchCalendar());
}

async function runTasks() {
  store.setTasks(await fetchTasks());
}

async function runGmail() {
  const finds = await scanGmail();
  if (!finds.length) return;
  const added: Package[] = [];
  updatePackages((pkgs) => {
    const known = new Set(pkgs.map((p) => p.number));
    for (const f of finds) {
      if (known.has(f.number)) continue;
      known.add(f.number);
      added.push(newPackage({ number: f.number, carrier: f.carrier, label: f.label, source: 'gmail' }));
    }
    return [...added, ...pkgs];
  });
  for (const p of added) await refreshPackage(p.id).catch(() => {});
}

async function runCarriers() {
  // Auto-archive packages delivered more than 3 days ago.
  updatePackages((pkgs) =>
    pkgs.map((p) => (!p.archived && p.deliveredAt && Date.now() - Date.parse(p.deliveredAt) > ARCHIVE_AFTER ? { ...p, archived: true } : p)),
  );
  const active = store.packages().filter((p) => !p.archived && p.stage < 3 && canTrack(p.carrier));
  const errors: string[] = [];
  for (const p of active) {
    try {
      await refreshPackage(p.id);
    } catch (e) {
      errors.push(`${p.label}: ${(e as Error).message}`);
    }
  }
  if (active.length && errors.length === active.length) throw new Error(errors[0]);
}

const JOBS: Record<SourceKey, () => Promise<void>> = {
  calendar: runCalendar,
  tasks: runTasks,
  gmail: runGmail,
  carriers: runCarriers,
};

export function runSource(key: SourceKey): Promise<void> {
  const existing = running.get(key);
  if (existing) return existing;
  if (!enabled(key)) return Promise.resolve();
  const p = (async () => {
    const prev = store.sync()[key];
    const at = new Date().toISOString();
    try {
      await JOBS[key]();
      store.setSync(key, { lastSuccess: new Date().toISOString(), lastAttempt: at, lastError: null });
    } catch (e) {
      const err = e as Error;
      console.error(`[sync] ${key} failed:`, err.message);
      store.setSync(key, { ...prev, lastAttempt: at, lastError: err.message });
      if (err instanceof GoogleError && err.authExpired) store.clearGoogle();
    } finally {
      running.delete(key);
    }
  })();
  running.set(key, p);
  return p;
}

/** Run a source now unless it succeeded within `minAgeMs`. */
export function runIfStale(key: SourceKey, minAgeMs: number): Promise<void> {
  const last = store.sync()[key].lastAttempt;
  if (last && Date.now() - Date.parse(last) < minAgeMs) return Promise.resolve();
  return runSource(key);
}

export function runAllGoogle(): Promise<void> {
  return Promise.all((['calendar', 'tasks', 'gmail'] as const).map(runSource)).then(() => {});
}

export function startScheduler(): void {
  let delay = 2000;
  for (const key of Object.keys(EVERY) as SourceKey[]) {
    // Stagger the first runs so startup isn't one burst of requests.
    setTimeout(() => {
      runSource(key);
      setInterval(() => runSource(key), EVERY[key]);
    }, delay);
    delay += 3000;
  }
}

// ---------- packages ----------

export function newPackage(p: { number: string; carrier: string; label: string; source: Package['source'] }): Package {
  return {
    id: randomUUID(),
    label: p.label,
    carrier: p.carrier,
    number: p.number,
    stage: 0,
    exception: false,
    statusText: canTrack(p.carrier) ? 'Info received · waiting for first scan' : 'Tracking on the carrier’s site',
    source: p.source,
    isNew: p.source === 'gmail',
    timeline: [],
    deliveredAt: null,
    archived: false,
    createdAt: new Date().toISOString(),
    lastChecked: null,
    trackingError: null,
  };
}

export async function refreshPackage(id: string): Promise<void> {
  const pkg = store.packages().find((p) => p.id === id);
  if (!pkg) return;
  let patch: Partial<Package>;
  try {
    const r = await track(pkg);
    patch = r
      ? { ...r, lastChecked: new Date().toISOString(), trackingError: null }
      : { lastChecked: new Date().toISOString(), trackingError: 'No tracking updates yet.' };
  } catch (e) {
    patch = { lastChecked: new Date().toISOString(), trackingError: (e as Error).message };
    if (!(e instanceof TrackingUnavailable)) {
      updatePackages((pkgs) => pkgs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
      throw e;
    }
  }
  updatePackages((pkgs) => pkgs.map((p) => (p.id === id ? { ...p, ...patch } : p)));
}
