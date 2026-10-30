// Claude's note on the week ahead in Learn: what's due, how each course is
// going against its target and how study time compares with the goals.
// Written once a day (or on refresh), and only with ANTHROPIC_API_KEY.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { store } from './store';
import { DOW, MON, dayDiff, parseYmd, startOfDay, ymd } from '../../shared/dates';
import { SIDE_STALE_DAYS, STATUS_NAMES, courseGrade, fmtDue, fmtStudy, letterOf, neededFor, openWork, studyStreak, weekByCourse, weeklyStudy } from '../../shared/learn';
import type { Learn, LearnNote } from '../../shared/types';

const NOTE_SYSTEM = `You write a short note for a student on their personal dashboard, about the week ahead in their courses. They read it on a new browser tab, so it has to be quick to take in.

Write:
- headline: one or two sentences on what matters most in the next week or so, with real numbers from the data: what's due and how much it counts, and any course that's behind its target or its study goal
- points: two to four short points, each one specific thing to do or know, such as work that's late, a heavy stretch coming up, a course that needs time, or an exam getting close

Only use what's in the data. Be plain and direct, like a friend who has read their planner; don't cheer, scold or pad. No emoji. Percentages are of the course grade. Weeks start on Monday.`;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'points'],
  additionalProperties: false,
};

const day = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;

/** Learn as Claude reads it: each course's grade and study, open work for the next five weeks, exams and side learning. */
export function learnInput(learn: Learn, now: Date): string {
  const today = startOfDay(now);
  const courses = learn.courses.filter((c) => !c.archived);
  const byCourse = weekByCourse(learn, now);
  const lines = [
    `Today is ${day(today)} ${today.getFullYear()}.`,
    `Study this week so far: ${fmtStudy(Object.values(byCourse).reduce((a, b) => a + b, 0))}; ${studyStreak(learn, now)} days in a row with some study.`,
    `Study a week, last 8 weeks, oldest first: ${weeklyStudy(learn, now, 8).map((w) => fmtStudy(w.minutes)).join(', ')}.`,
    '',
    'Courses:',
  ];
  for (const c of courses) {
    const g = courseGrade(learn.assessments, c.id);
    const need = c.target ? neededFor(g, c.target) : null;
    lines.push(
      `- ${c.code ? `${c.code} ` : ''}${c.name}: ` +
        (g.pct === null ? 'nothing marked yet' : `${g.pct}% (${letterOf(g.pct)}) from the ${g.marked}% marked`) +
        (c.target ? `; target ${c.target}% (${letterOf(c.target)})${need !== null ? `, needs ${need}% on the rest` : ''}` : '; no target') +
        `; studied ${fmtStudy(byCourse[c.id] ?? 0)} this week${c.goalMin ? ` of a ${fmtStudy(c.goalMin)} goal` : ''}` +
        (c.topics.length ? `; topics not yet solid: ${c.topics.filter((t) => t.conf < 3).map((t) => t.name).join(', ') || 'none'}` : ''),
    );
  }
  const names = new Map(courses.map((c) => [c.id, c.code || c.name]));
  const open = openWork(learn).filter((a) => !a.due || dayDiff(today, parseYmd(a.due)) <= 35);
  lines.push('', 'Open work, soonest first (not handed in):');
  if (!open.length) lines.push('- none');
  for (const a of open) {
    const when = a.due ? `${fmtDue(a.due)}${a.time ? ` ${a.time}` : ''}${dayDiff(today, parseYmd(a.due)) < 0 ? ' (late)' : ''}` : 'no date';
    lines.push(`- ${names.get(a.courseId)}: ${a.title} (${a.kind}, ${a.weight}%), due ${when}, ${STATUS_NAMES[a.status].toLowerCase()}`);
  }
  if (learn.side.length) {
    lines.push('', 'Learning on the side:');
    for (const s of learn.side) {
      const since = s.lastAt ? dayDiff(new Date(s.lastAt), today) : null;
      lines.push(`- ${s.title}: ${s.done} of ${s.total} ${s.unit}, ${since === null ? 'not started' : `last progress ${since} days ago${since >= SIDE_STALE_DAYS ? ' (stalled)' : ''}`}`);
    }
  }
  return lines.join('\n');
}

let writing: Promise<void> | null = null;

/** Write a note when there isn't one from today yet (or always, with `force`). Failures are kept for the page to show. */
export function refreshLearnNote(force = false): Promise<void> {
  writing ??= (async () => {
    const learn = store.learn();
    const state = store.learnNote();
    if (!claudeEnabled() || !learn.courses.some((c) => !c.archived)) {
      store.setLearnNote({ note: null, error: null });
      return;
    }
    if (!force && state.note && ymd(new Date(state.note.writtenAt)) === ymd(new Date()) && !state.error) return;
    try {
      const res = await askJson<{ headline: string; points: string[] }>({
        model: config.learnModel,
        system: NOTE_SYSTEM,
        user: learnInput(learn, new Date()),
        schema: NOTE_SCHEMA,
        effort: 'low',
        task: 'write a note on the week ahead',
      });
      const note: LearnNote = { headline: res.headline.trim(), points: res.points.map((p) => p.trim()).filter(Boolean).slice(0, 5), writtenAt: new Date().toISOString() };
      store.setLearnNote({ note, error: null });
    } catch (e) {
      store.setLearnNote({ note: state.note, error: (e as Error).message });
    }
  })().finally(() => {
    writing = null;
  });
  return writing;
}
