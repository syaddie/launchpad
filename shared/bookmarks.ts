// Bookmark helpers both sides use: ranking by how often and how lately each is opened,
// and reading a browser's bookmark export (the Netscape HTML every browser writes).
import type { Bookmark, BookmarkGroup, BookmarkOpens, OpenCount } from './types';

/** An open counts half as much after two weeks, a quarter after four. */
export const OPEN_HALF_LIFE = 14 * 86_400_000;

const decay = (o: OpenCount, now: number) => o.score * 0.5 ** (Math.max(0, now - Date.parse(o.last)) / OPEN_HALF_LIFE);

/** The count after one more open now. */
export function bumpOpen(prev: OpenCount | undefined, now = Date.now()): OpenCount {
  return { score: Math.round(((prev ? decay(prev, now) : 0) + 1) * 1000) / 1000, last: new Date(now).toISOString(), n: (prev?.n ?? 0) + 1 };
}

/** How often and how lately it's been opened, as one number: each open is 1, fading by half every two weeks. */
export function frecency(o: OpenCount | undefined, now = Date.now()): number {
  return o && Number.isFinite(o.score) && !Number.isNaN(Date.parse(o.last)) ? decay(o, now) : 0;
}

/**
 * The most opened first. Ties (most bookmarks, never opened) keep their order, except that
 * a name starting with what's typed goes ahead of one that only contains it.
 */
export function rankBookmarks<T extends Bookmark>(list: T[], opens: BookmarkOpens | undefined, q = '', now = Date.now()): T[] {
  const lq = q.trim().toLowerCase();
  const starts = (b: T) => (lq && b.name.toLowerCase().startsWith(lq) ? 1 : 0);
  return list
    .map((b, i) => ({ b, i, f: frecency(opens?.[b.id], now), s: starts(b) }))
    .sort((x, y) => y.f - x.f || y.s - x.s || x.i - y.i)
    .map((x) => x.b);
}

/** The counts kept: only for bookmarks that still exist, and only sane ones. */
export function cleanOpens(v: unknown, ids?: Set<string>): BookmarkOpens {
  const out: BookmarkOpens = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, o] of Object.entries(v as Record<string, Partial<OpenCount>>)) {
    if (ids && !ids.has(id)) continue;
    if (!o || typeof o.score !== 'number' || !Number.isFinite(o.score) || o.score < 0 || typeof o.last !== 'string' || Number.isNaN(Date.parse(o.last))) continue;
    out[id.slice(0, 80)] = { score: Math.min(o.score, 10_000), last: o.last, n: typeof o.n === 'number' && o.n > 0 ? Math.floor(o.n) : 1 };
  }
  return out;
}

// ---------- importing a browser's bookmarks ----------

export interface ImportFolder {
  /** Folder names from the top, e.g. ["Bookmarks bar", "Dev"]; empty for links outside any folder. */
  path: string[];
  items: { name: string; url: string }[];
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const unescape = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Every folder in a bookmark export with the links directly in it, in the order they appear.
 * Links outside any folder come first, with an empty path. Only http(s) links are kept.
 */
export function parseBookmarkHtml(html: string): ImportFolder[] {
  const folders: ImportFolder[] = [];
  const top: ImportFolder = { path: [], items: [] };
  const stack: ImportFolder[] = [];
  let pending: string | null = null;
  let depth = 0;
  const token = /<h3\b[^>]*>([\s\S]*?)<\/h3>|<dl\b[^>]*>|<\/dl>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(token)) {
    const t = m[0].slice(0, 3).toLowerCase();
    if (t === '<h3') pending = unescape(m[1]) || 'Untitled folder';
    else if (t === '<dl') {
      depth++;
      // The outermost list is the export itself, not a folder.
      if (pending !== null) {
        const parent = stack[stack.length - 1];
        const f: ImportFolder = { path: [...(parent?.path ?? []), pending], items: [] };
        folders.push(f);
        stack.push(f);
      } else if (depth > 1) stack.push(stack[stack.length - 1] ?? top);
      pending = null;
    } else if (t === '</d') {
      if (depth > 1) stack.pop();
      depth = Math.max(0, depth - 1);
    } else {
      const href = m[2].match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = href ? unescape(href[2] ?? href[3] ?? href[4] ?? '') : '';
      if (!/^https?:\/\//i.test(url) || url.length > 2000) continue;
      const name = unescape(m[3]).slice(0, 60) || url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/.*$/, '');
      (stack[stack.length - 1] ?? top).items.push({ name, url });
    }
  }
  return [...(top.items.length ? [top] : []), ...folders];
}

/** Same bookmark, give or take http vs https, "www.", a trailing slash and the fragment. */
export function bookmarkKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.port ? ':' + u.port : ''}${u.pathname.replace(/\/+$/, '')}${u.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

/**
 * Add the chosen folders as groups: each becomes a group named after it, or adds to the group
 * that already has its name. Links already among the bookmarks (or twice in the export) are skipped.
 */
export function importFolders(groups: BookmarkGroup[], folders: ImportFolder[], chosen: number[], makeId: (prefix: string) => string, topName = 'Imported'): { groups: BookmarkGroup[]; added: number; skipped: number } {
  const seen = new Set(groups.flatMap((g) => g.items.map((b) => bookmarkKey(b.url))));
  const next = groups.map((g) => ({ ...g, items: [...g.items] }));
  let added = 0;
  let skipped = 0;
  for (const i of chosen) {
    const f = folders[i];
    if (!f) continue;
    const name = (f.path[f.path.length - 1] ?? topName).slice(0, 40);
    const fresh = f.items.filter((b) => {
      const k = bookmarkKey(b.url);
      if (seen.has(k)) {
        skipped++;
        return false;
      }
      seen.add(k);
      return true;
    });
    if (!fresh.length) continue;
    added += fresh.length;
    const items = fresh.map((b) => ({ id: makeId('b'), name: b.name, url: b.url }));
    const into = next.find((g) => g.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (into) into.items.push(...items);
    else next.push({ id: makeId('g'), name, items });
  }
  return { groups: next, added, skipped };
}

/** How many of a folder's links are new, given the bookmarks there are. */
export function newInFolder(groups: BookmarkGroup[], f: ImportFolder): number {
  const seen = new Set(groups.flatMap((g) => g.items.map((b) => bookmarkKey(b.url))));
  let n = 0;
  for (const b of f.items) {
    const k = bookmarkKey(b.url);
    if (!seen.has(k)) n++;
    seen.add(k);
  }
  return n;
}
