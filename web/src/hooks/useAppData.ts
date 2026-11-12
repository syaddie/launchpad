import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../../shared/defaults';
import { emptyLearn } from '../../../shared/learn';
import { starterMoney } from '../../../shared/money';
import { EMPTY_TRAINING } from '../../../shared/training';
import type { AppState, SavedDoc } from '../../../shared/types';
import { api, cachedState, cacheState, ServerError, TAB_ID } from '../api';
import type { ServerIssue } from '../components/ServerBanner';
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
  moods: {},
  money: starterMoney(new Date()),
  training: EMPTY_TRAINING,
  exerciseMuscles: {},
  trainingNote: { note: null, error: null },
  weights: {},
  learn: emptyLearn(),
  learnNote: { note: null, error: null },
};

/** A cached copy from an older version can be missing newer fields. */
export function fromCache(c: AppState | null): AppState {
  if (!c) return EMPTY;
  return { ...EMPTY, ...c, prefs: { ...DEFAULT_PREFS, ...c.prefs }, sync: { ...EMPTY.sync, ...c.sync }, inbox: c.inbox ?? EMPTY.inbox, money: Array.isArray(c.money?.entries) ? c.money : EMPTY.money, training: Array.isArray(c.training?.workouts) ? c.training : EMPTY.training, exerciseMuscles: c.exerciseMuscles ?? {}, trainingNote: c.trainingNote ?? EMPTY.trainingNote, weights: c.weights ?? {}, learn: Array.isArray(c.learn?.courses) ? c.learn : EMPTY.learn, learnNote: c.learnNote ?? EMPTY.learnNote };
}

/**
 * Everything the page shows, painted from the local copy first and then kept up to date
 * from the server: on load, from the change stream (/api/events) when another tab, a phone
 * or a sync changes something, and from a slow poll as a backstop. Edits are kept in the
 * local copy at once and saved in the background (see useSavers).
 */
export function useAppData({ notify, onSaveError, onNotesSaved, onMoneySaved, noteEditing }: {
  notify: (msg: string) => void;
  onSaveError: (e: Error) => void;
  onNotesSaved: () => void;
  onMoneySaved: () => void;
  /** Notes are being typed in, so a refresh shouldn't swap them out yet. */
  noteEditing: RefObject<boolean>;
}) {
  const [data, setData] = useState<AppState>(() => fromCache(cachedState()));
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

  /** Take fresh server state, but keep local edits that haven't been saved yet. */
  const merge = useCallback(
    (s: AppState) => {
      const keep: Record<SavedDoc, boolean> = {
        bookmarks: savers.bookmarks.busy(),
        notes: savers.notes.busy() || noteEditing.current,
        money: savers.money.busy(),
        learn: savers.learn.busy(),
      };
      // A document taken from the server is the new starting point for the next save; one kept keeps its old one.
      for (const k of SAVED_DOCS) if (!keep[k]) setBase(k, s[k], s.versions?.[k]);
      update((prev) => ({
        ...s,
        bookmarks: keep.bookmarks ? prev.bookmarks : s.bookmarks,
        notes: keep.notes ? prev.notes : s.notes,
        money: keep.money ? prev.money : s.money,
        learn: keep.learn ? prev.learn : s.learn,
      }));
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
  const refresh = useCallback(
    () =>
      api
        .state()
        .then((s) => {
          merge(s);
          setServerIssue(null);
          lastRefresh.current = Date.now();
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
    // While the change stream is open, a poll every 5 minutes is only a backstop.
    const iv = window.setInterval(() => (!live.current || Date.now() - lastRefresh.current > 5 * 60_000) && refresh(), 60_000);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      // Tasks sync "on focus", throttled server-side to once every 30 s.
      api.sync('tasks', 30).then(merge).catch(() => refresh());
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh, merge]);

  // Live updates: the server says when something changed (another tab, a phone, a sync that
  // finished) and this tab fetches the state. Only a visible tab keeps the stream open, so a
  // pile of background tabs doesn't use up the browser's six connections over plain HTTP.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let es: EventSource | null = null;
    let soon = 0;
    let retry = 0;
    const later = () => {
      clearTimeout(soon);
      soon = window.setTimeout(refresh, 150);
    };
    const open = () => {
      if (es || document.visibilityState !== 'visible') return;
      const src = new EventSource(`/api/events?tab=${TAB_ID}`);
      let hellos = 0;
      // Reconnected after a restart or a dropped connection: catch up on what was missed.
      src.addEventListener('hello', () => {
        live.current = true;
        if (hellos++) later();
      });
      src.addEventListener('change', later);
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

  return { data, update, savers, merge, replace, refresh, serverIssue };
}
