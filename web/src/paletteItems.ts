// What ⌘K offers: actions, views, panels to show or hide, bookmarks, and for what's typed,
// quick logs ("weight 72.4", "study 45 cs210") and web searches.
import { rankBookmarks } from '../../shared/bookmarks';
import { ymd } from '../../shared/dates';
import { fmtStudy, parseStudy, timerMinutes } from '../../shared/learn';
import { fmtKg, parseWeight } from '../../shared/training';
import { MOOD_WORDS, engineUrl, fmtDuration, parseSearch } from '../../shared/trackers';
import type { AppState, DesignKey, Prefs, ViewKey } from '../../shared/types';
import { DESIGNS, PANEL_ROWS } from './components/Drawers';
import type { PaletteItem } from './components/Palette';
import { VIEWS } from './components/Rail';
import type { ServerTab } from './components/Server';
import { bookmarkOpened } from './api';
import { host } from './util';

export interface PaletteContext {
  data: AppState;
  now: Date;
  view: ViewKey;
  dark: boolean;
  design: DesignKey;
  localDesign: DesignKey | '';
  smokesToday: number;
  inboxCount: number;
  courseName: (id: string) => string;
  setView: (v: ViewKey) => void;
  setPrefs: (p: Prefs) => void;
  setLocalDesign: (d: DesignKey | '') => void;
  logSmoke: () => void;
  openWeight: () => void;
  addCountdown: () => void;
  addWork: () => void;
  startStudy: (courseId: string) => void;
  stopStudy: () => void;
  logStudy: (minutes: number, courseId: string) => void;
  setWeight: (date: string, kg: number | null, undo?: boolean) => void;
  runSpeedTest: () => void;
  openServerTab: (tab: ServerTab) => void;
  addPackage: () => void;
  refreshNews: () => void;
  refreshInbox: () => void;
  /** News › Reading list. */
  openReading: () => void;
  /** Show a notepad on home. */
  openNote: (id: string) => void;
  showShortcuts: () => void;
  openSettings: () => void;
  toggleHidden: (key: string) => void;
}

export function paletteItems(c: PaletteContext): PaletteItem[] {
  const { data, now, view, dark, design, localDesign, smokesToday, inboxCount, courseName, setView, setPrefs } = c;
  const todayMood = data.moods[ymd(now)];
  const hasCourses = data.learn.courses.some((x) => !x.archived);
  const hidden = new Set(data.prefs.hidden);
  return [
    {
      id: 'a:smoke', group: 'Actions', label: 'Log a cigarette', icon: 'ph-cigarette', keys: ['C'], words: 'smoke',
      sub: `${smokesToday} today${data.smokes.length ? ` · last one ${fmtDuration(now.getTime() - Date.parse(data.smokes[data.smokes.length - 1]))} ago` : ''}`,
      run: c.logSmoke,
    },
    {
      id: 'a:weight', group: 'Actions', label: 'Log your weight', icon: 'ph-scales', words: 'body weight kg scale',
      sub: data.weights[ymd(now)] ? `Today: ${fmtKg(data.weights[ymd(now)])} kg` : 'Or type “weight 72.4”',
      run: c.openWeight,
    },
    { id: 'a:mood', group: 'Actions', label: 'Log today’s mood', icon: 'ph-smiley', keys: ['M'], sub: todayMood ? `Today: ${MOOD_WORDS[todayMood.level - 1]}` : 'Not logged yet today', run: () => setView('you') },
    { id: 'a:countdown', group: 'Actions', label: 'Add a countdown', icon: 'ph-hourglass-medium', run: c.addCountdown },
    ...(data.learn.timer
      ? [{
          id: 'a:study-stop', group: 'Actions', label: 'Stop studying', icon: 'ph-stop', words: 'timer learn log',
          sub: `${courseName(data.learn.timer.courseId)} · ${fmtStudy(timerMinutes(data.learn.timer, now))} so far`,
          run: c.stopStudy,
        }]
      : []),
    ...data.learn.courses.filter((x) => !x.archived && x.id !== data.learn.timer?.courseId).map((x, i) => ({
      id: 'a:study-' + x.id, group: 'Actions', label: `Start studying ${x.name}`, icon: 'ph-timer', words: `timer learn ${x.code}`,
      sub: i === 0 ? 'Or type “study 45 ' + (x.code || x.name).toLowerCase().replace(/\s+/g, '') + '” to log time' : x.code || undefined,
      onlyWhenTyping: i > 0,
      run: () => (c.startStudy(x.id), setView('learn')),
    })),
    ...(hasCourses
      ? [{ id: 'a:work', group: 'Actions', label: 'Add a deliverable', icon: 'ph-exam', words: 'assignment homework quiz exam due learn', run: c.addWork }]
      : []),
    { id: 'a:speed', group: 'Actions', label: 'Run a speed test', icon: 'ph-gauge', words: 'internet', run: c.runSpeedTest },
    { id: 'a:terminal', group: 'Actions', label: 'Open the server terminal', icon: 'ph-terminal-window', words: 'shell ssh console command line', run: () => c.openServerTab('terminal') },
    { id: 'a:files', group: 'Actions', label: 'Browse the server’s files', icon: 'ph-folder-simple', words: 'file explorer sftp upload download folders', run: () => c.openServerTab('files') },
    { id: 'a:package', group: 'Actions', label: 'Add a package', icon: 'ph-package', words: 'tracking', run: c.addPackage },
    { id: 'a:news', group: 'Actions', label: 'Refresh the news', icon: 'ph-arrows-clockwise', run: () => (setView('news'), c.refreshNews()) },
    ...readingItems(c),
    // Notepads by name, tag or anything in them, once something's typed.
    ...data.notes.map((n) => ({
      id: 'n:' + n.id, group: 'Notes', label: n.name || 'Untitled', icon: 'ph-notebook', onlyWhenTyping: true,
      sub: n.tags?.length ? n.tags.map((t) => '#' + t).join(' ') : undefined,
      words: `notepad note ${n.text.slice(0, 5000)}`,
      run: () => c.openNote(n.id),
    })),
    {
      id: 'a:inbox', group: 'Actions', label: 'Catch up on email', icon: 'ph-envelope-open', words: 'inbox gmail mail summary digest',
      sub: inboxCount ? `${inboxCount} need${inboxCount === 1 ? 's' : ''} you` : undefined,
      run: () => (setView('inbox'), c.refreshInbox()),
    },
    { id: 'a:theme', group: 'Actions', label: dark ? 'Switch to the light theme' : 'Switch to the dark theme', icon: dark ? 'ph-sun' : 'ph-moon', run: () => setPrefs({ ...data.prefs, theme: dark ? 'light' : 'dark' }) },
    ...DESIGNS.filter((d) => d.key !== design).map((d) => ({
      id: 'l:' + d.key, group: 'Actions', label: `Layout: ${d.name}`, icon: 'ph-layout', words: 'design look theme switch view',
      sub: localDesign ? 'This browser only' : 'Every device',
      run: () => (localDesign ? c.setLocalDesign(d.key) : setPrefs({ ...data.prefs, design: d.key })),
    })),
    { id: 'a:shortcuts', group: 'Actions', label: 'Keyboard shortcuts', icon: 'ph-keyboard', keys: ['?'], words: 'keys hotkeys help cheat sheet', run: c.showShortcuts },
    { id: 'a:settings', group: 'Actions', label: 'Open Settings', icon: 'ph-gear-six', words: 'preferences', run: c.openSettings },
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
        run: () => c.toggleHidden(r.key),
      })),
    ),
    // The most opened first, so they lead once something's typed.
    ...rankBookmarks(data.bookmarks.flatMap((g) => g.items.map((b, i) => ({ ...b, g, i }))), data.bookmarkOpens).map(({ g, i, ...b }) => ({
        id: 'b:' + b.id,
        group: 'Bookmarks',
        label: b.name,
        sub: `${g.name} · ${host(b.url)}`,
        icon: (b.name || '?')[0].toUpperCase(),
        keys: g.name === 'Daily' && i < 9 ? [String(i + 1)] : undefined,
        words: b.url,
        onlyWhenTyping: true,
        run: () => {
          bookmarkOpened(b.id);
          window.open(b.url, '_blank', 'noopener');
        },
      })),
  ];
}

/** The reading list, and each story on it (those once something's typed). */
function readingItems(c: PaletteContext): PaletteItem[] {
  const toRead = (c.data.newsLists?.saved ?? []).filter((s) => !s.readAt);
  return [
    {
      id: 'a:reading', group: 'Actions', label: 'Open the reading list', icon: 'ph-bookmark-simple', words: 'news saved later read stories',
      sub: toRead.length ? `${toRead.length} to read` : 'Nothing saved yet',
      run: c.openReading,
    },
    ...toRead.map((s) => ({
      id: 'r:' + s.id, group: 'Reading list', label: s.title, icon: 'ph-bookmark-simple', sub: s.source || host(s.url), words: `${s.url} saved read later`,
      onlyWhenTyping: true,
      run: () => window.open(s.url, '_blank', 'noopener'),
    })),
  ];
}

/** Items for what's typed: a quick log when it reads as one, then the web searches. */
export function paletteSearches(c: PaletteContext, q: string): PaletteItem[] {
  const { data, now, courseName } = c;
  const kg = parseWeight(q);
  const log: PaletteItem[] = kg === null ? [] : [{
    id: 'a:weight-now', group: 'Actions', label: `Log ${fmtKg(kg)} kg for today`, icon: 'ph-scales', first: true,
    sub: data.weights[ymd(now)] ? `Replaces ${fmtKg(data.weights[ymd(now)])} kg` : 'Body weight, in Training',
    run: () => c.setWeight(ymd(now), kg, true),
  }];
  const study = parseStudy(q, data.learn.courses);
  if (study) {
    log.push({
      id: 'a:study-now', group: 'Actions', label: `Log ${fmtStudy(study.minutes)} of ${courseName(study.courseId)}`, icon: 'ph-timer', first: true,
      sub: 'Study time, in Learn',
      run: () => c.logStudy(study.minutes, study.courseId),
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
}
