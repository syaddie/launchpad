// The Learn view: courses with their graded work, study sessions and learning
// on the side. What's stored is what's typed in; grades, what's needed to hit a
// target, study totals and the due list are worked out here. Also cleaning for
// what the page sends, and reading "study 45 cs210" in ⌘K.
import { DOW, MON, addDays, dayDiff, parseYmd, startOfDay, ymd } from './dates';
import type { Assessment, AssessmentKind, AssessmentStatus, CalEvent, Course, Learn, SideLearning, StudySession } from './types';

export const MAX_COURSES = 30;
export const MAX_ASSESSMENTS = 600;
export const MAX_SESSIONS = 5000;
export const MAX_SIDE = 30;
/** A timer left running longer than this is logged as this long. */
export const MAX_SESSION_MIN = 12 * 60;
/** Days without progress before learning on the side turns orange. */
export const SIDE_STALE_DAYS = 7;

export const KINDS: AssessmentKind[] = ['Assignment', 'Problem set', 'Lab', 'Quiz', 'Test', 'Exam', 'Essay', 'Project', 'Presentation', 'Reading', 'Other'];
export const STATUS_NAMES: Record<AssessmentStatus, string> = { todo: 'Not started', doing: 'In progress', done: 'Handed in' };

/** Muted, told apart by lightness as well as hue; the first three match the calendar colours in the handoff. */
export const COURSE_COLORS = ['#5f8fa3', '#b08844', '#a06a8c', '#6f7d4a', '#4f6fa8', '#b0674a', '#7a6a9e', '#5c8a78'];

/** Letter grades from the lowest percent that earns each, highest first. */
export const GRADES: [string, number][] = [
  ['A+', 90], ['A', 85], ['A−', 80], ['B+', 75], ['B', 70], ['B−', 65], ['C+', 60], ['C', 55], ['D+', 50], ['D', 45], ['F', 0],
];

export const letterOf = (pct: number) => GRADES.find(([, min]) => pct >= min)![0];

export const emptyLearn = (): Learn => ({ courses: [], assessments: [], sessions: [], side: [], timer: null, calendarId: '' });

// ---------- cleaning ----------

const isStr = (v: unknown): v is string => typeof v === 'string';
const str = (v: unknown, max: number) => (isStr(v) ? v.trim().slice(0, max) : '');
const id = (v: unknown) => (isStr(v) && v ? v.slice(0, 40) : '');
const numIn = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : d);
const isYmd = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const round1 = (n: number) => Math.round(n * 10) / 10;
const hostOf = (url: string) => {
  try {
    return new URL(url.trim()).host.slice(0, 40);
  } catch {
    return url.trim().slice(0, 40);
  }
};

function cleanCourse(c: Partial<Course>): Course | null {
  const name = str(c.name, 80);
  if (!id(c.id) || !name) return null;
  return {
    id: id(c.id),
    code: str(c.code, 20),
    name,
    color: isStr(c.color) && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : COURSE_COLORS[0],
    target: Math.round(numIn(c.target, 0, 100, 0)),
    goalMin: Math.round(numIn(c.goalMin, 0, 60 * 60, 0)),
    links: (Array.isArray(c.links) ? c.links : [])
      .filter((l) => l && isStr(l.url) && /^https?:\/\//i.test(l.url.trim()))
      .slice(0, 12)
      .map((l) => ({ name: str(l.name, 40) || hostOf(l.url), url: l.url.trim().slice(0, 500) })),
    topics: (Array.isArray(c.topics) ? c.topics : [])
      .filter((t) => t && str(t.name, 80))
      .slice(0, 60)
      .map((t) => ({ name: str(t.name, 80), conf: ([1, 2, 3].includes(t.conf) ? t.conf : 1) as 1 | 2 | 3 })),
    archived: c.archived === true,
  };
}

function cleanAssessment(a: Partial<Assessment>, courses: Set<string>): Assessment | null {
  const title = str(a.title, 120);
  if (!id(a.id) || !title || !courses.has(a.courseId!)) return null;
  return {
    id: id(a.id),
    courseId: a.courseId!,
    title,
    kind: KINDS.includes(a.kind as AssessmentKind) ? a.kind! : 'Other',
    weight: round1(numIn(a.weight, 0, 100, 0)),
    due: isYmd(a.due) ? a.due : '',
    time: isStr(a.time) && /^([01]\d|2[0-3]):[0-5]\d$/.test(a.time) ? a.time : '',
    status: (['todo', 'doing', 'done'] as const).includes(a.status as AssessmentStatus) ? a.status! : 'todo',
    score: typeof a.score === 'number' && Number.isFinite(a.score) ? round1(Math.min(200, Math.max(0, a.score))) : null,
  };
}

function cleanSession(s: Partial<StudySession>, courses: Set<string>): StudySession | null {
  if (!id(s.id) || !isIso(s.start)) return null;
  const minutes = Math.round(numIn(s.minutes, 0, MAX_SESSION_MIN, 0));
  if (!minutes) return null;
  return { id: id(s.id), courseId: courses.has(s.courseId!) ? s.courseId! : '', start: new Date(s.start).toISOString(), minutes };
}

function cleanSide(s: Partial<SideLearning>): SideLearning | null {
  const title = str(s.title, 100);
  if (!id(s.id) || !title) return null;
  const total = Math.round(numIn(s.total, 1, 10_000, 1));
  return { id: id(s.id), title, unit: str(s.unit, 20) || 'steps', done: Math.round(numIn(s.done, 0, total, 0)), total, lastAt: isIso(s.lastAt) ? s.lastAt : null };
}

/** What the page sent, or what's stored, made safe: unknown fields dropped, sizes capped, links to missing courses removed. */
export function cleanLearn(v: unknown): Learn {
  const b = (v && typeof v === 'object' ? v : {}) as Partial<Learn>;
  const arr = <T>(x: unknown) => (Array.isArray(x) ? (x as Partial<T>[]).filter((y) => y && typeof y === 'object') : []);
  const courses = arr<Course>(b.courses).flatMap((c) => cleanCourse(c) ?? []).slice(0, MAX_COURSES);
  const ids = new Set(courses.map((c) => c.id));
  const t = b.timer as Learn['timer'];
  return {
    courses,
    assessments: arr<Assessment>(b.assessments).flatMap((a) => cleanAssessment(a, ids) ?? []).slice(0, MAX_ASSESSMENTS),
    sessions: arr<StudySession>(b.sessions).flatMap((s) => cleanSession(s, ids) ?? []).sort((x, y) => x.start.localeCompare(y.start)).slice(-MAX_SESSIONS),
    side: arr<SideLearning>(b.side).flatMap((s) => cleanSide(s) ?? []).slice(0, MAX_SIDE),
    timer: t && isIso(t.start) && Date.parse(t.start) <= Date.now() + 60_000 ? { courseId: ids.has(t.courseId) ? t.courseId : '', start: new Date(t.start).toISOString() } : null,
    calendarId: str(b.calendarId, 300),
  };
}

// ---------- grades ----------

export interface Grade {
  /** Weighted average of what's marked, in percent; null before anything is marked. */
  pct: number | null;
  /** Percent of the course grade that's been marked. */
  marked: number;
  /** All the weights added up; a course is normally 100. */
  totalWeight: number;
  /** Points earned towards the final grade so far (percent of the whole course), unrounded for the maths. */
  earned: number;
}

export function courseGrade(assessments: Assessment[], courseId: string): Grade {
  const mine = assessments.filter((a) => a.courseId === courseId);
  const marked = mine.filter((a) => a.score !== null && a.weight > 0);
  const w = marked.reduce((s, a) => s + a.weight, 0);
  const earned = marked.reduce((s, a) => s + (a.weight * a.score!) / 100, 0);
  return { pct: w ? round1((earned / w) * 100) : null, marked: round1(w), totalWeight: round1(mine.reduce((s, a) => s + a.weight, 0)), earned };
}

/**
 * The average needed on what isn't marked yet to finish on `target` percent.
 * Counts the rest of the course as 100 minus what's marked. null when nothing is left;
 * over 100 means it's out of reach, 0 means it's already safe.
 */
export function neededFor(g: Grade, target: number): number | null {
  const left = 100 - g.marked;
  if (left <= 0) return null;
  return Math.max(0, round1(((target - g.earned) / left) * 100));
}

// ---------- what's due ----------

export type DueGroup = 'Overdue' | 'Today' | 'This week' | 'Next week' | 'Later' | 'No date';
export const DUE_GROUPS: DueGroup[] = ['Overdue', 'Today', 'This week', 'Next week', 'Later', 'No date'];

/** Monday of the week d is in. */
export const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));

export function dueGroup(a: Assessment, today: Date): DueGroup {
  if (!a.due) return 'No date';
  const o = dayDiff(today, parseYmd(a.due));
  if (o < 0) return 'Overdue';
  if (o === 0) return 'Today';
  const sunday = dayDiff(today, addDays(weekStart(today), 6));
  if (o <= sunday) return 'This week';
  if (o <= sunday + 7) return 'Next week';
  return 'Later';
}

/** Open work in courses that aren't archived, soonest first; undated ones last. */
export function openWork(learn: Learn): Assessment[] {
  const live = new Set(learn.courses.filter((c) => !c.archived).map((c) => c.id));
  return learn.assessments
    .filter((a) => live.has(a.courseId) && a.status !== 'done' && a.score === null)
    .sort((x, y) => (x.due || '9999') + (x.time || '99') < (y.due || '9999') + (y.time || '99') ? -1 : 1);
}

/** Exams still to come, soonest first, with the days to go. */
export function upcomingExams(learn: Learn, today: Date): (Assessment & { days: number })[] {
  const live = new Set(learn.courses.filter((c) => !c.archived).map((c) => c.id));
  return learn.assessments
    .filter((a) => a.kind === 'Exam' && a.due && live.has(a.courseId) && a.score === null && dayDiff(today, parseYmd(a.due)) >= 0)
    .map((a) => ({ ...a, days: dayDiff(today, parseYmd(a.due)) }))
    .sort((x, y) => x.days - y.days || x.time.localeCompare(y.time));
}

/** The next open piece of work in a course with a date today or later. */
export function nextUp(learn: Learn, courseId: string, today: Date): Assessment | undefined {
  return openWork(learn).find((a) => a.courseId === courseId && a.due && dayDiff(today, parseYmd(a.due)) >= 0);
}

// ---------- study time ----------

/** Minutes in a session, counting a running timer up to `now`. */
export function timerMinutes(timer: Learn['timer'], now: Date): number {
  if (!timer) return 0;
  return Math.min(MAX_SESSION_MIN, Math.max(0, (now.getTime() - Date.parse(timer.start)) / 60000));
}

/** Sessions, with the running timer as one more, so totals move while it runs. */
function withTimer(learn: Learn, now: Date): StudySession[] {
  if (!learn.timer) return learn.sessions;
  return [...learn.sessions, { id: 'timer', courseId: learn.timer.courseId, start: learn.timer.start, minutes: timerMinutes(learn.timer, now) }];
}

export interface StudyDay {
  date: Date;
  /** Minutes by course id ('' for general study). */
  byCourse: Record<string, number>;
  total: number;
}

/** Monday to Sunday of the week `today` is in. A session counts on the day it started. */
export function studyWeek(learn: Learn, now: Date): StudyDay[] {
  const mon = weekStart(now);
  const days: StudyDay[] = Array.from({ length: 7 }, (_, i) => ({ date: addDays(mon, i), byCourse: {}, total: 0 }));
  for (const s of withTimer(learn, now)) {
    const i = dayDiff(mon, new Date(s.start));
    if (i < 0 || i > 6) continue;
    days[i].byCourse[s.courseId] = (days[i].byCourse[s.courseId] ?? 0) + s.minutes;
    days[i].total += s.minutes;
  }
  return days;
}

/** Study minutes for each course this week. */
export function weekByCourse(learn: Learn, now: Date): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of studyWeek(learn, now)) for (const [k, m] of Object.entries(d.byCourse)) out[k] = (out[k] ?? 0) + m;
  return out;
}

/** Minutes a week for the last `n` weeks, oldest first; the last is this week so far. */
export function weeklyStudy(learn: Learn, now: Date, n = 12): { start: Date; minutes: number }[] {
  const mon = weekStart(now);
  const weeks = Array.from({ length: n }, (_, i) => ({ start: addDays(mon, -7 * (n - 1 - i)), minutes: 0 }));
  for (const s of withTimer(learn, now)) {
    const i = n - 1 - Math.round(dayDiff(weekStart(new Date(s.start)), mon) / 7);
    if (i >= 0 && i < n) weeks[i].minutes += s.minutes;
  }
  return weeks;
}

/** Days in a row with any study, up to today (or up to yesterday while today has none yet). */
export function studyStreak(learn: Learn, now: Date): number {
  const days = new Set(withTimer(learn, now).filter((s) => s.minutes >= 1).map((s) => ymd(new Date(s.start))));
  let d = startOfDay(now);
  if (!days.has(ymd(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(ymd(d)) && n < 3650) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

/** "45m", "1h 05m", "2h" */
export function fmtStudy(min: number): string {
  const m = Math.round(min);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${String(r).padStart(2, '0')}m` : `${h}h`;
}

// ---------- ⌘K ----------

/**
 * "study 45 cs210", "study 1h30 linear algebra", "studied 90" → minutes and the course it names.
 * The course is matched by code (ignoring spaces) or the start of a word in its name; none means general study.
 * Returns null when the text isn't a study log, or names a course that isn't there.
 */
export function parseStudy(q: string, courses: Course[]): { minutes: number; courseId: string } | null {
  const m = q.trim().toLowerCase().match(/^(?:study|studied|log study)\s+(?:(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(\d+)?\s*(?:m(?:in(?:utes?|s)?)?)?|(\d+)\s*(?:m(?:in(?:utes?|s)?)?)?)(?:\s+(.+))?$/);
  if (!m) return null;
  const minutes = m[1] ? Math.round(Number(m[1]) * 60 + Number(m[2] || 0)) : Number(m[3]);
  if (!minutes || minutes > MAX_SESSION_MIN) return null;
  const rest = (m[4] || '').trim();
  if (!rest) return { minutes, courseId: '' };
  const flat = rest.replace(/\s+/g, '');
  const live = courses.filter((c) => !c.archived);
  const course =
    live.find((c) => c.code && c.code.toLowerCase().replace(/\s+/g, '') === flat) ??
    live.find((c) => c.code && c.code.toLowerCase().replace(/\s+/g, '').startsWith(flat)) ??
    live.find((c) => c.name.toLowerCase().startsWith(rest)) ??
    live.find((c) => c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(rest)));
  return course ? { minutes, courseId: course.id } : null;
}

// ---------- classes ----------

/** The course a calendar event is for, by its code or name in the title. */
export function courseForEvent(title: string, courses: Course[]): Course | undefined {
  const t = title.toLowerCase();
  const flat = t.replace(/\s+/g, '');
  return courses.find((c) => !c.archived && ((c.code && flat.includes(c.code.toLowerCase().replace(/\s+/g, ''))) || t.includes(c.name.toLowerCase())));
}

/** Today's timed events that are classes: everything in the chosen calendar, or (without one) events naming a course. */
export function classesOn(events: CalEvent[], learn: Learn, day: Date, hiddenCalendars: string[] = []): (CalEvent & { course?: Course })[] {
  const from = startOfDay(day);
  const to = addDays(from, 1);
  const hidden = new Set(hiddenCalendars);
  return events
    .filter((e) => !e.allDay && !hidden.has(e.calendarId) && new Date(e.start) < to && new Date(e.end) > from)
    .map((e) => ({ ...e, course: courseForEvent(e.title, learn.courses) }))
    .filter((e) => (learn.calendarId ? e.calendarId === learn.calendarId : !!e.course))
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** "Tue 3 Nov" */
export const fmtDue = (s: string) => {
  const d = parseYmd(s);
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
};
