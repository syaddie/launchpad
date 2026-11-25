// What ⌘K offers: actions, views, panels to show or hide, and for what's typed, quick logs
// ("weight 72.4", "study 45 cs210") and web searches.
import { askable, type AskAction } from '../../shared/ask';
import { parseEvent, ymd, type EventDraft } from '../../shared/dates';
import { fmtStudy, parseStudy, timerMinutes } from '../../shared/learn';
import { fmtKg, parseWeight } from '../../shared/training';
import { engineUrl, fmtDuration, moodWord, parseSearch } from '../../shared/trackers';
import type { AppState, Countdown, DesignKey, Mood, MoneyEntry, Prefs, ViewKey } from '../../shared/types';
import { api } from './api';
import { canAddEvents, defaultCalendar, describeDraft } from './components/AddEvent';
import { DESIGNS, PANEL_ROWS } from './components/Drawers';
import type { PaletteAsk, PaletteItem } from './components/Palette';
import { VIEWS } from './components/Rail';
import type { ServerTab } from './components/Server';
import { host, newId } from './util';

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
  addEvent: (calendarId: string, d: EventDraft) => Promise<boolean>;
  /** Put the cursor in Today's add-an-event field; missing when that panel isn't on screen. */
  openAddEvent?: () => void;
  refreshInbox: () => void;
  /** Digest › Archive, or the reading list kept from the old News view. */
  openDigestTab: (tab: 'archive' | 'reading') => void;
  /** Show a notepad on home. */
  openNote: (id: string) => void;
  showShortcuts: () => void;
  openSettings: () => void;
  toggleHidden: (key: string) => void;
  /** What Ask Launchpad's actions save through (the same calls the views make). */
  ask: AskHandlers;
}

export interface AskHandlers {
  addMoney: (entry: MoneyEntry) => void;
  addCountdown: (c: Countdown) => void;
  setMood: (date: string, mood: Mood) => void;
  notify: (msg: string) => void;
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
    { id: 'a:mood', group: 'Actions', label: 'Log today’s mood', icon: 'ph-smiley', keys: ['M'], sub: moodWord(todayMood) ? `Today: ${moodWord(todayMood)}` : 'Not logged yet today', run: () => setView('you') },
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
    { id: 'a:minecraft', group: 'Actions', label: 'Open the Minecraft console', icon: 'ph-cube', words: 'minecraft server console rcon players tmux screen game', run: () => c.openServerTab('minecraft') },
    { id: 'a:downloads', group: 'Actions', label: 'Download to the server', icon: 'ph-download-simple', words: 'download link url wget curl torrent magnet qbittorrent instagram ig insta reel post profile photos videos instaloader', run: () => c.openServerTab('downloads') },
    ...(c.openAddEvent && eventsOn(data)
      ? [{ id: 'a:event', group: 'Actions', label: 'Add a calendar event', icon: 'ph-calendar-plus', words: 'google calendar meeting appointment schedule', sub: 'Or type “event”, then what and when', run: c.openAddEvent }]
      : []),
    { id: 'a:lessons', group: 'Actions', label: 'Search past lessons', icon: 'ph-lightbulb', words: 'digest learn archive concepts starred', run: () => c.openDigestTab('archive') },
    { id: 'a:slots', group: 'Actions', label: 'Find a free busking slot', icon: 'ph-music-notes', words: 'music nac busk busking slot slots book booking free tampines pasir ris paya lebar changi village', run: () => setView('music') },
    ...readingItems(c),
    // Notepads by name, tag or anything in them, once something's typed.
    ...data.notes.map((n) => ({
      id: 'n:' + n.id, group: 'Notepad', label: n.name || 'Untitled', icon: 'ph-notebook', onlyWhenTyping: true,
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
  ];
}

/** The reading list, and each story on it (those once something's typed). */
function readingItems(c: PaletteContext): PaletteItem[] {
  const toRead = (c.data.newsLists?.saved ?? []).filter((s) => !s.readAt);
  // Nothing new can be saved since News became the digest, so it's only offered while it holds something.
  if (!c.data.newsLists?.saved.length) return [];
  return [
    {
      id: 'a:reading', group: 'Actions', label: 'Open the reading list', icon: 'ph-bookmark-simple', words: 'news saved later read stories',
      sub: toRead.length ? `${toRead.length} to read` : 'All read',
      run: () => c.openDigestTab('reading'),
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
  // "event lunch w/ Dan fri 1pm", or anything with a time in it, can go straight into the calendar.
  const cal = eventsOn(data) ? defaultCalendar(data) : undefined;
  const asked = q.match(/^(?:add |new )?event\s+(.+)/i);
  const draft = cal && (asked ? parseEvent(asked[1], now) : parseEvent(q, now));
  if (cal && draft?.title && (asked || (draft.understood && !draft.allDay))) {
    log.push({
      id: 'a:event-now', group: 'Actions', label: `Add “${draft.title}” to ${cal.name}`, icon: 'ph-calendar-plus', first: !!asked,
      sub: describeDraft(draft),
      run: () => void c.addEvent(cal.id, draft),
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

// ---------- Ask Launchpad ----------

/** Do what the preview said. The server checked the action; this checks it still fits what's here. */
export function runAskAction(c: PaletteContext, a: AskAction): void {
  const { data } = c;
  const gone = (what: string) => c.ask.notify(`Couldn’t do that: the ${what} isn’t there any more.`);
  switch (a.type) {
    case 'money':
      if (!data.money.accounts.some((x) => x.id === a.account)) return gone('account');
      return c.ask.addMoney({ id: newId('e'), date: a.date, kind: a.kind, amount: a.amount, note: a.note, category: a.category, planned: a.date > ymd(new Date()), account: a.account, to: '' });
    // Tasks and Bookmarks were retired (2026-11-25); the server no longer offers either.
    case 'task':
    case 'bookmark':
      return c.ask.notify('Couldn’t do that: Tasks and Bookmarks are no longer part of Launchpad.');
    case 'weight':
      return c.setWeight(a.date, a.kg, true);
    case 'smoke':
      return c.logSmoke();
    case 'study':
      if (!data.learn.courses.some((x) => x.id === a.courseId)) return gone('course');
      return c.logStudy(a.minutes, a.courseId);
    case 'countdown':
      return c.ask.addCountdown({ id: newId('c'), title: a.title, date: a.date, yearly: a.yearly, createdAt: new Date().toISOString() });
    case 'mood': {
      // The note is the day's journal entry: what was typed goes at its end rather than replacing it.
      const entry = data.moods[a.date]?.note?.trimEnd() ?? '';
      return c.ask.setMood(a.date, { level: a.level, note: a.note ? (entry ? `${entry}\n${a.note}` : a.note) : entry });
    }
  }
}

/** ⌘K's Ask Launchpad, or nothing without an Anthropic API key (or while the server can't be reached). */
export function paletteAsk(c: PaletteContext, online: boolean): PaletteAsk | undefined {
  if (!c.data.newsSummaries || !online) return undefined;
  return {
    // Not for a web search with its prefix ("yt lofi").
    when: (q) => askable(q) && !parseSearch(q, c.data.prefs.searchEngines).engine,
    ask: (q) => api.ask(q).then((r) => ('error' in r ? r : { label: r.label, sub: r.sub, run: () => runAskAction(c, r.action) })),
  };
}

/** Google is connected, the calendar syncs, and the sign-in allows adding events. */
const eventsOn = (data: AppState) => data.google.connected && data.prefs.sources.calendar && canAddEvents(data);
