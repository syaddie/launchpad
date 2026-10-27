import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_PREFS, STARTER_BOOKMARKS, STARTER_NOTES } from '../../shared/defaults';
import type { AppState, BookmarkGroup, Note, Package, Photo, Prefs, Task } from '../../shared/types';
import { api, cachedState, cacheState, localGet, localSet } from './api';
import { Bookmarks } from './components/Bookmarks';
import { AddPackageDrawer, Drawer, PackageDrawer, SettingsDrawer } from './components/Drawers';
import { News } from './components/News';
import { FocusView, Notes } from './components/Notes';
import { Packages } from './components/Packages';
import { PhotoPanel, shrinkImage, usePhotoSlots } from './components/Photos';
import { Tasks } from './components/Tasks';
import { Today, todayAgenda } from './components/Today';
import { TopBar } from './components/TopBar';
import { dayDiff, hm, inMinutes, parseYmd } from './util';

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
  },
  tracking: { allCarriers: false },
  news: [],
  newsSummaries: false,
  photos: [],
};

/** A cached copy from an older version can be missing newer fields. */
function fromCache(c: AppState | null): AppState {
  if (!c) return EMPTY;
  return { ...EMPTY, ...c, prefs: { ...DEFAULT_PREFS, ...c.prefs }, sync: { ...EMPTY.sync, ...c.sync } };
}

type Layout = 'narrow' | 'desktop' | 'wide';
type View = 'home' | 'news';
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
  const [view, setView] = useState<View>('home');
  const [newsBusy, setNewsBusy] = useState(false);
  const [layout, setLayout] = useState<Layout>('desktop');
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focus, setFocus] = useState(false);
  const [editBookmarks, setEditBookmarks] = useState(false);
  const [activeNote, setActiveNote] = useState(() => localGet('activeNote') || '');
  const [saved, setSaved] = useState(false);
  const [toast, setToast] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteEditing = useRef(false);
  const savedT = useRef(0);
  const toastT = useRef(0);
  const now = useMinuteNow();
  const photoSlots = usePhotoSlots(data.photos.length);
  const systemDark = useSystemDark();

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastT.current);
    toastT.current = window.setTimeout(() => setToast(''), 4000);
  }, []);
  const onSaveError = useCallback((e: Error) => showToast(`Couldn’t save: ${e.message}`), [showToast]);

  const flashSaved = useCallback(() => {
    setSaved(true);
    clearTimeout(savedT.current);
    savedT.current = window.setTimeout(() => setSaved(false), 1500);
  }, []);

  const bookmarkSaver = useSaver(api.putBookmarks, 400, undefined, onSaveError);
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
      }));
    },
    [update, bookmarkSaver, noteSaver],
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

  // ---------- keyboard ----------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (drawer) setDrawer(null);
        else if (focus) setFocus(false);
        else if (view === 'news') setView('home');
        return;
      }
      const t = e.target as HTMLElement;
      const typing = /INPUT|TEXTAREA|SELECT/.test(t.tagName) || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'n' && !drawer && !focus) {
        setView((v) => (v === 'news' ? 'home' : 'news'));
        return;
      }
      if (/^[1-9]$/.test(e.key) && !search && !drawer && !focus && !editBookmarks) {
        const daily = data.bookmarks.find((g) => g.name === 'Daily');
        const b = daily?.items[Number(e.key) - 1];
        if (b) window.open(b.url, '_blank', 'noopener');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawer, focus, search, editBookmarks, data.bookmarks, view]);

  // Pick up anything the hourly news run fetched since the last poll.
  useEffect(() => {
    if (view === 'news') refresh();
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

  const importBackup = (bookmarks?: BookmarkGroup[], notes?: Note[]) => {
    if (bookmarks) setBookmarks(bookmarks);
    if (notes) {
      setNotes(notes);
      pickNote(notes[0].id);
    }
  };

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
  subline = subline.replace(/^ · /, '');

  const notes = data.notes.length ? data.notes : STARTER_NOTES;
  const activeId = notes.some((n) => n.id === activeNote) ? activeNote : notes[0].id;
  const drawerPkg = drawer?.type === 'pkg' ? data.packages.find((p) => p.id === drawer.id) : undefined;
  const photoCount = Math.min(data.photos.length, 2);
  const drawerTitle = drawer?.type === 'settings' ? 'Settings' : drawer?.type === 'add' ? 'Add package' : drawerPkg ? 'Package' : '';

  return (
    <div ref={rootRef} className="lp-root" data-layout={layout} data-photos={photoCount || undefined}>
      <div className="lp-inner">
        <TopBar
          data={data}
          now={now}
          subline={subline}
          search={search}
          onSearch={setSearch}
          searchRef={searchRef}
          onOpenSettings={() => setDrawer({ type: 'settings' })}
          newsOpen={view === 'news'}
          onToggleNews={() => setView(view === 'news' ? 'home' : 'news')}
        />
        {view === 'news' ? (
          <News data={data} now={now} busy={newsBusy} onRefresh={refreshNews} onTopics={setNewsTopics} />
        ) : (
          <main className="lp-grid">
            <Today
              data={data}
              now={now}
              wide={layout === 'wide'}
              compact={photoCount === 2 && layout !== 'narrow'}
              onConnect={connect}
              onRetry={() => api.sync('calendar').then(merge).catch(() => refresh())}
            />
            <Tasks data={data} now={now} onConnect={connect} onAdd={addTask} onComplete={completeTask} />
            {photoCount > 0 && <PhotoPanel photos={data.photos} area="photo" index={photoSlots.shown[0]} onStep={(d) => photoSlots.step(0, d)} />}
            {photoCount > 1 && <PhotoPanel photos={data.photos} area="photo2" index={photoSlots.shown[1]} onStep={(d) => photoSlots.step(1, d)} />}
            <Notes
              notes={notes}
              activeId={activeId}
              onActive={pickNote}
              onChange={setNotes}
              saved={saved}
              onOpenFocus={() => setFocus(true)}
              onEditing={onNoteEditing}
            />
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
            <Bookmarks groups={data.bookmarks} onChange={setBookmarks} search={search} edit={editBookmarks} setEdit={setEditBookmarks} />
          </main>
        )}
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

      {toast && (
        <div className="popover toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}
