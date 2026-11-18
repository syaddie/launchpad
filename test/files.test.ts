import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { archiveOf, numberedName, previewOf, TRASH_DAYS, type TrashItem } from '../shared/files';
import { DEFAULT_PREFS } from '../shared/defaults';
import { cleanFolders, cleanPrefs } from '../server/src/clean';
import { downloadHeaders, etagOf, ifRangeOk, inlineHeaders, parseRange, rangeHeaders } from '../server/src/fileserve';
import { expired, formatTrashInfo, hostOffset, localStamp, parseDf, parseMounts, parsePlace, parseTrashInfo, trashDirFor, topdirOf, cleanPaths } from '../server/src/trash';
import { checkMembers, extractError, parse7zList, parsePyList, parseTarList, parseUnrarList, parseZipInfo, planCompress, planExtract, type Member } from '../server/src/archive';
import { cleanQuery, contentCommand, globEscape, nameCommand, parseContents, parseNames } from '../server/src/filesearch';
import { parseDu, zipName } from '../server/src/fileops';
import { splitPgid, wrapCommand } from '../server/src/remote';
import { zipChunks, type ZipSource } from '../server/src/zipstream';
import { unzip } from '../server/src/zip';
import { fmtFolderSize, rangeOf } from '../web/src/components/Files';

describe('previews and ranges', () => {
  it('previews only media a browser never runs as a page', () => {
    expect(previewOf('a.JPG')).toEqual({ type: 'image/jpeg', kind: 'image' });
    expect(previewOf('x.mkv')?.kind).toBe('video');
    expect(previewOf('t.flac')?.kind).toBe('audio');
    expect(previewOf('doc.pdf')?.kind).toBe('pdf');
    for (const bad of ['page.html', 'page.htm', 'logo.svg', 'feed.xml', 'x.xhtml', 'run.js', 'noext', 'a.svgz']) expect(previewOf(bad)).toBeNull();
  });

  it('sends inline only with nosniff and a sandboxing CSP', () => {
    expect(inlineHeaders('page.html')).toBeNull();
    expect(inlineHeaders('logo.svg')).toBeNull();
    const img = inlineHeaders('cat.png')!;
    expect(img['Content-Type']).toBe('image/png');
    expect(img['X-Content-Type-Options']).toBe('nosniff');
    expect(img['Content-Security-Policy']).toMatch(/default-src 'none'/);
    expect(img['Content-Security-Policy']).toMatch(/sandbox/);
    expect(img['Content-Disposition']).toMatch(/^inline; filename\*=UTF-8''cat\.png$/);
    const pdf = inlineHeaders('a b.pdf')!;
    expect(pdf['Content-Security-Policy']).toMatch(/default-src 'none'/);
    expect(pdf['Content-Disposition']).toContain('a%20b.pdf');
    expect(downloadHeaders('x.html')['Content-Type']).toBe('application/octet-stream');
    expect(downloadHeaders('x.html')['Content-Disposition']).toMatch(/^attachment/);
  });

  it('reads one byte range, as RFC 9110 has it', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseRange('bytes=90-500', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=100-', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 100)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
    // Ignored, so the whole file goes: several ranges, other units, nonsense, a backwards range.
    for (const h of ['bytes=0-1,5-6', 'items=0-1', 'bytes=x-y', 'bytes=-', 'bytes=20-10']) expect(parseRange(h, 100)).toBeNull();
  });

  it('answers 200, 206 or 416 with the right headers', () => {
    const full = rangeHeaders(100, null, 1700000000);
    expect(full.status).toBe(200);
    expect(full.headers['Content-Length']).toBe('100');
    expect(full.headers['Accept-Ranges']).toBe('bytes');
    const part = rangeHeaders(100, { start: 10, end: 19 }, 1700000000);
    expect(part.status).toBe(206);
    expect(part.headers['Content-Range']).toBe('bytes 10-19/100');
    expect(part.headers['Content-Length']).toBe('10');
    const none = rangeHeaders(100, 'unsatisfiable', 1700000000);
    expect(none.status).toBe(416);
    expect(none.headers['Content-Range']).toBe('bytes */100');
  });

  it('sends a changed file whole for an If-Range that no longer matches', () => {
    const tag = etagOf(100, 1700000000);
    expect(ifRangeOk(undefined, tag)).toBe(true);
    expect(ifRangeOk(tag, tag)).toBe(true);
    expect(ifRangeOk(etagOf(101, 1700000000), tag)).toBe(false);
    expect(ifRangeOk('Wed, 01 Jan 2025 00:00:00 GMT', tag)).toBe(false);
  });
});

describe('names', () => {
  it('numbers a name that is taken, keeping two-part extensions', () => {
    expect(numberedName('photo.jpg', 1)).toBe('photo.jpg');
    expect(numberedName('photo.jpg', 2)).toBe('photo (2).jpg');
    expect(numberedName('backup.tar.gz', 3)).toBe('backup (3).tar.gz');
    expect(numberedName('folder', 2)).toBe('folder (2)');
    expect(numberedName('.bashrc', 2)).toBe('.bashrc (2)');
    expect(numberedName('my.notes v2', 2)).toBe('my.notes v2 (2)');
  });

  it('knows the archives it can unpack and the folder they go in', () => {
    expect(archiveOf('photos.zip')).toEqual({ kind: 'zip', stem: 'photos' });
    expect(archiveOf('site.tar.gz')).toEqual({ kind: 'tar', stem: 'site' });
    expect(archiveOf('a.b.tgz')).toEqual({ kind: 'tar', stem: 'a.b' });
    expect(archiveOf('x.tar.xz')).toEqual({ kind: 'tar', stem: 'x' });
    expect(archiveOf('x.tar.bz2')?.kind).toBe('tar');
    expect(archiveOf('x.tar')?.kind).toBe('tar');
    expect(archiveOf('x.7z')).toEqual({ kind: '7z', stem: 'x' });
    expect(archiveOf('Movie.Part1.RAR')).toEqual({ kind: 'rar', stem: 'Movie.Part1' });
    for (const no of ['notes.txt', 'x.gz', '.zip', 'zip']) expect(archiveOf(no)).toBeNull();
  });

  it('names a zip after the one thing in it, or its folder', () => {
    expect(zipName(['/home/me/photos'])).toBe('photos.zip');
    expect(zipName(['/home/me/a.txt', '/home/me/b.txt'])).toBe('me.zip');
    expect(zipName(['/a', '/b'])).toBe('files.zip');
  });

  it('takes a list of absolute paths, without repeats', () => {
    expect(cleanPaths(['/a/b/', '/a/b', '/c'])).toEqual(['/a/b', '/c']);
    expect(cleanPaths('/one')).toEqual(['/one']);
    expect(() => cleanPaths([])).toThrow();
    expect(() => cleanPaths(['relative'])).toThrow();
    expect(() => cleanPaths(Array.from({ length: 1001 }, (_, i) => `/${i}`))).toThrow();
  });

  it('chooses a run of rows for a shift-click, either way', () => {
    const names = ['a', 'b', 'c', 'd'];
    expect(rangeOf(names, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeOf(names, 'd', 'a')).toEqual(['a', 'b', 'c', 'd']);
    expect(rangeOf(names, 'gone', 'c')).toEqual(['c']);
  });

  it('shows a partly unreadable folder’s size as at least that', () => {
    expect(fmtFolderSize({ bytes: 1_500_000, partial: false })).toBe('1.50 MB');
    expect(fmtFolderSize({ bytes: 1_500_000, partial: true })).toBe('≥ 1.50 MB');
  });
});

describe('pinned folders', () => {
  it('keeps absolute, normalised paths without repeats, at most 30', () => {
    expect(cleanFolders(['/srv/media/', '/srv//media', '/home/me/../you', 'relative', 42, '/a\0b', '/' + 'x'.repeat(1100)])).toEqual(['/srv/media', '/home/you']);
    expect(cleanFolders(Array.from({ length: 40 }, (_, i) => `/f${i}`))).toHaveLength(30);
  });

  it('are saved with the settings and kept when other settings change', () => {
    const prev = { ...DEFAULT_PREFS, pinnedFolders: ['/srv/media'] };
    expect(cleanPrefs({ pinnedFolders: ['/a', '/b'] }, prev).pinnedFolders).toEqual(['/a', '/b']);
    expect(cleanPrefs({ name: 'Me' }, prev).pinnedFolders).toEqual(['/srv/media']);
    expect(cleanPrefs({ pinnedFolders: 'nope' as unknown as string[] }, prev).pinnedFolders).toEqual(['/srv/media']);
    // Settings saved before pins existed get none.
    const { pinnedFolders: _, ...old } = DEFAULT_PREFS;
    expect(cleanPrefs({}, old as typeof DEFAULT_PREFS).pinnedFolders).toEqual([]);
  });
});

describe('trash', () => {
  const place = { uid: 1000, home: '/home/me', homeTrash: '/home/me/.local/share/Trash', homeMount: '/', offsetMin: 480 };

  it('keeps a trash on the same disk as what goes in it', () => {
    expect(trashDirFor('/', place)).toBe('/home/me/.local/share/Trash');
    expect(trashDirFor('/mnt/media', place)).toBe('/mnt/media/.Trash-1000');
    expect(trashDirFor('/home', { ...place, homeMount: '/home' })).toBe('/home/me/.local/share/Trash');
    expect(trashDirFor('/', { ...place, homeMount: '/home' })).toBe('/.Trash-1000');
    expect(topdirOf('/mnt/media/.Trash-1000', place)).toBe('/mnt/media');
    expect(topdirOf(place.homeTrash, place)).toBeNull();
  });

  it('reads df -P lines, spaces and all', () => {
    expect(parseDf('/dev/sda1        959863856 512345678 398765432  57% /')).toEqual({ mount: '/', availKb: 398765432 });
    expect(parseDf('//nas/my share   100 50 50 50% /mnt/my share')).toEqual({ mount: '/mnt/my share', availKb: 50 });
    expect(parseDf('C:               496692220 445139232  51552988      90% /c')?.mount).toBe('/c');
    expect(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on')).toBeNull();
  });

  it('works out the server’s clock from its own date', () => {
    // 2026-11-18 03:00 UTC is 11:00 in Singapore.
    const epoch = Date.UTC(2026, 10, 18, 3, 0, 0) / 1000;
    expect(hostOffset(epoch, '2026-11-18T11:00:00')).toBe(480);
    expect(hostOffset(epoch, '2026-11-17T22:00:01')).toBe(-300);
    expect(hostOffset(epoch, 'garbage')).toBe(0);
    const p = parsePlace(`1000\n/home/me\n/home/me/.local/share/Trash\n${epoch}\n2026-11-18T11:00:00\n/dev/sda1 100 50 50 50% /\n`);
    expect(p).toEqual({ uid: 1000, home: '/home/me', homeTrash: '/home/me/.local/share/Trash', homeMount: '/', offsetMin: 480 });
    expect(() => parsePlace('')).toThrow();
  });

  it('writes .trashinfo as the FreeDesktop spec has it, and reads it back', () => {
    const at = new Date(Date.UTC(2026, 10, 18, 3, 4, 5));
    expect(localStamp(at, 480)).toBe('2026-11-18T11:04:05');
    const home = formatTrashInfo('/home/me/My Files/a#b%.txt', null, at, 480);
    expect(home).toBe('[Trash Info]\nPath=/home/me/My%20Files/a%23b%25.txt\nDeletionDate=2026-11-18T11:04:05\nX-Launchpad=1\n');
    expect(parseTrashInfo(home, null, 480)).toEqual({ path: '/home/me/My Files/a#b%.txt', deletedAt: at.toISOString(), ours: true });
    // A disk's own trash keeps paths relative to the disk.
    const disk = formatTrashInfo('/mnt/media/films/x.mkv', '/mnt/media', at, 480);
    expect(disk).toContain('Path=films/x.mkv\n');
    expect(parseTrashInfo(disk, '/mnt/media', 480)?.path).toBe('/mnt/media/films/x.mkv');
    expect(parseTrashInfo(formatTrashInfo('/srv/x', '/', at, 0), '/', 0)?.path).toBe('/srv/x');
  });

  it('reads what other tools trashed, and leaves it to them', () => {
    const gio = '[Trash Info]\r\nPath=/home/me/old.txt\r\nDeletionDate=2026-01-02T03:04:05\r\n';
    expect(parseTrashInfo(gio, null, 0)).toEqual({ path: '/home/me/old.txt', deletedAt: '2026-01-02T03:04:05.000Z', ours: false });
    expect(parseTrashInfo('[Other]\nPath=/x\n', null, 0)).toBeNull();
    expect(parseTrashInfo('[Trash Info]\nPath=relative\n', null, 0)).toBeNull();
    // A broken escape is kept as it is rather than thrown on.
    expect(parseTrashInfo('[Trash Info]\nPath=/a/%E0%A4%A\n', null, 0)?.path).toBe('/a/%E0%A4%A');
  });

  it('empties only what Launchpad put there over a week ago', () => {
    const now = Date.UTC(2026, 10, 18);
    const item = (days: number, ours: boolean): TrashItem => ({ trash: '/t', id: `${days}-${ours}`, path: '/x', deletedAt: new Date(now - days * 86_400_000).toISOString(), kind: 'file', size: 1, ours });
    const items = [item(1, true), item(TRASH_DAYS - 0.1, true), item(TRASH_DAYS + 0.1, true), item(30, false)];
    expect(expired(items, now).map((i) => i.id)).toEqual([`${TRASH_DAYS + 0.1}-true`]);
  });

  it('finds real disks in /proc/mounts, not the kernel’s or Docker’s', () => {
    const mounts = [
      'sysfs /sys sysfs rw 0 0',
      'proc /proc proc rw 0 0',
      '/dev/sda1 / ext4 rw 0 0',
      '/dev/sdb1 /mnt/media ext4 rw 0 0',
      '/dev/sdc1 /mnt/my\\040disk ext4 rw 0 0',
      'tmpfs /run tmpfs rw 0 0',
      'overlay /var/lib/docker/overlay2/abc/merged overlay rw 0 0',
      '/dev/loop1 /snap/core/1 squashfs ro 0 0',
    ].join('\n');
    expect(parseMounts(mounts)).toEqual(['/', '/mnt/media', '/mnt/my disk']);
  });
});

describe('archives', () => {
  it('reads unzip -Z listings, with links', () => {
    const out = [
      'Archive:  t.zip',
      'Zip file size: 390 bytes, number of entries: 4',
      'drwxr-xr-x  3.0 unx        0 bx stor 24-Jan-01 12:00 d/',
      '-rw-r--r--  3.0 unx       12 tx defN 24-Jan-01 12:00 d/a file.txt',
      'lrwxrwxrwx  3.0 unx        5 bx stor 24-Jan-01 12:00 d/link',
      '-rw----     2.0 fat        5 b- stor 80-Jan-01 00:00 win.txt',
      '4 files, 22 bytes uncompressed, 22 bytes compressed:  0.0%',
    ].join('\n');
    expect(parseZipInfo(out)).toEqual([
      { name: 'd/', type: 'dir', size: 0 },
      { name: 'd/a file.txt', type: 'file', size: 12 },
      { name: 'd/link', type: 'link', size: 5 },
      { name: 'win.txt', type: 'file', size: 5 },
    ]);
  });

  it('reads GNU tar -tv listings, with links and hard links', () => {
    const out = [
      'drwxr-xr-x 1000/1000         0 2024-01-01 12:00 site/',
      '-rw-r--r-- 1000/1000      1234 2024-01-01 12:00 site/index page.html',
      'lrwxrwxrwx 1000/1000         0 2024-01-01 12:00 site/latest -> v2',
      'hrw-r--r-- 1000/1000         0 2024-01-01 12:00:30 site/copy link to site/index page.html',
      'crw-r--r-- 0/0             1,3 2024-01-01 12:00 dev/null',
    ].join('\n');
    expect(parseTarList(out)).toEqual([
      { name: 'site/', type: 'dir', size: 0, target: undefined },
      { name: 'site/index page.html', type: 'file', size: 1234, target: undefined },
      { name: 'site/latest', type: 'link', size: 0, target: undefined },
      { name: 'site/copy', type: 'hardlink', size: 0, target: 'site/index page.html' },
      { name: 'dev/null', type: 'other', size: 0, target: undefined },
    ]);
  });

  it('reads 7-Zip and unrar technical listings', () => {
    const seven = [
      '7-Zip 23.01 (x64) : Copyright (c) 1999-2023 Igor Pavlov',
      '',
      'Listing archive: /home/me/a.7z',
      '',
      '--',
      'Path = /home/me/a.7z',
      'Type = 7z',
      '',
      '----------',
      'Path = docs',
      'Size = 0',
      'Attributes = D_ drwxr-xr-x',
      '',
      'Path = docs/readme.txt',
      'Size = 42',
      'Attributes = A_ -rw-r--r--',
      '',
      'Path = docs/link',
      'Size = 6',
      'Attributes = A_ lrwxrwxrwx',
      '',
    ].join('\n');
    expect(parse7zList(seven)).toEqual([
      { name: 'docs', type: 'dir', size: 0 },
      { name: 'docs/readme.txt', type: 'file', size: 42 },
      { name: 'docs/link', type: 'link', size: 6 },
    ]);
    const rar = [
      'UNRAR 6.24 freeware      Copyright (c) 1993-2023 Alexander Roshal',
      '',
      'Archive: /home/me/a.rar',
      'Details: RAR 5',
      '',
      '        Name: docs/readme.txt',
      '        Type: File',
      '        Size: 42',
      ' Packed size: 40',
      '',
      '        Name: docs',
      '        Type: Directory',
      '',
      '        Name: docs/link',
      '        Type: Symbolic link',
      '      Target: /etc',
    ].join('\n');
    expect(parseUnrarList(rar)).toEqual([
      { name: 'docs/readme.txt', type: 'file', size: 42 },
      { name: 'docs', type: 'dir', size: 0 },
      { name: 'docs/link', type: 'link', size: 0 },
    ]);
    expect(parsePyList('["a/","dir",0]\n["a/b","file",3]\nnot json\n')).toEqual([
      { name: 'a/', type: 'dir', size: 0 },
      { name: 'a/b', type: 'file', size: 3 },
    ]);
  });

  it('refuses archives that would write outside their folder', () => {
    const f = (name: string, extra: Partial<Member> = {}): Member => ({ name, type: 'file', size: 1, ...extra });
    expect(checkMembers([f('a/b.txt'), f('./c'), f('d/'), f('lnk', { type: 'link' })])).toBeNull();
    expect(checkMembers([f('ok'), f('../evil')])).toMatch(/climb out/);
    expect(checkMembers([f('a/../../evil')])).toMatch(/climb out/);
    expect(checkMembers([f('a\\..\\evil')])).toMatch(/climb out/);
    expect(checkMembers([f('/etc/passwd')])).toMatch(/absolute/);
    expect(checkMembers([f('C:\\Windows\\x')])).toMatch(/absolute/);
    expect(checkMembers([f('lnk', { type: 'link' }), f('lnk/authorized_keys')])).toMatch(/through a link/);
    expect(checkMembers([f('./a/lnk', { type: 'link' }), f('a//lnk/x')])).toMatch(/through a link/);
    expect(checkMembers([f('h', { type: 'hardlink', target: '/etc/shadow' })])).toMatch(/points out/);
    expect(checkMembers([f('h', { type: 'hardlink', target: '../x' })])).toMatch(/points out/);
    expect(checkMembers(Array.from({ length: 200_001 }, (_, i) => f(`f${i}`)))).toMatch(/too many/);
  });

  it('picks a tool, or says what to install', () => {
    const t = (...names: string[]) => new Set(names);
    expect(planExtract('zip', '/a/x.zip', t('unzip', 'python3')).tool).toBe('unzip');
    expect(planExtract('zip', '/a/x.zip', t('bsdtar', 'python3')).tool).toBe('bsdtar');
    expect(planExtract('zip', '/a/x.zip', t('7zz', 'python3')).tool).toBe('7zz');
    expect(planExtract('zip', '/a/x.zip', t('python3')).tool).toBe('python3');
    expect(() => planExtract('zip', '/a/x.zip', t())).toThrow(/install unzip/);
    expect(planExtract('tar', '/a/x.tar.gz', t('tar', 'gzip')).tool).toBe('tar');
    expect(() => planExtract('tar', '/a/x.tar.xz', t('tar', 'gzip'))).toThrow(/xz-utils/);
    expect(() => planExtract('tar', '/a/x.tar', t())).toThrow(/install tar/);
    expect(planExtract('7z', '/a/x.7z', t('7z')).tool).toBe('7z');
    expect(() => planExtract('7z', '/a/x.7z', t('unrar'))).toThrow(/7-Zip/);
    expect(planExtract('rar', '/a/x.rar', t('unrar', '7z')).tool).toBe('unrar');
    expect(planExtract('rar', '/a/x.rar', t('7z')).tool).toBe('7z');
    expect(() => planExtract('rar', '/a/x.rar', t('unzip'))).toThrow(/unrar/);
  });

  it('quotes every path it hands the shell, and never overwrites', () => {
    const file = "/home/me/it's; rm -rf ~.zip";
    const p = planExtract('zip', file, new Set(['unzip']));
    expect(p.list).toBe(`unzip -Z '/home/me/it'\\''s; rm -rf ~.zip'`);
    expect(p.extract('/home/me/new $(x)')).toBe(`unzip -qq -n '/home/me/it'\\''s; rm -rf ~.zip' -d '/home/me/new $(x)'`);
    expect(planExtract('rar', '/a/x.rar', new Set(['unrar'])).extract('/a/x')).toContain('-o-');
    expect(planExtract('7z', '/a/x.7z', new Set(['7z'])).extract('/a/x')).toContain(`'-o/a/x'`);
    expect(planExtract('tar', '/a/x.tgz', new Set(['tar', 'gzip'])).extract('/a/x')).toBe(`tar -xf '/a/x.tgz' -C '/a/x' --no-same-owner`);
  });

  it('packs with whatever is there, or says what to install', () => {
    const t = (...names: string[]) => new Set(names);
    expect(planCompress('tar.gz', '/a', ['b c', '-d'], '/a/.tmp.tar.gz', t('tar', 'gzip')).cmd).toBe(`cd '/a' && tar -czf '/a/.tmp.tar.gz' -- 'b c' '-d'`);
    expect(planCompress('zip', '/a', ['-d'], '/a/.tmp.zip', t('zip')).cmd).toBe(`cd '/a' && zip -r -q -y '/a/.tmp.zip' './-d'`);
    expect(planCompress('zip', '/a', ['x'], '/a/.tmp.zip', t('python3')).tool).toBe('python3');
    expect(() => planCompress('zip', '/a', ['x'], '/a/t.zip', t('tar', 'gzip'))).toThrow(/install zip/);
    expect(() => planCompress('tar.gz', '/a', ['x'], '/a/t', t('zip'))).toThrow(/tar and gzip/);
  });

  it('turns a tool’s complaints into something to act on', () => {
    const r = (stderr: string) => ({ code: 1, stdout: '', stderr, stopped: null });
    expect(extractError('unzip', r('skipping: a.txt  unable to get password'))).toMatch(/password-protected/);
    expect(extractError('tar', r('tar: x: Cannot write: No space left on device'))).toMatch(/filled up/);
    expect(extractError('tar', r('gzip: stdin: unexpected end of file'))).toMatch(/damaged or incomplete/);
    expect(extractError('7z', r(''))).toBe('7z stopped with code 1.');
  });
});

describe('search', () => {
  it('matches the query literally', () => {
    expect(globEscape('a*b?[c]\\')).toBe('a\\*b\\?\\[c\\]\\\\');
    expect(nameCommand('/home/me', "it's*")).toContain(`-iname '*it'\\''s\\**'`);
    expect(nameCommand('/home/me', 'x')).toMatch(/^find '\/home\/me' -mindepth 1 .*-prune -o -iname/);
    expect(contentCommand('/srv', '-e x', false)).toContain(`grep -I -i -F -n -m 1 -Z -H -e '-e x' --`);
    expect(contentCommand('/srv', 'x', true)).toMatch(/^rg .* --fixed-strings .* -e 'x' -- '\/srv'$/);
    expect(cleanQuery('  hello ')).toBe('hello');
    for (const bad of ['', '   ', 'a\nb', 'x'.repeat(201), 42]) expect(() => cleanQuery(bad)).toThrow();
  });

  it('reads find’s records as they come, however they’re split', () => {
    const all = Buffer.from('f 12 /a/b.txt\0d 4096 /a/my dir\0l 0 /a/link\0');
    const first = parseNames(all.subarray(0, 20));
    expect(first.hits).toEqual([{ path: '/a/b.txt', kind: 'file', size: 12 }]);
    const rest = parseNames(Buffer.concat([first.rest, all.subarray(20)]));
    expect(rest.hits).toEqual([
      { path: '/a/my dir', kind: 'dir', size: undefined },
      { path: '/a/link', kind: 'other', size: undefined },
    ]);
    expect(rest.rest.length).toBe(0);
  });

  it('reads grep -Z and rg --null matches, with their first line', () => {
    const out = Buffer.from('/a/x.txt\x003:  the Needle here  \n/a/b c.log\x0010:needle\r\n/a/half');
    const r = parseContents(out);
    expect(r.hits).toEqual([
      { path: '/a/x.txt', kind: 'file', line: 3, text: 'the Needle here' },
      { path: '/a/b c.log', kind: 'file', line: 10, text: 'needle' },
    ]);
    expect(r.rest.toString()).toBe('/a/half');
    // A line too long to hold is cut short, and what follows is skipped up to its end.
    const long = parseContents(Buffer.concat([Buffer.from('/a/min.js\x001:'), Buffer.alloc(300 * 1024, 'x')]));
    expect(long.hits[0].text).toHaveLength(240);
    expect(long.rest).toEqual(Buffer.from([0xff]));
  });

  it('reads du’s totals', () => {
    expect(parseDu('1234\t/a\n99\t/b c\n')).toEqual(new Map([['/a', 1234], ['/b c', 99]]));
    expect(parseDu('3\t/a\n', 1024).get('/a')).toBe(3072);
  });
});

describe('remote commands', () => {
  it('learn the process group before the output', () => {
    expect(splitPgid('  4242\nhello')).toEqual({ pgid: 4242, rest: 'hello' });
    expect(splitPgid('12')).toBeNull();
    expect(splitPgid('weird\nout')).toEqual({ pgid: null, rest: 'out' });
    expect(splitPgid('1\n')).toEqual({ pgid: null, rest: '' });
    expect(wrapCommand("echo 'hi'")).toBe(`sh -c 'echo "$(ps -o pgid= -p $$ 2>/dev/null || echo $$)"; exec sh -c "$0"' 'echo '\\''hi'\\'''`);
  });
});

// ---------- zips ----------

async function collect(it: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const b of it) parts.push(b);
  return Buffer.concat(parts);
}

async function* from(list: ZipSource[]) {
  yield* list;
}

const file = (name: string, data: string | Buffer, extra: Partial<ZipSource> = {}): ZipSource => {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return { name, mtime: new Date(2026, 10, 18, 12, 30, 10), mode: 0o644, dir: false, size: b.length, open: async () => [b.subarray(0, 3), b.subarray(3)], ...extra };
};

/** Just enough of a reader for ZIP64: the central directory, its extra fields, and the end records. */
function readZip64(buf: Buffer) {
  let end = buf.length - 22;
  while (buf.readUInt32LE(end) !== 0x06054b50) end--;
  let count = buf.readUInt16LE(end + 10);
  let cd = buf.readUInt32LE(end + 16);
  if (count === 0xffff || cd === 0xffffffff) {
    const loc = end - 20;
    expect(buf.readUInt32LE(loc)).toBe(0x07064b50);
    const z = Number(buf.readBigUInt64LE(loc + 8));
    expect(buf.readUInt32LE(z)).toBe(0x06064b50);
    count = Number(buf.readBigUInt64LE(z + 32));
    cd = Number(buf.readBigUInt64LE(z + 48));
  }
  const out: { name: string; crc: number; size: number; offset: number; flags: number }[] = [];
  let p = cd;
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(p + 8);
    const crc = buf.readUInt32LE(p + 16);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    let offset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    if (extra.length && extra.readUInt16LE(0) === 1) {
      let q = 4;
      if (size === 0xffffffff) {
        size = Number(extra.readBigUInt64LE(q));
        q += 16;
      }
      if (offset === 0xffffffff) offset = Number(extra.readBigUInt64LE(q));
    }
    out.push({ name, crc, size, offset, flags });
    p += 46 + nameLen + extraLen;
  }
  return out;
}

describe('streamed zips', () => {
  it('make a zip other readers open, CRCs and all', async () => {
    const buf = await collect(
      zipChunks(
        from([
          { name: 'photos/', mtime: new Date(), mode: 0o755, dir: true },
          file('photos/a.txt', 'hello world'),
          file('photos/empty.txt', ''),
          file('ünï cödé.txt', 'unicode name'),
        ]),
      ),
    );
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(['photos/a.txt', 'photos/empty.txt', 'ünï cödé.txt']);
    expect(files.get('photos/a.txt')!.toString()).toBe('hello world');
    expect(files.get('photos/empty.txt')!.length).toBe(0);
    const central = readZip64(buf);
    expect(central.find((e) => e.name === 'photos/a.txt')!.crc).toBe(crc32(Buffer.from('hello world')) >>> 0);
    // Files carry a data descriptor and UTF-8 names; folders need no descriptor.
    expect(central.find((e) => e.name === 'photos/a.txt')!.flags).toBe(0x0808);
    expect(central.find((e) => e.name === 'photos/')!.flags).toBe(0x0800);
  });

  it('leave out what won’t open, and say so at the end', async () => {
    const buf = await collect(
      zipChunks(from([file('ok.txt', 'fine'), { ...file('locked.txt', 'x'), open: async () => Promise.reject(new Error('Permission denied')) }]), {
        note: (skipped) => (skipped.length ? file('Not included.txt', skipped.join('\n')) : null),
      }),
    );
    const files = unzip(buf);
    expect([...files.keys()]).toEqual(['ok.txt', 'Not included.txt']);
    expect(files.get('Not included.txt')!.toString()).toBe('locked.txt: Permission denied');
  });

  it('switch to ZIP64 for a file known to be over 4 GB', async () => {
    // Said to be 5 GB ahead, so it's written ZIP64 from its local header on; the data itself is small.
    const buf = await collect(zipChunks(from([file('big.mkv', 'tiny', { size: 5 * 1024 ** 3 })])));
    expect(buf.readUInt16LE(4)).toBe(45);
    expect(buf.readUInt32LE(18)).toBe(0xffffffff);
    const [e] = readZip64(buf);
    expect(e).toMatchObject({ name: 'big.mkv', size: 4, crc: crc32(Buffer.from('tiny')) >>> 0 });
    // The descriptor after the data has 8-byte sizes.
    const at = 30 + 'big.mkv'.length + 20 + 4;
    expect(buf.readUInt32LE(at)).toBe(0x08074b50);
    expect(Number(buf.readBigUInt64LE(at + 8))).toBe(4);
  });

  it('use the ZIP64 end records past 65,535 entries', async () => {
    const many = Array.from({ length: 70_000 }, (_, i) => ({ name: `d${i}/`, mtime: new Date(), mode: 0o755, dir: true }));
    const buf = await collect(zipChunks(from(many)));
    const entries = readZip64(buf);
    expect(entries).toHaveLength(70_000);
    expect(entries.at(-1)!.name).toBe('d69999/');
  });
});
