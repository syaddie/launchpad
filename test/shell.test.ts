import { describe, expect, it } from 'vitest';
import { cleanName, cleanPath, cleanSize, cleanUploadId, isPartFile, isStalePart, kindOf, shellQuote, STALE_PART_MS, UPLOAD_CHUNK } from '../server/src/shell';
import { UPLOAD_CHUNK as PAGE_CHUNK, uploadPieces } from '../web/src/api';
import { permString } from '../web/src/components/Files';

describe('server files', () => {
  it('takes absolute paths only, normalised', () => {
    expect(cleanPath('/home/me/')).toBe('/home/me');
    expect(cleanPath('/home/me/../you/./x')).toBe('/home/you/x');
    expect(cleanPath('//etc//nginx')).toBe('/etc/nginx');
    expect(cleanPath('/')).toBe('/');
    expect(() => cleanPath('home/me')).toThrow('absolute');
    expect(() => cleanPath('~')).toThrow('absolute');
    expect(() => cleanPath(42)).toThrow();
    expect(() => cleanPath('/a\0b')).toThrow();
  });

  it('takes one name, not a path', () => {
    expect(cleanName('notes.txt')).toBe('notes.txt');
    expect(cleanName('it’s a file')).toBe('it’s a file');
    for (const bad of ['', '.', '..', 'a/b', '/x', 'a\0b', 'x'.repeat(256)]) expect(() => cleanName(bad)).toThrow();
  });

  it('reads the file type from the mode', () => {
    expect(kindOf(0o040755)).toBe('dir');
    expect(kindOf(0o100644)).toBe('file');
    expect(kindOf(0o120777)).toBe('link');
    expect(kindOf(0o140755)).toBe('other');
  });

  it('quotes paths for the shell', () => {
    expect(shellQuote('/home/me/My Files')).toBe(`'/home/me/My Files'`);
    expect(shellQuote(`/tmp/it's; rm -rf ~`)).toBe(`'/tmp/it'\\''s; rm -rf ~'`);
  });

  it('prints permissions as ls does', () => {
    expect(permString({ kind: 'dir', link: false, mode: 0o755 })).toBe('drwxr-xr-x');
    expect(permString({ kind: 'file', link: false, mode: 0o640 })).toBe('-rw-r-----');
    expect(permString({ kind: 'file', link: true, mode: 0o600 })).toBe('-rw-------');
    expect(permString({ kind: 'other', link: true, mode: 0o777 })).toBe('lrwxrwxrwx');
  });

  it('splits uploads into pieces Cloudflare will take', () => {
    expect(PAGE_CHUNK).toBe(UPLOAD_CHUNK);
    expect(UPLOAD_CHUNK).toBeLessThan(100 * 1000 * 1000);
    expect(uploadPieces(0)).toEqual([[0, 0]]);
    expect(uploadPieces(5, 10)).toEqual([[0, 5]]);
    expect(uploadPieces(10, 10)).toEqual([[0, 10]]);
    expect(uploadPieces(25, 10)).toEqual([[0, 10], [10, 20], [20, 25]]);
    const big = uploadPieces(5 * 1024 ** 3);
    expect(big.length).toBe(160);
    expect(big.at(-1)![1]).toBe(5 * 1024 ** 3);
  });

  it('checks the upload id and sizes', () => {
    expect(cleanUploadId('0123456789abcdef0123456789abcdef')).toBe('0123456789abcdef0123456789abcdef');
    for (const bad of ['', 'short', '../../etc/passwd', 'a b c d e f g h', 42]) expect(() => cleanUploadId(bad)).toThrow();
    expect(cleanSize('0', 'offset')).toBe(0);
    expect(cleanSize('33554432', 'offset')).toBe(33554432);
    for (const bad of [undefined, '', '-1', '1.5', '1e9', 'x', '99999999999999999']) expect(() => cleanSize(bad, 'offset')).toThrow();
  });

  it('spots abandoned .launchpad-upload-*.part files older than 24 hours', () => {
    const part = '.launchpad-upload-0123456789abcdef0123456789abcdef.part';
    expect(isPartFile(part)).toBe(true);
    expect(isPartFile('.bashrc')).toBe(false);
    expect(isPartFile('.launchpad-upload-short.part')).toBe(false);
    const nowMs = 1_700_000_000_000;
    const recentSec = Math.floor((nowMs - 3600_000) / 1000);
    const staleSec = Math.floor((nowMs - STALE_PART_MS - 1000) / 1000);
    expect(isStalePart(part, recentSec, nowMs)).toBe(false);
    expect(isStalePart(part, staleSec, nowMs)).toBe(true);
    expect(isStalePart('notes.txt', staleSec, nowMs)).toBe(false);
  });
});
