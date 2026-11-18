// Server › Downloads' Instagram posts. instagram.py (instaloader, in the Docker image) works
// out what a post, or a profile's newest posts, are made of; Launchpad then saves each photo
// and video into a folder on the server over SSH, like any other download, as
// <folder>/<account>/<date>_UTC[_n].<ext>: the names instaloader gives its own downloads, so
// files already there are skipped. Instagram jobs run one at a time, as Instagram prefers.
//
// Signing in is optional (public posts work without it): the session cookie of a browser
// that's signed in to Instagram, kept in DATA_DIR/instagram-session.json, readable only by
// Launchpad, never sent to the page and not part of backups. It reaches the helper on stdin.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { SFTPWrapper } from 'ssh2';
import { config } from './config';
import { HelperError, runHelper as runPython, type Helper, type HelperOptions } from './helper';
import { addJob, counter, downloadDir, fetchError, newJob, safeName, STALL, view, type Job } from './downloads';
import { call, FileError, kindOf, moveInto, noteUploadDir, partPath, sftpError, sftpSession, stat } from './shell';
import { cleanIgLimit, igFileName, igLabel, type IgTarget } from '../../shared/instagram';
import type { DownloadJob, IgProgress, InstagramInfo } from '../../shared/types';

/** Beside this file in the source, and beside the bundle in dist/server (the build copies it). */
const SCRIPT = fileURLToPath(new URL('./instagram.py', import.meta.url));
const UA = 'Mozilla/5.0 (Launchpad)';
const MISSING =
  'Instagram downloads need instaloader, which comes with Launchpad’s Docker image. Running Launchpad another way: pip install instaloader, and set INSTALOADER_PYTHON to that Python.';

// ---------- the helper ----------

export interface IgPost {
  type: 'post';
  shortcode: string;
  owner: string;
  /** "2026-11-16_07-00-32_UTC": when it was posted, the start of each file's name. */
  stem: string;
  caption: string;
  info: Record<string, unknown>;
  items: { url: string; ext: string }[];
}

type HelperEvent =
  | { type: 'version'; instaloader: string }
  | { type: 'me'; username: string }
  | IgPost
  | { type: 'wait'; seconds: number }
  | { type: 'skip'; target: string; error: string; code: string }
  | { type: 'session'; cookies: Record<string, unknown> }
  | { type: 'error'; error: string; code: string }
  | { type: 'done' };

export { HelperError };

const HELPER: Helper = {
  python: config.instaloaderPython,
  script: SCRIPT,
  missing: MISSING,
  slow: 'Instagram took too long to answer. Try again in a while.',
  name: 'Instagram',
};

/** Run instagram.py with `req`; see runHelper. `code` is login, private, notfound, limited, missing or other. */
const runHelper = (req: object, onEvent: (e: HelperEvent) => unknown, opts: HelperOptions = {}) => runPython<HelperEvent>(HELPER, req, onEvent, opts);

// ---------- is it installed ----------

let probed: { at: number; available: boolean; version: string | null; error: string | null } | null = null;
let probing: Promise<void> | null = null;

async function probe(): Promise<void> {
  let version: string | null = null;
  try {
    await runHelper({ cmd: 'version' }, (e) => e.type === 'version' && (version = e.instaloader), { timeout: 20_000 });
    probed = { at: Date.now(), available: !!version, version, error: version ? null : MISSING };
  } catch (e) {
    probed = { at: Date.now(), available: false, version: null, error: (e as Error).message };
  }
}

/** Whether Instagram downloads can run, and who they're signed in as. A failed check is tried again after a minute. */
export async function instagramInfo(): Promise<InstagramInfo> {
  if (!probed || (!probed.available && Date.now() - probed.at > 60_000)) await (probing ??= probe().finally(() => (probing = null)));
  const s = loadSession();
  return { available: probed!.available, version: probed!.version, error: probed!.error, account: s?.username ?? null, stale: !!s?.stale };
}

// ---------- the session ----------

interface Session {
  username: string;
  cookies: Record<string, string>;
  savedAt: string;
  stale?: boolean;
}

/** The cookies worth keeping from instagram.com: the session and what Instagram sends along with it. */
const COOKIE_NAMES = new Set(['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'ig_nrcb', 'rur', 'datr', 'shbid', 'shbts']);
const COOKIE_VALUE = /^[\x21-\x7e]{1,4096}$/;

function keepCookies(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const name = k.trim().toLowerCase();
    const val = typeof v === 'string' ? v.trim().replace(/^"(.*)"$/, '$1') : '';
    if (COOKIE_NAMES.has(name) && COOKIE_VALUE.test(val) && !/[;,"\\]/.test(val)) out[name] = val;
  }
  return out;
}

/**
 * Instagram's cookies from what was pasted: the sessionid's value on its own, a Cookie header
 * ("sessionid=…; csrftoken=…", with or without "cookie:" in front), or a cookie export in JSON
 * (a list of {name, value}, as browser extensions write). Null without a sessionid.
 */
export function parseIgCookies(text: unknown): Record<string, string> | null {
  if (typeof text !== 'string') return null;
  const t = text.trim().replace(/^cookie:\s*/i, '');
  if (!t || t.length > 20_000) return null;
  const raw: Record<string, unknown> = {};
  if (/^[[{]/.test(t)) {
    try {
      const j: unknown = JSON.parse(t);
      const list = Array.isArray(j) ? j : Object.entries(j as object).map(([name, value]) => ({ name, value }));
      for (const c of list as { name?: unknown; value?: unknown }[]) if (c && typeof c.name === 'string') raw[c.name] = c.value;
    } catch {
      return null;
    }
  } else if (t.includes('=')) {
    for (const part of t.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) raw[part.slice(0, i)] = part.slice(i + 1);
    }
  } else raw.sessionid = t;
  const out = keepCookies(raw);
  return out.sessionid ? out : null;
}

const sessionFile = () => path.join(config.dataDir, 'instagram-session.json');

function loadSession(): Session | null {
  try {
    const s = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as Session;
    return typeof s?.username === 'string' && s.cookies && typeof s.cookies.sessionid === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** Written whole and then moved into place, readable by Launchpad alone. */
function saveSession(s: Session): void {
  const file = sessionFile();
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Change the saved session, as long as it's still the one `was` read (not signed out or replaced meanwhile). */
function updateSession(was: Session, change: Partial<Session>): void {
  const now = loadSession();
  if (now && now.username === was.username && now.savedAt === was.savedAt) saveSession({ ...now, ...change, savedAt: was.savedAt });
}

export async function signInInstagram(text: unknown): Promise<InstagramInfo> {
  const cookies = parseIgCookies(text);
  if (!cookies) throw new FileError('Paste the value of the sessionid cookie, or the whole Cookie header.');
  let username = '';
  let renewed: Record<string, string> = {};
  try {
    await runHelper(
      { cmd: 'check', session: cookies },
      (e) => {
        if (e.type === 'me') username = e.username;
        if (e.type === 'session') renewed = keepCookies(e.cookies);
      },
      { timeout: 90_000 },
    );
  } catch (e) {
    throw new FileError((e as Error).message, e instanceof HelperError && e.code === 'missing' ? 409 : 400);
  }
  if (!username) throw new FileError('Instagram didn’t say whose session that is. Copy a fresh sessionid while signed in.');
  saveSession({ username, cookies: { ...cookies, ...(renewed.sessionid ? renewed : {}) }, savedAt: new Date().toISOString() });
  return instagramInfo();
}

export async function signOutInstagram(): Promise<InstagramInfo> {
  fs.rmSync(sessionFile(), { force: true });
  return instagramInfo();
}

// ---------- downloading ----------

let igJobs = 0;
let queue: Promise<void> = Promise.resolve();

/** Start saving `target`'s photos and videos into `body.dir`; it carries on after this returns, after any Instagram job before it. */
export function startInstagram(body: { url?: unknown; dir?: unknown; limit?: unknown; metadata?: unknown }, target: IgTarget): DownloadJob {
  const dir = downloadDir(body.dir);
  if (probed && !probed.available) throw new FileError(probed.error ?? MISSING, 409);
  const limit = target.profile ? cleanIgLimit(body.limit) : null;
  const ig: IgProgress = {
    limit,
    metadata: body.metadata === true,
    want: limit ?? target.posts.length,
    postsDone: 0,
    current: null,
    files: 0,
    skipped: 0,
    failed: 0,
    lastError: null,
    folder: null,
    queued: igJobs > 0,
    waitUntil: null,
  };
  const job = newJob({ url: String(body.url).trim().slice(0, 8000), name: igLabel(target, limit ?? 0), dir, ig });
  addJob(job);
  igJobs++;
  // Cancelled while it waits its turn: it's over now, not when the one before it ends.
  job.ctl.signal.addEventListener(
    'abort',
    () => {
      if (!ig.queued) return;
      ig.queued = false;
      job.state = 'cancelled';
      job.endedAt = new Date().toISOString();
    },
    { once: true },
  );
  queue = queue.then(() => runInstagram(job, target).finally(() => igJobs--)).catch(() => {});
  return view(job);
}

async function runInstagram(job: Job, target: IgTarget): Promise<void> {
  const ig = job.ig!;
  if (job.state === 'cancelled') return;
  ig.queued = false;
  const session = loadSession();
  const owners = new Set<string>();
  try {
    if (job.ctl.signal.aborted) throw job.ctl.signal.reason;
    const { sftp } = await sftpSession();
    const d = await stat(sftp, job.dir);
    if (kindOf(d.mode) !== 'dir') throw new FileError(`${job.dir} isn’t a folder.`);
    const req = { cmd: 'resolve', posts: target.posts, profile: target.profile, limit: ig.limit, session: session?.cookies ?? null, username: session?.username ?? null };
    await runHelper(
      req,
      async (e) => {
        if (e.type === 'wait') {
          ig.waitUntil = new Date(Date.now() + e.seconds * 1000).toISOString();
          return;
        }
        ig.waitUntil = null;
        if (e.type === 'post') {
          await savePost(job, sftp, e, owners, target.profile);
          ig.postsDone++;
          ig.current = null;
        } else if (e.type === 'skip') {
          ig.failed++;
          ig.postsDone++;
          ig.lastError = e.error;
          if (e.code === 'login' && session) updateSession(session, { stale: true });
        } else if (e.type === 'session' && session) {
          const renewed = keepCookies(e.cookies);
          updateSession(session, { cookies: renewed.sessionid ? { ...session.cookies, ...renewed } : session.cookies, stale: false });
        }
      },
      { signal: job.ctl.signal },
    );
    if (!ig.files && !ig.skipped && ig.failed) throw new Error(ig.failed === 1 ? ig.lastError! : `None of the ${ig.failed} posts could be read. ${ig.lastError}`);
    job.state = 'done';
    job.total = job.received;
  } catch (e) {
    job.state = job.cancelled ? 'cancelled' : 'failed';
    if (!job.cancelled && e instanceof HelperError && e.code === 'login' && session) updateSession(session, { stale: true });
    job.error = job.cancelled ? null : (e as Error)?.message || String(e);
  } finally {
    job.bps = 0;
    ig.current = null;
    ig.waitUntil = null;
    job.endedAt = new Date().toISOString();
  }
}

const STEM = /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_UTC$/;

/**
 * One post's photos and videos (and its caption and details, if asked for) into <dir>/<account>:
 * the profile's own folder for a profile's posts, collaborations with other accounts included,
 * as instaloader's --profile does; otherwise the folder of whoever posted it.
 */
async function savePost(job: Job, sftp: SFTPWrapper, p: IgPost, owners: Set<string>, profile: string | null): Promise<void> {
  const ig = job.ig!;
  const items = (p.items ?? []).filter((it) => typeof it.url === 'string' && /^https:\/\//i.test(it.url));
  if (!STEM.test(p.stem) || !items.length) {
    ig.failed++;
    ig.lastError = 'Instagram gave no photos or videos for a post.';
    return;
  }
  job.state = 'downloading';
  const owner = safeName(profile ?? p.owner ?? '') || 'instagram';
  owners.add(owner);
  const folder = path.posix.join(job.dir, owner);
  await ensureDir(sftp, folder);
  ig.folder = owners.size === 1 ? folder : job.dir;
  if (owners.size === 1) job.name = ig.limit !== null ? `@${owner} · newest ${ig.limit}` : ig.want === 1 ? `@${owner} · ${p.shortcode}` : `@${owner} · ${ig.want} posts`;
  else job.name = `${ig.want} Instagram posts`;
  ig.current = { done: 0, of: items.length };
  for (const [i, it] of items.entries()) {
    const dest = path.posix.join(folder, igFileName(p.stem, i, items.length, it.ext));
    if (await stat(sftp, dest).catch(() => null)) ig.skipped++;
    else {
      await saveUrl(job, sftp, it.url, dest);
      ig.files++;
    }
    ig.current.done++;
  }
  if (ig.metadata) {
    if (p.caption) await writeIfNew(sftp, path.posix.join(folder, `${p.stem}.txt`), p.caption + '\n');
    await writeIfNew(sftp, path.posix.join(folder, `${p.stem}.json`), JSON.stringify(p.info, null, 2) + '\n');
  }
}

async function ensureDir(sftp: SFTPWrapper, dir: string): Promise<void> {
  const st = await stat(sftp, dir).catch(() => null);
  if (st && kindOf(st.mode) === 'dir') return;
  if (st) throw new FileError(`${dir} is there already, and isn’t a folder.`, 409);
  await call<void>(dir, (cb) => sftp.mkdir(dir, cb));
}

async function writeIfNew(sftp: SFTPWrapper, file: string, text: string): Promise<void> {
  if (await stat(sftp, file).catch(() => null)) return;
  await call<void>(file, (cb) => sftp.writeFile(file, text, { mode: 0o644 }, cb));
}

/** Fetch one photo or video into `dest`, through a hidden part file like every download. */
async function saveUrl(job: Job, sftp: SFTPWrapper, url: string, dest: string): Promise<void> {
  if (job.ctl.signal.aborted) throw job.ctl.signal.reason;
  const ctl = new AbortController();
  const stop = () => ctl.abort(job.ctl.signal.reason);
  job.ctl.signal.addEventListener('abort', stop);
  job.lastByteAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - job.lastByteAt > STALL) ctl.abort(new Error('Nothing arrived from Instagram for 90 seconds.'));
  }, 10_000);
  const dir = path.posix.dirname(dest);
  let part: string | null = null;
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*' } });
    } catch (e) {
      throw ctl.signal.aborted ? ctl.signal.reason : new Error(fetchError(e));
    }
    if (!res.ok || !res.body) throw new Error(`Instagram’s server answered ${res.status} for one of the files.`);
    const len = Number(res.headers.get('content-length'));
    const expect = !res.headers.get('content-encoding') && len > 0 ? len : null;
    const before = job.received;
    part = partPath(dir, `dl-${job.id}`);
    noteUploadDir(dir);
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter(job), sftp.createWriteStream(part, { flags: 'w', mode: 0o644 }), { signal: ctl.signal });
    } catch (e) {
      if (ctl.signal.aborted) throw ctl.signal.reason;
      if (typeof (e as { code?: unknown }).code === 'number') throw sftpError(e as Error, dest);
      throw new Error(fetchError(e));
    }
    if (expect !== null && job.received - before < expect) throw new Error('Instagram stopped sending before the end of a file.');
    await moveInto(sftp, part, dest, false);
    part = null;
  } finally {
    clearInterval(watchdog);
    job.ctl.signal.removeEventListener('abort', stop);
    if (part) {
      const p = part;
      await call<void>(p, (cb) => sftp.unlink(p, cb)).catch(() => {});
    }
  }
}
