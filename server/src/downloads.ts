// The Server view's downloads: paste a link and Launchpad fetches it straight into a
// folder on the server, over the files' SSH connection, without it passing through
// the browser. Each goes into a hidden part file named like an upload's, so one cut
// off by a restart is swept away with them a day later, and takes its real name when
// it's complete. The list lives in memory: a restart forgets it (and stops any still
// running).
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper } from 'ssh2';
import { call, cleanName, cleanPath, FileError, homeDir, kindOf, moveInto, noteUploadDir, partPath, sftpError, sftpSession, shellConfigured, stat } from './shell';
import type { DownloadJob, DownloadsInfo } from '../../shared/types';

export const MAX_ACTIVE = 4;
const KEEP = 30;
/** A download that gets nothing for this long is given up on. */
const STALL = 90_000;

interface Job extends DownloadJob {
  ctl: AbortController;
  cancelled: boolean;
  lastAt: number;
  lastBytes: number;
  lastByteAt: number;
}

const jobs: Job[] = [];

/** An http or https link. */
export function cleanUrl(v: unknown): URL {
  if (typeof v !== 'string' || v.length > 4000) throw new FileError('Paste an http:// or https:// link.');
  let u: URL;
  try {
    u = new URL(v.trim());
  } catch {
    throw new FileError('That isn’t a link Launchpad can read.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FileError('Only http:// and https:// links download here. Magnet links go to qBittorrent.');
  return u;
}

/** A name to save as: no folders, no control characters, and not a hidden file. */
export function safeName(n: string): string {
  const base = n.replace(/\\/g, '/').split('/').pop() ?? '';
  const clean = base.replace(/[\x00-\x1f\x7f]/g, '').trim().replace(/^\.+/, '').trim();
  if (clean.length <= 200) return clean;
  const ext = /\.[A-Za-z0-9]{1,8}$/.exec(clean)?.[0] ?? '';
  return clean.slice(0, 200 - ext.length) + ext;
}

/** The file's name: the one the site gives (Content-Disposition), else the end of the link. */
export function nameFrom(url: URL, disposition: string | null): string {
  let n = '';
  if (disposition) {
    const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
    if (star) {
      try {
        n = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
      } catch {
        n = '';
      }
    }
    if (!n) {
      const m = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
      if (m) n = (m[1] ?? m[2] ?? '').trim();
    }
  }
  if (!safeName(n)) {
    const seg = url.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      n = decodeURIComponent(seg);
    } catch {
      n = seg;
    }
  }
  return safeName(n) || safeName(url.hostname) || 'download';
}

/** "name (2).ext", keeping .tar.gz and the like together. */
export function withNumber(name: string, n: number): string {
  const ext = /(\.tar)?\.[A-Za-z0-9]{1,8}$/.exec(name)?.[0] ?? '';
  const stem = ext && ext.length < name.length ? name.slice(0, -ext.length) : name;
  return `${stem} (${n})${stem === name ? '' : ext}`;
}

/** `name`, or the first numbered one that isn't in `dir` yet. */
async function freeName(sftp: SFTPWrapper, dir: string, name: string): Promise<string> {
  for (let n = 1; n < 1000; n++) {
    const pick = n === 1 ? name : withNumber(name, n);
    if (!(await stat(sftp, path.posix.join(dir, pick)).catch(() => null))) return pick;
  }
  throw new FileError(`There are too many files called ${name} there already.`, 409);
}

function view(j: Job): DownloadJob {
  const { ctl: _c, cancelled: _x, lastAt: _a, lastBytes: _b, lastByteAt: _t, ...rest } = j;
  return { ...rest };
}

const active = () => jobs.filter((j) => j.state === 'starting' || j.state === 'downloading');

let defaultDir: string | null = null;

async function pickDefaultDir(): Promise<string | null> {
  if (defaultDir || !shellConfigured()) return defaultDir;
  const home = await homeDir();
  const { sftp } = await sftpSession();
  const dl = path.posix.join(home, 'Downloads');
  const st = await stat(sftp, dl).catch(() => null);
  defaultDir = st && kindOf(st.mode) === 'dir' ? dl : home;
  return defaultDir;
}

export async function listDownloads(): Promise<DownloadsInfo> {
  return { jobs: jobs.map(view), defaultDir: await pickDefaultDir().catch(() => null) };
}

/** Start fetching `url` into `dir`; it carries on after this returns. `name` overrides the one the site gives. */
export function startDownload(body: { url?: unknown; dir?: unknown; name?: unknown }): DownloadJob {
  if (!shellConfigured()) throw new FileError('Downloads are written over the terminal’s SSH login, which isn’t set up yet.', 409);
  const url = cleanUrl(body.url);
  const dir = cleanPath(typeof body.dir === 'string' ? body.dir.trim() : body.dir);
  const want = typeof body.name === 'string' && body.name.trim() ? cleanName(body.name.trim()) : null;
  if (active().length >= MAX_ACTIVE) throw new FileError(`${MAX_ACTIVE} downloads are going already. Wait for one to finish.`, 409);
  const now = Date.now();
  const job: Job = {
    id: crypto.randomUUID(),
    url: url.href,
    name: want ?? nameFrom(url, null),
    dir,
    received: 0,
    total: null,
    bps: 0,
    state: 'starting',
    error: null,
    startedAt: new Date(now).toISOString(),
    endedAt: null,
    ctl: new AbortController(),
    cancelled: false,
    lastAt: now,
    lastBytes: 0,
    lastByteAt: now,
  };
  jobs.unshift(job);
  // Forget the oldest finished ones.
  for (let i = jobs.length - 1; i >= 0 && jobs.length > KEEP; i--) if (!active().includes(jobs[i])) jobs.splice(i, 1);
  fetchInto(job, url, want).catch(() => {});
  return view(job);
}

/** Why a fetch failed, in words: Node puts the reason (no such host, refused…) in `cause`. */
function fetchError(e: unknown): string {
  const err = e as Error & { cause?: Error & { code?: string } };
  const c = err.cause;
  if (c?.code === 'ENOTFOUND' || c?.code === 'EAI_AGAIN') return 'Can’t find that site.';
  if (c?.code === 'ECONNREFUSED') return 'The site refused the connection.';
  if (c?.code === 'ECONNRESET') return 'The site dropped the connection.';
  return c?.message || err.message || String(e);
}

async function fetchInto(job: Job, url: URL, want: string | null): Promise<void> {
  let part: string | null = null;
  let sftp: SFTPWrapper | null = null;
  const watchdog = setInterval(() => {
    if (Date.now() - job.lastByteAt > STALL) job.ctl.abort(new Error('Nothing arrived for 90 seconds.'));
  }, 10_000);
  try {
    ({ sftp } = await sftpSession());
    const d = await stat(sftp, job.dir);
    if (kindOf(d.mode) !== 'dir') throw new FileError(`${job.dir} isn’t a folder.`);
    let res: Response;
    try {
      res = await fetch(url, { signal: job.ctl.signal, redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Launchpad)', Accept: '*/*' } });
    } catch (e) {
      throw new Error(fetchError(e));
    }
    if (!res.ok || !res.body) throw new Error(`The site answered ${res.status}${res.statusText ? ` ${res.statusText}` : ''}.`);
    // A compressed answer is unpacked on the way, so its length says nothing about the file's.
    const len = Number(res.headers.get('content-length'));
    job.total = !res.headers.get('content-encoding') && len > 0 ? len : null;
    const final = res.url ? new URL(res.url) : url;
    job.name = await freeName(sftp, job.dir, want ?? nameFrom(final, res.headers.get('content-disposition')));
    part = partPath(job.dir, `dl-${job.id}`);
    noteUploadDir(job.dir);
    job.state = 'downloading';
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        const now = Date.now();
        job.received += chunk.length;
        job.lastByteAt = now;
        if (now - job.lastAt >= 1000) {
          const bps = ((job.received - job.lastBytes) * 1000) / (now - job.lastAt);
          job.bps = job.bps ? job.bps * 0.5 + bps * 0.5 : bps;
          job.lastAt = now;
          job.lastBytes = job.received;
        }
        cb(null, chunk);
      },
    });
    const source = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
    try {
      await pipeline(source, count, sftp.createWriteStream(part, { flags: 'w', mode: 0o644 }), { signal: job.ctl.signal });
    } catch (e) {
      if (job.ctl.signal.aborted) throw e;
      if (typeof (e as { code?: unknown }).code === 'number') throw sftpError(e as Error, path.posix.join(job.dir, job.name));
      throw new Error(fetchError(e));
    }
    if (job.total !== null && job.received < job.total) throw new Error('The site stopped sending before the end of the file.');
    // Something by the same name may have turned up meanwhile.
    job.name = await freeName(sftp, job.dir, job.name);
    await moveInto(sftp, part, path.posix.join(job.dir, job.name), false);
    part = null;
    job.state = 'done';
    job.total = job.received;
  } catch (e) {
    job.state = job.cancelled ? 'cancelled' : 'failed';
    const reason = job.ctl.signal.aborted && !job.cancelled ? job.ctl.signal.reason : e;
    job.error = job.cancelled ? null : (reason as Error)?.message || String(reason);
  } finally {
    clearInterval(watchdog);
    job.bps = 0;
    job.endedAt = new Date().toISOString();
    if (part && sftp) {
      const p = part;
      await call<void>(p, (cb) => sftp!.unlink(p, cb)).catch(() => {});
    }
  }
}

export function cancelDownload(id: string): DownloadJob {
  const j = jobs.find((x) => x.id === id);
  if (!j) throw new FileError('That download is gone from the list.', 404);
  if (j.state === 'starting' || j.state === 'downloading') {
    j.cancelled = true;
    j.ctl.abort(new Error('Cancelled'));
  }
  return view(j);
}

/** Take the finished, failed and cancelled ones off the list. */
export function clearDownloads(): DownloadsInfo['jobs'] {
  for (let i = jobs.length - 1; i >= 0; i--) if (!active().includes(jobs[i])) jobs.splice(i, 1);
  return jobs.map(view);
}
