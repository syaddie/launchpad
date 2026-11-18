// Server › Downloads' Python helpers (instagram.py, ytdlp.py): each takes one JSON request on
// stdin and answers with one JSON object a line on stdout, the last an "error" or "done".
import { spawn } from 'node:child_process';
import os from 'node:os';
import readline from 'node:readline';

/** What a helper said went wrong, with its code (login, missing, unsupported, …). */
export class HelperError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface Helper {
  python: string;
  script: string;
  /** What to say when Python or the helper's library isn't there. */
  missing: string;
  /** What to say when it takes longer than `timeout`. */
  slow: string;
  /** Its name, for "The … helper stopped". */
  name: string;
}

export interface HelperOptions {
  signal?: AbortSignal;
  timeout?: number;
  /** Stop what it started too (ffmpeg under yt-dlp) when it's stopped: its own process group, outside Windows. */
  group?: boolean;
}

/** The last line of what a helper printed to stderr, as the reason when it stops without saying why. */
export function lastLine(text: string): string {
  return text.trim().split(/\r?\n/).pop()?.trim().slice(0, 400) ?? '';
}

/**
 * Run `h` with `req` and hand each line it prints to `onEvent`, one at a time (the next waits
 * until it's done). Resolves when the helper finishes; rejects with what it said went wrong, or
 * the signal's reason once aborted.
 */
export async function runHelper<E extends { type: string }>(h: Helper, req: object, onEvent: (e: E) => unknown, opts: HelperOptions = {}): Promise<void> {
  if (opts.signal?.aborted) throw opts.signal.reason;
  const group = !!opts.group && process.platform !== 'win32';
  const child = spawn(h.python, [h.script], {
    cwd: os.tmpdir(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1' },
    windowsHide: true,
    detached: group,
  });
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
  child.stdin.on('error', () => {});
  const exited = new Promise<number | null>((resolve) => child.once('close', (code) => resolve(code)));
  let timedOut = false;
  const kill = () => {
    if (group && child.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
        return;
      } catch {
        // Gone already, or not a group after all: stop the helper itself.
      }
    }
    child.kill();
  };
  opts.signal?.addEventListener('abort', kill);
  const timer = opts.timeout
    ? setTimeout(() => {
        timedOut = true;
        kill();
      }, opts.timeout)
    : undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (e) => reject(new HelperError(`${h.missing} (${(e as Error).message})`, 'missing')));
    });
    child.stdin.end(JSON.stringify(req));
    let failed: HelperError | null = null;
    for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      let ev: E & { error?: string; code?: string };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'error') failed = new HelperError(ev.code === 'missing' ? h.missing : String(ev.error), String(ev.code ?? 'other'));
      else await onEvent(ev);
    }
    const code = await exited;
    if (opts.signal?.aborted) throw opts.signal.reason;
    if (timedOut) throw new HelperError(h.slow, 'other');
    if (failed) throw failed;
    if (code !== 0) throw new HelperError(lastLine(stderr) || `The ${h.name} helper stopped (exit ${code}).`, 'other');
  } catch (e) {
    if (opts.signal?.aborted) throw opts.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', kill);
    if (child.exitCode === null && child.signalCode === null) kill();
  }
}
