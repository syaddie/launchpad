// Deleting from the Files explorer moves things to a trash, where they can be restored,
// and Launchpad empties what it put there after TRASH_DAYS.
//
// The trash is the FreeDesktop one that desktop file managers, gio and trash-cli use, so
// they all see the same thing. Something on the same disk as the home folder goes to
// ~/.local/share/Trash; something on another disk (/mnt/media, say) goes to that disk's
// own <mount>/.Trash-<uid>. Either way it's a rename on one filesystem, never a copy:
// the move itself is an SFTP rename, which fails rather than copies across disks. Each
// item is files/<name>, with info/<name>.trashinfo saying where it was and when.
//
// Emptying deletes only inside a trash's files and info folders, and only trashes this
// module found itself, checked to be real folders and not links.
import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { call, cleanName, cleanPath, FileError, kindOf, runCommand, sftpSession, shellConfigured, shellQuote, stat } from './shell';
import { runRemote } from './remote';
import { numberedName, TRASH_DAYS, type TrashItem, type TrashListing, type TrashOutcome } from '../../shared/files';

/** A delete that couldn't go to the trash, saying whether deleting it for good is still an option. */
export class TrashError extends FileError {
  constructor(message: string, readonly permanentOk: boolean, status: 400 | 403 | 404 | 409 | 500 = 409) {
    super(message, status);
  }
}

// ---------- where the trash is ----------

export interface Place {
  uid: number;
  home: string;
  /** ~/.local/share/Trash, or under XDG_DATA_HOME. */
  homeTrash: string;
  /** The mount the home folder is on. */
  homeMount: string;
  /** The server's clock: minutes ahead of UTC, for the local times .trashinfo files hold. */
  offsetMin: number;
}

/** One line of `df -P`: the mount point and the KB free. Filesystem names and mount points may have spaces. */
export function parseDf(line: string): { mount: string; availKb: number } | null {
  const m = /^(.*?)\s+(\d+|-)\s+(\d+|-)\s+(\d+|-)\s+(\d+%|-)\s+(\/.*)$/.exec(line.trim());
  return m ? { mount: m[6], availKb: m[4] === '-' ? 0 : Number(m[4]) } : null;
}

/** Minutes ahead of UTC, from the server's `date +%s` and its local `date +%Y-%m-%dT%H:%M:%S`, to the quarter hour. */
export function hostOffset(epoch: number, local: string): number {
  const asUtc = Date.parse(local + 'Z');
  if (!Number.isFinite(asUtc) || !Number.isFinite(epoch)) return 0;
  return Math.round((asUtc - epoch * 1000) / 60_000 / 15) * 15;
}

export function parsePlace(out: string): Place {
  const [uid, home, homeTrash, epoch, local, df] = out.split('\n');
  const mount = df ? parseDf(df)?.mount : undefined;
  if (!/^\d+$/.test(uid ?? '') || !home?.startsWith('/') || !homeTrash?.startsWith('/') || !mount) throw new FileError('Couldn’t find the home folder’s trash on the server.', 500);
  return { uid: Number(uid), home, homeTrash: path.posix.normalize(homeTrash), homeMount: mount, offsetMin: hostOffset(Number(epoch), (local ?? '').trim()) };
}

const PLACE_CMD = [
  'id -u',
  `printf '%s\\n' "$HOME"`,
  `printf '%s\\n' "\${XDG_DATA_HOME:-$HOME/.local/share}/Trash"`,
  'date +%s',
  'date +%Y-%m-%dT%H:%M:%S',
  'df -P -- "$HOME" | tail -n 1',
].join('; ');

let placeCache: { place: Place; at: number } | null = null;

export async function getPlace(): Promise<Place> {
  if (placeCache && Date.now() - placeCache.at < 10 * 60_000) return placeCache.place;
  const r = await runCommand(PLACE_CMD, 15_000);
  const place = parsePlace(r.stdout);
  placeCache = { place, at: Date.now() };
  return place;
}

const MARK = '--launchpad--';

/** Which mount each path is on, from one df per path. A path df can't see is left out. */
export async function mountsOf(paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!paths.length) return out;
  const cmd = `for p in ${paths.map(shellQuote).join(' ')}; do df -P -- "$p" 2>/dev/null | tail -n 1; echo ${MARK}; done`;
  const r = await runCommand(cmd, 20_000);
  const blocks = r.stdout.split(MARK + '\n');
  paths.forEach((p, i) => {
    const m = blocks[i] ? parseDf(blocks[i].trim().split('\n').pop() ?? '')?.mount : undefined;
    if (m) out.set(p, m);
  });
  return out;
}

/** The trash for something whose folder is on `mount`: the home one on the home disk, else the disk's own. */
export const trashDirFor = (mount: string, place: Pick<Place, 'uid' | 'homeTrash' | 'homeMount'>) =>
  mount === place.homeMount ? place.homeTrash : path.posix.join(mount, `.Trash-${place.uid}`);

/** The folder a trash's relative paths start from: the disk's top for <mount>/.Trash-<uid>; none for the home trash, which keeps absolute ones. */
export const topdirOf = (trash: string, place: Pick<Place, 'homeTrash'>) => (trash === place.homeTrash ? null : path.posix.dirname(trash));

// ---------- .trashinfo ----------

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function decodePath(p: string): string {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

/** Local time on the server, as the spec has it: no zone. */
export const localStamp = (d: Date, offsetMin: number) => new Date(d.getTime() + offsetMin * 60_000).toISOString().slice(0, 19);

/** The X-Launchpad line marks what Launchpad trashed, so only that is emptied on a timer; other tools ignore keys they don't know. */
export function formatTrashInfo(original: string, topdir: string | null, deleted: Date, offsetMin: number): string {
  const rel = topdir && original.startsWith(topdir === '/' ? '/' : topdir + '/') ? original.slice(topdir === '/' ? 1 : topdir.length + 1) : original;
  return `[Trash Info]\nPath=${encodePath(rel)}\nDeletionDate=${localStamp(deleted, offsetMin)}\nX-Launchpad=1\n`;
}

export function parseTrashInfo(text: string, topdir: string | null, offsetMin: number): { path: string; deletedAt: string; ours: boolean } | null {
  let group = '';
  let p: string | null = null;
  let date: string | null = null;
  let ours = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) group = line;
    else if (group === '[Trash Info]') {
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k === 'Path') p = decodePath(v);
      else if (k === 'DeletionDate') date = v;
      else if (k === 'X-Launchpad') ours = v === '1';
    }
  }
  if (!p) return null;
  const abs = p.startsWith('/') ? p : topdir ? path.posix.join(topdir, p) : null;
  if (!abs) return null;
  const at = date ? Date.parse(date.replace(' ', 'T') + 'Z') - offsetMin * 60_000 : NaN;
  return { path: path.posix.normalize(abs), deletedAt: new Date(Number.isFinite(at) ? at : 0).toISOString(), ours };
}

// ---------- making and checking trash folders ----------

const lstat = (sftp: SFTPWrapper, p: string) => call<Stats>(p, (cb) => sftp.lstat(p, cb));
const mkdir = (sftp: SFTPWrapper, p: string) => call<void>(p, (cb) => sftp.mkdir(p, { mode: 0o700 }, cb));

/** Every folder down to `p`, as mkdir -p does. */
export async function mkdirp(sftp: SFTPWrapper, p: string, mode = 0o755): Promise<void> {
  const parts = p.split('/').filter(Boolean);
  let at = '';
  for (const part of parts) {
    at += '/' + part;
    const st = await stat(sftp, at).catch(() => null);
    if (st) {
      if (kindOf(st.mode) !== 'dir') throw new FileError(`${at} isn’t a folder.`, 409);
      continue;
    }
    await call<void>(at, (cb) => sftp.mkdir(at, { mode }, cb)).catch(async (e) => {
      // Made meanwhile by someone else is fine.
      if (!(await stat(sftp, at).catch(() => null))) throw e;
    });
  }
}

const isRealDir = (st: Stats | null) => !!st && kindOf(st.mode) === 'dir';

const ready = new Map<string, number>();

/** The trash folder with its files and info folders, made if they aren't there. A disk's trash must be a real folder of ours. */
async function ensureTrash(sftp: SFTPWrapper, dir: string, place: Place, mount: string): Promise<void> {
  if (Date.now() - (ready.get(dir) ?? 0) < 10 * 60_000) return;
  const home = dir === place.homeTrash;
  const st = await lstat(sftp, dir).catch(() => null);
  if (st) {
    if (!isRealDir(st) && !(home && kindOf(st.mode) === 'link')) throw new TrashError(`${dir} isn’t a folder, so there’s no trash for ${mount}.`, true);
    if (!home && st.uid !== place.uid) throw new TrashError(`${dir} belongs to someone else, so Launchpad won’t use it as a trash.`, true);
  } else {
    try {
      if (home) await mkdirp(sftp, path.posix.dirname(dir));
      await mkdir(sftp, dir);
    } catch (e) {
      throw new TrashError(`There’s no trash on ${mount}, and Launchpad can’t make one at ${dir} (${(e as Error).message}).`, true);
    }
  }
  for (const sub of ['files', 'info']) {
    const p = `${dir}/${sub}`;
    const s = await lstat(sftp, p).catch(() => null);
    if (!s) await mkdir(sftp, p).catch((e) => Promise.reject(new TrashError(`Couldn’t make ${p}: ${(e as Error).message}`, true)));
    else if (!isRealDir(s)) throw new TrashError(`${p} isn’t a folder, so Launchpad won’t use that trash.`, true);
  }
  ready.set(dir, Date.now());
}

/** Write the .trashinfo under the first free name, claiming it (O_EXCL) before anything moves. */
async function reserve(sftp: SFTPWrapper, dir: string, base: string, info: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const id = numberedName(base, n);
    if (Buffer.byteLength(id) > 240) throw new TrashError('That name is too long for the trash.', true);
    if (await lstat(sftp, `${dir}/files/${id}`).catch(() => null)) continue;
    const infoPath = `${dir}/info/${id}.trashinfo`;
    let handle: Buffer;
    try {
      handle = await call<Buffer>(infoPath, (cb) => sftp.open(infoPath, 'wx', { mode: 0o600 }, cb));
    } catch (e) {
      if (await lstat(sftp, infoPath).catch(() => null)) continue;
      throw e;
    }
    const buf = Buffer.from(info, 'utf8');
    try {
      await call<void>(infoPath, (cb) => sftp.write(handle, buf, 0, buf.length, 0, cb));
    } finally {
      await call<void>(infoPath, (cb) => sftp.close(handle, cb)).catch(() => {});
    }
    return id;
  }
  throw new TrashError('The trash has too many things with that name.', true);
}

// ---------- deleting ----------

export const MAX_BATCH = 1000;

/** A list of absolute paths from the page, without repeats. */
export function cleanPaths(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length) throw new FileError('Nothing was chosen.');
  if (list.length > MAX_BATCH) throw new FileError(`That’s more than ${MAX_BATCH} at once.`);
  return [...new Set(list.map(cleanPath))];
}

/** Move these to the trash. Each goes or fails on its own; what failed says why, and whether it could be deleted for good instead. */
export async function trashPaths(input: unknown): Promise<TrashOutcome> {
  const paths = cleanPaths(input);
  const { sftp } = await sftpSession();
  const place = await getPlace();
  const stats = new Map(await Promise.all(paths.map(async (p) => [p, await lstat(sftp, p).catch(() => null)] as const)));
  // The folder each is in decides its trash; a folder of its own may be a mount point, which can't move.
  const ask = new Set<string>();
  for (const p of paths) {
    if (p !== '/') ask.add(path.posix.dirname(p));
    if (stats.get(p) && kindOf(stats.get(p)!.mode) === 'dir') ask.add(p);
  }
  const mounts = await mountsOf([...ask]);
  const out: TrashOutcome = { trashed: [], failed: [] };
  for (const p of paths) {
    try {
      out.trashed.push(await trashOne(sftp, p, stats.get(p) ?? null, place, mounts));
    } catch (e) {
      const permanentOk = e instanceof TrashError ? e.permanentOk : !(e instanceof FileError && (e.status === 403 || e.status === 404));
      out.failed.push({ path: p, error: (e as Error).message, permanentOk });
    }
  }
  return out;
}

async function trashOne(sftp: SFTPWrapper, p: string, st: Stats | null, place: Place, mounts: Map<string, string>): Promise<{ path: string; trash: string; id: string }> {
  const name = path.posix.basename(p);
  if (p === '/') throw new TrashError('Launchpad won’t delete the root folder.', false, 400);
  if (!st) throw new TrashError(`${name} isn’t there any more.`, false, 404);
  const mount = mounts.get(path.posix.dirname(p));
  if (!mount) throw new TrashError(`Couldn’t tell which disk ${name} is on.`, true, 500);
  if (kindOf(st.mode) === 'dir' && mounts.get(p) === p) throw new TrashError(`${name} is where a disk is mounted, so it can’t be moved to the trash.`, false);
  const dir = trashDirFor(mount, place);
  if (p === dir || dir.startsWith(p + '/')) throw new TrashError(`${name} holds the trash itself, so it can’t go in it.`, true);
  if (p.startsWith(dir + '/')) throw new TrashError(`${name} is in the trash already.`, true);
  await ensureTrash(sftp, dir, place, mount);
  const id = await reserve(sftp, dir, name, formatTrashInfo(p, topdirOf(dir, place), new Date(), place.offsetMin));
  try {
    await call<void>(p, (cb) => sftp.rename(p, `${dir}/files/${id}`, cb));
  } catch (e) {
    await call<void>(dir, (cb) => sftp.unlink(`${dir}/info/${id}.trashinfo`, cb)).catch(() => {});
    if (e instanceof FileError && e.status === 403) throw new TrashError(`Permission denied: ${p}`, false, 403);
    throw new TrashError(`Couldn’t move ${name} to the trash in ${dir}: ${(e as Error).message}`, true, 500);
  }
  return { path: p, trash: dir, id };
}

// ---------- the trash's contents ----------

/** Mount points from /proc/mounts, without the kernel's own filesystems or Docker's layers. */
export function parseMounts(text: string): string[] {
  const skip = new Set(['proc', 'sysfs', 'devpts', 'devtmpfs', 'cgroup', 'cgroup2', 'securityfs', 'pstore', 'bpf', 'tracefs', 'debugfs', 'configfs', 'fusectl', 'mqueue', 'hugetlbfs', 'autofs', 'binfmt_misc', 'rpc_pipefs', 'nsfs', 'overlay', 'squashfs', 'efivarfs', 'ramfs', 'selinuxfs']);
  const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const f = line.split(' ');
    if (f.length < 3 || skip.has(f[2])) continue;
    const m = unescape(f[1]);
    if (m.startsWith('/') && !m.startsWith('/proc') && !m.startsWith('/sys') && !m.startsWith('/dev') && !m.startsWith('/run') && !m.includes('/docker/') && !m.startsWith('/snap/')) seen.add(m);
  }
  return [...seen];
}

/** The home trash and every disk's trash of ours that's there. */
export async function trashDirs(sftp: SFTPWrapper, place: Place): Promise<string[]> {
  const r = await runCommand('cat /proc/mounts 2>/dev/null', 10_000).catch(() => ({ stdout: '' }));
  const dirs = new Set([place.homeTrash]);
  const found = await Promise.all(
    parseMounts(r.stdout).map(async (m) => {
      const d = path.posix.join(m, `.Trash-${place.uid}`);
      const st = await lstat(sftp, d).catch(() => null);
      return st && isRealDir(st) && st.uid === place.uid ? d : null;
    }),
  );
  for (const d of found) if (d) dirs.add(d);
  return [...dirs];
}

const MAX_LISTED = 3000;

async function inBatches<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  return out;
}

async function itemsIn(sftp: SFTPWrapper, dir: string, place: Place): Promise<TrashItem[]> {
  const list = await call<{ filename: string }[]>(dir, (cb) => sftp.readdir(`${dir}/info`, cb)).catch(() => []);
  const topdir = topdirOf(dir, place);
  const names = list.map((f) => f.filename).filter((n) => n.endsWith('.trashinfo')).slice(0, MAX_LISTED);
  const items = await inBatches(names, 16, async (n): Promise<TrashItem | null> => {
    const id = n.slice(0, -'.trashinfo'.length);
    if (!id) return null;
    const [text, st] = await Promise.all([
      call<Buffer>(n, (cb) => sftp.readFile(`${dir}/info/${n}`, cb)).catch(() => null),
      lstat(sftp, `${dir}/files/${id}`).catch(() => null),
    ]);
    // Info without the thing itself: emptied by something else. Left alone.
    if (!text || !st) return null;
    const info = parseTrashInfo(text.toString('utf8'), topdir, place.offsetMin);
    if (!info) return null;
    const kind = kindOf(st.mode);
    return { trash: dir, id, path: info.path, deletedAt: info.deletedAt, ours: info.ours, kind: kind === 'link' ? 'other' : kind, size: kind === 'file' ? st.size : 0 };
  });
  return items.filter((x): x is TrashItem => !!x);
}

export async function listTrash(): Promise<TrashListing> {
  const { sftp } = await sftpSession();
  const place = await getPlace();
  const trashes = await trashDirs(sftp, place);
  const items = (await Promise.all(trashes.map((d) => itemsIn(sftp, d, place)))).flat();
  items.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  return { items, trashes };
}

interface ItemRef {
  trash: string;
  id: string;
}

/** Items the page names, checked against the trashes that are really there. */
async function cleanItems(v: unknown, sftp: SFTPWrapper, place: Place): Promise<ItemRef[]> {
  if (!Array.isArray(v) || !v.length) throw new FileError('Nothing was chosen.');
  if (v.length > MAX_BATCH) throw new FileError(`That’s more than ${MAX_BATCH} at once.`);
  const known = new Set(await trashDirs(sftp, place));
  return v.map((x) => {
    const trash = cleanPath((x as ItemRef)?.trash);
    if (!known.has(trash)) throw new FileError(`${trash} isn’t a trash Launchpad knows.`, 404);
    return { trash, id: cleanName((x as ItemRef)?.id) };
  });
}

/** A trash's files and info folders as real paths, refusing one where either is a link or not a folder. */
async function trashFolders(sftp: SFTPWrapper, trash: string): Promise<{ files: string; info: string }> {
  const real = await call<string>(trash, (cb) => sftp.realpath(trash, cb));
  const out: Record<string, string> = {};
  for (const sub of ['files', 'info']) {
    const st = await lstat(sftp, `${trash}/${sub}`).catch(() => null);
    if (!isRealDir(st)) throw new FileError(`${trash}/${sub} isn’t a folder, so Launchpad won’t delete in it.`, 409);
    const r = await call<string>(trash, (cb) => sftp.realpath(`${trash}/${sub}`, cb));
    if (r !== path.posix.join(real, sub)) throw new FileError(`${trash}/${sub} leads somewhere else, so Launchpad won’t delete in it.`, 409);
    out[sub] = r;
  }
  return out as { files: string; info: string };
}

/** Put these back where they were, under a numbered name if something has taken their place. */
export async function restoreItems(v: unknown): Promise<{ restored: { path: string; as: string }[]; failed: { id: string; error: string }[] }> {
  const { sftp } = await sftpSession();
  const place = await getPlace();
  const items = await cleanItems(v, sftp, place);
  const restored: { path: string; as: string }[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const it of items) {
    try {
      const text = await call<Buffer>(it.id, (cb) => sftp.readFile(`${it.trash}/info/${it.id}.trashinfo`, cb));
      const info = parseTrashInfo(text.toString('utf8'), topdirOf(it.trash, place), place.offsetMin);
      if (!info) throw new FileError('Its trash record can’t be read, so Launchpad doesn’t know where it came from.', 409);
      const dir = path.posix.dirname(info.path);
      await mkdirp(sftp, dir);
      let target = info.path;
      for (let n = 2; await lstat(sftp, target).catch(() => null); n++) {
        if (n > 1000) throw new FileError(`There’s no free name for it in ${dir}.`, 409);
        target = path.posix.join(dir, numberedName(path.posix.basename(info.path), n));
      }
      await call<void>(target, (cb) => sftp.rename(`${it.trash}/files/${it.id}`, target, cb));
      await call<void>(it.id, (cb) => sftp.unlink(`${it.trash}/info/${it.id}.trashinfo`, cb)).catch(() => {});
      restored.push({ path: info.path, as: target });
    } catch (e) {
      failed.push({ id: it.id, error: (e as Error).message });
    }
  }
  return { restored, failed };
}

/** rm -rf of exactly these names inside a checked trash, and their info files. */
async function deleteIn(sftp: SFTPWrapper, trash: string, ids: string[], signal?: AbortSignal): Promise<void> {
  const { files, info } = await trashFolders(sftp, trash);
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const cmd = `rm -rf -- ${chunk.map((id) => shellQuote(`${files}/${id}`)).join(' ')} && rm -f -- ${chunk.map((id) => shellQuote(`${info}/${id}.trashinfo`)).join(' ')}`;
    const r = await runRemote(cmd, { timeout: 6 * 60 * 60_000, signal }).done;
    if (r.stopped) throw new Error(r.stopped === 'cancel' ? 'Stopped. Some of it may be deleted already.' : 'Deleting took too long.');
    if (r.code) throw new FileError(r.stderr.replace(/^rm: /gm, '') || `rm exited with ${r.code}`, 500);
  }
}

/** Delete these trash items for good. Run as a job: a big folder takes a while. */
export async function deleteItems(v: unknown, signal?: AbortSignal): Promise<number> {
  const { sftp } = await sftpSession();
  const place = await getPlace();
  const items = await cleanItems(v, sftp, place);
  const byTrash = new Map<string, string[]>();
  for (const it of items) byTrash.set(it.trash, [...(byTrash.get(it.trash) ?? []), it.id]);
  for (const [trash, ids] of byTrash) await deleteIn(sftp, trash, ids, signal);
  return items.length;
}

/** Everything in every trash, for good. */
export async function emptyTrash(signal?: AbortSignal): Promise<void> {
  const { sftp } = await sftpSession();
  const place = await getPlace();
  for (const trash of await trashDirs(sftp, place)) {
    const { files, info } = await trashFolders(sftp, trash).catch(() => ({ files: '', info: '' }));
    if (!files) continue;
    const cmd = [
      `find ${shellQuote(files)} -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      `find ${shellQuote(info)} -mindepth 1 -maxdepth 1 -name '*.trashinfo' -exec rm -f -- {} +`,
      `rm -f -- ${shellQuote(path.posix.join(path.posix.dirname(files), 'directorysizes'))}`,
    ].join('; ');
    const r = await runRemote(cmd, { timeout: 6 * 60 * 60_000, signal }).done;
    if (r.stopped) throw new Error(r.stopped === 'cancel' ? 'Stopped. Some of it may be deleted already.' : 'Emptying took too long.');
    if (r.code) throw new FileError(r.stderr.replace(/^(rm|find): /gm, '') || `Emptying ${trash} didn’t finish.`, 500);
  }
}

/** What Launchpad put in the trash more than TRASH_DAYS ago. */
export const expired = (items: TrashItem[], now = Date.now()) => items.filter((i) => i.ours && now - Date.parse(i.deletedAt) > TRASH_DAYS * 24 * 60 * 60_000);

/** Empty what Launchpad trashed over a week ago; what other tools trashed is theirs to empty. */
export async function purgeTrash(now = Date.now()): Promise<number> {
  if (!shellConfigured()) return 0;
  const old = expired((await listTrash()).items, now);
  if (old.length) await deleteItems(old.map(({ trash, id }) => ({ trash, id })));
  return old.length;
}
