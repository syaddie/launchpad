import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../shared/defaults';
import type { BackupSnapshot, DriveStatus, SourceKey, SyncStatus } from '../shared/types';

// This file writes to the store, so it gets a database of its own rather than the shared test one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-health-'));
process.env.DATA_DIR = dataDir;
// Windows won't delete the database while it's still open; the temp folder is cleared later anyway.
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

let store: typeof import('../server/src/store').store;
let checkDb: typeof import('../server/src/store').checkDb;
let google: typeof import('../server/src/google');
let drive: typeof import('../server/src/drive');
let health: typeof import('../server/src/health');
let snapshots: typeof import('../server/src/snapshots');
let clean: typeof import('../server/src/clean');
let sync: typeof import('../server/src/sync');

beforeAll(async () => {
  ({ store, checkDb } = await import('../server/src/store'));
  google = await import('../server/src/google');
  drive = await import('../server/src/drive');
  health = await import('../server/src/health');
  snapshots = await import('../server/src/snapshots');
  clean = await import('../server/src/clean');
  sync = await import('../server/src/sync');
});

const AUTH = 'https://www.googleapis.com/auth/';
const OLD_GRANT = ['openid', 'email', 'profile', 'calendar.readonly', 'tasks', 'gmail.readonly'].map((s) => (s.includes('.') || s === 'tasks' ? AUTH + s : s));

describe('Google scopes', () => {
  afterEach(() => store.clearGoogle());

  it('reads what Google granted, as a list or the token response’s string', () => {
    expect(google.grantHas(`openid ${AUTH}drive.file ${AUTH}tasks`, 'drive.file')).toBe(true);
    expect(google.grantHas([AUTH + 'tasks'], 'drive.file')).toBe(false);
    expect(google.grantHas(undefined, 'tasks')).toBe(false);
    // A full URL is needed: a scope that merely ends the same way doesn't count.
    expect(google.grantHas(['drive.file'], 'drive.file')).toBe(false);
  });

  it('asks an old sign-in to reconnect for the new scopes, and keeps what it had', () => {
    store.setGoogle({ refreshToken: 'r', scopes: OLD_GRANT });
    expect(google.missingScopes()).toEqual(['drive.file', 'calendar.events', 'gmail.modify']);
    expect(google.hasScope('gmail.readonly')).toBe(true);
    expect(google.hasScope('tasks')).toBe(true);
    expect(google.hasScope('drive.file')).toBe(false);
  });

  it('is quiet once every new scope is granted, and while the grant isn’t known yet', () => {
    store.setGoogle({ refreshToken: 'r', scopes: [...OLD_GRANT, ...['drive.file', 'calendar.events', 'gmail.modify'].map((s) => AUTH + s)] });
    expect(google.missingScopes()).toEqual([]);
    expect(google.hasScope('gmail.modify')).toBe(true);
    // Saved before scopes were kept: learnt on the next token refresh, so no prompt yet.
    store.setGoogle({ refreshToken: 'r' });
    expect(google.missingScopes()).toEqual([]);
    expect(google.hasScope('drive.file')).toBe(false);
    store.clearGoogle();
    expect(google.missingScopes()).toEqual([]);
    expect(google.hasScope('tasks')).toBe(false);
  });

  it('asks for the new scopes, keeping calendar.readonly for the calendar list', () => {
    const scope = new URL(google.authUrl('s')).searchParams.get('scope')!.split(' ');
    for (const s of ['calendar.readonly', 'calendar.events', 'tasks', 'gmail.modify', 'drive.file']) expect(scope).toContain(AUTH + s);
    expect(scope).not.toContain(AUTH + 'gmail.readonly');
  });

  it('quotes Drive query values', () => {
    expect(google.driveLiteral("Sam's backups")).toBe("'Sam\\'s backups'");
    expect(google.driveLiteral('a\\b')).toBe("'a\\\\b'");
  });
});

const ours = (id: string, extra: Partial<import('../server/src/google').DriveFile> = {}) => ({
  id: 'f-' + id,
  name: `launchpad-${id}.db`,
  appProperties: { launchpad: 'database-copy', snapshot: id },
  ...extra,
});
const dayId = (day: number, reason: BackupSnapshot['reason'] = 'daily') => snapshots.snapshotId(new Date(Date.UTC(2026, 9, day, 3)), reason);

describe('Drive pruning', () => {
  it('keeps the newest 14 daily copies and moves only older ones of its own to the bin', () => {
    const files = Array.from({ length: 17 }, (_, i) => ours(dayId(i + 1)));
    const gone = drive.drivePrunable(files).map((f) => f.id);
    expect(gone).toEqual([dayId(3), dayId(2), dayId(1)].map((id) => 'f-' + id));
  });

  it('never touches a file this didn’t upload, however it’s named', () => {
    const old = dayId(1);
    const files = [
      ...Array.from({ length: 20 }, (_, i) => ours(dayId(i + 5))),
      // Same name, no mark: a file you put there yourself.
      { id: 'yours', name: `launchpad-${old}.db` },
      // Marked by something else.
      { id: 'other-app', name: `launchpad-${old}.db`, appProperties: { launchpad: 'something-else', snapshot: old } },
      // Marked, but the name and the mark disagree.
      { id: 'renamed', name: 'my notes.db', appProperties: { launchpad: 'database-copy', snapshot: old } },
      { id: 'mismatch', name: `launchpad-${old}.db`, appProperties: { launchpad: 'database-copy', snapshot: dayId(2) } },
      // Marked, but not a copy's name at all.
      { id: 'odd', name: 'launchpad-whatever.db', appProperties: { launchpad: 'database-copy', snapshot: 'whatever' } },
    ];
    const gone = drive.drivePrunable(files).map((f) => f.id);
    expect(gone).toHaveLength(6);
    expect(gone.every((id) => id.startsWith('f-'))).toBe(true);
    for (const id of ['yours', 'other-app', 'renamed', 'mismatch', 'odd']) expect(drive.uploadedId(files.find((f) => f.id === id)!)).toBeNull();
  });

  it('counts copies taken by hand separately, so pressing the button doesn’t push out the dailies', () => {
    const files = [...Array.from({ length: 14 }, (_, i) => ours(dayId(i + 1))), ...Array.from({ length: 12 }, (_, i) => ours(dayId(i + 1, 'manual')))];
    const gone = drive.drivePrunable(files).map((f) => f.id);
    expect(gone).toEqual([dayId(2, 'manual'), dayId(1, 'manual')].map((id) => 'f-' + id));
  });

  it('uploads the newest daily copy once, and again after a failure', () => {
    const list: BackupSnapshot[] = [
      { id: dayId(3, 'manual'), at: '', reason: 'manual', size: 1 },
      { id: dayId(2), at: '', reason: 'daily', size: 1 },
      { id: dayId(1), at: '', reason: 'daily', size: 1 },
    ];
    expect(drive.pendingDaily(list, null)?.id).toBe(dayId(2));
    expect(drive.pendingDaily(list, dayId(1))?.id).toBe(dayId(2));
    expect(drive.pendingDaily(list, dayId(2))).toBeNull();
    expect(drive.pendingDaily([], null)).toBeNull();
  });

  it('takes the Google sign-in out of the copy it uploads, and nothing else', () => {
    store.setGoogle({ refreshToken: 'secret-refresh-token', email: 'me@example.com' });
    store.setNotes([{ id: 'n', name: 'Notes', text: 'kept' }]);
    const s = snapshots.takeSnapshot('manual');
    const out = path.join(dataDir, 'uploaded.db');
    fs.writeFileSync(out, drive.driveCopy(snapshots.snapshotFile(s.id)!));
    const db = new DatabaseSync(out, { readOnly: true });
    const keys = (db.prepare('SELECT key FROM docs').all() as { key: string }[]).map((r) => r.key);
    db.close();
    expect(keys).not.toContain('google');
    expect(keys).toContain('notes');
    expect(fs.readFileSync(out).includes('secret-refresh-token')).toBe(false);
    // The copy kept on the server still has it, as before.
    expect(fs.readFileSync(snapshots.snapshotFile(s.id)!).includes('secret-refresh-token')).toBe(true);
    snapshots.removeSnapshot(s.id);
    store.clearGoogle();
  });

  it('is on by default, and only once the sign-in allows Drive', () => {
    expect(DEFAULT_PREFS.driveBackup).toBe(true);
    expect(clean.cleanPrefs({}, DEFAULT_PREFS).driveBackup).toBe(true);
    expect(clean.cleanPrefs({ driveBackup: false }, DEFAULT_PREFS).driveBackup).toBe(false);
    expect(clean.cleanPrefs({ driveBackup: 'no' as never }, { ...DEFAULT_PREFS, driveBackup: false }).driveBackup).toBe(false);
    store.setPrefs({ ...DEFAULT_PREFS });
    store.setGoogle({ refreshToken: 'r', scopes: OLD_GRANT });
    expect(drive.driveOn()).toBe(false);
    expect(drive.driveStatus()).toMatchObject({ on: true, allowed: false });
    store.setGoogle({ refreshToken: 'r', scopes: [...OLD_GRANT, AUTH + 'drive.file'] });
    expect(drive.driveOn()).toBe(true);
    store.setPrefs({ ...DEFAULT_PREFS, driveBackup: false });
    expect(drive.driveOn()).toBe(false);
    store.setPrefs({ ...DEFAULT_PREFS });
    store.clearGoogle();
  });
});

const NOW = Date.parse('2026-11-12T12:00:00Z');
const H = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const KEYS: SourceKey[] = ['calendar', 'tasks', 'gmail', 'carriers', 'news', 'inbox', 'weather', 'speedtest'];
const fine: SyncStatus = { lastSuccess: iso(60_000), lastAttempt: iso(60_000), lastError: null, failures: 0 };
const DRIVE_OK: DriveStatus = { on: true, allowed: true, lastSuccess: iso(H), lastAttempt: iso(H), lastError: null, running: false };

function input(over: Partial<import('../server/src/health').HealthInput> = {}): import('../server/src/health').HealthInput {
  return {
    now: NOW,
    startedAt: NOW - 48 * H,
    dbError: null,
    snapshots: [{ id: 'x', at: iso(5 * H), reason: 'daily', size: 1 }],
    drive: DRIVE_OK,
    driveOn: true,
    sync: Object.fromEntries(KEYS.map((k) => [k, fine])) as Record<SourceKey, SyncStatus>,
    on: Object.fromEntries(KEYS.map((k) => [k, true])) as Record<SourceKey, boolean>,
    everyMs: Object.fromEntries(KEYS.map((k) => [k, 10 * 60_000])) as Record<SourceKey, number>,
    ...over,
  };
}
const withSync = (key: SourceKey, s: Partial<SyncStatus>) => input({ sync: { ...input().sync, [key]: { ...fine, ...s } } });
const keys = (i: import('../server/src/health').HealthInput) => health.healthWarnings(i).map((w) => w.key);

describe('health', () => {
  it('finds nothing wrong when everything is fine', () => {
    expect(health.healthWarnings(input())).toEqual([]);
  });

  it('reads the database for real', () => {
    expect(checkDb()).toBeNull();
    expect(keys(input({ dbError: 'disk I/O error' }))).toEqual(['database']);
  });

  it('warns when the daily copy is a day late, or none has been taken after a while', () => {
    expect(keys(input({ snapshots: [{ id: 'x', at: iso(40 * H), reason: 'daily', size: 1 }] }))).toEqual(['copies']);
    expect(health.healthWarnings(input({ snapshots: [{ id: 'x', at: iso(40 * H), reason: 'daily', size: 1 }] }))[0].text).toBe('Last taken 40 h ago');
    // Only copies taken by hand: there's still no daily one.
    expect(keys(input({ snapshots: [{ id: 'm', at: iso(H), reason: 'manual', size: 1 }] }))).toEqual(['copies']);
    // Just started: the first copy is taken a couple of minutes in.
    expect(keys(input({ snapshots: [], startedAt: NOW - 5 * 60_000 }))).toEqual([]);
  });

  it('warns about Drive only while it’s on and the last upload failed', () => {
    const failed = { ...DRIVE_OK, lastError: 'Hit Google’s rate limit.' };
    expect(health.healthWarnings(input({ drive: failed }))).toEqual([
      { key: 'drive', name: 'Drive backup', text: 'Couldn’t copy to Drive · last copied 1 h ago', detail: 'Hit Google’s rate limit.' },
    ]);
    expect(keys(input({ drive: failed, driveOn: false }))).toEqual([]);
  });

  it('lets a sync fail once or twice, and warns from the third in a row', () => {
    expect(keys(withSync('calendar', { lastError: 'x', failures: 2 }))).toEqual([]);
    const w = health.healthWarnings(withSync('calendar', { lastError: 'Google is having trouble', failures: 3, lastSuccess: iso(30 * 60_000) }));
    expect(w).toEqual([{ key: 'calendar', name: 'Calendar', text: 'Failed 3 times in a row · last worked 30 min ago', detail: 'Google is having trouble' }]);
  });

  it('warns when a sync last worked far longer ago than it runs', () => {
    // Every 10 minutes: half an hour is the floor.
    expect(keys(withSync('tasks', { lastSuccess: iso(25 * 60_000) }))).toEqual([]);
    expect(keys(withSync('tasks', { lastSuccess: iso(45 * 60_000) }))).toEqual(['tasks']);
    // Every 3 hours (the speed test): not late at 5 hours, late at 10.
    const slow = (ago: number) => input({ sync: { ...input().sync, speedtest: { ...fine, lastSuccess: iso(ago) } }, everyMs: { ...input().everyMs, speedtest: 3 * H } });
    expect(keys(slow(5 * H))).toEqual([]);
    expect(keys(slow(10 * H))).toEqual(['speedtest']);
  });

  it('skips syncs that are off, and gives a restarted server time to catch up', () => {
    const old = withSync('news', { lastSuccess: iso(30 * H), lastError: 'x', failures: 5 });
    expect(keys({ ...old, on: { ...old.on, news: false } })).toEqual([]);
    const restarted = withSync('weather', { lastSuccess: iso(30 * H) });
    expect(keys({ ...restarted, startedAt: NOW - 5 * 60_000 })).toEqual([]);
    expect(keys(restarted)).toEqual(['weather']);
    // Never attempted: nothing to say yet.
    expect(keys(withSync('inbox', { lastSuccess: null, lastAttempt: null }))).toEqual([]);
  });

  it('says how long ago, whatever the server’s time zone', () => {
    expect(health.ago(null, NOW)).toBe('never');
    expect(health.ago(iso(20_000), NOW)).toBe('just now');
    expect(health.ago(iso(47 * H), NOW)).toBe('47 h ago');
    expect(health.ago(iso(80 * H), NOW)).toBe('3 days ago');
  });

  it('reports the database, the last copy, Drive and every sync', () => {
    const h = health.health();
    expect(h.database).toEqual({ ok: true, error: null });
    expect(Object.keys(h.sync).sort()).toEqual([...KEYS].sort());
    expect(h.sync.calendar.everyMinutes).toBe(5);
    expect(Array.isArray(h.warnings)).toBe(true);
  });
});

describe('sync failures in a row', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('counts each failure since the last success', async () => {
    store.setPrefs({ ...DEFAULT_PREFS, weatherArea: 'City' });
    store.resetSync();
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    for (let n = 1; n <= 3; n++) {
      await sync.runSource('weather');
      expect(store.sync().weather.failures).toBe(n);
    }
    expect(store.sync().weather.lastError).toBeTruthy();
  });
});
