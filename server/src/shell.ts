// The Server view's terminal and file explorer. Launchpad runs in a container,
// so it reaches the machine's own shell and files by SSH, as SSH_USER and with
// that user's permissions. Its key is made on first use and kept in the data
// folder; the view shows the public half to add to ~/.ssh/authorized_keys. The
// host's key is trusted on the first connection and checked on every one after.
//
// A terminal is a WebSocket on /api/terminal: binary frames carry what's typed
// and what the shell prints, text frames carry JSON control messages. A shell
// outlives its socket for a while, so switching views or reloading picks it up
// where it was, with the recent output replayed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, utils, type ClientChannel, type SFTPWrapper, type Stats } from 'ssh2';
import type { WebSocket } from 'ws';
import { config } from './config';
import { store } from './store';
import type { DirListing, FileEntry, ShellInfo } from '../../shared/types';

const dir = path.join(config.dataDir, 'ssh');
const keyFile = path.join(dir, 'id_ed25519');
const hostFile = path.join(dir, 'known_host');

export const shellConfigured = () => !!(config.ssh.host && config.ssh.user);

const target = () => `${config.ssh.user}@${config.ssh.host}${config.ssh.port === 22 ? '' : `:${config.ssh.port}`}`;

let keys: { private: string; public: string } | null = null;

function keyPair() {
  if (keys) return keys;
  if (!fs.existsSync(keyFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const k = utils.generateKeyPairSync('ed25519', { comment: 'launchpad' });
    fs.writeFileSync(keyFile, k.private, { mode: 0o600 });
    fs.writeFileSync(keyFile + '.pub', k.public + '\n');
  }
  keys = { private: fs.readFileSync(keyFile, 'utf8'), public: fs.readFileSync(keyFile + '.pub', 'utf8').trim() };
  return keys;
}

/** The fingerprint the host offered when it differed from the trusted one, until it's trusted. */
let offeredKey: string | null = null;

/** In the form ssh-keygen -l prints. */
const fingerprint = (key: Buffer) => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

function checkHostKey(key: Buffer): boolean {
  const fp = fingerprint(key);
  const known = fs.existsSync(hostFile) ? fs.readFileSync(hostFile, 'utf8').trim() : '';
  if (!known) {
    fs.writeFileSync(hostFile, fp + '\n');
    return true;
  }
  offeredKey = known === fp ? null : fp;
  return !offeredKey;
}

/** Trust the key the host offered last time, after it changed (a reinstall, say). */
export function trustHostKey(): void {
  if (offeredKey) fs.writeFileSync(hostFile, offeredKey + '\n');
  offeredKey = null;
}

export function shellInfo(guarded: boolean): ShellInfo {
  return { configured: shellConfigured(), target: shellConfigured() ? target() : null, publicKey: keyPair().public, newHostKey: offeredKey, guarded };
}

function connectError(e: Error & { level?: string; code?: string }, keyMismatch: boolean): Error {
  const where = `${config.ssh.host}:${config.ssh.port}`;
  if (keyMismatch) return new Error(`The server’s host key changed since Launchpad first connected to ${where}.`);
  if (e.level === 'client-authentication') return new Error(`${target()} didn’t accept Launchpad’s key. Add it to ~/.ssh/authorized_keys on the server.`);
  if (e.level === 'client-timeout') return new Error(`Timed out connecting to ${where}.`);
  if (e.code === 'ECONNREFUSED') return new Error(`Nothing is answering SSH at ${where}.`);
  if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') return new Error(`Can’t find the host ${config.ssh.host}.`);
  return new Error(`Couldn’t connect to ${where}: ${e.message}`);
}

function connect(): Promise<Client> {
  if (!shellConfigured()) return Promise.reject(new Error('SSH isn’t set up: set SSH_HOST and SSH_USER.'));
  return new Promise((resolve, reject) => {
    const conn = new Client();
    let ready = false;
    let keyMismatch = false;
    conn.on('ready', () => {
      ready = true;
      resolve(conn);
    });
    // After it's ready, a dropped connection shows up as 'close' on its channels.
    conn.on('error', (e) => (ready ? console.error('[ssh]', e.message) : reject(connectError(e, keyMismatch))));
    conn.connect({
      host: config.ssh.host,
      port: config.ssh.port,
      username: config.ssh.user,
      privateKey: keyPair().private,
      hostVerifier: (key: Buffer) => !(keyMismatch = !checkHostKey(key)),
      readyTimeout: 10_000,
      keepaliveInterval: 30_000,
    });
  });
}

// ---------- terminal ----------

const KEEP_DETACHED = 15 * 60_000;
const SCROLLBACK = 256 * 1024;

interface Session {
  id: string;
  conn: Client;
  stream: ClientChannel;
  /** Recent output, replayed when a page attaches again. */
  out: Buffer[];
  outBytes: number;
  ws: WebSocket | null;
  timer?: NodeJS.Timeout;
}

const sessions = new Map<string, Session>();

const clampSize = (v: unknown, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(2, Math.round(v))) : d);

function control(ws: WebSocket, msg: Record<string, unknown>) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function endSession(s: Session) {
  clearTimeout(s.timer);
  sessions.delete(s.id);
  s.conn.end();
}

function openShell(conn: Client, cols: number, rows: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => conn.shell({ term: 'xterm-256color', cols, rows }, (e, stream) => (e ? reject(e) : resolve(stream))));
}

async function newSession(ws: WebSocket, cols: number, rows: number): Promise<Session | null> {
  let conn: Client | null = null;
  try {
    conn = await connect();
    const stream = await openShell(conn, cols, rows);
    const s: Session = { id: crypto.randomUUID(), conn, stream, out: [], outBytes: 0, ws };
    const print = (d: Buffer) => {
      s.out.push(d);
      s.outBytes += d.length;
      while (s.outBytes > SCROLLBACK && s.out.length > 1) s.outBytes -= s.out.shift()!.length;
      if (s.ws?.readyState === s.ws?.OPEN) s.ws!.send(d);
    };
    stream.on('data', print);
    stream.stderr.on('data', print);
    stream.on('close', () => {
      if (s.ws) {
        control(s.ws, { type: 'exit' });
        s.ws.close(1000);
      }
      endSession(s);
    });
    sessions.set(s.id, s);
    return s;
  } catch (e) {
    conn?.end();
    control(ws, { type: 'error', message: (e as Error).message });
    ws.close(1000);
    return null;
  }
}

/** Attach a terminal socket to the shell it had (`id`), or to a new one. */
export async function attachTerminal(ws: WebSocket, id: string | null, cols: number, rows: number): Promise<void> {
  cols = clampSize(cols, 500, 80);
  rows = clampSize(rows, 200, 24);
  let s = id ? sessions.get(id) : undefined;
  if (s) {
    clearTimeout(s.timer);
    // The same shell open in another tab moves here.
    if (s.ws && s.ws !== ws) {
      control(s.ws, { type: 'taken' });
      s.ws.close(1000);
    }
    s.ws = ws;
    s.stream.setWindow(rows, cols, 0, 0);
    control(ws, { type: 'session', id: s.id, resumed: true });
    for (const b of s.out) ws.send(b);
  } else {
    s = (await newSession(ws, cols, rows)) ?? undefined;
    if (!s) return;
    // The page went away while the shell was starting: keep it for when it comes back.
    if (ws.readyState !== ws.OPEN) {
      s.ws = null;
      s.timer = setTimeout(() => endSession(s!), KEEP_DETACHED);
      return;
    }
    control(ws, { type: 'session', id: s.id, resumed: false });
  }
  const session = s;
  ws.on('message', (data: Buffer, binary: boolean) => {
    if (session.ws !== ws) return;
    if (binary) {
      session.stream.write(data);
      return;
    }
    let msg: { type?: string; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (msg.type === 'resize') session.stream.setWindow(clampSize(msg.rows, 200, 24), clampSize(msg.cols, 500, 80), 0, 0);
    if (msg.type === 'close') endSession(session);
  });
  ws.on('close', () => {
    if (session.ws !== ws) return;
    session.ws = null;
    if (sessions.has(session.id)) session.timer = setTimeout(() => endSession(session), KEEP_DETACHED);
  });
}

// ---------- files ----------

const IDLE = 5 * 60_000;

/** One SFTP connection shared by the file explorer, closed after a few idle minutes. */
let sftpConn: Promise<{ conn: Client; sftp: SFTPWrapper }> | null = null;
let sftpTimer: NodeJS.Timeout | undefined;

function sftpSession() {
  if (!sftpConn) {
    const p = connect().then(
      (conn) =>
        new Promise<{ conn: Client; sftp: SFTPWrapper }>((resolve, reject) => {
          conn.on('close', () => sftpConn === p && (sftpConn = null));
          conn.sftp((e, sftp) => (e ? (conn.end(), reject(e)) : resolve({ conn, sftp })));
        }),
    );
    sftpConn = p;
    p.catch(() => sftpConn === p && (sftpConn = null));
  }
  clearTimeout(sftpTimer);
  const p = sftpConn;
  sftpTimer = setTimeout(() => p.then(({ conn }) => conn.end()).catch(() => {}), IDLE);
  return p;
}

/** An error the page can show, with the HTTP status that fits it. */
export class FileError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 413 | 415 | 500 = 400) {
    super(message);
  }
}

function sftpError(e: Error & { code?: number }, p: string): Error {
  // SFTP status codes: 2 no such file, 3 permission denied, 4 failure (often "not empty" or "exists").
  if (e.code === 2) return new FileError(`${p} doesn’t exist.`, 404);
  if (e.code === 3) return new FileError(`Permission denied: ${p}`, 403);
  return new FileError(`${e.message} (${p})`, 500);
}

function call<T>(p: string, fn: (cb: (err: Error | null | undefined, v: T) => void) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((e, v) => (e ? reject(sftpError(e, p)) : resolve(v))));
}

/** An absolute path, normalised. Relative ones are refused rather than guessed at. */
export function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p.startsWith('/') || p.includes('\0')) throw new FileError('Expected an absolute path.');
  return path.posix.normalize(p).replace(/(.)\/+$/, '$1');
}

/** A single file or folder name. */
export function cleanName(n: unknown): string {
  if (typeof n !== 'string' || !n || n === '.' || n === '..' || n.includes('/') || n.includes('\0') || n.length > 255) throw new FileError('That isn’t a valid name.');
  return n;
}

const S_IFMT = 0o170000;

export function kindOf(mode: number): FileEntry['kind'] | 'link' {
  const t = mode & S_IFMT;
  return t === 0o040000 ? 'dir' : t === 0o100000 ? 'file' : t === 0o120000 ? 'link' : 'other';
}

const stat = (sftp: SFTPWrapper, p: string) => call<Stats>(p, (cb) => sftp.stat(p, cb));

/** A folder's contents, folders first. Without a path, the SSH user's home folder. */
export async function listDir(p?: string): Promise<DirListing> {
  const { sftp } = await sftpSession();
  const abs = await call<string>(p || '~', (cb) => sftp.realpath(p ? cleanPath(p) : '.', cb));
  const all = await call<{ filename: string; attrs: Stats }[]>(abs, (cb) => sftp.readdir(abs, cb));
  // Part files of uploads given up on long ago are cleared away as the folder is opened.
  const stale = all.filter((f) => stalePart(f.filename, f.attrs.mtime));
  if (stale.length) removeParts(sftp, abs, stale.map((f) => f.filename)).catch(() => {});
  const list = stale.length ? all.filter((f) => !stale.includes(f)) : all;
  const entries = await Promise.all(
    list.map(async ({ filename, attrs }): Promise<FileEntry> => {
      let kind = kindOf(attrs.mode);
      let { size, mtime, mode } = attrs;
      const link = kind === 'link';
      // A link shows what it points at; a broken one stays 'other'.
      if (link) {
        const t = await stat(sftp, path.posix.join(abs, filename)).catch(() => null);
        kind = t ? kindOf(t.mode) : 'other';
        if (t) ({ size, mtime, mode } = t);
      }
      return { name: filename, kind: kind === 'link' ? 'other' : kind, link, size, mtime: new Date(mtime * 1000).toISOString(), mode: mode & 0o7777 };
    }),
  );
  entries.sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: abs, entries };
}

/** A file to send to the browser as a stream. */
export async function readFileStream(p: unknown): Promise<{ name: string; size: number; body: ReadableStream }> {
  const abs = cleanPath(p);
  const { sftp } = await sftpSession();
  const st = await stat(sftp, abs);
  if (kindOf(st.mode) !== 'file') throw new FileError(`${abs} isn’t a file.`);
  const stream = sftp.createReadStream(abs);
  return { name: path.posix.basename(abs), size: st.size, body: Readable.toWeb(stream) as ReadableStream };
}

export const MAX_TEXT = 1024 * 1024;

/** A text file for the editor: up to 1 MB, and not binary. */
export async function readText(p: unknown): Promise<{ path: string; text: string }> {
  const abs = cleanPath(p);
  const { sftp } = await sftpSession();
  const st = await stat(sftp, abs);
  if (kindOf(st.mode) !== 'file') throw new FileError(`${abs} isn’t a file.`);
  if (st.size > MAX_TEXT) throw new FileError('That file is over 1 MB. Download it instead.', 413);
  const buf = await call<Buffer>(abs, (cb) => sftp.readFile(abs, cb));
  if (buf.subarray(0, 8192).includes(0)) throw new FileError('That looks like a binary file. Download it instead.', 415);
  return { path: abs, text: buf.toString('utf8') };
}

export async function writeText(p: unknown, text: unknown): Promise<void> {
  const abs = cleanPath(p);
  if (typeof text !== 'string') throw new FileError('Expected the file’s text.');
  if (Buffer.byteLength(text) > MAX_TEXT) throw new FileError('That’s over 1 MB.', 413);
  const { sftp } = await sftpSession();
  await call<void>(abs, (cb) => sftp.writeFile(abs, text, { mode: 0o644 }, cb));
}

/**
 * Uploads come in pieces, since Cloudflare refuses any request body over 100 MB
 * (on the Free and Pro plans). Each piece is well under that, and quick enough to
 * stay inside Node's request timeout on a slow uplink. The pieces go into a hidden
 * file next to the destination, which takes the real name once the last one lands.
 */
export const UPLOAD_CHUNK = 32 * 1024 * 1024;

/** The id the page gives an upload, so its pieces find the same part file. */
export function cleanUploadId(id: unknown): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new FileError('That isn’t a valid upload.');
  return id;
}

/** A byte count from the query string. */
export function cleanSize(n: unknown, what: string): number {
  const v = typeof n === 'string' && /^\d{1,16}$/.test(n) ? Number(n) : NaN;
  if (!Number.isSafeInteger(v)) throw new FileError(`Expected the ${what} in bytes.`);
  return v;
}

const partPath = (dir: string, id: string) => path.posix.join(dir, `.launchpad-upload-${id}.part`);

/** A part file stops growing once its upload is given up on; after this long it's swept away. */
export const PART_MAX_AGE = 24 * 60 * 60_000;
const PART_NAME = /^\.launchpad-upload-[A-Za-z0-9-]{8,64}\.part$/;

/** An upload's part file that hasn't been written to for a day. `mtime` is in seconds, as SFTP gives it. */
export function stalePart(name: string, mtime: number, now = Date.now()): boolean {
  return PART_NAME.test(name) && now - mtime * 1000 > PART_MAX_AGE;
}

async function removeParts(sftp: SFTPWrapper, dir: string, names: string[]): Promise<void> {
  for (const n of names) {
    const p = path.posix.join(dir, n);
    await call<void>(p, (cb) => sftp.unlink(p, cb)).catch((e) => console.warn('[files] couldn’t sweep', p, (e as Error).message));
  }
}

/** Remember the folder an upload went into, so its part file is swept even if the folder is never opened again. */
function noteUploadDir(dir: string): void {
  store.setUploadDirs({ ...store.uploadDirs(), [dir]: new Date().toISOString() });
}

/**
 * Clear away part files that uploads left behind when the tab closed before it could
 * say so. Only the folders uploads went into are looked at; a folder is forgotten once
 * it has nothing left to sweep and its last upload started more than a day ago.
 */
export async function sweepUploads(now = Date.now()): Promise<number> {
  const dirs = store.uploadDirs();
  if (!shellConfigured() || !Object.keys(dirs).length) return 0;
  const { sftp } = await sftpSession();
  let removed = 0;
  const keep: Record<string, string> = {};
  for (const [dir, last] of Object.entries(dirs)) {
    let list: { filename: string; attrs: Stats }[];
    try {
      list = await call(dir, (cb) => sftp.readdir(dir, cb));
    } catch (e) {
      // Gone or unreadable: nothing to sweep there.
      if (!(e instanceof FileError && (e.status === 404 || e.status === 403))) keep[dir] = last;
      continue;
    }
    const stale = list.filter((f) => stalePart(f.filename, f.attrs.mtime, now)).map((f) => f.filename);
    await removeParts(sftp, dir, stale);
    removed += stale.length;
    const waiting = list.some((f) => PART_NAME.test(f.filename) && !stale.includes(f.filename));
    if (waiting || now - Date.parse(last) < PART_MAX_AGE) keep[dir] = last;
  }
  // An upload may have started meanwhile; keep what it added.
  store.setUploadDirs({ ...keep, ...Object.fromEntries(Object.entries(store.uploadDirs()).filter(([d, at]) => at !== dirs[d])) });
  return removed;
}

export interface UploadPiece {
  dir: unknown;
  name: unknown;
  id: unknown;
  /** Where this piece starts in the file. */
  offset: unknown;
  /** The whole file's size. */
  total: unknown;
  overwrite: boolean;
  body: ReadableStream<Uint8Array> | null;
}

/** Write one piece of an upload. The piece that reaches `total` moves the file into place. */
export async function uploadPiece(u: UploadPiece): Promise<{ done: boolean }> {
  const dir = cleanPath(u.dir);
  const dest = path.posix.join(dir, cleanName(u.name));
  const id = cleanUploadId(u.id);
  const offset = cleanSize(u.offset, 'offset');
  const total = cleanSize(u.total, 'file size');
  if (offset > total) throw new FileError('That piece starts past the end of the file.');
  const part = partPath(dir, id);
  const { sftp } = await sftpSession();

  if (offset === 0) {
    const existing = await stat(sftp, dest).catch(() => null);
    if (existing && !overwrite(u, existing)) throw new FileError(`${path.posix.basename(dest)} is already there.`, 409);
    noteUploadDir(dir);
  } else {
    // A retried piece may find some of itself already written; anything short of its start means one went missing.
    const sofar = await stat(sftp, part).catch(() => null);
    if (!sofar || (sofar.size ?? 0) < offset) throw new FileError('The upload lost its place. Try it again.', 409);
  }

  let written = 0;
  const count = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctl) {
      written += chunk.byteLength;
      if (offset + written > total) ctl.error(new FileError('That’s more than the file’s size.'));
      else ctl.enqueue(chunk);
    },
  });
  const source = (u.body ?? new Blob([]).stream()).pipeThrough(count);
  try {
    await pipeline(
      Readable.fromWeb(source as import('node:stream/web').ReadableStream),
      sftp.createWriteStream(part, offset === 0 ? { flags: 'w', mode: 0o644 } : { flags: 'r+', start: offset }),
    );
  } catch (e) {
    throw e instanceof FileError ? e : sftpError(e as Error, dest);
  }
  if (offset + written < total) return { done: false };

  const size = (await stat(sftp, part)).size ?? 0;
  if (size !== total) throw new FileError('The upload came out the wrong size. Try it again.', 500);
  const existing = await stat(sftp, dest).catch(() => null);
  if (existing && !overwrite(u, existing)) throw new FileError(`${path.posix.basename(dest)} is already there.`, 409);
  await moveInto(sftp, part, dest, !!existing);
  return { done: true };
}

/** An existing file may be replaced when asked; a folder never is. */
function overwrite(u: UploadPiece, existing: Stats): boolean {
  if (kindOf(existing.mode) === 'dir') throw new FileError(`${String(u.name)} is a folder.`, 409);
  return u.overwrite;
}

async function moveInto(sftp: SFTPWrapper, from: string, to: string, replace: boolean): Promise<void> {
  if (replace) {
    // OpenSSH's posix-rename replaces in one step; plain SFTP rename refuses an existing target.
    try {
      await call<void>(to, (cb) => sftp.ext_openssh_rename(from, to, cb));
      return;
    } catch (e) {
      if (!(e instanceof Error && /does not support/i.test(e.message))) throw e;
    }
    await call<void>(to, (cb) => sftp.unlink(to, cb));
  }
  await call<void>(to, (cb) => sftp.rename(from, to, cb));
}

/** Clear away the part file of an upload that failed or was given up on. */
export async function abandonUpload(dirPath: unknown, id: unknown): Promise<void> {
  const part = partPath(cleanPath(dirPath), cleanUploadId(id));
  const { sftp } = await sftpSession();
  await call<void>(part, (cb) => sftp.unlink(part, cb)).catch(() => {});
}

export async function makeDir(p: unknown): Promise<void> {
  const abs = cleanPath(p);
  const { sftp } = await sftpSession();
  if (await stat(sftp, abs).catch(() => null)) throw new FileError(`${path.posix.basename(abs)} is already there.`, 409);
  await call<void>(abs, (cb) => sftp.mkdir(abs, cb));
}

export async function rename(from: unknown, to: unknown): Promise<void> {
  const a = cleanPath(from);
  const b = cleanPath(to);
  const { sftp } = await sftpSession();
  if (await stat(sftp, b).catch(() => null)) throw new FileError(`${path.posix.basename(b)} is already there.`, 409);
  await call<void>(a, (cb) => sftp.rename(a, b, cb));
}

export const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Delete a file, or a folder and everything in it. */
export async function remove(p: unknown): Promise<void> {
  const abs = cleanPath(p);
  if (abs === '/') throw new FileError('Launchpad won’t delete the root folder.');
  const { conn } = await sftpSession();
  // rm -r in one go is far quicker than walking a big folder over SFTP.
  const stderr = await new Promise<string>((resolve, reject) =>
    conn.exec(`rm -rf -- ${shellQuote(abs)}`, (e, stream) => {
      if (e) return reject(e);
      let err = '';
      stream.stderr.on('data', (d: Buffer) => (err += d));
      stream.on('data', () => {});
      stream.on('close', (code: number) => resolve(code ? err.trim() || `rm exited with ${code}` : ''));
    }),
  );
  if (stderr) throw new FileError(stderr.replace(/^rm: /, ''), 403);
}
