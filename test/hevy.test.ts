import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanTraining, trainingFromHevy, workoutFromHevyApi } from '../shared/training';

/** A workout as Hevy's API sends it. */
const apiWorkout = (id: string, start: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: 'Push',
  start_time: start,
  end_time: start,
  exercises: [{ index: 0, title: 'Bench Press (Barbell)', notes: null, sets: [{ index: 0, type: 'normal', weight_kg: 60, reps: 8, distance_meters: null, duration_seconds: null, rpe: null }] }],
  ...extra,
});

describe('reading Hevy’s API', () => {
  it('turns a workout into Launchpad’s shape, in Hevy’s order', () => {
    const w = workoutFromHevyApi(
      apiWorkout('abc', '2026-11-20T02:00:00+00:00', {
        end_time: '2026-11-20T03:00:00Z',
        exercises: [
          { index: 1, title: 'Treadmill', notes: 'easy', sets: [{ index: 0, type: 'normal', distance_meters: 2170, duration_seconds: 1010 }] },
          { index: 0, title: 'Bench Press (Barbell)', sets: [{ index: 1, type: 'mystery', weight_kg: 60, reps: 8, rpe: 9.5 }, { index: 0, type: 'warmup', weight_kg: 20, reps: 10 }] },
        ],
      }),
    )!;
    expect(w).toMatchObject({ id: 'abc', title: 'Push', start: '2026-11-20T02:00:00.000Z', end: '2026-11-20T03:00:00.000Z' });
    expect(w.exercises.map((e) => e.title)).toEqual(['Bench Press (Barbell)', 'Treadmill']);
    expect(w.exercises[0].sets).toEqual([
      { type: 'warmup', kg: 20, reps: 10, km: null, sec: null, rpe: null },
      { type: 'normal', kg: 60, reps: 8, km: null, sec: null, rpe: 9.5 },
    ]);
    expect(w.exercises[1].sets[0]).toMatchObject({ km: 2.17, sec: 1010, kg: null });
  });
  it('refuses what isn’t a workout', () => {
    expect(workoutFromHevyApi(null)).toBeNull();
    expect(workoutFromHevyApi({ id: 'a', start_time: 'soon', exercises: [] })).toBeNull();
    expect(workoutFromHevyApi({ start_time: '2026-11-20T02:00:00Z', exercises: [] })).toBeNull();
    expect(workoutFromHevyApi({ id: 'a', start_time: '2026-11-20T02:00:00Z' })).toBeNull();
  });
  it('saves newest first, marked as synced, and survives cleaning', () => {
    const ws = [apiWorkout('old', '2026-11-01T02:00:00Z'), apiWorkout('new', '2026-11-20T02:00:00Z')].map((w) => workoutFromHevyApi(w)!);
    const t = trainingFromHevy(ws, '2026-11-26T00:00:00.000Z');
    expect(t.workouts.map((w) => w.id)).toEqual(['new', 'old']);
    expect(t.source).toBe('api');
    expect(cleanTraining(t)).toEqual(t);
  });
});

describe('syncing with Hevy', () => {
  let hevy: typeof import('../server/src/hevy');
  let store: (typeof import('../server/src/store'))['store'];
  /** What the fake Hevy holds, and the requests it got. */
  let remote: ReturnType<typeof apiWorkout>[];
  let events: unknown[];
  let calls: URL[];
  let failPage = 0;
  let status = 200;

  beforeAll(async () => {
    vi.stubEnv('HEVY_API_KEY', 'test-key');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.resetModules();
    hevy = await import('../server/src/hevy');
    store = (await import('../server/src/store')).store;
  });

  beforeEach(() => {
    store.setTraining({ workouts: [], source: '', importedAt: null });
    remote = Array.from({ length: 23 }, (_, i) => apiWorkout(`w${i}`, new Date(Date.UTC(2026, 9, 30 - i)).toISOString()));
    events = [];
    calls = [];
    failPage = 0;
    status = 200;
    vi.stubGlobal('fetch', async (input: string, init: RequestInit) => {
      const url = new URL(input);
      calls.push(url);
      expect(url.origin).toBe('https://api.hevyapp.com');
      expect((init.headers as Record<string, string>)['api-key']).toBe('test-key');
      expect(init.redirect).toBe('error');
      if (status !== 200) return new Response('{}', { status });
      if (url.pathname === '/v1/workouts/events') return Response.json({ page: 1, page_count: 1, events });
      const page = Number(url.searchParams.get('page'));
      if (page === failPage) return new Response('', { status: 500 });
      return Response.json({ page, page_count: Math.ceil(remote.length / 10), workouts: remote.slice((page - 1) * 10, page * 10) });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('downloads every page the first time', async () => {
    await hevy.syncHevy();
    expect(store.training().workouts).toHaveLength(23);
    expect(store.training().source).toBe('api');
    expect(calls.map((u) => u.searchParams.get('page'))).toEqual(['1', '2', '3']);
  });

  it('asks only what changed afterwards, and downloads when something did', async () => {
    await hevy.syncHevy();
    const first = store.training();
    calls = [];
    await hevy.syncHevy();
    expect(calls.map((u) => u.pathname)).toEqual(['/v1/workouts/events']);
    expect(Date.parse(calls[0].searchParams.get('since')!)).toBeLessThan(Date.parse(first.importedAt!));
    expect(store.training()).toEqual(first);

    remote = remote.slice(1);
    events = [{ type: 'deleted', id: 'w0' }];
    await hevy.syncHevy();
    expect(store.training().workouts).toHaveLength(22);
  });

  it('downloads again when asked by hand', async () => {
    await hevy.syncHevy();
    calls = [];
    await hevy.syncHevy(true);
    expect(calls.map((u) => u.pathname)).toEqual(['/v1/workouts', '/v1/workouts', '/v1/workouts']);
  });

  const imported = () => ({ workouts: [workoutFromHevyApi(apiWorkout('csv', '2026-01-01T02:00:00Z'))!], source: 'csv' as const, importedAt: '2026-01-02T00:00:00.000Z' });

  it('keeps a copy of imported workouts it replaces', async () => {
    const setCopy = vi.spyOn(store, 'setTrainingBeforeSync');
    store.setTraining(imported());
    await hevy.syncHevy();
    expect(setCopy).toHaveBeenCalledWith(imported());
    // Its own downloads aren't copied over it.
    await hevy.syncHevy(true);
    expect(setCopy).toHaveBeenCalledTimes(1);
    setCopy.mockRestore();
  });

  it('keeps what’s stored when a page fails, Hevy is empty, or a workout can’t be read', async () => {
    store.setTraining(imported());
    failPage = 2;
    await expect(hevy.syncHevy()).rejects.toThrow(/error \(500\)/);
    failPage = 0;
    remote = [];
    await expect(hevy.syncHevy()).rejects.toThrow(/no workouts/);
    remote = [apiWorkout('bad', 'never')];
    await expect(hevy.syncHevy()).rejects.toThrow(/can’t read/);
    expect(store.training()).toEqual(imported());
  });

  it('says why in words, without the key', async () => {
    status = 401;
    await expect(hevy.syncHevy()).rejects.toThrow(/refused the API key/);
    status = 429;
    await expect(hevy.syncHevy()).rejects.toThrow(/limiting requests/);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed: test-key');
    });
    await expect(hevy.syncHevy()).rejects.toThrow(/^Couldn’t reach Hevy\.$/);
  });
});
