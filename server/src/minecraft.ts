// The Server view's Minecraft consoles. The servers are Java processes in tmux or
// screen on the host, so everything goes over the files' SSH connection: one
// command finds the running servers (and the session each runs in), the console
// reads the server's logs/latest.log from where it last stopped, and a command is
// typed into the session as if at its keyboard. Servers can be saved, with a
// start command, so they're listed (and can be started) while they're stopped.
//
// Also here: the crash reports, and Restart if it crashes, which watches the saved
// servers that have it on and starts one again when it stops on its own. What it
// notices goes out through onMcEvent. Players and meters are in mc-players.ts,
// world backups in mc-backups.ts.
import crypto from 'node:crypto';
import path from 'node:path';
import type { SFTPWrapper } from 'ssh2';
import { call, cleanPath, FileError, runCommand, sftpSession, shellConfigured, shellQuote, stat } from './shell';
import { store } from './store';
import { MC_KEEP_BACKUPS } from '../../shared/types';
import type { McCrashes, McCrashReport, McCrashSummary, McDiagnosis, McFinding, McLog, McMux, McRestart, McServer, McStatus, McWatchRecord } from '../../shared/types';

export const MAX_MC = 20;
const SESSION = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * runCommand, but a timeout or a failed connection says what Launchpad was doing and
 * lands in the server's own log (docker logs), so the cause can be found afterwards.
 */
export async function ssh(cmd: string, timeoutMs: number, what: string) {
  try {
    return await runCommand(cmd, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const slow = /took too long/.test(msg);
    const text = slow ? `${what}: the server didn’t answer within ${Math.round(timeoutMs / 1000)} seconds. SSH may be stuck, or the machine is overloaded.` : `${what}: ${msg}`;
    console.error(`[minecraft] ${text}`);
    throw new FileError(text, 409);
  }
}

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
  // A bad number is put right rather than refused, so an odd backup doesn't drop the whole server.
  const n = typeof s.keepBackups === 'number' || (typeof s.keepBackups === 'string' && s.keepBackups.trim()) ? Math.round(Number(s.keepBackups)) : NaN;
  const keep = Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : MC_KEEP_BACKUPS;
  let backupDir = '';
  if (typeof s.backupDir === 'string' && s.backupDir.trim()) {
    try {
      backupDir = cleanPath(s.backupDir.trim());
    } catch {
      throw new FileError('The backups folder needs to be a full path, like /home/me/backups.');
    }
    if (backupDir === '/') throw new FileError('Pick a folder for the backups, not the root folder.');
  }
  return {
    id,
    name,
    dir,
    mux,
    session,
    start,
    // Restarting needs something to type.
    ...(s.autoRestart === true && start ? { autoRestart: true } : {}),
    ...(keep !== MC_KEEP_BACKUPS ? { keepBackups: keep } : {}),
    ...(backupDir ? { backupDir } : {}),
  };
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
  const found = ssh(DETECT, 15_000, 'Looking for Minecraft servers').then((r) => parseDetect(r.stdout));
  cache = { at: Date.now(), found };
  found.catch(() => cache?.found === found && (cache = null));
  return found;
}

/** Look again on the next ask, after something that starts or stops a server. */
export const forgetDetected = () => (cache = null);

export async function mcStatuses(fresh = false): Promise<McStatus[]> {
  const watch = store.mcWatch();
  return mergeStatuses(store.minecraft(), await detect(fresh)).map((s) => {
    const job = busy.get(s.id);
    return { ...s, ...(job ? { job } : {}), ...(watch[s.id]?.gaveUp ? { gaveUp: true } : {}) };
  });
}

export async function findMc(id: string, fresh = false): Promise<McStatus> {
  const s = (await mcStatuses(fresh)).find((x) => x.id === id);
  if (!s) throw new FileError('That server isn’t running any more, and it isn’t saved.', 404);
  return s;
}

// ---------- backups and restores under way ----------

/** Servers with a backup or restore running: nothing may start them or type stop meanwhile. */
const busy = new Map<string, 'backup' | 'restore'>();

export const mcBusy = {
  get: (id: string) => busy.get(id),
  set: (id: string, kind: 'backup' | 'restore') => void busy.set(id, kind),
  clear: (id: string) => void busy.delete(id),
};

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
  const r = await ssh(cmd, 15_000, what);
  if (r.code) {
    const err = r.stderr.trim().split('\n').pop() || `exited with ${r.code}`;
    console.error(`[minecraft] ${what}: ${err}`);
    if (/command not found/.test(err)) throw new FileError(`${what}: ${err}. Install it on the server.`, 409);
    throw new FileError(`${what}: ${err}`, 409);
  }
}

/** Commands that shut the server down, so the watcher knows the stop was asked for. */
const STOPS = /^(stop|end|restart)(\s|$)/i;

/** Type a line into a running server's console. */
export async function typeInto(s: McStatus, cmd: string): Promise<void> {
  if (!s.running) throw new FileError(`${s.name} isn’t running.`, 409);
  if (!s.attached || !s.session) throw new FileError(`${s.name} isn’t running in tmux or screen, so Launchpad can’t type into its console.`, 409);
  if (STOPS.test(cmd)) expectStop(s.id);
  await run(sendLine(s.mux, s.session, cmd), `Couldn’t send it to ${s.mux} session ${s.session}`);
}

export async function sendCommand(id: string, command: unknown): Promise<void> {
  const cmd = cleanCommand(command);
  const s = await findMc(id);
  if (busy.get(id) === 'backup' && /^(stop|end|restart|save-on|save-off)(\s|$)/i.test(cmd)) {
    throw new FileError(`A backup of ${s.name} is under way. Wait for it to finish first: it turns saving back on itself.`, 409);
  }
  await typeInto(s, cmd);
}

export async function startServer(id: string): Promise<void> {
  const s = await findMc(id, true);
  if (s.running) throw new FileError(`${s.name} is running already.`, 409);
  const job = busy.get(id);
  if (job) throw new FileError(`${s.name} can’t start while its world is being ${job === 'backup' ? 'backed up' : 'restored'}.`, 409);
  const saved = store.minecraft().find((x) => x.id === id);
  if (!saved?.start) throw new FileError(`Add a start command to ${s.name} first.`, 409);
  await run(startLine(saved), `Couldn’t start ${s.name}`);
  cache = null;
  // A start from you is the answer to giving up.
  setWatch(id, (r) => ({ ...r, gaveUp: false }));
}

// ---------- the log, and reading what the console answers ----------

export const logFile = (s: Pick<McServer, 'dir'>) => path.posix.join(s.dir, 'logs', 'latest.log');

/** A file's size, or null when it isn't there. */
export async function sizeOf(sftp: SFTPWrapper, file: string): Promise<number | null> {
  const st = await stat(sftp, file).catch((e) => {
    if (e instanceof FileError && e.status === 404) return null;
    throw e;
  });
  return st ? (st.size ?? 0) : null;
}

/** Bytes [start, end) of a file. */
export function readRange(sftp: SFTPWrapper, file: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Promise.resolve(Buffer.alloc(0));
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    sftp
      .createReadStream(file, { start, end: end - 1 })
      .on('data', (c: Buffer) => chunks.push(c))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject);
  });
}

/** A small file whole (up to `max` bytes), or null when it isn't there. */
export async function readSmall(sftp: SFTPWrapper, file: string, max = 1024 * 1024): Promise<string | null> {
  const size = await sizeOf(sftp, file);
  if (size === null) return null;
  return (await readRange(sftp, file, 0, Math.min(size, max))).toString('utf8');
}

/** A log line without its [time] [thread/LEVEL]: start, as vanilla, Paper, Fabric and Forge write it. */
export const logMessage = (line: string) => line.replace(/^(?:\[[^\]]*\]\s*){1,3}:\s?/, '').trimEnd();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Type `cmd` into the console and read what the log says next, until `enough` is happy
 * with the lines (their messages, colour codes taken out) or `timeoutMs` passes.
 * Returns the lines either way; the caller decides what it got.
 */
export async function askConsole(s: McStatus, cmd: string, enough: (msgs: string[]) => boolean, timeoutMs = 4000): Promise<string[]> {
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder, so it can’t read its answer.`, 409);
  const file = logFile(s);
  const { sftp } = await sftpSession();
  const from = await sizeOf(sftp, file);
  if (from === null) throw new FileError(`${s.name} has no logs/latest.log, so Launchpad can’t read its answer.`, 409);
  await typeInto(s, cmd);
  const began = Date.now();
  let msgs: string[] = [];
  while (Date.now() - began < timeoutMs) {
    await sleep(300);
    const size = (await sizeOf(sftp, file)) ?? 0;
    // A log that shrank started over: the server restarted.
    const start = size < from ? 0 : from;
    const buf = await readRange(sftp, file, start, Math.min(size, start + 256 * 1024));
    msgs = plainLog(buf.toString('utf8')).split('\n').filter((l) => l.trim()).map(logMessage);
    if (enough(msgs)) break;
  }
  return msgs;
}

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
  const s = await findMc(id);
  if (!s.dir) return { text: '', offset: 0, reset: true, missing: true };
  const file = logFile(s);
  const { sftp } = await sftpSession();
  const size = await sizeOf(sftp, file);
  if (size === null) return { text: '', offset: 0, reset: true, missing: true };
  const offset = typeof offsetParam === 'string' && /^\d{1,15}$/.test(offsetParam) ? Number(offsetParam) : null;
  const w = logWindow(size, offset);
  if (w.end <= w.start) return { text: '', offset: w.start, reset: w.reset, missing: false };
  const buf = await readRange(sftp, file, w.start, w.end);
  const got = takeLines(buf, w.start, w.reset && w.start > 0);
  return { text: plainLog(got.text), offset: got.offset, reset: w.reset, missing: false };
}

// ---------- the server's own settings ----------

/** server.properties as key → value, with Java's escapes undone. */
export function parseProps(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const m = /^((?:\\.|[^\\:=\s])+)\s*[:=]?\s*(.*)$/.exec(line);
    if (!m) continue;
    const un = (s: string) => s.replace(/\\u([0-9a-fA-F]{4})|\\(.)/g, (_, u, c) => (u ? String.fromCharCode(parseInt(u, 16)) : c === 'n' ? '\n' : c === 't' ? '\t' : c));
    out[un(m[1])] = un(m[2]).trim();
  }
  return out;
}

/** level-name, when it's a folder inside the server's own: relative, without .. or odd characters. */
export function cleanLevel(v: string | undefined): string | null {
  const name = (v ?? '').trim() || 'world';
  if (name.length > 200 || name.startsWith('/') || /[\x00-\x1f\x7f\\]/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return null;
  return name;
}

/** What Launchpad needs to know about a server from its folder. */
export interface McFacts {
  port: number;
  /** server-ip, when the server only listens on one address. */
  ip: string | null;
  /** level-name, or null when it points outside the folder. */
  level: string | null;
  whitelistOn: boolean;
  /** Bukkit, Spigot, Paper and their forks keep the Nether and the End in folders of their own. */
  bukkit: boolean;
  paper: boolean;
  spark: boolean;
}

/** One look at the folder: server.properties and the files that say what kind of server it is. */
export function factsScript(dir: string): string {
  return [
    `cd ${shellQuote(dir)} 2>/dev/null || exit 0`,
    'echo @@props; head -c 65536 server.properties 2>/dev/null; echo',
    'echo @@marks; for f in bukkit.yml spigot.yml paper.yml config/paper-global.yml; do [ -f "$f" ] && echo "$f"; done; ls -d plugins/spark* plugins/Spark* mods/spark* config/spark 2>/dev/null | head -n 3',
    'true',
  ].join('\n');
}

export function parseFacts(out: string): McFacts {
  const parts: Record<string, string[]> = {};
  let cur = '';
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) parts[(cur = m[1])] = [];
    else if (cur) parts[cur].push(line);
  }
  const props = parseProps((parts.props ?? []).join('\n'));
  const marks = (parts.marks ?? []).map((l) => l.trim()).filter(Boolean);
  const port = Number(props['server-port']);
  const ip = (props['server-ip'] ?? '').trim();
  return {
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 25565,
    ip: ip && ip !== '0.0.0.0' && ip !== '::' && /^[A-Za-z0-9.:-]{1,253}$/.test(ip) ? ip : null,
    level: cleanLevel(props['level-name']),
    whitelistOn: /^true$/i.test(props['white-list'] ?? ''),
    bukkit: marks.includes('bukkit.yml'),
    paper: marks.includes('paper.yml') || marks.includes('config/paper-global.yml'),
    spark: marks.some((m) => /spark/i.test(m)),
  };
}

const factsCache = new Map<string, { at: number; facts: Promise<McFacts> }>();

/** A server's facts, looked at most once a minute. */
export function serverFacts(s: Pick<McServer, 'dir' | 'name'>, fresh = false): Promise<McFacts> {
  const hit = factsCache.get(s.dir);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.facts;
  const facts = ssh(factsScript(s.dir), 15_000, `Reading ${s.name}’s settings`).then((r) => parseFacts(r.stdout));
  factsCache.set(s.dir, { at: Date.now(), facts });
  facts.catch(() => factsCache.get(s.dir)?.facts === facts && factsCache.delete(s.dir));
  return facts;
}

/** The world's folders, relative to the server's: Bukkit-style servers keep the Nether and End beside it. */
export const worldFolders = (f: Pick<McFacts, 'level' | 'bukkit'>): string[] => (f.level ? (f.bukkit ? [f.level, `${f.level}_nether`, `${f.level}_the_end`] : [f.level]) : []);

// ---------- crash reports ----------

const CRASH_NAME = /^[A-Za-z0-9_.+-]{1,200}\.txt$/;
const crashDir = (s: Pick<McServer, 'dir'>) => path.posix.join(s.dir, 'crash-reports');

/** A crash report's Description line and its exception with the first few lines under it. */
export function parseCrash(text: string): { description: string | null; lines: string[] } {
  const all = plainLog(text).split('\n');
  const at = all.findIndex((l) => /^Description:\s/.test(l));
  const description = at >= 0 ? all[at].replace(/^Description:\s*/, '').trim() || null : null;
  const lines: string[] = [];
  if (at >= 0) {
    let i = at + 1;
    while (i < all.length && !all[i].trim()) i++;
    let stack = 0;
    for (; i < all.length && all[i].trim() && lines.length < 12; i++) {
      const l = all[i].replace(/\s+$/, '');
      const isAt = /^\s+at\s/.test(l);
      if (isAt && stack >= 6) continue;
      if (isAt) stack++;
      lines.push(l.length > 300 ? l.slice(0, 300) + '…' : l);
    }
  }
  return { description, lines };
}

/** The reports in crash-reports/, newest first. */
export async function crashReports(s: McServer, max = 50): Promise<McCrashReport[]> {
  if (!s.dir) return [];
  const { sftp } = await sftpSession();
  const dir = crashDir(s);
  const list = await call<{ filename: string; attrs: { mtime: number; size: number; mode: number } }[]>(dir, (cb) => sftp.readdir(dir, cb)).catch((e) => {
    if (e instanceof FileError && e.status === 404) return [];
    throw e;
  });
  return list
    .filter((f) => CRASH_NAME.test(f.filename) && (f.attrs.mode & 0o170000) === 0o100000)
    .sort((a, b) => b.attrs.mtime - a.attrs.mtime || b.filename.localeCompare(a.filename))
    .slice(0, max)
    .map((f) => ({ name: f.filename, at: new Date(f.attrs.mtime * 1000).toISOString(), size: f.attrs.size }));
}

export async function listCrashes(id: string): Promise<McCrashes> {
  const s = await findMc(id);
  const w = store.mcWatch()[id];
  return { reports: await crashReports(s), autoRestart: !!s.autoRestart, gaveUp: !!w?.gaveUp, restarts: [...(w?.log ?? [])].reverse() };
}

export const CRASH_MAX = 1024 * 1024;

/** One whole report (up to 1 MB), to read. */
export async function readCrash(id: string, name: unknown): Promise<{ name: string; text: string; truncated: boolean }> {
  if (typeof name !== 'string' || !CRASH_NAME.test(name)) throw new FileError('That isn’t a crash report’s name.');
  const s = await findMc(id);
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder.`, 409);
  const file = path.posix.join(crashDir(s), name);
  const { sftp } = await sftpSession();
  const size = await sizeOf(sftp, file);
  if (size === null) throw new FileError(`${name} isn’t there any more.`, 404);
  const buf = await readRange(sftp, file, 0, Math.min(size, CRASH_MAX));
  return { name, text: plainLog(buf.toString('utf8')), truncated: size > CRASH_MAX };
}

// ---------- finding out why it won't start ----------

/** What one look at the server's folder, tools and terminal turned up. */
export interface DiagFacts {
  dirExists: boolean;
  hasMux: boolean;
  /** Java's version line, or null when `java` isn't on the SSH shell's PATH. */
  java: string | null;
  /** The start command's script, when it names one: where it stands. */
  startFile: 'none' | 'ok' | 'missing' | 'notexec';
  eula: 'true' | 'false' | 'missing';
  port: number;
  /** What's listening on the server's port, if anything. */
  portBusy: string | null;
  diskFreeMb: number | null;
  /** A crash report written in the last 30 minutes. */
  recentCrash: string | null;
  pane: string;
  log: string;
  /** The newest crash report, however old. */
  crash?: McCrashSummary | null;
}

/** The script file a start command runs, as a full path, when it begins with ./ or /. */
export function startScript(s: McServer): string | null {
  const first = s.start.trim().split(/\s+/)[0] ?? '';
  if (first.startsWith('/')) return first;
  if (first.startsWith('./')) return path.posix.join(s.dir, first);
  return null;
}

/** One round trip that gathers everything diagnose() reasons about. Sections start with @@name. */
export function diagScript(s: McServer): string {
  const d = shellQuote(s.dir);
  const script = startScript(s);
  const f = script ? shellQuote(script) : '';
  const pane =
    s.mux === 'tmux'
      ? `tmux capture-pane -p -t ${shellQuote('=' + s.session + ':')} -S -40 2>&1 | tail -n 40`
      : `f=$(mktemp); screen -S ${shellQuote(s.session)} -p 0 -X hardcopy -h "$f" 2>&1; tail -n 40 "$f" 2>&1; rm -f "$f"`;
  return [
    `echo @@dir; [ -d ${d} ] && echo yes || echo no`,
    `echo @@mux; command -v ${s.mux} >/dev/null 2>&1 && echo yes || echo no`,
    'echo @@java; command -v java >/dev/null 2>&1 && java -version 2>&1 | head -n 1',
    `echo @@startfile; ${script ? `if [ ! -e ${f} ]; then echo missing; elif [ ! -x ${f} ]; then echo notexec; else echo ok; fi` : 'echo none'}`,
    `echo @@eula; grep -i '^eula=' ${shellQuote(path.posix.join(s.dir, 'eula.txt'))} 2>/dev/null`,
    `echo @@port; p=$(grep -E '^server-port=' ${shellQuote(path.posix.join(s.dir, 'server.properties'))} 2>/dev/null | head -n 1 | cut -d= -f2 | tr -d '\\r '); case "$p" in ''|*[!0-9]*) p=25565;; esac; echo "port=$p"; ss -ltnp 2>/dev/null | grep -E ":$p[[:space:]]" | head -n 1`,
    `echo @@disk; df -Pk ${d} 2>/dev/null | tail -n 1`,
    `echo @@crash; find ${shellQuote(crashDir(s))} -name '*.txt' -mmin -30 2>/dev/null | head -n 1`,
    `echo @@crashfile; c=$(ls -1t ${shellQuote(crashDir(s))}/*.txt 2>/dev/null | head -n 1); [ -n "$c" ] && { echo "\${c##*/}"; stat -c '%Y %s' "$c" 2>/dev/null; }`,
    `echo @@crashtext; [ -n "$c" ] && head -c 16384 "$c" | sed 's/^@@/@ @/'`,
    `echo @@pane; ${pane}`,
    `echo @@log; tail -n 40 ${shellQuote(logFile(s))} 2>&1`,
    'true',
  ].join('\n');
}

/** diagScript's output as facts. Anything missing reads as "not found". */
export function parseDiag(out: string): DiagFacts {
  const parts: Record<string, string[]> = {};
  let cur = '';
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) parts[(cur = m[1])] = [];
    else if (cur) parts[cur].push(line);
  }
  const sec = (k: string) => (parts[k] ?? []).join('\n').replace(/\s+$/, '');
  const first = (k: string) => (parts[k] ?? []).map((l) => l.trim()).find(Boolean) ?? '';
  const eula = /^eula\s*=\s*(\w+)/i.exec(first('eula'))?.[1]?.toLowerCase();
  const portLines = parts.port ?? [];
  const port = Number(/^port=(\d+)$/.exec(portLines[0]?.trim() ?? '')?.[1]) || 25565;
  const free = Number(first('disk').split(/\s+/)[3]);
  const startFile = first('startfile');
  const [crashName = '', crashStat = ''] = (parts.crashfile ?? []).map((l) => l.trim()).filter(Boolean);
  const [mtime, size] = crashStat.split(/\s+/).map(Number);
  const crash: McCrashSummary | null = CRASH_NAME.test(crashName)
    ? { name: crashName, at: new Date(Number.isFinite(mtime) ? mtime * 1000 : 0).toISOString(), size: Number.isFinite(size) ? size : 0, ...parseCrash(sec('crashtext')) }
    : null;
  return {
    dirExists: first('dir') === 'yes',
    hasMux: first('mux') === 'yes',
    java: first('java') || null,
    startFile: startFile === 'ok' || startFile === 'missing' || startFile === 'notexec' ? startFile : 'none',
    eula: eula === 'true' ? 'true' : eula ? 'false' : 'missing',
    port,
    portBusy: portLines.slice(1).map((l) => l.trim()).find(Boolean) ?? null,
    diskFreeMb: Number.isFinite(free) && first('disk') ? Math.round(free / 1024) : null,
    recentCrash: first('crash') || null,
    pane: sec('pane'),
    log: sec('log'),
    crash,
  };
}

/** Things the terminal or the log say that point at a cause, with what to do about it. */
const OUTPUT_CLUES: { re: RegExp; level: McFinding['level']; text: string }[] = [
  { re: /UnsupportedClassVersionError|class file version/i, level: 'error', text: 'This server needs a newer version of Java than the one it ran with. (Minecraft 1.20.5 and up needs Java 21.)' },
  { re: /Unable to access jarfile/i, level: 'error', text: 'Java can’t find the server .jar named in the start command. Check its name and folder.' },
  { re: /Could not reserve enough space|Invalid maximum heap size|Initial heap size set to a larger value/i, level: 'error', text: 'The memory in the start command (-Xmx or -Xms) is more than the machine can give. Lower it.' },
  { re: /OutOfMemoryError/i, level: 'error', text: 'The server ran out of memory. Give it more with -Xmx, or free some on the machine.' },
  { re: /FAILED TO BIND TO PORT|Address already in use/i, level: 'error', text: 'The server’s port is already taken by another program, maybe an old server still running.' },
  { re: /No space left on device/i, level: 'error', text: 'The disk is full.' },
  { re: /You need to agree to the EULA/i, level: 'error', text: 'The EULA hasn’t been accepted. Set eula=true in eula.txt.' },
  { re: /java: (command )?not found/i, level: 'error', text: 'Java isn’t installed, or isn’t on the PATH inside the session.' },
  { re: /: command not found/i, level: 'error', text: 'The session doesn’t know a command in the start line. Is the program installed?' },
  { re: /Permission denied/i, level: 'error', text: 'The session was refused access to something. Check file permissions (and that the start script is executable).' },
  { re: /No such file or directory/i, level: 'error', text: 'The start command points at something that doesn’t exist.' },
  { re: /Failed to start the minecraft server|Encountered an unexpected exception|Exception in thread "main"/i, level: 'error', text: 'The server crashed while starting. The lines below it have the cause.' },
];

/** The findings for a server, most serious first. Nothing here touches the server. */
export function explain(f: DiagFacts, s: McServer, running: boolean): McFinding[] {
  const out: McFinding[] = [];
  const add = (level: McFinding['level'], text: string, detail?: string) => out.push({ level, text, detail });
  if (!f.dirExists) add('error', `The folder ${s.dir} isn’t on the server. Check the path under Edit.`);
  if (!f.hasMux) add('error', `${s.mux} isn’t installed on the server, so there’s nowhere to run or type into the server. Install it (for example: sudo apt install ${s.mux}).`);
  if (f.startFile === 'missing') add('error', `The start script ${startScript(s)} doesn’t exist.`);
  if (f.startFile === 'notexec') add('error', `The start script ${startScript(s)} isn’t executable. In that folder, run: chmod +x ${path.posix.basename(startScript(s) ?? '')}`);
  if (!running && !f.java) add('warn', 'Java wasn’t found on the PATH of Launchpad’s SSH login. That’s fine if the session finds it itself or the start command gives its full path.');
  if (f.eula === 'false') add('error', 'eula.txt says eula=false, so the server stops straight away. Change it to eula=true.');
  else if (f.eula === 'missing' && !running) add('warn', 'There’s no eula.txt yet. The first run makes it, then it needs eula=true before the next one.');
  if (!running && f.portBusy) add('error', `Port ${f.port} is already in use, so a server can’t start on it. Another server may still be running.`, f.portBusy);
  if (f.diskFreeMb !== null && f.diskFreeMb < 200) add('warn', `Only ${f.diskFreeMb} MB is free on the disk.`);
  if (f.recentCrash) add('warn', 'A crash report was written in the last 30 minutes.', f.recentCrash);

  // The terminal and log, line by line, for known messages. Each message is reported once.
  // Without tmux or screen the "terminal" is only our own command's complaint, so it's left out.
  const seen = new Set<string>();
  const lines = `${f.hasMux ? f.pane : ''}\n${f.log}`.split('\n').filter((l) => l.trim());
  for (const clue of OUTPUT_CLUES) {
    const line = lines.find((l) => clue.re.test(l));
    if (!line || seen.has(clue.text)) continue;
    seen.add(clue.text);
    add(clue.level, clue.text, line.trim().slice(0, 240));
  }

  const order = { error: 0, warn: 1, info: 2 };
  out.sort((a, b) => order[a.level] - order[b.level]);
  if (!out.length) {
    add('info', 'Nothing obviously wrong: the folder, start script, EULA and port check out. What the session printed is below.');
    if (!f.pane.trim() && !running) add('info', 'The session printed nothing. If it didn’t exist before, Start made it, so try Start once more and look again.');
  }
  return out;
}

/** Look over a server that won't start, or has stopped, and say what's likely wrong. */
export async function diagnose(id: string): Promise<McDiagnosis> {
  const s = await findMc(id, true);
  if (!s.dir) throw new FileError(`Launchpad doesn’t know ${s.name}’s folder, so it can’t check it. Save the server with its folder.`, 409);
  const r = await ssh(diagScript(s), 20_000, `Checking ${s.name}`);
  const facts = parseDiag(r.stdout);
  return { findings: explain(facts, s, s.running), pane: plainLog(facts.pane), log: plainLog(facts.log), running: s.running, at: Date.now(), crash: facts.crash ?? null };
}

// ---------- Restart if it crashes ----------

/** What onMcEvent subscribers hear. */
export interface McEvent {
  /** crash: a server with Restart if it crashes on stopped on its own. restart: it was started again. gave-up: too many crashes, so it was left stopped. */
  type: 'crash' | 'restart' | 'gave-up';
  serverId: string;
  server: string;
  /** ISO time. */
  at: string;
  /** In a sentence, e.g. "It crashed: Exception in server tick loop". */
  reason: string;
  /** The crash report's file name in crash-reports/, when there's a new one. */
  crashReport: string | null;
}

const listeners = new Set<(e: McEvent) => void>();

/** Hear about crashes, restarts and giving up (alerts, say). Returns a function that stops listening. */
export function onMcEvent(fn: (e: McEvent) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function emit(e: McEvent): void {
  for (const fn of listeners) {
    try {
      const r = fn(e) as unknown;
      if (r instanceof Promise) r.catch((err) => console.error('[minecraft] an event listener failed:', (err as Error).message));
    } catch (err) {
      console.error('[minecraft] an event listener failed:', (err as Error).message);
    }
  }
}

export const WATCH_EVERY = 15_000;
/** At most MAX_RESTARTS restarts in RESTART_WINDOW; one more crash and it gives up. */
export const MAX_RESTARTS = 3;
export const RESTART_WINDOW = 15 * 60_000;
/** After a stop, how long to wait before deciding (a start script that loops brings it back itself). */
export const GRACE = 10_000;
/** After typing the start command, how long the process has to appear. */
export const COME_UP = 2 * 60_000;
/** A stop Launchpad typed counts for this long. */
const EXPECTED_FOR = 5 * 60_000;
const LOG_KEEP = 20;

/** What the watcher remembers about one server between looks. */
export interface WatchMem {
  /** Running at the last look; null before the first. */
  was: boolean | null;
  lastUp: number;
  /** When it was first seen stopped, while waiting out GRACE. */
  downAt: number | null;
  /** When Launchpad typed the start command, while waiting for it to come up. */
  restartedAt: number | null;
}

export const NEW_MEM: WatchMem = { was: null, lastUp: 0, downAt: null, restartedAt: null };

/**
 * One look at one server: what to remember and what to do. `check`: it stopped a while
 * ago and is still stopped, so read its log to see whether it crashed. `failed`: a restart
 * didn't come up in time. A stop Launchpad typed (`expectedAt`) isn't looked into.
 */
export function watchStep(m: WatchMem, running: boolean, now: number, expectedAt?: number): { mem: WatchMem; act: 'none' | 'check' | 'failed' } {
  if (running) return { mem: { was: true, lastUp: now, downAt: null, restartedAt: null }, act: 'none' };
  if (m.was === null) return { mem: { ...m, was: false }, act: 'none' };
  if (m.restartedAt !== null) {
    if (now - m.restartedAt < COME_UP) return { mem: m, act: 'none' };
    return { mem: { ...m, restartedAt: null }, act: 'failed' };
  }
  if (m.was) {
    const expected = expectedAt !== undefined && now - expectedAt < EXPECTED_FOR;
    return { mem: { ...m, was: false, downAt: expected ? null : now }, act: 'none' };
  }
  if (m.downAt !== null && now - m.downAt >= GRACE) return { mem: { ...m, downAt: null }, act: 'check' };
  return { mem: m, act: 'none' };
}

/** Lines that only a crash leaves in the log. */
const CRASHED = /This crash report has been saved to|Preparing crash report|Encountered an unexpected exception|Exception in server tick loop|Considering it to be crashed|The server has stopped responding|A single server tick took|OutOfMemoryError|Failed to start the minecraft server|Exception in thread "main"/i;
/** Lines a clean stop leaves. */
const STOPPED = /Stopping the server|Stopping server|Closing Server|All dimensions are saved/i;

/** Did it crash? From the end of its log and a crash report written since it was last seen up. */
export function classifyStop(logTail: string, crash: { name: string; description: string | null } | null): { crashed: boolean; reason: string } {
  if (crash) return { crashed: true, reason: `It crashed${crash.description ? `: ${crash.description}` : ''}.` };
  const lines = plainLog(logTail).split('\n').filter((l) => l.trim());
  const bad = lines.find((l) => CRASHED.test(l));
  if (bad) return { crashed: true, reason: `It crashed: ${logMessage(bad).trim().slice(0, 200)}` };
  if (lines.some((l) => STOPPED.test(l))) return { crashed: false, reason: 'It was stopped cleanly.' };
  return { crashed: true, reason: lines.length ? 'It stopped without shutting down cleanly: killed, or out of memory?' : 'It stopped, and its log says nothing about why.' };
}

/** The end of the log, and any crash report from the last `minutes`, in one round trip. */
export function stopScript(s: McServer, minutes: number): string {
  return [
    `echo @@log; tail -n 80 ${shellQuote(logFile(s))} 2>/dev/null`,
    `echo @@crashfile; c=$(find ${shellQuote(crashDir(s))} -maxdepth 1 -name '*.txt' -mmin -${Math.max(1, Math.ceil(minutes))} 2>/dev/null | head -n 1); [ -n "$c" ] && echo "\${c##*/}"`,
    `echo @@crashtext; [ -n "$c" ] && head -c 8192 "$c" | sed 's/^@@/@ @/'`,
    'true',
  ].join('\n');
}

const expected = new Map<string, number>();
const mems = new Map<string, WatchMem>();

/** A stop Launchpad typed, or is about to: not a crash. */
export const expectStop = (id: string, at = Date.now()) => void expected.set(id, at);

function setWatch(id: string, fn: (r: McWatchRecord) => McWatchRecord): McWatchRecord {
  const all = store.mcWatch();
  const prev = all[id] ?? { gaveUp: false, log: [] };
  const next = fn(prev);
  if (next.gaveUp !== prev.gaveUp || next.log !== prev.log) store.setMcWatch({ ...all, [id]: { gaveUp: next.gaveUp, log: next.log.slice(-LOG_KEEP) } });
  return next;
}

function note(s: McServer, kind: McRestart['kind'], reason: string, crashReport: string | null, now: number): void {
  const at = new Date(now).toISOString();
  setWatch(s.id, (r) => ({ gaveUp: kind === 'gave-up' ? true : r.gaveUp, log: [...r.log, { at, kind, reason }] }));
  console.log(`[minecraft] ${s.name}: ${kind}: ${reason}`);
  emit({ type: kind, serverId: s.id, server: s.name, at, reason, crashReport });
}

/** It crashed: start it again, unless it has crashed too often lately. */
async function restartAfter(s: McServer, now: number): Promise<boolean> {
  const recent = (store.mcWatch()[s.id]?.log ?? []).filter((e) => e.kind === 'restart' && now - Date.parse(e.at) < RESTART_WINDOW);
  if (recent.length >= MAX_RESTARTS) {
    note(s, 'gave-up', `It crashed ${MAX_RESTARTS + 1} times in ${RESTART_WINDOW / 60_000} minutes, so Launchpad stopped restarting it. Fix the cause, then start it yourself.`, null, now);
    return false;
  }
  try {
    await startServer(s.id);
  } catch (e) {
    note(s, 'gave-up', `Launchpad couldn’t start it again: ${(e as Error).message}`, null, now);
    return false;
  }
  note(s, 'restart', `Started it again (${recent.length + 1} of ${MAX_RESTARTS} in ${RESTART_WINDOW / 60_000} minutes).`, null, now);
  return true;
}

async function watchOne(s: McServer, running: boolean, now: number): Promise<void> {
  if (running && store.mcWatch()[s.id]?.gaveUp) setWatch(s.id, (r) => ({ ...r, gaveUp: false }));
  const prev = mems.get(s.id) ?? NEW_MEM;
  const { mem, act } = watchStep(prev, running, now, expected.get(s.id));
  mems.set(s.id, mem);
  if (act === 'none' || busy.has(s.id) || store.mcWatch()[s.id]?.gaveUp) return;
  // Crash reports from this run only: since it was last seen up, or since the restart that never came up.
  const since = act === 'failed' ? (prev.restartedAt ?? now) : prev.lastUp;
  const r = await ssh(stopScript(s, (now - since) / 60_000 + 1), 15_000, `Looking at why ${s.name} stopped`);
  const facts = parseDiag(r.stdout);
  const crash = facts.crash ?? null;
  const verdict = classifyStop(facts.log, crash ? { name: crash.name, description: crash.description } : null);
  if (!verdict.crashed) return;
  // A start that never came up and left nothing new in the log says so; a crash says what it was.
  const reason = act === 'failed' && !crash && !verdict.reason.startsWith('It crashed') ? 'It didn’t come back up after Launchpad started it again.' : verdict.reason;
  note(s, 'crash', reason, crash?.name ?? null, now);
  if (await restartAfter(s, now)) mems.set(s.id, { ...mem, restartedAt: now });
}

let watching = false;

/** One look at every saved server that has Restart if it crashes on. */
export async function watchTick(now = Date.now()): Promise<void> {
  const on = store.minecraft().filter((s) => s.autoRestart && s.start);
  for (const id of mems.keys()) if (!on.some((s) => s.id === id)) mems.delete(id);
  if (!on.length || !shellConfigured() || watching) return;
  watching = true;
  try {
    const statuses = mergeStatuses(store.minecraft(), await detect(true));
    for (const s of on) {
      const st = statuses.find((x) => x.id === s.id);
      if (st) await watchOne(s, st.running, now).catch((e) => console.error(`[minecraft] watching ${s.name}: ${(e as Error).message}`));
    }
  } catch {
    // SSH is down or slow: look again next time.
  } finally {
    watching = false;
  }
}

/** Start watching; called once at boot. */
export function startMcWatch(): void {
  setInterval(() => void watchTick(), WATCH_EVERY).unref();
}
