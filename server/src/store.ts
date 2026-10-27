// All state lives in one SQLite file as JSON documents keyed by name.
// The app is single-user and single-process, so whole-document reads and
// writes are simple and safe.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import type {
  BookmarkGroup, CalEvent, CalendarInfo, Note, Package, Prefs, SourceKey, SyncStatus, Task, TaskList,
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
  },

  calendar: () => get<CalendarCache>('calendar', { calendars: [], events: [] }),
  setCalendar: (v: CalendarCache) => set('calendar', v),

  tasks: () => get<TasksCache>('tasks', { lists: [], tasks: [] }),
  setTasks: (v: TasksCache) => set('tasks', v),

  packages: () => get<Package[]>('packages', []),
  setPackages: (v: Package[]) => set('packages', v),

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
