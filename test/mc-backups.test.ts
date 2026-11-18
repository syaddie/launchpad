import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDirOf, backupKey, backupName, fits, keepOf, manifestWorlds, packScript, parseBackupName, parseSpace, spaceProblem, spaceScript, stampOf, swapScript, toPrune } from '../server/src/mc-backups';
import { shellQuote } from '../server/src/shell';
import { fmtSize, fmtTook, fmtWhen } from '../web/src/components/McBackups';
import type { McBackup } from '../shared/types';

const GB = 1024 ** 3;

describe('backup names', () => {
  const at = new Date(Date.UTC(2026, 10, 18, 14, 30, 5));
  it('carry the server and the time, in UTC', () => {
    expect(stampOf(at)).toBe('20261118-143005');
    expect(backupName('abc_-12', at)).toBe('launchpad-abc_-12-20261118-143005.tar.gz');
    expect(backupName('abc', at, true)).toBe('launchpad-abc-20261118-143005-before-restore.tar.gz');
  });
  it('read back only for that server, and only Launchpad’s own', () => {
    expect(parseBackupName('abc', 'launchpad-abc-20261118-143005.tar.gz')).toEqual({ at, beforeRestore: false });
    expect(parseBackupName('abc', 'launchpad-abc-20261118-143005-before-restore.tar.gz')).toEqual({ at, beforeRestore: true });
    // Another server whose id starts the same way.
    expect(parseBackupName('abc', 'launchpad-abc-def-20261118-143005.tar.gz')).toBeNull();
    expect(parseBackupName('abc-def', 'launchpad-abc-20261118-143005.tar.gz')).toBeNull();
    // Someone else's files, and Launchpad's half-written ones.
    for (const n of ['world-backup.tar.gz', 'launchpad-abc-20261118-143005.zip', '.launchpad-abc-20261118-143005.tar.gz.part', 'launchpad-abc-2026111-143005.tar.gz', '../launchpad-abc-20261118-143005.tar.gz']) {
      expect(parseBackupName('abc', n), n).toBeNull();
    }
    expect(parseBackupName('abc', 'launchpad-abc-20261340-143005.tar.gz')).not.toBeNull();
    expect(parseBackupName('a b', 'launchpad-a b-20261118-143005.tar.gz')).toBeNull();
  });
  it('go by the server’s folder, so they stay with the world', () => {
    expect(backupKey('/srv/mc/survival')).toMatch(/^survival-[0-9a-f]{8}$/);
    expect(backupKey('/srv/mc/survival')).toBe(backupKey('/srv/mc/survival'));
    expect(backupKey('/srv/other/survival')).not.toBe(backupKey('/srv/mc/survival'));
    expect(backupKey("/srv/My World's (1)")).toMatch(/^My-World-s-1-[0-9a-f]{8}$/);
    expect(backupKey('/')).toMatch(/^server-[0-9a-f]{8}$/);
    const k = backupKey('/srv/mc/survival');
    expect(parseBackupName(k, backupName(k, new Date(Date.UTC(2026, 0, 2, 3, 4, 5))))).toEqual({ at: new Date(Date.UTC(2026, 0, 2, 3, 4, 5)), beforeRestore: false });
  });
  it('default the folder and the count', () => {
    expect(backupDirOf({ dir: '/srv/mc' })).toBe('/srv/mc/backups');
    expect(backupDirOf({ dir: '/srv/mc', backupDir: '/mnt/b' })).toBe('/mnt/b');
    expect(keepOf({})).toBe(7);
    expect(keepOf({ keepBackups: 3 })).toBe(3);
  });
});

describe('pruning', () => {
  const b = (day: number, beforeRestore = false): McBackup => ({ name: `launchpad-a-202611${String(day).padStart(2, '0')}-120000${beforeRestore ? '-before-restore' : ''}.tar.gz`, size: 1, at: new Date(Date.UTC(2026, 10, day, 12)).toISOString(), beforeRestore });
  it('keeps the newest and removes the rest', () => {
    const list = [b(3), b(10), b(1), b(7, true), b(9)];
    expect(toPrune(list, 3)).toEqual([b(3).name, b(1).name]);
    expect(toPrune(list, 7)).toEqual([]);
  });
  it('never removes the newest, whatever the count', () => {
    expect(toPrune([b(1), b(2)], 0)).toEqual([b(1).name]);
  });
});

describe('measuring before packing', () => {
  it('is valid shell', () => {
    const r = spawnSync('sh', ['-n'], { input: spaceScript("/srv/it's", '/srv/b', ['world', 'world_nether']) + '\n' + spaceScript('/x', '/y', []) });
    if (!r.error) expect(r.stderr.toString()).toBe('');
  });
  it('reads the worlds, their size and the room', () => {
    const sp = parseSpace('world world\nworld world_nether\nsize 2097152\nfreebackup 10485760 /mnt/big\nfreedir 5242880 /\n');
    expect(sp).toEqual({ noDir: false, worlds: ['world', 'world_nether'], size: 2 * GB, freeBackup: { bytes: 10 * GB, mount: '/mnt/big' }, freeDir: { bytes: 5 * GB, mount: '/' }, missing: [] });
    expect(parseSpace('nodir\n').noDir).toBe(true);
    expect(parseSpace('world My World\nsize 1\nfreebackup  \nmissing tar\n')).toMatchObject({ worlds: ['My World'], freeBackup: null, missing: ['tar'] });
  });
  it('refuses with a clear message when it won’t fit', () => {
    const sp = parseSpace('world world\nsize 2097152\nfreebackup 1048576 /\nfreedir 1048576 /\n');
    expect(spaceProblem(sp, '/srv/mc/backups')).toBe('Not enough space: the world is 2.0 GB and only 1.0 GB is free in /srv/mc/backups. Free some space, keep fewer backups, or pick another backups folder under Edit.');
    expect(spaceProblem(parseSpace('world world\nsize 1024\nfreebackup 10485760 /\n'), '/b')).toBeNull();
    expect(spaceProblem(parseSpace('world world\nsize 1024\nfreebackup 10485760 /\nmissing tar\nmissing gzip\n'), '/b')).toMatch(/missing tar, gzip.*sudo apt install tar gzip/);
    expect(spaceProblem(parseSpace('world world\n'), '/b')).toMatch(/couldn’t work out/);
  });
  it('leaves some room over', () => {
    expect(fits(GB, GB)).toBe(false);
    expect(fits(GB, 2 * GB)).toBe(true);
  });
  it('keeps the manifest to plain folders inside the server’s', () => {
    expect(manifestWorlds('world\nworld_nether\n\n../etc\n/abs\nworld\nworlds/a b\n')).toEqual(['world', 'world_nether', 'worlds/a b']);
  });
});

describe('the page’s numbers', () => {
  it('says sizes, times and how long', () => {
    expect(fmtSize(1536)).toBe('2 KB');
    expect(fmtSize(5 * 1024 ** 2)).toBe('5 MB');
    expect(fmtSize(1.25 * GB)).toBe('1.3 GB');
    expect(fmtWhen('2026-11-18T06:30:00Z', new Date('2026-12-01T00:00:00Z'))).toBe('18 Nov 14:30');
    expect(fmtWhen('2025-11-18T06:30:00Z', new Date('2026-12-01T00:00:00Z'))).toBe('18 Nov 2025 14:30');
    expect(fmtTook(42_000)).toBe('42 s');
    expect(fmtTook(3 * 60_000)).toBe('3 min');
    expect(fmtTook(65 * 60_000)).toBe('1 h 5 min');
  });
});

// Packing and swapping for real, with this machine's sh and tar, where there are some.
const hasTools = !spawnSync('sh', ['-c', 'command -v tar && command -v gzip && command -v nice'], { encoding: 'utf8' }).error && spawnSync('sh', ['-c', 'command -v tar && command -v gzip && command -v nice']).status === 0;
/** A path as sh sees it: Git Bash on Windows wants /c/…, and tar reads C: as a remote host. */
const shPath = (p: string) => (process.platform === 'win32' ? p.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/${d.toLowerCase()}/`).replace(/\\/g, '/') : p);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-mc-backups-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const run = (script: string) => spawnSync('sh', ['-c', script], { encoding: 'utf8' });

// sh and tar are slow to start on Windows, more so with the other test files running.
describe.runIf(hasTools)('packing and restoring a world for real', { timeout: 60_000 }, () => {
  const dir = path.join(root, "server's folder");
  const backups = path.join(root, 'backups');
  const D = shPath(dir);
  const B = shPath(backups);
  const write = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

  it('packs the worlds and leaves no part file, with Launchpad there to turn saving on', () => {
    write('world/level.dat', 'overworld v1');
    write('world_nether/DIM-1/r.0.0.mca', 'nether v1');
    write('server.properties', 'level-name=world');
    fs.mkdirSync(backups, { recursive: true });
    const r = run(packScript(D, B, ['world', 'world_nether'], 'launchpad-a-20261118-120000.tar.gz', `echo save-on > ${shPath(path.join(root, 'after.txt'))}`));
    expect(r.stdout.trim()).toBe('packed');
    expect(r.status).toBe(0);
    // Launchpad read the answer, so it types save-on itself.
    expect(fs.existsSync(path.join(root, 'after.txt'))).toBe(false);
    expect(fs.readdirSync(backups)).toEqual(['launchpad-a-20261118-120000.tar.gz']);
    const list = run(`tar -tzf ${shellQuote(B + '/launchpad-a-20261118-120000.tar.gz')}`).stdout.split('\n');
    expect(list[0]).toBe('launchpad-worlds.txt');
    expect(list).toContain('world/level.dat');
    expect(list).not.toContain('server.properties');
  });

  it('turns saving on from the host when Launchpad went away while tar ran', () => {
    // Nothing reads what the script prints: the connection closed under it.
    const r = run(`(${packScript(D, B, ['world'], 'launchpad-a-20261118-121000.tar.gz', `echo save-on > ${shPath(path.join(root, 'after.txt'))}`)}) | true`);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(root, 'after.txt'), 'utf8').trim()).toBe('save-on');
    fs.rmSync(path.join(backups, 'launchpad-a-20261118-121000.tar.gz'));
  });

  it('says so when tar fails, and cleans up', () => {
    fs.rmSync(path.join(root, 'after.txt'), { force: true });
    const r = run(packScript(D, B, ['no-such-world'], 'launchpad-a-20261118-130000.tar.gz', `echo ran > ${shPath(path.join(root, 'after.txt'))}`));
    expect(r.stdout.trim()).toBe('failed');
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(root, 'after.txt'))).toBe(false);
    expect(fs.readdirSync(backups)).toEqual(['launchpad-a-20261118-120000.tar.gz']);
  });

  it('swaps an unpacked backup into place', () => {
    write('world/level.dat', 'overworld v2');
    write('world_nether/DIM-1/r.0.0.mca', 'nether v2');
    const tmp = '.launchpad-restore-20261118-140000';
    const old = '.launchpad-old-20261118-140000';
    const un = run(`cd ${shellQuote(D)} && mkdir -- ${tmp} && tar -xzf ${shellQuote(B + '/launchpad-a-20261118-120000.tar.gz')} -C ${tmp} --no-same-owner`);
    expect(un.status).toBe(0);
    expect(manifestWorlds(fs.readFileSync(path.join(dir, tmp, 'launchpad-worlds.txt'), 'utf8'))).toEqual(['world', 'world_nether']);
    const sw = run(swapScript(D, tmp, old, ['world', 'world_nether']));
    expect(sw.stdout).toContain('swapped');
    expect(read('world/level.dat')).toBe('overworld v1');
    expect(read('world_nether/DIM-1/r.0.0.mca')).toBe('nether v1');
    expect(read('server.properties')).toBe('level-name=world');
    expect(fs.existsSync(path.join(dir, tmp))).toBe(false);
    expect(fs.existsSync(path.join(dir, old))).toBe(false);
  });

  it('changes nothing when the backup lacks a world it should have', () => {
    const tmp = '.launchpad-restore-20261118-150000';
    fs.mkdirSync(path.join(dir, tmp, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, tmp, 'world', 'level.dat'), 'other');
    const sw = run(swapScript(D, tmp, '.launchpad-old-20261118-150000', ['world', 'world_the_end']));
    expect(sw.status).toBe(13);
    expect(read('world/level.dat')).toBe('overworld v1');
    fs.rmSync(path.join(dir, tmp), { recursive: true, force: true });
  });

  it('puts the old world back when a move fails halfway', () => {
    const tmp = '.launchpad-restore-20261118-160000';
    const old = '.launchpad-old-20261118-160000';
    fs.mkdirSync(path.join(dir, tmp, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, tmp, 'world', 'level.dat'), 'new');
    fs.mkdirSync(path.join(dir, tmp, 'world_nether'), { recursive: true });
    // A file where a folder should go makes the second move into place fail.
    const script = swapScript(D, tmp, old, ['world', 'world_nether']).replace(/(mkdir -p -- '\.' && mv -- '\.launchpad-restore-20261118-160000\/world_nether')/, "mkdir -p -- '.' && false && $1");
    const sw = run(script);
    expect(sw.status).toBe(12);
    expect(read('world/level.dat')).toBe('overworld v1');
    expect(read('world_nether/DIM-1/r.0.0.mca')).toBe('nether v1');
    expect(fs.readFileSync(path.join(dir, tmp, 'world', 'level.dat'), 'utf8')).toBe('new');
  });

  it('is valid shell for odd names', () => {
    const r = spawnSync('sh', ['-n'], { input: swapScript("/srv/it's", '.t', '.o', ['worlds/my world', "o'neil"]) + '\n' + packScript("/srv/it's", '/b', ['a b'], 'x.tar.gz', 'echo hi') });
    expect(r.stderr.toString()).toBe('');
  });
});
