import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STARTER_NOTES } from '../../shared/defaults';
import { ymd } from '../../shared/dates';
import { fmtStudy, timerMinutes } from '../../shared/learn';
import { fmtKg } from '../../shared/training';
import { fmtUsd } from '../../shared/claudeUsage';
import { fmtMoney, sortEntries } from '../../shared/money';
import { MOOD_WORDS, nearestCountdown, smokesOn } from '../../shared/trackers';
import type { AppState, Backup, BookmarkGroup, DesignKey, Countdown, Learn, Money, Mood, Note, Package, Photo, Prefs, Task, Training } from '../../shared/types';
import { api, localGet, localSet, type RestoreResult } from './api';
import { Bookmarks } from './components/Bookmarks';
import { AddPackageDrawer, DESIGNS, Drawer, PackageDrawer, SettingsDrawer } from './components/Drawers';
import { HeroPanel } from './components/Hero';
import { HorizonHome } from './components/Horizon';
import { FocusView, Notes } from './components/Notes';
import { Packages } from './components/Packages';
import { Palette } from './components/Palette';
import { PhotoPanel, shrinkImage, usePhotoSlots } from './components/Photos';
import { Rail } from './components/Rail';
import type { ServerTab } from './components/Server';
import { ServerBanner } from './components/ServerBanner';
import { Shortcuts } from './components/Shortcuts';
import { Tasks } from './components/Tasks';
import { Today, todayAgenda } from './components/Today';
import { TopBar, WeatherPanel } from './components/TopBar';
import { useAppData } from './hooks/useAppData';
import { useHashView, useLayout, useMinuteNow, useSystemDark } from './hooks/useDevice';
import { useShortcuts } from './hooks/useShortcuts';
import { useFlash, useToast } from './hooks/useToast';
import { gridLayout, type Area } from './layout';
import { send } from './outbox';
import { paletteAsk, paletteItems, paletteSearches, type AskHandlers, type PaletteContext } from './paletteItems';
import { dayDiff, hm, inboxBadge, inMinutes, newId, parseYmd } from './util';

// The views off the home page load the first time they're opened, so a new tab downloads
// and starts only what home needs. They're fetched in the background once the page is up
// (see preloadViews), so opening one is still instant, and works offline from the
// service worker's copy.
const loadInbox = () => import('./components/Inbox');
const loadLearn = () => import('./components/Learn');
const loadMoney = () => import('./components/money/MoneyView');
const loadNews = () => import('./components/News');
const loadServer = () => import('./components/Server');
const loadTraining = () => import('./components/Training');
const loadYou = () => import('./components/You');
const Inbox = lazy(() => loadInbox().then((m) => ({ default: m.Inbox })));
const LearnView = lazy(() => loadLearn().then((m) => ({ default: m.LearnView })));
const CourseDrawer = lazy(() => loadLearn().then((m) => ({ default: m.CourseDrawer })));
const MoneyView = lazy(() => loadMoney().then((m) => ({ default: m.MoneyView })));
const News = lazy(() => loadNews().then((m) => ({ default: m.News })));
const Server = lazy(() => loadServer().then((m) => ({ default: m.Server })));
const TrainingView = lazy(() => loadTraining().then((m) => ({ default: m.TrainingView })));
const ExerciseDrawer = lazy(() => loadTraining().then((m) => ({ default: m.ExerciseDrawer })));
const You = lazy(() => loadYou().then((m) => ({ default: m.You })));

function preloadViews() {
  for (const load of [loadInbox, loadLearn, loadMoney, loadNews, loadServer, loadTraining, loadYou]) load().catch(() => {});
}

type DrawerState = { type: 'pkg'; id: string } | { type: 'add' } | { type: 'settings' } | { type: 'exercise'; title: string } | { type: 'course'; id: string; item?: string } | null;

export function App({ cached }: { cached: AppState | null }) {
  const [view, setView] = useHashView();
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
  const [saved, flashSaved, setSaved] = useFlash();
  const [moneySaved, flashMoneySaved, setMoneySaved] = useFlash();
  const { toast, showToast, hideToast } = useToast();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const noteEditing = useRef(false);
  const now = useMinuteNow();
  const systemDark = useSystemDark();
  const layout = useLayout(rootRef);

  const onSaveError = useCallback((e: Error) => showToast(`Couldn’t save: ${e.message}`), [showToast]);

  // ---------- data ----------

  const { data, update, savers, merge, replace, refresh, serverIssue, waiting } = useAppData({ cached, notify: showToast, onSaveError, onNotesSaved: flashSaved, onMoneySaved: flashMoneySaved, noteEditing });
  const photoSlots = usePhotoSlots(data.photos.length);

  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 1500));
    idle(preloadViews);
    const err = new URLSearchParams(location.search).get('google');
    if (err) {
      showToast(err === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in failed: ${err}`);
      history.replaceState(null, '', '/' + location.hash);
    }
  }, [showToast]);

  // ---------- theme & layout ----------

  const design: DesignKey = localDesign || data.prefs.design || 'broadsheet';
  // Console is always dark; the others follow Theme.
  const dark = design === 'console' || data.prefs.theme === 'dark' || (data.prefs.theme === 'system' && systemDark);
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = data.prefs.accent;
    document.documentElement.dataset.design = design;
  }, [dark, data.prefs.accent, design]);

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
    savers.bookmarks.schedule(bookmarks);
  };

  const setNotes = (notes: Note[]) => {
    setSaved(false);
    update((d) => ({ ...d, notes }));
    savers.notes.schedule(notes);
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
    // Queued when the server can't be reached; otherwise fetch what the change set off (a new weather area).
    send({ kind: 'prefs', value: prefs }).then((saved) => saved && refresh()).catch(onSaveError);
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
    send({ kind: 'prefs', value: prefs })
      .then((saved) => saved && (added ? refreshNews() : refresh()))
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
    send({ kind: 'completeTask', listId: t.listId, id: t.id }, keepalive).catch((e) => {
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
  /** Server calls for the cigarette log run in order, and the server's list replaces the optimistic one (none when queued). */
  const smokeCall = (call: () => Promise<string[] | undefined>) => {
    smokeSaver.current = smokeSaver.current
      .then(call)
      .then((smokes) => smokes && update((d) => ({ ...d, smokes })))
      .catch((e) => {
        showToast(`Couldn’t save: ${e.message}`);
        refresh();
      });
  };

  const undoSmoke = (at: string) => {
    update((d) => ({ ...d, smokes: d.smokes.filter((x) => x !== at) }));
    smokeCall(() => send({ kind: 'removeSmoke', at }));
  };

  const logSmoke = () => {
    const at = new Date().toISOString();
    const count = smokesOn([...data.smokes, at], new Date()).length;
    update((d) => ({ ...d, smokes: [...d.smokes, at] }));
    smokeCall(() => send({ kind: 'addSmoke', at }));
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
    send<Record<string, number>>({ kind: 'weight', date, kg })
      .then((weights) => {
        if (weights) update((d) => ({ ...d, weights }));
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
    send<Record<string, Mood>>({ kind: 'mood', date, mood })
      .then((moods) => moods && update((d) => ({ ...d, moods })))
      .catch(onSaveError);
  };

  const setCountdowns = (countdowns: Countdown[]) => {
    update((d) => ({ ...d, countdowns }));
    send({ kind: 'countdowns', value: countdowns }).catch(onSaveError);
  };

  const setMoney = (money: Money) => {
    setMoneySaved(false);
    update((d) => ({ ...d, money }));
    savers.money.schedule(money);
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
    savers.learn.schedule(learn);
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

  // Over the Claude budget (Settings › General): say so once a month in each browser.
  const claudeOver = !!data.prefs.claudeBudget && (data.claudeSpend ?? 0) > data.prefs.claudeBudget;
  useEffect(() => {
    const month = ymd(new Date()).slice(0, 7);
    if (!claudeOver || localGet('claudeBudgetWarned') === month) return;
    localSet('claudeBudgetWarned', month);
    showToast(`Claude has cost about ${fmtUsd(data.claudeSpend ?? 0)} this month, over your ${fmtUsd(data.prefs.claudeBudget ?? 0)} budget.`, { label: 'See usage', run: () => openServerTab('overview') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeOver]);

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
    replace(state);
    if (!state.notes.some((n) => n.id === activeNote)) pickNote(state.notes[0].id);
    const summary = `Restored ${restored.join(', ')}.`;
    showToast(summary, undo ? { label: 'Undo', run: () => restoreWith(() => api.restoreSnapshot(undo)).catch((e) => showToast(`Couldn’t undo: ${e.message}`)) } : undefined);
    return restored;
  };
  const restoreBackup = (b: Partial<Backup> | Blob) => restoreWith(() => api.restoreBackup(b));
  const restoreSnapshot = (id: string) => restoreWith(() => api.restoreSnapshot(id));

  // ---------- keyboard ----------

  useShortcuts({
    view, setView, design, palette, setPalette, shortcuts, setShortcuts,
    drawer: !!drawer, closeDrawer: () => setDrawer(null), openSettings: () => setDrawer({ type: 'settings' }),
    focus, closeFocus: () => setFocus(false),
    search, searchRef, editBookmarks, bookmarks: data.bookmarks, logSmoke,
  });

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

  /** Ask Launchpad's actions, through the same saves the views use, each with an undo where there's one to give. */
  const askHandlers: AskHandlers = {
    addTask: (listId, title, due) => {
      addTask(listId, title, due);
      showToast(`Added “${title}” to Tasks`);
    },
    addMoney: (entry) => {
      const before = data.money;
      setMoney({ ...before, entries: sortEntries([...before.entries, entry]) });
      showToast(`Added ${fmtMoney(entry.amount)} ${entry.kind} to Money`, { label: 'Undo', run: () => setMoney(before) });
    },
    addCountdown: (cd) => {
      const before = data.countdowns;
      setCountdowns([...before, cd]);
      showToast(`Added a countdown to ${cd.title}`, { label: 'Undo', run: () => setCountdowns(before) });
    },
    addBookmark: (groupId, name, url) => {
      const before = data.bookmarks;
      setBookmarks(before.map((g) => (g.id === groupId ? { ...g, items: [...g.items, { id: newId('b'), name, url }] } : g)));
      showToast(`Added ${name} to bookmarks`, { label: 'Undo', run: () => setBookmarks(before) });
    },
    setMood: (date, mood) => {
      const before = data.moods[date] ?? null;
      setMood(date, mood);
      showToast(`Logged ${MOOD_WORDS[mood.level - 1].toLowerCase()} for ${date === ymd(new Date()) ? 'today' : date}`, { label: 'Undo', run: () => setMood(date, before) });
    },
    notify: showToast,
  };

  const paletteCtx: PaletteContext = {
    data, now, view, dark, design, localDesign, smokesToday, inboxCount, courseName, setView, setPrefs, setLocalDesign, logSmoke,
    openWeight: () => (setView('training'), setWeightSignal((n) => n + 1)),
    addCountdown: () => (setView('you'), setAddCountdown((n) => n + 1)),
    addWork: () => (setView('learn'), setAddWorkSignal((n) => n + 1)),
    startStudy, stopStudy, logStudy, setWeight, runSpeedTest, openServerTab,
    addPackage: () => setDrawer({ type: 'add' }),
    refreshNews, refreshInbox,
    showShortcuts: () => setShortcuts(true),
    openSettings: () => setDrawer({ type: 'settings' }),
    toggleHidden,
    ask: askHandlers,
  };

  const drawerTitle =
    drawer?.type === 'settings' ? 'Settings' : drawer?.type === 'add' ? 'Add package' : drawer?.type === 'exercise' ? drawer.title : drawer?.type === 'course' ? data.learn.courses.find((c) => c.id === drawer.id)?.name || 'Course' : drawerPkg ? 'Package' : '';

  return (
    <div ref={rootRef} className="lp-root" data-layout={layout} data-design={design} data-view={view}>
      <div className="lp-shell">
      <Rail view={view} hidden={data.prefs.hidden} badges={{ inbox: inboxCount }} onView={setView} onPalette={() => setPalette(true)} onSettings={() => setDrawer({ type: 'settings' })} />
      <div className="lp-inner">
        <TopBar data={data} now={now} subline={subline} search={search} onSearch={setSearch} searchRef={searchRef} smokesToday={smokesToday} onLogSmoke={logSmoke} onOpenTraining={() => setView('training')} onOpenLearn={() => setView('learn')} />
        {serverIssue && <ServerBanner issue={serverIssue} waiting={waiting} onRetry={() => refresh()} />}
        <Suspense fallback={<main className="view-loading" aria-busy="true" />}>
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
        </Suspense>
      </div>
      </div>

      {drawer && drawerTitle && (
        <Drawer title={drawerTitle} onClose={() => setDrawer(null)}>
          <Suspense fallback={null}>
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
          </Suspense>
        </Drawer>
      )}

      {focus && <FocusView notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onClose={() => setFocus(false)} />}

      {shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}

      {palette && <Palette items={paletteItems(paletteCtx)} searches={(q) => paletteSearches(paletteCtx, q)} ask={paletteAsk(paletteCtx, !serverIssue)} onClose={() => setPalette(false)} />}

      {toast && (
        <div className="popover toast" role="status">
          {toast.msg}
          {toast.action && (
            <button
              className="btn-link"
              style={{ marginLeft: 12, color: 'var(--tx)', fontWeight: 600 }}
              onClick={() => {
                toast.action!.run();
                hideToast();
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
