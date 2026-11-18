// File work that can take minutes (unpacking, compressing, copying, moving, emptying
// the trash) runs here in the background, since Cloudflare gives up on a request after
// 100 seconds. The page polls the list, shows each with a Cancel, and refreshes the
// folder when one ends. Jobs live in memory: a restart forgets them.
import { randomBytes } from 'node:crypto';
import { FileError } from './shell';
import type { FileJob, FileJobKind } from '../../shared/files';

/** Running at once, across every page; more is refused rather than queued, so nothing starts unseen later. */
export const MAX_JOBS = 4;
/** A finished job stays listed this long, so a page that was away still hears how it went. */
const KEEP = 30 * 60_000;

interface Job extends FileJob {
  abort: AbortController;
}

const jobs = new Map<string, Job>();

export interface JobContext {
  signal: AbortSignal;
  /** Say what it's doing now. */
  progress: (message: string) => void;
}

/** What a job ends with: how it went, and something to go to. */
export interface JobEnd {
  message: string;
  result?: string;
}

const view = ({ abort: _a, ...j }: Job): FileJob => j;

function prune(now = Date.now()) {
  for (const [id, j] of jobs) if (j.endedAt && now - Date.parse(j.endedAt) > KEEP) jobs.delete(id);
}

/** Start `run` in the background; its error message is what the page shows. */
export function startJob(kind: FileJobKind, label: string, dir: string, run: (ctx: JobContext) => Promise<JobEnd>): FileJob {
  prune();
  if ([...jobs.values()].filter((j) => j.state === 'running').length >= MAX_JOBS) throw new FileError(`${MAX_JOBS} file jobs are running already. Wait for one to finish.`, 409);
  const job: Job = { id: randomBytes(9).toString('base64url'), kind, label, state: 'running', message: 'Starting…', dir, startedAt: new Date().toISOString(), abort: new AbortController() };
  jobs.set(job.id, job);
  const ctx: JobContext = { signal: job.abort.signal, progress: (m) => job.state === 'running' && (job.message = m) };
  run(ctx).then(
    (end) => {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'done';
      job.message = end.message;
      job.result = end.result;
    },
    (e: Error) => {
      job.state = job.abort.signal.aborted ? 'cancelled' : 'failed';
      job.message = job.abort.signal.aborted ? e.message || 'Stopped.' : e.message;
      if (!job.abort.signal.aborted) console.warn(`[files] ${label}:`, e.message);
    },
  ).finally(() => (job.endedAt = new Date().toISOString()));
  return view(job);
}

export function listJobs(): FileJob[] {
  prune();
  return [...jobs.values()].map(view).sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function cancelJob(id: string): FileJob[] {
  const j = jobs.get(id);
  if (j?.state === 'running') {
    j.message = 'Stopping…';
    j.abort.abort();
  }
  return listJobs();
}

/** Forget a finished job, once the page has shown how it went. */
export function dismissJob(id: string): FileJob[] {
  const j = jobs.get(id);
  if (j && j.state !== 'running') jobs.delete(id);
  return listJobs();
}

/** Whether a job is running in this folder or on these paths, so another doesn't start on top of it. */
export const jobRunning = (kind: FileJobKind, dir: string) => [...jobs.values()].some((j) => j.state === 'running' && j.kind === kind && j.dir === dir);
