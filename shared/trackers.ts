// Pure helpers for countdowns, the cigarette log, moods and search engines,
// shared by the web app and the tests. Days are local calendar days.
import { addDays, dayDiff, parseYmd, startOfDay, ymd } from './dates';
import type { Countdown, Craving, CravingTrigger, Mood, SearchEngine, SmokeDays } from './types';

const DAY = 86_400_000;

// ---------- countdowns ----------

/** The date a countdown is counting to (for yearly ones, the next one from today), its distance in days and where its progress bar starts. */
export function countdownNext(c: Countdown, today: Date): { date: Date; days: number; from: Date } {
  const base = parseYmd(c.date);
  const created = startOfDay(new Date(c.createdAt));
  if (!c.yearly) return { date: base, days: dayDiff(today, base), from: created };
  let date = new Date(today.getFullYear(), base.getMonth(), base.getDate());
  if (dayDiff(today, date) < 0) date = new Date(today.getFullYear() + 1, base.getMonth(), base.getDate());
  const prev = new Date(date.getFullYear() - 1, date.getMonth(), date.getDate());
  return { date, days: dayDiff(today, date), from: prev > created ? prev : created };
}

/** How far along the bar is, 0–1. */
export function countdownProgress(c: Countdown, today: Date): number {
  const { date, from } = countdownNext(c, today);
  const total = dayDiff(from, date);
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, dayDiff(from, today) / total));
}

/** Soonest first; ones that have passed go last, most recent first. */
export function sortCountdowns(list: Countdown[], today: Date): Countdown[] {
  const days = new Map(list.map((c) => [c.id, countdownNext(c, today).days]));
  return [...list].sort((a, b) => {
    const da = days.get(a.id)!;
    const db = days.get(b.id)!;
    if (da < 0 !== db < 0) return da < 0 ? 1 : -1;
    return da < 0 ? db - da : da - db;
  });
}

/** "today", "tomorrow", "in 23 days", "yesterday", "3 days ago" */
export function countdownPhrase(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

// ---------- cigarettes ----------

/** Cigarettes logged on the local day of `day`. */
export function smokesOn(smokes: string[], day: Date): Date[] {
  const start = startOfDay(day).getTime();
  const end = addDays(day, 1).getTime();
  return smokes.map((s) => new Date(s)).filter((d) => d.getTime() >= start && d.getTime() < end);
}

/** Counts for the last `n` days ending today, oldest first. */
export function dailyCounts(smokes: string[], today: Date, n: number): { date: Date; count: number }[] {
  const first = addDays(today, -(n - 1));
  const counts = new Array<number>(n).fill(0);
  for (const s of smokes) {
    const i = dayDiff(first, new Date(s));
    if (i >= 0 && i < n) counts[i]++;
  }
  return counts.map((count, i) => ({ date: addDays(first, i), count }));
}

/** The longest stretch without a cigarette in the last `days` days, counting the one still running. null without any logged. */
export function longestGapMs(smokes: string[], now: Date, days = 7): number | null {
  const since = now.getTime() - days * DAY;
  const times = smokes.map((s) => Date.parse(s)).filter((t) => t <= now.getTime()).sort((a, b) => a - b);
  if (!times.length) return null;
  const inWindow = times.filter((t) => t >= since);
  // The gap that was already running when the window opened counts from the window's start.
  const before = times.filter((t) => t < since).pop();
  const points = [before !== undefined ? since : inWindow[0] ?? since, ...inWindow, now.getTime()];
  let best = 0;
  for (let i = 1; i < points.length; i++) best = Math.max(best, points[i] - points[i - 1]);
  return best;
}

/** "45 min", "2 h 05 min", "3 d 4 h" */
export function fmtDuration(ms: number): string {
  const mins = Math.max(0, Math.floor(ms / 60_000));
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  if (h < 48) return `${h} h ${String(mins % 60).padStart(2, '0')} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// ---------- what cigarettes cost ----------

/** Days kept in full in the page's log (`smokes`); older days come as counts. */
export const SMOKE_LOG_DAYS = 60;

/** Counts a day for every cigarette before the first day the page's log covers in full. */
export function smokeDaysFrom(all: string[], now: Date): SmokeDays {
  const before = ymd(addDays(now, -(SMOKE_LOG_DAYS - 1)));
  const counts: Record<string, number> = {};
  for (const s of all) {
    const d = ymd(new Date(s));
    if (d < before) counts[d] = (counts[d] ?? 0) + 1;
  }
  return { before, counts };
}

/** Cigarettes on each day (YYYY-MM-DD): the day counts up to `days.before`, the log from then on. */
export function smokeCountMap(smokes: string[], days?: SmokeDays): Map<string, number> {
  const before = days?.before ?? '';
  const out = new Map<string, number>(Object.entries(days?.counts ?? {}).filter(([d]) => d < before));
  for (const s of smokes) {
    const d = ymd(new Date(s));
    if (d >= before) out.set(d, (out.get(d) ?? 0) + 1);
  }
  return out;
}

/** The first day with a cigarette logged, or null. */
export const firstSmokeDay = (counts: Map<string, number>): string | null => [...counts.keys()].reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);

/** Dollars a cigarette, from the pack price and size in Settings; 0 when no price is set. */
export const cigPrice = (p: { packPrice: number; packSize: number }) => (p.packPrice > 0 && p.packSize > 0 ? p.packPrice / p.packSize : 0);

const cents = (n: number) => Math.round(n * 100) / 100;

/** Cigarettes from `from` to `to` (YYYY-MM-DD, both included). */
export function smokesBetween(counts: Map<string, number>, from: string, to: string): number {
  let n = 0;
  for (const [d, c] of counts) if (d >= from && d <= to) n += c;
  return n;
}

export interface SmokeSpend {
  today: { count: number; cost: number };
  /** Since Monday. */
  week: { count: number; cost: number };
  /** Since the 1st. */
  month: { count: number; cost: number };
  /** The last 365 days, today included. */
  year: { count: number; cost: number };
}

/** What the cigarettes cost today, this week, this month and over the last year. */
export function smokeSpend(counts: Map<string, number>, today: Date, price: number): SmokeSpend {
  const t = ymd(today);
  const at = (from: Date) => {
    const count = smokesBetween(counts, ymd(from), t);
    return { count, cost: cents(count * price) };
  };
  const day = startOfDay(today);
  return {
    today: at(day),
    week: at(addDays(day, -((day.getDay() + 6) % 7))),
    month: at(new Date(day.getFullYear(), day.getMonth(), 1)),
    year: at(addDays(day, -364)),
  };
}

/**
 * What staying under the daily limit saved against smoking the limit every day: the
 * cigarettes left under it on each finished day from `from` (or the first one logged, if
 * later) to yesterday, and their price. Today doesn't count until it's over.
 */
export function savedUnderLimit(counts: Map<string, number>, today: Date, limit: number, price: number, from: string): { days: number; under: number; saved: number } {
  const first = firstSmokeDay(counts);
  if (limit <= 0 || !first) return { days: 0, under: 0, saved: 0 };
  const end = addDays(startOfDay(today), -1);
  let days = 0;
  let under = 0;
  for (let d = parseYmd(first > from ? first : from); d <= end && days < 4000; d = addDays(d, 1)) {
    days++;
    under += Math.max(0, limit - (counts.get(ymd(d)) ?? 0));
  }
  return { days, under, saved: cents(under * price) };
}

// ---------- cravings ----------

export const CRAVING_TRIGGERS: { key: CravingTrigger; name: string }[] = [
  { key: 'stress', name: 'Stress' },
  { key: 'coffee', name: 'Coffee' },
  { key: 'meal', name: 'After meals' },
  { key: 'social', name: 'Social' },
  { key: 'boredom', name: 'Boredom' },
  { key: 'alcohol', name: 'Alcohol' },
  { key: 'waking', name: 'Waking up' },
  { key: 'other', name: 'Other' },
];

export const triggerName = (t: CravingTrigger | '') => CRAVING_TRIGGERS.find((x) => x.key === t)?.name ?? '';

/** 1 Mild · 2 Medium · 3 Strong. */
export const STRENGTH_WORDS = ['Mild', 'Medium', 'Strong'];

export const MAX_CRAVINGS = 10_000;

/** One craving from the page or a backup, or null when it isn't one. */
export function cleanCraving(v: unknown, now = Date.now()): Craving | null {
  const c = (v && typeof v === 'object' ? v : {}) as Partial<Craving>;
  if (typeof c.id !== 'string' || !c.id.trim() || typeof c.at !== 'string' || Number.isNaN(Date.parse(c.at)) || Date.parse(c.at) > now + 60_000) return null;
  return {
    id: c.id.trim().slice(0, 40),
    at: new Date(c.at).toISOString(),
    strength: c.strength === 1 || c.strength === 3 ? c.strength : 2,
    trigger: CRAVING_TRIGGERS.some((t) => t.key === c.trigger) ? c.trigger! : '',
    note: typeof c.note === 'string' ? c.note.trim().slice(0, 500) : '',
  };
}

/** Oldest first, one per id. */
export function cleanCravings(v: unknown, now = Date.now()): Craving[] {
  const byId = new Map<string, Craving>();
  for (const x of Array.isArray(v) ? v : []) {
    const c = cleanCraving(x, now);
    if (c) byId.set(c.id, c);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-MAX_CRAVINGS);
}

/** ⌘K: "craving", "craving 3", "craving stress", "urge 1 coffee" → its strength and trigger. */
export function parseCraving(q: string): { strength: 1 | 2 | 3; trigger: CravingTrigger | '' } | null {
  const m = q.trim().toLowerCase().match(/^(?:log\s+)?(?:a\s+)?(?:craving|crave|urge)(?:\s+([123]))?(?:\s+(.+))?$/);
  if (!m) return null;
  const word = (m[2] ?? '').trim();
  const trigger = word ? CRAVING_TRIGGERS.find((t) => t.key === word || t.name.toLowerCase().startsWith(word) || t.name.toLowerCase().split(' ').includes(word)) : undefined;
  if (word && !trigger) return null;
  return { strength: m[1] ? (Number(m[1]) as 1 | 2 | 3) : 2, trigger: trigger?.key ?? '' };
}

/** Cravings on the local day of `day`. */
export function cravingsOn(cravings: Craving[], day: Date): Craving[] {
  const d = ymd(day);
  return cravings.filter((c) => ymd(new Date(c.at)) === d);
}

export interface CravingSummary {
  resisted: number;
  smoked: number;
  /** Oldest first, one row per day. */
  byDay: { date: string; resisted: number; smoked: number }[];
  /** Most first; cravings with no trigger aren't counted. */
  triggers: { trigger: CravingTrigger; count: number }[];
}

/** Cravings resisted against cigarettes smoked over the last `days` days, today included, and what set them off. */
export function cravingSummary(cravings: Craving[], counts: Map<string, number>, today: Date, days: number): CravingSummary {
  const first = addDays(startOfDay(today), -(days - 1));
  const byDay = Array.from({ length: days }, (_, i) => {
    const date = ymd(addDays(first, i));
    return { date, resisted: 0, smoked: counts.get(date) ?? 0 };
  });
  const index = new Map(byDay.map((d, i) => [d.date, i]));
  const triggers = new Map<CravingTrigger, number>();
  for (const c of cravings) {
    const i = index.get(ymd(new Date(c.at)));
    if (i === undefined) continue;
    byDay[i].resisted++;
    if (c.trigger) triggers.set(c.trigger, (triggers.get(c.trigger) ?? 0) + 1);
  }
  const order = (t: CravingTrigger) => CRAVING_TRIGGERS.findIndex((x) => x.key === t);
  return {
    resisted: byDay.reduce((a, d) => a + d.resisted, 0),
    smoked: byDay.reduce((a, d) => a + d.smoked, 0),
    byDay,
    triggers: [...triggers].map(([trigger, count]) => ({ trigger, count })).sort((a, b) => b.count - a.count || order(a.trigger) - order(b.trigger)),
  };
}

// ---------- mood and journal ----------

export const MOOD_WORDS = ['Rough', 'Low', 'Okay', 'Good', 'Great'];

/** The longest journal entry kept for a day. */
export const MAX_JOURNAL = 20_000;

/** The day's mood word, or '' for a day with only a journal entry. */
export const moodWord = (m: Mood | undefined) => (m && m.level >= 1 ? MOOD_WORDS[m.level - 1] : '');

/** Journal entries holding every word of `q` (ignoring case), newest first, with a line around the first match. */
export function searchJournal(moods: Record<string, Mood>, q: string, limit = 50): { date: string; level: number; snippet: string }[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: { date: string; level: number; snippet: string }[] = [];
  for (const date of Object.keys(moods).sort().reverse()) {
    const text = moods[date].note ?? '';
    const low = text.toLowerCase();
    if (!text || !words.every((w) => low.includes(w))) continue;
    const at = low.indexOf(words[0]);
    const from = Math.max(0, at - 50);
    const flat = text.slice(from, at + 90).replace(/\s+/g, ' ').trim();
    out.push({ date, level: moods[date].level, snippet: (from > 0 ? '…' : '') + flat + (at + 90 < text.length ? '…' : '') });
    if (out.length >= limit) break;
  }
  return out;
}

/** A year's average mood, the days rated, and the days with a journal entry. */
export function moodYear(moods: Record<string, Mood>, year: number): { avg: number | null; logged: number; written: number } {
  const days = Object.entries(moods).filter(([d]) => d.startsWith(`${year}-`));
  const levels = days.filter(([, m]) => m.level >= 1).map(([, m]) => m.level);
  return { avg: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null, logged: levels.length, written: days.filter(([, m]) => (m.note ?? '').trim()).length };
}

/** Average and number of days logged in a month (month 0–11). */
export function moodMonth(moods: Record<string, Mood>, year: number, month: number): { avg: number | null; logged: number } {
  const prefix = `${year}-${String(month + 1).padStart(2, '0')}-`;
  const levels = Object.entries(moods).filter(([d, m]) => d.startsWith(prefix) && m.level >= 1).map(([, m]) => m.level);
  return { avg: levels.length ? levels.reduce((a, b) => a + b, 0) / levels.length : null, logged: levels.length };
}

// ---------- search ----------

/** "yt lofi beats" → YouTube and "lofi beats"; anything else searches with no engine picked. */
export function parseSearch(q: string, engines: SearchEngine[]): { engine: SearchEngine | null; term: string } {
  const m = q.trim().match(/^(\S+)\s+(.+)$/);
  const engine = m ? engines.find((e) => e.prefix.toLowerCase() === m[1].toLowerCase()) : undefined;
  return engine ? { engine, term: m![2].trim() } : { engine: null, term: q.trim() };
}

export function engineUrl(e: SearchEngine, term: string): string {
  const t = encodeURIComponent(term);
  return e.url.includes('%s') ? e.url.replace('%s', t) : e.url + t;
}

/** Nearest upcoming countdown for the line under the greeting: "Japan in 23 days". */
export function nearestCountdown(list: Countdown[], now: Date): string {
  const today = startOfDay(now);
  const next = sortCountdowns(list, today)[0];
  if (!next) return '';
  const { days } = countdownNext(next, today);
  return days >= 0 ? `${next.title} ${countdownPhrase(days)}` : '';
}
