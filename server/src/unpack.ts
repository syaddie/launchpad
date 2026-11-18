// Server › Downloads' "Unpack archives when they finish". downloads.ts says when a link or a
// torrent is done; an archive among them is unpacked next to it by extractArchive (archive.ts),
// which never writes into a folder that's there already, one at a time. The archive itself is
// always kept: a torrent still seeds from it, and nothing is lost if unpacking goes wrong.
// What happened is listed in Downloads until Launchpad restarts, like the downloads themselves.
import crypto from 'node:crypto';
import path from 'node:path';
import type { Stats } from 'ssh2';
import { extractArchive } from './archive';
import { onDownloadFinished, type FinishedDownload } from './downloads';
import { call, kindOf, sftpSession } from './shell';
import { store } from './store';
import { archiveOf } from '../../shared/files';
import type { UnpackRecord } from '../../shared/types';

/** The most archives unpacked out of one torrent's folder, and the most records kept. */
export const MAX_PER_TORRENT = 10;
const KEEP = 20;

/**
 * The names in a folder worth unpacking: archives, but only the first part of one split into
 * parts ("film.part01.rar"; "film.rar" beside "film.r00" is already the first). Sorted.
 */
export function archivesIn(names: string[]): string[] {
  return names
    .filter((n) => archiveOf(n) && !n.startsWith('.'))
    .filter((n) => {
      const part = /\.part(\d+)\.rar$/i.exec(n);
      return !part || Number(part[1]) === 1;
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_PER_TORRENT);
}

/** Whether a finished download is for unpacking at all, and the archives to unpack when it's one file. */
export function unpackTargets(d: FinishedDownload): { files: string[] } | { dir: string } | null {
  if (d.source === 'video' || !d.path) return null;
  if (d.isDir) return { dir: d.path };
  return archivesIn([path.posix.basename(d.path)]).length ? { files: [d.path] } : null;
}

let records: UnpackRecord[] = [];

export const unpackRecords = (): UnpackRecord[] => records.map((r) => ({ ...r }));

function update(id: string, patch: Partial<UnpackRecord>): void {
  records = records.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

// One at a time: unpacking is heavy on the disk, and a torrent's parts finish together.
let queue: Promise<unknown> = Promise.resolve();

function unpackOne(file: string, from: UnpackRecord['from']): Promise<void> {
  const id = crypto.randomBytes(6).toString('hex');
  const rec: UnpackRecord = { id, at: new Date().toISOString(), file, from, state: 'waiting' };
  records = [rec, ...records].slice(0, KEEP);
  const run = async () => {
    update(id, { state: 'unpacking' });
    try {
      const { folder } = await extractArchive(file);
      update(id, { state: 'done', folder, at: new Date().toISOString() });
      console.log(`[unpack] ${file} → ${folder}`);
    } catch (e) {
      const message = (e as Error).message;
      const folder = (e as { folder?: string | null }).folder ?? undefined;
      update(id, { state: 'failed', message, folder, at: new Date().toISOString() });
      console.error(`[unpack] ${file}: ${message}`);
    }
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

/** A download finished: unpack what's in it, if the switch is on. Exported for tests. */
export async function onFinished(d: FinishedDownload): Promise<void> {
  if (!store.prefs().autoUnpack) return;
  const t = unpackTargets(d);
  if (!t) return;
  let files: string[];
  if ('files' in t) files = t.files;
  else {
    const { sftp } = await sftpSession();
    const list = await call<{ filename: string; attrs: Stats }[]>(t.dir, (cb) => sftp.readdir(t.dir, cb));
    files = archivesIn(list.filter((e) => kindOf(e.attrs.mode) === 'file').map((e) => e.filename)).map((n) => path.posix.join(t.dir, n));
  }
  const from = d.source === 'torrent' ? 'torrent' : 'link';
  await Promise.all(files.map((f) => unpackOne(f, from)));
}

let started = false;

/** Called once at boot. */
export function startUnpacking(): void {
  if (started) return;
  started = true;
  onDownloadFinished(onFinished);
}

/** For tests. */
export function resetUnpackForTests(): void {
  records = [];
  queue = Promise.resolve();
}
