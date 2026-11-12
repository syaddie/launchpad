import type { AppState, Backup, BackupSnapshot, Countdown, DirListing, Mood, Package, Photo, Prefs, SavedDoc, ServerStats, ShellInfo, SourceKey, Task, Training } from '../../shared/types';

const STATE_KEY = 'launchpad:state';
const PREFS_KEY = 'launchpad:prefs';
const SERVER_KEY = 'launchpad:server';

// localStorage mirrors: paint instantly from cache, then refresh from the server.
export function cachedState(): AppState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? (JSON.parse(raw) as AppState) : null;
  } catch {
    return null;
  }
}

export function cacheState(s: AppState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: s.prefs.theme, accent: s.prefs.accent, design: s.prefs.design }));
  } catch {
    // Storage full or blocked: the page still works, it just paints from the network.
  }
}

/** The Server view's last reading, so it opens on that instead of a blank page. */
export function cachedServer(): ServerStats | null {
  try {
    const raw = localStorage.getItem(SERVER_KEY);
    return raw ? (JSON.parse(raw) as ServerStats) : null;
  } catch {
    return null;
  }
}

export function cacheServer(s: ServerStats): void {
  try {
    localStorage.setItem(SERVER_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function localGet(key: string): string | null {
  try {
    return localStorage.getItem('launchpad:' + key);
  } catch {
    return null;
  }
}

export function localSet(key: string, value: string): void {
  try {
    localStorage.setItem('launchpad:' + key, value);
  } catch {
    // ignore
  }
}

/**
 * This tab's id, sent with every request so the server's change stream (/api/events)
 * doesn't echo a tab's own saves back to it. Not randomUUID: that needs HTTPS.
 */
export const TAB_ID = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

/** The Launchpad server itself can't be used: not reachable, not answering, or the Access sign-in lapsed. */
export class ServerError extends Error {
  constructor(readonly kind: 'unreachable' | 'down' | 'access', message: string, readonly status = 0) {
    super(message);
  }
}

/** A whole-document save refused because another tab or device saved first; carries their copy. */
export class ConflictError extends Error {
  constructor(readonly version: string, readonly value: unknown) {
    super('Changed on another device');
  }
}

async function req<T>(method: string, url: string, body?: unknown, keepalive = false, extra?: Record<string, string>): Promise<T> {
  const raw = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'X-Launchpad-Tab': TAB_ID, ...(body === undefined ? {} : { 'Content-Type': raw ? body.type || 'application/octet-stream' : 'application/json' }), ...extra },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      keepalive,
    });
  } catch {
    throw new ServerError('unreachable', 'Can’t reach the Launchpad server.');
  }
  if (res.status === 403) throw new ServerError('access', 'Not signed in through Cloudflare Access.', 403);
  // The tunnel or a proxy answering for a server that's down (Cloudflare uses 52x and 530).
  if ([502, 503, 504].includes(res.status) || (res.status >= 520 && res.status <= 530)) {
    throw new ServerError('down', `The Launchpad server isn’t answering (${res.status}).`, res.status);
  }
  const json = await res.json().catch(() => ({}));
  if (res.status === 409 && (json as { conflict?: boolean }).conflict) {
    const c = json as { version: string; value: unknown };
    throw new ConflictError(c.version, c.value);
  }
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  /** Save a whole document. With `base`, the server refuses it (ConflictError) if someone else saved since that version. */
  putDoc: <K extends SavedDoc>(key: K, v: AppState[K], base?: string, keepalive?: boolean) =>
    req<{ ok: true; version: string }>('PUT', `/api/${key}`, v, keepalive, base === undefined ? undefined : { 'X-Base-Version': base }),
  putPrefs: (v: Prefs) => req<Prefs>('PUT', '/api/prefs', v),
  addTask: (listId: string, title: string, due: string | null) => req<Task>('POST', '/api/tasks', { listId, title, due }),
  completeTask: (t: Task, keepalive?: boolean) =>
    req('POST', `/api/tasks/${encodeURIComponent(t.listId)}/${encodeURIComponent(t.id)}/complete`, {}, keepalive),
  addPackage: (number: string, label: string, carrier: string) => req<Package>('POST', '/api/packages', { number, label, carrier }),
  patchPackage: (id: string, patch: Partial<Pick<Package, 'label' | 'isNew' | 'archived'>>) =>
    req<Package>('PATCH', `/api/packages/${encodeURIComponent(id)}`, patch),
  refreshPackage: (id: string) => req<Package | null>('POST', `/api/packages/${encodeURIComponent(id)}/refresh`, {}),
  sync: (source: SourceKey, ifOlderThanSec = 0) =>
    req<AppState>('POST', `/api/sync/${source}${ifOlderThanSec ? `?ifOlderThan=${ifOlderThanSec}` : ''}`, {}),
  disconnectGoogle: () => req<AppState>('POST', '/api/auth/google/disconnect', {}),
  addPhoto: (image: Blob) => req<Photo>('POST', '/api/photos', image),
  putPhotos: (v: Photo[]) => req('PUT', '/api/photos', v),
  deletePhoto: (id: string) => req('DELETE', `/api/photos/${encodeURIComponent(id)}`),
  putCountdowns: (v: Countdown[]) => req<Countdown[]>('PUT', '/api/countdowns', v),
  addSmoke: () => req<string[]>('POST', '/api/smokes', {}),
  removeSmoke: (at?: string) => req<string[]>('DELETE', `/api/smokes${at ? `?at=${encodeURIComponent(at)}` : ''}`),
  putTraining: (v: Training) => req<Training>('PUT', '/api/training', v),
  refreshTraining: (force: boolean) => req<AppState>('POST', `/api/training/refresh${force ? '?force=1' : ''}`, {}),
  refreshLearn: (force: boolean) => req<AppState>('POST', `/api/learn/refresh${force ? '?force=1' : ''}`, {}),
  putWeight: (date: string, kg: number | null) => req<Record<string, number>>('PUT', `/api/weights/${date}`, { kg }),
  putMood: (date: string, mood: Mood | { level: 0 }) => req<Record<string, Mood>>('PUT', `/api/moods/${date}`, mood),
  server: (iface?: string) => req<ServerStats>('GET', `/api/server${iface ? `?iface=${encodeURIComponent(iface)}` : ''}`),
  speedTest: () => req<ServerStats['speed']>('POST', '/api/speedtest', {}),
  shell: () => req<ShellInfo>('GET', '/api/shell'),
  trustHostKey: () => req<ShellInfo>('POST', '/api/shell/trust', {}),
  listDir: (path?: string) => req<DirListing>('GET', `/api/files/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  readText: (path: string) => req<{ path: string; text: string }>('GET', `/api/files/text?path=${encodeURIComponent(path)}`),
  writeText: (path: string, text: string) => req('PUT', '/api/files/text', { path, text }),
  makeDir: (path: string) => req('POST', '/api/files/mkdir', { path }),
  renamePath: (from: string, to: string) => req('POST', '/api/files/rename', { from, to }),
  deletePath: (path: string) => req('POST', '/api/files/delete', { path }),
  /** Restore a backup: the JSON, or a .zip with photos as the raw file. `undo` names the copy taken just before. */
  restoreBackup: (b: Partial<Backup> | Blob) => req<RestoreResult>('POST', '/api/backup', b),
  snapshots: () => req<BackupSnapshot[]>('GET', '/api/backup/snapshots'),
  takeSnapshot: () => req<BackupSnapshot[]>('POST', '/api/backup/snapshots', {}),
  restoreSnapshot: (id: string) => req<RestoreResult>('POST', `/api/backup/snapshots/${encodeURIComponent(id)}/restore`, {}),
  /** Take a copy now and upload it to Google Drive; resolves once it's there (or failed, in `drive.lastError`). */
  copyToDrive: () => req<AppState>('POST', '/api/backup/drive', {}),
};

/** Everything you've entered, as JSON. */
export const BACKUP_URL = '/api/backup';
export interface RestoreResult {
  restored: string[];
  /** The automatic copy taken just before, to put things back as they were. */
  undo: string | null;
  state: AppState;
}

/** Everything you've entered plus the photos, as a .zip. */
export const ZIP_BACKUP_URL = '/api/backup/zip';
export const snapshotUrl = (id: string) => `/api/backup/snapshots/${encodeURIComponent(id)}`;
/** A copy of the whole SQLite database. */
export const DB_BACKUP_URL = '/api/backup/db';

export const downloadUrl = (path: string) => `/api/files/download?path=${encodeURIComponent(path)}`;

/** An upload that failed, with the status so a clash (409) can be offered as a replace. */
export class UploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Pieces of an upload, each its own request. Cloudflare refuses a request body over
 * 100 MB, so a big file sent whole never arrives; the server's UPLOAD_CHUNK matches.
 */
export const UPLOAD_CHUNK = 32 * 1024 * 1024;

/** Where each piece of a file of `size` bytes starts and ends. An empty file is still one (empty) piece. */
export function uploadPieces(size: number, chunk = UPLOAD_CHUNK): [number, number][] {
  const pieces: [number, number][] = [];
  for (let start = 0; start < size || !pieces.length; start += chunk) pieces.push([start, Math.min(start + chunk, size)]);
  return pieces;
}

/** Send one piece; `onProgress` gets the bytes of it sent so far. */
function sendPiece(url: string, body: Blob, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status})`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {
        // Not JSON: a proxy's error page.
        if (xhr.status === 413) message = 'The server or Cloudflare refused it as too big.';
      }
      reject(new UploadError(message, xhr.status));
    };
    xhr.onerror = () => reject(new UploadError('Can’t reach the Launchpad server.', 0));
    xhr.send(body);
  });
}

/** Worth another go: the connection dropped, or Cloudflare couldn't reach the server for a moment. */
const transient = (e: unknown) => e instanceof UploadError && [0, 502, 503, 504, 520, 521, 522, 523, 524].includes(e.status);

/** Upload a file into `dir` on the server, piece by piece, reporting progress from 0 to 1. XHR, since fetch can't report upload progress. */
export async function uploadFile(dir: string, file: File, overwrite: boolean, onProgress: (p: number) => void): Promise<void> {
  // Not randomUUID: that needs HTTPS, and the LAN address is plain HTTP.
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const base = `/api/files/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&id=${id}&total=${file.size}${overwrite ? '&overwrite=1' : ''}`;
  try {
    for (const [start, end] of uploadPieces(file.size)) {
      for (let attempt = 1; ; attempt++) {
        try {
          await sendPiece(`${base}&offset=${start}`, file.slice(start, end), (sent) => file.size && onProgress((start + sent) / file.size));
          break;
        } catch (e) {
          if (attempt >= 4 || !transient(e)) throw e;
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    }
    onProgress(1);
  } catch (e) {
    // Leave nothing half-written behind; a clash (409 on the first piece) never wrote anything.
    req('POST', '/api/files/upload/abandon', { dir, id }).catch(() => {});
    throw e;
  }
}

export const photoUrl = (id: string) => `/api/photos/${encodeURIComponent(id)}`;
