// Docker for the Server view. The container list and logs come through a read-only
// socket proxy (DOCKER_HOST); restarts go to a second proxy that lets through only
// stop, restart and kill (DOCKER_RESTART_HOST). On top of that, every request passes
// dockerRequestAllowed first, so Launchpad itself sends Docker nothing but those
// reads and a restart, whatever a proxy would allow.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { config } from './config';
import type { ContainerInfo, LogLine } from '../../shared/types';

/** An error the page can show, with the HTTP status that fits it. */
export class DockerError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 500 | 502 | 503 = 500) {
    super(message);
  }
}

const ID = /^[0-9a-f]{64}$/;

/**
 * The only requests Launchpad makes to Docker: list containers, read one's logs, restart one.
 * Anything else (start, stop, kill, exec, create, delete, another query) is refused here.
 */
export function dockerRequestAllowed(method: string, apiPath: string): boolean {
  const i = apiPath.indexOf('?');
  const p = i < 0 ? apiPath : apiPath.slice(0, i);
  const q = i < 0 ? '' : apiPath.slice(i + 1);
  if (!/^[A-Za-z0-9=&.]*$/.test(q)) return false;
  const keys = q ? q.split('&').map((kv) => kv.split('=')[0]) : [];
  const only = (allowed: string[]) => keys.every((k) => allowed.includes(k));
  if (method === 'GET' && p === '/containers/json') return only(['all']);
  const m = /^\/containers\/([0-9a-f]{64})\/(logs|restart)$/.exec(p);
  if (!m) return false;
  if (method === 'GET' && m[2] === 'logs') return only(['stdout', 'stderr', 'timestamps', 'tail', 'since']);
  if (method === 'POST' && m[2] === 'restart') return only(['t']);
  return false;
}

const MAX_BODY = 16 * 1024 * 1024;

/** A request to Docker: reads to DOCKER_HOST, the one write (restart) to DOCKER_RESTART_HOST. */
function request(method: 'GET' | 'POST', apiPath: string, timeout: number): Promise<{ status: number; body: Buffer }> {
  if (!dockerRequestAllowed(method, apiPath)) return Promise.reject(new DockerError(`Launchpad doesn’t send Docker ${method} ${apiPath.split('?')[0]}.`, 400));
  const target = method === 'POST' ? config.dockerRestartHost : config.dockerHost;
  const opts: http.RequestOptions = { path: apiPath, method, timeout, headers: { Host: 'docker' } };
  if (target.startsWith('unix://')) opts.socketPath = target.slice('unix://'.length);
  else {
    const u = new URL(target.replace(/^tcp:\/\//, 'http://'));
    opts.host = u.hostname;
    opts.port = Number(u.port || 2375);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) req.destroy(new DockerError('Docker sent more than 16 MB. Ask for fewer lines.', 502));
        else chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 500, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new DockerError('Docker didn’t answer in time.', 502)));
    req.on('error', reject);
    req.end();
  });
}

/** Docker's own error message, from a JSON body like {"message": "..."}. */
function dockerMessage(body: Buffer): string {
  try {
    return (JSON.parse(body.toString('utf8')) as { message?: string }).message ?? '';
  } catch {
    return '';
  }
}

// ---------- containers ----------

let ownId: string | null | undefined;

/** Launchpad's own container id: Docker mounts /etc/hostname from a folder named after it. */
function ownContainerId(): string | null {
  if (ownId !== undefined) return ownId;
  ownId = null;
  try {
    ownId = /\/containers\/([0-9a-f]{64})\/(?:hostname|hosts|resolv\.conf)\s/.exec(fs.readFileSync('/proc/self/mountinfo', 'utf8'))?.[1] ?? null;
  } catch {
    // Not Linux, or not in a container.
  }
  return ownId;
}

/** A container's hostname is the start of its id, unless compose set another. */
export function isOwnContainer(id: string, own = ownContainerId(), hostname = os.hostname()): boolean {
  if (own) return id === own;
  return /^[0-9a-f]{12}$/.test(hostname) && id.startsWith(hostname);
}

interface DockerContainer { Id?: string; Names?: string[]; Image?: string; State?: string; Status?: string }

export function toContainers(list: DockerContainer[], isSelf: (id: string) => boolean = () => false): ContainerInfo[] {
  return list
    .map((c) => ({
      id: c.Id ?? '',
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      image: c.Image ?? '',
      state: c.State ?? 'unknown',
      status: c.Status ?? '',
      self: !!c.Id && isSelf(c.Id),
    }))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
}

async function listContainers(): Promise<ContainerInfo[]> {
  const res = await request('GET', '/containers/json?all=1', 4000);
  if (res.status >= 400) throw new DockerError(`Docker answered ${res.status}`, 502);
  try {
    // docker-compose.yml names it launchpad, should the id not be found.
    const list = JSON.parse(res.body.toString('utf8')) as DockerContainer[];
    return toContainers(list, (id) => isOwnContainer(id) || list.find((c) => c.Id === id)?.Names?.[0] === '/launchpad');
  } catch {
    throw new DockerError('Docker sent something that isn’t JSON', 502);
  }
}

/** The container list for the Server view, or why it isn't there. */
export async function containers(): Promise<{ list: ContainerInfo[] | null; error: string | null }> {
  if (!config.dockerHost) return { list: null, error: null };
  try {
    return { list: await listContainers(), error: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const down = ['ENOTFOUND', 'ECONNREFUSED', 'ENOENT', 'EAI_AGAIN'].includes(err.code ?? '');
    return { list: null, error: down ? `Docker isn’t reachable at ${config.dockerHost}. Is the docker-proxy service running?` : err.message };
  }
}

// ---------- restart ----------

export const canRestart = () => !!(config.dockerHost && config.dockerRestartHost);

/** The one write Launchpad makes: restart a container that's in the list, and not Launchpad itself. */
export function restartPath(id: unknown, list: ContainerInfo[]): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new DockerError('That isn’t a container id.', 400);
  const c = list.find((x) => x.id === id);
  if (!c) throw new DockerError('There’s no such container.', 404);
  if (c.self) throw new DockerError('That’s Launchpad itself, which can’t restart itself from the page. On the server: docker compose restart launchpad', 409);
  return `/containers/${id}/restart?t=10`;
}

export async function restartContainer(id: unknown): Promise<void> {
  if (!canRestart()) throw new DockerError('Restarts aren’t set up: add the docker-restart service from docker-compose.yml (docs/setup.md, step 8).', 503);
  const p = restartPath(id, await listContainers());
  let res: { status: number; body: Buffer };
  try {
    // Docker waits up to 10 s for it to stop, then starts it again.
    res = await request('POST', p, 60_000);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN'].includes(err.code ?? '')) throw new DockerError(`The restart proxy isn’t reachable at ${config.dockerRestartHost}. Is the docker-restart service running?`, 502);
    // Restarting the proxy itself drops the connection on the way down.
    if (err.code === 'ECONNRESET' || /socket hang up/i.test(err.message)) throw new DockerError('The connection closed while it restarted. Check its status in a moment.', 502);
    throw e;
  }
  if (res.status === 204 || res.status === 200) return;
  if (res.status === 404) throw new DockerError('There’s no such container.', 404);
  if (res.status === 403) throw new DockerError('The restart proxy refused it. Check that docker-restart has POST=1 and ALLOW_RESTARTS=1.', 502);
  throw new DockerError(dockerMessage(res.body) || `Docker answered ${res.status}`, 502);
}

// ---------- logs ----------

export const MAX_LOG_LINES = 5000;
const MAX_LINE = 4000;

// Colour codes and other terminal escapes, then the control characters left over.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;
const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z ?/;

function logLine(stream: LogLine['stream'], raw: string): LogLine {
  const m = TS.exec(raw);
  // A progress bar redraws its line with \r; keep what it showed last.
  const shown = (m ? raw.slice(m[0].length) : raw).split('\r').filter(Boolean).pop() ?? '';
  const text = shown.replace(ANSI, '').replace(CONTROL, '');
  return { at: m ? `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z` : null, stream, text: text.length > MAX_LINE ? text.slice(0, MAX_LINE) + '…' : text };
}

/**
 * Docker's log stream as lines. A container without a terminal sends frames, each with an
 * 8-byte header saying stdout (1) or stderr (2) and how long it is; one with a terminal (tty)
 * sends the text as it is. With timestamps on, that text starts with a digit, never 0–2.
 */
export function parseDockerLogs(buf: Buffer): LogLine[] {
  const out: LogLine[] = [];
  const pending: Record<LogLine['stream'], string> = { out: '', err: '' };
  const take = (stream: LogLine['stream'], text: string) => {
    const parts = (pending[stream] + text).split('\n');
    pending[stream] = parts.pop()!;
    for (const l of parts) out.push(logLine(stream, l));
  };
  if (buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0) {
    for (let i = 0; i + 8 <= buf.length; ) {
      const end = Math.min(buf.length, i + 8 + buf.readUInt32BE(i + 4));
      take(buf[i] === 2 ? 'err' : 'out', buf.toString('utf8', i + 8, end));
      i = end;
    }
  } else take('out', buf.toString('utf8'));
  for (const s of ['out', 'err'] as const) if (pending[s]) out.push(logLine(s, pending[s]));
  return out;
}

/** A line's timestamp as Docker's `since` wants it: seconds since 1970, with the fraction. */
export function sinceParam(at: unknown): string | null {
  const m = typeof at === 'string' ? /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)\.(\d{9})Z$/.exec(at) : null;
  const secs = m ? Date.parse(m[1] + 'Z') / 1000 : NaN;
  return Number.isFinite(secs) ? `${secs}.${m![2]}` : null;
}

/** The last `tail` lines of a container's log, stdout and stderr together; with `since`, only lines from then on. */
export async function containerLogs(id: unknown, tail: unknown, since: unknown): Promise<LogLine[]> {
  if (!config.dockerHost) throw new DockerError('Docker isn’t connected (DOCKER_HOST).', 503);
  if (typeof id !== 'string' || !ID.test(id)) throw new DockerError('That isn’t a container id.', 400);
  const n = Math.min(MAX_LOG_LINES, Math.max(1, Math.round(Number(tail)) || 500));
  const from = sinceParam(since);
  const res = await request('GET', `/containers/${id}/logs?stdout=1&stderr=1&timestamps=1&tail=${n}${from ? `&since=${from}` : ''}`, 15_000);
  if (res.status === 404) throw new DockerError('There’s no such container.', 404);
  if (res.status >= 400) throw new DockerError(dockerMessage(res.body) || `Docker answered ${res.status}`, 502);
  return parseDockerLogs(res.body);
}
