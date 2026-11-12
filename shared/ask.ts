// ⌘K's "Ask Launchpad": Claude turns what's typed ("spent 12 on lunch") into one action
// from a fixed list, by calling one of these tools. The server checks what comes back
// against the rules here before the palette shows it; nothing runs until Enter.
import { DOW, MON, dayDiff, parseYmd, startOfDay, ymd } from './dates';
import { MAX_SESSION_MIN, fmtStudy } from './learn';
import { CATEGORIES, fmtMoney } from './money';
import { MAX_KG, MIN_KG, fmtKg } from './training';
import { MOOD_WORDS } from './trackers';
import type { MoneyCategory } from './types';

/** What Claude may refer to: today's date and the names it can pick from. Nothing else is sent. */
export interface AskContext {
  /** YYYY-MM-DD. */
  today: string;
  accounts: { id: string; name: string }[];
  /** The account an entry goes to when none is named. */
  mainAccount: string;
  /** Empty when Google Tasks isn't connected. */
  taskLists: { id: string; title: string }[];
  courses: { id: string; code: string; name: string }[];
  bookmarkGroups: { id: string; name: string }[];
}

export type AskAction =
  | { type: 'money'; kind: 'in' | 'out'; amount: number; category: MoneyCategory | ''; note: string; date: string; account: string }
  | { type: 'task'; title: string; due: string | null; listId: string }
  | { type: 'weight'; kg: number; date: string }
  | { type: 'smoke' }
  | { type: 'study'; minutes: number; courseId: string }
  | { type: 'countdown'; title: string; date: string; yearly: boolean }
  | { type: 'bookmark'; name: string; url: string; groupId: string }
  | { type: 'mood'; level: number; note: string; date: string };

/** A tool as the Claude API takes it. */
export interface AskTool {
  name: string;
  description: string;
  strict: true;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false };
}

const obj = (properties: Record<string, unknown>): AskTool['input_schema'] => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = (description: string) => ({ type: 'string', description });
const DATE = 'YYYY-MM-DD';

/** The tools Claude can pick from, given what exists (no task tool without task lists, and so on). */
export function askTools(c: AskContext): AskTool[] {
  const tools: AskTool[] = [];
  const tool = (name: string, description: string, properties: Record<string, unknown>) => tools.push({ name, description, strict: true, input_schema: obj(properties) });
  if (c.accounts.length) {
    tool('add_money', 'Record money spent or received in the Money tracker: buying, paying, spending, getting paid, a refund, a tip.', {
      kind: { type: 'string', enum: ['out', 'in'], description: 'out for spending or paying, in for money received' },
      amount: { type: 'number', description: 'In dollars, more than 0' },
      category: { type: 'string', enum: [...CATEGORIES, ''], description: 'The closest category, or empty when none fits' },
      note: str('A few words on what it was for, e.g. "lunch"; empty if nothing was said'),
      date: str(`${DATE}; today unless a day is given`),
      account: { type: 'string', enum: c.accounts.map((a) => a.id), description: `The account named, else ${c.mainAccount}. ${c.accounts.map((a) => `${a.id} is ${a.name}`).join('; ')}` },
    });
  }
  if (c.taskLists.length) {
    tool('add_task', 'Add a to-do or reminder to Google Tasks.', {
      title: str('The task, short and in their words, without the date'),
      due: str(`${DATE}, or empty when no day is given`),
      list: { type: 'string', enum: c.taskLists.map((l) => l.id), description: `The list named, else ${c.taskLists[0].id}. ${c.taskLists.map((l) => `${l.id} is ${l.title}`).join('; ')}` },
    });
  }
  tool('log_weight', 'Log body weight.', { kg: { type: 'number', description: 'Kilograms' }, date: str(`${DATE}; today unless a day is given`) });
  tool('log_cigarette', 'Log one cigarette smoked just now.', {});
  if (c.courses.length) {
    tool('log_study', 'Log time already spent studying a course.', {
      minutes: { type: 'integer', description: 'Minutes studied' },
      course: { type: 'string', enum: c.courses.map((x) => x.id), description: c.courses.map((x) => `${x.id} is ${[x.code, x.name].filter(Boolean).join(' ')}`).join('; ') },
    });
  }
  tool('add_countdown', 'Add a countdown to a date: a trip, a birthday, an event.', {
    title: str('What it counts down to, e.g. "Japan trip"'),
    date: str(`${DATE}; the next time that date comes round`),
    yearly: { type: 'boolean', description: 'true for something every year, like a birthday or anniversary' },
  });
  if (c.bookmarkGroups.length) {
    tool('add_bookmark', 'Add a web page to the bookmarks.', {
      name: str('A short name for the tile'),
      url: str('The full address, starting https://'),
      group: { type: 'string', enum: c.bookmarkGroups.map((g) => g.id), description: `The group named, else ${c.bookmarkGroups[0].id}. ${c.bookmarkGroups.map((g) => `${g.id} is ${g.name}`).join('; ')}` },
    });
  }
  tool('log_mood', 'Log how the day is going, from 1 (rough) to 5 (great).', {
    level: { type: 'integer', enum: [1, 2, 3, 4, 5], description: '1 rough, 2 low, 3 okay, 4 good, 5 great' },
    note: str('Their words about the day, if any; empty otherwise'),
    date: str(`${DATE}; today unless a day is given`),
  });
  return tools;
}

/** The system prompt: today's date and how to read what's typed. */
export function askSystem(c: AskContext): string {
  const today = parseYmd(c.today);
  return `You turn what someone typed into their dashboard's command box into one action, by calling exactly one of the tools. Today is ${DOW[today.getDay()]} ${today.getDate()} ${MON[today.getMonth()]} ${today.getFullYear()} (${c.today}); weeks start on Monday.

Work out dates from what's typed: "today", "tomorrow", "fri" (the next Friday, today included), "the 1st" (the next 1st of a month, today included), "3 Mar" (the next 3 March). Amounts are in dollars. Keep titles and notes in their words, short, without the date or amount.

If nothing they typed fits a tool, or it's a question rather than something to record, don't call a tool: answer in one short sentence with what you can do instead.`;
}

// ---------- checking what Claude sent ----------

/** What the server sends back for what's typed: the action and how to say it, or why there isn't one. */
export type AskResult = { action: AskAction; label: string; sub: string } | { error: string };

export type Checked = { ok: true; action: AskAction } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');

/** A real YYYY-MM-DD within five years of today, or null. */
function date(v: unknown, today: string): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = parseYmd(v);
  if (ymd(d) !== v) return null;
  return Math.abs(dayDiff(parseYmd(today), d)) <= 5 * 366 ? v : null;
}

function url(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Claude's tool call as an action, if it keeps to the rules; otherwise what's wrong with it. */
export function checkAction(name: string, input: unknown, c: AskContext): Checked {
  const bad = (error: string): Checked => ({ ok: false, error });
  const ok = (action: AskAction): Checked => ({ ok: true, action });
  const i = isObj(input) ? input : {};
  switch (name) {
    case 'add_money': {
      const amount = typeof i.amount === 'number' && Number.isFinite(i.amount) ? Math.round(Math.abs(i.amount) * 100) / 100 : 0;
      if (!(amount > 0) || amount > 1_000_000) return bad('That amount doesn’t look right.');
      if (i.kind !== 'in' && i.kind !== 'out') return bad('It wasn’t clear whether that’s money in or out.');
      const d = date(i.date, c.today);
      if (!d) return bad('That date doesn’t look right.');
      const account = c.accounts.some((a) => a.id === i.account) ? (i.account as string) : c.mainAccount;
      if (!c.accounts.some((a) => a.id === account)) return bad('There’s no account to add it to yet. Set one up in Money.');
      const category = (CATEGORIES as string[]).includes(i.category as string) ? (i.category as MoneyCategory) : '';
      return ok({ type: 'money', kind: i.kind, amount, category, note: text(i.note, 120), date: d, account });
    }
    case 'add_task': {
      const title = text(i.title, 200);
      if (!title) return bad('The task had no title.');
      if (!c.taskLists.length) return bad('Connect Google to add tasks.');
      const due = i.due === '' || i.due === null || i.due === undefined ? null : date(i.due, c.today);
      if (due === null && i.due) return bad('That due date doesn’t look right.');
      const listId = c.taskLists.some((l) => l.id === i.list) ? (i.list as string) : c.taskLists[0].id;
      return ok({ type: 'task', title, due, listId });
    }
    case 'log_weight': {
      const kg = typeof i.kg === 'number' && Number.isFinite(i.kg) ? Math.round(i.kg * 10) / 10 : 0;
      if (kg < MIN_KG || kg > MAX_KG) return bad(`Weight has to be between ${MIN_KG} and ${MAX_KG} kg.`);
      const d = date(i.date, c.today);
      if (!d || d > c.today) return bad('That date doesn’t look right.');
      return ok({ type: 'weight', kg, date: d });
    }
    case 'log_cigarette':
      return ok({ type: 'smoke' });
    case 'log_study': {
      const minutes = typeof i.minutes === 'number' && Number.isFinite(i.minutes) ? Math.round(i.minutes) : 0;
      if (minutes < 1 || minutes > MAX_SESSION_MIN) return bad(`Study time has to be between 1 minute and ${MAX_SESSION_MIN / 60} hours.`);
      if (!c.courses.some((x) => x.id === i.course)) return bad('Which course was that? Name it by its code.');
      return ok({ type: 'study', minutes, courseId: i.course as string });
    }
    case 'add_countdown': {
      const title = text(i.title, 60);
      if (!title) return bad('The countdown had no name.');
      const d = date(i.date, c.today);
      if (!d) return bad('That date doesn’t look right.');
      return ok({ type: 'countdown', title, date: d, yearly: i.yearly === true });
    }
    case 'add_bookmark': {
      const u = url(i.url);
      if (!u) return bad('That web address doesn’t look right.');
      if (!c.bookmarkGroups.length) return bad('Add a bookmark group first.');
      const groupId = c.bookmarkGroups.some((g) => g.id === i.group) ? (i.group as string) : c.bookmarkGroups[0].id;
      return ok({ type: 'bookmark', name: text(i.name, 60) || new URL(u).hostname.replace(/^www\./, ''), url: u, groupId });
    }
    case 'log_mood': {
      const level = typeof i.level === 'number' ? Math.round(i.level) : 0;
      if (level < 1 || level > 5) return bad('Mood goes from 1 to 5.');
      const d = date(i.date, c.today);
      if (!d || d > c.today) return bad('That date doesn’t look right.');
      return ok({ type: 'mood', level, note: text(i.note, 280), date: d });
    }
    default:
      return bad('Claude picked something Launchpad can’t do.');
  }
}

// ---------- saying what will happen ----------

/** "today", "tomorrow", "yesterday", "Fri 13 Nov", or with the year when it isn't this one. */
export function dayPhrase(d: string, today: string): string {
  const t = parseYmd(today);
  const x = parseYmd(d);
  const diff = dayDiff(t, x);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return `${DOW[x.getDay()]} ${x.getDate()} ${MON[x.getMonth()]}${x.getFullYear() !== t.getFullYear() ? ` ${x.getFullYear()}` : ''}`;
}

/** Exactly what Enter will do, e.g. "Add $12 out, Food, today", with the detail underneath. */
export function describeAction(a: AskAction, c: AskContext): { label: string; sub: string } {
  const on = (d: string) => dayPhrase(d, c.today);
  switch (a.type) {
    case 'money': {
      const account = c.accounts.find((x) => x.id === a.account)?.name ?? 'Money';
      const planned = a.date > c.today;
      return {
        label: `Add ${fmtMoney(a.amount)} ${a.kind}${a.category ? `, ${a.category}` : ''}, ${on(a.date)}`,
        sub: [a.note && `“${a.note}”`, account, planned ? 'planned' : 'done'].filter(Boolean).join(' · '),
      };
    }
    case 'task':
      return { label: `Add task “${a.title}”${a.due ? `, due ${on(a.due)}` : ''}`, sub: `Google Tasks · ${c.taskLists.find((l) => l.id === a.listId)?.title ?? 'Tasks'}` };
    case 'weight':
      return { label: `Log ${fmtKg(a.kg)} kg for ${on(a.date)}`, sub: 'Body weight, in Training' };
    case 'smoke':
      return { label: 'Log a cigarette', sub: 'Now, in You' };
    case 'study': {
      const course = c.courses.find((x) => x.id === a.courseId);
      return { label: `Log ${fmtStudy(a.minutes)} of ${course?.code || course?.name || 'study'}`, sub: 'Study time, in Learn, ending now' };
    }
    case 'countdown': {
      const d = parseYmd(a.date);
      const days = dayDiff(startOfDay(parseYmd(c.today)), d);
      return { label: `Add countdown “${a.title}” to ${on(a.date)}`, sub: `${a.yearly ? 'Every year' : 'One-off'} · ${days >= 0 ? `${days} day${days === 1 ? '' : 's'} away` : 'already passed'}` };
    }
    case 'bookmark':
      return { label: `Add bookmark “${a.name}” to ${c.bookmarkGroups.find((g) => g.id === a.groupId)?.name ?? 'Bookmarks'}`, sub: a.url.replace(/^https?:\/\//, '').replace(/\/$/, '') };
    case 'mood':
      return { label: `Log ${on(a.date) === 'today' ? 'today’s' : `${on(a.date)}’s`} mood: ${MOOD_WORDS[a.level - 1]}`, sub: a.note ? `“${a.note}”` : 'In You' };
  }
}

/** Whether what's typed is worth asking Claude about: a few words, not a single command word. */
export const askable = (q: string) => q.trim().length >= 6 && /\s/.test(q.trim());
