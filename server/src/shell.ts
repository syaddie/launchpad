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
  const list = await call<{ filename: string; attrs: Stats }[]>(abs, (cb) => sftp.readdir(abs, cb));
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

/** Stream an upload into `dir`. An existing file is only replaced when `overwrite` is set. */
export async function upload(dirPath: unknown, name: unknown, body: ReadableStream<Uint8Array> | null, overwrite: boolean): Promise<void> {
  const dest = path.posix.join(cleanPath(dirPath), cleanName(name));
  const { sftp } = await sftpSession();
  const existing = await stat(sftp, dest).catch(() => null);
  if (existing && !overwrite) throw new FileError(`${path.posix.basename(dest)} is already there.`, 409);
  if (existing && kindOf(existing.mode) === 'dir') throw new FileError(`${dest} is a folder.`, 409);
  if (!body) throw new FileError('The upload was empty.');
  try {
    await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream), sftp.createWriteStream(dest, { mode: 0o644 }));
  } catch (e) {
    throw sftpError(e as Error, dest);
  }
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
