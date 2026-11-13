// The Server view's torrents, through qBittorrent's Web API (QBIT_URL). Launchpad
// signs in as QBIT_USER and keeps the cookie it gets, signing in again when it
// lapses; with no QBIT_USER it expects qBittorrent to let it in without (its
// "bypass authentication for clients in whitelisted subnets" option).
import { config } from './config';
import type { Torrent, TorrentsInfo, TorrentStatus } from '../../shared/types';

/** An error the page can show, with the HTTP status that fits it. */
export class QbitError extends Error {
  constructor(message: string, readonly status: 400 | 409 | 413 | 502 | 503 = 502) {
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
  if (!res.ok || !/^ok/i.test(text)) throw new QbitError('qBittorrent didn’t take QBIT_USER and QBIT_PASS. Check them in .env.', 502);
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
  if (res.status === 403 && !retried && config.qbit.user) {
    cookie = null;
    return qreq(pathname, body, true);
  }
  if (res.status === 403) throw new QbitError(config.qbit.user ? 'qBittorrent refused Launchpad’s sign-in.' : 'qBittorrent wants a password: set QBIT_USER and QBIT_PASS.', 502);
  return res;
}

async function qjson<T>(pathname: string): Promise<T> {
  const res = await qreq(pathname);
  if (!res.ok) throw new QbitError(`qBittorrent answered ${res.status} to ${pathname}.`, 502);
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

// ---------- the list ----------

interface QTorrent {
  hash?: string;
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
  save_path?: string;
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
  };
}

export async function torrents(): Promise<TorrentsInfo> {
  const base = { configured: qbitConfigured(), torrents: [] as Torrent[], dlBps: 0, upBps: 0, version, hostDir: config.qbit.hostDir || null };
  if (!base.configured) return { ...base, error: null };
  try {
    const [list, transfer] = await Promise.all([qjson<QTorrent[]>('/api/v2/torrents/info'), qjson<{ dl_info_speed?: number; up_info_speed?: number }>('/api/v2/transfer/info')]);
    if (!version) version = await qreq('/api/v2/app/version').then((r) => (r.ok ? r.text() : null)).catch(() => null);
    return {
      ...base,
      error: null,
      version,
      torrents: list.map(toTorrent).sort((a, b) => b.addedAt.localeCompare(a.addedAt)),
      dlBps: transfer.dl_info_speed ?? 0,
      upBps: transfer.up_info_speed ?? 0,
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
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

export async function addTorrentLinks(v: unknown, paused = false): Promise<void> {
  const body = new URLSearchParams({ urls: cleanTorrentLinks(v).join('\n') });
  if (paused) {
    // v5 calls it stopped, v4 paused.
    body.set('stopped', 'true');
    body.set('paused', 'true');
  }
  await qpost(['/api/v2/torrents/add'], body);
}

export const MAX_TORRENT_FILE = 10 * 1024 * 1024;

export async function addTorrentFile(bytes: ArrayBuffer, name: string): Promise<void> {
  if (!bytes.byteLength) throw new QbitError('That file is empty.', 400);
  // A .torrent is a bencoded dictionary, so it starts with d.
  if (new Uint8Array(bytes)[0] !== 0x64) throw new QbitError('That isn’t a .torrent file.', 400);
  const form = new FormData();
  form.append('torrents', new Blob([bytes], { type: 'application/x-bittorrent' }), name.replace(/[^\w .-]/g, '_').slice(0, 120) || 'file.torrent');
  await qpost(['/api/v2/torrents/add'], form);
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
