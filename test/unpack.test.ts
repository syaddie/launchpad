import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  on: true,
  dir: [] as { filename: string; dir?: boolean }[],
  unpacked: [] as string[],
  fail: null as null | { message: string; folder: string | null },
  slow: null as null | Promise<void>,
}));

vi.mock('../server/src/store', async (orig) => {
  const real = await orig<typeof import('../server/src/store')>();
  return { ...real, store: { ...real.store, prefs: () => ({ ...real.store.prefs(), autoUnpack: fake.on }) } };
});
vi.mock('../server/src/archive', () => ({
  extractArchive: vi.fn(async (file: string) => {
    fake.unpacked.push(file);
    if (fake.slow) await fake.slow;
    if (fake.fail) throw Object.assign(new Error(fake.fail.message), { folder: fake.fail.folder });
    return { folder: file.replace(/\.(zip|rar|7z|tar\.gz)$/, ''), tool: 'unzip' };
  }),
}));
vi.mock('../server/src/shell', async (orig) => ({
  ...(await orig<typeof import('../server/src/shell')>()),
  sftpSession: async () => ({
    sftp: {
      readdir: (_p: string, cb: (e: null, l: unknown[]) => void) =>
        cb(null, fake.dir.map((e) => ({ filename: e.filename, attrs: { mode: e.dir ? 0o040755 : 0o100644 } }))),
    },
  }),
}));

import { archivesIn, onFinished, resetUnpackForTests, unpackRecords, unpackTargets } from '../server/src/unpack';
import type { FinishedDownload } from '../server/src/downloads';

const link = (name: string): FinishedDownload => ({ source: 'link', id: 'j1', name, path: `/home/me/Downloads/${name}`, isDir: false });

beforeEach(() => {
  fake.on = true;
  fake.dir = [];
  fake.unpacked = [];
  fake.fail = null;
  fake.slow = null;
  resetUnpackForTests();
});

describe('which archives', () => {
  it('takes archives, and only the first part of a split one', () => {
    expect(archivesIn(['film.part02.rar', 'film.part01.rar', 'film.part03.rar', 'notes.txt', 'b.zip', 'a.tar.gz', '.hidden.zip', 'film.r00', 'old.rar'])).toEqual(['a.tar.gz', 'b.zip', 'film.part01.rar', 'old.rar']);
    expect(archivesIn(['x.part1.rar', 'x.part2.rar'])).toEqual(['x.part1.rar']);
  });
  it('leaves videos, torrents Files can’t see, and files that aren’t archives', () => {
    expect(unpackTargets({ source: 'video', id: 'v', name: 'a.zip', path: '/d/a.zip', isDir: false })).toBeNull();
    expect(unpackTargets({ source: 'torrent', id: 'h', name: 'a', path: null, isDir: true })).toBeNull();
    expect(unpackTargets(link('song.mp3'))).toBeNull();
    expect(unpackTargets(link('photos.zip'))).toEqual({ files: ['/home/me/Downloads/photos.zip'] });
  });
});

describe('when a download finishes', () => {
  it('does nothing while the switch is off', async () => {
    fake.on = false;
    await onFinished(link('photos.zip'));
    expect(fake.unpacked).toEqual([]);
    expect(unpackRecords()).toEqual([]);
  });

  it('unpacks a link and says where it went', async () => {
    await onFinished(link('photos.zip'));
    expect(fake.unpacked).toEqual(['/home/me/Downloads/photos.zip']);
    expect(unpackRecords()).toMatchObject([{ file: '/home/me/Downloads/photos.zip', from: 'link', state: 'done', folder: '/home/me/Downloads/photos' }]);
  });

  it('unpacks the archives at the top of a torrent’s folder, one at a time', async () => {
    fake.dir = [{ filename: 'Film.part01.rar' }, { filename: 'Film.part02.rar' }, { filename: 'Film.nfo' }, { filename: 'Extras.zip' }, { filename: 'Sub.zip', dir: true }];
    let release!: () => void;
    fake.slow = new Promise((r) => (release = r));
    const done = onFinished({ source: 'torrent', id: 'h', name: 'Film', path: '/mnt/media/Film', isDir: true });
    await vi.waitFor(() => expect(fake.unpacked).toHaveLength(1));
    expect(unpackRecords().map((r) => r.state).sort()).toEqual(['unpacking', 'waiting']);
    release();
    await done;
    expect(fake.unpacked).toEqual(['/mnt/media/Film/Extras.zip', '/mnt/media/Film/Film.part01.rar']);
    expect(unpackRecords().every((r) => r.state === 'done' && r.from === 'torrent')).toBe(true);
  });

  it('keeps what went wrong, and where a partial unpack is', async () => {
    fake.fail = { message: 'unrar isn’t installed on the server. Install it with: sudo apt install unrar', folder: null };
    await onFinished(link('a.rar'));
    expect(unpackRecords()[0]).toMatchObject({ state: 'failed', message: expect.stringMatching(/unrar/) });
    fake.fail = { message: 'Stopped.', folder: '/home/me/Downloads/b' };
    await onFinished(link('b.zip'));
    expect(unpackRecords()[0]).toMatchObject({ state: 'failed', folder: '/home/me/Downloads/b' });
  });
});
