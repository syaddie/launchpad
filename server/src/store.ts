// All state lives in one SQLite file as JSON documents keyed by name.
// The app is single-user and single-process, so whole-document reads and
// writes are simple and safe.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import type { StoredEmail } from './gmail-parse';
import type { StoredPhoto } from './photos';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import { cleanMoney } from '../../shared/money';
import { cleanTraining } from '../../shared/training';
import type {
  BookmarkGroup, CalEvent, CalendarInfo, Countdown, InboxDigest, InboxRange, Money, Mood, NewsTopic, Note, Package, Prefs, SourceKey, SpeedTest, SyncStatus, Task, TaskList, Training, Weather,
} from '../../shared/types';

fs.mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(path.join(config.dataDir, 'launchpad.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS docs (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const getStmt = db.prepare('SELECT value FROM docs WHERE key = ?');
const setStmt = db.prepare(
  'INSERT INTO docs (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
);
const delStmt = db.prepare('DELETE FROM docs WHERE key = ?');

function get<T>(key: string, fallback: T): T {
  const row = getStmt.get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

function set(key: string, value: unknown): void {
  setStmt.run(key, JSON.stringify(value), new Date().toISOString());
}

export interface GoogleTokens {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  email?: string;
  name?: string;
}

export interface CalendarCache { calendars: CalendarInfo[]; events: CalEvent[] }
export interface TasksCache { lists: TaskList[]; tasks: Task[] }
/** Keyed by lower-cased topic. `summarisedUrls` are the headlines the current stories came from. */
export type NewsCache = Record<string, NewsTopic & { summarisedUrls: string[] }>;

/** `emailIds` are the emails each digest was written from. */
export interface InboxCache {
  emails: StoredEmail[];
  digests: Record<InboxRange, (InboxDigest & { emailIds: string[] }) | null>;
  fetchedAt: string | null;
  error: string | null;
}
const EMPTY_INBOX: InboxCache = { emails: [], digests: { '2d': null, '7d': null }, fetchedAt: null, error: null };

const EMPTY_SYNC: SyncStatus = { lastSuccess: null, lastAttempt: null, lastError: null };

export const store = {
  bookmarks: () => get<BookmarkGroup[]>('bookmarks', STARTER_BOOKMARKS),
  setBookmarks: (v: BookmarkGroup[]) => set('bookmarks', v),

  notes: () => get<Note[]>('notes', STARTER_NOTES),
  setNotes: (v: Note[]) => set('notes', v),

  prefs: (): Prefs => {
    const p = get<Partial<Prefs>>('prefs', {});
    return { ...DEFAULT_PREFS, ...p, sources: { ...DEFAULT_PREFS.sources, ...p.sources } };
  },
  setPrefs: (v: Prefs) => set('prefs', v),

  google: () => get<GoogleTokens | null>('google', null),
  setGoogle: (v: GoogleTokens) => set('google', v),
  clearGoogle: () => {
    delStmt.run('google');
    delStmt.run('calendar');
    delStmt.run('tasks');
    delStmt.run('inbox');
  },
  /** Why Google disconnected itself, shown until it's reconnected. */
  googleSignedOut: () => get<{ reason: string; at: string } | null>('googleSignedOut', null),
  setGoogleSignedOut: (reason: string | null) => {
    if (reason) set('googleSignedOut', { reason, at: new Date().toISOString() });
    else delStmt.run('googleSignedOut');
  },

  calendar: () => get<CalendarCache>('calendar', { calendars: [], events: [] }),
  setCalendar: (v: CalendarCache) => set('calendar', v),

  tasks: () => get<TasksCache>('tasks', { lists: [], tasks: [] }),
  setTasks: (v: TasksCache) => set('tasks', v),

  packages: () => get<Package[]>('packages', []),
  setPackages: (v: Package[]) => set('packages', v),

  news: () => get<NewsCache>('news', {}),
  setNews: (v: NewsCache) => set('news', v),

  inbox: (): InboxCache => {
    const v = get<Partial<InboxCache>>('inbox', {});
    return { ...EMPTY_INBOX, ...v, digests: { ...EMPTY_INBOX.digests, ...v.digests } };
  },
  setInbox: (v: InboxCache) => set('inbox', v),

  weather: () => get<{ areas: string[]; now: Weather | null }>('weather', { areas: [], now: null }),
  setWeather: (v: { areas: string[]; now: Weather | null }) => set('weather', v),

  photos: () => get<StoredPhoto[]>('photos', []),
  setPhotos: (v: StoredPhoto[]) => set('photos', v),

  countdowns: () => get<Countdown[]>('countdowns', []),
  setCountdowns: (v: Countdown[]) => set('countdowns', v),

  /** ISO times, oldest first. Two years is plenty for any chart. */
  smokes: () => get<string[]>('smokes', []),
  setSmokes: (v: string[]) => set('smokes', v.slice(-20_000)),

  moods: () => get<Record<string, Mood>>('moods', {}),
  setMoods: (v: Record<string, Mood>) => set('moods', v),

  money: (): Money => cleanMoney(get<unknown>('money', null)),
  setMoney: (v: Money) => set('money', v),

  training: (): Training => cleanTraining(get<unknown>('training', null)),
  setTraining: (v: Training) => set('training', v),

  /** Oldest first, the last 30 days. */
  speedTests: () => get<SpeedTest[]>('speedTests', []),
  addSpeedTest: (t: SpeedTest) => {
    const since = Date.now() - 30 * 86_400_000;
    set('speedTests', [...store.speedTests().filter((x) => Date.parse(x.at) >= since), t]);
  },

  /** Gmail message ids already scanned for tracking numbers. */
  gmailSeen: () => get<string[]>('gmailSeen', []),
  setGmailSeen: (v: string[]) => set('gmailSeen', v.slice(-1000)),

  /** Numbers already registered with 17TRACK (registration uses quota). */
  registered17: () => get<string[]>('registered17', []),
  setRegistered17: (v: string[]) => set('registered17', v.slice(-2000)),

  sync: (): Record<SourceKey, SyncStatus> => {
    const s = get<Partial<Record<SourceKey, SyncStatus>>>('sync', {});
    return {
      calendar: s.calendar || EMPTY_SYNC,
      tasks: s.tasks || EMPTY_SYNC,
      gmail: s.gmail || EMPTY_SYNC,
      carriers: s.carriers || EMPTY_SYNC,
      news: s.news || EMPTY_SYNC,
      inbox: s.inbox || EMPTY_SYNC,
      weather: s.weather || EMPTY_SYNC,
      speedtest: s.speedtest || EMPTY_SYNC,
    };
  },
  setSync: (key: SourceKey, v: SyncStatus) => set('sync', { ...store.sync(), [key]: v }),
  resetSync: () => delStmt.run('sync'),
};

export function updatePackages(fn: (pkgs: Package[]) => Package[]): Package[] {
  const next = fn(store.packages());
  store.setPackages(next);
  return next;
}
