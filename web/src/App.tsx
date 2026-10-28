import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import { ymd } from '../../shared/dates';
import { starterMoney } from '../../shared/money';
import { MOOD_WORDS, engineUrl, fmtDuration, parseSearch, smokesOn } from '../../shared/trackers';
import type { AppState, BookmarkGroup, Countdown, Money, Mood, Note, Package, Photo, Prefs, Task, ViewKey } from '../../shared/types';
import { api, cachedState, cacheState, localGet, localSet } from './api';
import { Bookmarks } from './components/Bookmarks';
import { AddPackageDrawer, Drawer, PANEL_ROWS, PackageDrawer, SettingsDrawer } from './components/Drawers';
import { Inbox, inboxBadge } from './components/Inbox';
import { MoneyView } from './components/Money';
import { News } from './components/News';
import { FocusView, Notes } from './components/Notes';
import { Packages } from './components/Packages';
import { Palette, type PaletteItem } from './components/Palette';
import { PhotoPanel, shrinkImage, usePhotoSlots } from './components/Photos';
import { Rail, VIEWS } from './components/Rail';
import { Server } from './components/Server';
import { Tasks } from './components/Tasks';
import { Today, todayAgenda } from './components/Today';
import { TopBar } from './components/TopBar';
import { You, nearestCountdown } from './components/You';
import { gridLayout, type Area, type Layout } from './layout';
import { dayDiff, hm, host, inMinutes, parseYmd } from './util';

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
};

/** A cached copy from an older version can be missing newer fields. */
function fromCache(c: AppState | null): AppState {
  if (!c) return EMPTY;
  return { ...EMPTY, ...c, prefs: { ...DEFAULT_PREFS, ...c.prefs }, sync: { ...EMPTY.sync, ...c.sync }, inbox: c.inbox ?? EMPTY.inbox, money: Array.isArray(c.money?.entries) ? c.money : EMPTY.money };
}

type DrawerState = { type: 'pkg'; id: string } | { type: 'add' } | { type: 'settings' } | null;

/** Debounced saver for whole-document PUTs, flushed when the tab closes. */
function useSaver<T>(save: (v: T, keepalive?: boolean) => Promise<unknown>, delay: number, onSaved?: () => void, onError?: (e: Error) => void) {
  const timer = useRef(0);
  const latest = useRef<T | null>(null);
  const inflight = useRef(0);
  const flush = useCallback(
    (keepalive = false) => {
      clearTimeout(timer.current);
      const v = latest.current;
      if (v === null) return;
      latest.current = null;
      inflight.current++;
      save(v, keepalive)
        .then(() => onSaved?.())
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
  const [view, setView] = useState<ViewKey>('home');
  const [palette, setPalette] = useState(false);
  const [addCountdown, setAddCountdown] = useState(0);
  const [newsBusy, setNewsBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [layout, setLayout] = useState<Layout>('desktop');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focus, setFocus] = useState(false);
  const [editBookmarks, setEditBookmarks] = useState(false);
  const [activeNote, setActiveNote] = useState(() => localGet('activeNote') || '');
  const [saved, setSaved] = useState(false);
  const [moneySaved, setMoneySaved] = useState(false);
  const [toast, setToast] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
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

  const bookmarkSaver = useSaver(api.putBookmarks, 400, undefined, onSaveError);
  const moneySaver = useSaver(api.putMoney, 500, flashMoneySaved, onSaveError);
  const noteSaver = useSaver(api.putNotes, 500, flashSaved, onSaveError);

  // ---------- data ----------

  const update = useCallback((fn: (d: AppState) => AppState) => {
    setData((d) => {
      const next = fn(d);
      cacheState(next);
      return next;
    });
  }, []);

  /** Take fresh server state, but keep local edits that haven't been saved yet. */
  const merge = useCallback(
    (s: AppState) => {
      update((prev) => ({
        ...s,
        bookmarks: bookmarkSaver.busy() ? prev.bookmarks : s.bookmarks,
        notes: noteSaver.busy() || noteEditing.current ? prev.notes : s.notes,
        money: moneySaver.busy() ? prev.money : s.money,
      }));
    },
    [update, bookmarkSaver, noteSaver, moneySaver],
  );

  const refresh = useCallback(() => api.state().then(merge).catch((e) => console.warn('refresh failed', e)), [merge]);

  useEffect(() => {
    refresh();
    const iv = window.setInterval(refresh, 60_000);
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
      history.replaceState(null, '', '/');
    }
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [refresh, merge, showToast]);

  // ---------- theme & layout ----------

  const dark = data.prefs.theme === 'dark' || (data.prefs.theme === 'system' && systemDark);
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = data.prefs.accent;
  }, [dark, data.prefs.accent]);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const w = e.contentRect.width;
      setLayout(w < 760 ? 'narrow' : w >= 2000 ? 'wide' : 'desktop');
    });
    ro.observe(el);
    return () => ro.disconnect();
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

  const toggleHidden = (key: string) => {
    const hidden = data.prefs.hidden.includes(key) ? data.prefs.hidden.filter((h) => h !== key) : [...data.prefs.hidden, key];
    setPrefs({ ...data.prefs, hidden });
  };

  const runSpeedTest = () => {
    setView('server');
    api.speedTest().catch((e) => showToast(`Couldn’t start a speed test: ${e.message}`));
  };

  const importBackup = (bookmarks?: BookmarkGroup[], notes?: Note[]) => {
    if (bookmarks) setBookmarks(bookmarks);
    if (notes) {
      setNotes(notes);
      pickNote(notes[0].id);
    }
  };

  // ---------- keyboard ----------

  const gAt = useRef(0);
  const keyActions = useRef({ logSmoke });
  keyActions.current = { logSmoke };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey || palette) return;
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
  }, [drawer, focus, search, editBookmarks, data.bookmarks, view, palette]);

  // ---------- derived ----------

  let subline = 'Connect Google to see what’s next';
  if (data.google.connected) {
    const { cur, next } = todayAgenda(data, now);
    if (!data.prefs.sources.calendar) subline = '';
    else if (cur) subline = `${cur.title} now · ends ${hm(cur.e)}`;
    else if (next) {
      subline = `Next: ${next.title} ${inMinutes(Math.max(1, Math.round((next.s.getTime() - now.getTime()) / 60000)))}`;
      if (next.conferenceType) subline += ` · ${next.conferenceType}`;
    } else subline = 'Nothing else on today';
    const overdue = data.prefs.sources.tasks ? data.tasks.filter((t) => t.due && dayDiff(now, parseYmd(t.due)) < 0).length : 0;
    if (overdue) subline += ` · ${overdue} overdue task${overdue > 1 ? 's' : ''}`;
  }
  const outPk = data.packages.filter((p) => p.stage === 2 && !p.exception).length;
  if (outPk) subline += ` · ${outPk} package${outPk > 1 ? 's' : ''} out for delivery`;
  const soon = data.prefs.hidden.includes('top:countdown') ? '' : nearestCountdown(data.countdowns, now);
  if (soon) subline += ` · ${soon}`;
  subline = subline.replace(/^ · /, '');

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
  const grid = gridLayout(layout, shown);
  const smokesToday = smokesOn(data.smokes, now).length;
  const todayMood = data.moods[ymd(now)];
  const inboxCount = inboxBadge(data);

  // ---------- command palette ----------

  const paletteItems: PaletteItem[] = [
    {
      id: 'a:smoke', group: 'Actions', label: 'Log a cigarette', icon: 'ph-cigarette', keys: ['C'], words: 'smoke',
      sub: `${smokesToday} today${data.smokes.length ? ` · last one ${fmtDuration(now.getTime() - Date.parse(data.smokes[data.smokes.length - 1]))} ago` : ''}`,
      run: logSmoke,
    },
    { id: 'a:mood', group: 'Actions', label: 'Log today’s mood', icon: 'ph-smiley', keys: ['M'], sub: todayMood ? `Today: ${MOOD_WORDS[todayMood.level - 1]}` : 'Not logged yet today', run: () => setView('you') },
    {
      id: 'a:countdown', group: 'Actions', label: 'Add a countdown', icon: 'ph-hourglass-medium',
      run: () => {
        setView('you');
        setAddCountdown((n) => n + 1);
      },
    },
    { id: 'a:speed', group: 'Actions', label: 'Run a speed test', icon: 'ph-gauge', words: 'internet', run: runSpeedTest },
    { id: 'a:package', group: 'Actions', label: 'Add a package', icon: 'ph-package', words: 'tracking', run: () => setDrawer({ type: 'add' }) },
    { id: 'a:news', group: 'Actions', label: 'Refresh the news', icon: 'ph-arrows-clockwise', run: () => (setView('news'), refreshNews()) },
    {
      id: 'a:inbox', group: 'Actions', label: 'Catch up on email', icon: 'ph-envelope-open', words: 'inbox gmail mail summary digest',
      sub: inboxCount ? `${inboxCount} need${inboxCount === 1 ? 's' : ''} you` : undefined,
      run: () => (setView('inbox'), refreshInbox()),
    },
    { id: 'a:theme', group: 'Actions', label: dark ? 'Switch to the light theme' : 'Switch to the dark theme', icon: dark ? 'ph-sun' : 'ph-moon', run: () => setPrefs({ ...data.prefs, theme: dark ? 'light' : 'dark' }) },
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
    const engines = data.prefs.searchEngines;
    const { engine, term } = parseSearch(q, engines);
    return (engine ? [engine] : engines).map((e) => ({
      id: 's:' + e.prefix,
      group: 'Search the web',
      label: `Search ${e.name} for “${term}”`,
      icon: e.name[0].toUpperCase(),
      keys: [e.prefix],
      run: () => window.open(engineUrl(e, term), '_blank', 'noopener'),
    }));
  };
  const drawerTitle = drawer?.type === 'settings' ? 'Settings' : drawer?.type === 'add' ? 'Add package' : drawerPkg ? 'Package' : '';

  return (
    <div ref={rootRef} className="lp-root" data-layout={layout}>
      <div className="lp-shell">
      <Rail view={view} hidden={data.prefs.hidden} badges={{ inbox: inboxCount }} onView={setView} onPalette={() => setPalette(true)} onSettings={() => setDrawer({ type: 'settings' })} />
      <div className="lp-inner">
        <TopBar data={data} now={now} subline={subline} search={search} onSearch={setSearch} searchRef={searchRef} smokesToday={smokesToday} onLogSmoke={logSmoke} />
        {view === 'news' ? (
          <News data={data} now={now} busy={newsBusy} onRefresh={refreshNews} onTopics={setNewsTopics} />
        ) : view === 'inbox' ? (
          <Inbox data={data} now={now} busy={inboxBusy} onRefresh={refreshInbox} onConnect={connect} onOpenSettings={() => setDrawer({ type: 'settings' })} />
        ) : view === 'you' ? (
          <You data={data} now={now} addSignal={addCountdown} onCountdowns={setCountdowns} onLogSmoke={logSmoke} onUndoSmoke={undoSmoke} onMood={setMood} />
        ) : view === 'money' ? (
          <MoneyView money={data.money} now={now} saved={moneySaved} onChange={setMoney} onImport={importMoney} notify={showToast} />
        ) : view === 'server' ? (
          <Server data={data} now={now} onOpenSettings={() => setDrawer({ type: 'settings' })} />
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
            {shown.has('notes') && (
            <Notes
              notes={notes}
              activeId={activeId}
              onActive={pickNote}
              onChange={setNotes}
              saved={saved}
              onOpenFocus={() => setFocus(true)}
              onEditing={onNoteEditing}
            />
            )}
            {shown.has('pkgs') && (
            <Packages
              packages={data.packages}
              now={now}
              onOpen={(id) => setDrawer({ type: 'pkg', id })}
              onAdd={() => setDrawer({ type: 'add' })}
              onKeep={(id) => {
                patchPackage(id, { isNew: false });
                api.patchPackage(id, { isNew: false }).catch(onSaveError);
              }}
              onDismiss={archivePackage}
            />
            )}
            {shown.has('bm') && <Bookmarks groups={data.bookmarks} onChange={setBookmarks} search={search} edit={editBookmarks} setEdit={setEditBookmarks} />}
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
              onImport={importBackup}
              onAddPhotos={addPhotos}
              onRemovePhoto={removePhoto}
              onPhotoFocus={setPhotoFocus}
            />
          )}
          {drawer.type === 'add' && <AddPackageDrawer onSubmit={addPackage} onCancel={() => setDrawer(null)} />}
          {drawerPkg && <PackageDrawer key={drawerPkg.id} pkg={drawerPkg} now={now} onRename={(l) => renamePackage(drawerPkg.id, l)} onArchive={() => archivePackage(drawerPkg.id)} />}
        </Drawer>
      )}

      {focus && <FocusView notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onClose={() => setFocus(false)} />}

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
