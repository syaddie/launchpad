// A .zip written as it's sent, for downloading a selection or a folder that may be
// gigabytes: each file is read from the server and passed on piece by piece, so
// only the central directory (a hundred-odd bytes a file) is held in memory.
// zip.ts holds whole files and stops at 4 GB, which is fine for backups but not here.
//
// Files are stored, not compressed: photos and videos are already, and the server's
// CPU stays free. Each file's CRC is only known once it's been sent, so it follows the
// data in a descriptor. ZIP64 records are used for files, offsets or counts past what
// the classic format can hold.
import path from 'node:path';
import { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';
import type { SFTPWrapper, Stats } from 'ssh2';
import { call, kindOf, stat } from './shell';

export interface ZipSource {
  /** Its path in the archive, with / between folders; a folder's ends in /. */
  name: string;
  mtime: Date;
  /** Unix permission bits. */
  mode: number;
  dir: boolean;
  /** For a file: its bytes, opened when its turn comes. Throwing skips it. */
  open?: () => Promise<AsyncIterable<Buffer> | Iterable<Buffer>>;
  /** Its size, if known ahead; past 4 GB the entry is written as ZIP64 from the start. */
  size?: number;
}

const MAX32 = 0xffffffff;

function dosTime(d: Date) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

interface Written {
  name: Buffer;
  dir: boolean;
  mode: number;
  time: number;
  date: number;
  crc: number;
  size: number;
  offset: number;
  zip64: boolean;
}

/**
 * The archive, entry by entry. A file that can't be opened is left out; at the end `note`
 * gets the list of those and may add one last entry (say, a text file saying what's missing).
 */
export async function* zipChunks(sources: AsyncIterable<ZipSource>, opts: { note?: (skipped: string[]) => ZipSource | null } = {}): AsyncGenerator<Buffer> {
  const central: Written[] = [];
  const skipped: string[] = [];
  let offset = 0;

  async function* entry(s: ZipSource): AsyncGenerator<Buffer> {
    let data: AsyncIterable<Buffer> | Iterable<Buffer> | null = null;
    if (!s.dir && s.open) {
      try {
        data = await s.open();
      } catch (e) {
        skipped.push(`${s.name}: ${(e as Error).message}`);
        return;
      }
    }
    const name = Buffer.from(s.name, 'utf8');
    const { time, date } = dosTime(s.mtime);
    // Big from the start if it's known to be; a file can't become ZIP64 after its header is out.
    const zip64 = !s.dir && (s.size ?? 0) >= MAX32;
    const flags = 0x0800 | (s.dir ? 0 : 0x0008);
    const extra = zip64 ? Buffer.concat([Buffer.from([0x01, 0x00, 16, 0]), u64(0), u64(0)]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // CRC and sizes are zero here and come after the data, in the descriptor.
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 18);
    local.writeUInt32LE(zip64 ? MAX32 : 0, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const start = offset;
    yield Buffer.concat([local, name, extra]);
    offset += 30 + name.length + extra.length;

    let crc = 0;
    let size = 0;
    if (data) {
      for await (const chunk of data) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32(b, crc);
        size += b.length;
        yield b;
      }
      offset += size;
      if (!zip64 && size >= MAX32) throw new Error(`${s.name} grew past 4 GB while it was being zipped.`);
      const desc = zip64 ? Buffer.alloc(24) : Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      desc.writeUInt32LE(crc >>> 0, 4);
      if (zip64) {
        u64(size).copy(desc, 8);
        u64(size).copy(desc, 16);
      } else {
        desc.writeUInt32LE(size, 8);
        desc.writeUInt32LE(size, 12);
      }
      yield desc;
      offset += desc.length;
    } else if (!s.dir) {
      // A file with nothing to read still needs its (empty) descriptor.
      const desc = Buffer.alloc(16);
      desc.writeUInt32LE(0x08074b50, 0);
      yield desc;
      offset += 16;
    }
    central.push({ name, dir: s.dir, mode: s.mode, time, date, crc: crc >>> 0, size, offset: start, zip64 });
  }

  for await (const s of sources) yield* entry(s);
  const note = opts.note ? opts.note(skipped) : null;
  if (note) yield* entry(note);

  const cdStart = offset;
  for (const e of central) {
    const big = e.zip64 || e.size >= MAX32 || e.offset >= MAX32;
    const fields: Buffer[] = [];
    if (big) {
      fields.push(u64(e.size), u64(e.size));
      if (e.offset >= MAX32) fields.push(u64(e.offset));
    }
    const extra = fields.length ? Buffer.concat([Buffer.from([0x01, 0x00, fields.length * 8, 0]), ...fields]) : Buffer.alloc(0);
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0);
    h.writeUInt16LE((3 << 8) | 45, 4); // made on Unix
    h.writeUInt16LE(big ? 45 : 20, 6);
    h.writeUInt16LE(0x0800 | (e.dir ? 0 : 0x0008), 8);
    h.writeUInt16LE(0, 10);
    h.writeUInt16LE(e.time, 12);
    h.writeUInt16LE(e.date, 14);
    h.writeUInt32LE(e.crc, 16);
    h.writeUInt32LE(big ? MAX32 : e.size, 20);
    h.writeUInt32LE(big ? MAX32 : e.size, 24);
    h.writeUInt16LE(e.name.length, 28);
    h.writeUInt16LE(extra.length, 30);
    h.writeUInt16LE(0, 32); // comment
    h.writeUInt16LE(0, 34); // disk
    h.writeUInt16LE(0, 36); // internal attributes
    const type = e.dir ? 0o040000 : 0o100000;
    h.writeUInt32LE((((type | (e.mode & 0o7777)) << 16) | (e.dir ? 0x10 : 0)) >>> 0, 38);
    h.writeUInt32LE(e.offset >= MAX32 ? MAX32 : e.offset, 42);
    const rec = Buffer.concat([h, e.name, extra]);
    yield rec;
    offset += rec.length;
  }
  const cdSize = offset - cdStart;
  const needs64 = central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
  if (needs64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    u64(44).copy(z, 4);
    z.writeUInt16LE((3 << 8) | 45, 12);
    z.writeUInt16LE(45, 14);
    z.writeUInt32LE(0, 16);
    z.writeUInt32LE(0, 20);
    u64(central.length).copy(z, 24);
    u64(central.length).copy(z, 32);
    u64(cdSize).copy(z, 40);
    u64(cdStart).copy(z, 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeUInt32LE(0, 4);
    u64(offset).copy(loc, 8);
    loc.writeUInt32LE(1, 16);
    yield Buffer.concat([z, loc]);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(needs64 ? 0xffff : central.length, 8);
  end.writeUInt16LE(needs64 ? 0xffff : central.length, 10);
  end.writeUInt32LE(needs64 ? MAX32 : cdSize, 12);
  end.writeUInt32LE(needs64 ? MAX32 : cdStart, 16);
  yield end;
}

/** Most files one download walks into; past that the zip ends with a note saying so. */
export const MAX_ZIP_FILES = 500_000;

async function* walk(sftp: SFTPWrapper, abs: string, name: string, notes: string[], count: { n: number; capped?: boolean }): AsyncGenerator<ZipSource> {
  if (count.n >= MAX_ZIP_FILES) return;
  let st: Stats;
  try {
    st = await call<Stats>(abs, (cb) => sftp.lstat(abs, cb));
  } catch (e) {
    notes.push(`${name}: ${(e as Error).message}`);
    return;
  }
  let kind = kindOf(st.mode);
  if (kind === 'link') {
    const t = await stat(sftp, abs).catch(() => null);
    // Links to files are followed; links to folders aren't, as they can loop.
    if (!t || kindOf(t.mode) !== 'file') {
      notes.push(`${name}: a link to ${t ? 'a folder' : 'something that isn’t there'}, so it was left out`);
      return;
    }
    st = t;
    kind = 'file';
  }
  count.n++;
  const mtime = new Date(st.mtime * 1000);
  if (kind === 'file') {
    const size = st.size;
    yield {
      name,
      mtime,
      mode: st.mode & 0o7777,
      dir: false,
      size,
      open: async () => {
        // Opened before the entry is written, so a file that can't be read is left out rather than breaking the zip.
        const handle = await call<Buffer>(abs, (cb) => sftp.open(abs, 'r', cb));
        if (!size) {
          sftp.close(handle, () => {});
          return [];
        }
        return sftp.createReadStream(abs, { handle, start: 0, end: size - 1, autoClose: true }) as AsyncIterable<Buffer>;
      },
    };
    return;
  }
  if (kind !== 'dir') {
    notes.push(`${name}: not a file or folder`);
    return;
  }
  yield { name: name + '/', mtime, mode: st.mode & 0o7777, dir: true };
  let list: { filename: string }[];
  try {
    list = await call(abs, (cb) => sftp.readdir(abs, cb));
  } catch (e) {
    notes.push(`${name}/: ${(e as Error).message}`);
    return;
  }
  list.sort((a, b) => a.filename.localeCompare(b.filename));
  for (const f of list) {
    if (count.n >= MAX_ZIP_FILES) {
      if (!count.capped) notes.push(`Stopped after ${MAX_ZIP_FILES.toLocaleString('en-US')} files.`);
      count.capped = true;
      return;
    }
    yield* walk(sftp, path.posix.join(abs, f.filename), `${name}/${f.filename}`, notes, count);
  }
}

/** A .zip of these paths (files or folders, in one folder), as a stream to send. */
export function zipPaths(sftp: SFTPWrapper, paths: string[]): Readable {
  const notes: string[] = [];
  const count: { n: number; capped?: boolean } = { n: 0 };
  async function* sources() {
    for (const p of paths) yield* walk(sftp, p, path.posix.basename(p), notes, count);
  }
  // What the walk passed over and files that wouldn't open, as a text file at the end.
  const note = (skipped: string[]): ZipSource | null => {
    if (!notes.length && !skipped.length) return null;
    const text = Buffer.from(['Launchpad couldn’t add these to the zip:', '', ...notes, ...skipped, ''].join('\n'), 'utf8');
    return { name: 'Not included.txt', mtime: new Date(), mode: 0o644, dir: false, size: text.length, open: async () => [text] };
  };
  return Readable.from(zipChunks(sources(), { note }));
}
