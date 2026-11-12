// The Review view's numbers for one week, Monday to Sunday, from every module. Pure, so the
// page and the server's Sunday note read the same numbers.
import { addDays, startOfDay, ymd } from './dates';
import { balanceOn } from './money';
import { weekStart, weekSummary, weightAvgOn } from './training';
import { cigPrice, smokesBetween } from './trackers';
import type { Craving, CravingTrigger, Learn, Money, Mood, Prefs, Workout } from './types';

export interface ReviewInput {
  workouts: Workout[];
  weights: Record<string, number>;
  /** Cigarettes a day, by YYYY-MM-DD (smokeCountMap in trackers.ts). */
  smokes: Map<string, number>;
  cravings: Craving[];
  moods: Record<string, Mood>;
  learn: Learn;
  money: Money;
  prefs: Pick<Prefs, 'cigaretteLimit' | 'packPrice' | 'packSize'>;
  /** Packages delivered, with when. */
  delivered: { label: string; at: string }[];
  /** Google Tasks ticked off in the week; null when it isn't known (Google not connected, or no answer yet). */
  tasksDone: number | null;
}

export interface WeekReview {
  /** Monday and Sunday, YYYY-MM-DD. */
  start: string;
  end: string;
  /** Days of the week gone so far, today included: 7 once it's over. */
  daysIn: number;
  training: { sessions: number; minutes: number; sets: number; volume: number; prevSessions: number; prevVolume: number };
  /** The 7-day average at the end of the week (or today), and how it moved since the end of the week before. */
  weight: { avg: number | null; change: number | null };
  cigarettes: { count: number; perDay: number; limit: number; daysOver: number; cost: number | null; prevCount: number };
  cravings: { resisted: number; strong: number; topTrigger: CravingTrigger | null };
  /** Average of the days rated, and the days with a journal entry. */
  mood: { avg: number | null; logged: number; written: number };
  study: {
    minutes: number;
    /** Courses studied, most first; '' is study that isn't for one course. */
    courses: { id: string; name: string; minutes: number; goal: number }[];
    /** Work due in the week up to today: handed in, and still open. */
    met: number;
    late: string[];
    /** Work due later this week, not handed in yet. */
    ahead: number;
  };
  /** Money in and out of the day-to-day accounts, the balance at the end of the week from what's done, and the forecast for it. Null before money is tracked. */
  money: { in: number; out: number; closing: number; forecast: number } | null;
  tasks: number | null;
  packages: string[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

/** Done money in and out of the spendable accounts between two days, counted the way the month's balances count it. */
function moneyFlow(money: Money, from: string, to: string): { in: number; out: number } {
  const spend = new Set(money.accounts.filter((a) => a.spendable).map((a) => a.id));
  let inn = 0;
  let out = 0;
  for (const e of money.entries) {
    if (e.planned || e.date < from || e.date > to) continue;
    const fromSpend = spend.has(e.account);
    if (e.kind === 'in' && fromSpend) inn += e.amount;
    else if (e.kind === 'out' && fromSpend) out += e.amount;
    else if (e.kind === 'move' && fromSpend !== spend.has(e.to)) {
      if (fromSpend) out += e.amount;
      else inn += e.amount;
    }
  }
  return { in: cents(inn), out: cents(out) };
}

/** Everything the Review shows for the week `day` is in, as of `now`. */
export function weekReview(input: ReviewInput, day: Date, now: Date): WeekReview {
  const mon = weekStart(day);
  const sun = addDays(mon, 6);
  const today = startOfDay(now);
  const last = sun < today ? sun : today;
  const start = ymd(mon);
  const end = ymd(sun);
  const upTo = ymd(last);
  const daysIn = Math.max(0, Math.min(7, Math.round((last.getTime() - mon.getTime()) / 86_400_000) + 1));
  const inWeek = (iso: string) => {
    const d = ymd(new Date(iso));
    return d >= start && d <= end;
  };

  const week = weekSummary(input.workouts, mon);
  const prev = weekSummary(input.workouts, addDays(mon, -7));

  const avg = weightAvgOn(input.weights, upTo);
  const before = weightAvgOn(input.weights, ymd(addDays(mon, -1)));

  const { cigaretteLimit: limit } = input.prefs;
  const count = smokesBetween(input.smokes, start, upTo);
  let daysOver = 0;
  for (let i = 0; i < daysIn; i++) if (limit > 0 && (input.smokes.get(ymd(addDays(mon, i))) ?? 0) > limit) daysOver++;
  const price = cigPrice(input.prefs);

  const cravings = input.cravings.filter((c) => inWeek(c.at));
  const triggers = new Map<CravingTrigger, number>();
  for (const c of cravings) if (c.trigger) triggers.set(c.trigger, (triggers.get(c.trigger) ?? 0) + 1);
  const topTrigger = [...triggers].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const moods = Object.entries(input.moods).filter(([d]) => d >= start && d <= end);
  const levels = moods.filter(([, m]) => m.level >= 1).map(([, m]) => m.level);

  const names = new Map(input.learn.courses.map((c) => [c.id, c]));
  const byCourse = new Map<string, number>();
  for (const s of input.learn.sessions) if (inWeek(s.start)) byCourse.set(s.courseId, (byCourse.get(s.courseId) ?? 0) + s.minutes);
  const due = input.learn.assessments.filter((a) => a.due >= start && a.due <= end);
  const past = due.filter((a) => a.due <= upTo);

  const tracked = input.money.entries.length > 0;
  const flowed = moneyFlow(input.money, start, end);

  return {
    start,
    end,
    daysIn,
    training: { sessions: week.sessions, minutes: week.minutes, sets: week.sets, volume: Math.round(week.volume), prevSessions: prev.sessions, prevVolume: Math.round(prev.volume) },
    weight: { avg, change: avg !== null && before !== null ? Math.round((avg - before) * 100) / 100 : null },
    cigarettes: {
      count,
      perDay: daysIn ? Math.round((count / daysIn) * 10) / 10 : 0,
      limit,
      daysOver,
      cost: price > 0 ? cents(count * price) : null,
      prevCount: smokesBetween(input.smokes, ymd(addDays(mon, -7)), ymd(addDays(mon, -1))),
    },
    cravings: { resisted: cravings.length, strong: cravings.filter((c) => c.strength === 3).length, topTrigger },
    mood: { avg: levels.length ? Math.round((levels.reduce((a, b) => a + b, 0) / levels.length) * 10) / 10 : null, logged: levels.length, written: moods.filter(([, m]) => (m.note ?? '').trim()).length },
    study: {
      minutes: Math.round([...byCourse.values()].reduce((a, b) => a + b, 0)),
      courses: [...byCourse]
        .map(([id, minutes]) => ({ id, name: id ? names.get(id)?.code || names.get(id)?.name || 'A removed course' : 'General study', minutes: Math.round(minutes), goal: names.get(id)?.goalMin ?? 0 }))
        .sort((a, b) => b.minutes - a.minutes),
      met: past.filter((a) => a.status === 'done').length,
      late: past.filter((a) => a.status !== 'done').map((a) => a.title),
      ahead: due.filter((a) => a.due > upTo && a.status !== 'done').length,
    },
    money: tracked ? { ...flowed, closing: balanceOn(input.money, upTo, true), forecast: balanceOn(input.money, end) } : null,
    tasks: input.tasksDone,
    packages: input.delivered.filter((p) => inWeek(p.at)).map((p) => p.label),
  };
}
