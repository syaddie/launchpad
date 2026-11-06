// Just enough ZIP to put a backup and its photos in one file and read it back.
// Written files are stored uncompressed (photos are JPEGs already); reading also
// takes deflated entries, for a backup someone unzipped and zipped up again.
import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  name: string;
  /** Read when its turn comes, so only one file is in memory at a time. */
  data: () => Buffer;
}

const DOS_EPOCH = (d: Date) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});

/** A .zip of `entries`, made as it's sent. Each file and the whole archive must stay under 4 GB (no ZIP64). */
export function zipStream(entries: ZipEntry[], now = new Date()): ReadableStream<Uint8Array> {
  const { time, date } = DOS_EPOCH(now);
  const central: Buffer[] = [];
  let offset = 0;
  let i = 0;
  return new ReadableStream({
    pull(ctl) {
      if (i < entries.length) {
        const e = entries[i++];
        const data = e.data();
        const name = Buffer.from(e.name, 'utf8');
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4); // version needed
        local.writeUInt16LE(0x0800, 6); // UTF-8 names
        local.writeUInt16LE(0, 8); // stored
        local.writeUInt16LE(time, 10);
        local.writeUInt16LE(date, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0x0800, 8);
        cd.writeUInt16LE(0, 10);
        cd.writeUInt16LE(time, 12);
        cd.writeUInt16LE(date, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        central.push(cd, name);
        offset += local.length + name.length + data.length;
        if (offset > 0xffffffff) return ctl.error(new Error('The backup is over 4 GB.'));
        ctl.enqueue(Buffer.concat([local, name, data]));
        return;
      }
      const dir = Buffer.concat(central);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(dir.length, 12);
      end.writeUInt32LE(offset, 16);
      ctl.enqueue(Buffer.concat([dir, end]));
      ctl.close();
    },
  });
}

export const isZip = (b: Uint8Array) => b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

/** Every file in a .zip, by name. Throws on anything it can't read. */
export function unzip(buf: Buffer): Map<string, Buffer> {
  let end = -1;
  for (let p = buf.length - 22; p >= Math.max(0, buf.length - 22 - 0xffff); p--) {
    if (buf.readUInt32LE(p) === 0x06054b50) {
      end = p;
      break;
    }
  }
  if (end < 0) throw new Error('That isn’t a readable .zip file.');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('That .zip file is damaged.');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const at = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(at) !== 0x04034b50) throw new Error('That .zip file is damaged.');
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const raw = buf.subarray(start, start + size);
    if (method === 0) out.set(name, raw);
    // The size cap keeps a crafted file from inflating into something huge.
    else if (method === 8) out.set(name, inflateRawSync(raw, { maxOutputLength: 64 * 1024 * 1024 }));
    else throw new Error('That .zip file uses a kind of compression Launchpad can’t read.');
  }
  return out;
}
