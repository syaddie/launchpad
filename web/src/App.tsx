import { Fragment, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { STARTER_NOTES } from '../../shared/defaults';
import { ymd } from '../../shared/dates';
import { fmtStudy, timerMinutes } from '../../shared/learn';
import { fmtKg, workoutLabel } from '../../shared/training';
import { fmtUsd } from '../../shared/claudeUsage';
import { fmtMoney, sortEntries } from '../../shared/money';
import { MOOD_WORDS, nearestCountdown, smokesOn } from '../../shared/trackers';
import { knownDesign, type AppState, type Backup, type DesignKey, type Countdown, Learn, Money, Mood, Note, Photo, Prefs, Training, ViewKey } from '../../shared/types';
import { api, localGet, localSet, type RestoreResult } from './api';
import { AddEvent } from './components/AddEvent';
import { closeMenu, ContextMenuHost, copyText, menuProps, placeOf } from './components/ContextMenu';
import { DESIGNS, Drawer, PANEL_ROWS, SettingsDrawer, type SettingsTab } from './components/Drawers';
import { FocusHome, type FocusTabInfo } from './components/FocusHome';
import { HeroPanel } from './components/Hero';
import { MissionHero } from './components/mission/Hero';
import { MissionHome } from './components/mission/MissionHome';
import { Mark } from './components/mission/Mark';
import { MissionScene } from './components/mission/Scene';
import { FocusView, Notes } from './components/Notes';
import { Palette } from './components/Palette';
import { PhotoPanel, shrinkImage, usePhotoSlots, Wallpaper } from './components/Photos';
import { Rail, VIEWS } from './components/Rail';
import type { ServerTab } from './components/Server';
import { ServerBanner } from './components/ServerBanner';
import { Shortcuts } from './components/Shortcuts';
import { Today, todayAgenda } from './components/Today';
import { TopBar } from './components/TopBar';
import { useAppData } from './hooks/useAppData';
import { useGoogleActions } from './hooks/useGoogleActions';
import { useHashView, useLayout, useMinuteNow, useSystemDark } from './hooks/useDevice';
import { useShortcuts } from './hooks/useShortcuts';
import { useSidewaysWheel } from './hooks/useSidewaysWheel';
import { useFlash, useToast } from './hooks/useToast';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Presence } from './components/Motion';
import { focusOrder, focusTab, gridLayout, type Area, type FocusTab } from './layout';
import { skyWeather } from './mission';
import { loadable } from './loadable';
import { viewStep } from './motion';
import { endOpening, viewTransition } from './viewTransition';
import { markTicks } from './tickMarks';
import { send } from './outbox';
import { paletteAsk, paletteItems, paletteSearches, type AskHandlers, type PaletteContext } from './paletteItems';
import { hm, inboxBadge, inMinutes } from './util';
import { EmptyArt } from './components/mission/EmptyArt';

// The views off the home page load the first time they're opened, so a new tab downloads
// and starts only what home needs. They're fetched in the background once the page is up
// (see preloadViews), so opening one is still instant, and works offline from the
// service worker's copy.
const loadInbox = () => import('./components/Inbox');
const loadLearn = () => import('./components/Learn');
const loadMoney = () => import('./components/money/MoneyView');
const loadDigest = () => import('./components/Digest');
const loadReview = () => import('./components/Review');
const loadServer = () => import('./components/Server');
// The terminal is the one file the Server view fetches on its own, so it's kept up to date with the rest.
const loadTerminal = () => import('./components/Terminal');
const loadTraining = () => import('./components/Training');
const loadYou = () => import('./components/You');
const loadMusic = () => import('./components/music/MusicView');
// Once fetched, each renders at once, without a loading placeholder (loadable.tsx).
const Inbox = loadable(() => loadInbox().then((m) => m.Inbox));
const LearnView = loadable(() => loadLearn().then((m) => m.LearnView));
const CourseDrawer = loadable(() => loadLearn().then((m) => m.CourseDrawer));
const MoneyView = loadable(() => loadMoney().then((m) => m.MoneyView));
const Digest = loadable(() => loadDigest().then((m) => m.Digest));
const ReviewView = loadable(() => loadReview().then((m) => m.ReviewView));
const Server = loadable(() => loadServer().then((m) => m.Server));
const TrainingView = loadable(() => loadTraining().then((m) => m.TrainingView));
const ExerciseDrawer = loadable(() => loadTraining().then((m) => m.ExerciseDrawer));
const WorkoutDrawer = loadable(() => loadTraining().then((m) => m.WorkoutDrawer));
const You = loadable(() => loadYou().then((m) => m.You));
const MusicView = loadable(() => loadMusic().then((m) => m.MusicView));

/** Each view's code, by view; Home's is always there. */
const VIEW_CODE: Partial<Record<ViewKey, { preload: () => Promise<unknown>; ready: () => boolean }>> = {
  digest: Digest, inbox: Inbox, you: You, training: TrainingView, learn: LearnView, money: MoneyView, server: Server, review: ReviewView, music: MusicView,
};

function preloadViews() {
  for (const v of [Digest, Inbox, LearnView, CourseDrawer, MoneyView, MusicView, ReviewView, Server, TrainingView, ExerciseDrawer, WorkoutDrawer, You]) v.preload().catch(() => {});
  loadTerminal().catch(() => {});
}

type DrawerState = { type: 'settings'; tab?: SettingsTab } | { type: 'exercise'; title: string } | { type: 'workout'; id: string } | { type: 'course'; id: string; item?: string } | null;

/** How long a change of view waits for the new view's code before going ahead without it. */
const CODE_WAIT_MS = 400;

/**
 * Changes the view with the motion that goes with it (motion.css): along the rail, whichever way
 * the rail runs. A view whose code isn't in yet is waited for a moment, so the motion goes to the
 * view itself rather than to its loading placeholder.
 */
function moveView(from: ViewKey, to: ViewKey, apply: () => void) {
  const go = () => {
    const rail = document.querySelector('.rail');
    document.documentElement.dataset.axis = rail && getComputedStyle(rail).flexDirection.startsWith('row') ? 'x' : 'y';
    viewTransition(viewStep(from, to), apply);
  };
  const code = VIEW_CODE[to];
  if (!code || code.ready()) go();
  else Promise.race([code.preload(), new Promise((r) => window.setTimeout(r, CODE_WAIT_MS))]).then(go, go);
}

export function App({ cached }: { cached: AppState | null }) {
  const [view, setView] = useHashView(moveView);
  const [palette, setPalette] = useState(false);
  const [shortcuts, setShortcuts] = useState(false);
  const [addCountdown, setAddCountdown] = useState(0);
  const [weightSignal, setWeightSignal] = useState(0);
  const [addWorkSignal, setAddWorkSignal] = useState(0);
  const [addEventSignal, setAddEventSignal] = useState(0);
  const [digestTab, setDigestTab] = useState<{ tab: 'archive' | 'reading'; n: number } | null>(null);
  const [serverTab, setServerTab] = useState<{ tab: ServerTab; n: number } | null>(null);
  const [learnNoteBusy, setLearnNoteBusy] = useState(false);
  const [digestBusy, setDigestBusy] = useState(false);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>(null);
  const [focus, setFocus] = useState(false);
  // Mission: each time this goes up, the rocket on the horizon lifts off (components/mission/Scene.tsx).
  const [launches, setLaunches] = useState(0);
  const [activeNote, setActiveNote] = useState(() => localGet('activeNote') || '');
  const [localDesign, setLocalDesignState] = useState<DesignKey | ''>(() => (DESIGNS.some((d) => d.key === localGet('design')) ? (localGet('design') as DesignKey) : ''));
  const setLocalDesign = (d: DesignKey | '') => {
    setLocalDesignState(d);
    localSet('design', d);
  };
  // The panel Focus's home has open; the other layouts show them all at once.
  const [homeTab, setHomeTabState] = useState(() => localGet('homeTab'));
  const setHomeTab = (t: FocusTab) => {
    setHomeTabState(t);
    localSet('homeTab', t);
  };
  const [saved, flashSaved, setSaved] = useFlash();
  const [moneySaved, flashMoneySaved, setMoneySaved] = useFlash();
  const { toast, showToast, hideToast, holdToast } = useToast();
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

  // The opening (motion.css) plays once as the app starts; after that, only changes move.
  useEffect(() => {
    const t = window.setTimeout(endOpening, 2200);
    return () => window.clearTimeout(t);
  }, []);

  // A box ticked by hand is marked, so a design can make that tick land with some light (tickMarks.ts).
  useEffect(() => markTicks(), []);

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

  // A design that's since been retired (saved before 2026-11-25) shows the default.
  const design: DesignKey = localDesign || knownDesign(data.prefs.design);
  const dark = data.prefs.theme === 'dark' || (data.prefs.theme === 'system' && systemDark);
  useLayoutEffect(() => {
    document.documentElement.dataset.mode = dark ? 'dark' : 'light';
    document.documentElement.dataset.accent = data.prefs.accent;
    document.documentElement.dataset.design = design;
    // A phone's status bar and an installed app's title bar take the design's own page colour.
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = bg;
  }, [dark, data.prefs.accent, design]);
  // On the page too, so drawers drawn outside .lp-root (portals) get the phone's layout.
  useLayoutEffect(() => {
    document.documentElement.dataset.layout = layout;
  }, [layout]);

  // A right-click menu belongs to the view it was opened in.
  useEffect(() => closeMenu(), [view]);

  // Pick up anything the hourly digest run (or the inbox's) wrote since the last poll.
  useEffect(() => {
    if (view === 'digest' || view === 'inbox') refresh();
  }, [view, refresh]);

  // ---------- actions ----------

  const connect = () => {
    location.href = '/api/auth/google';
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

  /** Write any of today's lessons that are missing (a new subject's, or all of them on a new day). */
  const refreshDigest = useCallback(() => {
    setDigestBusy(true);
    api
      .sync('digest')
      .then(merge)
      .catch((e) => showToast(`Couldn’t write today’s lessons: ${e.message}`))
      .finally(() => setDigestBusy(false));
  }, [merge, showToast]);

  const refreshInbox = () => {
    setInboxBusy(true);
    api
      .sync('inbox')
      .then(merge)
      .catch((e) => showToast(`Couldn’t refresh the inbox: ${e.message}`))
      .finally(() => setInboxBusy(false));
  };

  /** A subject added writes its lesson for today straight away. */
  const setDigestSubjects = (digestSubjects: string[]) => {
    const prefs = { ...data.prefs, digestSubjects };
    const added = digestSubjects.some((t) => !data.prefs.digestSubjects.some((s) => s.toLowerCase() === t.toLowerCase()));
    update((d) => ({ ...d, prefs }));
    send({ kind: 'prefs', value: prefs })
      .then((saved) => saved && (added && data.newsSummaries ? refreshDigest() : refresh()))
      .catch(onSaveError);
  };

  // Opening the digest on a day whose lessons haven't been written yet (the hourly run hasn't got
  // to them since midnight) writes them now; the server does nothing when they're all there.
  const digestToday = data.digest.days[0]?.date === ymd(now);
  useEffect(() => {
    if (view === 'digest' && data.newsSummaries && data.prefs.digestSubjects.length && !digestToday && !digestBusy) refreshDigest();
    // Once per visit to the view, and again when the day turns over while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, data.newsSummaries, digestToday]);

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

  const google = useGoogleActions({ data, update, refresh, notify: showToast, setMoney });

  const importMoney = (money: Money, summary: string) => {
    const before = data.money;
    setMoney(money);
    showToast(summary, { label: 'Undo', run: () => setMoney(before) });
  };

  /** Claude reads what any new exercises train, for Sets per muscle. */
  const labelExercises = () => {
    if (!data.newsSummaries) return;
    api
      .refreshTraining()
      .then(merge)
      .catch((e) => showToast(`Couldn’t read what your exercises train: ${e.message}`));
  };

  const setTraining = (training: Training) => {
    update((d) => ({ ...d, training }));
    api
      .putTraining(training)
      .then(labelExercises)
      .catch(onSaveError);
  };

  /** Download everything from Hevy now (Training › Sync now). */
  const syncHevy = () =>
    api
      .sync('hevy')
      .then((s) => {
        merge(s);
        const error = s.sync.hevy.lastError;
        showToast(error ? `Couldn’t sync with Hevy: ${error}` : 'Synced with Hevy');
      })
      .catch((e) => showToast(`Couldn’t sync with Hevy: ${e.message}`));

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

  /** Claude's recap of the week starting `week`, written again. */
  const refreshReview = (week: string) => {
    setReviewBusy(true);
    api
      .refreshReview(week)
      .then(merge)
      .catch((e) => showToast(`Couldn’t write the recap: ${e.message}`))
      .finally(() => setReviewBusy(false));
  };
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

  useSidewaysWheel();
  useShortcuts({
    view, setView, palette, setPalette, shortcuts, setShortcuts,
    drawer: !!drawer, closeDrawer: () => setDrawer(null),
    focus, closeFocus: () => setFocus(false),
    searchRef, logSmoke,
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
  // The tail of the summary line, which Focus's clock tile shows under the next event.
  const extras: string[] = [];
  const soon = data.prefs.hidden.includes('top:countdown') ? '' : nearestCountdown(data.countdowns, now);
  if (soon) extras.push(soon);
  subline = [subline, ...extras].filter(Boolean).join(' · ');

  const notes = data.notes.length ? data.notes : STARTER_NOTES;
  const activeId = notes.some((n) => n.id === activeNote) ? activeNote : notes[0].id;
  const hidden = new Set(data.prefs.hidden);
  const photoCount = hidden.has('panel:photos') ? 0 : Math.min(data.photos.length, 2);
  const shown = new Set<Area>(
    (
      [
        ['today', 'panel:today'],
        ['notes', 'panel:notes'],
      ] as const
    )
      .filter(([, k]) => !hidden.has(k))
      .map(([a]) => a),
  );
  // Vista's photos are its wallpaper; Focus has room for one beside the tabs.
  if (photoCount > 0 && design !== 'vista') shown.add('photo');
  if (photoCount > 1 && design !== 'vista' && design !== 'focus') shown.add('photo2');
  // Focus opens with a clock tile.
  if (design === 'focus') shown.add('hero');
  const weatherOn = !!data.prefs.weatherArea && !hidden.has('top:weather');
  const grid = gridLayout(layout, shown, design, data.prefs.homeLayouts);
  const smokesToday = smokesOn(data.smokes, now).length;
  const inboxCount = inboxBadge(data);

  // Focus: what's waiting behind each tab.
  const tabOrder = focusOrder(data.prefs.homeLayouts);
  const activeTab = focusTab(homeTab, shown, tabOrder);
  let focusTabs: FocusTabInfo[] = [];
  if (design === 'focus') {
    const calOn = data.google.connected && data.prefs.sources.calendar;
    const left = calOn ? todayAgenda(data, now).todays.filter((e) => e.e > now).length : 0;
    if (shown.has('today')) focusTabs.push({ key: 'today', name: 'Today', icon: 'ph-calendar-blank', count: left });
    if (shown.has('notes')) focusTabs.push({ key: 'notes', name: 'Notepad', icon: 'ph-notebook' });
    // In the order set in Settings › Layout.
    focusTabs = tabOrder.flatMap((k) => focusTabs.filter((t) => t.key === k));
  }

  const notesPanel = (
    <Notes notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onOpenFocus={() => setFocus(true)} onEditing={onNoteEditing} notify={showToast} />
  );
  const todayPanel = (
    <Today
      data={data}
      now={now}
      wide={layout === 'wide' || design === 'focus'}
      compact={shown.has('photo2') && layout !== 'narrow'}
      onConnect={connect}
      onRetry={() => api.sync('calendar').then(merge).catch(() => refresh())}
      notify={showToast}
      addEvent={<AddEvent data={data} now={now} focusSignal={addEventSignal} onAdd={google.addEvent} onConnect={connect} />}
    />
  );
  const heroPanel = <HeroPanel data={data} now={now} extras={extras.join(' · ')} />;
  const noPanels = (
    <div className="panel" style={{ gridColumn: '1 / -1' }}>
      <div className="empty">
        <EmptyArt kind="away" />
        <p>Every home panel is switched off.</p>
        <button className="btn btn-secondary" onClick={() => setDrawer({ type: 'settings' })}>
          Open Settings
        </button>
      </div>
    </div>
  );
  /** A photo panel; its menu also manages and hides them. */
  const photoPanel = (area: 'photo' | 'photo2') => {
    const slot = area === 'photo' ? 0 : 1;
    return (
      <PhotoPanel
        photos={data.photos}
        area={area}
        index={photoSlots.shown[slot]}
        onStep={(d) => photoSlots.step(slot, d)}
        onManage={() => setDrawer({ type: 'settings', tab: 'photos' })}
        onHide={() => hidePanel('panel:photos', 'Photos')}
      />
    );
  };
  /** The home grid's panel for an area. */
  const homePanel = (a: Area): ReactNode => {
    switch (a) {
      case 'today': return todayPanel;
      case 'notes': return notesPanel;
      case 'photo': return photoPanel('photo');
      case 'photo2': return photoPanel('photo2');
      case 'hero': return heroPanel;
    }
  };

  // ---------- command palette ----------

  /** Ask Launchpad's actions, through the same saves the views use, each with an undo where there's one to give. */
  const askHandlers: AskHandlers = {
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
    addEvent: google.addEvent,
    // The field is in the Today panel.
    openAddEvent: shown.has('today') ? () => (setView('home'), setHomeTab('today'), setAddEventSignal((n) => n + 1)) : undefined,
    refreshInbox,
    openDigestTab: (tab) => (setView('digest'), setDigestTab((t) => ({ tab, n: (t?.n ?? 0) + 1 }))),
    openNote: (id: string) => (pickNote(id), setHomeTab('notes'), setView('home')),
    showShortcuts: () => setShortcuts(true),
    openSettings: () => setDrawer({ type: 'settings' }),
    toggleHidden,
    ask: askHandlers,
  };

  const workoutTitle = (id: string) => {
    const w = data.training.workouts.find((x) => x.id === id);
    return w ? workoutLabel(w, data.exerciseMuscles) : 'Session';
  };
  const drawerTitle =
    drawer?.type === 'settings' ? 'Settings' : drawer?.type === 'exercise' ? drawer.title : drawer?.type === 'workout' ? workoutTitle(drawer.id) : drawer?.type === 'course' ? data.learn.courses.find((c) => c.id === drawer.id)?.name || 'Course' : '';

  // A right-click on anything without a menu of its own: what the panel or dialog it's in offers,
  // then the app-wide things. A long press on a plain link lands here too (a mouse keeps the browser's).
  const hidePanel = (key: string, name: string) => {
    const before = data.prefs;
    setPrefs({ ...before, hidden: [...before.hidden.filter((h) => h !== key), key] });
    showToast(`Hid ${name}. Settings › Panels brings it back.`, { label: 'Undo', run: () => setPrefs(before) });
  };
  const backgroundMenu = menuProps(
    (t) => {
      const place = placeOf(t);
      const link = t.closest('a[href]');
      const url = link instanceof HTMLAnchorElement ? link.href : '';
      const copyEl = t.closest<HTMLElement>('[data-copy]');
      // As Settings › Panels names it ("Photos" for either photo panel).
      const hideName = place?.hide && !hidden.has(place.hide) ? PANEL_ROWS.flatMap((s) => s.rows).find((r) => r.key === place.hide)?.name : undefined;
      return [
        url && { label: 'Open link', icon: 'ph-arrow-square-out', href: url, newTab: link?.getAttribute('target') === '_blank' },
        url && link?.getAttribute('target') !== '_blank' && { label: 'Open in a new tab', icon: 'ph-browsers', href: url, newTab: true },
        url && { label: 'Copy link', icon: 'ph-link', onSelect: () => copyText(url, showToast, 'Link copied') },
        'sep',
        // Text to copy whole, on phones where it can't be selected (`data-copy` names it).
        copyEl && { label: `Copy ${copyEl.dataset.copy || 'text'}`, icon: 'ph-copy', onSelect: () => copyText(copyEl.dataset.copyText ?? copyEl.innerText, showToast) },
        ...(place?.items ?? []),
        hideName && { label: `Hide ${hideName}`, icon: 'ph-eye-slash', onSelect: () => hidePanel(place!.hide!, hideName) },
        // Vista's photos are the wallpaper, so a right-click on it (outside every panel) is about them.
        view === 'home' && design === 'vista' && !place && photoCount > 1 && { label: 'Next photo', icon: 'ph-caret-right', onSelect: () => photoSlots.step(0, 1) },
        view === 'home' && design === 'vista' && !place && photoCount > 0 && { label: 'Manage photos…', icon: 'ph-images', onSelect: () => setDrawer({ type: 'settings', tab: 'photos' }) },
        'sep',
        !palette && { label: 'Command palette', icon: 'ph-command', onSelect: () => setPalette(true) },
        !shortcuts && { label: 'Keyboard shortcuts', icon: 'ph-keyboard', onSelect: () => setShortcuts(true) },
        'sep',
        drawer?.type !== 'settings' && { label: 'Settings', icon: 'ph-gear-six', onSelect: () => setDrawer({ type: 'settings' }) },
      ];
    },
    (t) => placeOf(t)?.name || 'Launchpad',
    { root: true },
  );

  return (
    <div ref={rootRef} className="lp-root" data-layout={layout} data-design={design} data-view={view} {...backgroundMenu}>
      {design === 'vista' && <Wallpaper photos={photoCount > 0 ? data.photos : []} index={photoSlots.shown[0]} onNext={() => photoSlots.step(0, 1)} />}
      {design === 'mission' && (
        <MissionScene
          now={now}
          dark={dark}
          narrow={layout === 'narrow'}
          home={view === 'home'}
          events={data.google.connected && data.prefs.sources.calendar ? todayAgenda(data, now).todays.map((e) => ({ id: e.id, at: e.s, end: e.e, name: e.title })) : []}
          wx={skyWeather(weatherOn ? data.weather.now?.forecast : null)}
          launch={launches}
        />
      )}
      <div className="lp-shell">
      <Rail
        view={view}
        hidden={data.prefs.hidden}
        badges={{ inbox: inboxCount }}
        onView={setView}
        onHide={(v) => {
          const before = data.prefs;
          setPrefs({ ...before, hidden: [...before.hidden.filter((h) => h !== `view:${v}`), `view:${v}`] });
          showToast(`Hid ${VIEWS.find((x) => x.key === v)?.name} from the rail. ⌘K still opens it.`, { label: 'Undo', run: () => setPrefs(before) });
        }}
        onPalette={() => setPalette(true)} onSettings={() => setDrawer({ type: 'settings' })}
        brand={
          design === 'mission' ? (
            // The mark goes Home, and launches when it's already there.
            <button
              className="ms-brand"
              title={view === 'home' ? 'Launch' : 'Home'}
              aria-label={view === 'home' ? 'Launchpad. Launch the rocket.' : 'Launchpad. Go Home.'}
              onClick={() => (view === 'home' ? setLaunches((n) => n + 1) : setView('home'))}
              {...menuProps(
                () => [
                  view !== 'home' && { label: 'Go Home', icon: 'ph-house', onSelect: () => setView('home') },
                  { label: 'Launch the rocket', icon: 'ph-rocket-launch', onSelect: () => (setView('home'), window.setTimeout(() => setLaunches((n) => n + 1), view === 'home' ? 0 : 700)) },
                ],
                'Launchpad',
              )}
            >
              <Mark small liftoff={launches} />
              <span>Launchpad</span>
            </button>
          ) : undefined
        }
      />
      <div className="lp-inner">
        <TopBar data={data} now={now} title={view === 'home' ? undefined : VIEWS.find((v) => v.key === view)?.name} subline={subline} search={search} onSearch={setSearch} searchRef={searchRef} smokesToday={smokesToday} onLogSmoke={logSmoke} onOpenTraining={() => setView('training')} onOpenLearn={() => setView('learn')} lost={!!serverIssue} waiting={waiting} lead={design === 'mission' && view === 'home' ? <MissionHero data={data} now={now} extras={extras.join(' · ')} /> : undefined} />
        {/* Mission brings it down and takes it back up (mission.css, LOSS OF SIGNAL); the others show and hide it. */}
        <Presence show={!!serverIssue}>{serverIssue && <ServerBanner issue={serverIssue} waiting={waiting} onRetry={() => refresh()} />}</Presence>
        <ErrorBoundary resetKey={view}>
        <Suspense fallback={<main className="view-loading" aria-busy="true" />}>
        {view === 'digest' ? (
          <Digest data={data} now={now} busy={digestBusy} onRefresh={refreshDigest} onSubjects={setDigestSubjects} onMerge={merge} onLists={(newsLists) => update((d) => ({ ...d, newsLists }))} notify={showToast} tabSignal={digestTab} />
        ) : view === 'inbox' ? (
          <Inbox
            data={data}
            now={now}
            busy={inboxBusy}
            onRefresh={refreshInbox}
            onConnect={connect}
            onOpenSettings={() => setDrawer({ type: 'settings' })}
            actions={{ onAction: google.inboxAction, onKeepBill: google.keepBill, onDismissBill: google.dismissBill }}
            notify={showToast}
          />
        ) : view === 'you' ? (
          <You
            data={data}
            now={now}
            addSignal={addCountdown}
            onCountdowns={setCountdowns}
            onLogSmoke={logSmoke}
            onUndoSmoke={undoSmoke}
            onMood={setMood}
            onOpenSettings={() => setDrawer({ type: 'settings' })}
          />
        ) : view === 'review' ? (
          <ReviewView data={data} now={now} busy={reviewBusy} onRefresh={refreshReview} onView={setView} />
        ) : view === 'training' ? (
          <TrainingView
            data={data}
            now={now}
            onImport={importTraining}
            onSync={syncHevy}
            onOpenExercise={(title) => setDrawer({ type: 'exercise', title })}
            onOpenWorkout={(id) => setDrawer({ type: 'workout', id })}
            onOpenSettings={() => setDrawer({ type: 'settings' })}
            onWeight={setWeight}
            weightSignal={weightSignal}
            notify={showToast}
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
          <MoneyView money={data.money} now={now} saved={moneySaved} onChange={setMoney} onImport={importMoney} notify={showToast} together={layout !== 'narrow'} bills={data.bills} onDropBill={google.dismissBill} />
        ) : view === 'music' ? (
          <MusicView now={now} notify={showToast} />
        ) : view === 'server' ? (
          <Server data={data} now={now} openTab={serverTab} onOpenSettings={() => setDrawer({ type: 'settings' })} onPinFolders={(pinnedFolders) => setPrefs({ ...data.prefs, pinnedFolders })} onAutoUnpack={(autoUnpack) => setPrefs({ ...data.prefs, autoUnpack })} split={layout !== 'narrow'} />
        ) : (
          design === 'mission' ? (
            <MissionHome
              photos={data.photos}
              photosOff={hidden.has('panel:photos')}
              start={photoSlots.shown[0]}
              today={shown.has('today') && todayPanel}
              notes={shown.has('notes') && notesPanel}
              onManagePhotos={() => setDrawer({ type: 'settings', tab: 'photos' })}
              onHidePhotos={() => hidePanel('panel:photos', 'Photos')}
              empty={noPanels}
            />
          ) : design === 'focus' ? (
            <FocusHome
              tabs={focusTabs}
              active={activeTab}
              onTab={setHomeTab}
              hero={heroPanel}
              photo={shown.has('photo') && photoPanel('photo')}
              panel={activeTab === 'notes' ? notesPanel : todayPanel}
              empty={noPanels}
            />
          ) : (
          <main className="lp-grid" style={{ gridTemplateAreas: grid.areas, gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}>
            {/* In reading order (gridLayout), so Tab goes down each column as it's arranged. */}
            {grid.order.map((a) => (
              <Fragment key={a}>{homePanel(a)}</Fragment>
            ))}
            {!shown.size && noPanels}
          </main>
          )
        )}
        </Suspense>
        </ErrorBoundary>
      </div>
      </div>

      {/* Each of these animates out before it goes (Presence, motion.css). */}
      <Presence show={!!(drawer && drawerTitle)}>
      {drawer && drawerTitle && (
        <Drawer title={drawerTitle} onClose={() => setDrawer(null)}>
          <Suspense fallback={null}>
          {drawer.type === 'settings' && (
            <SettingsDrawer
              key={drawer.tab ?? 'general'}
              startTab={drawer.tab}
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
          {drawer.type === 'exercise' && (
            <ExerciseDrawer key={drawer.title} title={drawer.title} data={data} pinned={data.prefs.pinnedLifts.includes(drawer.title)} onPin={() => togglePin(drawer.title)} />
          )}
          {drawer.type === 'workout' && (
            <WorkoutDrawer key={drawer.id} id={drawer.id} data={data} onOpenExercise={(title) => setDrawer({ type: 'exercise', title })} notify={showToast} />
          )}
          {drawer.type === 'course' && (
            <CourseDrawer key={drawer.id} learn={data.learn} courseId={drawer.id} focusItem={drawer.item} now={now} onChange={setLearn} onClose={() => setDrawer(null)} notify={showToast} />
          )}
          </Suspense>
        </Drawer>
      )}
      </Presence>

      <Presence show={focus}>
        {focus && <FocusView notes={notes} activeId={activeId} onActive={pickNote} onChange={setNotes} saved={saved} onClose={() => setFocus(false)} notify={showToast} />}
      </Presence>

      <Presence show={shortcuts}>{shortcuts && <Shortcuts onClose={() => setShortcuts(false)} />}</Presence>

      <ContextMenuHost />

      <Presence show={palette}>
        {palette && <Palette items={paletteItems(paletteCtx)} searches={(q) => paletteSearches(paletteCtx, q)} ask={paletteAsk(paletteCtx, !serverIssue)} onClose={() => setPalette(false)} />}
      </Presence>

      <Presence show={!!toast}>
        {toast && (
          // A message with an Undo shows how long it has left (motion.css); pointing at it holds it.
          <div
            key={toast.id}
            className="popover toast"
            role="status"
            data-life={toast.action ? '' : undefined}
            style={{ '--toast-life': `${toast.life}ms` } as CSSProperties}
            onMouseEnter={() => holdToast(true)}
            onMouseLeave={() => holdToast(false)}
          >
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
      </Presence>
    </div>
  );
}
