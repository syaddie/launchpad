// Copies of the database Launchpad takes by itself, in DATA_DIR/backups: one a
// day (the last 14 kept), one just before any restore (so it can be undone), and
// one whenever asked from Settings. Putting one back restores what you've entered
// from it, through the same path as a backup file, so it can be undone in turn.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config';
import { snapshotDb } from './store';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import { cleanLearn } from '../../shared/learn';
import { cleanMoney } from '../../shared/money';
import { cleanTraining } from '../../shared/training';
import type { Backup, BackupSnapshot } from '../../shared/types';

const dir = path.join(config.dataDir, 'backups');
const KEEP: Record<BackupSnapshot['reason'], number> = { daily: 14, 'before-restore': 10, manual: 10 };
const ID = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(daily|before-restore|manual)$/;
const DAY = 86_400_000;

/** "2026-11-06T07-31-36-968Z-daily" ⇄ its time and reason. Ids double as file names, so no colons. */
export const snapshotId = (at: Date, reason: BackupSnapshot['reason']) => `${at.toISOString().replace(/[:.]/g, '-')}-${reason}`;
export function parseSnapshotId(id: string): { at: string; reason: BackupSnapshot['reason'] } | null {
  const m = ID.exec(id);
  return m ? { at: `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`, reason: m[6] as BackupSnapshot['reason'] } : null;
}

/** Newest first. */
export function listSnapshots(): BackupSnapshot[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.db'))
    .flatMap((n) => {
      const id = n.slice(0, -3);
      const p = parseSnapshotId(id);
      if (!p) return [];
      try {
        return [{ id, ...p, size: fs.statSync(path.join(dir, n)).size }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The file of a snapshot, or null for an id that isn't one. */
export function snapshotFile(id: string): string | null {
  if (!parseSnapshotId(id)) return null;
  const file = path.join(dir, id + '.db');
  return fs.existsSync(file) ? file : null;
}

export function takeSnapshot(reason: BackupSnapshot['reason'], now = new Date()): BackupSnapshot {
  fs.mkdirSync(dir, { recursive: true });
  const id = snapshotId(now, reason);
  const file = path.join(dir, id + '.db');
  snapshotDb(file);
  prune(reason);
  return { id, at: now.toISOString(), reason, size: fs.statSync(file).size };
}

/** Keep the newest few of each kind. */
function prune(reason: BackupSnapshot['reason']): void {
  for (const s of listSnapshots().filter((x) => x.reason === reason).slice(KEEP[reason])) removeSnapshot(s.id);
}

export function removeSnapshot(id: string): void {
  const file = snapshotFile(id);
  if (file) fs.rmSync(file, { force: true });
}

/**
 * What you'd entered when the snapshot was taken, as a backup to restore. A document that
 * didn't exist yet comes back as it starts out, so putting back an older copy really undoes
 * what was added since.
 */
export function snapshotBackup(id: string): Backup {
  const file = snapshotFile(id);
  if (!file) throw new Error('That copy is gone.');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const get = <T>(key: string, fallback: T): T => {
      const row = db.prepare('SELECT value FROM docs WHERE key = ?').get(key) as { value: string } | undefined;
      try {
        return row ? (JSON.parse(row.value) as T) : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      version: 2,
      exported: parseSnapshotId(id)!.at,
      bookmarks: get('bookmarks', STARTER_BOOKMARKS),
      notes: get('notes', STARTER_NOTES),
      prefs: { ...DEFAULT_PREFS, ...get('prefs', {}) },
      countdowns: get('countdowns', []),
      smokes: get('smokes', []),
      moods: get('moods', {}),
      weights: get('weights', {}),
      money: cleanMoney(get('money', null)),
      learn: cleanLearn(get('learn', null)),
      training: cleanTraining(get('training', null)),
      exerciseMuscles: get('exerciseMuscles', {}),
      packages: get('packages', []),
      photos: get('photos', []),
    };
  } finally {
    db.close();
  }
}

/** Take the daily copy when the last one is over 20 hours old; checked hourly, so a restart never skips a day. */
export function dailySnapshotDue(list: BackupSnapshot[], now = Date.now()): boolean {
  const last = list.find((s) => s.reason === 'daily');
  return !last || now - Date.parse(last.at) > DAY - 4 * 3_600_000;
}

export function startSnapshots(): void {
  const check = () => {
    try {
      if (dailySnapshotDue(listSnapshots())) {
        const s = takeSnapshot('daily');
        console.log(`[backup] daily copy ${s.id} (${Math.round(s.size / 1024)} KB)`);
      }
    } catch (e) {
      console.error('[backup] couldn’t take the daily copy:', (e as Error).message);
    }
  };
  setTimeout(check, 2 * 60_000);
  setInterval(check, 3_600_000);
}
