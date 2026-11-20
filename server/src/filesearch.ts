// Searching under a folder on the server: names with find, contents with grep (or
// ripgrep, when it's installed). Results stream to the page as they're found, up to
// SEARCH_LIMIT, for at most SEARCH_SECONDS, and the page can stop a search early.
import { FileError, shellQuote } from './shell';
import { runRemote } from './remote';
import { hostTools } from './archive';
import { SEARCH_LIMIT, SEARCH_MAX_FILE_MB, SEARCH_SECONDS, type SearchEnd, type SearchHit } from '../../shared/files';

export type SearchMode = 'name' | 'content';

/** The kernel's own folders, which a search from / would otherwise wander into. */
const PRUNE = `\\( -path /proc -o -path /sys -o -path /dev -o -path /run \\) -prune -o`;

/** A query as a literal find -iname pattern: wildcards in it match themselves. */
export const globEscape = (s: string) => s.replace(/[\\*?[\]]/g, '\\$&');

export function cleanQuery(q: unknown): string {
  const s = typeof q === 'string' ? q.trim() : '';
  if (!s) throw new FileError('Type something to search for.');
  if (s.length > 200 || s.includes('\0') || /[\r\n]/.test(s)) throw new FileError('That search is too long.');
  return s;
}

export function nameCommand(dir: string, query: string): string {
  return `find ${shellQuote(dir)} -mindepth 1 ${PRUNE} -iname ${shellQuote(`*${globEscape(query)}*`)} -printf '%Y %s %p\\0' 2>/dev/null`;
}

export function contentCommand(dir: string, query: string, rg: boolean): string {
  if (rg) {
    return `rg --null --line-number --max-count 1 --ignore-case --fixed-strings --no-heading --with-filename --hidden --no-ignore --max-filesize ${SEARCH_MAX_FILE_MB}M --no-messages --color never -e ${shellQuote(query)} -- ${shellQuote(dir)}`;
  }
  return `find ${shellQuote(dir)} ${PRUNE} -type f -size -${SEARCH_MAX_FILE_MB}M -print0 2>/dev/null | xargs -0 -r grep -I -i -F -n -m 1 -Z -H -e ${shellQuote(query)} -- 2>/dev/null`;
}

const kindOfType = (t: string): SearchHit['kind'] => (t === 'd' ? 'dir' : t === 'f' ? 'file' : 'other');

/** Hits from find's `%Y %s %p\0` records in `buf`, and the bytes after the last whole one. */
export function parseNames(buf: Buffer): { hits: SearchHit[]; rest: Buffer } {
  const hits: SearchHit[] = [];
  let start = 0;
  for (let i = buf.indexOf(0); i >= 0; i = buf.indexOf(0, start)) {
    const rec = buf.subarray(start, i).toString('utf8');
    start = i + 1;
    const m = /^(\S) (\d+) (\/.*)$/s.exec(rec);
    if (m) hits.push({ path: m[3], kind: kindOfType(m[1]), size: m[1] === 'f' ? Number(m[2]) : undefined });
  }
  return { hits, rest: buf.subarray(start) };
}

/** Longest line kept from a contents match; the rest of the line is dropped. */
const MAX_TEXT = 240;
/** A line still unfinished past this is given up on rather than held. */
const MAX_PENDING = 256 * 1024;

/** Hits from grep -Z -n / rg --null records ("path\0line:text\n") in `buf`, and what's left over. */
export function parseContents(buf: Buffer): { hits: SearchHit[]; rest: Buffer } {
  const hits: SearchHit[] = [];
  let start = 0;
  for (;;) {
    const z = buf.indexOf(0, start);
    if (z < 0) break;
    const nl = buf.indexOf(10, z + 1);
    if (nl < 0) {
      // A very long line: keep the start of it and skip ahead once it ends.
      if (buf.length - z > MAX_PENDING) {
        const path = buf.subarray(start, z).toString('utf8');
        const head = buf.subarray(z + 1, z + 1 + 4096).toString('utf8');
        const m = /^(\d+):(.*)$/s.exec(head);
        if (m) hits.push({ path, kind: 'file', line: Number(m[1]), text: m[2].slice(0, MAX_TEXT) });
        return { hits, rest: Buffer.from([0xff]) };
      }
      break;
    }
    const path = buf.subarray(start, z).toString('utf8');
    const m = /^(\d+):(.*)$/s.exec(buf.subarray(z + 1, Math.min(nl, z + 1 + 4096)).toString('utf8'));
    start = nl + 1;
    if (m && path.startsWith('/')) hits.push({ path, kind: 'file', line: Number(m[1]), text: m[2].replace(/\r$/, '').trim().slice(0, MAX_TEXT) });
  }
  return { hits, rest: buf.subarray(start) };
}

const running = new Map<string, () => void>();

/** Stop a search the page started, by the id it gave. */
export function cancelSearch(id: string): void {
  running.get(id)?.();
}

/**
 * Search `dir`, calling `onHit` for each result as it's found. Resolves with how it
 * ended. `id` lets cancelSearch stop it; so does `signal`.
 */
export async function searchFiles(dir: string, query: string, mode: SearchMode, onHit: (h: SearchHit) => void, opts: { id?: string; signal?: AbortSignal } = {}): Promise<SearchEnd> {
  if (mode === 'content' && ['/', '/proc', '/sys', '/dev'].includes(dir)) throw new FileError('Pick a folder to search the contents of. The whole disk would take far too long.');
  const rg = mode === 'content' && (await hostTools()).has('rg');
  const tool: SearchEnd['tool'] = mode === 'name' ? 'find' : rg ? 'rg' : 'grep';
  const cmd = mode === 'name' ? nameCommand(dir, query) : contentCommand(dir, query, rg);
  let count = 0;
  let pending: Buffer = Buffer.alloc(0);
  // A line given up on: what comes until its end is skipped.
  let skipping = false;
  const parse = mode === 'name' ? parseNames : parseContents;
  const run = runRemote(cmd, {
    timeout: SEARCH_SECONDS * 1000,
    signal: opts.signal,
    onData: (d) => {
      let buf = Buffer.concat([pending, d]);
      if (skipping) {
        const nl = buf.indexOf(10);
        if (nl < 0) {
          pending = Buffer.alloc(0);
          return;
        }
        buf = buf.subarray(nl + 1);
        skipping = false;
      }
      const { hits, rest } = parse(buf);
      if (rest.length === 1 && rest[0] === 0xff) {
        skipping = true;
        pending = Buffer.alloc(0);
      } else pending = rest.length > MAX_PENDING * 2 ? Buffer.alloc(0) : Buffer.from(rest);
      for (const h of hits) {
        if (count >= SEARCH_LIMIT) return true;
        count++;
        onHit(h);
      }
      return count >= SEARCH_LIMIT;
    },
  });
  if (opts.id) running.set(opts.id, () => run.stop('cancel'));
  try {
    const r = await run.done;
    const error = !r.stopped && r.code && r.code > 1 && !count && r.stderr ? r.stderr.split('\n')[0] : undefined;
    return { done: true, count, more: r.stopped === 'limit', timedOut: r.stopped === 'timeout', tool, error };
  } finally {
    if (opts.id) running.delete(opts.id);
  }
}
