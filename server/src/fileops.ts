// The Files explorer's batch work: folder sizes, copying and moving, deleting for good,
// and zip downloads. Anything that may take long runs as a job (filejobs.ts).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { Stats } from 'ssh2';
import { call, cleanPath, FileError, kindOf, sftpSession, shellQuote, stat } from './shell';
import { runRemote } from './remote';
import { freeName } from './archive';
import { startJob } from './filejobs';
import { cleanPaths } from './trash';
import type { FileJob, FolderSize } from '../../shared/files';

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** `du -sb` lines: bytes, a tab, the path. */
export function parseDu(out: string, factor = 1): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (m) sizes.set(m[2], Number(m[1]) * factor);
  }
  return sizes;
}

export const SIZE_SECONDS = 60;

/** How much each folder holds, from du on the server, in one go. */
export async function folderSizes(input: unknown, signal?: AbortSignal): Promise<Record<string, FolderSize>> {
  const paths = cleanPaths(input).slice(0, 50);
  const q = paths.map(shellQuote).join(' ');
  let r = await runRemote(`du -sb -- ${q}`, { timeout: SIZE_SECONDS * 1000, signal }).done;
  let factor = 1;
  // BusyBox and BSD du have no -b; their -k is near enough.
  if (!r.stopped && r.code && /invalid|unrecognized|illegal/i.test(r.stderr)) {
    r = await runRemote(`du -sk -- ${q}`, { timeout: SIZE_SECONDS * 1000, signal }).done;
    factor = 1024;
  }
  if (r.stopped === 'timeout') throw new FileError(`Measuring took over ${SIZE_SECONDS} seconds, so Launchpad gave up. Try a folder inside it.`, 500);
  if (r.stopped) throw new FileError('Stopped.', 409);
  const sizes = parseDu(r.stdout, factor);
  if (!sizes.size) throw new FileError(r.stderr.replace(/^du: /gm, '') || 'du didn’t say.', r.stderr.includes('ermission') ? 403 : 500);
  // du still totals what it could read when some of it was unreadable, and says so.
  const partial = !!r.code;
  return Object.fromEntries(paths.filter((p) => sizes.has(p)).map((p) => [p, { bytes: sizes.get(p)!, partial }]));
}

// ---------- copy and move ----------

export type TransferMode = 'copy' | 'move';

export interface TransferPair {
  from: string;
  to: string;
}

/** Where each goes in `to`, refusing a folder into itself and anything that would replace what's there. A copy into its own folder gets a numbered name. */
export async function planTransfer(mode: TransferMode, input: unknown, toRaw: unknown): Promise<TransferPair[]> {
  const paths = cleanPaths(input);
  const to = cleanPath(toRaw);
  const { sftp } = await sftpSession();
  const dest = await stat(sftp, to).catch(() => null);
  if (!dest || kindOf(dest.mode) !== 'dir') throw new FileError(`${to} isn’t a folder.`, 404);
  const pairs: TransferPair[] = [];
  const clash: string[] = [];
  for (const p of paths) {
    const name = path.posix.basename(p);
    if (p === '/') throw new FileError(`Launchpad won’t ${mode} the whole disk.`);
    if (p === to || to.startsWith(p + '/')) throw new FileError(`Can’t ${mode} ${name} into itself.`);
    const same = path.posix.dirname(p) === to;
    if (same && mode === 'move') continue;
    if (same) {
      pairs.push({ from: p, to: await freeName(sftp, to, name) });
      continue;
    }
    const target = path.posix.join(to, name);
    if (await call<Stats>(target, (cb) => sftp.lstat(target, cb)).catch(() => null)) clash.push(name);
    else pairs.push({ from: p, to: target });
  }
  if (clash.length) {
    const names = clash.length > 3 ? `${clash.slice(0, 3).join(', ')} and ${clash.length - 3} more` : clash.join(clash.length === 2 ? ' and ' : ', ');
    throw new FileError(`${names} ${clash.length === 1 ? 'is' : 'are'} already in ${to}. Rename or delete ${clash.length === 1 ? 'it' : 'them'} first.`, 409);
  }
  return pairs;
}

const transferCmd = (mode: TransferMode, pairs: TransferPair[]) =>
  pairs.map((p) => (mode === 'copy' ? `cp -R -n --preserve=timestamps -- ${shellQuote(p.from)} ${shellQuote(p.to)}` : `mv -n -- ${shellQuote(p.from)} ${shellQuote(p.to)}`)).join(' && ');

/**
 * Copy or move these into `to`. A move on one disk is an instant rename and is done before
 * this returns; copies, and moves to another disk (which copy), run as a job.
 */
export async function transfer(mode: TransferMode, input: unknown, toRaw: unknown): Promise<{ moved: number; job: FileJob | null }> {
  const pairs = await planTransfer(mode, input, toRaw);
  const to = cleanPath(toRaw);
  let moved = 0;
  let rest = pairs;
  if (mode === 'move') {
    const { sftp } = await sftpSession();
    rest = [];
    for (const p of pairs) {
      try {
        await call<void>(p.from, (cb) => sftp.rename(p.from, p.to, cb));
        moved++;
      } catch (e) {
        // A plain failure is a rename across disks; mv copies those. Anything else is real.
        if (!(e instanceof FileError && e.status === 500)) throw e;
        rest.push(p);
      }
    }
  }
  if (!rest.length) return { moved, job: null };
  const what = rest.length === 1 ? path.posix.basename(rest[0].from) : plural(rest.length, 'item');
  const label = `${mode === 'copy' ? 'Copying' : 'Moving'} ${what} to ${path.posix.basename(to) || '/'}`;
  const job = startJob(mode, label, to, async (ctx) => {
    ctx.progress(mode === 'copy' ? 'Copying…' : 'Moving to the other disk, which copies…');
    const r = await runRemote(transferCmd(mode, rest), { timeout: 24 * 60 * 60_000, signal: ctx.signal }).done;
    if (r.stopped === 'cancel') throw new Error(mode === 'copy' ? 'Stopped. Some of it may have been copied already.' : 'Stopped. Part of it may have been copied; the original is still where it was.');
    if (r.stopped) throw new Error('That took too long.');
    if (r.code) throw new Error(r.stderr.replace(/^(cp|mv): /gm, '').split('\n').slice(0, 3).join(' ') || `${mode === 'copy' ? 'cp' : 'mv'} stopped with code ${r.code}.`);
    return { message: `${mode === 'copy' ? 'Copied' : 'Moved'} ${what}.`, result: rest.length === 1 ? rest[0].to : to };
  });
  return { moved, job };
}

/** Delete these for good, skipping the trash: for things the trash can't take. */
export function deleteForGood(input: unknown): FileJob {
  const paths = cleanPaths(input);
  if (paths.includes('/')) throw new FileError('Launchpad won’t delete the root folder.');
  const dir = path.posix.dirname(paths[0]);
  const what = paths.length === 1 ? path.posix.basename(paths[0]) : plural(paths.length, 'item');
  return startJob('delete', `Deleting ${what} for good`, dir, async (ctx) => {
    ctx.progress('Deleting…');
    // rm -r in one go is far quicker than walking a big folder over SFTP.
    const r = await runRemote(`rm -rf -- ${paths.map(shellQuote).join(' ')}`, { timeout: 6 * 60 * 60_000, signal: ctx.signal }).done;
    if (r.stopped === 'cancel') throw new Error('Stopped. Some of it may be deleted already.');
    if (r.stopped) throw new Error('Deleting took too long.');
    if (r.code) throw new Error(r.stderr.replace(/^rm: /gm, '').split('\n').slice(0, 3).join(' ') || `rm stopped with code ${r.code}.`);
    return { message: `Deleted ${what}.` };
  });
}

// ---------- zip downloads ----------

/** A zip download is asked for with a POST (a long list of names won't fit a link), then fetched by a link the browser can save. */
const tickets = new Map<string, { paths: string[]; name: string; at: number }>();
const TICKET_TTL = 2 * 60_000;

/** The name a zip of these gets: the one thing's name, or the folder's. */
export function zipName(paths: string[]): string {
  const base = paths.length === 1 ? path.posix.basename(paths[0]) : path.posix.basename(path.posix.dirname(paths[0])) || 'files';
  return `${base}.zip`;
}

export async function zipTicket(input: unknown): Promise<{ url: string; name: string }> {
  const paths = cleanPaths(input);
  const dir = path.posix.dirname(paths[0]);
  if (paths.some((p) => path.posix.dirname(p) !== dir)) throw new FileError('Everything in one zip has to be in the same folder.');
  if (paths.includes('/')) throw new FileError('Launchpad won’t zip the whole disk.');
  const { sftp } = await sftpSession();
  for (const p of paths) if (!(await call<Stats>(p, (cb) => sftp.lstat(p, cb)).catch(() => null))) throw new FileError(`${path.posix.basename(p)} isn’t there any more.`, 404);
  const now = Date.now();
  for (const [k, t] of tickets) if (now - t.at > TICKET_TTL) tickets.delete(k);
  const id = randomBytes(18).toString('base64url');
  const name = zipName(paths);
  tickets.set(id, { paths, name, at: now });
  return { url: `/api/files/zip/${id}`, name };
}

/** The paths a ticket was for, while it lasts (a couple of minutes). */
export function takeTicket(id: string): { paths: string[]; name: string } | null {
  const t = tickets.get(id);
  return t && Date.now() - t.at <= TICKET_TTL ? t : null;
}
