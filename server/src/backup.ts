// Backup and restore of everything you've typed into Launchpad, as one JSON file,
// plus a snapshot of the SQLite database itself. Caches that sync fills again
// (calendar, tasks, mail, news, weather) and the Google sign-in stay out of the JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanCountdowns, cleanMoods, cleanPackages, cleanPrefs, cleanSmokes, cleanSnippets, cleanWeights, validBookmarks, validNotes } from './clean';
import { MAX_PHOTOS, photoExists, readPhoto, restorePhotoFile, sniffImage, type StoredPhoto } from './photos';
import { snapshotDb, store } from './store';
import { isZip, unzip, zipStream, type ZipEntry } from './zip';
import { cleanLearn } from '../../shared/learn';
import { cleanMoney } from '../../shared/money';
import { MUSCLES, cleanTraining } from '../../shared/training';
import type { Backup, BackupPart, ExerciseMuscles, Muscle, Prefs } from '../../shared/types';

export function exportBackup(): Backup {
  return {
    version: 2,
    exported: new Date().toISOString(),
    bookmarks: store.bookmarks(),
    notes: store.notes(),
    prefs: store.prefs(),
    countdowns: store.countdowns(),
    smokes: store.smokes(),
    moods: store.moods(),
    weights: store.weights(),
    money: store.money(),
    learn: store.learn(),
    training: store.training(),
    exerciseMuscles: store.exerciseMuscles(),
    packages: store.packages(),
    photos: store.photos(),
    snippets: store.snippets(),
  };
}

/** What each part of a backup is called on the page. */
export const PART_NAMES: Record<BackupPart, string> = {
  bookmarks: 'bookmarks',
  notes: 'notepads',
  prefs: 'settings',
  countdowns: 'countdowns',
  smokes: 'cigarette log',
  moods: 'moods',
  weights: 'weights',
  money: 'money tracker',
  learn: 'courses and study time',
  training: 'workouts',
  exerciseMuscles: 'exercise muscles',
  packages: 'packages',
  photos: 'photos',
  snippets: 'terminal snippets',
};

function cleanMuscles(v: unknown): Record<string, ExerciseMuscles> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, ExerciseMuscles> = {};
  for (const [name, m] of Object.entries(v as Record<string, Partial<ExerciseMuscles>>)) {
    if (!m || !MUSCLES.includes(m.primary as Muscle)) continue;
    const secondary = Array.isArray(m.secondary) ? m.secondary.filter((x) => MUSCLES.includes(x) && x !== m.primary) : [];
    out[name.slice(0, 120)] = { primary: m.primary as Muscle, secondary: [...new Set(secondary)] };
  }
  return out;
}

/**
 * Put back each part the file has; parts it doesn't have are left as they are, so an
 * old bookmarks-and-notes backup (version 1) restores just those. Each part goes through
 * the same checks as a normal save. Returns the parts restored, or throws when there are none.
 */
export function restoreBackup(body: unknown): BackupPart[] {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RestoreError('That file isn’t a Launchpad backup.');
  const b = body as Record<string, unknown>;
  if (b.version !== 1 && b.version !== 2) throw new RestoreError('That backup is from a version of Launchpad this one can’t read.');

  // Check every part first, then write them all, so a bad part doesn't leave a half-restored store.
  const writes: [BackupPart, () => void][] = [];
  const has = (k: BackupPart) => k in b && b[k] !== undefined && b[k] !== null;
  if (has('bookmarks') && validBookmarks(b.bookmarks)) writes.push(['bookmarks', () => store.setBookmarks(b.bookmarks as never)]);
  if (has('notes') && validNotes(b.notes)) writes.push(['notes', () => store.setNotes(b.notes as never)]);
  if (has('prefs') && typeof b.prefs === 'object') {
    const prefs = cleanPrefs(b.prefs as Partial<Prefs>, store.prefs());
    writes.push(['prefs', () => store.setPrefs(prefs)]);
  }
  if (has('countdowns') && Array.isArray(b.countdowns)) {
    const v = cleanCountdowns(b.countdowns);
    writes.push(['countdowns', () => store.setCountdowns(v)]);
  }
  if (has('smokes') && Array.isArray(b.smokes)) {
    const v = cleanSmokes(b.smokes);
    writes.push(['smokes', () => store.setSmokes(v)]);
  }
  if (has('moods') && typeof b.moods === 'object') {
    const v = cleanMoods(b.moods);
    writes.push(['moods', () => store.setMoods(v)]);
  }
  if (has('weights') && typeof b.weights === 'object') {
    const v = cleanWeights(b.weights);
    writes.push(['weights', () => store.setWeights(v)]);
  }
  if (has('money') && Array.isArray((b.money as { entries?: unknown }).entries)) {
    const v = cleanMoney(b.money);
    writes.push(['money', () => store.setMoney(v)]);
  }
  if (has('learn') && Array.isArray((b.learn as { courses?: unknown }).courses)) {
    const v = cleanLearn(b.learn);
    writes.push(['learn', () => store.setLearn(v)]);
  }
  if (has('training') && Array.isArray((b.training as { workouts?: unknown }).workouts)) {
    const v = cleanTraining(b.training);
    writes.push(['training', () => store.setTraining(v)]);
  }
  const muscles = has('exerciseMuscles') ? cleanMuscles(b.exerciseMuscles) : null;
  // Merged, not replaced: labels Claude wrote since the backup are still right.
  if (muscles) writes.push(['exerciseMuscles', () => store.setExerciseMuscles({ ...store.exerciseMuscles(), ...muscles })]);
  if (has('packages') && Array.isArray(b.packages)) {
    const v = cleanPackages(b.packages);
    writes.push(['packages', () => store.setPackages(v)]);
  }

  if (has('photos') && Array.isArray(b.photos)) {
    const v = cleanPhotos(b.photos);
    writes.push(['photos', () => store.setPhotos(v)]);
  }

  if (has('snippets') && Array.isArray(b.snippets)) {
    const v = cleanSnippets(b.snippets);
    writes.push(['snippets', () => store.setSnippets(v)]);
  }

  if (!writes.length) throw new RestoreError('That file isn’t a Launchpad backup.');
  for (const [, write] of writes) write();
  return writes.map(([k]) => k);
}

export class RestoreError extends Error {}

/**
 * The photo list from a backup, keeping only photos whose file is here (put back from a
 * .zip, or never removed). Files of photos left off the list aren't deleted: the weekly
 * cleanup does that, so undoing the restore within a week brings them back.
 */
function cleanPhotos(v: unknown[]): StoredPhoto[] {
  const ids = new Set<string>();
  const clamp = (n: unknown, d: number) => (typeof n === 'number' && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : d);
  return (v as Partial<StoredPhoto>[]).flatMap((p) => {
    if (!p || typeof p.id !== 'string' || ids.has(p.id) || !photoExists(p.id)) return [];
    const mime = sniffImage(new Uint8Array(readPhoto(p.id) ?? []));
    if (!mime) return [];
    ids.add(p.id);
    return [{ id: p.id, mime, focus: { x: clamp(p.focus?.x, 50), y: clamp(p.focus?.y, 30) } }];
  }).slice(0, MAX_PHOTOS);
}

const ZIP_JSON = 'launchpad-backup.json';

/** The backup and every photo file, as a .zip. */
export function zipBackup(): ReadableStream<Uint8Array> {
  const backup = exportBackup();
  const entries: ZipEntry[] = [{ name: ZIP_JSON, data: () => Buffer.from(JSON.stringify(backup, null, 2)) }];
  for (const p of backup.photos ?? []) {
    if (photoExists(p.id)) entries.push({ name: `photos/${p.id}`, data: () => readPhoto(p.id) ?? Buffer.alloc(0) });
  }
  return zipStream(entries);
}

/**
 * A backup file as it was uploaded: the JSON itself, or a .zip holding it and the photos.
 * The zip's photo files are written first (never over one that's there), so the restore keeps them listed.
 */
export function readBackupUpload(bytes: Buffer): unknown {
  if (!isZip(bytes)) {
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new RestoreError('That file isn’t a Launchpad backup.');
    }
  }
  let files: Map<string, Buffer>;
  try {
    files = unzip(bytes);
  } catch (e) {
    throw new RestoreError((e as Error).message);
  }
  // Re-zipped by hand, it may sit in a folder; macOS adds a __MACOSX folder of its own.
  const names = [...files.keys()].filter((n) => !n.startsWith('__MACOSX/'));
  const json = names.find((n) => n === ZIP_JSON || n.endsWith('/' + ZIP_JSON));
  if (!json) throw new RestoreError('That .zip has no launchpad-backup.json in it.');
  let body: unknown;
  try {
    body = JSON.parse(files.get(json)!.toString('utf8'));
  } catch {
    throw new RestoreError('The backup inside that .zip is damaged.');
  }
  for (const n of names) {
    const m = /(?:^|\/)photos\/([A-Za-z0-9_-]{16})$/.exec(n);
    if (m) restorePhotoFile(m[1], files.get(n)!);
  }
  return body;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** What each restored part now holds, for the page: "3 countdowns", "money tracker (120 entries)". Empty ones are left out. */
export function describeRestored(parts: BackupPart[]): string[] {
  const all = parts.map((p) => {
    switch (p) {
      case 'bookmarks': return plural(store.bookmarks().length, 'bookmark group');
      case 'notes': return plural(store.notes().length, 'notepad');
      case 'countdowns': return plural(store.countdowns().length, 'countdown');
      case 'smokes': return plural(store.smokes().length, 'logged cigarette');
      case 'moods': return plural(Object.keys(store.moods()).length, 'mood');
      case 'weights': return plural(Object.keys(store.weights()).length, 'weight');
      case 'money': return `money tracker (${plural(store.money().entries.length, 'entry', 'entries')})`;
      case 'learn': return plural(store.learn().courses.length, 'course');
      case 'training': return plural(store.training().workouts.length, 'workout');
      case 'packages': return plural(store.packages().length, 'package');
      case 'photos': return plural(store.photos().length, 'photo');
      case 'snippets': return plural(store.snippets().length, 'terminal snippet');
      default: return PART_NAMES[p];
    }
  });
  const some = all.filter((l) => !/^0 |\(0 entries\)/.test(l));
  return some.length ? some : all.slice(0, 1);
}

/** Copy the database to a temporary file and hand it over; the file is gone once it's read. */
export function dbSnapshot(): { path: string; size: number; cleanup: () => void } {
  const file = path.join(os.tmpdir(), `launchpad-${randomBytes(6).toString('hex')}.db`);
  snapshotDb(file);
  return { path: file, size: fs.statSync(file).size, cleanup: () => fs.rmSync(file, { force: true }) };
}
