import type { AppState, BookmarkGroup, Countdown, Money, Mood, Note, Package, Photo, Prefs, ServerStats, SourceKey, Task, Training } from '../../shared/types';

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
    localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: s.prefs.theme, accent: s.prefs.accent }));
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

/** The Launchpad server itself can't be used: not reachable, not answering, or the Access sign-in lapsed. */
export class ServerError extends Error {
  constructor(readonly kind: 'unreachable' | 'down' | 'access', message: string, readonly status = 0) {
    super(message);
  }
}

async function req<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  const raw = body instanceof Blob;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': raw ? body.type || 'application/octet-stream' : 'application/json' },
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
  if (!res.ok) throw new Error((json as { error?: string }).error || `Request failed (${res.status})`);
  return json as T;
}

export const api = {
  state: () => req<AppState>('GET', '/api/state'),
  putBookmarks: (v: BookmarkGroup[], keepalive?: boolean) => req('PUT', '/api/bookmarks', v, keepalive),
  putNotes: (v: Note[], keepalive?: boolean) => req('PUT', '/api/notes', v, keepalive),
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
  putMoney: (v: Money, keepalive?: boolean) => req<Money>('PUT', '/api/money', v, keepalive),
  putTraining: (v: Training) => req<Training>('PUT', '/api/training', v),
  putMood: (date: string, mood: Mood | { level: 0 }) => req<Record<string, Mood>>('PUT', `/api/moods/${date}`, mood),
  server: (iface?: string) => req<ServerStats>('GET', `/api/server${iface ? `?iface=${encodeURIComponent(iface)}` : ''}`),
  speedTest: () => req<ServerStats['speed']>('POST', '/api/speedtest', {}),
};

export const photoUrl = (id: string) => `/api/photos/${encodeURIComponent(id)}`;
