// The Server view's torrents, through qBittorrent's Web API (QBIT_URL). Launchpad
// signs in as QBIT_USER and keeps the cookie it gets, signing in again when it
// lapses; with no QBIT_USER it expects qBittorrent to let it in without (its
// "bypass authentication for clients in whitelisted subnets" option).
//
// A torrent can have a ratio to seed to. That's Launchpad's, not qBittorrent's own share
// limit (which can be set to delete the files): it's kept in DATA_DIR/torrent-watch.json, and
// once the torrent has seeded that far Launchpad takes it out of qBittorrent, files kept.
// The same watch, every half a minute and whenever the page looks, notices torrents finishing
// and tells downloadFinished.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { downloadFinished } from './downloads';
import type { RetiredTorrent, Torrent, TorrentFile, TorrentOptions, TorrentsInfo, TorrentSpeed, TorrentStatus } from '../../shared/types';

/** An error the page can show, with the HTTP status that fits it. */
export class QbitError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 413 | 502 | 503 = 502) {
    super(message);
  }
}

export const qbitConfigured = () => !!config.qbit.url;

let cookie: string | null = null;
let version: string | null = null;
/** A sign-in under way, which requests made meanwhile wait for rather than signing in again. */
let signingIn: Promise<void> | null = null;

/** qBittorrent refuses API calls whose Referer or Origin isn't its own address. */
const headers = (): Record<string, string> => ({ Referer: config.qbit.url + '/', Origin: config.qbit.url, ...(cookie ? { Cookie: cookie } : {}) });

function unreachable(e: unknown): QbitError {
  const c = (e as { cause?: { code?: string; message?: string } }).cause;
  const why = c?.code === 'ENOTFOUND' || c?.code === 'EAI_AGAIN' ? 'no such host' : c?.code === 'ECONNREFUSED' ? 'nothing is listening' : c?.message || (e as Error).message;
  return new QbitError(`Can’t reach qBittorrent at ${config.qbit.url} (${why}). Is the qbittorrent container running?`, 502);
}

function login(): Promise<void> {
  signingIn ??= signIn().finally(() => (signingIn = null));
  return signingIn;
}

async function signIn(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${config.qbit.url}/api/v2/auth/login`, {
      method: 'POST',
      headers: { ...headers(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: config.qbit.user, password: config.qbit.pass }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    throw unreachable(e);
  }
  const text = (await res.text()).trim();
  if (res.status === 403) throw new QbitError('qBittorrent has locked Launchpad out after too many wrong passwords. Check QBIT_PASS, then restart the qbittorrent container.', 502);
  // v4 answers 200 "Ok." (or 200 "Fails."); v5 answers 204 with no body, and 401 for a wrong password.
  if (!res.ok || (res.status !== 204 && !/^ok/i.test(text))) throw new QbitError('qBittorrent didn’t take QBIT_USER and QBIT_PASS. Check them in .env.', 502);
  const set = res.headers.getSetCookie();
  cookie = set.map((c) => c.split(';')[0]).filter(Boolean).join('; ') || null;
}

async function qreq(pathname: string, body?: URLSearchParams | FormData, retried = false): Promise<Response> {
  if (!qbitConfigured()) throw new QbitError('qBittorrent isn’t set up: set QBIT_URL.', 503);
  if (!cookie && config.qbit.user) await login();
  let res: Response;
  try {
    res = await fetch(config.qbit.url + pathname, { method: body ? 'POST' : 'GET', headers: headers(), body, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw unreachable(e);
  }
  if ((res.status === 403 || res.status === 401) && !retried && config.qbit.user) {
    cookie = null;
    return qreq(pathname, body, true);
  }
  if (res.status === 403 || res.status === 401) throw new QbitError(config.qbit.user ? 'qBittorrent refused Launchpad’s sign-in.' : 'qBittorrent wants a password: set QBIT_USER and QBIT_PASS.', 502);
  return res;
}

async function qjson<T>(pathname: string): Promise<T> {
  const res = await qreq(pathname);
  if (res.status === 404 && pathname.includes('hash')) throw new QbitError('That torrent isn’t in qBittorrent any more.', 404);
  if (!res.ok) throw new QbitError(`qBittorrent answered ${res.status} to ${pathname.split('?')[0]}.`, 502);
  return (await res.json()) as T;
}

/** POST, trying each path in turn while qBittorrent says it doesn't have one (v5 renamed pause and resume). */
async function qpost(paths: string[], body: URLSearchParams | FormData): Promise<string> {
  for (const p of paths) {
    const res = await qreq(p, body);
    if (res.status === 404 && p !== paths[paths.length - 1]) continue;
    const text = (await res.text()).trim();
    if (res.status === 415) throw new QbitError('qBittorrent couldn’t read that torrent.', 400);
    if (!res.ok || /^fails/i.test(text)) throw new QbitError(text && !/^fails/i.test(text) ? `qBittorrent: ${text}` : 'qBittorrent didn’t add it. It may be in the list already.', 400);
    return text;
  }
  return '';
}

/** A POST that just has to work; `what` is what it does, for the error ("change the file's priority"). */
async function qset(pathname: string, params: Record<string, string>, what: string): Promise<void> {
  const res = await qreq(pathname, new URLSearchParams(params));
  if (res.ok) return;
  const text = (await res.text()).trim().slice(0, 200);
  if (res.status === 404) throw new QbitError(params.hash || params.hashes ? 'That torrent isn’t in qBittorrent any more.' : `This qBittorrent can’t ${what}. It may be too old.`, 404);
  throw new QbitError(`qBittorrent couldn’t ${what}${text ? `: ${text}` : '.'}`, res.status === 400 || res.status === 409 ? 400 : 502);
}

// ---------- the list ----------

interface QTorrent {
  hash?: string;
  infohash_v1?: string;
  infohash_v2?: string;
  name?: string;
  size?: number;
  total_size?: number;
  completed?: number;
  progress?: number;
  dlspeed?: number;
  upspeed?: number;
  eta?: number;
  state?: string;
  num_seeds?: number;
  num_leechs?: number;
  ratio?: number;
  added_on?: number;
  completion_on?: number;
  save_path?: string;
  download_path?: string;
  content_path?: string;
  category?: string;
  tags?: string;
}

/** qBittorrent's states (v4's paused* and v5's stopped* alike), in a handful of words the page shows. */
export function torrentStatus(state: string, progress: number): TorrentStatus {
  if (/^(error|missingFiles|unknown)$/.test(state)) return 'error';
  if (/^(paused|stopped)DL$/.test(state)) return 'paused';
  if (/^(paused|stopped)UP$/.test(state)) return 'done';
  if (/^queued/.test(state)) return 'queued';
  if (/^checking/.test(state)) return 'checking';
  if (/^(metaDL|forcedMetaDL)$/.test(state)) return 'metadata';
  if (state === 'moving') return 'moving';
  if (state === 'stalledDL') return 'stalled';
  if (/^(uploading|stalledUP|forcedUP)$/.test(state)) return 'seeding';
  if (/^(downloading|forcedDL)$/.test(state)) return 'downloading';
  return progress >= 1 ? 'done' : 'downloading';
}

/** qBittorrent's save folder as it is on the server: QBIT_SAVE_DIR in its container is QBIT_HOST_DIR outside. */
export function hostDirOf(savePath: string, saveDir = config.qbit.saveDir, hostDir = config.qbit.hostDir): string | null {
  if (!hostDir || !savePath) return null;
  const p = savePath.replace(/(.)\/+$/, '$1');
  if (p === saveDir) return hostDir;
  if (p.startsWith(saveDir + '/')) return hostDir + p.slice(saveDir.length);
  return null;
}

/** The tag Launchpad puts on a torrent it has just added with a ratio, until it knows the torrent's hash. */
const NEW_TAG = /^launchpad-new-[0-9a-f]{8}$/;

/** qBittorrent's comma-joined tags, without Launchpad's own. */
export const tagList = (tags: string | undefined): string[] =>
  (tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t && !NEW_TAG.test(t));

export function toTorrent(t: QTorrent): Torrent {
  const progress = Math.min(1, Math.max(0, t.progress ?? 0));
  const size = t.size ?? t.total_size ?? 0;
  const state = t.state ?? 'unknown';
  // qBittorrent says 8640000 (100 days) for "don't know".
  const eta = t.eta ?? -1;
  return {
    hash: t.hash ?? '',
    name: t.name ?? '',
    size,
    done: t.completed ?? Math.round(size * progress),
    progress,
    dlBps: t.dlspeed ?? 0,
    upBps: t.upspeed ?? 0,
    etaSec: eta > 0 && eta < 8_640_000 && progress < 1 ? eta : null,
    state,
    status: torrentStatus(state, progress),
    seeds: t.num_seeds ?? 0,
    peers: t.num_leechs ?? 0,
    ratio: Math.round((t.ratio ?? 0) * 100) / 100,
    addedAt: new Date((t.added_on ?? 0) * 1000).toISOString(),
    savePath: t.save_path ?? '',
    hostDir: hostDirOf(t.save_path ?? ''),
    category: t.category ?? '',
    tags: tagList(t.tags),
    ratioLimit: null,
  };
}

// ---------- speed limits ----------

interface QPrefs {
  dl_limit?: number;
  up_limit?: number;
  alt_dl_limit?: number;
  alt_up_limit?: number;
  save_path?: string;
}

let prefs: { at: number; p: QPrefs } | null = null;

/** qBittorrent's settings, kept for 15 seconds: the page asks every two. */
async function preferences(fresh = false): Promise<QPrefs> {
  if (!fresh && prefs && Date.now() - prefs.at < 15_000) return prefs.p;
  const p = await qjson<QPrefs>('/api/v2/app/preferences');
  prefs = { at: Date.now(), p };
  return p;
}

/** A limit as qBittorrent gives it (bytes a second; 0 or -1 for none) as the page shows it: 0 for none. */
const limitOf = (n: unknown) => (typeof n === 'number' && n > 0 ? n : 0);

export function toSpeed(mode: string, p: QPrefs): TorrentSpeed {
  return { turtle: mode.trim() === '1', dl: limitOf(p.dl_limit), up: limitOf(p.up_limit), turtleDl: limitOf(p.alt_dl_limit), turtleUp: limitOf(p.alt_up_limit) };
}

async function speed(): Promise<TorrentSpeed> {
  const [mode, p] = await Promise.all([qreq('/api/v2/transfer/speedLimitsMode').then((r) => (r.ok ? r.text() : '0')), preferences()]);
  return toSpeed(mode, p);
}

/** Turn turtle mode (qBittorrent's alternative speed limits) on or off. */
export async function setTurtle(on: unknown): Promise<void> {
  if (typeof on !== 'boolean') throw new QbitError('Say whether turtle mode is on.', 400);
  const now = (await (await qreq('/api/v2/transfer/speedLimitsMode')).text()).trim() === '1';
  if (now !== on) await qset('/api/v2/transfer/toggleSpeedLimitsMode', {}, 'switch turtle mode');
}

/** The most a cap can be: qBittorrent keeps them in a 32-bit number of bytes a second. */
const MAX_LIMIT = 2_000_000_000;

/** Speed caps from the page, in bytes a second (0 for none); only the ones given change. */
export function cleanSpeedCaps(v: unknown): Partial<Record<'dl' | 'up' | 'turtleDl' | 'turtleUp', number>> {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Partial<Record<'dl' | 'up' | 'turtleDl' | 'turtleUp', number>> = {};
  for (const k of ['dl', 'up', 'turtleDl', 'turtleUp'] as const) {
    if (!(k in o)) continue;
    const n = o[k];
    if (n === null || n === 0) out[k] = 0;
    else if (typeof n === 'number' && Number.isFinite(n) && n >= 1024 && n <= MAX_LIMIT) out[k] = Math.round(n);
    else throw new QbitError('A speed cap is at least 1 KB/s, or none.', 400);
  }
  if (!Object.keys(out).length) throw new QbitError('Give a speed cap to change.', 400);
  return out;
}

export async function setSpeedCaps(v: unknown): Promise<void> {
  const caps = cleanSpeedCaps(v);
  const json: Record<string, number> = {};
  if (caps.dl !== undefined) json.dl_limit = caps.dl;
  if (caps.up !== undefined) json.up_limit = caps.up;
  if (caps.turtleDl !== undefined) json.alt_dl_limit = caps.turtleDl;
  if (caps.turtleUp !== undefined) json.alt_up_limit = caps.turtleUp;
  try {
    await qset('/api/v2/app/setPreferences', { json: JSON.stringify(json) }, 'change the speed caps');
  } finally {
    prefs = null;
  }
}

// ---------- the watch: ratios and finished torrents ----------

interface Watch {
  /** Ratios to seed to, by hash, and when each was set. */
  ratios: Record<string, { ratio: number; at: number }>;
  /** Torrents just added with a ratio, by the tag they were added with, until they turn up in the list. */
  pending: Record<string, { ratio: number; at: number }>;
  /** Torrents that finished up to this time (qBittorrent's, in seconds) have been told about. */
  finishedUpTo: number;
}

const watchFile = () => path.join(config.dataDir, 'torrent-watch.json');
let watch: Watch | null = null;

function loadWatch(): Watch {
  if (watch) return watch;
  try {
    const w = JSON.parse(fs.readFileSync(watchFile(), 'utf8')) as Partial<Watch>;
    watch = { ratios: w.ratios ?? {}, pending: w.pending ?? {}, finishedUpTo: typeof w.finishedUpTo === 'number' ? w.finishedUpTo : Math.floor(Date.now() / 1000) };
  } catch {
    // The first time: torrents that finished before now aren't news.
    watch = { ratios: {}, pending: {}, finishedUpTo: Math.floor(Date.now() / 1000) };
    saveWatch();
  }
  return watch;
}

/** Written whole and then moved into place. */
function saveWatch(): void {
  if (!watch) return;
  const file = watchFile();
  const tmp = file + '.tmp';
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(watch));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.error('[torrents] Couldn’t save', file, (e as Error).message);
  }
}

/** Forget what's loaded, so the next look reads the file (and qBittorrent's settings) again: for tests. */
export function resetWatch(): void {
  watch = null;
  prefs = null;
  retired.length = 0;
  busy.clear();
}

const retired: RetiredTorrent[] = [];
/** Torrents being taken out at their ratio right now. */
const busy = new Set<string>();

/** A ratio from the page: more than 0 and at most 100, to two places; null or '' for none. */
export function cleanRatio(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > 100) throw new QbitError('A ratio to seed to is more than 0 and at most 100.', 400);
  return Math.round(n * 100) / 100;
}

/** The hashes a torrent goes by: v5 and hybrid torrents have a v2 one too. */
const hashesOf = (t: QTorrent) => [t.hash, t.infohash_v1, t.infohash_v2?.slice(0, 40)].filter((h): h is string => !!h);

/** Whether qBittorrent is done with a torrent's download and its files are where they'll stay. */
const settled = (t: QTorrent) => (t.progress ?? 0) >= 1 && !/^(moving|checking|metaDL|forcedMetaDL|error|missingFiles|unknown|allocating)/.test(t.state ?? '');

/**
 * Look over qBittorrent's list: give torrents just added with a ratio their ratio, tell
 * downloadFinished about torrents that have finished since last time, and take out of
 * qBittorrent (files kept) the ones that have reached their ratio.
 */
export async function observe(list: QTorrent[], now = Date.now()): Promise<void> {
  const w = loadWatch();
  let changed = false;
  // Added with a ratio: the tag says which they are.
  const found = new Map<string, string[]>();
  for (const t of list) {
    for (const tag of (t.tags ?? '').split(',').map((s) => s.trim())) {
      if (!NEW_TAG.test(tag)) continue;
      found.set(tag, [...(found.get(tag) ?? []), t.hash ?? '']);
      const p = w.pending[tag];
      if (p && t.hash && !w.ratios[t.hash]) {
        w.ratios[t.hash] = { ratio: p.ratio, at: now };
        changed = true;
      }
    }
  }
  for (const [tag, hashes] of found) {
    if (w.pending[tag]) {
      delete w.pending[tag];
      changed = true;
    }
    untag(hashes.filter(Boolean), tag);
  }
  for (const [tag, p] of Object.entries(w.pending)) {
    // qBittorrent never got it (a link that didn't download, say).
    if (now - p.at > 24 * 3_600_000) {
      delete w.pending[tag];
      changed = true;
      untag([], tag);
    }
  }
  // Finished since last time.
  const nowSec = Math.floor(now / 1000);
  let upTo = w.finishedUpTo;
  for (const t of list) {
    const at = t.completion_on ?? 0;
    if (at > w.finishedUpTo && at <= nowSec + 86_400 && settled(t)) {
      upTo = Math.max(upTo, at);
      tellFinished(t);
    }
  }
  if (upTo !== w.finishedUpTo) {
    w.finishedUpTo = upTo;
    changed = true;
  }
  // Ratios reached, and ratios of torrents that are gone.
  const present = new Set(list.flatMap(hashesOf));
  for (const [hash, r] of Object.entries(w.ratios)) {
    const t = list.find((x) => hashesOf(x).includes(hash));
    if (!t) {
      if (!present.has(hash) && now - r.at > 10 * 60_000) {
        delete w.ratios[hash];
        changed = true;
      }
      continue;
    }
    if (!settled(t) || (t.ratio ?? 0) + 1e-9 < r.ratio || busy.has(hash)) continue;
    busy.add(hash);
    try {
      // Never deleteFiles: the files stay where they are.
      await qset('/api/v2/torrents/delete', { hashes: t.hash ?? hash, deleteFiles: 'false' }, 'take it out of the list');
      delete w.ratios[hash];
      changed = true;
      retired.unshift({ name: t.name ?? '', ratio: Math.round((t.ratio ?? 0) * 100) / 100, at: new Date(now).toISOString(), hostDir: hostDirOf(t.save_path ?? '') });
      retired.splice(10);
    } catch (e) {
      console.error(`[torrents] Couldn’t take ${t.name} out at its ratio:`, (e as Error).message);
    } finally {
      busy.delete(hash);
    }
  }
  if (changed) saveWatch();
}

/** Take Launchpad's tag off the torrents it was added to, and out of qBittorrent's list of tags. */
function untag(hashes: string[], tag: string): void {
  (async () => {
    if (hashes.length) await qset('/api/v2/torrents/removeTags', { hashes: hashes.join('|'), tags: tag }, 'tidy up a tag');
    await qset('/api/v2/torrents/deleteTags', { tags: tag }, 'tidy up a tag');
  })().catch(() => {});
}

/** downloadFinished, with where the torrent is on the server: its file, or its folder when it has several. */
function tellFinished(t: QTorrent): void {
  const hash = t.hash ?? '';
  const content = (t.content_path || path.posix.join(t.save_path ?? '', t.name ?? '')).replace(/\\/g, '/');
  const send = (isDir: boolean) => downloadFinished({ source: 'torrent', id: hash, name: t.name ?? '', path: hostDirOf(content), isDir });
  qjson<QFile[]>(`/api/v2/torrents/files?hash=${encodeURIComponent(hash)}`)
    .then((files) => send(files.length > 1 || files.some((f) => (f.name ?? '').includes('/'))))
    .catch(() => send(!/\.[A-Za-z0-9]{1,8}$/.test(content)));
}

let watching: ReturnType<typeof setInterval> | null = null;

/** Every half a minute, look over the torrents even when no page is open. */
export function startTorrentWatch(): void {
  if (watching || !qbitConfigured()) return;
  const tick = () => {
    qjson<QTorrent[]>('/api/v2/torrents/info')
      .then((list) => observe(list))
      .catch(() => {});
  };
  watching = setInterval(tick, 30_000);
  watching.unref();
  setTimeout(tick, 5_000).unref();
}

/** A ratio for a torrent already in the list, or null to seed on. */
export async function setRatio(hashIn: unknown, ratioIn: unknown): Promise<void> {
  const hash = cleanHashes([hashIn]);
  const ratio = cleanRatio(ratioIn);
  const w = loadWatch();
  if (ratio === null) delete w.ratios[hash];
  else w.ratios[hash] = { ratio, at: Date.now() };
  saveWatch();
}

export async function torrents(): Promise<TorrentsInfo> {
  const base = { configured: qbitConfigured(), torrents: [] as Torrent[], dlBps: 0, upBps: 0, version, hostDir: config.qbit.hostDir || null, speed: null, retired: [...retired] };
  if (!base.configured) return { ...base, error: null };
  try {
    const [list, transfer, sp] = await Promise.all([
      qjson<QTorrent[]>('/api/v2/torrents/info'),
      qjson<{ dl_info_speed?: number; up_info_speed?: number }>('/api/v2/transfer/info'),
      speed().catch(() => null),
    ]);
    if (!version) version = await qreq('/api/v2/app/version').then((r) => (r.ok ? r.text() : null)).catch(() => null);
    await observe(list).catch(() => {});
    const ratios = loadWatch().ratios;
    return {
      ...base,
      error: null,
      version,
      speed: sp,
      retired: [...retired],
      torrents: list
        .map((t) => {
          const out = toTorrent(t);
          const r = hashesOf(t).map((h) => ratios[h]).find(Boolean);
          return r ? { ...out, ratioLimit: r.ratio } : out;
        })
        .sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
      dlBps: transfer.dl_info_speed ?? 0,
      upBps: transfer.up_info_speed ?? 0,
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

// ---------- a torrent's files ----------

interface QFile {
  index?: number;
  name?: string;
  size?: number;
  progress?: number;
  priority?: number;
}

/** qBittorrent's file priorities: 0 skip, 1 normal, 6 high, 7 maximal (shown as high). */
export const priorityOf = (p: number | undefined): TorrentFile['priority'] => (p === 0 ? 'skip' : p !== undefined && p >= 6 ? 'high' : 'normal');
const PRIORITY: Record<TorrentFile['priority'], string> = { skip: '0', normal: '1', high: '6' };

/** A torrent's files; each one's folder on the server is where qBittorrent keeps it now (its folder for unfinished ones, if it has one). */
export function toFiles(files: QFile[], t: Pick<QTorrent, 'save_path' | 'download_path' | 'progress'>): TorrentFile[] {
  const base = ((t.progress ?? 0) < 1 && t.download_path) || t.save_path || '';
  return files.map((f, i) => {
    const name = (f.name ?? '').replace(/\\/g, '/');
    const dir = path.posix.dirname(name);
    return {
      index: typeof f.index === 'number' ? f.index : i,
      name,
      size: f.size ?? 0,
      progress: Math.min(1, Math.max(0, f.progress ?? 0)),
      priority: priorityOf(f.priority),
      hostDir: base ? hostDirOf(dir === '.' ? base : path.posix.join(base.replace(/\\/g, '/'), dir)) : null,
    };
  });
}

export async function torrentFiles(hashIn: unknown): Promise<TorrentFile[]> {
  const hash = cleanHashes([hashIn]);
  const [files, info] = await Promise.all([qjson<QFile[]>(`/api/v2/torrents/files?hash=${hash}`), qjson<QTorrent[]>(`/api/v2/torrents/info?hashes=${hash}`)]);
  if (!info.length) throw new QbitError('That torrent isn’t in qBittorrent any more.', 404);
  return toFiles(files, info[0]);
}

export async function setFilePriority(hashIn: unknown, idsIn: unknown, priorityIn: unknown): Promise<TorrentFile[]> {
  const hash = cleanHashes([hashIn]);
  const ids = Array.isArray(idsIn) ? idsIn : [];
  if (!ids.length || ids.length > 100_000 || !ids.every((n) => Number.isInteger(n) && n >= 0)) throw new QbitError('Pick a file first.', 400);
  if (typeof priorityIn !== 'string' || !(priorityIn in PRIORITY)) throw new QbitError('A file is skipped, normal or high.', 400);
  await qset('/api/v2/torrents/filePrio', { hash, id: ids.join('|'), priority: PRIORITY[priorityIn as TorrentFile['priority']] }, 'change the file’s priority');
  return torrentFiles(hash);
}

// ---------- categories and tags ----------

export async function torrentOptions(): Promise<TorrentOptions> {
  const [cats, tags, p] = await Promise.all([
    qjson<Record<string, { name?: string; savePath?: string }>>('/api/v2/torrents/categories'),
    qjson<string[]>('/api/v2/torrents/tags'),
    preferences().catch(() => ({}) as QPrefs),
  ]);
  return {
    categories: Object.entries(cats)
      .map(([name, c]) => {
        // An empty save path is the default one with the category's name on the end.
        const savePath = c.savePath || (p.save_path ? path.posix.join(p.save_path.replace(/\\/g, '/'), name) : '');
        return { name, savePath, hostDir: hostDirOf(savePath) };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    tags: tags.filter((t) => !NEW_TAG.test(t)).sort((a, b) => a.localeCompare(b)),
  };
}

/** A category's name: a folder's name, so no slashes. */
export function cleanCategory(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') throw new QbitError('A category is a name.', 400);
  const c = v.trim();
  if (!c) return null;
  if (c.length > 60 || /[\\/\x00-\x1f\x7f]/.test(c) || /^\.+$/.test(c)) throw new QbitError('A category’s name is up to 60 characters, without slashes. It’s the name of its folder.', 400);
  return c;
}

export function cleanTags(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : null;
  if (!list || list.length > 20 || !list.every((t) => typeof t === 'string')) throw new QbitError('Up to 20 tags, please.', 400);
  const tags = [...new Set((list as string[]).map((t) => t.trim()).filter(Boolean))];
  for (const t of tags) if (t.length > 50 || /[,\x00-\x1f\x7f]/.test(t) || NEW_TAG.test(t)) throw new QbitError(`“${t.slice(0, 50)}” can’t be a tag: up to 50 characters, without commas.`, 400);
  return tags;
}

export interface AddOptions {
  paused?: boolean;
  category?: unknown;
  tags?: unknown;
  ratio?: unknown;
}

/** Check what a torrent is added with, make its category and tags if they're new, and say what to send qBittorrent (and the tag that marks it for its ratio). */
async function addFields(o: AddOptions): Promise<{ fields: Record<string, string>; tag: string | null }> {
  const category = cleanCategory(o.category);
  const tags = cleanTags(o.tags);
  const ratio = cleanRatio(o.ratio);
  const fields: Record<string, string> = {};
  if (o.paused) {
    // v5 calls it stopped, v4 paused.
    fields.stopped = 'true';
    fields.paused = 'true';
  }
  if (category) {
    const cats = await qjson<Record<string, unknown>>('/api/v2/torrents/categories');
    if (!(category in cats)) await qset('/api/v2/torrents/createCategory', { category, savePath: '' }, `make the category ${category}`);
    fields.category = category;
    // Saved in the category's folder.
    fields.autoTMM = 'true';
  }
  const tag = ratio !== null ? `launchpad-new-${crypto.randomBytes(4).toString('hex')}` : null;
  if (tag) {
    tags.push(tag);
    const w = loadWatch();
    w.pending[tag] = { ratio: ratio!, at: Date.now() };
    saveWatch();
  }
  if (tags.length) {
    fields.tags = tags.join(',');
    await qset('/api/v2/torrents/createTags', { tags: fields.tags }, 'make the tags').catch((e) => {
      forget(tag);
      throw e;
    });
  }
  return { fields, tag };
}

/** A torrent added with a ratio didn't go in after all. */
function forget(tag: string | null): void {
  if (!tag) return;
  const w = loadWatch();
  delete w.pending[tag];
  saveWatch();
  untag([], tag);
}

/** qBittorrent's add call, with what it's added with; the ratio is forgotten if it fails. */
async function add(body: URLSearchParams | FormData, o: AddOptions): Promise<void> {
  const { fields, tag } = await addFields(o);
  for (const [k, val] of Object.entries(fields)) body.append(k, val);
  try {
    await qpost(['/api/v2/torrents/add'], body);
  } catch (e) {
    forget(tag);
    throw e;
  }
}

// ---------- changes ----------

const MAGNET = /^magnet:\?\S*xt=urn:bt[im]h:/i;

/** Magnet links and links to .torrent files, one a line. */
export function cleanTorrentLinks(v: unknown): string[] {
  if (typeof v !== 'string') throw new QbitError('Paste a magnet link.', 400);
  const lines = v.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new QbitError('Paste a magnet link.', 400);
  if (lines.length > 50) throw new QbitError('That’s more than 50 links at once.', 400);
  for (const l of lines) {
    if (l.length > 8000 || !(MAGNET.test(l) || /^https?:\/\/\S+$/i.test(l))) throw new QbitError(`That isn’t a magnet link or a link to a .torrent file: ${l.slice(0, 80)}`, 400);
  }
  return lines;
}

export async function addTorrentLinks(v: unknown, o: AddOptions = {}): Promise<void> {
  await add(new URLSearchParams({ urls: cleanTorrentLinks(v).join('\n') }), o);
}

export const MAX_TORRENT_FILE = 10 * 1024 * 1024;

export async function addTorrentFile(bytes: ArrayBuffer, name: string, o: AddOptions = {}): Promise<void> {
  if (!bytes.byteLength) throw new QbitError('That file is empty.', 400);
  // A .torrent is a bencoded dictionary, so it starts with d.
  if (new Uint8Array(bytes)[0] !== 0x64) throw new QbitError('That isn’t a .torrent file.', 400);
  const form = new FormData();
  form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), name.replace(/[^\w .-]/g, '_').slice(0, 120) || 'file.torrent');
  await add(form, o);
}

const HASH = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
export type TorrentAction = 'stop' | 'start' | 'delete' | 'deleteFiles';

export function cleanHashes(v: unknown): string {
  const list = Array.isArray(v) ? v : [];
  if (!list.length || list.length > 500 || !list.every((h) => typeof h === 'string' && HASH.test(h))) throw new QbitError('Pick a torrent first.', 400);
  return list.join('|');
}

export async function torrentAction(hashesIn: unknown, action: unknown): Promise<void> {
  const hashes = cleanHashes(hashesIn);
  const body = new URLSearchParams({ hashes });
  if (action === 'stop') await qpost(['/api/v2/torrents/stop', '/api/v2/torrents/pause'], body);
  else if (action === 'start') await qpost(['/api/v2/torrents/start', '/api/v2/torrents/resume'], body);
  else if (action === 'delete' || action === 'deleteFiles') {
    body.set('deleteFiles', action === 'deleteFiles' ? 'true' : 'false');
    await qpost(['/api/v2/torrents/delete'], body);
  } else throw new QbitError('Launchpad can stop, start or delete a torrent.', 400);
}
