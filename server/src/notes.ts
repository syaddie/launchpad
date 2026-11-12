// Notepads on the server: the images pasted into them, kept in DATA_DIR/note-images
// like photos, and earlier versions of each, kept in the "noteHistory" document.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { sniffImage } from './photos';
import { store } from './store';
import { addVersions, imageIds } from '../../shared/notes';
import type { Note, NoteVersion } from '../../shared/types';

// ---------- images ----------

/** The page shrinks big images before uploading, so this only stops runaway files. */
export const MAX_NOTE_IMAGE = 10 * 1024 * 1024;
/** An image no note (or earlier version) shows any more is left a week, in case it's put back. */
export const IMAGE_GRACE = 7 * 86_400_000;

const dir = path.join(config.dataDir, 'note-images');
fs.mkdirSync(dir, { recursive: true });

/** Ids are made here, so anything else is not an image (and never reaches the file system). */
export const validImageId = (id: string) => /^[A-Za-z0-9_-]{16}$/.test(id);

export function writeNoteImage(bytes: Uint8Array): string {
  const id = randomBytes(12).toString('base64url');
  fs.writeFileSync(path.join(dir, id), bytes);
  return id;
}

export function readNoteImage(id: string): { bytes: Buffer; mime: string } | null {
  if (!validImageId(id)) return null;
  try {
    const bytes = fs.readFileSync(path.join(dir, id));
    const mime = sniffImage(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

export const noteImageExists = (id: string) => validImageId(id) && fs.existsSync(path.join(dir, id));

/** Put back an image from a backup under its own id. Leaves one that's already there alone. */
export function restoreNoteImage(id: string, bytes: Uint8Array): boolean {
  if (!validImageId(id) || bytes.length > MAX_NOTE_IMAGE || !sniffImage(bytes)) return false;
  if (!noteImageExists(id)) fs.writeFileSync(path.join(dir, id), bytes);
  return true;
}

/** Every image a notepad or one of its earlier versions shows. */
export function usedImages(notes = store.notes(), history = store.noteHistory()): Set<string> {
  const used = new Set<string>();
  for (const n of notes) for (const id of imageIds(n.text)) used.add(id);
  for (const list of Object.values(history)) for (const v of list) for (const id of imageIds(v.text)) used.add(id);
  return used;
}

/**
 * Tidy the image folder. An image still in use has its file touched, so the file's time
 * says when it was last seen in use; one unused for a week since (or a week since it was
 * uploaded, if it never was) is removed. Returns how many went.
 */
export function sweepNoteImages(used: Set<string>, now = Date.now(), folder = dir): number {
  let removed = 0;
  const when = new Date(now);
  for (const f of fs.readdirSync(folder)) {
    if (!validImageId(f)) continue;
    const p = path.join(folder, f);
    try {
      if (used.has(f)) fs.utimesSync(p, when, when);
      else if (now - fs.statSync(p).mtimeMs >= IMAGE_GRACE) {
        fs.rmSync(p, { force: true });
        removed++;
      }
    } catch {
      // Gone already.
    }
  }
  return removed;
}

/** Ids of every image file kept, for the .zip backup. */
export function noteImageFiles(): string[] {
  try {
    return fs.readdirSync(dir).filter(validImageId);
  } catch {
    return [];
  }
}

// ---------- history ----------

/** When each notepad last got a version, so a save only reads the history when one may be due. */
let lastVersion: Map<string, number> | null = null;

/**
 * Keep earlier versions as notes are saved (see addVersions): at most one an hour per
 * notepad, thinned to one a day after a day and gone after a month.
 */
export function recordVersions(prev: Note[], next: Note[], now = Date.now()): void {
  if (!lastVersion) lastVersion = new Map(Object.entries(store.noteHistory()).map(([id, l]) => [id, Date.parse(l[0]?.at ?? '') || 0]));
  const due = prev.some((p) => {
    const n = next.find((x) => x.id === p.id);
    if (!n || (n.text === p.text && n.name === p.name)) return false;
    const bigCut = p.text.length > 200 && n.text.length < p.text.length / 2;
    return bigCut || now - (lastVersion!.get(p.id) ?? 0) >= 3_600_000;
  });
  if (!due) return;
  const history = store.noteHistory();
  // Versions of notepads deleted over a month ago go too.
  const ids = new Set(next.map((n) => n.id));
  for (const id of Object.keys(history)) if (!ids.has(id) && now - Date.parse(history[id][0]?.at ?? '') > 30 * 86_400_000) delete history[id];
  const out = addVersions(history, prev, next, now);
  if (!out) return;
  store.setNoteHistory(out);
  for (const [id, l] of Object.entries(out)) lastVersion.set(id, Date.parse(l[0]?.at ?? '') || 0);
}

/** Keep a notepad's current text as a version now (before a restore replaces it). */
export function keepVersion(id: string, now = Date.now()): NoteVersion[] {
  const note = store.notes().find((n) => n.id === id);
  const history = store.noteHistory();
  if (note) {
    const out = addVersions(history, [note], [note], now, true);
    if (out) {
      store.setNoteHistory(out);
      lastVersion?.set(id, now);
      return out[id] ?? [];
    }
  }
  return history[id] ?? [];
}

/** Forget what's remembered about the history, after a restore replaced it. */
export function historyRestored(): void {
  lastVersion = null;
}
