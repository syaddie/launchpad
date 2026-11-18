// Server › Downloads' videos: YouTube, X, TikTok, Reddit and SoundCloud links (and any other site
// yt-dlp knows) saved as the best video, a 1080p .mp4 or an .mp3. ytdlp.py (yt-dlp and ffmpeg, in
// the Docker image) downloads it into DATA_DIR/video-downloads/<job>, then Launchpad copies it into
// the folder on the server over SSH like any other download, and deletes its own copy. One link
// gets one video: a playlist's link its first.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { SFTPWrapper } from 'ssh2';
import { config } from './config';
import { addJob, cleanUrl, counter, downloadDir, downloadFinished, freeName, newJob, safeName, view, type Job } from './downloads';
import { HelperError, runHelper, type Helper, type HelperOptions } from './helper';
import { call, FileError, kindOf, moveInto, noteUploadDir, partPath, sftpError, sftpSession, stat } from './shell';
import { cleanVideoFormat, videoLink, videoNoun } from '../../shared/video';
import type { DownloadJob, VideoInfo, VideoProgress } from '../../shared/types';

/** Beside this file in the source, and beside the bundle in dist/server (the build copies it). */
const SCRIPT = fileURLToPath(new URL('./ytdlp.py', import.meta.url));
const MISSING =
  'Video downloads need yt-dlp and ffmpeg, which come with Launchpad’s Docker image. Running Launchpad another way: pip install yt-dlp yt-dlp-ejs, put ffmpeg on the PATH (or set YTDLP_FFMPEG), and set YTDLP_PYTHON to that Python.';

const HELPER: Helper = { python: config.ytdlpPython, script: SCRIPT, missing: MISSING, slow: 'yt-dlp took too long to answer.', name: 'video' };

type Event =
  | { type: 'version'; yt_dlp: string; ffmpeg: boolean; js: boolean }
  | { type: 'check'; site: string | null }
  | { type: 'info'; title: string; site: string | null; id: string; playlist: boolean; parts: { size: number | null }[] }
  | { type: 'progress'; part: number; downloaded: number; total: number | null; speed: number; eta: number | null }
  | { type: 'step'; step: string }
  | { type: 'file'; path: string }
  | { type: 'done' };

const run = (req: object, onEvent: (e: Event) => unknown, opts?: HelperOptions) => runHelper<Event>(HELPER, req, onEvent, opts);

// ---------- is it installed ----------

let probed: { at: number; info: VideoInfo } | null = null;
let probing: Promise<void> | null = null;

async function probe(): Promise<void> {
  let ev: Extract<Event, { type: 'version' }> | null = null;
  try {
    await run({ cmd: 'version', ffmpeg: config.ytdlpFfmpeg }, (e) => e.type === 'version' && (ev = e), { timeout: 30_000 });
    const v = ev as Extract<Event, { type: 'version' }> | null;
    const error = !v ? MISSING : !v.ffmpeg ? 'yt-dlp is there, but ffmpeg isn’t: it joins the video and sound, and makes MP3s.' : null;
    probed = { at: Date.now(), info: { available: !error, version: v?.yt_dlp ?? null, error } };
  } catch (e) {
    probed = { at: Date.now(), info: { available: false, version: null, error: (e as Error).message } };
  }
}

/** Whether video downloads can run. A failed check is tried again after a minute. */
export async function videoInfo(): Promise<VideoInfo> {
  if (!probed || (!probed.info.available && Date.now() - probed.at > 60_000)) await (probing ??= probe().finally(() => (probing = null)));
  return probed!.info;
}

// ---------- does yt-dlp know the site ----------

const known = new Map<string, { site: string | null; at: number }>();
const asking = new Map<string, Promise<string | null>>();

/** The site yt-dlp knows a link as (worked out without fetching it), or null when all it could do is fetch the link itself. */
export async function videoSite(urlIn: unknown): Promise<{ site: string | null }> {
  const url = cleanUrl(urlIn).href;
  const link = videoLink(url);
  if (link) return { site: link.site };
  if (!(await videoInfo()).available) return { site: null };
  const hit = known.get(url);
  if (hit && Date.now() - hit.at < 3_600_000) return { site: hit.site };
  let p = asking.get(url);
  if (!p) {
    p = (async () => {
      let site: string | null = null;
      await run({ cmd: 'check', url }, (e) => e.type === 'check' && (site = e.site), { timeout: 30_000 });
      if (known.size >= 500) known.delete(known.keys().next().value!);
      known.set(url, { site, at: Date.now() });
      return site;
    })().finally(() => asking.delete(url));
    asking.set(url, p);
  }
  return { site: await p.catch(() => null) };
}

// ---------- room in DATA_DIR ----------

/** Below this much free in DATA_DIR, no video starts. */
export const MIN_FREE = 512 * 1024 * 1024;
/** Kept free on top of what a video needs. */
const MARGIN = 256 * 1024 * 1024;

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);

/** Bytes free where DATA_DIR is; null when the system won't say. */
export function freeSpace(dir = config.dataDir): number | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

/**
 * Why a video of these parts won't fit, or null when it will. It needs about twice its size while
 * ffmpeg works (the parts and what it makes of them), less what the other videos going need.
 */
export function roomFor(free: number | null, sizes: (number | null)[], reserved: number): string | null {
  if (free === null) return null;
  const left = free - reserved;
  if (left < MIN_FREE) return `Launchpad’s data folder has only ${gb(Math.max(0, left))} free, too little to download a video into first.`;
  if (!sizes.length || sizes.some((s) => s === null)) return null;
  const need = sizes.reduce<number>((a, s) => a + s!, 0) * 2 + MARGIN;
  return need > left ? `That video needs about ${gb(need)} free in Launchpad’s data folder while it downloads, and there’s ${gb(left)}.` : null;
}

/** Room the videos going will still take, by job. */
const claims = new Map<string, number>();
const reservedBy = (id: string) => [...claims].reduce((a, [k, v]) => (k === id ? a : a + v), 0);

// ---------- progress ----------

/** What ffmpeg is doing, from the name of yt-dlp's step. */
export function stepOf(pp: string): VideoProgress['step'] {
  if (pp === 'Merger') return 'join';
  if (pp === 'ExtractAudio') return 'mp3';
  if (pp === 'VideoRemuxer' || pp === 'VideoConvertor') return 'mp4';
  if (pp === 'Metadata') return 'tags';
  return 'fix';
}

/** Bytes downloaded and expected across the parts: each finished part whole, the current one so far; total null while any size is unknown. */
export function videoBytes(totals: (number | null)[], done: number[]): { received: number; total: number | null } {
  const received = done.reduce((a, d) => a + (d || 0), 0);
  const known = totals.length > 0 && totals.every((t) => t !== null && t > 0);
  const total = known ? totals.reduce<number>((a, t) => a + t!, 0) : null;
  return { received, total: total !== null ? Math.max(total, received) : null };
}

/** The job's name until the file's is known: the title, or what the link is to. */
function label(url: string, title: string | null): string {
  if (title) return safeName(title) || 'Video';
  const link = videoLink(url);
  const noun = link ? videoNoun(link.site) : `video from ${new URL(url).hostname.replace(/^www\./, '')}`;
  return noun[0].toUpperCase() + noun.slice(1);
}

// ---------- downloading ----------

const tmpRoot = () => path.join(config.dataDir, 'video-downloads');
let swept = false;

/** What a restart left behind: no video is going yet when the first one starts. */
function sweepTemp(): void {
  if (swept) return;
  swept = true;
  rmQuietly(tmpRoot());
}

function rmQuietly(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 });
  } catch (e) {
    console.error(`[video] Couldn’t delete ${p}:`, (e as Error).message);
  }
}

/** Start saving the video at `body.url` into `body.dir`; it carries on after this returns. */
export async function startVideo(body: { url?: unknown; dir?: unknown; format?: unknown }): Promise<DownloadJob> {
  const dir = downloadDir(body.dir);
  const url = cleanUrl(body.url);
  const info = await videoInfo();
  if (!info.available) throw new FileError(info.error ?? MISSING, 409);
  const format = cleanVideoFormat(body.format);
  const job = newJob({ url: url.href, name: label(url.href, null), dir });
  const room = roomFor(freeSpace(), [], reservedBy(job.id));
  if (room) throw new FileError(room, 409);
  const link = videoLink(url.href);
  job.video = { format, site: link?.site ?? null, title: null, phase: 'finding', part: 0, parts: 1, step: null, playlist: false };
  addJob(job);
  runVideo(job).catch(() => {});
  return view(job);
}

/** Nothing from yt-dlp for this long while it downloads: it's given up on. */
const STALL = 5 * 60_000;

async function runVideo(job: Job): Promise<void> {
  const v = job.video!;
  sweepTemp();
  const tmp = path.join(tmpRoot(), job.id);
  let sftp: SFTPWrapper | null = null;
  let part: string | null = null;
  let file: string | null = null;
  const totals: (number | null)[] = [];
  const done: number[] = [];
  const watchdog = setInterval(() => {
    if (v.phase === 'downloading' && Date.now() - job.lastByteAt > STALL) job.ctl.abort(new Error('yt-dlp got nothing for 5 minutes.'));
  }, 10_000);
  try {
    ({ sftp } = await sftpSession());
    const d = await stat(sftp, job.dir);
    if (kindOf(d.mode) !== 'dir') throw new FileError(`${job.dir} isn’t a folder.`);
    fs.mkdirSync(tmp, { recursive: true });
    await run(
      { cmd: 'download', url: job.url, format: v.format, dir: tmp, ffmpeg: config.ytdlpFfmpeg, node: process.execPath },
      (e) => {
        job.lastByteAt = Date.now();
        if (e.type === 'info') {
          v.title = e.title || null;
          v.site = e.site ?? v.site;
          v.playlist = !!e.playlist;
          v.parts = Math.max(1, e.parts.length);
          totals.splice(0, totals.length, ...e.parts.map((p) => (typeof p.size === 'number' && p.size > 0 ? p.size : null)));
          job.name = label(job.url, v.title);
          job.total = videoBytes(totals, done).total;
          const room = roomFor(freeSpace(), totals, reservedBy(job.id));
          if (room) job.ctl.abort(new Error(room));
          else if (job.total) claims.set(job.id, job.total * 2);
        } else if (e.type === 'progress') {
          const i = Math.max(0, Math.min(e.part, 9));
          // A part it says nothing more of is done whole; this one is as far as it says.
          for (let k = 0; k < i; k++) done[k] = totals[k] ?? done[k] ?? 0;
          done[i] = e.downloaded;
          if (e.total) totals[i] = Math.max(totals[i] ?? 0, e.total);
          v.parts = Math.max(v.parts, i + 1);
          v.part = i;
          v.phase = 'downloading';
          job.state = 'downloading';
          ({ received: job.received, total: job.total } = videoBytes(totals.slice(0, v.parts), done));
          job.bps = e.speed > 0 ? e.speed : job.bps * 0.5;
        } else if (e.type === 'step') {
          v.phase = 'processing';
          v.step = stepOf(e.step);
          job.state = 'downloading';
          job.bps = 0;
        } else if (e.type === 'file') {
          const p = path.resolve(e.path);
          if (p.startsWith(tmp + path.sep)) file = p;
        }
      },
      { signal: job.ctl.signal, group: true },
    );
    file ??= biggestFile(tmp);
    if (!file || !fs.existsSync(file)) throw new Error('yt-dlp finished without leaving a file.');
    await saveInto(job, sftp, file, (p) => (part = p));
    part = null;
    job.state = 'done';
    job.total = job.received;
    downloadFinished({ source: 'video', id: job.id, name: job.name, path: path.posix.join(job.dir, job.name), isDir: false });
  } catch (e) {
    job.state = job.cancelled ? 'cancelled' : 'failed';
    const reason = job.ctl.signal.aborted && !job.cancelled ? job.ctl.signal.reason : e;
    job.error = job.cancelled ? null : (reason as Error)?.message || String(reason);
    if (e instanceof HelperError && e.code === 'missing' && probed) probed.info = { ...probed.info, available: false, error: MISSING };
  } finally {
    clearInterval(watchdog);
    claims.delete(job.id);
    job.bps = 0;
    job.endedAt = new Date().toISOString();
    rmQuietly(tmp);
    if (part && sftp) {
      const p = part;
      await call<void>(p, (cb) => sftp!.unlink(p, cb)).catch(() => {});
    }
  }
}

/** What's left in the folder once yt-dlp is done, when it didn't say: the biggest file that isn't one of its own part files. */
function biggestFile(dir: string): string | null {
  let best: { p: string; size: number } | null = null;
  for (const name of fs.readdirSync(dir)) {
    if (/\.(part|ytdl|temp)$|\.part-Frag\d+$/i.test(name)) continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isFile() && (!best || st.size > best.size)) best = { p, size: st.size };
  }
  return best?.p ?? null;
}

/** Copy `file` into the job's folder, through a hidden part file like every download, counting it as it goes. */
async function saveInto(job: Job, sftp: SFTPWrapper, file: string, onPart: (p: string) => void): Promise<void> {
  const v = job.video!;
  v.phase = 'saving';
  v.step = null;
  const size = fs.statSync(file).size;
  const now = Date.now();
  Object.assign(job, { received: 0, total: size, bps: 0, lastAt: now, lastBytes: 0, lastByteAt: now });
  job.name = await freeName(sftp, job.dir, safeName(path.basename(file)) || 'video');
  const part = partPath(job.dir, `dl-${job.id}`);
  onPart(part);
  noteUploadDir(job.dir);
  try {
    await pipeline(fs.createReadStream(file), counter(job), sftp.createWriteStream(part, { flags: 'w', mode: 0o644 }), { signal: job.ctl.signal });
  } catch (e) {
    if (job.ctl.signal.aborted) throw e;
    if (typeof (e as { code?: unknown }).code === 'number') throw sftpError(e as Error, path.posix.join(job.dir, job.name));
    throw e;
  }
  if (job.received < size) throw new Error('The copy into the folder stopped before the end of the file.');
  // Something by the same name may have turned up meanwhile.
  job.name = await freeName(sftp, job.dir, job.name);
  await moveInto(sftp, part, path.posix.join(job.dir, job.name), false);
}
