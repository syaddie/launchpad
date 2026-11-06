// Three-way merge for the documents the page saves whole (notes, bookmarks, money,
// learn). When two devices edit the same document, the server refuses the second
// save; the page then merges its edits with the other device's, starting from the
// copy both began with, and saves the result.
//
// Lists of things with ids merge item by item, objects field by field. Only when
// both sides changed the very same value does one have to win: this device's.
import type { Note } from './types';

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasIds = (v: unknown): v is { id: string }[] => Array.isArray(v) && v.every((x) => isObj(x) && typeof x.id === 'string');

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

export interface Merged<T> {
  value: T;
  /** Values both sides changed differently, where this device's change was kept. */
  conflicts: number;
}

export function merge3<T>(base: T | undefined, mine: T, theirs: T): Merged<T> {
  const c = { n: 0 };
  return { value: merge(base, mine, theirs, c) as T, conflicts: c.n };
}

function merge(base: unknown, mine: unknown, theirs: unknown, c: { n: number }): unknown {
  if (deepEqual(mine, theirs)) return mine;
  if (deepEqual(base, mine)) return theirs;
  if (deepEqual(base, theirs)) return mine;
  if (isObj(mine) && isObj(theirs)) {
    const b = isObj(base) ? base : {};
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
      const v = merge(b[k], mine[k], theirs[k], c);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  if (hasIds(mine) && hasIds(theirs) && (base === undefined || hasIds(base))) return mergeById(base ?? [], mine, theirs, c);
  c.n++;
  return mine;
}

function mergeById(base: { id: string }[], mine: { id: string }[], theirs: { id: string }[], c: { n: number }): { id: string }[] {
  const b = new Map(base.map((x) => [x.id, x]));
  const t = new Map(theirs.map((x) => [x.id, x]));
  const m = new Map(mine.map((x) => [x.id, x]));
  const out: { id: string }[] = [];
  for (const x of mine) {
    const was = b.get(x.id);
    const other = t.get(x.id);
    if (other) out.push(merge(was, x, other, c) as { id: string });
    // They deleted it: gone, unless this device changed it since.
    else if (was && deepEqual(was, x)) continue;
    else out.push(x);
  }
  // What they added, or changed after this device deleted it, goes after the item it follows on their side.
  theirs.forEach((x, i) => {
    if (m.has(x.id)) return;
    const was = b.get(x.id);
    if (was && deepEqual(was, x)) return;
    const prev = theirs.slice(0, i).reverse().find((p) => out.some((o) => o.id === p.id));
    const at = prev ? out.findIndex((o) => o.id === prev.id) + 1 : 0;
    out.splice(at, 0, x);
  });
  return out;
}

/**
 * Notes merge like the rest, except when both devices rewrote the same notepad's text:
 * then this device's text stays, and the other device's is kept as a copy beside it.
 */
export function mergeNotes(base: Note[] | undefined, mine: Note[], theirs: Note[], now = Date.now()): Merged<Note[]> & { copies: number } {
  const b = new Map((base ?? []).map((n) => [n.id, n]));
  const copies: Note[] = [];
  for (const other of theirs) {
    const was = b.get(other.id);
    const own = mine.find((n) => n.id === other.id);
    if (own && was && own.text !== was.text && other.text !== was.text && own.text !== other.text) {
      copies.push({ ...other, id: `${other.id}-c${now.toString(36)}`, name: `${other.name} (other device)`.slice(0, 60) });
    }
  }
  const merged = merge3(base, mine, theirs);
  for (const copy of copies) {
    const at = merged.value.findIndex((n) => copy.id.startsWith(n.id + '-c'));
    merged.value.splice(at + 1, 0, copy);
  }
  // The text conflicts are settled by the copies, so they aren't reported as lost.
  return { value: merged.value, conflicts: Math.max(0, merged.conflicts - copies.length), copies: copies.length };
}
