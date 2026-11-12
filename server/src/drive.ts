// Copies of the database off the server: after each daily copy (see snapshots.ts), the
// same file goes to a "Launchpad backups" folder in your Google Drive, and the last 14 are
// kept there too. Drive's drive.file permission only shows Launchpad what it made, and
// pruning only ever touches files this uploaded, each marked in its private properties.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { driveFiles, driveFolder, driveTrash, driveUpload, GoogleError, hasScope, type DriveFile } from './google';
import { asServer, store } from './store';
import { KEEP, listSnapshots, parseSnapshotId, snapshotFile, takeSnapshot } from './snapshots';
import { signOutGoogle } from './sync';
import type { BackupSnapshot, DriveStatus } from '../../shared/types';

const FOLDER = 'Launchpad backups';
/** The private property every folder and file this makes carries. Nothing without it is ever deleted. */
const FOLDER_TAG = { launchpad: 'backup-folder' };
const FILE_TAG = { launchpad: 'database-copy' };

const fileName = (id: string) => `launchpad-${id}.db`;

/** The snapshot id a Drive file was uploaded from, or null when it isn't one of this feature's uploads. */
export function uploadedId(f: DriveFile): string | null {
  if (f.appProperties?.launchpad !== FILE_TAG.launchpad) return null;
  const m = /^launchpad-(.+)\.db$/.exec(f.name);
  const id = m?.[1];
  if (!id || !parseSnapshotId(id) || f.appProperties.snapshot !== id) return null;
  return id;
}

/**
 * The files to move to the bin: of this feature's own uploads, all but the newest
 * KEEP[reason] of each kind. Anything else in the list, even in the same folder, is left alone.
 */
export function drivePrunable(files: DriveFile[], keep: Partial<Record<BackupSnapshot['reason'], number>> = KEEP): DriveFile[] {
  const ours = files.flatMap((f) => {
    const id = uploadedId(f);
    const p = id && parseSnapshotId(id);
    return p ? [{ f, ...p }] : [];
  });
  const out: DriveFile[] = [];
  for (const reason of Object.keys(keep) as BackupSnapshot['reason'][]) {
    const n = keep[reason] ?? Infinity;
    out.push(...ours.filter((x) => x.reason === reason).sort((a, b) => b.at.localeCompare(a.at)).slice(n).map((x) => x.f));
  }
  return out;
}

/** The switch is on and the Google sign-in allows Drive. */
export const driveOn = () => store.prefs().driveBackup && !!store.google() && hasScope('drive.file');

let running: Promise<void> | null = null;

export function driveStatus(): DriveStatus {
  const s = store.driveBackup();
  return { on: store.prefs().driveBackup, allowed: !!store.google() && hasScope('drive.file'), lastSuccess: s.lastSuccess, lastAttempt: s.lastAttempt, lastError: s.lastError, running: !!running };
}

/**
 * The copy as it goes to Drive: the same database with the Google sign-in taken out, so a
 * file shared by mistake can't be used to read your mail. Putting one back means connecting
 * Google again.
 */
export function driveCopy(file: string): Buffer {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-drive-'));
  try {
    const copy = path.join(tmp, 'copy.db');
    fs.copyFileSync(file, copy);
    const db = new DatabaseSync(copy);
    try {
      db.prepare("DELETE FROM docs WHERE key = 'google'").run();
      db.exec('VACUUM');
    } finally {
      db.close();
    }
    return fs.readFileSync(copy);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function upload(s: BackupSnapshot): Promise<void> {
  const file = snapshotFile(s.id);
  if (!file) throw new Error('That copy is gone.');
  const folder = await driveFolder(FOLDER, FOLDER_TAG);
  await driveUpload(folder, fileName(s.id), driveCopy(file), { ...FILE_TAG, snapshot: s.id });
  const old = drivePrunable(await driveFiles(folder, FILE_TAG));
  for (const f of old) await driveTrash(f.id);
  if (old.length) console.log(`[backup] moved ${old.length} old Drive ${old.length === 1 ? 'copy' : 'copies'} to the bin`);
}

/** Upload one copy, recording how it went. One at a time, and it never rejects, so callers can leave it running. */
function run(pick: () => BackupSnapshot | null): Promise<void> {
  if (running) return running;
  const p = asServer(async () => {
    const prev = store.driveBackup();
    const at = new Date().toISOString();
    try {
      const s = pick();
      if (!s) return;
      await upload(s);
      store.setDriveBackup({ lastSuccess: new Date().toISOString(), lastAttempt: at, lastError: null, uploadedDaily: s.reason === 'daily' ? s.id : prev.uploadedDaily });
      console.log(`[backup] copied ${s.id} to Google Drive`);
    } catch (e) {
      const err = e as Error;
      console.error('[backup] couldn’t copy to Google Drive:', err.message);
      store.setDriveBackup({ ...prev, lastAttempt: at, lastError: err.message });
      if (err instanceof GoogleError && err.authExpired) signOutGoogle(err.message);
    }
  }).finally(() => {
    running = null;
  });
  running = p;
  return p;
}

/** The newest daily copy, when it hasn't reached Drive yet. */
export function pendingDaily(list: BackupSnapshot[], uploadedDaily: string | null): BackupSnapshot | null {
  const newest = list.find((s) => s.reason === 'daily');
  return newest && newest.id !== uploadedDaily ? newest : null;
}

/** Copy the newest daily copy to Drive unless it's there already. Run after every hourly check, so a failed upload is retried an hour later. */
export function copyDailyToDrive(): Promise<void> {
  if (!driveOn()) return Promise.resolve();
  return run(() => pendingDaily(listSnapshots(), store.driveBackup().uploadedDaily));
}

/** "Copy to Drive now": take a copy of how things are now (kept on the server too) and upload it. */
export function copyToDriveNow(): Promise<void> {
  if (!driveOn()) return Promise.resolve();
  return run(() => takeSnapshot('manual'));
}
