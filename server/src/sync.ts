// Background sync: pulls Google data and carrier status on a schedule and
// records success/failure per source for the sync dot.
import { randomUUID } from 'node:crypto';
import { googleConfigured } from './config';
import { claudeEnabled } from './claude';
import { fetchCalendar, fetchInbox, fetchTasks, GoogleError, scanGmail } from './google';
import { inRange, summariseInbox } from './inbox';
import { fetchHeadlines, summariseHeadlines } from './news';
import { store, updatePackages, type NewsCache } from './store';
import { runSpeedTest } from './speedtest';
import { canTrack, track, TrackingUnavailable } from './tracking';
import { fetchWeather } from './weather';
import type { InboxRange, Package, SourceKey } from '../../shared/types';

const MIN = 60_000;
const EVERY: Record<SourceKey, number> = {
  calendar: 5 * MIN,
  tasks: 2 * MIN,
  gmail: 10 * MIN,
  carriers: 20 * MIN,
  news: 60 * MIN,
  inbox: 15 * MIN,
  // Forecasts are issued every 30 min; temperatures every minute.
  weather: 10 * MIN,
  // Checks whether a test is due; the interval itself is prefs.speedTestHours.
  speedtest: 10 * MIN,
};
const ARCHIVE_AFTER = 3 * 24 * 60 * MIN;
// Summaries cost an API call, so a topic is re-summarised at most this often
// on the schedule. Pressing refresh in the News tab skips the wait.
const RESUMMARISE_AFTER = 3 * 60 * MIN;
// The same for the inbox: the two-day digest keeps up through the day, the week's
// a few times a day. Each is only rewritten when new mail has arrived in its range.
const REDIGEST_AFTER: Record<InboxRange, number> = { '2d': 90 * MIN, '7d': 6 * 60 * MIN };

const running = new Map<SourceKey, Promise<void>>();

/** Google stopped accepting the sign-in: forget it, and remember why for the page. */
export function signOutGoogle(reason: string): void {
  store.clearGoogle();
  store.setGoogleSignedOut(reason);
}

function enabled(key: SourceKey, force: boolean): boolean {
  if (key === 'carriers') return true;
  if (key === 'speedtest') {
    const hours = store.prefs().speedTestHours;
    const last = store.sync().speedtest.lastAttempt;
    // Leave a few minutes of slack so a 3-hour test doesn't slip a whole tick each time.
    return force || (hours > 0 && (!last || Date.now() - Date.parse(last) >= hours * 60 * MIN - 5 * MIN));
  }
  if (key === 'news') return store.prefs().newsTopics.length > 0;
  // The inbox reads Gmail too, so the Gmail switch covers it; hiding the view stops it.
  if (key === 'inbox') return googleConfigured() && !!store.google() && store.prefs().sources.gmail && !store.prefs().hidden.includes('view:inbox');
  if (key === 'weather') return !!store.prefs().weatherArea;
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

async function runNews(force: boolean) {
  const prev = store.news();
  const results = await Promise.all(
    store.prefs().newsTopics.map(async (topic) => {
      const old = prev[topic.toLowerCase()];
      const entry = {
        topic,
        articles: old?.articles ?? [],
        stories: claudeEnabled() ? old?.stories ?? null : null,
        summarisedAt: old?.summarisedAt ?? null,
        summarisedUrls: old?.summarisedUrls ?? [],
        fetchedAt: old?.fetchedAt ?? null,
        error: null as string | null,
      };
      try {
        entry.articles = await fetchHeadlines(topic);
        entry.fetchedAt = new Date().toISOString();
        const known = new Set(entry.summarisedUrls);
        const fresh = entry.articles.some((a) => !known.has(a.url));
        const due = force || !entry.summarisedAt || Date.now() - Date.parse(entry.summarisedAt) > RESUMMARISE_AFTER;
        if (claudeEnabled() && entry.articles.length && (!entry.stories || (fresh && due))) {
          entry.stories = await summariseHeadlines(topic, entry.articles);
          entry.summarisedUrls = entry.articles.map((a) => a.url);
          entry.summarisedAt = new Date().toISOString();
        }
      } catch (e) {
        entry.error = (e as Error).message;
      }
      return entry;
    }),
  );
  // A topic removed meanwhile is hidden by state(); one added meanwhile is fetched by refreshNews().
  const next: NewsCache = {};
  for (const r of results) next[r.topic.toLowerCase()] = r;
  store.setNews(next);
  const failed = results.filter((r) => r.error);
  if (failed.length && failed.length === results.length) throw new Error(`${failed[0].topic}: ${failed[0].error}`);
}

async function runInbox(force: boolean) {
  const prev = store.inbox();
  const emails = await fetchInbox(prev.emails);
  const next = { ...prev, emails, digests: { ...prev.digests }, fetchedAt: new Date().toISOString(), error: null as string | null };
  if (!claudeEnabled()) next.digests = { '2d': null, '7d': null };
  else {
    const name = store.prefs().name;
    await Promise.all(
      (['2d', '7d'] as const).map(async (range) => {
        const old = prev.digests[range];
        const mail = inRange(emails, range);
        const known = new Set(old?.emailIds);
        const fresh = mail.some((e) => !known.has(e.id));
        const due = force || !old || Date.now() - Date.parse(old.summarisedAt) > REDIGEST_AFTER[range];
        if (old && !(fresh && due)) return;
        try {
          next.digests[range] = { ...(await summariseInbox(range, mail, name)), emailIds: mail.map((e) => e.id) };
        } catch (e) {
          next.error = (e as Error).message;
        }
      }),
    );
  }
  store.setInbox(next);
  if (next.error) throw new Error(`Summary: ${next.error}`);
}

async function runWeather() {
  store.setWeather(await fetchWeather(store.prefs().weatherArea));
}

async function runSpeed() {
  store.addSpeedTest(await runSpeedTest());
}

const JOBS: Record<SourceKey, (force: boolean) => Promise<void>> = {
  calendar: runCalendar,
  tasks: runTasks,
  gmail: runGmail,
  carriers: runCarriers,
  news: runNews,
  inbox: runInbox,
  weather: runWeather,
  speedtest: runSpeed,
};

/** `force` summarises new news headlines and mail now instead of waiting, and runs a speed test even when one isn't due. */
export function runSource(key: SourceKey, force = false): Promise<void> {
  const existing = running.get(key);
  if (existing) return existing;
  if (!enabled(key, force)) return Promise.resolve();
  const p = (async () => {
    const prev = store.sync()[key];
    const at = new Date().toISOString();
    try {
      await JOBS[key](force);
      store.setSync(key, { lastSuccess: new Date().toISOString(), lastAttempt: at, lastError: null });
    } catch (e) {
      const err = e as Error;
      console.error(`[sync] ${key} failed:`, err.message);
      store.setSync(key, { ...prev, lastAttempt: at, lastError: err.message });
      if (err instanceof GoogleError && err.authExpired) signOutGoogle(err.message);
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

/** Refresh news or the inbox on request: waits out a scheduled run first, so topics added during it are included. */
export async function refreshSummaries(key: 'news' | 'inbox'): Promise<void> {
  await running.get(key);
  return runSource(key, true);
}

/** Fetch the weather for a newly chosen area, after any run still using the old one. */
export async function refreshWeather(): Promise<void> {
  await running.get('weather');
  return runSource('weather');
}

export const isRunning = (key: SourceKey) => running.has(key);

export function runAllGoogle(): Promise<void> {
  // The inbox downloads up to 150 emails and writes two digests, so signing in doesn't wait for it.
  runSource('inbox');
  return Promise.all((['calendar', 'tasks', 'gmail'] as const).map((k) => runSource(k))).then(() => {});
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
