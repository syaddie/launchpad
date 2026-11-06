// Backup and restore of everything you've typed into Launchpad, as one JSON file,
// plus a snapshot of the SQLite database itself. Caches that sync fills again
// (calendar, tasks, mail, news, weather) and the Google sign-in stay out of the JSON.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { cleanCountdowns, cleanMoods, cleanPackages, cleanPrefs, cleanSmokes, cleanWeights, validBookmarks, validNotes } from './clean';
import { snapshotDb, store } from './store';
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
  if (muscles) writes.push(['exerciseMuscles', () => store.setExerciseMuscles(muscles)]);
  if (has('packages') && Array.isArray(b.packages)) {
    const v = cleanPackages(b.packages);
    writes.push(['packages', () => store.setPackages(v)]);
  }

  if (!writes.length) throw new RestoreError('That file isn’t a Launchpad backup.');
  for (const [, write] of writes) write();
  return writes.map(([k]) => k);
}

export class RestoreError extends Error {}

/** Copy the database to a temporary file and hand it over; the file is gone once it's read. */
export function dbSnapshot(): { path: string; size: number; cleanup: () => void } {
  const file = path.join(os.tmpdir(), `launchpad-${randomBytes(6).toString('hex')}.db`);
  snapshotDb(file);
  return { path: file, size: fs.statSync(file).size, cleanup: () => fs.rmSync(file, { force: true }) };
}
