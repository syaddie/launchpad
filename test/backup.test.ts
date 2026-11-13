import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../shared/defaults';
import type { Backup } from '../shared/types';
import { hashFor, viewFromHash } from '../web/src/util';
import { SHORTCUT_GROUPS } from '../web/src/components/Shortcuts';
import { VIEWS } from '../web/src/components/Rail';

// This file writes to the store, so it gets a database of its own rather than the shared test one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-backup-'));
process.env.DATA_DIR = dataDir;
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));
let store: typeof import('../server/src/store').store;
let asTab: typeof import('../server/src/store').asTab;
let asServer: typeof import('../server/src/store').asServer;
let changes: typeof import('../server/src/store').changes;
let backup: typeof import('../server/src/backup');
let clean: typeof import('../server/src/clean');
let keysFor: typeof import('../server/src/events').keysFor;
let stalePart: typeof import('../server/src/shell').stalePart;
let sweepPhotos: typeof import('../server/src/photos').sweepPhotos;
let snapshots: typeof import('../server/src/snapshots');
let zip: typeof import('../server/src/zip');
let docVersion: typeof import('../server/src/store').docVersion;

beforeAll(async () => {
  ({ store, asTab, asServer, changes } = await import('../server/src/store'));
  backup = await import('../server/src/backup');
  clean = await import('../server/src/clean');
  ({ keysFor } = await import('../server/src/events'));
  ({ stalePart } = await import('../server/src/shell'));
  ({ sweepPhotos } = await import('../server/src/photos'));
  snapshots = await import('../server/src/snapshots');
  zip = await import('../server/src/zip');
  ({ docVersion } = await import('../server/src/store'));
});

describe('backup', () => {
  it('exports every part you enter, and restores it', () => {
    store.setCountdowns([{ id: 'c1', title: 'Trip', date: '2027-01-10', yearly: false, createdAt: '2026-10-01T00:00:00.000Z' }]);
    store.setSmokes(['2025-01-01T01:00:00.000Z', '2026-11-01T02:00:00.000Z']);
    store.setMoods({ '2026-11-01': { level: 4, note: 'good' } });
    store.setWeights({ '2026-11-01': 72.4 });
    store.setCravings([{ id: 'k1', at: '2026-11-01T03:00:00.000Z', strength: 3, trigger: 'coffee', note: 'after lunch' }]);
    store.setPrefs({ ...DEFAULT_PREFS, name: 'Sam', cigaretteLimit: 5 });
    store.setSnippets([{ id: 's1', name: 'Disk usage', command: 'df -h' }]);
    const mc = { id: 'm1', name: 'Survival', dir: '/home/me/mc', mux: 'tmux' as const, session: 'survival', start: './start.sh' };
    store.setMinecraft([mc]);
    const b = backup.exportBackup();
    expect(b.version).toBe(2);
    for (const k of ['bookmarks', 'notes', 'prefs', 'countdowns', 'smokes', 'moods', 'cravings', 'weights', 'money', 'learn', 'training', 'exerciseMuscles', 'packages', 'snippets', 'minecraft'] as const) expect(b).toHaveProperty(k);
    // Every cigarette, not just the 60 days the page gets.
    expect(b.smokes).toHaveLength(2);
    expect(JSON.stringify(b)).not.toMatch(/refreshToken/);

    store.setCountdowns([]);
    store.setSmokes([]);
    store.setMoods({});
    store.setWeights({});
    store.setCravings([]);
    store.setPrefs({ ...DEFAULT_PREFS });
    store.setSnippets([]);
    store.setMinecraft([]);
    const restored = backup.restoreBackup(JSON.parse(JSON.stringify(b)));
    expect(restored).toContain('money');
    expect(store.countdowns()).toEqual(b.countdowns);
    expect(store.smokes()).toEqual(b.smokes);
    expect(store.moods()).toEqual(b.moods);
    expect(store.weights()).toEqual(b.weights);
    expect(store.cravings()).toEqual(b.cravings);
    expect(store.cravings()).toHaveLength(1);
    expect(store.prefs().name).toBe('Sam');
    expect(store.prefs().cigaretteLimit).toBe(5);
    expect(store.snippets()).toEqual([{ id: 's1', name: 'Disk usage', command: 'df -h' }]);
    expect(store.minecraft()).toEqual([mc]);
  });

  it('restores an old bookmarks-and-notes backup without touching the rest', () => {
    store.setWeights({ '2026-11-02': 71 });
    const v1: Backup = { version: 1, exported: '2026-01-01T00:00:00Z', bookmarks: [{ id: 'g', name: 'Daily', items: [{ id: 'b', name: 'Mail', url: 'https://mail.example' }] }], notes: [{ id: 'n', name: 'N', text: 'hi' }] };
    expect(backup.restoreBackup(v1)).toEqual(['bookmarks', 'notes']);
    expect(backup.describeRestored(['bookmarks', 'notes'])).toEqual(['1 bookmark group', '1 notepad']);
    expect(store.bookmarks()[0].items[0].name).toBe('Mail');
    expect(store.weights()).toEqual({ '2026-11-02': 71 });
  });

  it('refuses what isn’t a backup, and changes nothing', () => {
    const before = store.notes();
    expect(() => backup.restoreBackup({ hello: 1 })).toThrow(backup.RestoreError);
    expect(() => backup.restoreBackup({ version: 9, notes: [] })).toThrow(/version/);
    expect(() => backup.restoreBackup({ version: 2, notes: [] })).toThrow(backup.RestoreError);
    expect(() => backup.restoreBackup(null)).toThrow(backup.RestoreError);
    expect(store.notes()).toEqual(before);
  });

  it('cleans what a restored file holds like a normal save would', () => {
    backup.restoreBackup({
      version: 2,
      moods: { '2026-11-03': { level: 9, note: 'x' }, nope: { level: 3 }, '2026-11-04': { level: 0 } },
      weights: { '2026-11-03': 9999, '2026-11-04': 70.25 },
      smokes: ['not a date', '2099-01-01T00:00:00Z', '2026-11-01T00:00:00+08:00'],
      prefs: { theme: 'neon', name: 'Alex', hidden: ['panel:today', 'evil'] },
      exerciseMuscles: { 'Bench Press': { primary: 'chest', secondary: ['triceps', 'nonsense'] }, Bad: { primary: 'tail' } },
    });
    expect(store.moods()).toEqual({ '2026-11-03': { level: 5, note: 'x' } });
    expect(store.weights()).toEqual({ '2026-11-04': 70.25 });
    expect(store.smokes()).toEqual(['2026-10-31T16:00:00.000Z']);
    expect(store.prefs().theme).toBe(DEFAULT_PREFS.theme);
    expect(store.prefs().name).toBe('Alex');
    expect(store.prefs().hidden).toEqual(['panel:today']);
    expect(store.exerciseMuscles()).toEqual({ 'Bench Press': { primary: 'chest', secondary: ['triceps'] } });
    // Labels already there are kept; the file's win where both have one.
    store.setExerciseMuscles({ Squat: { primary: 'quadriceps', secondary: [] }, 'Bench Press': { primary: 'shoulders', secondary: [] } });
    backup.restoreBackup({ version: 2, exerciseMuscles: { 'Bench Press': { primary: 'chest', secondary: [] } } });
    expect(store.exerciseMuscles()).toEqual({ Squat: { primary: 'quadriceps', secondary: [] }, 'Bench Press': { primary: 'chest', secondary: [] } });
  });

  it('snapshots the database into a file SQLite can open', () => {
    const snap = backup.dbSnapshot();
    try {
      const copy = new DatabaseSync(snap.path, { readOnly: true });
      const row = copy.prepare('SELECT value FROM docs WHERE key = ?').get('weights') as { value: string };
      expect(JSON.parse(row.value)).toEqual(store.weights());
      copy.close();
    } finally {
      snap.cleanup();
    }
    expect(fs.existsSync(snap.path)).toBe(false);
  });
});

describe('clean', () => {
  it('keeps countdowns with a title and a real date', () => {
    const list = clean.cleanCountdowns([{ id: 'a', title: '  Trip ', date: '2027-01-01' }, { id: 'b', title: '', date: '2027-01-01' }, { id: 'c', title: 'X', date: '2027-13-45' }, null]);
    expect(list.map((c) => c.title)).toEqual(['Trip']);
  });
  it('only takes true or false for each Google source', () => {
    const p = clean.cleanPrefs({ sources: { calendar: false, tasks: 'yes', bogus: true } as never }, DEFAULT_PREFS);
    expect(p.sources).toEqual({ ...DEFAULT_PREFS.sources, calendar: false });
  });
  it('keeps packages that have an id, number, carrier and label', () => {
    const pk = clean.cleanPackages([{ id: '1', number: 'X1', carrier: 'UPS', label: 'Shoes', stage: 7, timeline: [{ at: 'a', event: 'b' }, { nope: 1 }] }, { id: '2' }]);
    expect(pk).toHaveLength(1);
    expect(pk[0]).toMatchObject({ stage: 3, timeline: [{ at: 'a', location: '', event: 'b' }], archived: false });
  });
});

describe('change events', () => {
  it('names the tab that made a write, and none for background work', () => {
    const seen: [string, string | undefined][] = [];
    const on = (k: string, t: string | undefined) => seen.push([k, t]);
    changes.on('change', on);
    asTab('tab-a', () => store.setMoods({}));
    asTab('tab-a', () => asServer(() => store.setWeights({})));
    store.setCountdowns([]);
    changes.off('change', on);
    expect(seen).toEqual([['moods', 'tab-a'], ['weights', undefined], ['countdowns', undefined]]);
  });
  it('doesn’t send a tab its own writes back', () => {
    const changed = new Map([['notes', new Set(['tab-a'])], ['sync', new Set([''])], ['money', new Set(['tab-a', 'tab-b'])]]);
    expect(keysFor('tab-a', changed)).toEqual(['sync', 'money']);
    expect(keysFor('tab-b', changed)).toEqual(['notes', 'sync', 'money']);
    expect(keysFor('', changed)).toEqual(['notes', 'sync', 'money']);
  });
});

describe('cleanup', () => {
  it('sweeps upload part files only once they’ve sat for a day', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const old = (now - 25 * 3600_000) / 1000;
    const recent = (now - 3600_000) / 1000;
    expect(stalePart('.launchpad-upload-0123456789abcdef.part', old, now)).toBe(true);
    expect(stalePart('.launchpad-upload-0123456789abcdef.part', recent, now)).toBe(false);
    expect(stalePart('holiday.part', old, now)).toBe(false);
    expect(stalePart('.launchpad-upload-../../x.part', old, now)).toBe(false);
  });

  it('removes photo files nothing uses once they’re a week old, and drops photos without a file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-photos-'));
    const id = (c: string) => c.repeat(16);
    for (const f of [id('a'), id('b'), id('c'), 'README']) fs.writeFileSync(path.join(dir, f), 'x');
    const weekAgo = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(path.join(dir, id('b')), weekAgo, weekAgo);
    fs.utimesSync(path.join(dir, 'README'), weekAgo, weekAgo);
    const photo = (i: string) => ({ id: i, mime: 'image/jpeg', focus: { x: 50, y: 50 } });
    const r = sweepPhotos([photo(id('a')), photo(id('d'))], Date.now(), dir);
    expect(r.removed).toBe(1);
    expect(r.photos.map((p) => p.id)).toEqual([id('a')]);
    // b was old and unused; c is unused but new (maybe from a database put back); README isn't a photo.
    expect(fs.readdirSync(dir).sort()).toEqual(['README', id('a'), id('c')].sort());
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('view in the URL', () => {
  it('reads the view from the hash, home for anything else', () => {
    expect(viewFromHash('#money')).toBe('money');
    expect(viewFromHash('#/learn')).toBe('learn');
    expect(viewFromHash('#Server')).toBe('server');
    expect(viewFromHash('')).toBe('home');
    expect(viewFromHash('#home')).toBe('home');
    expect(viewFromHash('#nope')).toBe('home');
  });
  it('leaves home without a hash', () => {
    expect(hashFor('home')).toBe('');
    expect(hashFor('money')).toBe('#money');
    for (const v of VIEWS) expect(viewFromHash(hashFor(v.key))).toBe(v.key);
  });
});

describe('shortcut list', () => {
  it('has a G shortcut for every view', () => {
    const go = SHORTCUT_GROUPS.find((g) => g.title === 'Go to a view')!;
    for (const v of VIEWS) expect(go.rows.some((r) => r.keys[0].join(' ') === `G ${v.letter}`)).toBe(true);
  });
});

describe('automatic copies', () => {
  it('names copies by time and reason, and reads the name back', () => {
    const id = snapshots.snapshotId(new Date('2026-11-06T07:31:36.968Z'), 'daily');
    expect(id).toBe('2026-11-06T07-31-36-968Z-daily');
    expect(snapshots.parseSnapshotId(id)).toEqual({ at: '2026-11-06T07:31:36.968Z', reason: 'daily' });
    expect(snapshots.parseSnapshotId('../../etc/passwd')).toBeNull();
    expect(snapshots.snapshotFile('../launchpad')).toBeNull();
  });

  it('takes one a day', () => {
    const now = Date.parse('2026-11-06T12:00:00Z');
    const at = (h: number) => ({ id: 'x', at: new Date(now - h * 3_600_000).toISOString(), reason: 'daily' as const, size: 1 });
    expect(snapshots.dailySnapshotDue([], now)).toBe(true);
    expect(snapshots.dailySnapshotDue([at(5)], now)).toBe(false);
    expect(snapshots.dailySnapshotDue([at(21)], now)).toBe(true);
    expect(snapshots.dailySnapshotDue([{ ...at(1), reason: 'manual' }], now)).toBe(true);
  });

  it('keeps the newest of each kind and puts back what a copy holds', () => {
    store.setCountdowns([{ id: 'k', title: 'Kept', date: '2027-03-03', yearly: false, createdAt: '2026-10-01T00:00:00.000Z' }]);
    store.setWeights({ '2026-10-01': 70 });
    const base = Date.parse('2026-01-01T00:00:00Z');
    for (let i = 0; i < 12; i++) snapshots.takeSnapshot('before-restore', new Date(base + i * 1000));
    const list = snapshots.listSnapshots().filter((s) => s.reason === 'before-restore');
    expect(list).toHaveLength(10);
    expect(list[0].at).toBe(new Date(base + 11_000).toISOString());

    store.setCountdowns([]);
    store.setWeights({ '2026-10-02': 99 });
    const b = snapshots.snapshotBackup(list[0].id);
    expect(backup.restoreBackup(b)).toContain('countdowns');
    expect(store.countdowns().map((c) => c.title)).toEqual(['Kept']);
    expect(store.weights()).toEqual({ '2026-10-01': 70 });
  });
});

describe('backup with photos', () => {
  const jpeg = (fill: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, fill)]);

  it('round-trips files through a .zip', async () => {
    const files = [{ name: 'a.json', data: () => Buffer.from('{"x":1}') }, { name: 'photos/p', data: () => jpeg(7) }];
    const bytes = Buffer.from(await new Response(zip.zipStream(files)).arrayBuffer());
    expect(zip.isZip(bytes)).toBe(true);
    const out = zip.unzip(bytes);
    expect(out.get('a.json')!.toString()).toBe('{"x":1}');
    expect(out.get('photos/p')).toEqual(jpeg(7));
    expect(() => zip.unzip(Buffer.from('not a zip at all, sorry'))).toThrow();
  });

  it('puts photos back from a .zip backup, and re-lists only photos whose file is there', async () => {
    const id = 'Zz0123456789abcd';
    const missing = 'Mm0123456789abcd';
    const json = { version: 2, exported: '2026-11-06T00:00:00Z', photos: [{ id, mime: 'image/jpeg', focus: { x: 10, y: 20 } }, { id: missing, mime: 'image/jpeg', focus: { x: 1, y: 1 } }] };
    const bytes = Buffer.from(await new Response(zip.zipStream([
      { name: 'backup/launchpad-backup.json', data: () => Buffer.from(JSON.stringify(json)) },
      { name: `backup/photos/${id}`, data: () => jpeg(3) },
      { name: 'backup/photos/../../evil', data: () => jpeg(1) },
    ])).arrayBuffer());
    const body = backup.readBackupUpload(bytes);
    expect(backup.restoreBackup(body)).toEqual(['photos']);
    expect(store.photos()).toEqual([{ id, mime: 'image/jpeg', focus: { x: 10, y: 20 } }]);
    expect(fs.readFileSync(path.join(dataDir, 'photos', id))).toEqual(jpeg(3));
    expect(fs.existsSync(path.join(dataDir, 'evil'))).toBe(false);
    expect(backup.describeRestored(['photos'])).toEqual(['1 photo']);
  });

  it('refuses a .zip without a backup in it', async () => {
    const bytes = Buffer.from(await new Response(zip.zipStream([{ name: 'x.txt', data: () => Buffer.from('hi') }])).arrayBuffer());
    expect(() => backup.readBackupUpload(bytes)).toThrow(/launchpad-backup.json/);
  });
});

describe('document versions', () => {
  it('changes whenever a document is written', async () => {
    store.setNotes([{ id: 'v', name: 'V', text: '1' }]);
    const v1 = docVersion('notes');
    expect(v1).not.toBe('');
    await new Promise((r) => setTimeout(r, 5));
    store.setNotes([{ id: 'v', name: 'V', text: '2' }]);
    expect(docVersion('notes')).not.toBe(v1);
    expect(docVersion('never-written')).toBe('');
  });
});
