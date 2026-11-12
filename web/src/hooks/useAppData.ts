import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../../shared/defaults';
import { emptyLearn } from '../../../shared/learn';
import { starterMoney } from '../../../shared/money';
import { EMPTY_TRAINING } from '../../../shared/training';
import type { AppState, SavedDoc } from '../../../shared/types';
import { api, cacheState, ServerError, TAB_ID } from '../api';
import type { ServerIssue } from '../components/ServerBanner';
import { flush, pendingCount, pendingItems, setOutboxHandlers, subscribeOutbox } from '../outbox';
import { applyPending, pendingDocs } from '../pending';
import { SAVED_DOCS, useSavers } from './useSavers';

const EMPTY: AppState = {
  bookmarks: STARTER_BOOKMARKS,
  notes: STARTER_NOTES,
  prefs: DEFAULT_PREFS,
  google: { configured: false, connected: false },
  calendars: [],
  events: [],
  taskLists: [],
  tasks: [],
  packages: [],
  sync: {
    calendar: { lastSuccess: null, lastAttempt: null, lastError: null },
    tasks: { lastSuccess: null, lastAttempt: null, lastError: null },
    gmail: { lastSuccess: null, lastAttempt: null, lastError: null },
    carriers: { lastSuccess: null, lastAttempt: null, lastError: null },
    news: { lastSuccess: null, lastAttempt: null, lastError: null },
    inbox: { lastSuccess: null, lastAttempt: null, lastError: null },
    weather: { lastSuccess: null, lastAttempt: null, lastError: null },
    speedtest: { lastSuccess: null, lastAttempt: null, lastError: null },
  },
  tracking: { allCarriers: false },
  news: [],
  newsSummaries: false,
  inbox: { emails: [], digests: { '2d': null, '7d': null }, fetchedAt: null, error: null },
  weather: { areas: [], now: null },
  photos: [],
  countdowns: [],
  smokes: [],
  smokeDays: { before: '', counts: {} },
  cravings: [],
  moods: {},
  money: starterMoney(new Date()),
  training: EMPTY_TRAINING,
  exerciseMuscles: {},
  trainingNote: { note: null, error: null },
  weights: {},
  learn: emptyLearn(),
  learnNote: { note: null, error: null },
  reviewNotes: { notes: {}, error: null },
  delivered: [],
};

/** A cached copy from an older version can be missing newer fields. */
export function fromCache(c: AppState | null): AppState {
  if (!c) return EMPTY;
  return { ...EMPTY, ...c, prefs: { ...DEFAULT_PREFS, ...c.prefs }, sync: { ...EMPTY.sync, ...c.sync }, inbox: c.inbox ?? EMPTY.inbox, money: Array.isArray(c.money?.entries) ? c.money : EMPTY.money, training: Array.isArray(c.training?.workouts) ? c.training : EMPTY.training, exerciseMuscles: c.exerciseMuscles ?? {}, trainingNote: c.trainingNote ?? EMPTY.trainingNote, weights: c.weights ?? {}, learn: Array.isArray(c.learn?.courses) ? c.learn : EMPTY.learn, learnNote: c.learnNote ?? EMPTY.learnNote, smokeDays: c.smokeDays ?? EMPTY.smokeDays, cravings: c.cravings ?? [], reviewNotes: c.reviewNotes ?? EMPTY.reviewNotes, delivered: c.delivered ?? [] };
}

/**
 * Everything the page shows, painted from the local copy first and then kept up to date
 * from the server: on load, from the change stream (/api/events) when another tab, a phone
 * or a sync changes something, and from a slow poll as a backstop. Edits are kept in the
 * local copy at once and saved in the background (see useSavers).
 */
export function useAppData({ cached, notify, onSaveError, onNotesSaved, onMoneySaved, noteEditing }: {
  /** The copy kept in the browser, to paint from before the server answers. */
  cached: AppState | null;
  notify: (msg: string) => void;
  onSaveError: (e: Error) => void;
  onNotesSaved: () => void;
  onMoneySaved: () => void;
  /** Notes are being typed in, so a refresh shouldn't swap them out yet. */
  noteEditing: RefObject<boolean>;
}) {
  // Edits still waiting in the queue (made offline, maybe before a reload) are on screen too.
  const [data, setData] = useState<AppState>(() => applyPending(fromCache(cached), pendingItems()));
  const waiting = useSyncExternalStore(subscribeOutbox, pendingCount);
  const [serverIssue, setServerIssue] = useState<ServerIssue | null>(null);

  const update = useCallback((fn: (d: AppState) => AppState) => {
    setData((d) => {
      const next = fn(d);
      cacheState(next);
      return next;
    });
  }, []);

  /** The latest data, for saves that finish after more edits. */
  const dataRef = useRef(data);
  dataRef.current = data;

  const { savers, setBase } = useSavers({ data, dataRef, update, notify, onError: onSaveError, onNotesSaved, onMoneySaved });

  /** Take fresh server state, all of it or some parts, but keep local edits that haven't been saved yet. */
  const merge = useCallback(
    (fresh: Partial<AppState>) => {
      const queued = pendingItems();
      const docs = pendingDocs(queued);
      const keep: Record<SavedDoc, boolean> = {
        bookmarks: savers.bookmarks.busy() || docs.has('bookmarks'),
        notes: savers.notes.busy() || noteEditing.current || docs.has('notes'),
        money: savers.money.busy() || docs.has('money'),
        learn: savers.learn.busy() || docs.has('learn'),
      };
      // Small saves still waiting (a cigarette, a mood...) stay on screen until they reach the server.
      const s = applyPending(fresh, queued.filter((p) => p.kind !== 'doc'));
      // A document taken from the server is the new starting point for the next save; one kept keeps its old one.
      for (const k of SAVED_DOCS) if (s[k] !== undefined && !keep[k]) setBase(k, s[k], s.versions?.[k]);
      update((prev) => {
        const next = { ...prev, ...s, versions: { ...prev.versions, ...s.versions } };
        for (const k of SAVED_DOCS) if (keep[k]) Object.assign(next, { [k]: prev[k] });
        return next;
      });
    },
    [update, savers, setBase, noteEditing],
  );

  /** Put a restored copy on screen: it wins over anything there, unsaved edits included, and is where the next saves start. */
  const replace = useCallback(
    (s: AppState) => {
      for (const k of SAVED_DOCS) setBase(k, s[k], s.versions?.[k]);
      update(() => fromCache(s));
    },
    [update, setBase],
  );

  const lastRefresh = useRef(0);
  /** The change stream is open, so polling can slow right down. */
  const live = useRef(false);
  /** Fetch the state and take it in: all of it, or with `keys`, just what those store keys feed. */
  const refresh = useCallback(
    (keys?: string[]) =>
      (Array.isArray(keys) ? api.stateFor(keys) : api.state())
        .then((s) => {
          merge(s);
          setServerIssue(null);
          if (!Array.isArray(keys)) lastRefresh.current = Date.now();
          // The server answers again: send what was saved while it didn't. A full fetch also
          // looks for edits another tab left in the queue; a partial one only for this tab's.
          if (!Array.isArray(keys) || pendingCount()) void flush();
        })
        .catch((e) => {
          console.warn('refresh failed', e);
          // Keep the first time it failed, so the banner says how long it's been.
          if (e instanceof ServerError) setServerIssue((prev) => (prev?.kind === e.kind ? prev : { kind: e.kind, status: e.status, since: new Date() }));
        }),
    [merge],
  );

  useEffect(() => {
    refresh();
    // While the change stream is open, a full fetch every 5 minutes is only a backstop.
    const iv = window.setInterval(() => (!live.current || Date.now() - lastRefresh.current > 5 * 60_000) && refresh(), 60_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Tasks sync "on focus", throttled server-side to once every 30 s.
      api.sync('tasks', 30).then(merge).catch(() => refresh());
    };
    const onOnline = () => refresh();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh, merge]);

  useEffect(() => {
    setOutboxHandlers({
      // Fetching shows the banner straight away if the server really is unreachable.
      queued: () => refresh(),
      sent: () => refresh(),
      dropped: (_, e) => notify(`Couldn’t save a change made while the server was unreachable: ${e.message}`),
      docSaved: (key, value, version) => {
        if (!savers[key].busy()) setBase(key, value, version);
      },
      docConflict: (key) => (savers[key] as { schedule: (v: unknown) => void }).schedule(dataRef.current[key]),
    });
  }, [refresh, notify, savers, setBase]);

  // Live updates: the server says which store keys changed (another tab, a phone, a sync that
  // finished) and this tab fetches just the parts of the state those feed. Only a visible tab
  // keeps the stream open, so a pile of background tabs doesn't use up the browser's six
  // connections over plain HTTP.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let soon = 0;
    let retry = 0;
    /** Keys changed since the last fetch; null when it should be everything. */
    let keys: Set<string> | null = new Set();
    const later = (changed: string[] | null) => {
      if (keys && changed) for (const k of changed) keys.add(k);
      else keys = null;
      clearTimeout(soon);
      soon = window.setTimeout(() => {
        const ask = keys;
        keys = new Set();
        refresh(ask ? [...ask] : undefined);
      }, 150);
    };
    const onChange = (e: MessageEvent<string>) => {
      let changed: string[] | null = null;
      try {
        const k = (JSON.parse(e.data) as { keys?: unknown }).keys;
        if (Array.isArray(k) && k.length && k.every((x) => typeof x === 'string')) changed = k;
      } catch {
        // Not a message this page understands: fetch everything.
      }
      later(changed);
    };
    const open = () => {
      if (es || document.visibilityState !== 'visible') return;
      const src = new EventSource(`/api/events?tab=${TAB_ID}`);
      let hellos = 0;
      // Reconnected after a restart or a dropped connection: catch up on everything that was missed.
      src.addEventListener('hello', () => {
        live.current = true;
        if (hellos++) later(null);
      });
      src.addEventListener('change', onChange);
      src.onerror = () => {
        live.current = false;
        // EventSource retries a dropped stream itself, but gives up on an error status (a
        // proxy's 502, Access's 403). Then try again in a while, and let refresh show why.
        if (src.readyState === EventSource.CLOSED) {
          close();
          refresh();
          retry = window.setTimeout(open, 30_000);
        }
      };
      es = src;
    };
    const close = () => {
      es?.close();
      es = null;
      live.current = false;
      clearTimeout(retry);
    };
    const onVisible = () => (document.visibilityState === 'visible' ? open() : close());
    open();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      close();
      clearTimeout(soon);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  return { data, update, savers, merge, replace, refresh, serverIssue, waiting };
}
