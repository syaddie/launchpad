// Pure helpers for countdowns, the cigarette log, moods and search engines,
// shared by the web app and the tests. Days are local calendar days.
import { addDays, dayDiff, parseYmd, startOfDay } from './dates';
import type { Countdown, Mood, SearchEngine } from './types';

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

// ---------- mood ----------

export const MOOD_WORDS = ['Rough', 'Low', 'Okay', 'Good', 'Great'];

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
