// Live sync with Hevy's API (https://api.hevyapp.com), for Training. Needs
// HEVY_API_KEY, which Hevy gives to Pro subscribers. Launchpad only reads.
//
// Each run asks Hevy whether any workout changed since the last download. Only
// then is the whole history fetched again, so edits and deletions come through,
// and it replaces what's stored only once every page has arrived.
import { config } from './config';
import { store } from './store';
import { refreshTraining } from './training';
import { MAX_WORKOUTS, trainingFromHevy, workoutFromHevyApi } from '../../shared/training';
import type { Workout } from '../../shared/types';

const BASE = 'https://api.hevyapp.com';
/** The most Hevy sends on one page. */
const PAGE_SIZE = 10;
/** Allowed difference between this server's clock and Hevy's when asking what changed. */
const CLOCK_SLACK = 2 * 60_000;

export const hevyEnabled = () => !!config.hevyKey;

/** One read from Hevy; failures come back in words the page can show, never with the key in them. */
async function get<T>(path: string, query: Record<string, string>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}?${new URLSearchParams(query)}`, {
      headers: { 'api-key': config.hevyKey, accept: 'application/json' },
      // A redirect would carry the key somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new Error((e as Error).name === 'TimeoutError' ? 'Hevy took too long to answer.' : 'Couldn’t reach Hevy.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Hevy refused the API key. Check HEVY_API_KEY, and that Hevy Pro is still active.');
  if (res.status === 429) throw new Error('Hevy is limiting requests. Launchpad will try again later.');
  if (!res.ok) throw new Error(`Hevy answered with an error (${res.status}).`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error('Hevy sent an answer Launchpad can’t read.');
  }
}

/** Whether any workout was added, edited or deleted since `since`. */
async function changedSince(since: string): Promise<boolean> {
  const from = new Date(Date.parse(since) - CLOCK_SLACK).toISOString();
  const res = await get<{ events?: unknown }>('/v1/workouts/events', { page: '1', pageSize: '1', since: from });
  if (!Array.isArray(res?.events)) throw new Error('Hevy sent an answer Launchpad can’t read.');
  return res.events.length > 0;
}

/** The whole history, a page at a time. Throws rather than return part of it. */
async function allWorkouts(): Promise<Workout[]> {
  // By id: a workout saved while this runs shifts the pages, so one can come twice.
  const byId = new Map<string, Workout>();
  let pages = 1;
  for (let page = 1; page <= pages && byId.size < MAX_WORKOUTS; page++) {
    const res = await get<{ page_count?: unknown; workouts?: unknown }>('/v1/workouts', { page: String(page), pageSize: String(PAGE_SIZE) });
    if (!Array.isArray(res?.workouts) || !Number.isInteger(res.page_count)) throw new Error('Hevy sent an answer Launchpad can’t read.');
    pages = res.page_count as number;
    for (const raw of res.workouts) {
      const w = workoutFromHevyApi(raw);
      // One that can't be read would silently vanish from the history, so stop instead.
      if (!w) throw new Error('Hevy sent a workout Launchpad can’t read.');
      byId.set(w.id, w);
    }
  }
  return [...byId.values()];
}

/**
 * Bring the stored workouts up to date with Hevy. `force` downloads everything
 * even when Hevy reports no change.
 */
export async function syncHevy(force = false): Promise<void> {
  const before = store.training();
  if (!force && before.source === 'api' && before.importedAt && !(await changedSince(before.importedAt))) return;
  // Taken before downloading, so a change made during it is picked up next time.
  const startedAt = new Date().toISOString();
  const workouts = await allWorkouts();
  // Read again: an import may have landed during the download.
  const current = store.training();
  if (!workouts.length && current.workouts.length) throw new Error('Hevy sent no workouts, so the ones here were kept.');
  // What came from a file is kept aside the first time Hevy's data takes its place.
  if (current.source !== 'api' && current.workouts.length) store.setTrainingBeforeSync(current);
  store.setTraining(trainingFromHevy(workouts, startedAt));
  // Claude labels new exercises in the background.
  refreshTraining();
}
