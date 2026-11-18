// The Files explorer's calls beyond listing, reading and writing (those are in api.ts).
import type { FileJob, FolderSize, SearchEnd, SearchHit, TrashListing, TrashOutcome } from '../../shared/files';
import { req, TAB_ID } from './api';

export const previewUrl = (path: string) => `/api/files/preview?path=${encodeURIComponent(path)}`;

type ItemRef = { trash: string; id: string };

export const filesApi = {
  trash: (paths: string[]) => req<TrashOutcome>('POST', '/api/files/delete', { paths }),
  deleteForGood: (paths: string[]) => req<{ job: FileJob }>('POST', '/api/files/delete', { paths, permanent: true }),
  listTrash: () => req<TrashListing>('GET', '/api/files/trash'),
  restore: (items: ItemRef[]) => req<{ restored: { path: string; as: string }[]; failed: { id: string; error: string }[] }>('POST', '/api/files/trash/restore', { items }),
  deleteFromTrash: (items: ItemRef[]) => req<{ job: FileJob }>('POST', '/api/files/trash/delete', { items }),
  emptyTrash: () => req<{ job: FileJob }>('POST', '/api/files/trash/empty'),
  sizes: (paths: string[]) => req<Record<string, FolderSize>>('POST', '/api/files/size', { paths }),
  transfer: (mode: 'copy' | 'move', paths: string[], to: string) => req<{ moved: number; job: FileJob | null }>('POST', '/api/files/transfer', { mode, paths, to }),
  extract: (path: string) => req<{ job: FileJob }>('POST', '/api/files/extract', { path }),
  compress: (paths: string[], format: 'zip' | 'tar.gz') => req<{ job: FileJob }>('POST', '/api/files/compress', { paths, format }),
  jobs: () => req<FileJob[]>('GET', '/api/files/jobs'),
  cancelJob: (id: string) => req<FileJob[]>('POST', `/api/files/jobs/${encodeURIComponent(id)}/cancel`),
  dismissJob: (id: string) => req<FileJob[]>('POST', `/api/files/jobs/${encodeURIComponent(id)}/dismiss`),
  zipLink: (paths: string[]) => req<{ url: string; name: string }>('POST', '/api/files/zip', { paths }),
  cancelSearch: (id: string) => req('POST', '/api/files/search/cancel', { id }).catch(() => {}),
};

/** Save a zip of these: the server makes a short-lived link, and the browser downloads it like any file. */
export async function downloadZip(paths: string[]): Promise<void> {
  const { url, name } = await filesApi.zipLink(paths);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Search under `dir`, handing each hit to `onHit` as the server finds it. Resolves with how
 * it ended; `signal` stops it (the server is told too, in case the closed request isn't noticed).
 */
export async function searchFiles(dir: string, query: string, mode: 'name' | 'content', onHit: (h: SearchHit) => void, signal: AbortSignal): Promise<SearchEnd> {
  const id = randomId();
  signal.addEventListener('abort', () => filesApi.cancelSearch(id), { once: true });
  let res: Response;
  try {
    res = await fetch('/api/files/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Launchpad-Tab': TAB_ID },
      body: JSON.stringify({ dir, query, mode, id }),
      signal,
    });
  } catch (e) {
    if (signal.aborted) throw e;
    throw new Error('Can’t reach the Launchpad server.');
  }
  if (!res.ok || !res.body) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error || `Search failed (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let end: SearchEnd | null = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const v = JSON.parse(line) as SearchHit | SearchEnd;
      if ('done' in v) end = v;
      else onHit(v);
    }
  }
  if (!end) throw new Error('The search stopped without finishing.');
  return end;
}
