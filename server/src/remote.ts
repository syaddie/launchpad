// Commands on the server that may run for a while: searches, folder sizes, unpacking,
// copying. Each gets an SSH connection of its own, so it doesn't hold up the file
// explorer's shared one or get closed with it when that goes idle, and each can be
// stopped: on a time limit, when the page cancels, or once it has printed enough.
//
// Closing an SSH channel doesn't stop what it started (a tar writing files never
// notices), so the command first prints its process group, which sshd made for it,
// and stopping it kills that whole group: the shell and everything it ran.
import type { Client, ClientChannel } from 'ssh2';
import { openSsh, shellQuote } from './shell';

export type StopReason = 'timeout' | 'cancel' | 'limit';

export interface RemoteResult {
  /** The command's exit code; null when it was stopped or died of a signal. */
  code: number | null;
  /** What it printed, up to `maxOutput` bytes, unless `onData` took it. */
  stdout: string;
  stderr: string;
  /** Why it was stopped early, or null when it ended by itself. */
  stopped: StopReason | null;
}

export interface RemoteOptions {
  /** Milliseconds before it's stopped. */
  timeout: number;
  /** Bytes of output kept; past that it's stopped as 'limit'. Default 4 MB. */
  maxOutput?: number;
  /** Output as it comes, instead of collecting it. Return true to stop the command ('limit'). */
  onData?: (chunk: Buffer) => boolean | void;
  signal?: AbortSignal;
}

export interface RemoteRun {
  done: Promise<RemoteResult>;
  stop: (why?: StopReason) => void;
}

const MAX_ERR = 64 * 1024;

/**
 * `sh -c` with the command, after printing its process group: sshd starts every
 * command in a session of its own, so that group is just this command's.
 * `ps` gives the group; where it can't, the shell's own pid is the best guess.
 */
export const wrapCommand = (cmd: string) => `sh -c ${shellQuote('echo "$(ps -o pgid= -p $$ 2>/dev/null || echo $$)"; exec sh -c "$0"')} ${shellQuote(cmd)}`;

/** The process group from the first line the wrapper prints, and whatever came after it. */
export function splitPgid(head: string): { pgid: number | null; rest: string } | null {
  const nl = head.indexOf('\n');
  if (nl < 0) return null;
  const n = Number(head.slice(0, nl).trim());
  return { pgid: Number.isInteger(n) && n > 1 ? n : null, rest: head.slice(nl + 1) };
}

function exec(conn: Client, cmd: string): Promise<ClientChannel> {
  return new Promise((resolve, reject) => conn.exec(cmd, (e, ch) => (e ? reject(e) : resolve(ch))));
}

/** Kill a process group over its own channel, gently and then not. */
function killGroup(conn: Client, pgid: number): Promise<void> {
  const cmd = `kill -TERM -- -${pgid} 2>/dev/null || kill -TERM ${pgid} 2>/dev/null; sleep 2; kill -KILL -- -${pgid} 2>/dev/null; true`;
  return exec(conn, cmd)
    .then(
      (ch) =>
        new Promise<void>((resolve) => {
          ch.on('close', () => resolve());
          ch.on('data', () => {});
          ch.stderr.on('data', () => {});
          setTimeout(resolve, 5000);
        }),
    )
    .catch(() => {});
}

/** Start `cmd` on the server on a connection of its own, which is closed when it ends. */
export function runRemote(cmd: string, opts: RemoteOptions): RemoteRun {
  let stopWith: StopReason | null = null;
  let stopNow: (() => void) | null = null;
  const stop = (why: StopReason = 'cancel') => {
    if (stopWith) return;
    stopWith = why;
    stopNow?.();
  };
  if (opts.signal?.aborted) stop('cancel');
  opts.signal?.addEventListener('abort', () => stop('cancel'), { once: true });

  const done = (async (): Promise<RemoteResult> => {
    if (stopWith) return { code: null, stdout: '', stderr: '', stopped: stopWith };
    const conn = await openSsh();
    try {
      const ch = await exec(conn, wrapCommand(cmd));
      // Nothing is typed into it: a command that asks (a password, say) reads the end of its input and gives up.
      ch.end();
      return await new Promise<RemoteResult>((resolve) => {
        const max = opts.maxOutput ?? 4 * 1024 * 1024;
        let head = '';
        let pgid: number | null = null;
        let started = false;
        const out: Buffer[] = [];
        let outBytes = 0;
        let stderr = '';
        let killing: Promise<void> | null = null;
        let finished = false;
        const kill = () => {
          if (killing) return;
          // The group isn't known yet: the data handler kills it once it is, or the channel goes if it never says.
          if (!started) {
            setTimeout(() => !killing && ch.close(), 3000);
            return;
          }
          killing = (pgid ? killGroup(conn, pgid) : Promise.resolve()).finally(() => ch.close());
        };
        stopNow = kill;
        const timer = setTimeout(() => stop('timeout'), opts.timeout);
        const take = (d: Buffer) => {
          if (killing) return;
          if (opts.onData) {
            if (opts.onData(d)) stop('limit');
            return;
          }
          if (outBytes + d.length > max) {
            out.push(d.subarray(0, max - outBytes));
            outBytes = max;
            stop('limit');
            return;
          }
          out.push(d);
          outBytes += d.length;
        };
        ch.on('data', (d: Buffer) => {
          if (started) return take(d);
          head += d.toString('latin1');
          const split = splitPgid(head);
          if (!split) return;
          started = true;
          pgid = split.pgid;
          // A stop asked for before the group was known happens now.
          if (stopWith) kill();
          if (split.rest) take(Buffer.from(split.rest, 'latin1'));
        });
        ch.stderr.on('data', (d: Buffer) => stderr.length < MAX_ERR && (stderr += d.toString('utf8')));
        ch.on('close', (code: number | null) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ code: stopWith ? null : (code ?? null), stdout: Buffer.concat(out).toString('utf8'), stderr: stderr.trim(), stopped: stopWith });
        });
      });
    } finally {
      conn.end();
    }
  })();
  return { done, stop };
}
