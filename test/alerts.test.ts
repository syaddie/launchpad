import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFS } from '../shared/defaults';
import type { ContainerInfo, DiskHealth, DisksReport, HealthWarning } from '../shared/types';

// This file writes to the store, so it gets a database of its own rather than the shared test one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-alerts-'));
process.env.DATA_DIR = dataDir;
// Windows won't delete the database while it's still open; the temp folder is cleared later anyway.
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {}
});

let store: typeof import('../server/src/store').store;
let notify: typeof import('../server/src/notify');
let alerts: typeof import('../server/src/alerts');
let clean: typeof import('../server/src/clean');
let backup: typeof import('../server/src/backup');
let drive: typeof import('../server/src/drive');
let snapshots: typeof import('../server/src/snapshots');
let st: typeof import('../server/src/state');

beforeAll(async () => {
  ({ store } = await import('../server/src/store'));
  notify = await import('../server/src/notify');
  alerts = await import('../server/src/alerts');
  clean = await import('../server/src/clean');
  backup = await import('../server/src/backup');
  drive = await import('../server/src/drive');
  snapshots = await import('../server/src/snapshots');
  st = await import('../server/src/state');
});

// A literal address that isn't the server itself, so checkUrl passes it without a DNS lookup.
const TOPIC = 'http://203.0.113.5/launchpad-test';
const MIN = 60_000;
const HOUR = 60 * MIN;

interface Post { url: string; title: string; body: string; priority: string; tags: string; click?: string }
let posts: Post[] = [];
let answer: () => Response = () => new Response('{}', { status: 200 });

function stubNtfy() {
  posts = [];
  answer = () => new Response('{}', { status: 200 });
  vi.stubGlobal('fetch', vi.fn(async (url: URL | string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    const title = h.Title.startsWith('=?UTF-8?B?') ? Buffer.from(h.Title.slice(10, -2), 'base64').toString('utf8') : h.Title;
    posts.push({ url: String(url), title, body: String(init.body), priority: h.Priority, tags: h.Tags, ...(h.Click ? { click: h.Click } : {}) });
    return answer();
  }));
}

function fresh() {
  store.setAlertTopic('');
  store.setAlertMemory(null);
  store.setPrefs({ ...DEFAULT_PREFS });
  notify.resetForTests();
  alerts.resetWatchForTests();
}

describe('topic address', () => {
  it('takes an ntfy topic address, or nothing to turn alerts off', () => {
    expect(notify.cleanTopicUrl(' https://ntfy.sh/launchpad-abc123 ')).toBe('https://ntfy.sh/launchpad-abc123');
    expect(notify.cleanTopicUrl('http://192.168.1.5:8080/alerts')).toBe('http://192.168.1.5:8080/alerts');
    expect(notify.cleanTopicUrl('https://example.com/ntfy/home_alerts?auth=xyz')).toBe('https://example.com/ntfy/home_alerts?auth=xyz');
    expect(notify.cleanTopicUrl('')).toBe('');
    expect(notify.cleanTopicUrl('   ')).toBe('');
    // As the ntfy app shows it.
    expect(notify.cleanTopicUrl('ntfy.sh/launchpad-abc123')).toBe('https://ntfy.sh/launchpad-abc123');
  });

  it('says what’s wrong with one it won’t take', () => {
    expect(() => notify.cleanTopicUrl('not an address')).toThrow(/isn’t a web address/);
    expect(() => notify.cleanTopicUrl('ftp://ntfy.sh/topic')).toThrow(/http/);
    expect(() => notify.cleanTopicUrl('https://ntfy.sh/')).toThrow(/topic at the end/);
    expect(() => notify.cleanTopicUrl('https://ntfy.sh/has space')).toThrow(/topic at the end/);
    expect(() => notify.cleanTopicUrl('https://me:pw@ntfy.sh/topic')).toThrow(/login/);
    expect(() => notify.cleanTopicUrl('https://ntfy.sh/' + 'a'.repeat(65))).toThrow(/topic/);
    expect(() => notify.cleanTopicUrl(42)).toThrow();
    // The server itself never works, so it's refused when saved, not at the first send.
    expect(() => notify.cleanTopicUrl('http://localhost:8080/alerts')).toThrow(/own server/);
    expect(() => notify.cleanTopicUrl('http://127.0.0.1/alerts')).toThrow(/own server/);
    expect(() => notify.cleanTopicUrl('http://[::1]:80/alerts')).toThrow(/own server/);
    expect(() => notify.cleanTopicUrl('http://169.254.169.254/alerts')).toThrow(/own server/);
  });

  it('is kept apart from prefs: out of the page’s state, the JSON backup and the Drive copy', () => {
    fresh();
    notify.setTopicUrl(TOPIC);
    expect(store.alertTopic()).toBe(TOPIC);
    expect(JSON.stringify(st.state())).not.toContain('launchpad-test');
    expect(JSON.stringify(backup.exportBackup())).not.toContain('launchpad-test');
    // A restore leaves it as it is.
    backup.restoreBackup(JSON.parse(JSON.stringify(backup.exportBackup())));
    expect(store.alertTopic()).toBe(TOPIC);

    const s = snapshots.takeSnapshot('manual');
    const out = path.join(dataDir, 'drive.db');
    fs.writeFileSync(out, drive.driveCopy(snapshots.snapshotFile(s.id)!));
    const db = new DatabaseSync(out, { readOnly: true });
    const keys = (db.prepare('SELECT key FROM docs').all() as { key: string }[]).map((r) => r.key);
    db.close();
    expect(keys).not.toContain('alertTopic');
    expect(keys).toContain('prefs');
    snapshots.removeSnapshot(s.id);
  });

  it('changes to it and to what was sent don’t make tabs reload everything', () => {
    expect(st.fieldsFor(['alertTopic', 'alertMemory'])).toEqual([]);
  });
});

describe('alert switches in prefs', () => {
  it('are on by default and pass cleanPrefs field by field', () => {
    expect(DEFAULT_PREFS.alerts).toEqual({ health: true, containers: true, disks: true, minecraft: true, busking: true });
    expect(clean.cleanPrefs({}, DEFAULT_PREFS).alerts).toEqual(DEFAULT_PREFS.alerts);
    const off = clean.cleanPrefs({ alerts: { containers: false } as never }, DEFAULT_PREFS).alerts;
    expect(off).toEqual({ health: true, containers: false, disks: true, minecraft: true, busking: true });
    // Junk is dropped; what was there stays.
    const junk = clean.cleanPrefs({ alerts: { containers: 'no', disks: false, evil: true } as never }, { ...DEFAULT_PREFS, alerts: off });
    expect(junk).toMatchObject({ alerts: { health: true, containers: false, disks: false, minecraft: true } });
    expect(junk.alerts).not.toHaveProperty('evil');
    expect(clean.cleanPrefs({ alerts: 'off' as never }, DEFAULT_PREFS).alerts).toEqual(DEFAULT_PREFS.alerts);
  });

  it('fill in for prefs saved before they existed, and go through backup and restore', () => {
    fresh();
    const { alerts: _, ...old } = DEFAULT_PREFS;
    store.setPrefs(old as never);
    expect(store.prefs().alerts).toEqual(DEFAULT_PREFS.alerts);

    store.setPrefs({ ...DEFAULT_PREFS, alerts: { ...DEFAULT_PREFS.alerts, disks: false } });
    const b = JSON.parse(JSON.stringify(backup.exportBackup()));
    expect(b.prefs.alerts.disks).toBe(false);
    store.setPrefs({ ...DEFAULT_PREFS });
    backup.restoreBackup(b);
    expect(store.prefs().alerts.disks).toBe(false);
    store.setPrefs({ ...DEFAULT_PREFS });
  });
});

describe('what goes in a message', () => {
  it('keeps addresses to their host and path, and cuts out tokens and ids', () => {
    expect(notify.scrub('Feed https://example.com/rss?token=abc123secret failed', 200)).toBe('Feed https://example.com/rss failed');
    expect(notify.scrub('key sk-ant-api03-Xk9fQ2LmZp7RtV4wYb8NcJ1hGd6SaE3u leaked', 200)).toBe('key … leaked');
    expect(notify.scrub('token ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8 there', 200)).toBe('token … there');
    expect(notify.scrub('id ' + 'a3f9'.repeat(16), 200)).toBe('id …');
    // A long container name isn't a secret.
    expect(notify.scrub('my-awesome-media-server-stack-plex-1 stopped', 200)).toBe('my-awesome-media-server-stack-plex-1 stopped');
    expect(notify.scrub('line\u0000one\nline two', 200)).toBe('line one\nline two');
    expect(notify.scrub('x'.repeat(10) + ' ' + 'y'.repeat(10), 12)).toBe('xxxxxxxxxx…');
  });

  it('sends titles with curly quotes and dots so ntfy reads them as UTF-8', () => {
    expect(notify.encodeHeader('plain title')).toBe('plain title');
    const enc = notify.encodeHeader('Can’t reach Docker · 2');
    expect(enc).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
    expect(Buffer.from(enc.slice(10, -2), 'base64').toString('utf8')).toBe('Can’t reach Docker · 2');
  });
});

describe('publishing to ntfy', () => {
  beforeEach(stubNtfy);
  afterEach(() => vi.unstubAllGlobals());

  it('posts the title, priority and tag as headers and the text as the body', async () => {
    await notify.publish(TOPIC, { title: 'plex stopped', body: 'Docker says: Exited (1).', type: 'problem' });
    expect(posts).toEqual([{ url: TOPIC, title: 'plex stopped', body: 'Docker says: Exited (1).', priority: '4', tags: 'warning' }]);
    await notify.publish(TOPIC, { title: 'plex is running again', body: '', type: 'fixed' });
    expect(posts[1]).toMatchObject({ priority: '3', tags: 'white_check_mark', body: 'plex is running again' });
  });

  it('adds a link to open when it’s tapped, only a plain https one', async () => {
    const nac = 'https://eservices.nac.gov.sg/Busking/locations/c6f63ddc-3926-4a83-b59f-e7904989c7a0/events';
    await notify.publish(TOPIC, { title: 'Busking slot free', body: '2 PM – 4 PM', type: 'event', click: nac });
    expect(posts[0].click).toBe(nac);
    for (const click of ['http://example.com/', 'javascript:alert(1)', 'https://a b', 'https://x.test/' + 'a'.repeat(600)]) {
      await notify.publish(TOPIC, { title: 't', body: '', type: 'event', click });
      expect(posts[posts.length - 1].click).toBeUndefined();
    }
  });

  it('never sends to the server itself', async () => {
    await expect(notify.publish('http://127.0.0.1:8080/topic', { title: 't', body: '', type: 'test' })).rejects.toThrow(/own server/);
    await expect(notify.publish('http://localhost/topic', { title: 't', body: '', type: 'test' })).rejects.toThrow(/own server/);
    expect(posts).toHaveLength(0);
  });

  it('follows a redirect, checking where it goes', async () => {
    let n = 0;
    answer = () => (n++ ? new Response('{}', { status: 200 }) : new Response(null, { status: 307, headers: { location: 'http://203.0.113.6/launchpad-test' } }));
    await notify.publish(TOPIC, { title: 't', body: '', type: 'test' });
    expect(posts.map((p) => p.url)).toEqual([TOPIC, 'http://203.0.113.6/launchpad-test']);
    answer = () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/x' } });
    await expect(notify.publish(TOPIC, { title: 't', body: '', type: 'test' })).rejects.toThrow(/own server/);
  });

  it('explains what ntfy said when it refuses', async () => {
    answer = () => new Response('{"code":42901,"http":429,"error":"limit reached"}', { status: 429 });
    await expect(notify.publish(TOPIC, { title: 't', body: '', type: 'test' })).rejects.toThrow(/too many messages/);
    answer = () => new Response('{"error":"forbidden"}', { status: 403 });
    await expect(notify.publish(TOPIC, { title: 't', body: '', type: 'test' })).rejects.toThrow(/needs a login/);
    answer = () => new Response('{"error":"bad thing"}', { status: 500 });
    await expect(notify.publish(TOPIC, { title: 't', body: '', type: 'test' })).rejects.toThrow('ntfy answered 500: bad thing.');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))));
    await expect(notify.publish(TOPIC, { title: 't', body: '', type: 'test' })).rejects.toThrow(/refused the connection/);
  });
});

describe('notify()', () => {
  beforeEach(() => {
    stubNtfy();
    fresh();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('sends nothing until there’s a topic, or while its kind is off', async () => {
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: 'Survival crashed' })).toBe('no-topic');
    notify.setTopicUrl(TOPIC);
    store.setPrefs({ ...DEFAULT_PREFS, alerts: { ...DEFAULT_PREFS.alerts, minecraft: false } });
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: 'Survival crashed' })).toBe('off');
    expect(posts).toHaveLength(0);
  });

  it('sends an event once, dropping the same one again within 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-18T10:00:00Z'));
    notify.setTopicUrl(TOPIC);
    const crash = { kind: 'minecraft' as const, key: 'minecraft:s1', title: 'Survival crashed', body: 'It stopped without being asked to.' };
    expect(await notify.notify(crash)).toBe('sent');
    expect(await notify.notify(crash)).toBe('repeat');
    expect(await notify.notify({ ...crash, title: 'Survival is back up' })).toBe('sent');
    vi.setSystemTime(Date.parse('2026-11-18T10:11:00Z'));
    expect(await notify.notify({ ...crash, title: 'Survival is back up' })).toBe('sent');
    expect(posts.map((p) => p.title)).toEqual(['Survival crashed', 'Survival is back up', 'Survival is back up']);
    expect(posts[0]).toMatchObject({ priority: '4', tags: 'rotating_light' });
    expect(notify.alertsInfo().recent.map((r) => r.type)).toEqual(['event', 'event', 'event']);
  });

  it('caps one thing at four in six hours, with one note saying it’s paused', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let t = Date.parse('2026-11-18T10:00:00Z');
    vi.setSystemTime(t);
    notify.setTopicUrl(TOPIC);
    const results: string[] = [];
    for (let i = 0; i < 7; i++) {
      vi.setSystemTime((t += 11 * MIN));
      results.push(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: `Survival crashed (${i})` }));
    }
    expect(results).toEqual(['sent', 'sent', 'sent', 'sent', 'capped', 'capped', 'capped']);
    expect(posts).toHaveLength(5);
    expect(posts[4].title).toBe('Pausing alerts: Survival crashed (4)');
    expect(posts[4].body).toMatch(/keeps coming and going.*about 6 h/);
    expect(posts[4].tags).toBe('no_bell');
    // Something else still gets through.
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s2', title: 'Creative crashed' })).toBe('sent');
    // Six hours after the first, there's room again.
    vi.setSystemTime(Date.parse('2026-11-18T10:11:00Z') + 6 * HOUR);
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: 'Survival crashed (8)' })).toBe('sent');
  });

  it('caps everything at 15 an hour, saying so once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-18T10:00:00Z'));
    notify.setTopicUrl(TOPIC);
    const results: string[] = [];
    for (let i = 0; i < 18; i++) results.push(await notify.notify({ kind: 'minecraft', key: `minecraft:s${i}`, title: `Server ${i} crashed` }));
    expect(results.filter((r) => r === 'sent')).toHaveLength(15);
    expect(results.slice(15)).toEqual(['capped', 'capped', 'capped']);
    expect(posts).toHaveLength(16);
    expect(posts[15].title).toBe('Too many alerts at once');
  });

  it('notes a failed send for Settings, and doesn’t throw', async () => {
    notify.setTopicUrl(TOPIC);
    answer = () => new Response('{"error":"nope"}', { status: 500 });
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: 'Survival crashed' })).toBe('failed');
    expect(notify.alertsInfo().lastError?.message).toBe('ntfy answered 500: nope.');
    answer = () => new Response('{}', { status: 200 });
    // An event isn't held back by the wait after a failure: there's no next try for it.
    expect(await notify.notify({ kind: 'minecraft', key: 'minecraft:s1', title: 'Survival crashed' })).toBe('sent');
    expect(notify.alertsInfo().lastError).toBeNull();
  });

  it('sends a test outside the caps, and says why one didn’t go', async () => {
    await expect(notify.sendTest()).rejects.toThrow(/topic/);
    notify.setTopicUrl(TOPIC);
    await notify.sendTest();
    expect(posts[0]).toMatchObject({ title: 'Test from Launchpad', tags: 'bell', priority: '3' });
    answer = () => new Response('{}', { status: 404 });
    await expect(notify.sendTest()).rejects.toThrow(/no ntfy server/);
    expect(notify.alertsInfo().lastError?.message).toMatch(/no ntfy server/);
    expect(notify.alertsInfo().recent[0].type).toBe('test');
  });

  it('reads back stored memory, dropping anything malformed', () => {
    expect(notify.cleanMemory(null)).toEqual(notify.emptyMemory());
    expect(notify.cleanMemory('junk')).toEqual(notify.emptyMemory());
    const m = notify.cleanMemory({
      open: { a: { kind: 'disks', title: 'Disk nearly full', clear: 'ok', at: '2026-11-18T10:00:00Z' }, b: { kind: 'nope', title: 'x', clear: 'y', at: 'z' } },
      sent: [{ at: 5, key: 'a' }, { at: 'x', key: 'b' }],
      paused: { a: 7, b: 'x' },
      recent: [{ at: '2026-11-18T10:00:00Z', kind: 'test', type: 'test', title: 'Test' }, { at: 'bad' }],
      lastError: { at: 'bad', message: 1 },
      containers: { running: ['plex', 3], restarts: { plex: [1, 'x'] } },
    });
    expect(Object.keys(m.open)).toEqual(['a']);
    expect(m.sent).toEqual([{ at: 5, key: 'a' }]);
    expect(m.paused).toEqual({ a: 7 });
    expect(m.recent).toHaveLength(1);
    expect(m.lastError).toBeNull();
    expect(m.containers).toEqual({ running: ['plex'], restarts: { plex: [1] } });
  });
});

// ---------- the watcher ----------

const warn = (key: HealthWarning['key'], name: string, text: string, detail?: string): HealthWarning => ({ key, name, text, detail });
const ctr = (name: string, state: string, status: string, self = false): ContainerInfo => ({ id: name.padEnd(64, '0'), name, image: 'img', state, status, self });
const none = () => false;

describe('health warnings', () => {
  it('become problems in Launchpad’s own words, without the error behind them', () => {
    const c = alerts.healthCheck([warn('calendar', 'Calendar', 'Failed 3 times in a row · last worked 2 h ago', 'GET https://x.example/?key=SECRET 500')], none);
    expect(c.problems).toEqual([
      { key: 'health:calendar', kind: 'health', title: 'Calendar: Failed 3 times in a row · last worked 2 h ago', body: 'Launchpad’s Server view has the details.', clear: 'Calendar: back to normal' },
    ]);
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });

  it('go quietly when the sync was switched off rather than fixed', () => {
    const c = alerts.healthCheck([], (k) => k === 'digest' || k === 'drive');
    // The old news sync's warning goes too: it became the digest's.
    expect(c.cleared).toEqual({ 'health:digest': null, 'health:drive': null, 'health:news': null });
  });
});

describe('containers', () => {
  const watch = (list: ContainerInfo[] | null, last: { at: number; names: string[] } | null = null, error: string | null = null) => ({
    list,
    error,
    configured: true,
    last: last && { at: last.at, names: new Set(last.names) },
  });
  const noMem = { running: [], restarts: {} };
  const keys = (r: { check: { problems: { key: string }[] } }) => r.check.problems.map((p) => p.key);

  it('notice one that stops after being seen running, not one that was never running', () => {
    const a = alerts.containerCheck(watch([ctr('plex', 'running', 'Up 3 days'), ctr('job', 'exited', 'Exited (0) 2 days ago')]), noMem, none, 0);
    expect(keys(a)).toEqual([]);
    expect(a.memory.running).toEqual(['plex']);
    const b = alerts.containerCheck(watch([ctr('plex', 'exited', 'Exited (137) 1 minute ago'), ctr('job', 'exited', 'Exited (0) 2 days ago')]), a.memory, none, MIN);
    expect(b.check.problems).toEqual([{ key: 'container:plex:stopped', kind: 'containers', title: 'plex stopped', body: 'Docker says: Exited (137) 1 minute ago.', clear: 'plex is running again' }]);
    // Still remembered as one that should be running, until it's removed.
    expect(b.memory.running).toEqual(['plex']);
    expect(alerts.containerCheck(watch([]), b.memory, none, 2 * MIN).memory.running).toEqual([]);
  });

  it('notice one that’s unhealthy', () => {
    expect(keys(alerts.containerCheck(watch([ctr('db', 'running', 'Up 2 hours (unhealthy)'), ctr('web', 'running', 'Up 2 hours (healthy)')]), noMem, none, 0))).toEqual(['container:db:unhealthy']);
  });

  it('notice one that keeps restarting: three restarts in half an hour', () => {
    let mem: typeof noMem = { running: [], restarts: {} };
    let last: { at: number; names: string[] } | null = null;
    const step = (t: number, c: ContainerInfo) => {
      const r = alerts.containerCheck(watch([c], last), mem, none, t);
      mem = r.memory;
      last = { at: t, names: [c.name] };
      return keys(r);
    };
    expect(step(0, ctr('app', 'running', 'Up 2 hours'))).toEqual([]);
    expect(step(MIN, ctr('app', 'running', 'Up 20 seconds'))).toEqual([]);
    expect(step(2 * MIN, ctr('app', 'restarting', 'Restarting (1) 5 seconds ago'))).toEqual([]);
    expect(step(3 * MIN, ctr('app', 'running', 'Up Less than a second'))).toEqual(['container:app:restarting']);
    expect(mem.restarts.app).toHaveLength(3);
    // Up longer than since the last look: not a restart.
    expect(step(4 * MIN, ctr('app', 'running', 'Up About a minute'))).toEqual(['container:app:restarting']);
    expect(mem.restarts.app).toHaveLength(3);
  });

  it('keep a restart problem open while it still restarts, and clear it after half an hour without', () => {
    const mem = { running: ['app'], restarts: { app: [0] } };
    const open = (k: string) => k === 'container:app:restarting';
    expect(keys(alerts.containerCheck(watch([ctr('app', 'running', 'Up 5 minutes')]), mem, open, 10 * MIN))).toEqual(['container:app:restarting']);
    expect(keys(alerts.containerCheck(watch([ctr('app', 'running', 'Up 31 minutes')]), mem, open, 31 * MIN))).toEqual([]);
  });

  it('leave Launchpad itself out', () => {
    const mem = { running: ['launchpad'], restarts: {} };
    expect(keys(alerts.containerCheck(watch([ctr('launchpad', 'exited', 'Exited (1)', true)]), mem, none, 0))).toEqual([]);
  });

  it('when Docker can’t be reached, say so and leave the rest as they were', () => {
    const r = alerts.containerCheck(watch(null, null, 'Docker isn’t reachable'), { running: ['plex'], restarts: {} }, none, 0);
    expect(keys(r)).toEqual(['container:docker']);
    expect(r.check.unknown).toEqual(['container:']);
    expect(r.memory.running).toEqual(['plex']);
    // Not set up at all: nothing to watch.
    expect(alerts.containerCheck({ list: null, error: null, configured: false, last: null }, noMem, none, 0).check).toMatchObject({ problems: [], unknown: ['container:'] });
  });

  it('read how long Docker says a container has been up', () => {
    expect(alerts.upAtMost('Up Less than a second')).toBe(1);
    expect(alerts.upAtMost('Up 1 second')).toBe(2);
    expect(alerts.upAtMost('Up 42 seconds (health: starting)')).toBe(43);
    expect(alerts.upAtMost('Up About a minute')).toBe(120);
    expect(alerts.upAtMost('Up 3 minutes (healthy)')).toBe(240);
    expect(alerts.upAtMost('Up 2 hours')).toBeNull();
    expect(alerts.upAtMost('Exited (0) 3 seconds ago')).toBeNull();
  });
});

describe('disks', () => {
  const space = (pct: number) => ({ totalBytes: 100e9, usedBytes: pct * 1e9 });
  const disk = (name: string, level: DiskHealth['level'], problems: string[] = []): DiskHealth => ({
    name, model: 'Samsung SSD 870', serial: null, capacityBytes: null, kind: 'ssd', passed: level !== 'bad', tempC: 30, powerOnHours: 1, reallocated: 0, pending: 0, uncorrectable: 0,
    percentUsed: null, mediaErrors: null, availableSpare: null, level, problems, error: null,
  });
  const report = (disks: DiskHealth[], status: DisksReport['status'] = 'ok'): DisksReport => ({ at: '', status, message: null, disks });

  it('warn at 90% full and stay open until it’s under 87%', () => {
    expect(alerts.diskCheck(space(89), null, none).problems).toEqual([]);
    const full = alerts.diskCheck(space(92), null, none);
    expect(full.problems[0]).toMatchObject({ key: 'disk:space', title: 'Disk nearly full: 92% used', body: '8 GB left on the disk Launchpad’s data is on.' });
    const open = (k: string) => k === 'disk:space';
    expect(alerts.diskCheck(space(88), null, open).problems).toHaveLength(1);
    const ok = alerts.diskCheck(space(80), null, open);
    expect(ok.problems).toEqual([]);
    expect(ok.cleared['disk:space']).toBe('Disk space is fine again: 80% used, 20 GB free');
    expect(alerts.diskCheck(null, null, none).unknown).toContain('disk:space');
  });

  it('warn about a disk SMART says is failing, in Launchpad’s words', () => {
    const c = alerts.diskCheck(space(10), report([disk('/dev/sda', 'bad', ['SMART says this disk is failing. Back it up and replace it.']), disk('/dev/sdb', 'warn', ['Running hot at 60 °C.']), disk('/dev/sdc', 'unknown')]), none);
    expect(c.problems).toEqual([{ key: 'disk:smart:/dev/sda', kind: 'disks', title: '/dev/sda (Samsung SSD 870) is failing', body: 'SMART says this disk is failing. Back it up and replace it.', clear: '/dev/sda looks healthy again' }]);
    expect(c.unknown).toEqual(['disk:smart:/dev/sdc']);
    expect(alerts.diskCheck(space(10), report([], 'no-sudo'), none).unknown).toEqual(['disk:smart:']);
    expect(alerts.isUnknown('disk:smart:/dev/sdc1', c.unknown)).toBe(false);
  });
});

describe('deciding what to send', () => {
  const problem = (key: string, kind: 'health' | 'containers' = 'containers') => ({ key, kind, title: `${key} broke`, clear: `${key} fixed` });
  const check = (keys: string[], extra: Partial<import('../server/src/alerts').Check> = {}) => ({ problems: keys.map((k) => problem(k)), unknown: [], cleared: {}, ...extra });
  const on = () => true;
  const openAt = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { kind: 'containers' as const, title: `${k} broke`, clear: `${k} fixed`, at: '2026-11-18T10:00:00Z' }]));

  it('starts a problem on its second check in a row, and never repeats it while it lasts', () => {
    const counters = new Map();
    expect(alerts.plan(check(['a']), {}, counters, on).start).toEqual([]);
    expect(alerts.plan(check(['a']), {}, counters, on).start.map((p) => p.key)).toEqual(['a']);
    expect(alerts.plan(check(['a']), openAt(['a']), counters, on)).toEqual({ start: [], clear: [], forget: [] });
  });

  it('ignores a blip: there once, then gone', () => {
    const counters = new Map();
    alerts.plan(check(['a']), {}, counters, on);
    expect(alerts.plan(check([]), {}, counters, on).start).toEqual([]);
    expect(counters.size).toBe(0);
    expect(alerts.plan(check(['a']), {}, counters, on).start).toEqual([]);
  });

  it('clears a problem once it’s been gone for two checks, with what it said it’d say', () => {
    const counters = new Map();
    expect(alerts.plan(check([]), openAt(['a']), counters, on).clear).toEqual([]);
    expect(alerts.plan(check([]), openAt(['a']), counters, on).clear).toEqual([{ key: 'a', kind: 'containers', title: 'a fixed' }]);
    // Unless the check said otherwise.
    const c2 = new Map();
    alerts.plan(check([], { cleared: { a: 'a was removed' } }), openAt(['a']), c2, on);
    expect(alerts.plan(check([], { cleared: { a: 'a was removed' } }), openAt(['a']), c2, on).clear[0].title).toBe('a was removed');
    const c3 = new Map();
    alerts.plan(check([], { cleared: { a: null } }), openAt(['a']), c3, on);
    expect(alerts.plan(check([], { cleared: { a: null } }), openAt(['a']), c3, on)).toEqual({ start: [], clear: [], forget: ['a'] });
  });

  it('leaves a problem as it was while it can’t be looked at', () => {
    const counters = new Map();
    for (let i = 0; i < 5; i++) expect(alerts.plan(check([], { unknown: ['container:'] }), openAt(['container:x:stopped']), counters, on)).toEqual({ start: [], clear: [], forget: [] });
  });

  it('drops problems whose kind is switched off, without a word, and doesn’t start them', () => {
    const counters = new Map();
    const off = () => false;
    expect(alerts.plan(check(['b']), openAt(['a']), counters, off)).toEqual({ start: [], clear: [], forget: ['a'] });
    expect(alerts.plan(check(['b']), {}, counters, off).start).toEqual([]);
  });
});

describe('the watcher end to end', () => {
  beforeEach(() => {
    stubNtfy();
    fresh();
    notify.setTopicUrl(TOPIC);
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const counters = () => new Map();
  const problemCheck = (present: boolean) => ({
    problems: present ? [{ key: 'container:plex:stopped', kind: 'containers' as const, title: 'plex stopped', body: 'Docker says: Exited (1).', clear: 'plex is running again' }] : [],
    unknown: [],
    cleared: {},
  });

  it('one alert when it starts, one when it clears, and a flapping one is paused after four', async () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const c = counters();
    const step = async (present: boolean) => {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(present), notify.memory().open, c, () => true));
    };
    for (const present of [true, true, true, true]) await step(present);
    expect(posts.map((p) => p.title)).toEqual(['plex stopped']);
    expect(notify.alertsInfo().open).toEqual([{ kind: 'containers', title: 'plex stopped', at: expect.any(String) }]);
    for (const present of [false, false, false]) await step(present);
    expect(posts.map((p) => p.title)).toEqual(['plex stopped', 'plex is running again']);
    expect(posts[1].body).toBe('It was: plex stopped');
    expect(notify.alertsInfo().open).toEqual([]);
    // It keeps coming and going.
    for (let i = 0; i < 6; i++) for (const present of [true, true, false, false]) await step(present);
    expect(posts.map((p) => p.title)).toEqual(['plex stopped', 'plex is running again', 'plex stopped', 'plex is running again', 'Pausing alerts: plex stopped']);
    // Hours later it's down again, and stays down: the phone hears once there's room.
    for (const present of [true, true]) await step(present);
    expect(posts).toHaveLength(5);
    vi.setSystemTime((t += 6 * HOUR));
    await step(true);
    expect(posts.map((p) => p.title).slice(5)).toEqual(['plex stopped']);
  });

  it('remembers what the phone was told across a restart', async () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const c = counters();
    for (const present of [true, true]) {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(present), notify.memory().open, c, () => true));
    }
    expect(posts).toHaveLength(1);
    // A restart: the memory is read from the store again, the counts start afresh.
    notify.resetForTests();
    const c2 = counters();
    for (const present of [true, true, true]) {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(present), notify.memory().open, c2, () => true));
    }
    expect(posts).toHaveLength(1);
    for (const present of [false, false]) {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(present), notify.memory().open, c2, () => true));
    }
    expect(posts.map((p) => p.title)).toEqual(['plex stopped', 'plex is running again']);
  });

  it('when sending fails, tries again a few minutes later, and only says what’s still true', async () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const c = counters();
    answer = () => new Response('{}', { status: 500 });
    const step = async (present: boolean) => {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(present), notify.memory().open, c, () => true));
    };
    await step(true);
    await step(true);
    expect(posts).toHaveLength(1);
    expect(notify.alertsInfo().lastError?.message).toMatch(/500/);
    answer = () => new Response('{}', { status: 200 });
    // Waits out the five minutes.
    for (let i = 0; i < 4; i++) await step(true);
    expect(posts).toHaveLength(1);
    await step(true);
    expect(posts.map((p) => p.title)).toEqual(['plex stopped', 'plex stopped']);
    expect(notify.alertsInfo().lastError).toBeNull();
    expect(notify.alertsInfo().open).toHaveLength(1);
  });

  it('tells a new topic about what’s going on now; saving the same one again changes nothing', async () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const c = counters();
    const step = async () => {
      vi.setSystemTime((t += MIN));
      await alerts.carryOut(alerts.plan(problemCheck(true), notify.memory().open, c, () => true));
    };
    await step();
    await step();
    expect(posts.map((p) => p.url)).toEqual([TOPIC]);
    notify.setTopicUrl(TOPIC);
    await step();
    expect(posts).toHaveLength(1);
    notify.setTopicUrl('http://203.0.113.5/launchpad-new');
    await step();
    expect(posts.map((p) => [p.url, p.title])).toEqual([[TOPIC, 'plex stopped'], ['http://203.0.113.5/launchpad-new', 'plex stopped']]);
  });

  it('checkNow does nothing at all without a topic', async () => {
    notify.setTopicUrl('');
    await alerts.checkNow();
    expect(posts).toHaveLength(0);
    expect(notify.memory().containers).toEqual({ running: [], restarts: {} });
  });
});
