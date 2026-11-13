// The Server view's Minecraft consoles. The servers are Java processes in tmux or
// screen on the host, so everything goes over the files' SSH connection: one
// command finds the running servers (and the session each runs in), the console
// reads the server's logs/latest.log from where it last stopped, and a command is
// typed into the session as if at its keyboard. Servers can be saved, with a
// start command, so they're listed (and can be started) while they're stopped.
import crypto from 'node:crypto';
import path from 'node:path';
import { cleanPath, FileError, runCommand, sftpSession, shellQuote, stat } from './shell';
import { store } from './store';
import type { McLog, McMux, McServer, McStatus } from '../../shared/types';

export const MAX_MC = 20;
const SESSION = /^[A-Za-z0-9_.-]{1,64}$/;

// ---------- saved servers ----------

/** A server to save, checked; throws with what's wrong. */
export function cleanMcServer(v: unknown, id: string): McServer {
  const s = (v ?? {}) as Partial<Record<keyof McServer, unknown>>;
  const name = typeof s.name === 'string' ? s.name.trim().slice(0, 60) : '';
  if (!name) throw new FileError('Give the server a name.');
  let dir: string;
  try {
    dir = cleanPath(typeof s.dir === 'string' ? s.dir.trim() : s.dir);
  } catch {
    throw new FileError('The folder needs to be a full path, like /home/me/survival.');
  }
  const mux: McMux = s.mux === 'screen' ? 'screen' : 'tmux';
  const session = typeof s.session === 'string' ? s.session.trim() : '';
  if (!SESSION.test(session)) throw new FileError('The session name can only have letters, numbers, dots, dashes and underscores.');
  const start = typeof s.start === 'string' ? s.start.trim() : '';
  if (start.length > 1000 || /[\x00-\x1f\x7f]/.test(start)) throw new FileError('The start command must be one line, up to 1,000 characters.');
  return { id, name, dir, mux, session, start };
}

/** Saved servers from a backup; ones that don't check out are dropped. */
export function cleanMcServers(v: unknown): McServer[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set<string>();
  return v
    .flatMap((x) => {
      const id = x && typeof x.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x.id) && !ids.has(x.id) ? x.id : null;
      if (!id) return [];
      try {
        const s = cleanMcServer(x, id);
        ids.add(id);
        return [s];
      } catch {
        return [];
      }
    })
    .slice(0, MAX_MC);
}

// ---------- finding running servers ----------

export interface Detected {
  pid: number;
  dir: string | null;
  mux: McMux | null;
  /** tmux's session name, or screen's pid.name. */
  session: string | null;
}

/**
 * One round trip: every process with its parent, the tmux panes and screen sessions,
 * and for each java process its folder and whether a Minecraft server's config is there.
 */
export const DETECT = [
  'ps -eo pid=,ppid=,args= 2>/dev/null',
  'echo @@tmux',
  "tmux list-panes -a -F '#{pane_pid}\t#{session_name}' 2>/dev/null",
  'echo @@screen',
  'screen -ls 2>/dev/null',
  'echo @@java',
  `for p in $(pgrep -x java 2>/dev/null); do c=$(readlink /proc/$p/cwd 2>/dev/null); m=; for f in server.properties velocity.toml; do [ -n "$c" ] && [ -f "$c/$f" ] && m=$f; done; printf '%s\\t%s\\t%s\\n' "$p" "$c" "$m"; done`,
  'true',
].join('; ');

/** The Minecraft servers in DETECT's output, with the tmux or screen session each runs under. */
export function parseDetect(out: string): Detected[] {
  const parts: Record<string, string[]> = { ps: [] };
  let cur = 'ps';
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) parts[(cur = m[1])] = [];
    else parts[cur].push(line);
  }
  const procs = new Map<number, { ppid: number; args: string }>();
  for (const l of parts.ps) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l);
    if (m) procs.set(Number(m[1]), { ppid: Number(m[2]), args: m[3] });
  }
  const tmux = new Map<number, string>();
  for (const l of parts.tmux ?? []) {
    const m = /^(\d+)\t(.+)$/.exec(l);
    if (m && !tmux.has(Number(m[1]))) tmux.set(Number(m[1]), m[2]);
  }
  const screen = new Map<number, string>();
  for (const l of parts.screen ?? []) {
    const m = /^\s+((\d+)\.\S+)/.exec(l);
    if (m) screen.set(Number(m[2]), m[1]);
  }
  const found: Detected[] = [];
  for (const l of parts.java ?? []) {
    const [pidS, dir = '', marker = ''] = l.split('\t');
    const pid = Number(pidS);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const args = procs.get(pid)?.args ?? '';
    if (!marker && !/(^|\s)-{0,2}nogui(\s|$)/i.test(args)) continue;
    let mux: McMux | null = null;
    let session: string | null = null;
    // Up the parents until a tmux pane or a screen session.
    for (let p = pid, i = 0; p > 1 && i < 64; p = procs.get(p)?.ppid ?? 0, i++) {
      if (tmux.has(p)) {
        mux = 'tmux';
        session = tmux.get(p)!;
        break;
      }
      if (screen.has(p)) {
        mux = 'screen';
        session = screen.get(p)!;
        break;
      }
    }
    found.push({ pid, dir: dir.trim() || null, mux, session });
  }
  return found;
}

/** A saved server is the running one in the same folder, or in the session it names. */
export function sameServer(s: McServer, d: Detected): boolean {
  if (d.dir && d.dir === s.dir) return true;
  if (!d.session || d.mux !== s.mux) return false;
  return d.session === s.session || (s.mux === 'screen' && d.session.replace(/^\d+\./, '') === s.session);
}

/** A found server's id: the same each time, for its folder. */
export const autoId = (key: string) => 'auto-' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 12);

/** The saved servers, running or not, then any others found running. */
export function mergeStatuses(saved: McServer[], found: Detected[]): McStatus[] {
  const used = new Set<Detected>();
  const out: McStatus[] = saved.map((s) => {
    const d = found.find((f) => !used.has(f) && sameServer(s, f));
    if (d) used.add(d);
    return { ...s, session: d?.session ?? s.session, saved: true, running: !!d, pid: d?.pid ?? null, attached: !!d?.mux };
  });
  for (const d of found) {
    if (used.has(d)) continue;
    const key = d.dir ?? `${d.mux}:${d.session}:${d.pid}`;
    out.push({
      id: autoId(key),
      name: d.dir ? path.posix.basename(d.dir) : `java ${d.pid}`,
      dir: d.dir ?? '',
      mux: d.mux ?? 'tmux',
      session: d.session ?? '',
      start: '',
      saved: false,
      running: true,
      pid: d.pid,
      attached: !!d.mux,
    });
  }
  return out;
}

let cache: { at: number; found: Promise<Detected[]> } | null = null;

async function detect(fresh = false): Promise<Detected[]> {
  if (!fresh && cache && Date.now() - cache.at < 4_000) return cache.found;
  const found = runCommand(DETECT, 15_000).then((r) => parseDetect(r.stdout));
  cache = { at: Date.now(), found };
  found.catch(() => cache?.found === found && (cache = null));
  return found;
}

export async function mcStatuses(fresh = false): Promise<McStatus[]> {
  return mergeStatuses(store.minecraft(), await detect(fresh));
}

async function find(id: string, fresh = false): Promise<McStatus> {
  const s = (await mcStatuses(fresh)).find((x) => x.id === id);
  if (!s) throw new FileError('That server isn’t running any more, and it isn’t saved.', 404);
  return s;
}

// ---------- typing into the session ----------

/** One line for the console. A leading slash is dropped: the console takes commands without one. */
export function cleanCommand(v: unknown): string {
  const cmd = typeof v === 'string' ? v.trim().replace(/^\//, '') : '';
  if (!cmd) throw new FileError('Type a command first.');
  if (cmd.length > 1000) throw new FileError('That command is over 1,000 characters.');
  if (/[\x00-\x1f\x7f]/.test(cmd)) throw new FileError('A command is one line, without control characters.');
  return cmd;
}

/** screen's stuff reads ^X and backslash escapes, so those are escaped to arrive as typed. */
export const screenEscape = (s: string) => s.replace(/[\\^]/g, (c) => '\\' + c);

/** The shell command that types `line` into the session and presses Enter. */
export function sendLine(mux: McMux, session: string, line: string): string {
  if (mux === 'tmux') {
    // =name: is that session exactly, in its current window.
    const t = shellQuote(`=${session}:`);
    return `tmux send-keys -t ${t} -l -- ${shellQuote(line)} && tmux send-keys -t ${t} Enter`;
  }
  return `screen -S ${shellQuote(session)} -p 0 -X stuff ${shellQuote(screenEscape(line) + '\r')}`;
}

/** Make the session if it isn't there, with a shell in the server's folder, then type the start command into it. */
export function startLine(s: McServer): string {
  const typed = sendLine(s.mux, s.session, `cd ${shellQuote(s.dir)} && ${s.start}`);
  if (s.mux === 'tmux') return `{ tmux has-session -t ${shellQuote('=' + s.session)} 2>/dev/null || tmux new-session -d -s ${shellQuote(s.session)} -c ${shellQuote(s.dir)}; } && ${typed}`;
  return `{ screen -ls 2>/dev/null | grep -qF -- ${shellQuote('.' + s.session + '\t')} || { cd ${shellQuote(s.dir)} && screen -dmS ${shellQuote(s.session)} && sleep 0.3; }; } && ${typed}`;
}

async function run(cmd: string, what: string): Promise<void> {
  const r = await runCommand(cmd, 15_000);
  if (r.code) {
    const err = r.stderr.trim().split('\n').pop() || `exited with ${r.code}`;
    if (/command not found/.test(err)) throw new FileError(`${what}: ${err}. Install it on the server.`, 409);
    throw new FileError(`${what}: ${err}`, 409);
  }
}

export async function sendCommand(id: string, command: unknown): Promise<void> {
  const cmd = cleanCommand(command);
  const s = await find(id);
  if (!s.running) throw new FileError(`${s.name} isn’t running.`, 409);
  if (!s.attached || !s.session) throw new FileError(`${s.name} isn’t running in tmux or screen, so Launchpad can’t type into its console.`, 409);
  await run(sendLine(s.mux, s.session, cmd), `Couldn’t send it to ${s.mux} session ${s.session}`);
}

export async function startServer(id: string): Promise<void> {
  const s = await find(id, true);
  if (s.running) throw new FileError(`${s.name} is running already.`, 409);
  const saved = store.minecraft().find((x) => x.id === id);
  if (!saved?.start) throw new FileError(`Add a start command to ${s.name} first.`, 409);
  await run(startLine(saved), `Couldn’t start ${s.name}`);
  cache = null;
}

// ---------- the log ----------

/** What the first read shows, and the most one read returns. */
export const LOG_TAIL = 64 * 1024;
export const LOG_MAX = 512 * 1024;

/** Which bytes of a `size`-byte log to read, picking up at `offset`. A log shorter than that started over. */
export function logWindow(size: number, offset: number | null): { start: number; end: number; reset: boolean } {
  if (offset === null || offset > size) return { start: Math.max(0, size - LOG_TAIL), end: size, reset: true };
  return { start: offset, end: Math.min(size, offset + LOG_MAX), reset: false };
}

/**
 * The whole lines in `buf`, read from `start`. A read from the middle of the file skips
 * the part line it begins in; a partial last line waits for the next read, unless the
 * read was cut short at LOG_MAX and there's no line break to stop at.
 */
export function takeLines(buf: Buffer, start: number, midFile: boolean): { text: string; offset: number } {
  let from = 0;
  if (midFile) {
    const nl = buf.indexOf(10);
    from = nl < 0 ? buf.length : nl + 1;
  }
  let to = buf.lastIndexOf(10) + 1;
  if (to <= from) to = buf.length >= LOG_MAX ? buf.length : from;
  return { text: buf.subarray(from, to).toString('utf8'), offset: start + to };
}

/** Colour codes from the console (ANSI) and from chat (§), which the page doesn't draw. */
export const plainLog = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/§[0-9a-fk-orx]/gi, '').replace(/\r/g, '');

export async function readLog(id: string, offsetParam: unknown): Promise<McLog> {
  const s = await find(id);
  if (!s.dir) return { text: '', offset: 0, reset: true, missing: true };
  const file = path.posix.join(s.dir, 'logs', 'latest.log');
  const { sftp } = await sftpSession();
  const st = await stat(sftp, file).catch((e) => {
    if (e instanceof FileError && e.status === 404) return null;
    throw e;
  });
  if (!st) return { text: '', offset: 0, reset: true, missing: true };
  const size = st.size ?? 0;
  const offset = typeof offsetParam === 'string' && /^\d{1,15}$/.test(offsetParam) ? Number(offsetParam) : null;
  const w = logWindow(size, offset);
  if (w.end <= w.start) return { text: '', offset: w.start, reset: w.reset, missing: false };
  const buf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    sftp
      .createReadStream(file, { start: w.start, end: w.end - 1 })
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
  const got = takeLines(buf, w.start, w.reset && w.start > 0);
  return { text: plainLog(got.text), offset: got.offset, reset: w.reset, missing: false };
}
