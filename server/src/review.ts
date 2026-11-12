// The weekly Review: tasks ticked off in Google Tasks for a week (the page asks for them),
// and Claude's short recap of the week's numbers, written every Sunday evening (or on
// refresh) and only with ANTHROPIC_API_KEY. The numbers themselves are in shared/review.ts.
import { askJson, claudeEnabled } from './claude';
import { config, googleConfigured } from './config';
import { countCompletedTasks } from './google';
import { asServer, store } from './store';
import { DOW, MON, addDays, parseYmd, ymd } from '../../shared/dates';
import { fmtStudy } from '../../shared/learn';
import { fmtMoney } from '../../shared/money';
import { weekReview, type WeekReview } from '../../shared/review';
import { smokeCountMap, triggerName } from '../../shared/trackers';
import { fmtKg, fmtMinutes, weekStart } from '../../shared/training';
import type { ReviewNote } from '../../shared/types';

const MIN = 60_000;

// ---------- tasks ----------

const tasksCache = new Map<string, { at: number; n: number | null }>();

/** Tasks ticked off in the week starting `monday` (YYYY-MM-DD); null when Google isn't connected or doesn't answer. */
export async function tasksDoneIn(monday: string): Promise<number | null> {
  if (!googleConfigured() || !store.google() || !store.prefs().sources.tasks) return null;
  const hit = tasksCache.get(monday);
  if (hit && Date.now() - hit.at < 10 * MIN) return hit.n;
  const from = parseYmd(monday);
  let n: number | null;
  try {
    n = await countCompletedTasks(from.toISOString(), addDays(from, 7).toISOString());
  } catch {
    n = null;
  }
  tasksCache.set(monday, { at: Date.now(), n });
  return n;
}

// ---------- the week's numbers ----------

/** The week starting `monday`, from what's stored. */
export async function reviewOf(monday: string, now = new Date()): Promise<WeekReview> {
  return weekReview(
    {
      workouts: store.training().workouts,
      weights: store.weights(),
      smokes: smokeCountMap(store.smokes()),
      cravings: store.cravings(),
      moods: store.moods(),
      learn: store.learn(),
      money: store.money(),
      prefs: store.prefs(),
      delivered: store.packages().flatMap((p) => (p.deliveredAt ? [{ label: p.label || p.number, at: p.deliveredAt }] : [])),
      tasksDone: await tasksDoneIn(monday),
    },
    parseYmd(monday),
    now,
  );
}

const day = (s: string) => {
  const d = parseYmd(s);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
const signed = (n: number, unit: string) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtKg(Math.abs(n))}${unit}`;

/** The week as Claude reads it. Journal entries stay out: only how many days have one. */
export function reviewInput(r: WeekReview): string {
  const t = r.training;
  const c = r.cigarettes;
  const lines = [
    `Week of ${day(r.start)} to ${day(r.end)} ${r.end.slice(0, 4)}${r.daysIn < 7 ? `, ${r.daysIn} of 7 days so far` : ''}. Weeks start on Monday.`,
    `Training: ${t.sessions} session${t.sessions === 1 ? '' : 's'}${t.sessions ? `, ${fmtMinutes(t.minutes)}, ${t.sets} working sets, ${t.volume.toLocaleString('en-GB')} kg lifted` : ''} (week before: ${t.prevSessions} sessions, ${t.prevVolume.toLocaleString('en-GB')} kg).`,
    r.weight.avg !== null
      ? `Body weight: 7-day average ${fmtKg(r.weight.avg)} kg${r.weight.change !== null ? `, ${signed(r.weight.change, ' kg')} on the end of the week before` : ''}.`
      : 'Body weight: not logged.',
    `Cigarettes: ${c.count}, ${c.perDay} a day${c.limit ? `; daily limit ${c.limit}, over it on ${c.daysOver} day${c.daysOver === 1 ? '' : 's'}` : '; no daily limit set'}${c.cost !== null ? `; cost ${fmtMoney(c.cost)}` : ''} (week before: ${c.prevCount}).`,
    `Cravings logged and not acted on: ${r.cravings.resisted}${r.cravings.strong ? `, ${r.cravings.strong} strong` : ''}${r.cravings.topTrigger ? `, most often ${triggerName(r.cravings.topTrigger).toLowerCase()}` : ''}.`,
    r.mood.avg !== null
      ? `Mood: average ${r.mood.avg} of 5 over ${r.mood.logged} day${r.mood.logged === 1 ? '' : 's'} rated (1 rough, 3 okay, 5 great); journal written on ${r.mood.written} day${r.mood.written === 1 ? '' : 's'}.`
      : `Mood: not rated${r.mood.written ? `; journal written on ${r.mood.written} days` : ''}.`,
    `Study: ${fmtStudy(r.study.minutes)}${r.study.courses.length ? ` (${r.study.courses.map((x) => `${x.name} ${fmtStudy(x.minutes)}${x.goal ? ` of a ${fmtStudy(x.goal)} goal` : ''}`).join('; ')})` : ''}. Work due so far this week: ${r.study.met} handed in${r.study.late.length ? `, not handed in: ${r.study.late.join(', ')}` : ''}${r.study.ahead ? `; ${r.study.ahead} more due later this week` : ''}.`,
    r.money
      ? `Money in the day-to-day accounts: ${fmtMoney(r.money.in)} in, ${fmtMoney(r.money.out)} out; balance at the end of the week ${fmtMoney(r.money.closing)} from what's done, against a forecast of ${fmtMoney(r.money.forecast)} with what's planned.`
      : 'Money: not tracked.',
    r.tasks !== null ? `Tasks ticked off: ${r.tasks}.` : 'Tasks: not known.',
    `Packages delivered: ${r.packages.length}${r.packages.length ? ` (${r.packages.join(', ')})` : ''}.`,
  ];
  return lines.join('\n');
}

/** A week with nothing logged anywhere gets no note. */
const empty = (r: WeekReview) =>
  !r.training.sessions && !r.cigarettes.count && !r.cravings.resisted && !r.mood.logged && !r.mood.written && !r.study.minutes && !(r.money && (r.money.in || r.money.out)) && !r.tasks;

// ---------- the note ----------

const NOTE_SYSTEM = `You write a short recap of someone's week on their personal dashboard, from the week's numbers across their training, body weight, cigarettes, cravings, mood, study, money, tasks and deliveries. They read it on Sunday evening or when looking back at a past week, so it has to be quick to take in.

Write:
- headline: one or two sentences on how the week went overall, with real numbers from the data
- points: two to four short points, each one specific thing worth knowing, such as a number that moved against the week before, a limit or goal that was or wasn't met, or work that's late

Only use what's in the data, and leave out what wasn't logged. Be plain and direct, like a friend who has read the numbers; don't cheer, scold or pad. No emoji, no medical or diet advice. Cravings are urges to smoke that they didn't act on.`;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'points'],
  additionalProperties: false,
};

const writing = new Map<string, Promise<void>>();

/** Write the recap for the week starting `monday` when it has none yet (or again, with `force`). Failures are kept for the page to show. */
export function refreshReviewNote(monday: string, force = false): Promise<void> {
  let run = writing.get(monday);
  if (run) return run;
  run = (async () => {
    if (!claudeEnabled()) return;
    const state = store.reviewNotes();
    if (!force && state.notes[monday]) return;
    const r = await reviewOf(monday);
    if (empty(r) && !force) return;
    try {
      const res = await askJson<{ headline: string; points: string[] }>({
        model: config.reviewModel,
        system: NOTE_SYSTEM,
        user: reviewInput(r),
        schema: NOTE_SCHEMA,
        effort: 'low',
        task: 'write a recap of the week',
      });
      const note: ReviewNote = { headline: res.headline.trim(), points: res.points.map((p) => p.trim()).filter(Boolean).slice(0, 5), writtenAt: new Date().toISOString() };
      const now = store.reviewNotes();
      store.setReviewNotes({ notes: { ...now.notes, [monday]: note }, error: null });
    } catch (e) {
      store.setReviewNotes({ ...store.reviewNotes(), error: (e as Error).message });
      throw e;
    }
  })().finally(() => writing.delete(monday));
  writing.set(monday, run);
  return run;
}

/** The week a recap is due for: this one from Sunday 6 pm, else the one before. */
export function recapWeek(now: Date): string {
  const mon = weekStart(now);
  return ymd(now.getDay() === 0 && now.getHours() >= 18 ? mon : addDays(mon, -7));
}

let lastTry = 0;

/** Checks every half hour whether a recap is due, and writes it. A failure waits three hours before trying again. */
export function startReviewNotes(): void {
  const tick = () => {
    if (!claudeEnabled() || Date.now() - lastTry < 3 * 60 * MIN) return;
    const week = recapWeek(new Date());
    if (store.reviewNotes().notes[week]) return;
    lastTry = Date.now();
    asServer(() => refreshReviewNote(week)).then(
      () => (lastTry = 0),
      () => {},
    );
  };
  setTimeout(tick, 2 * MIN);
  setInterval(tick, 30 * MIN);
}
