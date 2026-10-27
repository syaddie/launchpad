import type { AppState, BookmarkGroup, Note, Package, Prefs, SourceKey, Task } from '../../shared/types';

const STATE_KEY = 'launchpad:state';
const PREFS_KEY = 'launchpad:prefs';

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

async function req<T>(method: string, url: string, body?: unknown, keepalive = false): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    keepalive,
  });
  if (res.status === 403) throw new Error('Not signed in through Cloudflare Access.');
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
};
