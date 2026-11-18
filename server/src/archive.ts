// Unpacking and making archives on the server, with whatever tools it has.
//
// extractArchive() needs no page: it unpacks into a new folder next to the archive (or
// in a folder given), never into one that's there, so nothing existing is overwritten.
// Before unpacking it lists the archive and refuses one that would write outside that
// folder (absolute paths, "..", or files unpacked through a link it also holds), and one
// that wouldn't fit on the disk. Downloads finishing can call it the same way the page does.
//
// .zip uses unzip, else bsdtar, 7-Zip or Python; tar files use tar (with xz, bzip2 or
// zstd for those); .7z needs 7-Zip and .rar unrar (or 7-Zip). A missing tool is named
// with the package to install.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { SFTPWrapper, Stats } from 'ssh2';
import { call, cleanPath, FileError, kindOf, runCommand, sftpSession, shellQuote } from './shell';
import { runRemote, type RemoteResult } from './remote';
import { parseDf } from './trash';
import { archiveOf, numberedName, type ArchiveKind } from '../../shared/files';

// ---------- tools ----------

const TOOLS = ['tar', 'gzip', 'xz', 'bzip2', 'zstd', 'unzip', 'zip', 'bsdtar', '7z', '7za', '7zz', 'unrar', 'python3', 'rg'];
let toolCache: { tools: Set<string>; at: number } | null = null;

/** Which of the tools Launchpad can use are on the server, looked up at most every 5 minutes. */
export async function hostTools(fresh = false): Promise<Set<string>> {
  if (!fresh && toolCache && Date.now() - toolCache.at < 5 * 60_000) return toolCache.tools;
  const r = await runCommand(`for t in ${TOOLS.join(' ')}; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true`, 15_000);
  const tools = new Set(r.stdout.split('\n').map((s) => s.trim()).filter((t) => TOOLS.includes(t)));
  toolCache = { tools, at: Date.now() };
  return tools;
}

const sevenZip = (t: Set<string>) => ['7z', '7zz', '7za'].find((x) => t.has(x)) ?? null;

const INSTALL: Record<string, string> = {
  zip: 'To unpack .zip files, install unzip on the server (sudo apt install unzip).',
  tar: 'To unpack tar files, install tar on the server (sudo apt install tar).',
  xz: 'To unpack .tar.xz files, install xz on the server (sudo apt install xz-utils).',
  bzip2: 'To unpack .tar.bz2 files, install bzip2 on the server (sudo apt install bzip2).',
  zstd: 'To unpack .tar.zst files, install zstd on the server (sudo apt install zstd).',
  gzip: 'To unpack .tar.gz files, install gzip on the server (sudo apt install gzip).',
  '7z': 'To unpack .7z files, install 7-Zip on the server (sudo apt install 7zip, or p7zip-full on older systems).',
  rar: 'To unpack .rar files, install unrar on the server (sudo apt install unrar).',
};

/** The tar compressor an archive's name says it needs. */
function compressorOf(name: string): string | null {
  if (/\.(tar\.xz|txz)$/i.test(name)) return 'xz';
  if (/\.(tar\.bz2|tbz2?)$/i.test(name)) return 'bzip2';
  if (/\.(tar\.zst|tzst)$/i.test(name)) return 'zstd';
  if (/\.(tar\.gz|tgz)$/i.test(name)) return 'gzip';
  return null;
}

// ---------- listing ----------

export interface Member {
  /** As the archive has it. */
  name: string;
  type: 'file' | 'dir' | 'link' | 'hardlink' | 'other';
  size: number;
  /** For a hard link, what it links to. */
  target?: string;
}

const typeOfPerm = (c: string): Member['type'] => (c === 'd' ? 'dir' : c === 'l' ? 'link' : c === 'h' ? 'hardlink' : c === '-' ? 'file' : 'other');

/** `unzip -Z`: permissions, version, system, size, type, method, date, time, name. */
export function parseZipInfo(out: string): Member[] {
  const ms: Member[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S)\S*\s+\d+\.\d+\s+\S+\s+(\d+)\s+\S+\s+\S+\s+\S+\s+\d\d:\d\d\s(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const name = m[3];
    ms.push({ name, type: name.endsWith('/') ? 'dir' : typeOfPerm(m[1]), size: Number(m[2]) });
  }
  return ms;
}

/** `tar --numeric-owner -tvf`, as GNU tar prints it: links as "name -> target", hard links as "name link to target". */
export function parseTarList(out: string): Member[] {
  const ms: Member[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S)\S{9,}\s+\S+\s+(\d+(?:,\s*\d+)?)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s(.*)$/.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const type = typeOfPerm(m[1]);
    let name = m[3];
    let target: string | undefined;
    if (type === 'link') name = name.split(' -> ')[0];
    if (type === 'hardlink') {
      const i = name.indexOf(' link to ');
      if (i >= 0) [name, target] = [name.slice(0, i), name.slice(i + ' link to '.length)];
    }
    ms.push({ name, type, size: type === 'file' ? Number(m[2]) || 0 : 0, target });
  }
  return ms;
}

/** `7z l -slt`: a block of "Key = value" lines per file, after the archive's own block and a line of dashes. */
export function parse7zList(out: string): Member[] {
  const after = out.split(/\r?\n----------\r?\n/).slice(1).join('\n----------\n');
  const ms: Member[] = [];
  for (const block of after.split(/\r?\n\s*\r?\n/)) {
    const f: Record<string, string> = {};
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' = ');
      if (i > 0) f[line.slice(0, i).trim()] = line.slice(i + 3);
    }
    if (!f.Path) continue;
    const attrs = f.Attributes ?? '';
    const unix = / ([dl-])[rwxsStT-]{9}/.exec(attrs)?.[1];
    const dir = f.Folder === '+' || attrs.startsWith('D') || unix === 'd';
    const link = unix === 'l' || (!!f['Symbolic Link'] && f['Symbolic Link'] !== '-');
    ms.push({ name: f.Path, type: dir ? 'dir' : link ? 'link' : 'file', size: Number(f.Size) || 0 });
  }
  return ms;
}

/** `unrar lt`: "Name:", "Type:", "Size:" (and "Target:" for links) per file. */
export function parseUnrarList(out: string): Member[] {
  const ms: Member[] = [];
  let cur: Member | null = null;
  for (const raw of out.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z ]+):\s(.*)$/.exec(raw);
    if (!m) continue;
    const [k, v] = [m[1].trim(), m[2]];
    if (k === 'Name') {
      cur = { name: v, type: 'file', size: 0 };
      ms.push(cur);
    } else if (cur && k === 'Type') {
      cur.type = /director/i.test(v) ? 'dir' : /hard link/i.test(v) ? 'hardlink' : /link/i.test(v) ? 'link' : /file/i.test(v) ? 'file' : 'other';
    } else if (cur && k === 'Size') cur.size = Number(v.trim()) || 0;
    else if (cur && k === 'Target' && cur.type === 'hardlink') cur.target = v;
  }
  return ms;
}

/** Python's zipfile, one JSON line a file, for a server without unzip. */
const PY_LIST = `import json,sys,zipfile
for i in zipfile.ZipFile(sys.argv[1]).infolist():
    m=(i.external_attr>>16)&0o170000
    print(json.dumps([i.filename,'dir' if i.is_dir() else 'link' if m==0o120000 else 'file',i.file_size]))`;

export function parsePyList(out: string): Member[] {
  return out.split('\n').flatMap((line) => {
    try {
      const [name, type, size] = JSON.parse(line) as [string, Member['type'], number];
      return typeof name === 'string' ? [{ name, type, size: Number(size) || 0 }] : [];
    } catch {
      return [];
    }
  });
}

/** Most files an archive may have; past that it isn't checked, so it isn't unpacked here. */
export const MAX_MEMBERS = 200_000;

const parts = (name: string) => name.split(/[\\/]+/).filter((p) => p && p !== '.');
const absolute = (name: string) => /^([\\/]|[A-Za-z]:)/.test(name);

/** Why unpacking these could write outside the new folder, or null when it can't. */
export function checkMembers(ms: Member[]): string | null {
  if (ms.length > MAX_MEMBERS) return `It has more than ${MAX_MEMBERS.toLocaleString('en-US')} files, too many to check first. Unpack it in the terminal if you trust it.`;
  const links = new Set<string>();
  for (const m of ms) if (m.type === 'link') links.add(parts(m.name).join('/'));
  for (const m of ms) {
    const p = parts(m.name);
    if (absolute(m.name)) return `It has files with absolute paths (like ${m.name}), which would land outside the new folder.`;
    if (p.includes('..')) return `It has files that climb out of their folder (like ${m.name}).`;
    if (m.target !== undefined && (absolute(m.target) || parts(m.target).includes('..'))) return `It has a link that points out of the new folder (${m.name}).`;
    for (let i = 1; i < p.length; i++) {
      if (links.has(p.slice(0, i).join('/'))) return `It unpacks files through a link it also holds (${p.slice(0, i).join('/')}), which could write anywhere.`;
    }
  }
  return null;
}

// ---------- unpacking ----------

export interface Plan {
  tool: string;
  list: string | null;
  parse: (out: string) => Member[];
  extract: (dest: string) => string;
}

/** How to list and unpack `file` with the tools there are; a FileError says what to install. */
export function planExtract(kind: ArchiveKind, file: string, tools: Set<string>): Plan {
  const q = shellQuote(file);
  const sz = sevenZip(tools);
  const seven = (tool: string): Plan => ({ tool, list: `${tool} l -slt -- ${q}`, parse: parse7zList, extract: (d) => `${tool} x -bd -y -aos ${shellQuote('-o' + d)} -- ${q}` });
  if (kind === 'tar') {
    if (!tools.has('tar')) throw new FileError(INSTALL.tar, 415);
    const c = compressorOf(file);
    if (c && !tools.has(c)) throw new FileError(INSTALL[c], 415);
    return { tool: 'tar', list: `tar --numeric-owner -tvf ${q}`, parse: parseTarList, extract: (d) => `tar -xf ${q} -C ${shellQuote(d)} --no-same-owner` };
  }
  if (kind === 'zip') {
    if (tools.has('unzip')) return { tool: 'unzip', list: `unzip -Z ${q}`, parse: parseZipInfo, extract: (d) => `unzip -qq -n ${q} -d ${shellQuote(d)}` };
    // libarchive refuses absolute paths, ".." and writing through links by itself.
    if (tools.has('bsdtar')) return { tool: 'bsdtar', list: null, parse: () => [], extract: (d) => `bsdtar -xf ${q} -C ${shellQuote(d)}` };
    if (sz) return seven(sz);
    if (tools.has('python3'))
      return { tool: 'python3', list: `python3 -c ${shellQuote(PY_LIST)} ${q}`, parse: parsePyList, extract: (d) => `python3 -c ${shellQuote('import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])')} ${q} ${shellQuote(d)}` };
    throw new FileError(INSTALL.zip, 415);
  }
  if (kind === '7z') {
    if (sz) return seven(sz);
    throw new FileError(INSTALL['7z'], 415);
  }
  if (tools.has('unrar')) return { tool: 'unrar', list: `unrar lt -p- -- ${q}`, parse: parseUnrarList, extract: (d) => `unrar x -o- -p- -idq -- ${q} ${shellQuote(d + '/')}` };
  if (sz) return seven(sz);
  throw new FileError(INSTALL.rar, 415);
}

/** What went wrong, from the tool's own words where they're clear. */
export function extractError(tool: string, r: RemoteResult): string {
  const err = r.stderr;
  if (/password|encrypted/i.test(err)) return 'It’s password-protected. Unpack it in the terminal, where you can type the password.';
  if (/no space left/i.test(err)) return 'The disk filled up while unpacking.';
  if (/cannot exec|not found/i.test(err) && /xz|bzip2|zstd|gzip/.test(err)) return 'The server is missing the tool for this kind of compression. ' + (err.split('\n')[0] ?? '');
  if (/not a zip|end-of-central|unexpected end|not in gzip format|truncated|corrupt|crc error|data error|can ?not open/i.test(err)) return `It looks damaged or incomplete: ${err.split('\n').find((l) => l.trim()) ?? ''}`.trim();
  const first = err.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join(' ');
  return first ? `${tool}: ${first}` : `${tool} stopped with code ${r.code}.`;
}

const lstat = (sftp: SFTPWrapper, p: string) => call<Stats>(p, (cb) => sftp.lstat(p, cb));

/** The first free name for `name` in `dir`: name, then name (2)… */
export async function freeName(sftp: SFTPWrapper, dir: string, name: string): Promise<string> {
  for (let n = 1; n <= 1000; n++) {
    const p = path.posix.join(dir, numberedName(name, n));
    if (!(await lstat(sftp, p).catch(() => null))) return p;
  }
  throw new FileError(`There’s no free name like ${name} in ${dir}.`, 409);
}

export function fmtSize(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) {
    n /= 1000;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(n >= 10 ? 1 : 2)} ${units[i]}`;
}

/** A failure partway, saying where what was unpacked so far is. */
export class ExtractError extends FileError {
  constructor(message: string, readonly folder: string | null) {
    super(message, 500);
  }
}

export interface ExtractOptions {
  signal?: AbortSignal;
  /** What it's doing now, for a progress line. */
  progress?: (message: string) => void;
  /** For each step; unpacking itself defaults to 12 hours. */
  timeout?: number;
}

/** Whether `file` can be unpacked here, before a job is started for it: its kind, that it's a file, and the tools. */
export async function checkExtract(file: string): Promise<{ a: { kind: ArchiveKind; stem: string }; plan: Plan }> {
  const abs = cleanPath(file);
  const a = archiveOf(path.posix.basename(abs));
  if (!a) throw new FileError(`${path.posix.basename(abs)} isn’t an archive Launchpad can unpack (.zip, .tar, .tar.gz, .tar.xz, .tar.bz2, .7z or .rar).`, 415);
  const { sftp } = await sftpSession();
  const st = await lstat(sftp, abs).catch(() => null);
  if (!st || kindOf(st.mode) !== 'file') throw new FileError(`${abs} isn’t a file.`, 404);
  return { a, plan: planExtract(a.kind, abs, await hostTools()) };
}

/**
 * Unpack `file` into a new folder in `parentDir` (the archive's own folder by default),
 * named after the archive: "photos.zip" unpacks into "photos", or "photos (2)" if that's
 * taken. An archive holding just one folder unpacks as that folder, without another
 * around it. Returns the folder made and the tool used.
 */
export async function extractArchive(file: string, parentDir?: string, opts: ExtractOptions = {}): Promise<{ folder: string; tool: string }> {
  const abs = cleanPath(file);
  const parent = parentDir ? cleanPath(parentDir) : path.posix.dirname(abs);
  const { a, plan } = await checkExtract(abs);
  const { sftp } = await sftpSession();
  const step = opts.timeout ?? 12 * 60 * 60_000;

  if (plan.list) {
    opts.progress?.('Checking what’s in it…');
    const r = await runRemote(plan.list, { timeout: Math.min(step, 60 * 60_000), maxOutput: 64 * 1024 * 1024, signal: opts.signal }).done;
    if (r.stopped === 'cancel') throw new FileError('Stopped before unpacking anything.', 409);
    if (r.stopped === 'limit') throw new FileError('It has too many files to check first. Unpack it in the terminal if you trust it.', 413);
    if (r.stopped) throw new FileError('Checking it took too long.', 500);
    const members = plan.parse(r.stdout);
    if (r.code || !members.length) throw new FileError(r.code ? extractError(plan.tool, r) : 'It looks empty, or Launchpad couldn’t read its list of files.', 415);
    const bad = checkMembers(members);
    if (bad) throw new FileError(`Launchpad won’t unpack this. ${bad}`, 409);
    const need = members.reduce((n, m) => n + m.size, 0);
    const df = await runCommand(`df -Pk -- ${shellQuote(parent)} | tail -n 1`, 15_000).catch(() => null);
    const free = df ? parseDf(df.stdout)?.availKb : undefined;
    if (free !== undefined && need > free * 1024) throw new FileError(`It needs ${fmtSize(need)} unpacked and the disk has ${fmtSize(free * 1024)} free.`, 413);
  }

  const folder = await freeName(sftp, parent, a.stem || 'archive');
  await call<void>(folder, (cb) => sftp.mkdir(folder, { mode: 0o755 }, cb));
  opts.progress?.(`Unpacking into ${path.posix.basename(folder)}…`);
  const r = await runRemote(plan.extract(folder), { timeout: step, signal: opts.signal }).done;
  const where = `What was unpacked so far is in ${path.posix.basename(folder)}.`;
  if (r.stopped === 'cancel') throw new ExtractError(`Stopped. ${where}`, folder);
  if (r.stopped) throw new ExtractError(`Unpacking took too long. ${where}`, folder);
  // unzip -n says 1 for warnings (a file skipped), which still unpacked the rest.
  if (r.code && !(plan.tool === 'unzip' && r.code === 1)) throw new ExtractError(`${extractError(plan.tool, r)} ${where}`, folder);
  return { folder: await lift(sftp, folder, parent), tool: plan.tool };
}

/** An archive of one folder unpacks as that folder, not inside another of the archive's name. */
async function lift(sftp: SFTPWrapper, folder: string, parent: string): Promise<string> {
  const list = await call<{ filename: string; attrs: Stats }[]>(folder, (cb) => sftp.readdir(folder, cb)).catch(() => []);
  if (list.length !== 1 || kindOf(list[0].attrs.mode) !== 'dir') return folder;
  const inner = list[0].filename;
  try {
    // Out of the wrapper to a name of its own, then the empty wrapper goes.
    const tmp = path.posix.join(parent, `.launchpad-unpack-${randomBytes(6).toString('hex')}`);
    await call<void>(tmp, (cb) => sftp.rename(path.posix.join(folder, inner), tmp, cb));
    await call<void>(folder, (cb) => sftp.rmdir(folder, cb));
    const target = await freeName(sftp, parent, inner);
    await call<void>(target, (cb) => sftp.rename(tmp, target, cb));
    return target;
  } catch {
    // Wherever it got to, everything is still there; leave it.
    return folder;
  }
}

// ---------- compressing ----------

export type PackFormat = 'zip' | 'tar.gz';

/** How to make the archive `tmp` of `names` (all in `dir`), with the tools there are. */
export function planCompress(format: PackFormat, dir: string, names: string[], tmp: string, tools: Set<string>): { tool: string; cmd: string } {
  const cd = `cd ${shellQuote(dir)} && `;
  const rel = names.map((n) => shellQuote('./' + n)).join(' ');
  const t = shellQuote(tmp);
  if (format === 'tar.gz') {
    if (!tools.has('tar') || !tools.has('gzip')) throw new FileError('To make a .tar.gz, install tar and gzip on the server (sudo apt install tar gzip).', 415);
    return { tool: 'tar', cmd: `${cd}tar -czf ${t} -- ${names.map(shellQuote).join(' ')}` };
  }
  if (tools.has('zip')) return { tool: 'zip', cmd: `${cd}zip -r -q -y ${t} ${rel}` };
  const sz = sevenZip(tools);
  if (sz) return { tool: sz, cmd: `${cd}${sz} a -tzip -bd -snl ${t} ${rel}` };
  if (tools.has('bsdtar')) return { tool: 'bsdtar', cmd: `${cd}bsdtar --format zip -cf ${t} ${rel}` };
  if (tools.has('python3')) return { tool: 'python3', cmd: `${cd}python3 -m zipfile -c ${t} ${rel}` };
  throw new FileError('To make a .zip on the server, install zip there (sudo apt install zip), or make a .tar.gz instead.', 415);
}

/** Whether these can be packed, before a job is started: one folder, not the root, and a tool for the format. */
export async function checkCompress(paths: string[], format: PackFormat) {
  if (!paths.length) throw new FileError('Nothing was chosen.');
  const dir = path.posix.dirname(paths[0]);
  if (paths.some((p) => path.posix.dirname(p) !== dir)) throw new FileError('Everything to pack has to be in the same folder.');
  if (paths.includes('/')) throw new FileError('Launchpad won’t pack the whole disk.');
  const names = paths.map((p) => path.posix.basename(p));
  const ext = format === 'zip' ? '.zip' : '.tar.gz';
  const tmp = path.posix.join(dir, `.launchpad-pack-${randomBytes(6).toString('hex')}${ext}`);
  return { dir, names, ext, tmp, plan: planCompress(format, dir, names, tmp, await hostTools()) };
}

/** Pack these (all in one folder) into a .zip or .tar.gz beside them. Written under a hidden name and renamed when done, so a half-made archive never looks finished. */
export async function compressPaths(paths: string[], format: PackFormat, opts: ExtractOptions = {}): Promise<{ file: string; tool: string }> {
  const { dir, names, ext, tmp, plan } = await checkCompress(paths, format);
  const { sftp } = await sftpSession();
  opts.progress?.(`Packing ${names.length === 1 ? names[0] : `${names.length} items`}…`);
  const r = await runRemote(plan.cmd, { timeout: opts.timeout ?? 12 * 60 * 60_000, signal: opts.signal }).done;
  const failed = r.stopped || r.code;
  if (failed) {
    await call<void>(tmp, (cb) => sftp.unlink(tmp, cb)).catch(() => {});
    if (r.stopped === 'cancel') throw new FileError('Stopped. Nothing was kept.', 409);
    if (r.stopped) throw new FileError('Packing took too long.', 500);
    throw new FileError(/no space left/i.test(r.stderr) ? 'The disk filled up while packing.' : `${plan.tool}: ${r.stderr.split('\n').slice(0, 3).join(' ') || `stopped with code ${r.code}`}`, 500);
  }
  const target = await freeName(sftp, dir, (names.length === 1 ? names[0] : 'Archive') + ext);
  await call<void>(target, (cb) => sftp.rename(tmp, target, cb));
  return { file: target, tool: plan.tool };
}
