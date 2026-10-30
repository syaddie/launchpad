import { describe, expect, it } from 'vitest';
import { cleanName, cleanPath, kindOf, shellQuote } from '../server/src/shell';
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
});
