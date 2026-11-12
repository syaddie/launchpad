// What's wrong, if anything: the database, the daily copies, Drive and the syncs. /healthz
// only looks at the database, since Docker restarts the container when it fails and a
// flaky Google sync isn't worth a restart. /api/health has the rest, for the page.
import { checkDb, store } from './store';
import { driveOn, driveStatus } from './drive';
import { listSnapshots } from './snapshots';
import { intervalOf, sourceOn } from './sync';
import type { BackupSnapshot, DriveStatus, Health, HealthWarning, SourceKey, SyncStatus } from '../../shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const startedAt = Date.now();

const NAMES: Record<SourceKey, string> = {
  calendar: 'Calendar',
  tasks: 'Tasks',
  gmail: 'Gmail packages',
  carriers: 'Carriers',
  news: 'News',
  inbox: 'Inbox',
  weather: 'Weather',
  speedtest: 'Speed test',
};

/** "never", "5 min ago", "3 h ago", "2 days ago": a length of time, so it reads the same whatever the server's time zone. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return 'never';
  const mins = Math.max(0, Math.floor((now - Date.parse(iso)) / MIN));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

/** Failures in a row before a sync counts as broken rather than a blip. */
export const FAILS_IN_A_ROW = 3;
/** The daily copy is checked hourly and taken after 20 hours, so this means a day was missed. */
export const COPY_LATE = 36 * HOUR;

/** How long since a sync last worked before it's worth a warning: three runs missed, and at least half an hour. */
export const staleAfter = (everyMs: number) => Math.max(3 * everyMs, 30 * MIN);

export interface HealthInput {
  now: number;
  /** When the server started: a sync isn't late until it's had time to run since. */
  startedAt: number;
  dbError: string | null;
  snapshots: BackupSnapshot[];
  drive: DriveStatus;
  /** The switch is on and the sign-in allows it. */
  driveOn: boolean;
  sync: Record<SourceKey, SyncStatus>;
  on: Record<SourceKey, boolean>;
  everyMs: Record<SourceKey, number>;
}

/** The rules, kept apart from where their inputs come from so they can be tested. */
export function healthWarnings(i: HealthInput): HealthWarning[] {
  const out: HealthWarning[] = [];
  if (i.dbError) out.push({ key: 'database', name: 'Database', text: 'Can’t be read', detail: i.dbError });

  const daily = i.snapshots.find((s) => s.reason === 'daily');
  if (daily ? i.now - Date.parse(daily.at) > COPY_LATE : i.now - i.startedAt > 30 * MIN) {
    out.push({ key: 'copies', name: 'Daily copy', text: daily ? `Last taken ${ago(daily.at, i.now)}` : 'None taken yet' });
  }

  if (i.driveOn && i.drive.lastError) {
    out.push({ key: 'drive', name: 'Drive backup', text: `Couldn’t copy to Drive · last copied ${ago(i.drive.lastSuccess, i.now)}`, detail: i.drive.lastError });
  }

  for (const key of Object.keys(NAMES) as SourceKey[]) {
    if (!i.on[key]) continue;
    const s = i.sync[key];
    const fails = s.failures ?? 0;
    // Since it last worked, or since the server started, whichever is later.
    const since = Math.max(s.lastSuccess ? Date.parse(s.lastSuccess) : 0, i.startedAt);
    const late = i.now - since > staleAfter(i.everyMs[key]);
    if (fails >= FAILS_IN_A_ROW) {
      out.push({ key, name: NAMES[key], text: `Failed ${fails} times in a row · last worked ${ago(s.lastSuccess, i.now)}`, detail: s.lastError ?? undefined });
    } else if (late && s.lastAttempt) {
      out.push({ key, name: NAMES[key], text: `Last worked ${ago(s.lastSuccess, i.now)}`, detail: s.lastError ?? undefined });
    }
  }
  return out;
}

function input(): HealthInput {
  const keys = Object.keys(NAMES) as SourceKey[];
  return {
    now: Date.now(),
    startedAt,
    dbError: checkDb(),
    snapshots: listSnapshots(),
    drive: driveStatus(),
    driveOn: driveOn(),
    sync: store.sync(),
    on: Object.fromEntries(keys.map((k) => [k, sourceOn(k)])) as Record<SourceKey, boolean>,
    everyMs: Object.fromEntries(keys.map((k) => [k, intervalOf(k)])) as Record<SourceKey, number>,
  };
}

/** The warnings alone, for the page's state. */
export const currentWarnings = (): HealthWarning[] => healthWarnings(input());

export function health(): Health {
  const i = input();
  const daily = i.snapshots.find((s) => s.reason === 'daily');
  const keys = Object.keys(NAMES) as SourceKey[];
  return {
    database: { ok: !i.dbError, error: i.dbError },
    lastCopy: { at: daily?.at ?? null, ageHours: daily ? Math.round(((i.now - Date.parse(daily.at)) / HOUR) * 10) / 10 : null },
    drive: i.drive,
    sync: Object.fromEntries(keys.map((k) => [k, { ...i.sync[k], on: i.on[k], everyMinutes: Math.round(i.everyMs[k] / MIN) }])) as Health['sync'],
    warnings: healthWarnings(i),
  };
}
