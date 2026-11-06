import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import { ymd } from '../../shared/dates';
import { emptyLearn, fmtStudy, parseStudy, timerMinutes } from '../../shared/learn';
import { starterMoney } from '../../shared/money';
import { EMPTY_TRAINING, fmtKg, parseWeight } from '../../shared/training';
import { MOOD_WORDS, engineUrl, fmtDuration, parseSearch, smokesOn } from '../../shared/trackers';
import type { AppState, Backup, BookmarkGroup, DesignKey, Countdown, Learn, Money, Mood, Note, Package, Photo, Prefs, SavedDoc, Task, Training, ViewKey } from '../../shared/types';
import { api, cachedState, cacheState, ConflictError, localGet, localSet, ServerError, TAB_ID, type RestoreResult } from './api';
import { merge3, mergeNotes } from '../../shared/merge';
import { Bookmarks } from './components/Bookmarks';
import { AddPackageDrawer, DESIGNS, Drawer, PANEL_ROWS, PackageDrawer, SettingsDrawer } from './components/Drawers';
import { Inbox, inboxBadge } from './components/Inbox';
import { CourseDrawer, LearnView } from './components/Learn';
import { MoneyView } from './components/Money';
import { News } from './components/News';
import { HeroPanel } from './components/Hero';
import { HorizonHome } from './components/Horizon';
import { FocusView, Notes } from './components/Notes';
import { Packages } from './components/Packages';
import { Palette, type PaletteItem } from './components/Palette';
import { PhotoPanel, shrinkImage, usePhotoSlots } from './components/Photos';
import { Rail, VIEWS } from './components/Rail';
import { Server, type ServerTab } from './components/Server';
import { ServerBanner, type ServerIssue } from './components/ServerBanner';
import { Shortcuts } from './components/Shortcuts';
import { Tasks } from './components/Tasks';
import { Today, todayAgenda } from './components/Today';
import { TopBar, WeatherPanel } from './components/TopBar';
import { ExerciseDrawer, TrainingView } from './components/Training';
import { You, nearestCountdown } from './components/You';
import { gridLayout, type Area, type Layout } from './layout';
import { dayDiff, hashFor, hm, host, inMinutes, parseYmd, viewFromHash } from './util';

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
function fromCache(c: AppState | null): AppState {
  if (!c) return EMPTY;
  return { ...EMPTY, ...c, prefs: { ...DEFAULT_PREFS, ...c.prefs }, sync: { ...EMPTY.sync, ...c.sync }, inbox: c.inbox ?? EMPTY.inbox, money: Array.isArray(c.money?.entries) ? c.money : EMPTY.money, training: Array.isArray(c.training?.workouts) ? c.training : EMPTY.training, exerciseMuscles: c.exerciseMuscles ?? {}, trainingNote: c.trainingNote ?? EMPTY.trainingNote, weights: c.weights ?? {}, learn: Array.isArray(c.learn?.courses) ? c.learn : EMPTY.learn, learnNote: c.learnNote ?? EMPTY.learnNote };
}

type DrawerState = { type: 'pkg'; id: string } | { type: 'add' } | { type: 'settings' } | { type: 'exercise'; title: string } | { type: 'course'; id: string; item?: string } | null;

/**
 * Debounced saver for whole-document PUTs, flushed when the tab closes. Saves go one at a
 * time, so each starts from the version the last one made. `save` resolves to a value when
 * that should be saved next instead (a merge after another device saved first).
 */
function useSaver<T>(save: (v: T, opts: { keepalive: boolean; unchecked: boolean }) => Promise<T | void>, delay: number, onSaved?: () => void, onError?: (e: Error) => void) {
  const timer = useRef(0);
  const latest = useRef<T | null>(null);
  const inflight = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback(
    function flush(keepalive = false) {
      clearTimeout(timer.current);
      const v = latest.current;
      if (v === null) return;
      latest.current = null;
      // The tab is closing and can't wait its turn: send now, without the version check.
      if (keepalive && inflight.current) {
        save(v, { keepalive, unchecked: true }).catch(() => {});
        return;
      }
      inflight.current++;
      chain.current = chain.current
        .then(() => save(v, { keepalive, unchecked: false }))
        .then((again) => {
          if (again === undefined) return onSaved?.();
          latest.current = again;
          flush();
        })
        .catch((e) => onError?.(e))
        .finally(() => inflight.current--);
    },
    [save, onSaved, onError],
  );
  const schedule = useCallback(
    (v: T) => {
      latest.current = v;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(), delay);
    },
    [delay, flush],
  );
  useEffect(() => {
    const h = () => flush(true);
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  }, [flush]);
  const busy = useCallback(() => latest.current !== null || inflight.current > 0, []);
  return useMemo(() => ({ schedule, busy }), [schedule, busy]);
}

function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let iv = 0;
    // Tick on the minute boundary so "in 28 min" labels change with the clock.
    const t = window.setTimeout(() => {
      setNow(new Date());
      iv = window.setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000) + 50);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);
  return now;
}

function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const h = () => setDark(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return dark;
}

export function App() {
  const [data, setData] = useState<AppState>(() => fromCache(cachedState()));
  const [view, setView] = useState<ViewKey>(() => viewFromHash(location.hash));
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [addCountdown, setAddCountdown] = useState(0);
  const [weightSignal, setWeightSignal] = useState(0);
  const [addWorkSignal, setAddWorkSignal] = useState(0);
  const [serverTab, setServerTab] = useState<{ tab: ServerTab; n: number } | null>(null);
  const [learnNoteBusy, setLearnNoteBusy] = useState(false);
  const [newsBusy, setNewsBusy] = useState(false);
  const [noteBusy, setNoteBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [layout, setLayout] = useState<Layout>('desktop');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focus, setFocus] = useState(false);
  const [editBookmarks, setEditBookmarks] = useState(false);
  const [activeNote, setActiveNote] = useState(() => localGet('activeNote') || '');
  const [localDesign, setLocalDesignState] = useState<DesignKey | ''>(() => (DESIGNS.some((d) => d.key === localGet('design')) ? (localGet('design') as DesignKey) : ''));
  const setLocalDesign = (d: DesignKey | '') => {
    setLocalDesignState(d);
    localSet('design', d);
  };
  const [saved, setSaved] = useState(false);
  const [moneySaved, setMoneySaved] = useState(false);
  const [toast, setToast] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  const [serverIssue, setServerIssue] = useState<ServerIssue | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteEditing = useRef(false);
  const savedT = useRef(0);
  const moneySavedT = useRef(0);
  const toastT = useRef(0);
  const now = useMinuteNow();
  const photoSlots = usePhotoSlots(data.photos.length);
  const systemDark = useSystemDark();

  const showToast = useCallback((msg: string, action?: { label: string; run: () => void }) => {
    setToast({ msg, action });
    clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(null), action ? 6000 : 4000);
  }, []);
  const onSaveError = useCallback((e: Error) => showToast(`Couldn’t save: ${e.message}`), [showToast]);

  const flashSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(savedT.current);
    savedT.current = window.setTimeout(() => setSaved(false), 1500);
  }, []);

  const flashMoneySaved = useCallback(() => {
    setMoneySaved(true);
    clearTimeout(moneySavedT.current);
    moneySavedT.current = window.setTimeout(() => setMoneySaved(false), 1500);
  }, []);

  // ---------- data ----------

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
  /** For each document saved whole, the server's copy this page's edits started from, and its version. */
  const bases = useRef<Partial<Record<SavedDoc, { value: unknown; version?: string }>> | null>(null);
  bases.current ??= Object.fromEntries((['bookmarks', 'notes', 'money', 'learn'] as const).map((k) => [k, { value: data[k], version: data.versions?.[k] }]));

  /**
   * Save one document. If another tab or device saved it first, merge this page's edits
   * (all of them, including any made while the save was out) into their copy, show the
   * result, and hand it back to be saved on top of theirs.
   */
  const saveDoc = useCallback(
    <K extends SavedDoc>(key: K) =>
      async (v: AppState[K], { keepalive, unchecked }: { keepalive: boolean; unchecked: boolean }): Promise<AppState[K] | void> => {
        const base = bases.current![key];
        try {
          const { version } = await api.putDoc(key, v, unchecked ? undefined : base?.version, keepalive);
          bases.current![key] = { value: v, version };
        } catch (e) {
          if (!(e instanceof ConflictError)) throw e;
          const mine = dataRef.current[key];
          const theirs = e.value as AppState[K];
          const { value, conflicts, copies = 0 } = key === 'notes'
            ? (mergeNotes(base?.value as Note[], mine as Note[], theirs as Note[]) as { value: AppState[K]; conflicts: number; copies: number })
            : { ...merge3(base?.value as AppState[K], mine, theirs), copies: 0 };
          bases.current![key] = { value: theirs, version: e.version };
          update((d) => ({ ...d, [key]: value }));
          showToast(
            `Merged with changes made on another device${copies ? '; its version of a notepad you both edited is kept as a copy' : ''}${conflicts ? ` (${conflicts} edit${conflicts === 1 ? '' : 's'} you both made: yours kept)` : ''}.`,
          );
          return value;
        }
      },
    [update, showToast],
  );
  const saveBookmarks = useMemo(() => saveDoc('bookmarks'), [saveDoc]);
  const saveNotes = useMemo(() => saveDoc('notes'), [saveDoc]);
  const saveMoney = useMemo(() => saveDoc('money'), [saveDoc]);
  const saveLearn = useMemo(() => saveDoc('learn'), [saveDoc]);
  const bookmarkSaver = useSaver(saveBookmarks, 400, undefined, onSaveError);
  const moneySaver = useSaver(saveMoney, 500, flashMoneySaved, onSaveError);
  const noteSaver = useSaver(saveNotes, 500, flashSaved, onSaveError);
  const learnSaver = useSaver(saveLearn, 400, undefined, onSaveError);

  /** Take fresh server state, but keep local edits that haven't been saved yet. */
  const merge = useCallback(
    (s: AppState) => {
      const keep: Record<SavedDoc, boolean> = {
        bookmarks: bookmarkSaver.busy(),
        notes: noteSaver.busy() || noteEditing.current,
        money: moneySaver.busy(),
        learn: learnSaver.busy(),
      };
      // A document taken from the server is the new starting point for the next save; one kept keeps its old one.
      for (const k of Object.keys(keep) as SavedDoc[]) if (!keep[k]) bases.current![k] = { value: s[k], version: s.versions?.[k] };
      update((prev) => ({
        ...s,
        bookmarks: keep.bookmarks ? prev.bookmarks : s.bookmarks,
        notes: keep.notes ? prev.notes : s.notes,
        money: keep.money ? prev.money : s.money,
        learn: keep.learn ? prev.learn : s.learn,
      }));
    },
    [update, bookmarkSaver, noteSaver, moneySaver, learnSaver],
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
    const err = new URLSearchParams(location.search).get('google');
    if (err) {
      showToast(err === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${err}`);
      history.replaceState(null, '', '/' + location.hash);
    }
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh, merge, showToast]);

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

  // The view lives in the URL's hash (#money), so a reload stays put and Back and Forward
  // move between views. Home has no hash, so a new tab is still the plain "/".
  useEffect(() => {
    if (viewFromHash(location.hash) !== view) history.pushState(null, '', hashFor(view) || location.pathname + location.search);
  }, [view]);
  useEffect(() => {
    const onNav = () => setView(viewFromHash(location.hash));
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, []);

  // ---------- theme & layout ----------

  const design: DesignKey = localDesign || data.prefs.design || 'broadsheet';
  // Console is always dark; the others follow Theme.
  const dark = design === 'console' || data.prefs.theme === 'dark' || (data.prefs.theme === 'system' && systemDark);
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = data.prefs.accent;
    document.documentElement.dataset.design = design;
  }, [dark, data.prefs.accent, design]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    // A short screen (a phone on its side) gets the stacked, page-scrolling layout too:
    // the other layouts pin the panels to the window height, which squeezes them to nothing.
    const short = window.matchMedia('(max-height: 599px)');
    let w = el.clientWidth;
    const pick = () => setLayout(w < 760 || short.matches ? 'narrow' : w >= 2000 ? 'wide' : 'desktop');
    const ro = new ResizeObserver(([e]) => {
      w = e.contentRect.width;
      pick();
    });
    ro.observe(el);
    short.addEventListener('change', pick);
    return () => {
      ro.disconnect();
      short.removeEventListener('change', pick);
    };
  }, []);

  // Pick up anything the hourly news run (or the inbox's) fetched since the last poll.
  useEffect(() => {
    if (view === 'news' || view === 'inbox') refresh();
  }, [view, refresh]);

  // ---------- actions ----------

  const connect = () => {
    location.href = '/api/auth/google';
  };

  const setBookmarks = (bookmarks: BookmarkGroup[]) => {
    update((d) => ({ ...d, bookmarks }));
    bookmarkSaver.schedule(bookmarks);
  };

  const setNotes = (notes: Note[]) => {
    setSaved(false);
    update((d) => ({ ...d, notes }));
    noteSaver.schedule(notes);
  };

  const onNoteEditing = useCallback((v: boolean) => {
    noteEditing.current = v;
  }, []);

  const pickNote = (id: string) => {
    setActiveNote(id);
    localSet('activeNote', id);
  };

  const setPrefs = (prefs: Prefs) => {
    update((d) => ({ ...d, prefs }));
    api.putPrefs(prefs).then(() => refresh()).catch(onSaveError);
  };

  const refreshNews = () => {
    setNewsBusy(true);
    api
      .sync('news')
      .then(merge)
      .catch((e) => showToast(`Couldn’t refresh news: ${e.message}`))
      .finally(() => setNewsBusy(false));
  };

  const refreshInbox = () => {
    setInboxBusy(true);
    api
      .sync('inbox')
      .then(merge)
      .catch((e) => showToast(`Couldn’t refresh the inbox: ${e.message}`))
      .finally(() => setInboxBusy(false));
  };

  const setNewsTopics = (newsTopics: string[]) => {
    const prefs = { ...data.prefs, newsTopics };
    const added = newsTopics.some((t) => !data.news.some((n) => n.topic.toLowerCase() === t.toLowerCase()));
    update((d) => ({
      ...d,
      prefs,
      news: newsTopics.map((t) => d.news.find((n) => n.topic.toLowerCase() === t.toLowerCase()) ?? { topic: t, articles: [], stories: null, summarisedAt: null, fetchedAt: null, error: null }),
    }));
    api
      .putPrefs(prefs)
      .then(() => (added ? refreshNews() : refresh()))
      .catch(onSaveError);
  };

  const addTask = (listId: string, title: string, due: string | null) => {
    const tmp: Task = { id: 'tmp-' + Date.now(), listId, title, due };
    update((d) => ({ ...d, tasks: [tmp, ...d.tasks] }));
    api
      .addTask(listId, title, due)
      .then((t) => update((d) => ({ ...d, tasks: d.tasks.map((x) => (x.id === tmp.id ? t : x)) })))
      .catch((e) => {
        update((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== tmp.id) }));
        showToast(`Couldn’t add task: ${e.message}`);
      });
  };

  const completeTask = (t: Task, keepalive?: boolean) => {
    update((d) => ({ ...d, tasks: d.tasks.filter((x) => x.id !== t.id) }));
    api.completeTask(t, keepalive).catch((e) => {
      showToast(`Couldn’t complete task: ${e.message}`);
      refresh();
    });
  };

  const patchPackage = (id: string, patch: Partial<Package>) => {
    update((d) => ({ ...d, packages: d.packages.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  };

  const labelTimer = useRef(0);
  const renamePackage = (id: string, label: string) => {
    patchPackage(id, { label });
    clearTimeout(labelTimer.current);
    labelTimer.current = window.setTimeout(() => api.patchPackage(id, { label }).catch(onSaveError), 400);
  };

  const archivePackage = (id: string) => {
    update((d) => ({ ...d, packages: d.packages.filter((p) => p.id !== id) }));
    setDrawer(null);
    api.patchPackage(id, { archived: true, isNew: false }).catch(onSaveError);
  };

  const addPackage = async (number: string, label: string, carrier: string) => {
    const pkg = await api.addPackage(number, label, carrier);
    update((d) => ({ ...d, packages: [pkg, ...d.packages.filter((p) => p.id !== pkg.id)] }));
    setDrawer(null);
  };

  const addPhotos = async (files: File[]): Promise<string> => {
    let added = 0;
    for (const f of files) {
      try {
        const photo = await api.addPhoto(await shrinkImage(f));
        update((d) => ({ ...d, photos: [...d.photos, photo] }));
        added++;
      } catch (e) {
        return `${added ? `Added ${added}. ` : ''}Couldn’t add ${f.name}: ${(e as Error).message}`;
      }
    }
    return added === 1 ? 'Added 1 photo.' : `Added ${added} photos.`;
  };

  const removePhoto = (id: string) => {
    update((d) => ({ ...d, photos: d.photos.filter((p) => p.id !== id) }));
    api.deletePhoto(id).catch(onSaveError);
  };

  const setPhotoFocus = (id: string, focus: Photo['focus']) => {
    const photos = data.photos.map((p) => (p.id === id ? { ...p, focus } : p));
    update((d) => ({ ...d, photos }));
    api.putPhotos(photos).catch(onSaveError);
  };

  // ---------- trackers ----------

  const smokeSaver = useRef(Promise.resolve());
  /** Server calls for the cigarette log run in order, and the server's list replaces the optimistic one. */
  const smokeCall = (call: () => Promise<string[]>) => {
    smokeSaver.current = smokeSaver.current
      .then(call)
      .then((smokes) => update((d) => ({ ...d, smokes })))
      .catch((e) => {
        showToast(`Couldn’t save: ${e.message}`);
        refresh();
      });
  };

  const undoSmoke = (at: string) => {
    update((d) => ({ ...d, smokes: d.smokes.filter((x) => x !== at) }));
    smokeCall(() => api.removeSmoke(at));
  };

  const logSmoke = () => {
    const at = new Date().toISOString();
    const count = smokesOn([...data.smokes, at], new Date()).length;
    update((d) => ({ ...d, smokes: [...d.smokes, at] }));
    smokeCall(() => api.addSmoke());
    const limit = data.prefs.cigaretteLimit;
    showToast(`Logged · ${count} today${limit ? ` of ${limit}` : ''}`, { label: 'Undo', run: () => undoSmoke(at) });
  };

  /** Log body weight for a day (null removes it); `undo` offers to put back what was there. */
  const setWeight = (date: string, kg: number | null, undo = false) => {
    const before = data.weights[date];
    update((d) => {
      const weights = { ...d.weights };
      if (kg === null) delete weights[date];
      else weights[date] = kg;
      return { ...d, weights };
    });
    api
      .putWeight(date, kg)
      .then((weights) => {
        update((d) => ({ ...d, weights }));
        if (undo && kg !== null) showToast(`Logged ${fmtKg(kg)} kg for today`, { label: 'Undo', run: () => setWeight(date, before ?? null) });
      })
      .catch(onSaveError);
  };

  const setMood = (date: string, mood: Mood | null) => {
    update((d) => {
      const moods = { ...d.moods };
      if (mood) moods[date] = mood;
      else delete moods[date];
      return { ...d, moods };
    });
    api
      .putMood(date, mood ?? { level: 0 })
      .then((moods) => update((d) => ({ ...d, moods })))
      .catch(onSaveError);
  };

  const setCountdowns = (countdowns: Countdown[]) => {
    update((d) => ({ ...d, countdowns }));
    api.putCountdowns(countdowns).catch(onSaveError);
  };

  const setMoney = (money: Money) => {
    setMoneySaved(false);
    update((d) => ({ ...d, money }));
    moneySaver.schedule(money);
  };

  const importMoney = (money: Money, summary: string) => {
    const before = data.money;
    setMoney(money);
    showToast(summary, { label: 'Undo', run: () => setMoney(before) });
  };

  /** Claude labels new exercises and writes the note; `force` writes a new note even when nothing changed. */
  const refreshTrainingNote = (force: boolean) => {
    if (!data.newsSummaries) return;
    setNoteBusy(true);
    api
      .refreshTraining(force)
      .then(merge)
      .catch((e) => showToast(`Couldn’t write the training note: ${e.message}`))
      .finally(() => setNoteBusy(false));
  };

  const setTraining = (training: Training) => {
    update((d) => ({ ...d, training }));
    api
      .putTraining(training)
      .then(() => refreshTrainingNote(false))
      .catch(onSaveError);
  };

  const togglePin = (title: string) => {
    const pins = data.prefs.pinnedLifts;
    setPrefs({ ...data.prefs, pinnedLifts: pins.includes(title) ? pins.filter((t) => t !== title) : [...pins, title] });
  };

  const importTraining = (training: Training, summary: string) => {
    const before = data.training;
    setTraining(training);
    showToast(summary, { label: 'Undo', run: () => setTraining(before) });
  };

  // ---------- learn ----------

  const setLearn = (learn: Learn) => {
    update((d) => ({ ...d, learn }));
    learnSaver.schedule(learn);
  };

  const courseName = (id: string) => data.learn.courses.find((c) => c.id === id)?.name ?? 'general study';

  /** Stop the timer and log what it ran as a session; returns the new state, or the same one when it wasn't running. */
  const stoppedTimer = (learn: Learn): { learn: Learn; minutes: number } => {
    if (!learn.timer) return { learn, minutes: 0 };
    const minutes = Math.round(timerMinutes(learn.timer, new Date()));
    const sessions = minutes >= 1 ? [...learn.sessions, { id: 'ss' + Date.now().toString(36), courseId: learn.timer.courseId, start: learn.timer.start, minutes }] : learn.sessions;
    return { learn: { ...learn, sessions, timer: null }, minutes };
  };

  const startStudy = (courseId: string) => {
    const { learn } = stoppedTimer(data.learn);
    setLearn({ ...learn, timer: { courseId, start: new Date().toISOString() } });
  };

  const stopStudy = () => {
    const before = data.learn;
    const { learn, minutes } = stoppedTimer(before);
    setLearn(learn);
    showToast(minutes >= 1 ? `Logged ${fmtStudy(minutes)} of ${courseName(before.timer!.courseId)}` : 'Under a minute, so nothing was logged', { label: 'Undo', run: () => setLearn(before) });
  };

  const logStudy = (minutes: number, courseId: string) => {
    const before = data.learn;
    const start = new Date(Date.now() - minutes * 60000).toISOString();
    setLearn({ ...before, sessions: [...before.sessions, { id: 'ss' + Date.now().toString(36), courseId, start, minutes }] });
    showToast(`Logged ${fmtStudy(minutes)} of ${courseName(courseId)}`, { label: 'Undo', run: () => setLearn(before) });
  };

  /** Claude's note on the week ahead; without `force` it's only written when today's isn't there yet. */
  const refreshLearnNote = useCallback(
    (force: boolean) => {
      setLearnNoteBusy(true);
      api
        .refreshLearn(force)
        .then(merge)
        .catch((e) => showToast(`Couldn’t write the note: ${e.message}`))
        .finally(() => setLearnNoteBusy(false));
    },
    [merge, showToast],
  );

  const learnNoteDay = data.learnNote.note ? ymd(new Date(data.learnNote.note.writtenAt)) : '';
  const hasCourses = data.learn.courses.some((c) => !c.archived);
  useEffect(() => {
    if (view === 'learn' && data.newsSummaries && hasCourses && learnNoteDay !== ymd(new Date())) refreshLearnNote(false);
    // Once per visit to the view; the server skips it when today's note is already written.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, data.newsSummaries, hasCourses]);

  const toggleHidden = (key: string) => {
    const hidden = data.prefs.hidden.includes(key) ? data.prefs.hidden.filter((h) => h !== key) : [...data.prefs.hidden, key];
    setPrefs({ ...data.prefs, hidden });
  };

  const openServerTab = (tab: ServerTab) => {
    // Read when the view mounts; the signal switches it when it's already open.
    localSet('serverTab', tab);
    setView('server');
    setServerTab((t) => ({ tab, n: (t?.n ?? 0) + 1 }));
  };

  const runSpeedTest = () => {
    setView('server');
    api.speedTest().catch((e) => showToast(`Couldn’t start a speed test: ${e.message}`));
  };

  /**
   * Restore something on the server (a backup file, or one of the automatic copies), show it,
   * and offer Undo, which puts back the copy the server took just before. Returns what came back.
   */
  const restoreWith = async (run: () => Promise<RestoreResult>): Promise<string[]> => {
    const { restored, undo, state } = await run();
    // The restored copy wins over anything on screen, unsaved edits included, and is where the next saves start.
    for (const k of ['bookmarks', 'notes', 'money', 'learn'] as const) bases.current![k] = { value: state[k], version: state.versions?.[k] };
    update(() => fromCache(state));
    if (!state.notes.some((n) => n.id === activeNote)) pickNote(state.notes[0].id);
    const summary = `Restored ${restored.join(', ')}.`;
    showToast(summary, undo ? { label: 'Undo', run: () => restoreWith(() => api.restoreSnapshot(undo)).catch((e) => showToast(`Couldn’t undo: ${e.message}`)) } : undefined);
    return restored;
  };
  const restoreBackup = (b: Partial<Backup> | Blob) => restoreWith(() => api.restoreBackup(b));
  const restoreSnapshot = (id: string) => restoreWith(() => api.restoreSnapshot(id));

  // ---------- keyboard ----------

  const gAt = useRef(0);
  const designRef = useRef(design);
  designRef.current = design;
  const keyActions = useRef({ logSmoke });
  keyActions.current = { logSmoke };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed into the server terminal belong to the shell: Esc for vim, Ctrl K to cut a line.
      if ((e.target as HTMLElement).closest?.('.xterm')) return;
      // ⌘K / Ctrl K works everywhere, even while typing.
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        if (palette) setPalette(false);
        else if (drawer) setDrawer(null);
        else if (focus) setFocus(false);
        else if (view !== 'home') setView('home');
        return;
      }
      // Console: F1–F8 open the views in rail order, F9 Settings.
      if (designRef.current === 'console' && /^F[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        const n = Number(e.key.slice(1));
        if (n === 9) setDrawer({ type: 'settings' });
        else if (VIEWS[n - 1]) {
          setPalette(false);
          setDrawer(null);
          setView(VIEWS[n - 1].key);
        }
        return;
      }
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey || palette || shortcuts) return;
      const key = e.key.toLowerCase();
      // G then a letter jumps to a view.
      if (Date.now() - gAt.current < 1500) {
        gAt.current = 0;
        const v = VIEWS.find((x) => x.letter.toLowerCase() === key);
        if (v && !drawer && !focus) {
          setView(v.key);
          return;
        }
      }
      if (key === 'g' && !e.shiftKey) {
        gAt.current = Date.now();
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        setShortcuts(true);
        return;
      }
      if (drawer || focus) return;
      if (key === 'n') {
        setView((v) => (v === 'news' ? 'home' : 'news'));
        return;
      }
      if (key === 'c' && !e.shiftKey) {
        keyActions.current.logSmoke();
        return;
      }
      if (key === 'm' && !e.shiftKey) {
        setView('you');
        return;
      }
      if (/^[1-9]$/.test(e.key) && !search && !editBookmarks && view === 'home') {
        const daily = data.bookmarks.find((g) => g.name === 'Daily');
        const b = daily?.items[Number(e.key) - 1];
        if (b) window.open(b.url, '_blank', 'noopener');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, focus, search, editBookmarks, data.bookmarks, view, palette, shortcuts]);

  // ---------- derived ----------

  let subline = data.google.signedOut ? 'Google signed out · reconnect in Settings' : 'Connect Google to see what’s next';
  if (data.google.connected) {
    const { cur, next } = todayAgenda(data, now);
    if (!data.prefs.sources.calendar) subline = '';
    else if (cur) subline = `${cur.title} now · ends ${hm(cur.e)}`;
    else if (next) {
      subline = `Next: ${next.title} ${inMinutes(Math.max(1, Math.round((next.s.getTime() - now.getTime()) / 60000)))}`;
      if (next.conferenceType) subline += ` · ${next.conferenceType}`;
    } else subline = 'Nothing else on today';
  }
  // The tail of the summary line, which Bento's clock tile shows under the next event.
  const extras: string[] = [];
  const overdue = data.google.connected && data.prefs.sources.tasks ? data.tasks.filter((t) => t.due && dayDiff(now, parseYmd(t.due)) < 0).length : 0;
  if (overdue) extras.push(`${overdue} overdue task${overdue > 1 ? 's' : ''}`);
  const outPk = data.packages.filter((p) => p.stage === 2 && !p.exception).length;
  if (outPk) extras.push(`${outPk} package${outPk > 1 ? 's' : ''} out for delivery`);
  const soon = data.prefs.hidden.includes('top:countdown') ? '' : nearestCountdown(data.countdowns, now);
  if (soon) extras.push(soon);
  subline = [subline, ...extras].filter(Boolean).join(' · ');

  const notes = data.notes.length ? data.notes : STARTER_NOTES;
  const activeId = notes.some((n) => n.id === activeNote) ? activeNote : notes[0].id;
  const drawerPkg = drawer?.type === 'pkg' ? data.packages.find((p) => p.id === drawer.id) : undefined;
  const hidden = new Set(data.prefs.hidden);
  const photoCount = hidden.has('panel:photos') ? 0 : Math.min(data.photos.length, 2);
  const shown = new Set<Area>(
    (
      [
        ['today', 'panel:today'],
        ['tasks', 'panel:tasks'],
        ['notes', 'panel:notes'],
        ['pkgs', 'panel:packages'],
        ['bm', 'panel:bookmarks'],
      ] as const
    )
      .filter(([, k]) => !hidden.has(k))
      .map(([a]) => a),
  );
  if (photoCount > 0) shown.add('photo');
  if (photoCount > 1) shown.add('photo2');
  // Bento opens with a clock tile; Console and Bento print the weather details as a panel.
  if (design === 'bento') shown.add('hero');
  const weatherOn = !!data.prefs.weatherArea && !hidden.has('top:weather');
  if ((design === 'console' || design === 'bento') && weatherOn) shown.add('wx');
  const grid = gridLayout(layout, shown, design);
  const smokesToday = smokesOn(data.smokes, now).length;
  const todayMood = data.moods[ymd(now)];
  const inboxCount = inboxBadge(data);

  const keepPackage = (id: string) => {
    patchPackage(id, { isNew: false });
    api.patchPackage(id, { isNew: false }).catch(onSaveError);
  };
  const notesPanel = (
    <Notes notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onOpenFocus={() => setFocus(true)} onEditing={onNoteEditing} />
  );
  const bookmarksPanel = <Bookmarks groups={data.bookmarks} onChange={setBookmarks} search={search} edit={editBookmarks} setEdit={setEditBookmarks} />;

  // ---------- command palette ----------

  const paletteItems: PaletteItem[] = [
    {
      id: 'a:smoke', group: 'Actions', label: 'Log a cigarette', icon: 'ph-cigarette', keys: ['C'], words: 'smoke',
      sub: `${smokesToday} today${data.smokes.length ? ` · last one ${fmtDuration(now.getTime() - Date.parse(data.smokes[data.smokes.length - 1]))} ago` : ''}`,
      run: logSmoke,
    },
    {
      id: 'a:weight', group: 'Actions', label: 'Log your weight', icon: 'ph-scales', words: 'body weight kg scale',
      sub: data.weights[ymd(now)] ? `Today: ${fmtKg(data.weights[ymd(now)])} kg` : 'Or type “weight 72.4”',
      run: () => (setView('training'), setWeightSignal((n) => n + 1)),
    },
    { id: 'a:mood', group: 'Actions', label: 'Log today’s mood', icon: 'ph-smiley', keys: ['M'], sub: todayMood ? `Today: ${MOOD_WORDS[todayMood.level - 1]}` : 'Not logged yet today', run: () => setView('you') },
    {
      id: 'a:countdown', group: 'Actions', label: 'Add a countdown', icon: 'ph-hourglass-medium',
      run: () => {
        setView('you');
        setAddCountdown((n) => n + 1);
      },
    },
    ...(data.learn.timer
      ? [{
          id: 'a:study-stop', group: 'Actions', label: 'Stop studying', icon: 'ph-stop', words: 'timer learn log',
          sub: `${courseName(data.learn.timer.courseId)} · ${fmtStudy(timerMinutes(data.learn.timer, now))} so far`,
          run: stopStudy,
        }]
      : []),
    ...data.learn.courses.filter((c) => !c.archived && c.id !== data.learn.timer?.courseId).map((c, i) => ({
      id: 'a:study-' + c.id, group: 'Actions', label: `Start studying ${c.name}`, icon: 'ph-timer', words: `timer learn ${c.code}`,
      sub: i === 0 ? 'Or type “study 45 ' + (c.code || c.name).toLowerCase().replace(/\s+/g, '') + '” to log time' : c.code || undefined,
      onlyWhenTyping: i > 0,
      run: () => (startStudy(c.id), setView('learn')),
    })),
    ...(hasCourses
      ? [{ id: 'a:work', group: 'Actions', label: 'Add a deliverable', icon: 'ph-exam', words: 'assignment homework quiz exam due learn', run: () => (setView('learn'), setAddWorkSignal((n) => n + 1)) }]
      : []),
    { id: 'a:speed', group: 'Actions', label: 'Run a speed test', icon: 'ph-gauge', words: 'internet', run: runSpeedTest },
    { id: 'a:terminal', group: 'Actions', label: 'Open the server terminal', icon: 'ph-terminal-window', words: 'shell ssh console command line', run: () => openServerTab('terminal') },
    { id: 'a:files', group: 'Actions', label: 'Browse the server’s files', icon: 'ph-folder-simple', words: 'file explorer sftp upload download folders', run: () => openServerTab('files') },
    { id: 'a:package', group: 'Actions', label: 'Add a package', icon: 'ph-package', words: 'tracking', run: () => setDrawer({ type: 'add' }) },
    { id: 'a:news', group: 'Actions', label: 'Refresh the news', icon: 'ph-arrows-clockwise', run: () => (setView('news'), refreshNews()) },
    {
      id: 'a:inbox', group: 'Actions', label: 'Catch up on email', icon: 'ph-envelope-open', words: 'inbox gmail mail summary digest',
      sub: inboxCount ? `${inboxCount} need${inboxCount === 1 ? 's' : ''} you` : undefined,
      run: () => (setView('inbox'), refreshInbox()),
    },
    { id: 'a:theme', group: 'Actions', label: dark ? 'Switch to the light theme' : 'Switch to the dark theme', icon: dark ? 'ph-sun' : 'ph-moon', run: () => setPrefs({ ...data.prefs, theme: dark ? 'light' : 'dark' }) },
    ...DESIGNS.filter((d) => d.key !== design).map((d) => ({
      id: 'l:' + d.key, group: 'Actions', label: `Layout: ${d.name}`, icon: 'ph-layout', words: 'design look theme switch view',
      sub: localDesign ? 'This browser only' : 'Every device',
      run: () => (localDesign ? setLocalDesign(d.key) : setPrefs({ ...data.prefs, design: d.key })),
    })),
    { id: 'a:shortcuts', group: 'Actions', label: 'Keyboard shortcuts', icon: 'ph-keyboard', keys: ['?'], words: 'keys hotkeys help cheat sheet', run: () => setShortcuts(true) },
    { id: 'a:settings', group: 'Actions', label: 'Open Settings', icon: 'ph-gear-six', words: 'preferences', run: () => setDrawer({ type: 'settings' }) },
    ...VIEWS.filter((v) => v.key !== view).map((v) => ({
      id: 'v:' + v.key, group: 'Go to', label: v.name, icon: v.icon, keys: ['G', v.letter], words: 'view', run: () => setView(v.key),
    })),
    ...PANEL_ROWS.flatMap((sec) =>
      sec.rows.map((r) => ({
        id: 'p:' + r.key,
        group: 'Panels',
        label: `${hidden.has(r.key) ? 'Show' : 'Hide'} ${sec.section === 'Views' ? `the ${r.name} view` : r.name}`,
        sub: sec.section,
        icon: hidden.has(r.key) ? 'ph-eye' : 'ph-eye-slash',
        words: 'panel toggle',
        onlyWhenTyping: true,
        run: () => toggleHidden(r.key),
      })),
    ),
    ...data.bookmarks.flatMap((g) =>
      g.items.map((b, i) => ({
        id: 'b:' + b.id,
        group: 'Bookmarks',
        label: b.name,
        sub: `${g.name} · ${host(b.url)}`,
        icon: (b.name || '?')[0].toUpperCase(),
        keys: g.name === 'Daily' && i < 9 ? [String(i + 1)] : undefined,
        words: b.url,
        onlyWhenTyping: true,
        run: () => window.open(b.url, '_blank', 'noopener'),
      })),
    ),
  ];

  const paletteSearches = (q: string): PaletteItem[] => {
    const kg = parseWeight(q);
    const log: PaletteItem[] = kg === null ? [] : [{
      id: 'a:weight-now', group: 'Actions', label: `Log ${fmtKg(kg)} kg for today`, icon: 'ph-scales', first: true,
      sub: data.weights[ymd(now)] ? `Replaces ${fmtKg(data.weights[ymd(now)])} kg` : 'Body weight, in Training',
      run: () => setWeight(ymd(now), kg, true),
    }];
    const study = parseStudy(q, data.learn.courses);
    if (study) {
      log.push({
        id: 'a:study-now', group: 'Actions', label: `Log ${fmtStudy(study.minutes)} of ${courseName(study.courseId)}`, icon: 'ph-timer', first: true,
        sub: 'Study time, in Learn',
        run: () => logStudy(study.minutes, study.courseId),
      });
    }
    const engines = data.prefs.searchEngines;
    const { engine, term } = parseSearch(q, engines);
    return [...log, ...(engine ? [engine] : engines).map((e) => ({
      id: 's:' + e.prefix,
      group: 'Search the web',
      label: `Search ${e.name} for “${term}”`,
      icon: e.name[0].toUpperCase(),
      keys: [e.prefix],
      run: () => window.open(engineUrl(e, term), '_blank', 'noopener'),
    }))];
  };
  const drawerTitle =
    drawer?.type === 'settings' ? 'Settings' : drawer?.type === 'add' ? 'Add package' : drawer?.type === 'exercise' ? drawer.title : drawer?.type === 'course' ? data.learn.courses.find((c) => c.id === drawer.id)?.name || 'Course' : drawerPkg ? 'Package' : '';

  return (
    <div ref={rootRef} className="lp-root" data-layout={layout} data-design={design} data-view={view}>
      <div className="lp-shell">
      <Rail view={view} hidden={data.prefs.hidden} badges={{ inbox: inboxCount }} onView={setView} onPalette={() => setPalette(true)} onSettings={() => setDrawer({ type: 'settings' })} />
      <div className="lp-inner">
        <TopBar data={data} now={now} subline={subline} search={search} onSearch={setSearch} searchRef={searchRef} smokesToday={smokesToday} onLogSmoke={logSmoke} onOpenTraining={() => setView('training')} onOpenLearn={() => setView('learn')} />
        {serverIssue && <ServerBanner issue={serverIssue} onRetry={refresh} />}
        {view === 'news' ? (
          <News data={data} now={now} busy={newsBusy} onRefresh={refreshNews} onTopics={setNewsTopics} />
        ) : view === 'inbox' ? (
          <Inbox data={data} now={now} busy={inboxBusy} onRefresh={refreshInbox} onConnect={connect} onOpenSettings={() => setDrawer({ type: 'settings' })} />
        ) : view === 'you' ? (
          <You data={data} now={now} addSignal={addCountdown} onCountdowns={setCountdowns} onLogSmoke={logSmoke} onUndoSmoke={undoSmoke} onMood={setMood} />
        ) : view === 'training' ? (
          <TrainingView
            data={data}
            now={now}
            noteBusy={noteBusy}
            onImport={importTraining}
            onRefreshNote={() => refreshTrainingNote(true)}
            onOpenExercise={(title) => setDrawer({ type: 'exercise', title })}
            onOpenSettings={() => setDrawer({ type: 'settings' })}
            onWeight={setWeight}
            weightSignal={weightSignal}
          />
        ) : view === 'learn' ? (
          <LearnView
            data={data}
            now={now}
            noteBusy={learnNoteBusy}
            addSignal={addWorkSignal}
            onChange={setLearn}
            onStart={startStudy}
            onStop={stopStudy}
            onOpenCourse={(id, item) => setDrawer({ type: 'course', id, item })}
            onRefreshNote={() => refreshLearnNote(true)}
            notify={showToast}
          />
        ) : view === 'money' ? (
          <MoneyView money={data.money} now={now} saved={moneySaved} onChange={setMoney} onImport={importMoney} notify={showToast} together={design !== 'broadsheet' && layout !== 'narrow'} />
        ) : view === 'server' ? (
          <Server data={data} now={now} openTab={serverTab} onOpenSettings={() => setDrawer({ type: 'settings' })} split={design !== 'broadsheet' && layout !== 'narrow'} />
        ) : (
          design === 'horizon' ? (
            <HorizonHome
              data={data}
              now={now}
              smokesToday={smokesToday}
              countdown={soon}
              show={{ today: shown.has('today'), tasks: shown.has('tasks'), packages: shown.has('pkgs') }}
              onConnect={connect}
              onAddTask={addTask}
              onCompleteTask={completeTask}
              onOpenPackage={(id) => setDrawer({ type: 'pkg', id })}
              onAddPackage={() => setDrawer({ type: 'add' })}
              onKeepPackage={keepPackage}
              onDismissPackage={archivePackage}
              onLogSmoke={logSmoke}
              onOpenLearn={() => setView('learn')}
              notify={showToast}
              notes={shown.has('notes') && notesPanel}
              photos={
                photoCount > 0 && (
                  <div className="hz-photos">
                    {photoCount > 0 && <PhotoPanel photos={data.photos} area="photo" index={photoSlots.shown[0]} onStep={(d) => photoSlots.step(0, d)} />}
                    {photoCount > 1 && <PhotoPanel photos={data.photos} area="photo2" index={photoSlots.shown[1]} onStep={(d) => photoSlots.step(1, d)} />}
                  </div>
                )
              }
              bookmarks={shown.has('bm') && bookmarksPanel}
            />
          ) : (
          <main className="lp-grid" style={{ gridTemplateAreas: grid.areas, gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}>
            {shown.has('today') && (
            <Today
              data={data}
              now={now}
              wide={layout === 'wide'}
              compact={photoCount === 2 && layout !== 'narrow'}
              onConnect={connect}
              onRetry={() => api.sync('calendar').then(merge).catch(() => refresh())}
            />
            )}
            {shown.has('tasks') && <Tasks data={data} now={now} onConnect={connect} onAdd={addTask} onComplete={completeTask} />}
            {photoCount > 0 && <PhotoPanel photos={data.photos} area="photo" index={photoSlots.shown[0]} onStep={(d) => photoSlots.step(0, d)} />}
            {photoCount > 1 && <PhotoPanel photos={data.photos} area="photo2" index={photoSlots.shown[1]} onStep={(d) => photoSlots.step(1, d)} />}
            {shown.has('hero') && <HeroPanel data={data} now={now} extras={extras.join(' · ')} />}
            {shown.has('wx') && <WeatherPanel data={data} now={now} />}
            {shown.has('notes') && notesPanel}
            {shown.has('pkgs') && (
            <Packages
              packages={data.packages}
              now={now}
              onOpen={(id) => setDrawer({ type: 'pkg', id })}
              onAdd={() => setDrawer({ type: 'add' })}
              onKeep={keepPackage}
              onDismiss={archivePackage}
            />
            )}
            {shown.has('bm') && bookmarksPanel}
            {!shown.size && (
              <div className="panel" style={{ gridColumn: '1 / -1' }}>
                <div className="empty">
                  <p>Every home panel is switched off.</p>
                  <button className="btn btn-secondary" onClick={() => setDrawer({ type: 'settings' })}>
                    Open Settings
                  </button>
                </div>
              </div>
            )}
          </main>
          )
        )}
      </div>
      </div>

      {drawer && drawerTitle && (
        <Drawer title={drawerTitle} onClose={() => setDrawer(null)}>
          {drawer.type === 'settings' && (
            <SettingsDrawer
              data={data}
              now={now}
              dark={dark}
              onPrefs={setPrefs}
              onConnect={connect}
              onDisconnect={() => api.disconnectGoogle().then(merge).catch(onSaveError)}
              onRestore={restoreBackup}
              onRestoreSnapshot={restoreSnapshot}
              onAddPhotos={addPhotos}
              onRemovePhoto={removePhoto}
              onPhotoFocus={setPhotoFocus}
              localDesign={localDesign}
              onLocalDesign={setLocalDesign}
            />
          )}
          {drawer.type === 'add' && <AddPackageDrawer onSubmit={addPackage} onCancel={() => setDrawer(null)} />}
          {drawer.type === 'exercise' && (
            <ExerciseDrawer key={drawer.title} title={drawer.title} data={data} pinned={data.prefs.pinnedLifts.includes(drawer.title)} onPin={() => togglePin(drawer.title)} />
          )}
          {drawer.type === 'course' && (
            <CourseDrawer key={drawer.id} learn={data.learn} courseId={drawer.id} focusItem={drawer.item} now={now} onChange={setLearn} onClose={() => setDrawer(null)} notify={showToast} />
          )}
          {drawerPkg && <PackageDrawer key={drawerPkg.id} pkg={drawerPkg} now={now} onRename={(l) => renamePackage(drawerPkg.id, l)} onArchive={() => archivePackage(drawerPkg.id)} />}
        </Drawer>
      )}

      {focus && <FocusView notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onClose={() => setFocus(false)} />}

      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}

      {palette && <Palette items={paletteItems} searches={paletteSearches} onClose={() => setPalette(false)} />}

      {toast && (
        <div className="popover toast" role="status">
          {toast.msg}
          {toast.action && (
            <button
              className="btn-link"
              style={{ marginLeft: 12, color: 'var(--tx)', fontWeight: 600 }}
              onClick={() => {
                toast.action!.run();
                setToast(null);
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
