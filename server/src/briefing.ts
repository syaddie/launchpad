// The daily briefing at the top of Today: Claude reads the day's calendar, what's due,
// the inbox, Learn, packages, the weather, Money, training and countdowns, and writes two
// to four sentences. Once each morning from 6:00 (or as soon as the server is up after
// that), again on refresh, and only with ANTHROPIC_API_KEY and the panel switched on.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { store } from './store';
import { DOW, MON, addDays, dayDiff, pad2, parseYmd, startOfDay, ymd } from '../../shared/dates';
import { fmtDue, openWork, upcomingExams } from '../../shared/learn';
import { balanceOn, calcMonths, fmtMoney, lowestAhead, monthKeys, toReview } from '../../shared/money';
import { nearestCountdown } from '../../shared/trackers';
import { lastTrained, weekStreak } from '../../shared/training';
import type { Briefing, CalEvent, Countdown, InboxDigest, Learn, Money, Package, Prefs, Task, Training, Weather } from '../../shared/types';

/** The hour the briefing is written from, server time (Singapore in the container). */
export const BRIEFING_HOUR = 6;

const SYSTEM = `You write the briefing at the top of someone's personal dashboard: their day ahead, in two to four sentences. They read it at a glance on a new browser tab, any time of day.

Lead with what shapes the day: when the first thing starts, any long busy stretch, and the next video call. Then what's due or late (tasks, coursework, emails waiting on them with a deadline). Then only what's worth knowing today: a package arriving, rain or poor air, money that's tight or a planned payment, an exam coming up, the training streak, a countdown that's close.

Pick what matters; you don't have to mention everything, and leave out what's routine or empty. Use the real names, times and amounts from the data. Write calm, plain sentences, like a good assistant's note: no greeting, no sign-off, no cheering or scolding, no advice unless something needs doing, no emoji, no lists or headings. Times are 24-hour, as given. Only use what's in the data.`;

const SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
};

const hm = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const day = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;

/** What the briefing is written from; each part is left out when it's switched off or empty. */
export interface BriefingData {
  prefs: Prefs;
  googleConnected: boolean;
  events: CalEvent[];
  tasks: Task[];
  inbox: { digest: InboxDigest | null; unread: Set<string> };
  learn: Learn;
  packages: Package[];
  weather: Weather | null;
  money: Money;
  training: Training;
  countdowns: Countdown[];
}

/** The day as Claude reads it. */
export function briefingInput(d: BriefingData, now: Date): string {
  const today = startOfDay(now);
  const todayKey = ymd(today);
  const tomorrow = addDays(today, 1);
  const hidden = new Set(d.prefs.hidden);
  const on = (view: string) => !hidden.has(`view:${view}`);
  const lines = [`Today is ${day(today)} ${today.getFullYear()}; it's ${hm(now)} now.`];

  if (d.googleConnected && d.prefs.sources.calendar && !hidden.has('panel:today')) {
    const shown = d.events.filter((e) => !d.prefs.hiddenCalendars.includes(e.calendarId));
    const allDay = shown.filter((e) => e.allDay && parseYmd(e.start) <= today && parseYmd(e.end) > today);
    const timed = shown
      .filter((e) => !e.allDay)
      .map((e) => ({ ...e, s: new Date(e.start), e: new Date(e.end) }))
      .filter((e) => e.s < tomorrow && e.e > today)
      .sort((a, b) => a.s.getTime() - b.s.getTime());
    lines.push('', 'Calendar today:');
    if (!timed.length && !allDay.length) lines.push('- nothing');
    for (const e of allDay) lines.push(`- all day: ${e.title}`);
    for (const e of timed) {
      const extra = [e.conferenceType ? `${e.conferenceType} call` : '', e.location ? `at ${e.location}` : ''].filter(Boolean).join(', ');
      lines.push(`- ${e.s < today ? 'from yesterday' : hm(e.s)}–${hm(e.e)} ${e.title}${extra ? ` (${extra})` : ''}${e.e <= now ? ' (over)' : ''}`);
    }
  }

  if (d.googleConnected && d.prefs.sources.tasks && !hidden.has('panel:tasks')) {
    const due = d.tasks.filter((t) => t.due && t.due <= todayKey).sort((a, b) => (a.due! < b.due! ? -1 : 1));
    if (due.length) {
      lines.push('', 'Tasks due today or late:');
      for (const t of due.slice(0, 12)) lines.push(`- ${t.title}${t.due! < todayKey ? ` (was due ${day(parseYmd(t.due!))})` : ''}`);
    }
  }

  if (d.googleConnected && d.prefs.sources.gmail && on('inbox') && d.inbox.digest) {
    const todo = d.inbox.digest.items.filter((i) => i.kind === 'action' && i.emails.some((id) => d.inbox.unread.has(id)));
    if (todo.length) {
      lines.push('', 'Emails waiting on them, still unread:');
      for (const i of todo.slice(0, 6)) lines.push(`- ${i.headline}${i.due ? ` (${i.due})` : ''}`);
    }
  }

  if (on('learn')) {
    const names = new Map(d.learn.courses.map((c) => [c.id, c.code || c.name]));
    const soon = openWork(d.learn).filter((a) => a.due && dayDiff(today, parseYmd(a.due)) <= 2);
    const exams = upcomingExams(d.learn, today).filter((a) => a.days <= 14);
    if (soon.length || exams.length) {
      lines.push('', 'Coursework:');
      for (const a of soon.slice(0, 8)) {
        const late = dayDiff(today, parseYmd(a.due)) < 0;
        lines.push(`- ${names.get(a.courseId)} ${a.title} (${a.kind}, ${a.weight}% of the grade), due ${fmtDue(a.due)}${a.time ? ` ${a.time}` : ''}${late ? ', late' : ''}`);
      }
      for (const a of exams.filter((x) => !soon.includes(x))) lines.push(`- ${names.get(a.courseId)} ${a.title} exam in ${a.days} day${a.days === 1 ? '' : 's'} (${fmtDue(a.due)})`);
    }
  }

  if (!hidden.has('panel:packages')) {
    const arriving = d.packages.filter((p) => !p.archived && (p.stage === 2 || (p.exception && p.stage < 3)));
    if (arriving.length) {
      lines.push('', 'Packages:');
      for (const p of arriving) lines.push(`- ${p.label || p.carrier}: ${p.exception ? 'needs a look, ' : ''}${p.statusText}`);
    }
  }

  const w = d.weather;
  if (w && d.prefs.weatherArea && !hidden.has('top:weather')) {
    const parts = [`${w.forecast} in ${w.area} for the next two hours`];
    if (w.tempC !== null) parts.push(`${Math.round(w.tempC)}°C now`);
    const out = w.outlook?.find((o) => o.date === todayKey);
    if (out) parts.push(`today ${out.forecast.toLowerCase()}, ${out.low}–${out.high}°C`);
    if (w.air && !hidden.has('top:air')) parts.push(`24-hour PSI ${w.air.psi}${w.air.psi > 100 ? ' (unhealthy)' : w.air.psi > 50 ? ' (moderate)' : ' (good)'}`);
    lines.push('', `Weather: ${parts.join('; ')}.`);
  }

  if (on('money') && d.money.entries.length) {
    const balance = balanceOn(d.money, todayKey, true);
    const dueToday = d.money.entries.filter((e) => e.planned && e.date === todayKey && e.kind !== 'move');
    const passed = toReview(d.money, todayKey).length;
    const low = lowestAhead(calcMonths(d.money, monthKeys(d.money, todayKey)), todayKey);
    lines.push('', 'Money:', `- in the day-to-day accounts now: ${fmtMoney(balance)}`);
    for (const e of dueToday) lines.push(`- planned today: ${e.kind === 'in' ? 'in' : 'out'} ${fmtMoney(e.amount)}${e.note ? `, ${e.note}` : ''}`);
    if (passed) lines.push(`- ${passed} planned entr${passed === 1 ? 'y has' : 'ies have'} passed without being ticked off`);
    if (low && (low.balance < 0 || low.balance < balance * 0.25)) lines.push(`- the forecast balance gets as low as ${fmtMoney(low.balance)} on ${day(parseYmd(low.date))}`);
  }

  if (on('training') && d.training.workouts.length) {
    const last = lastTrained(d.training.workouts, today);
    const streak = weekStreak(d.training.workouts, today);
    lines.push('', `Training: ${streak} week${streak === 1 ? '' : 's'} in a row with a session${last ? `; last session ${last.days === 0 ? 'today' : last.days === 1 ? 'yesterday' : `${last.days} days ago`}` : ''}.`);
  }

  const soon = hidden.has('top:countdown') ? '' : nearestCountdown(d.countdowns, now);
  if (soon) lines.push('', `Nearest countdown: ${soon}.`);
  return lines.join('\n');
}

function briefingData(): BriefingData {
  const inbox = store.inbox();
  return {
    prefs: store.prefs(),
    googleConnected: !!store.google(),
    events: store.calendar().events,
    tasks: store.tasks().tasks,
    inbox: { digest: inbox.digests['2d'], unread: new Set(inbox.emails.filter((e) => e.unread).map((e) => e.id)) },
    learn: store.learn(),
    packages: store.packages(),
    weather: store.weather().now,
    money: store.money(),
    training: store.training(),
    countdowns: store.countdowns(),
  };
}

/** Whether this morning's briefing is still to be written. */
export function briefingDue(note: Briefing | null, now: Date): boolean {
  if (now.getHours() < BRIEFING_HOUR) return false;
  const from = startOfDay(now);
  from.setHours(BRIEFING_HOUR);
  return !note || Date.parse(note.writtenAt) < from.getTime();
}

let writing: Promise<void> | null = null;

/** Write the briefing when this morning's isn't written yet (or always, with `force`). Failures are kept for the page to show. */
export function refreshBriefing(force = false): Promise<void> {
  writing ??= (async () => {
    const state = store.briefing();
    const hidden = store.prefs().hidden;
    if (!claudeEnabled() || hidden.includes('panel:briefing') || hidden.includes('panel:today')) return;
    if (!force && !briefingDue(state.note, new Date())) return;
    try {
      const res = await askJson<{ text: string }>({
        model: config.briefingModel,
        feature: 'briefing',
        system: SYSTEM,
        user: briefingInput(briefingData(), new Date()),
        schema: SCHEMA,
        effort: 'low',
        task: 'write the daily briefing',
      });
      store.setBriefing({ note: { text: res.text.trim(), writtenAt: new Date().toISOString() }, error: null });
    } catch (e) {
      store.setBriefing({ note: state.note, error: (e as Error).message });
    }
  })().finally(() => {
    writing = null;
  });
  return writing;
}

/** Check every few minutes; the first check waits for the first syncs to bring in today's calendar and mail. */
export function startBriefing(): void {
  let failedAt = 0;
  const check = () => {
    if (Date.now() - failedAt < 30 * 60_000) return;
    refreshBriefing().then(() => {
      if (store.briefing().error) failedAt = Date.now();
    });
  };
  setTimeout(() => {
    check();
    setInterval(check, 5 * 60_000);
  }, 90_000);
}
