import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { config } from '../server/src/config';
import { onDownloadFinished, type FinishedDownload } from '../server/src/downloads';
import {
  addTorrentLinks,
  cleanCategory,
  cleanRatio,
  cleanSpeedCaps,
  cleanTags,
  observe,
  priorityOf,
  resetWatch,
  setFilePriority,
  setRatio,
  setSpeedCaps,
  setTurtle,
  tagList,
  toFiles,
  torrentFiles,
  torrentOptions,
  torrents,
  toSpeed,
  toTorrent,
} from '../server/src/qbit';
import { capText, capValue, speedLine } from '../web/src/components/Downloads';

const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);

describe('reading qBittorrent', () => {
  it('reads a torrent’s category and tags, without Launchpad’s own tag', () => {
    const t = toTorrent({ hash: H1, name: 'x', category: 'Linux', tags: 'iso, work,launchpad-new-0123abcd', progress: 1, state: 'stalledUP' });
    expect(t).toMatchObject({ category: 'Linux', tags: ['iso', 'work'], ratioLimit: null });
    expect(toTorrent({}).tags).toEqual([]);
    expect(tagList(' a ,, b ')).toEqual(['a', 'b']);
  });

  it('reads the speed caps, none as 0', () => {
    expect(toSpeed('1', { dl_limit: 0, up_limit: -1, alt_dl_limit: 1_048_576, alt_up_limit: 102_400 })).toEqual({ turtle: true, dl: 0, up: 0, turtleDl: 1_048_576, turtleUp: 102_400 });
    expect(toSpeed('0\n', {}).turtle).toBe(false);
  });

  it('reads file priorities', () => {
    expect(priorityOf(0)).toBe('skip');
    expect(priorityOf(1)).toBe('normal');
    expect(priorityOf(6)).toBe('high');
    expect(priorityOf(7)).toBe('high');
    expect(priorityOf(undefined)).toBe('normal');
  });

  it('finds each file’s folder on the server, where qBittorrent keeps it now', () => {
    const old = { ...config.qbit };
    Object.assign(config.qbit, { saveDir: '/downloads', hostDir: '/home/me/torrents' });
    try {
      const files = [
        { index: 0, name: 'Album/CD1/01.flac', size: 10, progress: 0.5, priority: 1 },
        { index: 1, name: 'Album/cover.jpg', size: 2, progress: 1, priority: 0 },
      ];
      expect(toFiles(files, { save_path: '/downloads/Music', progress: 1 })).toEqual([
        { index: 0, name: 'Album/CD1/01.flac', size: 10, progress: 0.5, priority: 'normal', hostDir: '/home/me/torrents/Music/Album/CD1' },
        { index: 1, name: 'Album/cover.jpg', size: 2, progress: 1, priority: 'skip', hostDir: '/home/me/torrents/Music/Album' },
      ]);
      expect(toFiles([{ name: 'one.iso' }], { save_path: '/downloads/', progress: 1 })[0]).toMatchObject({ index: 0, hostDir: '/home/me/torrents' });
      // Unfinished, in qBittorrent's folder for those: under QBIT_SAVE_DIR it opens, elsewhere it can't.
      expect(toFiles([{ name: 'a/b.mkv' }], { save_path: '/downloads', download_path: '/downloads/incomplete', progress: 0.2 })[0].hostDir).toBe('/home/me/torrents/incomplete/a');
      expect(toFiles([{ name: 'a/b.mkv' }], { save_path: '/downloads', download_path: '/temp', progress: 0.2 })[0].hostDir).toBe(null);
      expect(toFiles([{ name: 'a/b.mkv' }], { save_path: '/downloads', download_path: '/temp', progress: 1 })[0].hostDir).toBe('/home/me/torrents/a');
    } finally {
      Object.assign(config.qbit, old);
    }
  });
});

describe('what torrents are added with', () => {
  it('takes a ratio more than 0 and at most 100', () => {
    expect(cleanRatio(2)).toBe(2);
    expect(cleanRatio('1.256')).toBe(1.26);
    expect(cleanRatio('')).toBe(null);
    expect(cleanRatio(null)).toBe(null);
    for (const bad of [0, -1, 101, 'two', Infinity]) expect(() => cleanRatio(bad), String(bad)).toThrow();
  });

  it('takes a category that can be a folder’s name', () => {
    expect(cleanCategory(' Movies ')).toBe('Movies');
    expect(cleanCategory('')).toBe(null);
    for (const bad of ['a/b', 'a\\b', '..', 'x'.repeat(61), 42]) expect(() => cleanCategory(bad), String(bad)).toThrow();
  });

  it('takes up to 20 tags without commas', () => {
    expect(cleanTags(['a', ' b ', 'a', ''])).toEqual(['a', 'b']);
    expect(cleanTags('x, y')).toEqual(['x', 'y']);
    expect(cleanTags(undefined)).toEqual([]);
    expect(() => cleanTags(Array.from({ length: 21 }, (_, i) => `t${i}`))).toThrow();
    expect(() => cleanTags(['launchpad-new-0123abcd'])).toThrow();
    expect(() => cleanTags([42])).toThrow();
  });

  it('takes speed caps of at least 1 KB/s, or none', () => {
    expect(cleanSpeedCaps({ dl: 2_000_000, up: 0, turtleDl: null })).toEqual({ dl: 2_000_000, up: 0, turtleDl: 0 });
    expect(() => cleanSpeedCaps({ dl: 10 })).toThrow();
    expect(() => cleanSpeedCaps({ dl: 3_000_000_000 })).toThrow();
    expect(() => cleanSpeedCaps({})).toThrow();
    expect(() => cleanSpeedCaps({ up: 'fast' })).toThrow();
  });
});

describe('the speed caps on the page', () => {
  it('says what’s capped', () => {
    expect(speedLine({ turtle: false, dl: 0, up: 0, turtleDl: 1e6, turtleUp: 1e5 })).toBe(null);
    expect(speedLine({ turtle: true, dl: 0, up: 0, turtleDl: 1e6, turtleUp: 1e5 })).toBe('Turtle mode: downloads up to 1.00 MB/s, uploads up to 100 KB/s.');
    expect(speedLine({ turtle: true, dl: 0, up: 0, turtleDl: 0, turtleUp: 0 })).toBe('Turtle mode: downloads at full speed, uploads at full speed.');
    expect(speedLine({ turtle: false, dl: 5e6, up: 0, turtleDl: 0, turtleUp: 0 })).toBe('Capped: downloads up to 5.00 MB/s, uploads at full speed.');
  });

  it('reads and writes MB/s', () => {
    expect(capText(0)).toBe('');
    expect(capText(2_000_000)).toBe('2');
    expect(capText(1_048_576)).toBe('1.049');
    expect(capValue('')).toBe(0);
    expect(capValue('0')).toBe(0);
    expect(capValue('2')).toBe(2_000_000);
    expect(capValue('0,5')).toBe(500_000);
    expect(capValue('fast')).toBe(null);
    expect(capValue('0.0001')).toBe(null);
    expect(capValue('-1')).toBe(null);
  });
});

// ---------- against a stand-in qBittorrent ----------

type Call = { path: string; method: string; body: Record<string, string> };

/** A fetch that answers like qBittorrent from `routes`, keeping each call. */
function fakeQbit(routes: Record<string, unknown | ((c: Call) => unknown)>) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const body: Record<string, string> = {};
    if (init?.body instanceof URLSearchParams) for (const [k, v] of init.body) body[k] = v;
    else if (init?.body instanceof FormData) for (const [k, v] of init.body) body[k] = typeof v === 'string' ? v : `<file ${(v as File).name}>`;
    const call = { path: url.pathname + url.search, method: init?.method ?? 'GET', body };
    calls.push(call);
    const route = routes[url.pathname] ?? routes[url.pathname + url.search];
    if (route === undefined) return new Response('Not Found', { status: 404 });
    const out = typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route;
    if (out instanceof Response) return out;
    return typeof out === 'string' ? new Response(out) : Response.json(out);
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

describe('with qBittorrent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-qbit-'));
  const old = { qbit: { ...config.qbit }, dataDir: config.dataDir };
  let n = 0;
  beforeEach(() => {
    config.dataDir = path.join(dir, `d${n++}`);
    Object.assign(config.qbit, { url: 'http://qbit.test', user: '', pass: '', saveDir: '/downloads', hostDir: '/home/me/torrents' });
    resetWatch();
  });
  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => {
    Object.assign(config.qbit, old.qbit);
    config.dataDir = old.dataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const watchFile = () => JSON.parse(fs.readFileSync(path.join(config.dataDir, 'torrent-watch.json'), 'utf8'));
  const seeding = (more: object) => ({ hash: H1, name: 'ubuntu.iso', progress: 1, state: 'stalledUP', save_path: '/downloads', content_path: '/downloads/ubuntu.iso', ratio: 0.5, completion_on: 1, ...more });

  it('adds with a new category, tags and a ratio, and gives the torrent its ratio once it shows up', async () => {
    const calls = fakeQbit({
      '/api/v2/torrents/categories': { Linux: { name: 'Linux', savePath: '' } },
      '/api/v2/torrents/createCategory': '',
      '/api/v2/torrents/createTags': '',
      '/api/v2/torrents/add': 'Ok.',
      '/api/v2/torrents/removeTags': '',
      '/api/v2/torrents/deleteTags': '',
    });
    await addTorrentLinks('magnet:?xt=urn:btih:' + H1, { category: 'Movies', tags: ['hd'], ratio: 2 });
    expect(calls.find((c) => c.path === '/api/v2/torrents/createCategory')?.body).toEqual({ category: 'Movies', savePath: '' });
    const add = calls.find((c) => c.path === '/api/v2/torrents/add')!;
    expect(add.body).toMatchObject({ urls: 'magnet:?xt=urn:btih:' + H1, category: 'Movies', autoTMM: 'true' });
    expect(add.body).not.toHaveProperty('ratioLimit');
    const tag = add.body.tags.split(',').find((t) => t.startsWith('launchpad-new-'))!;
    expect(add.body.tags.split(',')).toEqual(['hd', tag]);
    expect(Object.keys(watchFile().pending)).toEqual([tag]);

    await observe([{ hash: H1, name: 'x', progress: 0, state: 'metaDL', tags: `hd, ${tag}` }]);
    expect(watchFile().ratios[H1].ratio).toBe(2);
    expect(watchFile().pending).toEqual({});
    await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/v2/torrents/deleteTags' && c.body.tags === tag)).toBe(true));
    expect(calls.find((c) => c.path === '/api/v2/torrents/removeTags')?.body).toEqual({ hashes: H1, tags: tag });
  });

  it('forgets the ratio when qBittorrent doesn’t take the torrent', async () => {
    fakeQbit({ '/api/v2/torrents/createTags': '', '/api/v2/torrents/add': 'Fails.', '/api/v2/torrents/deleteTags': '' });
    await expect(addTorrentLinks('magnet:?xt=urn:btih:' + H1, { ratio: 1 })).rejects.toThrow(/didn’t add it/);
    expect(watchFile().pending).toEqual({});
  });

  it('adds a category it already has without making it again, and nothing extra without options', async () => {
    const calls = fakeQbit({ '/api/v2/torrents/categories': { Linux: {} }, '/api/v2/torrents/add': 'Ok.' });
    await addTorrentLinks('magnet:?xt=urn:btih:' + H1, { category: 'Linux' });
    expect(calls.map((c) => c.path)).toEqual(['/api/v2/torrents/categories', '/api/v2/torrents/add']);
    await addTorrentLinks('magnet:?xt=urn:btih:' + H2);
    expect(calls.at(-1)!.body).toEqual({ urls: 'magnet:?xt=urn:btih:' + H2 });
  });

  it('takes a torrent out at its ratio, never deleting its files', async () => {
    const calls = fakeQbit({ '/api/v2/torrents/delete': '' });
    await setRatio(H1, 1.5);
    await observe([seeding({ ratio: 1.2 })]);
    await observe([seeding({ ratio: 2, progress: 0.9, state: 'downloading' })]);
    expect(calls.filter((c) => c.path === '/api/v2/torrents/delete')).toHaveLength(0);
    await observe([seeding({ ratio: 1.5 }), seeding({ hash: H2, ratio: 9 })]);
    const deletes = calls.filter((c) => c.path === '/api/v2/torrents/delete');
    expect(deletes).toEqual([{ path: '/api/v2/torrents/delete', method: 'POST', body: { hashes: H1, deleteFiles: 'false' } }]);
    expect(watchFile().ratios).toEqual({});
    const info = await (async () => {
      fakeQbit({ '/api/v2/torrents/info': [], '/api/v2/transfer/info': {}, '/api/v2/transfer/speedLimitsMode': '0', '/api/v2/app/preferences': {}, '/api/v2/app/version': 'v5.1.0' });
      return torrents();
    })();
    expect(info.retired).toEqual([{ name: 'ubuntu.iso', ratio: 1.5, at: expect.any(String), hostDir: '/home/me/torrents' }]);
  });

  it('shows each torrent’s ratio, and forgets those of torrents that have gone', async () => {
    await setRatio(H1, 3);
    fakeQbit({ '/api/v2/torrents/info': [seeding({ ratio: 1 })], '/api/v2/transfer/info': { dl_info_speed: 5 }, '/api/v2/transfer/speedLimitsMode': '1', '/api/v2/app/preferences': { alt_dl_limit: 2048 } });
    const info = await torrents();
    expect(info.torrents[0]).toMatchObject({ hash: H1, ratioLimit: 3 });
    expect(info.speed).toEqual({ turtle: true, dl: 0, up: 0, turtleDl: 2048, turtleUp: 0 });
    await observe([], Date.now() + 11 * 60_000);
    expect(watchFile().ratios).toEqual({});
    await setRatio(H2, null);
    expect(watchFile().ratios).toEqual({});
  });

  it('tells the download-finished hook about torrents that finish, once', async () => {
    const got: FinishedDownload[] = [];
    const off = onDownloadFinished((d) => void got.push(d));
    try {
      fakeQbit({
        [`/api/v2/torrents/files?hash=${H1}`]: [{ name: 'ubuntu.iso' }],
        [`/api/v2/torrents/files?hash=${H2}`]: [{ name: 'Show/e1.mkv' }, { name: 'Show/e2.mkv' }],
      });
      const start = Math.floor(Date.now() / 1000);
      // The first look: what finished before Launchpad started watching isn't news.
      await observe([seeding({ completion_on: start - 100 })]);
      expect(watchFile().finishedUpTo).toBeGreaterThanOrEqual(start);
      await observe([
        seeding({ completion_on: start + 5 }),
        seeding({ hash: H2, name: 'Show', content_path: '/downloads/TV/Show', save_path: '/downloads/TV', completion_on: start + 6 }),
        seeding({ hash: 'c'.repeat(40), completion_on: start + 7, state: 'moving' }),
      ]);
      await vi.waitFor(() => expect(got).toHaveLength(2));
      expect(got).toEqual([
        { source: 'torrent', id: H1, name: 'ubuntu.iso', path: '/home/me/torrents/ubuntu.iso', isDir: false },
        { source: 'torrent', id: H2, name: 'Show', path: '/home/me/torrents/TV/Show', isDir: true },
      ]);
      await observe([seeding({ completion_on: start + 5 })]);
      await new Promise((r) => setTimeout(r, 20));
      expect(got).toHaveLength(2);
    } finally {
      off();
    }
  });

  it('lists and changes a torrent’s files', async () => {
    const calls = fakeQbit({
      [`/api/v2/torrents/files?hash=${H1}`]: [{ index: 0, name: 'a/one.mkv', size: 5, progress: 1, priority: 1 }],
      [`/api/v2/torrents/info?hashes=${H1}`]: [{ hash: H1, save_path: '/downloads', progress: 1 }],
      '/api/v2/torrents/filePrio': '',
    });
    expect(await torrentFiles(H1)).toEqual([{ index: 0, name: 'a/one.mkv', size: 5, progress: 1, priority: 'normal', hostDir: '/home/me/torrents/a' }]);
    await setFilePriority(H1, [0, 3], 'high');
    expect(calls.find((c) => c.path === '/api/v2/torrents/filePrio')?.body).toEqual({ hash: H1, id: '0|3', priority: '6' });
    await expect(setFilePriority(H1, [], 'skip')).rejects.toThrow();
    await expect(setFilePriority(H1, [0], 'max')).rejects.toThrow();
    await expect(torrentFiles('nope')).rejects.toThrow();
  });

  it('says when a torrent has gone', async () => {
    fakeQbit({});
    await expect(torrentFiles(H1)).rejects.toMatchObject({ status: 404 });
  });

  it('switches turtle mode only when it isn’t already', async () => {
    let mode = '0';
    const calls = fakeQbit({
      '/api/v2/transfer/speedLimitsMode': () => mode,
      '/api/v2/transfer/toggleSpeedLimitsMode': () => ((mode = mode === '1' ? '0' : '1'), ''),
    });
    await setTurtle(true);
    await setTurtle(true);
    expect(calls.filter((c) => c.path.endsWith('toggleSpeedLimitsMode'))).toHaveLength(1);
    expect(mode).toBe('1');
    await setTurtle(false);
    expect(mode).toBe('0');
    await expect(setTurtle('yes')).rejects.toThrow();
  });

  it('sets the caps in qBittorrent’s preferences, in bytes a second', async () => {
    const calls = fakeQbit({ '/api/v2/app/setPreferences': '' });
    await setSpeedCaps({ turtleDl: 1_000_000, turtleUp: 0 });
    expect(JSON.parse(calls[0].body.json)).toEqual({ alt_dl_limit: 1_000_000, alt_up_limit: 0 });
  });

  it('lists categories with their folders, and tags without Launchpad’s own', async () => {
    fakeQbit({
      '/api/v2/torrents/categories': { TV: { name: 'TV', savePath: '/downloads/Shows' }, Movies: { name: 'Movies', savePath: '' }, Odd: { savePath: '/elsewhere' } },
      '/api/v2/torrents/tags': ['work', 'launchpad-new-0123abcd', 'hd'],
      '/api/v2/app/preferences': { save_path: '/downloads/' },
    });
    expect(await torrentOptions()).toEqual({
      categories: [
        { name: 'Movies', savePath: '/downloads/Movies', hostDir: '/home/me/torrents/Movies' },
        { name: 'Odd', savePath: '/elsewhere', hostDir: null },
        { name: 'TV', savePath: '/downloads/Shows', hostDir: '/home/me/torrents/Shows' },
      ],
      tags: ['hd', 'work'],
    });
  });
});
