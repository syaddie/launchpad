// The Minecraft tab's world backups. A backup packs the world's folders (level-name
// from server.properties, and its _nether and _the_end beside it on Bukkit-style
// servers) into a .tar.gz in the server's backups folder. A running server is told to
// stop writing first (save-off, then save-all flush, waiting in the log until the save
// is done) and to carry on afterwards (save-on), which the host's own shell types once
// tar ends, so it happens even if Launchpad goes away halfway. Only files with
// Launchpad's own names are listed, pruned or deleted.
//
// A restore needs the server stopped. It backs up the world as it is first, unpacks
// the backup beside it, then swaps the folders, putting the old ones back if a move
// fails; the backup from just before is how a restore is undone.
import path from 'node:path';
import { cleanLevel, findMc, forgetDetected, mcBusy, askConsole, sendLine, serverFacts, ssh, typeInto, worldFolders } from './minecraft';
import { call, FileError, runCommand, sftpSession, shellQuote } from './shell';
import { MC_KEEP_BACKUPS } from '../../shared/types';
import type { McBackup, McBackups, McJob, McServer, McStatus } from '../../shared/types';

const q = shellQuote;

export const backupDirOf = (s: Pick<McServer, 'dir' | 'backupDir'>) => s.backupDir || path.posix.join(s.dir, 'backups');
export const keepOf = (s: Pick<McServer, 'keepBackups'>) => s.keepBackups ?? MC_KEEP_BACKUPS;

// ---------- names ----------

const pad = (n: number) => String(n).padStart(2, '0');

/** 20261118-143005, in UTC, so names sort by time wherever the host's clock is set. */
export const stampOf = (d: Date) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;

/** launchpad-<server id>-<stamp>[-before-restore].tar.gz */
export const backupName = (id: string, d: Date, beforeRestore = false) => `launchpad-${id}-${stampOf(d)}${beforeRestore ? '-before-restore' : ''}.tar.gz`;

/** A backup of server `id` by its name, or null for anything else (someone else's file, another server's). */
export function parseBackupName(id: string, name: string): { at: Date; beforeRestore: boolean } | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || !name.startsWith(`launchpad-${id}-`)) return null;
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(-before-restore)?\.tar\.gz$/.exec(name.slice(`launchpad-${id}-`.length));
  if (!m) return null;
  const at = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  return Number.isNaN(at.getTime()) ? null : { at, beforeRestore: !!m[7] };
}

/** The names to remove so only the newest `keep` remain. */
export function toPrune(list: McBackup[], keep: number): string[] {
  return [...list].sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name)).slice(Math.max(1, keep)).map((b) => b.name);
}

// ---------- looking before packing ----------

export interface Space {
  /** The folder isn't there. */
  noDir: boolean;
  /** World folders that exist. */
  worlds: string[];
  /** Their size together, bytes. */
  size: number | null;
  /** Free bytes where backups go, and on the server folder's disk, with each one's mount point. */
  freeBackup: { bytes: number; mount: string } | null;
  freeDir: { bytes: number; mount: string } | null;
  missing: string[];
}

/** Which world folders are there, how big, and how much room there is. Makes the backups folder if it isn't there. */
export function spaceScript(dir: string, backupDir: string, worlds: string[]): string {
  return [
    `cd ${q(dir)} 2>/dev/null || { echo nodir; exit 0; }`,
    'set --',
    `for w in ${worlds.map(q).join(' ') || "''"}; do [ -n "$w" ] && [ -d "$w" ] && set -- "$@" "$w"; done`,
    'for w in "$@"; do printf \'world %s\\n\' "$w"; done',
    '[ $# -gt 0 ] && echo "size $(du -skc -- "$@" 2>/dev/null | tail -n 1 | cut -f1)"',
    `mkdir -p -- ${q(backupDir)} 2>/dev/null`,
    `echo "freebackup $(df -Pk -- ${q(backupDir)} 2>/dev/null | tail -n 1 | awk '{print $4, $6}')"`,
    `echo "freedir $(df -Pk -- . 2>/dev/null | tail -n 1 | awk '{print $4, $6}')"`,
    'for t in tar gzip du df; do command -v $t >/dev/null 2>&1 || echo "missing $t"; done',
    'true',
  ].join('\n');
}

export function parseSpace(out: string): Space {
  const lines = out.split('\n');
  const val = (k: string) => lines.find((l) => l.startsWith(k + ' '))?.slice(k.length + 1).trim() ?? '';
  const free = (k: string) => {
    const [kb, ...mount] = val(k).split(/\s+/);
    return /^\d+$/.test(kb ?? '') ? { bytes: Number(kb) * 1024, mount: mount.join(' ') } : null;
  };
  const size = val('size');
  return {
    noDir: lines.some((l) => l.trim() === 'nodir'),
    worlds: lines.filter((l) => l.startsWith('world ')).map((l) => l.slice(6)),
    size: /^\d+$/.test(size) ? Number(size) * 1024 : null,
    freeBackup: free('freebackup'),
    freeDir: free('freedir'),
    missing: lines.filter((l) => l.startsWith('missing ')).map((l) => l.slice(8).trim()),
  };
}

/** Room for `need` bytes in `free`, leaving some over. */
export const fits = (need: number, free: number) => need * 1.05 + 200 * 1024 * 1024 <= free;

export function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Why a backup won't fit, or null when it will. */
export function spaceProblem(sp: Space, backupDir: string): string | null {
  if (sp.missing.length) return `The server is missing ${sp.missing.join(', ')}, which backups need. Install ${sp.missing.length > 1 ? 'them' : 'it'} (for example: sudo apt install ${sp.missing.join(' ')}).`;
  if (sp.size === null || !sp.freeBackup) return `Launchpad couldn’t work out how much room the backup needs, or how much is free in ${backupDir}, so it didn’t start.`;
  if (!fits(sp.size, sp.freeBackup.bytes)) {
    return `Not enough space: the world is ${fmtBytes(sp.size)} and only ${fmtBytes(sp.freeBackup.bytes)} is free in ${backupDir}. Free some space, keep fewer backups, or pick another backups folder under Edit.`;
  }
  return null;
}

// ---------- running long commands ----------

/**
 * A command that can take a long time (tar on a big world). The shared SSH connection
 * closes after five quiet minutes, so it's kept busy meanwhile.
 */
async function longRun(cmd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const keep = setInterval(() => void sftpSession().catch(() => {}), 60_000);
  try {
    return await runCommand(cmd, timeoutMs);
  } finally {
    clearInterval(keep);
  }
}

const TAR_TIMEOUT = 4 * 60 * 60_000;
/** How long save-all flush may take to say it's done. */
const SAVE_WAIT = 5 * 60_000;

/** The manifest at the top of every archive: the world folders in it, one a line. */
const MANIFEST = 'launchpad-worlds.txt';

/**
 * Pack `worlds` (relative to dir) into `final`, through a hidden part file, with the manifest
 * first. `after` runs whatever tar did (save-on). Prints "packed" when the file is in place.
 */
export function packScript(dir: string, backupDir: string, worlds: string[], final: string, after = ''): string {
  const part = path.posix.join(backupDir, `.${final}.part`);
  const meta = path.posix.join(backupDir, `.${final}.meta`);
  return [
    `rm -rf -- ${q(meta)} && mkdir -p -- ${q(meta)} && printf '%s\\n' ${worlds.map(q).join(' ')} > ${q(path.posix.join(meta, MANIFEST))} || exit 3`,
    // tar's 1 is "a file changed as it was read": with saving paused that's only logs and the like.
    `nice -n 10 tar -czf ${q(part)} -C ${q(meta)} ${MANIFEST} -C ${q(dir)} -- ${worlds.map(q).join(' ')}; rc=$?`,
    ...(after ? [`{ ${after}; } >/dev/null 2>&1`] : []),
    `rm -rf -- ${q(meta)}`,
    `if [ $rc -le 1 ] && [ -s ${q(part)} ]; then mv -f -- ${q(part)} ${q(path.posix.join(backupDir, final))} && echo packed; else rm -f -- ${q(part)}; fi`,
    'exit $rc',
  ].join('\n');
}

/** The last line tar or the shell complained with, for the page. */
const complaint = (r: { code: number | null; stderr: string }) => r.stderr.trim().split('\n').filter((l) => !/file changed as we read it|Removing leading/.test(l)).pop() || `exited with ${r.code}`;

// ---------- jobs ----------

const jobs = new Map<string, McJob>();

function begin(id: string, kind: McJob['kind'], file: string | null): McJob {
  const job: McJob = { kind, step: kind === 'backup' ? 'Getting ready…' : 'Getting ready to restore…', startedAt: new Date().toISOString(), endedAt: null, ok: null, message: null, file, bytes: null };
  jobs.set(id, job);
  mcBusy.set(id, kind);
  return job;
}

function finish(id: string, job: McJob, ok: boolean, message: string): void {
  Object.assign(job, { ok, message, endedAt: new Date().toISOString(), step: ok ? 'Done' : 'Failed', bytes: null });
  mcBusy.clear(id);
  console.log(`[minecraft] ${job.kind} of ${id}: ${ok ? 'done' : 'failed'}: ${message}`);
}

const fmtWhen = (d: Date) => d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- listing ----------

async function listOf(s: McServer): Promise<{ list: McBackup[]; leftovers: string[] }> {
  const { sftp } = await sftpSession();
  const dir = backupDirOf(s);
  type Entry = { filename: string; attrs: { size: number; mode: number } };
  const read = (d: string) =>
    call<Entry[]>(d, (cb) => sftp.readdir(d, cb)).catch((e) => {
      if (e instanceof FileError && e.status === 404) return [] as Entry[];
      throw e;
    });
  const [files, here] = await Promise.all([read(dir), s.dir ? read(s.dir).catch(() => [] as Entry[]) : Promise.resolve([] as Entry[])]);
  const list = files.flatMap((f) => {
    const p = parseBackupName(s.id, f.filename);
    return p && (f.attrs.mode & 0o170000) === 0o100000 ? [{ name: f.filename, size: f.attrs.size, at: p.at.toISOString(), beforeRestore: p.beforeRestore }] : [];
  });
  list.sort((a, b) => b.at.localeCompare(a.at));
  const leftovers = here.map((f) => f.filename).filter((n) => /^\.launchpad-(restore|old)-\d{8}-\d{6}$/.test(n));
  return { list, leftovers };
}

export async function backups(id: string): Promise<McBackups> {
  const s = await findMc(id);
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder. Save it with its folder to back it up.`, 409);
  const dir = backupDirOf(s);
  const { list, leftovers } = await listOf(s);
  const job = jobs.get(id) ?? null;
  // How far tar has got, from the size of its part file.
  if (job && !job.endedAt && job.file && job.step.startsWith('Packing')) {
    const { sftp } = await sftpSession();
    const part = path.posix.join(dir, `.${job.file}.part`);
    job.bytes = await call<{ size: number }>(part, (cb) => sftp.stat(part, cb)).then((st) => st.size, () => job.bytes);
  }
  const r = await ssh(`df -Pk -- ${q(dir)} 2>/dev/null | tail -n 1 | awk '{print $4}'`, 10_000, 'Checking the free space').catch(() => null);
  const kb = r?.stdout.trim();
  return { dir, keep: keepOf(s), list, job, free: kb && /^\d+$/.test(kb) ? Number(kb) * 1024 : null, leftovers };
}

// ---------- backing up ----------

/** Pause saving and flush, then pack, then saving back on. A stopped server is packed as it is. */
async function runBackup(s: McStatus, job: McJob, worlds: string[], final: string): Promise<void> {
  const dir = backupDirOf(s);
  let resumed = !s.running;
  try {
    if (s.running) {
      job.step = 'Pausing saving…';
      await typeInto(s, 'save-off');
      job.step = 'Saving the world to disk…';
      const msgs = await askConsole(s, 'save-all flush', (m) => m.some((l) => /Saved the (game|world)|All dimensions are saved/i.test(l)), SAVE_WAIT);
      if (!msgs.some((l) => /Saved the (game|world)|All dimensions are saved/i.test(l))) {
        throw new FileError(`${s.name} didn’t say it had finished saving within ${SAVE_WAIT / 60_000} minutes, so Launchpad didn’t pack a world that might be half-written.`);
      }
    }
    job.step = `Packing ${worlds.join(', ')}…`;
    // The host's shell types save-on as soon as tar ends, however it ends.
    const after = s.running && s.session ? sendLine(s.mux, s.session, 'save-on') : '';
    const r = await longRun(packScript(s.dir, dir, worlds, final, after), TAR_TIMEOUT);
    resumed = true;
    if (!/^packed$/m.test(r.stdout)) throw new FileError(`Packing the world failed: ${complaint(r)}`);
    job.step = 'Clearing out old backups…';
    const pruned = await prune(s);
    const size = (await listOf(s)).list.find((b) => b.name === final)?.size;
    finish(s.id, job, true, `Backed up ${worlds.join(', ')}${size ? ` (${fmtBytes(size)})` : ''}.${pruned ? ` Removed ${pruned} older backup${pruned === 1 ? '' : 's'}, keeping ${keepOf(s)}.` : ''}`);
  } catch (e) {
    finish(s.id, job, false, (e as Error).message);
  } finally {
    // Saving goes back on whatever happened before tar got to it.
    if (!resumed) await typeInto(s, 'save-on').catch((e) => console.error(`[minecraft] couldn’t turn saving back on for ${s.name}: ${(e as Error).message}`));
  }
}

/** Remove all but the newest backups. Only after a new one is in place, and only Launchpad's own. */
async function prune(s: McServer): Promise<number> {
  const { list } = await listOf(s);
  const gone = toPrune(list, keepOf(s));
  if (!gone.length) return 0;
  const { sftp } = await sftpSession();
  let n = 0;
  for (const name of gone) {
    const p = path.posix.join(backupDirOf(s), name);
    await call<void>(p, (cb) => sftp.unlink(p, cb)).then(
      () => n++,
      (e) => console.warn(`[minecraft] couldn’t remove the old backup ${p}: ${(e as Error).message}`),
    );
  }
  return n;
}

/** Look before starting: the world's folders, the space, the tools. Throws what's wrong. */
async function prepare(s: McStatus): Promise<{ worlds: string[]; space: Space }> {
  const facts = await serverFacts(s, true);
  if (!facts.level) throw new FileError(`server.properties gives a level-name outside ${s.name}’s folder, so Launchpad won’t back it up.`, 409);
  const r = await ssh(spaceScript(s.dir, backupDirOf(s), worldFolders(facts)), 120_000, `Measuring ${s.name}’s world`);
  const space = parseSpace(r.stdout);
  if (space.noDir) throw new FileError(`The folder ${s.dir} isn’t on the server.`, 409);
  return { worlds: space.worlds, space };
}

export async function startBackup(id: string): Promise<McBackups> {
  const s = await findMc(id, true);
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder. Save it with its folder to back it up.`, 409);
  const busy = mcBusy.get(id);
  if (busy) throw new FileError(`A ${busy} of ${s.name} is already under way.`, 409);
  if (s.running && !s.attached) throw new FileError(`${s.name} is running outside tmux or screen, so Launchpad can’t pause its saving for a clean copy. Stop it first, or run it in tmux or screen.`, 409);
  const final = backupName(id, new Date());
  const job = begin(id, 'backup', final);
  try {
    job.step = 'Measuring the world…';
    const { worlds, space } = await prepare(s);
    if (!worlds.length) throw new FileError(`There’s no world folder in ${s.dir} yet (level-name is ${(await serverFacts(s)).level}). Start the server once to make it.`, 409);
    const problem = spaceProblem(space, backupDirOf(s));
    if (problem) throw new FileError(problem, 409);
    void runBackup(s, job, worlds, final);
  } catch (e) {
    finish(id, job, false, (e as Error).message);
    throw e;
  }
  return backups(id);
}

// ---------- restoring ----------

/** The world folders an unpacked backup holds, from its manifest; ones that aren't plain folders inside the server's are dropped. */
export function manifestWorlds(text: string): string[] {
  return [...new Set(text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => cleanLevel(l)).filter((l): l is string => !!l))].slice(0, 10);
}

/**
 * Move each world folder aside and the unpacked one into its place. If a move fails, what
 * moved goes back: the old folders into place, the new ones back into the unpacked folder.
 */
export function swapScript(dir: string, tmp: string, old: string, worlds: string[]): string {
  const parent = (w: string) => path.posix.dirname(w);
  const undoOld = worlds.map((w) => `if [ -e ${q(`${old}/${w}`)} ]; then mkdir -p -- ${q(parent(w))} && mv -- ${q(`${old}/${w}`)} ${q(w)}; fi`);
  const undoNew = worlds.map((w) => `if [ ! -e ${q(`${tmp}/${w}`)} ] && [ -e ${q(w)} ]; then mkdir -p -- ${q(`${tmp}/${parent(w)}`)} && mv -- ${q(w)} ${q(`${tmp}/${w}`)}; fi`);
  return [
    `cd ${q(dir)} || exit 3`,
    `undo_old() { ${undoOld.join('; ')}; }`,
    `undo_new() { ${undoNew.join('; ')}; }`,
    ...worlds.map((w) => `[ -d ${q(`${tmp}/${w}`)} ] || { echo ${q(`missing ${w}`)}; exit 13; }`),
    `mkdir -p -- ${q(old)} || exit 3`,
    ...worlds.map((w) => `if [ -e ${q(w)} ]; then mkdir -p -- ${q(`${old}/${parent(w)}`)} && mv -- ${q(w)} ${q(`${old}/${w}`)} || { undo_old; exit 11; }; fi`),
    ...worlds.map((w) => `mkdir -p -- ${q(parent(w))} && mv -- ${q(`${tmp}/${w}`)} ${q(w)} || { undo_new; undo_old; exit 12; }`),
    `rm -rf -- ${q(old)} ${q(tmp)}`,
    'echo swapped',
  ].join('\n');
}

async function runRestore(s: McStatus, job: McJob, name: string, size: number): Promise<void> {
  const dir = backupDirOf(s);
  const now = new Date();
  const tmp = `.launchpad-restore-${stampOf(now)}`;
  const old = `.launchpad-old-${stampOf(now)}`;
  let unpacked = false;
  try {
    job.step = 'Measuring the world as it is now…';
    const facts = await serverFacts(s, true);
    const current = worldFolders(facts);
    const measure = async (worlds: string[]) => parseSpace((await ssh(spaceScript(s.dir, dir, worlds), 120_000, `Measuring ${s.name}’s world`)).stdout);
    const space = await measure(current);
    if (space.noDir) throw new FileError(`The folder ${s.dir} isn’t on the server.`, 409);
    if (space.missing.length || !space.freeDir || !space.freeBackup) throw new FileError(spaceProblem(space, dir) ?? 'Launchpad couldn’t read the free space.');
    const needBackup = space.size ?? 0;
    // Region files are compressed already, so the unpacked world is about the size of the archive; some room over for the rest.
    const needUnpack = size * 1.3;
    const same = space.freeBackup.mount === space.freeDir.mount;
    if (same ? !fits(needBackup + needUnpack, space.freeDir.bytes) : !fits(needBackup, space.freeBackup.bytes) || !fits(needUnpack, space.freeDir.bytes)) {
      throw new FileError(`Not enough space: keeping a copy of the world as it is (${fmtBytes(needBackup)}) and unpacking the backup (about ${fmtBytes(needUnpack)}) needs more than the ${fmtBytes(space.freeDir.bytes)} free. Nothing was changed.`);
    }

    job.step = 'Unpacking the backup…';
    const archive = path.posix.join(dir, name);
    const r = await longRun(`cd ${q(s.dir)} && rm -rf -- ${q(tmp)} && mkdir -- ${q(tmp)} && tar -xzf ${q(archive)} -C ${q(tmp)} --no-same-owner; rc=$?; [ $rc -eq 0 ] || rm -rf -- ${q(tmp)}; exit $rc`, TAR_TIMEOUT);
    if (r.code) throw new FileError(`Couldn’t unpack the backup, so the world wasn’t changed: ${complaint(r)}`);
    unpacked = true;
    const { sftp } = await sftpSession();
    const mf = path.posix.join(s.dir, tmp, MANIFEST);
    const into = manifestWorlds(await call<Buffer>(mf, (cb) => sftp.readFile(mf, cb)).then((b) => b.toString('utf8'), () => ''));
    if (!into.length) throw new FileError('That backup doesn’t say which world folders it holds, so Launchpad didn’t change anything.');

    // Everything the swap could replace is copied first: today's world folders and any of the backup's that exist.
    const keep = await measure([...new Set([...current, ...into])]);
    let undo = '';
    if (keep.worlds.length) {
      if (keep.size === null || !keep.freeBackup || !fits(keep.size, keep.freeBackup.bytes)) {
        throw new FileError(`Not enough space left in ${dir} to keep a copy of the world as it is (${fmtBytes(keep.size ?? 0)}), so nothing was changed.`);
      }
      job.step = 'Backing up the world as it is now…';
      const safety = backupName(s.id, now, true);
      const pk = await longRun(packScript(s.dir, dir, keep.worlds, safety), TAR_TIMEOUT);
      if (!/^packed$/m.test(pk.stdout)) throw new FileError(`Couldn’t back up the world as it is, so nothing was changed: ${complaint(pk)}`);
      undo = ` The world as it was is kept as the backup from ${fmtWhen(now)}, so this can be undone.`;
    }
    // Someone may have started it meanwhile; a running server's world mustn't be swapped under it.
    if ((await findMc(s.id, true)).running) throw new FileError(`${s.name} was started during the restore, so the world wasn’t changed.`);
    job.step = 'Putting the backup in place…';
    const sw = await ssh(swapScript(s.dir, tmp, old, into), 120_000, 'Swapping the world folders');
    if (!/^swapped$/m.test(sw.stdout)) throw new FileError(`Couldn’t move the world folders into place, so they were put back as they were: ${complaint(sw)}`);
    unpacked = false;
    const at = parseBackupName(s.id, name)?.at;
    finish(s.id, job, true, `Restored ${into.join(', ')} from the backup of ${at ? fmtWhen(at) : name}.${undo}`);
  } catch (e) {
    finish(s.id, job, false, (e as Error).message);
  } finally {
    if (unpacked) await ssh(`cd ${q(s.dir)} && rm -rf -- ${q(tmp)}`, 120_000, 'Tidying up').catch(() => {});
    forgetDetected();
  }
}

export async function startRestore(id: string, name: unknown): Promise<McBackups> {
  const s = await findMc(id, true);
  if (typeof name !== 'string' || !parseBackupName(id, name)) throw new FileError('That isn’t one of this server’s backups.');
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder.`, 409);
  const busy = mcBusy.get(id);
  if (busy) throw new FileError(`A ${busy} of ${s.name} is already under way.`, 409);
  if (s.running) throw new FileError(`Stop ${s.name} first: a world can’t be restored while the server is using it.`, 409);
  const found = (await listOf(s)).list.find((b) => b.name === name);
  if (!found) throw new FileError('That backup isn’t there any more.', 404);
  const job = begin(id, 'restore', name);
  void runRestore(s, job, name, found.size);
  return backups(id);
}

export async function deleteBackup(id: string, name: unknown): Promise<McBackups> {
  const s = await findMc(id);
  if (typeof name !== 'string' || !parseBackupName(id, name)) throw new FileError('That isn’t one of this server’s backups.');
  if (mcBusy.get(id)) throw new FileError(`Wait for the ${mcBusy.get(id)} of ${s.name} to finish first.`, 409);
  const p = path.posix.join(backupDirOf(s), name);
  const { sftp } = await sftpSession();
  await call<void>(p, (cb) => sftp.unlink(p, cb));
  return backups(id);
}

/** Forget the last finished job, so its message stops showing. */
export function dismissJob(id: string): void {
  if (jobs.get(id)?.endedAt) jobs.delete(id);
}
