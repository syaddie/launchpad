// Background sync: pulls Google data and carrier status on a schedule and
// records success/failure per source for the sync dot.
import { randomUUID } from 'node:crypto';
import { googleConfigured } from './config';
import { claudeEnabled } from './claude';
import { addFinds, CLAUDE_BATCH, readBill, readBillsWithClaude, withoutDueDate, type BillMail, type FoundBill } from './bills';
import { fetchBillMail, fetchCalendar, fetchInbox, fetchTasks, GoogleError } from './google';
import { inRange, summariseInbox } from './inbox';
import { runDigest } from './digest';
import { asServer, store, updatePackages } from './store';
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
  // Writes today's lessons once a day, on the first run after midnight that finds them missing.
  digest: 60 * MIN,
  inbox: 15 * MIN,
  // Forecasts are issued every 30 min; temperatures every minute.
  weather: 10 * MIN,
  // Checks whether a test is due; the interval itself is prefs.speedTestHours.
  speedtest: 10 * MIN,
};
const ARCHIVE_AFTER = 3 * 24 * 60 * MIN;
// The same for the inbox: the two-day digest keeps up through the day, the week's
// a few times a day. Each is only rewritten when new mail has arrived in its range.
const REDIGEST_AFTER: Record<InboxRange, number> = { '2d': 90 * MIN, '7d': 6 * 60 * MIN };

const running = new Map<SourceKey, Promise<void>>();

/** Google stopped accepting the sign-in: forget it, and remember why for the page. */
export function signOutGoogle(reason: string): void {
  store.clearGoogle();
  store.setGoogleSignedOut(reason);
}

/** Whether a source is switched on at all; the speed test counts as on when it runs on a schedule. */
export function sourceOn(key: SourceKey): boolean {
  return key === 'speedtest' ? store.prefs().speedTestHours > 0 : enabled(key, false);
}

/** How often a source runs, in ms. */
export const intervalOf = (key: SourceKey): number => (key === 'speedtest' ? store.prefs().speedTestHours * 60 * MIN : EVERY[key]);

function enabled(key: SourceKey, force: boolean): boolean {
  // Retired on 2026-11-25 with the Tasks and Packages panels: Google Tasks and the carriers aren't
  // asked any more. What was fetched before stays stored (and in backups) untouched.
  if (key === 'tasks' || key === 'carriers') return false;
  if (key === 'speedtest') {
    const hours = store.prefs().speedTestHours;
    const last = store.sync().speedtest.lastAttempt;
    // Leave a few minutes of slack so a 3-hour test doesn't slip a whole tick each time.
    return force || (hours > 0 && (!last || Date.now() - Date.parse(last) >= hours * 60 * MIN - 5 * MIN));
  }
  // Lessons cost an API call each day, so switching the view off stops them.
  if (key === 'digest') return claudeEnabled() && store.prefs().digestSubjects.length > 0 && !store.prefs().hidden.includes('view:digest');
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

/** Gmail is read for bills (the Inbox view). It used to be scanned for tracking numbers too, until Packages was retired. */
async function runGmail() {
  await runBills();
}

/**
 * Bills, due notices and receipts in recent mail become suggestions in the Inbox view. Each
 * email is read once: by the rules, or by Claude when the rules can't and there's an API key.
 */
async function runBills() {
  const seen = store.billSeen();
  const mails = await fetchBillMail(new Set(seen));
  if (!mails.length) return;
  const found: FoundBill[] = [];
  const unsure: BillMail[] = [];
  const read: string[] = [];
  for (const m of mails) {
    const r = readBill(m);
    if (r.kind === 'unsure' && claudeEnabled()) {
      unsure.push(m);
      continue;
    }
    if (r.kind === 'bill') found.push(r.bill);
    else if (r.kind === 'unsure') {
      const b = withoutDueDate(m);
      if (b) found.push(b);
    }
    read.push(m.id);
  }
  // A failed Claude call leaves its emails unread, to try again on the next run.
  const batch = unsure.slice(0, CLAUDE_BATCH);
  let claudeError: Error | null = null;
  if (batch.length) {
    try {
      found.push(...(await readBillsWithClaude(batch)));
      read.push(...batch.map((m) => m.id));
    } catch (e) {
      claudeError = e as Error;
    }
  }
  const next = addFinds(store.bills(), store.billSeen(), found);
  if (found.length) store.setBills(next.pending);
  store.setBillSeen([...next.seen, ...read]);
  if (claudeError) throw new Error(`Reading bills: ${claudeError.message}`);
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

async function runInbox(force: boolean) {
  const startedAt = new Date().toISOString();
  const prev = store.inbox();
  const emails = await fetchInbox(prev.emails);
  const next = { ...prev, emails, digests: { ...prev.digests }, fetchedAt: new Date().toISOString(), error: null as string | null };
  if (!claudeEnabled()) next.digests = { '2d': null, '7d': null };
  else {
    const { name, aboutMe } = store.prefs();
    const events = store.calendar().events;
    await Promise.all(
      (['2d', '7d'] as const).map(async (range) => {
        const old = prev.digests[range];
        const mail = inRange(emails, range);
        const known = new Set(old?.emailIds);
        const fresh = mail.some((e) => !known.has(e.id));
        const due = force || !old || Date.now() - Date.parse(old.summarisedAt) > REDIGEST_AFTER[range];
        if (old && !(fresh && due)) return;
        try {
          next.digests[range] = { ...(await summariseInbox(range, mail, name, aboutMe, events)), emailIds: mail.map((e) => e.id) };
        } catch (e) {
          next.error = (e as Error).message;
        }
      }),
    );
  }
  // Archived or marked read here while this ran: keep that, not what Gmail said before it.
  const latest = store.inbox();
  const ids = new Set(emails.map((e) => e.id));
  const marks = Object.fromEntries(Object.entries(latest.marks).filter(([id, m]) => ids.has(id) && Date.now() - Date.parse(m.at) < 3_600_000));
  next.emails = emails.map((e) => (marks[e.id] && marks[e.id].at >= startedAt ? { ...e, unread: marks[e.id].unread } : e));
  next.archived = latest.archived.filter((id) => ids.has(id));
  next.marks = marks;
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
  digest: () => runDigest(),
  inbox: runInbox,
  weather: runWeather,
  speedtest: runSpeed,
};

/** `force` summarises new mail now instead of waiting, and runs a speed test even when one isn't due. */
export function runSource(key: SourceKey, force = false): Promise<void> {
  const existing = running.get(key);
  if (existing) return existing;
  if (!enabled(key, force)) return Promise.resolve();
  // Background work, even when a tab asked for it: every tab should hear what it changed.
  const p = asServer(async () => {
    const prev = store.sync()[key];
    const at = new Date().toISOString();
    try {
      await JOBS[key](force);
      store.setSync(key, { lastSuccess: new Date().toISOString(), lastAttempt: at, lastError: null, failures: 0 });
    } catch (e) {
      const err = e as Error;
      console.error(`[sync] ${key} failed:`, err.message);
      store.setSync(key, { ...prev, lastAttempt: at, lastError: err.message, failures: (prev.failures ?? 0) + 1 });
      if (err instanceof GoogleError && err.authExpired) signOutGoogle(err.message);
    } finally {
      running.delete(key);
    }
  });
  running.set(key, p);
  return p;
}

/** Run a source now unless it succeeded within `minAgeMs`. */
export function runIfStale(key: SourceKey, minAgeMs: number): Promise<void> {
  const last = store.sync()[key].lastAttempt;
  if (last && Date.now() - Date.parse(last) < minAgeMs) return Promise.resolve();
  return runSource(key);
}

/** Refresh the digest or the inbox on request: waits out a scheduled run first, so subjects added during it are included. */
export async function refreshSummaries(key: 'digest' | 'inbox'): Promise<void> {
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
