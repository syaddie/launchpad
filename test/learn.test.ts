import { describe, expect, it } from 'vitest';
import {
  classesOn, cleanLearn, courseGrade, dueGroup, emptyLearn, fmtStudy, letterOf, neededFor, nextUp, openWork, parseStudy, studyStreak, studyWeek, upcomingExams, weekByCourse, weeklyStudy,
} from '../shared/learn';
import type { Assessment, CalEvent, Course, Learn } from '../shared/types';

// Friday 30 Oct 2026, 14:32 in Singapore (the tests run with TZ=Asia/Singapore).
const NOW = new Date(2026, 9, 30, 14, 32);
const TODAY = new Date(2026, 9, 30);

const course = (id: string, name: string, code = '', extra: Partial<Course> = {}): Course => ({ id, code, name, color: '#5f8fa3', target: 0, goalMin: 0, links: [], topics: [], archived: false, ...extra });
let seq = 0;
const work = (courseId: string, weight: number, extra: Partial<Assessment> = {}): Assessment => ({
  id: `a${seq++}`, courseId, title: `Item ${seq}`, kind: 'Assignment', weight, due: '', time: '', status: 'todo', score: null, ...extra,
});
const at = (d: number, h = 10) => new Date(2026, 9, d, h).toISOString();

const sample = (): Learn => ({
  ...emptyLearn(),
  courses: [course('cs', 'Data Structures', 'CS 210', { target: 85, goalMin: 240 }), course('ma', 'Linear Algebra', 'MA 202'), course('old', 'Old course', '', { archived: true })],
  assessments: [
    work('cs', 14, { score: 92, status: 'done' }),
    work('cs', 15, { score: 81, status: 'done' }),
    work('cs', 16, { score: 85, status: 'done' }),
    work('cs', 4, { due: '2026-10-30', time: '23:59', status: 'doing', title: 'Lab 8' }),
    work('cs', 30, { due: '2026-11-26', kind: 'Exam', title: 'Final' }),
    work('ma', 10, { due: '2026-11-03', kind: 'Quiz', title: 'Quiz 3' }),
    work('ma', 5, { due: '2026-10-28', title: 'Late one' }),
    work('ma', 5, { due: '2026-10-29', status: 'done', title: 'Handed in' }),
    work('old', 50, { due: '2026-11-02', title: 'Archived course work' }),
  ],
  sessions: [
    { id: 's1', courseId: 'cs', start: at(26), minutes: 60 },
    { id: 's2', courseId: 'ma', start: at(27), minutes: 20 },
    { id: 's3', courseId: 'cs', start: at(28), minutes: 50 },
    { id: 's4', courseId: '', start: at(29), minutes: 40 },
    { id: 's5', courseId: 'cs', start: at(30, 9), minutes: 80 },
    { id: 's6', courseId: 'cs', start: at(19), minutes: 100 },
  ],
});

describe('grades', () => {
  it('averages what’s marked by weight and counts how much is marked', () => {
    const g = courseGrade(sample().assessments, 'cs');
    expect(g).toMatchObject({ pct: 85.8, marked: 45, totalWeight: 79 });
    expect(courseGrade(sample().assessments, 'ma').pct).toBeNull();
  });
  it('works out the average needed on the rest to reach a target', () => {
    const g = courseGrade(sample().assessments, 'cs');
    // 38.6 points earned; 85 needs 46.4 more from the remaining 55%.
    expect(neededFor(g, 85)).toBe(84.3);
    expect(neededFor(g, 30)).toBe(0);
    expect(neededFor({ pct: 90, marked: 100, totalWeight: 100, earned: 90 }, 85)).toBeNull();
    expect(neededFor({ pct: 40, marked: 80, totalWeight: 100, earned: 32 }, 85)).toBeGreaterThan(100);
  });
  it('turns a percent into a letter', () => {
    expect([95, 85, 84.9, 70, 44].map(letterOf)).toEqual(['A+', 'A', 'A−', 'B', 'F']);
  });
});

describe('what’s due', () => {
  it('groups by overdue, today, the rest of this week, next week and later', () => {
    const g = (due: string) => dueGroup(work('cs', 0, { due }), TODAY);
    expect(['2026-10-29', '2026-10-30', '2026-11-01', '2026-11-02', '2026-11-08', '2026-11-09', ''].map(g)).toEqual([
      'Overdue', 'Today', 'This week', 'Next week', 'Next week', 'Later', 'No date',
    ]);
  });
  it('lists open work soonest first, leaving out handed-in, marked and archived courses’ work', () => {
    expect(openWork(sample()).map((a) => a.title)).toEqual(['Late one', 'Lab 8', 'Quiz 3', 'Final']);
    expect(nextUp(sample(), 'cs', TODAY)?.title).toBe('Lab 8');
    expect(nextUp(sample(), 'ma', TODAY)?.title).toBe('Quiz 3');
  });
  it('counts down to exams', () => {
    expect(upcomingExams(sample(), TODAY).map((x) => [x.title, x.days])).toEqual([['Final', 27]]);
  });
});

describe('study time', () => {
  it('splits this week by day and course, Monday first, counting a running timer', () => {
    const learn = { ...sample(), timer: { courseId: 'ma', start: new Date(NOW.getTime() - 30 * 60000).toISOString() } };
    const week = studyWeek(learn, NOW);
    expect(week.map((d) => Math.round(d.total))).toEqual([60, 20, 50, 40, 110, 0, 0]);
    expect(week[4].byCourse).toEqual({ cs: 80, ma: 30 });
    expect(weekByCourse(sample(), NOW)).toEqual({ cs: 190, ma: 20, '': 40 });
  });
  it('totals each of the last weeks, oldest first', () => {
    expect(weeklyStudy(sample(), NOW, 3).map((w) => w.minutes)).toEqual([0, 100, 250]);
  });
  it('counts days in a row, from yesterday while today has nothing yet', () => {
    expect(studyStreak(sample(), NOW)).toBe(5);
    expect(studyStreak(sample(), new Date(2026, 9, 31, 8))).toBe(5);
    expect(studyStreak(sample(), new Date(2026, 10, 2, 8))).toBe(0);
  });
  it('formats minutes', () => {
    expect([0, 45, 60, 65, 190].map(fmtStudy)).toEqual(['0m', '45m', '1h', '1h 05m', '3h 10m']);
  });
});

describe('⌘K study log', () => {
  const cs = sample().courses;
  it('reads minutes or hours and finds the course by code or name', () => {
    expect(parseStudy('study 45 cs210', cs)).toEqual({ minutes: 45, courseId: 'cs' });
    expect(parseStudy('study 45m CS 210', cs)).toEqual({ minutes: 45, courseId: 'cs' });
    expect(parseStudy('studied 1h30 linear', cs)).toEqual({ minutes: 90, courseId: 'ma' });
    expect(parseStudy('study 1.5h algebra', cs)).toEqual({ minutes: 90, courseId: 'ma' });
    expect(parseStudy('study 2 hours', cs)).toEqual({ minutes: 120, courseId: '' });
    expect(parseStudy('study 20', cs)).toEqual({ minutes: 20, courseId: '' });
  });
  it('ignores other text, unknown or archived courses and silly lengths', () => {
    expect(parseStudy('study', cs)).toBeNull();
    expect(parseStudy('study group', cs)).toBeNull();
    expect(parseStudy('study 30 history', cs)).toBeNull();
    expect(parseStudy('study 30 old', cs)).toBeNull();
    expect(parseStudy('study 900', cs)).toBeNull();
  });
});

describe('classes', () => {
  const ev = (id: string, title: string, calendarId: string, h: number, extra: Partial<CalEvent> = {}): CalEvent => ({
    id, title, calendarId, start: new Date(2026, 9, 30, h).toISOString(), end: new Date(2026, 9, 30, h + 1).toISOString(), allDay: false, ...extra,
  });
  const events = [ev('1', 'CS210 lab', 'personal', 15), ev('2', 'Linear Algebra lecture', 'school', 9), ev('3', 'Dentist', 'personal', 11), ev('4', 'Tutorial', 'school', 12)];
  it('matches events naming a course when no calendar is chosen', () => {
    const got = classesOn(events, sample(), TODAY);
    expect(got.map((e) => [e.title, e.course?.id])).toEqual([['Linear Algebra lecture', 'ma'], ['CS210 lab', 'cs']]);
  });
  it('takes every event in the chosen calendar, skipping hidden calendars', () => {
    expect(classesOn(events, { ...sample(), calendarId: 'school' }, TODAY).map((e) => e.id)).toEqual(['2', '4']);
    expect(classesOn(events, sample(), TODAY, ['personal']).map((e) => e.id)).toEqual(['2']);
  });
});

describe('cleaning', () => {
  it('keeps good data and drops what doesn’t fit', () => {
    const dirty = {
      courses: [{ id: 'cs', name: ' Data Structures ', code: 'CS 210', color: 'red', target: 120, goalMin: -5, links: [{ name: 'Site', url: 'javascript:alert(1)' }, { name: '', url: 'https://lms.example.com' }], topics: [{ name: 'Heaps', conf: 7 }] }, { id: 'x' }],
      assessments: [{ id: 'a', courseId: 'cs', title: 'Lab', kind: 'Nope', weight: 4.25, due: 'soon', time: '25:00', status: 'done', score: 'A' }, { id: 'b', courseId: 'missing', title: 'Orphan' }],
      sessions: [{ id: 's2', courseId: 'gone', start: at(28), minutes: 30 }, { id: 's1', courseId: 'cs', start: at(27), minutes: 9999 }, { id: 's0', start: 'never', minutes: 5 }],
      side: [{ id: 'r', title: 'Rust book', unit: '', done: 50, total: 21 }],
      timer: { courseId: 'cs', start: new Date(Date.now() + 3_600_000).toISOString() },
      calendarId: 'school',
      extra: true,
    };
    const l = cleanLearn(dirty);
    expect(l.courses).toEqual([
      { id: 'cs', code: 'CS 210', name: 'Data Structures', color: '#5f8fa3', target: 100, goalMin: 0, links: [{ name: 'lms.example.com', url: 'https://lms.example.com' }], topics: [{ name: 'Heaps', conf: 1 }], archived: false },
    ]);
    expect(l.assessments).toEqual([{ id: 'a', courseId: 'cs', title: 'Lab', kind: 'Other', weight: 4.3, due: '', time: '', status: 'done', score: null }]);
    expect(l.sessions.map((s) => [s.id, s.courseId, s.minutes])).toEqual([['s1', 'cs', 720], ['s2', '', 30]]);
    expect(l.side).toEqual([{ id: 'r', title: 'Rust book', unit: 'steps', done: 21, total: 21, lastAt: null }]);
    expect(l.timer).toBeNull();
    expect(l.calendarId).toBe('school');
    expect(cleanLearn(null)).toEqual(emptyLearn());
  });
});
