// Notepads: [[links]] between them, tags, search, the images in them and their
// version history. Used by the page and the server.
import type { Note, NoteVersion } from './types';

// ---------- links ----------

const LINK = /\[\[([^\[\]\n]{1,60})\]\]/g;

/** The names a notepad links to with [[Name]], as written. */
export function linksIn(text: string): string[] {
  return [...text.matchAll(LINK)].map((m) => m[1].trim()).filter(Boolean);
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The notepad a [[link]] names, matched ignoring case. */
export const findNote = (notes: Note[], name: string) => notes.find((n) => same(n.name, name));

/** Notepads with a [[link]] to this one, in their order. */
export function backlinks(notes: Note[], to: Note): Note[] {
  if (!to.name.trim()) return [];
  return notes.filter((n) => n.id !== to.id && linksIn(n.text).some((l) => same(l, to.name)));
}

/** Point [[links]] at a notepad's new name. Notepads that don't link to it are returned as they were. */
export function renameLinks(notes: Note[], from: string, to: string): Note[] {
  if (!from.trim() || !to.trim() || from === to) return notes;
  return notes.map((n) => {
    if (!linksIn(n.text).some((l) => same(l, from))) return n;
    return { ...n, text: n.text.replace(LINK, (m, name: string) => (same(name, from) ? `[[${to}]]` : m)) };
  });
}

// ---------- tags and pins ----------

/** Lower case, no "#", letters, numbers and dashes; at most 10 of 24 characters. */
export function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const t of v) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out.slice(0, 10);
}

/** What's typed in the tags box: commas or spaces between them. */
export const parseTags = (s: string) => cleanTags(s.split(/[,\s]+/));

/** Every tag in use, with how many notepads have it, most used first. */
export function allTags(notes: Note[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const n of notes) for (const t of n.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Pinned notepads first; otherwise the order they're saved in. */
export const pinnedFirst = (notes: Note[]) => [...notes.filter((n) => n.pinned), ...notes.filter((n) => !n.pinned)];

// ---------- search ----------

export interface NoteHit {
  note: Note;
  /** Lines that match, at most three, trimmed. */
  lines: string[];
  /** The name or a tag matched. */
  title: boolean;
}

/** Notepads with every word typed in their name, tags or text; ones matching on the name first. */
export function searchNotes(notes: Note[], q: string): NoteHit[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hits: NoteHit[] = [];
  for (const note of notes) {
    const head = `${note.name} ${(note.tags ?? []).map((t) => '#' + t).join(' ')}`.toLowerCase();
    const body = note.text.toLowerCase();
    if (!words.every((w) => head.includes(w) || body.includes(w))) continue;
    const lines = note.text
      .split('\n')
      .filter((l) => words.some((w) => l.toLowerCase().includes(w)))
      .slice(0, 3)
      .map((l) => l.trim().slice(0, 160));
    hits.push({ note, lines, title: words.some((w) => head.includes(w)) });
  }
  return hits.sort((a, b) => Number(b.title) - Number(a.title));
}

// ---------- images ----------

/** Images pasted or dropped into a note sit on a line of their own as ![](/api/note-images/<id>). */
export const NOTE_IMAGE = /!\[([^\]\n]*)\]\(\/api\/note-images\/([A-Za-z0-9_-]{16})\)/g;

export const imageMarkdown = (id: string) => `![](/api/note-images/${id})`;

/** Ids of the images some text shows. */
export function imageIds(text: string): string[] {
  return [...text.matchAll(NOTE_IMAGE)].map((m) => m[2]);
}

// ---------- history ----------

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** One version an hour for a day, then one a day for a month. */
export const HISTORY_HOURLY = DAY;
export const HISTORY_KEPT = 30 * DAY;

/** The day a time falls on, in Singapore (where the dashboard is used). */
const dayOf = (at: string) => new Date(Date.parse(at) + 8 * HOUR).toISOString().slice(0, 10);

/**
 * Thin a notepad's versions, newest first: every one from the last day (they're an hour
 * apart at least), then the newest of each day for a month. Older ones go.
 */
export function thinHistory(list: NoteVersion[], now = Date.now()): NoteVersion[] {
  const days = new Set<string>();
  return [...list]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((v) => {
      const age = now - Date.parse(v.at);
      if (Number.isNaN(age) || age >= HISTORY_KEPT) return false;
      if (age < HISTORY_HOURLY) return true;
      const d = dayOf(v.at);
      if (days.has(d)) return false;
      days.add(d);
      return true;
    })
    .slice(0, 80);
}

/**
 * The versions to keep after a save: each notepad that changed gets its earlier text as a
 * version, unless it already got one in the last hour (or that's what its newest version holds).
 * Returns null when nothing needs writing.
 */
export function addVersions(history: Record<string, NoteVersion[]>, prev: Note[], next: Note[], now = Date.now(), force = false): Record<string, NoteVersion[]> | null {
  let changed = false;
  const out = { ...history };
  const at = new Date(now).toISOString();
  for (const p of prev) {
    const n = next.find((x) => x.id === p.id);
    if (!force && (!n || (n.text === p.text && n.name === p.name))) continue;
    const list = out[p.id] ?? [];
    const last = list[0];
    if (last && last.text === p.text && last.name === p.name) continue;
    // Most of a long note cut at once is kept straight away, in case it was a slip.
    const bigCut = !!n && p.text.length > 200 && n.text.length < p.text.length / 2;
    if (!force && !bigCut && last && now - Date.parse(last.at) < HOUR) continue;
    out[p.id] = thinHistory([{ at, name: p.name, text: p.text }, ...list], now);
    changed = true;
  }
  return changed ? out : null;
}

/** Versions as the store keeps them; anything malformed is dropped. */
export function cleanHistory(v: unknown, now = Date.now()): Record<string, NoteVersion[]> {
  const out: Record<string, NoteVersion[]> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [id, list] of Object.entries(v as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const ok = list.filter((x): x is NoteVersion => !!x && typeof x.at === 'string' && typeof x.name === 'string' && typeof x.text === 'string');
    const kept = thinHistory(ok.map((x) => ({ at: x.at, name: x.name.slice(0, 200), text: x.text })), now);
    if (kept.length) out[id.slice(0, 80)] = kept;
  }
  return out;
}
