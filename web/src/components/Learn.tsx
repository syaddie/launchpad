import { useEffect, useMemo, useState } from 'react';
import { DOW, addDays, dayDiff, parseYmd, startOfDay, ymd } from '../../../shared/dates';
import {
  COURSE_COLORS, DUE_GROUPS, GRADES, KINDS, SIDE_STALE_DAYS, STATUS_NAMES, classesOn, courseGrade, dueGroup, fmtStudy, letterOf, neededFor, nextUp, openWork,
  studyStreak, studyWeek, timerMinutes, upcomingExams, weekByCourse, weeklyStudy,
} from '../../../shared/learn';
import type { AppState, Assessment, AssessmentKind, AssessmentStatus, Course, Learn, SideLearning } from '../../../shared/types';
import { ago, fmtDay, hm, inMinutes, newId, shortDay } from '../util';

type Notify = (msg: string, action?: { label: string; run: () => void }) => void;

interface Props {
  data: AppState;
  now: Date;
  noteBusy: boolean;
  /** Bumped by ⌘K › Add a deliverable to open the form. */
  addSignal: number;
  onChange: (l: Learn) => void;
  onStart: (courseId: string) => void;
  onStop: () => void;
  onOpenCourse: (id: string, item?: string) => void;
  onRefreshNote: () => void;
  notify: Notify;
}

const GENERAL = 'var(--t3)';
const colorOf = (learn: Learn, id: string) => learn.courses.find((c) => c.id === id)?.color ?? GENERAL;
const short = (c: Course | undefined) => (c ? c.code || c.name : 'General');

/** Ticks every second while the timer runs, so the clock in the view moves. */
function useSecondNow(on: boolean, minuteNow: Date): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!on) return;
    setNow(new Date());
    const iv = window.setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(iv);
  }, [on]);
  return on ? now : minuteNow;
}

/** "Today 23:59", "Tomorrow", "Fri", "Mon 9 Nov" */
function dueLabel(a: Assessment, today: Date): string {
  if (!a.due) return 'No date';
  return `${shortDay(parseYmd(a.due), today)}${a.time ? ` ${a.time}` : ''}`;
}

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (min: number) => {
  const s = Math.floor(min * 60);
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
};

/** The Learn view: what's due, today's classes and exams, courses, study time and learning on the side. */
export function LearnView({ data, now: minuteNow, noteBusy, addSignal, onChange, onStart, onStop, onOpenCourse, onRefreshNote, notify }: Props) {
  const learn = data.learn;
  const now = useSecondNow(!!learn.timer, minuteNow);
  const today = startOfDay(minuteNow);
  const courses = learn.courses.filter((c) => !c.archived);
  const [adding, setAdding] = useState(false);
  const [timerCourse, setTimerCourse] = useState(courses[0]?.id ?? '');
  const pickedCourse = courses.some((c) => c.id === timerCourse) ? timerCourse : courses[0]?.id ?? '';

  useEffect(() => {
    if (addSignal) setAdding(true);
  }, [addSignal]);

  const open = openWork(learn);
  const overdue = open.filter((a) => dueGroup(a, today) === 'Overdue').length;
  const week = open.filter((a) => ['Today', 'This week'].includes(dueGroup(a, today))).length;
  const exams = upcomingExams(learn, today);
  const timer = learn.timer;
  const timerCourseObj = timer ? learn.courses.find((c) => c.id === timer.courseId) : undefined;

  return (
    <main className="you learn" aria-label="Learn">
      <div className="tr-head">
        <span className="meta">
          {courses.length
            ? [
                `${courses.length} course${courses.length > 1 ? 's' : ''}`,
                overdue ? `${overdue} overdue` : '',
                week ? `${week} due by Sunday` : '',
                exams[0] ? `first exam ${exams[0].days === 0 ? 'today' : exams[0].days === 1 ? 'tomorrow' : `in ${exams[0].days} days`}` : '',
              ].filter(Boolean).join(' · ')
            : ''}
        </span>
        <div className="tr-actions">
          {timer ? (
            <div className="ln-timer" role="status">
              <span className="ln-dot" style={{ background: 'var(--ac)' }} />
              <span style={{ fontWeight: 600 }}>Studying {timerCourseObj?.name ?? 'general'}</span>
              <span className="mono tnum">{clock(timerMinutes(timer, now))}</span>
              <button className="btn btn-ghost btn-small" style={{ color: 'var(--acd)' }} onClick={onStop}>
                <i className="ph-duotone ph-stop" />
                Stop and log
              </button>
            </div>
          ) : (
            <>
              <label className="meta" htmlFor="ln-timer-course">Study</label>
              <select id="ln-timer-course" className="input sm" value={pickedCourse} onChange={(e) => setTimerCourse(e.target.value)}>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
                <option value="">General</option>
              </select>
              <button className="btn btn-primary" onClick={() => onStart(pickedCourse)}>
                <i className="ph-duotone ph-play" />
                Start studying
              </button>
            </>
          )}
          {courses.length > 0 && (
            <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)}>
              <i className="ph-duotone ph-plus" />
              Add deliverable
            </button>
          )}
        </div>
      </div>

      {data.newsSummaries && courses.length > 0 && <LearnNoteBox state={data.learnNote} busy={noteBusy} now={minuteNow} onRefresh={onRefreshNote} />}

      {courses.length ? (
        <>
          <div className="you-row">
            <DuePanel learn={learn} today={today} adding={adding} setAdding={setAdding} onChange={onChange} onOpen={onOpenCourse} notify={notify} />
            <TodayPanel data={data} now={minuteNow} onChange={onChange} />
          </div>
          <CoursesPanel learn={learn} now={now} today={today} onChange={onChange} onOpen={onOpenCourse} />
          <div className="you-row">
            <StudyPanel learn={learn} now={now} onChange={onChange} notify={notify} />
            <SidePanel learn={learn} now={minuteNow} onChange={onChange} />
          </div>
        </>
      ) : (
        <>
          <FirstCourse learn={learn} onChange={onChange} onOpen={onOpenCourse} />
          <div className="you-row">
            <StudyPanel learn={learn} now={now} onChange={onChange} notify={notify} />
            <SidePanel learn={learn} now={minuteNow} onChange={onChange} />
          </div>
        </>
      )}
    </main>
  );
}

// ---------- Claude's note ----------

function LearnNoteBox({ state, busy, now, onRefresh }: { state: AppState['learnNote']; busy: boolean; now: Date; onRefresh: () => void }) {
  const { note, error } = state;
  return (
    <section className="panel you-panel tr-note" aria-label="The week ahead" aria-busy={busy}>
      <div className="panel-head">
        <span className="sec-label">The week ahead</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {note && <span className="meta">{busy ? 'Writing a new one…' : `Written by Claude ${ago(note.writtenAt, now)}`}</span>}
          <button className="icon-btn" title="Write a new note" disabled={busy} onClick={onRefresh}>
            <i className={'ph-duotone ph-arrows-clockwise' + (busy ? ' spin' : '')} />
          </button>
        </div>
      </div>
      {note ? (
        <>
          <p className="serif tr-note-head">{note.headline}</p>
          {note.points.length > 0 && (
            <ul className="tr-note-points">
              {note.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </>
      ) : busy || !error ? (
        <p className="meta">{busy ? 'Reading your courses and writing a note…' : 'A short note on what’s coming up appears here once a day.'}</p>
      ) : null}
      {error && !busy && <p className="meta" style={{ color: 'var(--wn)' }}>{error}</p>}
    </section>
  );
}

// ---------- first run ----------

function FirstCourse({ learn, onChange, onOpen }: { learn: Learn; onChange: (l: Learn) => void; onOpen: (id: string) => void }) {
  return (
    <section className="panel you-panel" aria-label="Add your courses">
      <div className="panel-head">
        <h2 className="panel-title">Add your courses</h2>
      </div>
      <p style={{ margin: 0, color: 'var(--t2)', maxWidth: '64ch', textWrap: 'pretty' }}>
        Add each course with its assignments, quizzes and exams and how much each one counts. Learn then shows what’s due, your grade so far against a target, a countdown to each exam and
        how much you’ve studied. Classes come from your Google Calendar.
      </p>
      <CourseForm learn={learn} onChange={onChange} onAdded={onOpen} />
    </section>
  );
}

function CourseForm({ learn, onChange, onAdded, onCancel }: { learn: Learn; onChange: (l: Learn) => void; onAdded: (id: string) => void; onCancel?: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const used = new Set(learn.courses.filter((c) => !c.archived).map((c) => c.color));
  const add = () => {
    if (!name.trim()) return;
    const course: Course = {
      id: newId('co'),
      code: code.trim(),
      name: name.trim(),
      color: COURSE_COLORS.find((c) => !used.has(c)) ?? COURSE_COLORS[learn.courses.length % COURSE_COLORS.length],
      target: 0,
      goalMin: 0,
      links: [],
      topics: [],
      archived: false,
    };
    onChange({ ...learn, courses: [...learn.courses, course] });
    setName('');
    setCode('');
    onAdded(course.id);
  };
  return (
    <form
      className="ln-form"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
      onKeyDown={(e) => e.key === 'Escape' && onCancel && (e.stopPropagation(), onCancel())}
    >
      <label className="field" style={{ flex: '2 1 220px' }}>
        Course name
        <input className="input sm" autoFocus={!!onCancel} placeholder="Data Structures" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field" style={{ flex: '1 1 110px' }}>
        Code (optional)
        <input className="input sm" placeholder="CS 210" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="ln-form-btns">
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn btn-primary btn-small" disabled={!name.trim()}>
          Add course
        </button>
      </div>
    </form>
  );
}

// ---------- due soon ----------

function DuePanel({ learn, today, adding, setAdding, onChange, onOpen, notify }: {
  learn: Learn;
  today: Date;
  adding: boolean;
  setAdding: (v: boolean) => void;
  onChange: (l: Learn) => void;
  onOpen: (courseId: string, item?: string) => void;
  notify: Notify;
}) {
  const [filter, setFilter] = useState('all');
  // Ticked off in this visit: they stay, struck through, so a slip is easy to see and undo.
  const [ticked, setTicked] = useState<string[]>([]);
  const courses = learn.courses.filter((c) => !c.archived);
  const byId = new Map(courses.map((c) => [c.id, c]));
  const shown = learn.assessments
    .filter((a) => byId.has(a.courseId) && ((a.status !== 'done' && a.score === null) || ticked.includes(a.id)))
    .filter((a) => filter === 'all' || a.courseId === filter)
    .sort((x, y) => ((x.due || '9999') + (x.time || '99') < (y.due || '9999') + (y.time || '99') ? -1 : 1));
  const groups = DUE_GROUPS.map((g) => ({ g, items: shown.filter((a) => dueGroup(a, today) === g) })).filter((x) => x.items.length);

  const setStatus = (a: Assessment, status: AssessmentStatus) =>
    onChange({ ...learn, assessments: learn.assessments.map((x) => (x.id === a.id ? { ...x, status } : x)) });

  const toggle = (a: Assessment) => {
    if (a.status === 'done') {
      setStatus(a, 'doing');
      setTicked((t) => t.filter((x) => x !== a.id));
      return;
    }
    const before = a.status;
    setStatus(a, 'done');
    setTicked((t) => [...t, a.id]);
    notify(`Handed in “${a.title}”`, { label: 'Undo', run: () => (setStatus(a, before), setTicked((t) => t.filter((x) => x !== a.id))) });
  };

  return (
    <section className="panel you-panel ln-due" aria-label="Due soon">
      <div className="panel-head" style={{ flexWrap: 'wrap' }}>
        <h2 className="panel-title">Due soon</h2>
        <div className="ln-tabs" role="group" aria-label="Course">
          {[{ id: 'all', label: 'All' }, ...courses.map((c) => ({ id: c.id, label: short(c) }))].map((f) => (
            <button key={f.id} className={'ln-tab' + (filter === f.id ? ' on' : '')} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      {adding && (
        <AddWork
          learn={learn}
          courseId={filter === 'all' ? courses[0]?.id ?? '' : filter}
          today={today}
          onAdd={(a) => onChange({ ...learn, assessments: [...learn.assessments, a] })}
          onClose={() => setAdding(false)}
        />
      )}
      <div className="ln-groups">
        {groups.map(({ g, items }) => (
          <div key={g}>
            <div className={'ln-group' + (g === 'Overdue' ? ' warn' : '')}>
              {g} <span>{items.length}</span>
            </div>
            {items.map((a) => {
              const done = a.status === 'done';
              const late = g === 'Overdue' && !done;
              const c = byId.get(a.courseId);
              return (
                <div key={a.id} className={'ln-due-row' + (done ? ' done' : '')}>
                  <button className={'check' + (done ? ' on' : '')} aria-label={`${done ? 'Not handed in' : 'Handed in'}: ${a.title}`} aria-pressed={done} onClick={() => toggle(a)}>
                    {done && <i className="ph-bold ph-check" />}
                  </button>
                  <button className="ln-due-body" title="Open the course" onClick={() => onOpen(a.courseId, a.id)}>
                    <span className="ln-due-title">{a.title}</span>
                    <span className="ln-due-meta">
                      <span className="ln-dot" style={{ background: c?.color }} />
                      {c?.name} · {a.kind}
                      {a.weight ? ` · ${a.weight}%` : ''}
                    </span>
                  </button>
                  <span className="ln-due-right">
                    <span className={'tnum ln-due-when' + (late ? ' warn' : g === 'Today' && !done ? ' soon' : '')}>{dueLabel(a, today)}</span>
                    <span className={'chip ' + (done ? 'chip-accent' : late ? 'chip-warn' : 'chip-neutral')}>{STATUS_NAMES[a.status]}</span>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {!groups.length && !adding && (
          <div className="empty" style={{ padding: 0 }}>
            <p>{filter === 'all' ? 'Nothing due. Add assignments, quizzes and exams here or in each course.' : 'Nothing due in this course.'}</p>
            <button className="btn btn-secondary btn-small" onClick={() => setAdding(true)}>
              <i className="ph-duotone ph-plus" />
              Add deliverable
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

/** The add form for a piece of work: course, title, kind, weight, due date and time. */
function AddWork({ learn, courseId, today, onAdd, onClose }: { learn: Learn; courseId: string; today: Date; onAdd: (a: Assessment) => void; onClose: () => void }) {
  const courses = learn.courses.filter((c) => !c.archived);
  const [d, setD] = useState({ courseId, title: '', kind: 'Assignment' as AssessmentKind, weight: '', due: ymd(addDays(today, 7)), time: '' });
  const save = () => {
    if (!d.title.trim() || !d.courseId) return;
    onAdd({ id: newId('as'), courseId: d.courseId, title: d.title.trim(), kind: d.kind, weight: Number(d.weight) || 0, due: d.due, time: d.time, status: 'todo', score: null });
    setD({ ...d, title: '', weight: '' });
  };
  return (
    <form
      className="ln-form ln-add"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
    >
      <label className="field" style={{ flex: '2 1 220px' }}>
        What’s due
        <input className="input sm" autoFocus placeholder="Problem set 5" value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 150px' }}>
        Course
        <select className="input sm" value={d.courseId} onChange={(e) => setD({ ...d, courseId: e.target.value })}>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label className="field" style={{ flex: '1 1 120px' }}>
        Kind
        <select className="input sm" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as AssessmentKind })}>
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label className="field" style={{ flex: '0 1 90px' }}>
        % of grade
        <input className="input sm tnum" type="number" min={0} max={100} step="any" placeholder="10" value={d.weight} onChange={(e) => setD({ ...d, weight: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '0 1 150px' }}>
        Due
        <input className="input sm" type="date" value={d.due} onChange={(e) => setD({ ...d, due: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '0 1 110px' }}>
        Time (optional)
        <input className="input sm" type="time" value={d.time} onChange={(e) => setD({ ...d, time: e.target.value })} />
      </label>
      <div className="ln-form-btns">
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          Done
        </button>
        <button className="btn btn-primary btn-small" disabled={!d.title.trim()}>
          Add
        </button>
      </div>
    </form>
  );
}

// ---------- classes and exams ----------

function TodayPanel({ data, now, onChange }: { data: AppState; now: Date; onChange: (l: Learn) => void }) {
  const learn = data.learn;
  const today = startOfDay(now);
  const classes = classesOn(data.events, learn, today, data.prefs.hiddenCalendars);
  const tomorrow = classesOn(data.events, learn, addDays(today, 1), data.prefs.hiddenCalendars);
  const next = classes.find((e) => new Date(e.end) > now);
  const exams = upcomingExams(learn, today);
  const byId = new Map(learn.courses.map((c) => [c.id, c]));
  const calColor = new Map(data.calendars.map((c) => [c.id, c.color]));
  const connected = data.google.connected && data.prefs.sources.calendar;

  return (
    <section className="panel you-panel ln-today" aria-label="Classes and exams">
      <div className="panel-head">
        <h2 className="panel-title">Today</h2>
        {connected && (
          <label className="meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Classes from
            <select className="ln-mini-select" value={learn.calendarId} onChange={(e) => onChange({ ...learn, calendarId: e.target.value })}>
              <option value="">Events naming a course</option>
              {data.calendars.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {connected ? (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {classes.map((e) => {
            const s = new Date(e.start);
            const end = new Date(e.end);
            const isNext = e === next;
            const past = end <= now;
            const live = s <= now && now < end;
            return (
              <div key={e.id} className={'ln-class' + (isNext ? ' next' : '') + (past ? ' past' : '')}>
                <span className="tnum ln-class-time">
                  <span>{hm(s)}</span>
                  <span>{hm(end)}</span>
                </span>
                <span className="ln-dot" style={{ marginTop: 6, background: e.course?.color ?? calColor.get(e.calendarId) ?? GENERAL }} />
                <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span style={{ fontWeight: isNext ? 600 : 400 }}>{e.title}</span>
                  {(e.location || e.conferenceType) && <span className="meta">{[e.location, e.conferenceType].filter(Boolean).join(' · ')}</span>}
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                  {isNext && (
                    <span className="ln-class-when">{live ? `now · ends ${hm(end)}` : inMinutes(Math.max(1, Math.round((s.getTime() - now.getTime()) / 60000)))}</span>
                  )}
                  {isNext && e.conferenceUrl && (
                    <a className="btn btn-primary btn-small" href={e.conferenceUrl} target="_blank" rel="noopener noreferrer">
                      <i className="ph-duotone ph-video-camera" />
                      Join
                    </a>
                  )}
                </span>
              </div>
            );
          })}
          {!classes.length && <p className="meta" style={{ margin: '4px 0' }}>{learn.calendarId ? 'No classes today.' : 'No classes today. Events whose title has a course’s name or code show here.'}</p>}
          <p className="meta" style={{ margin: '8px 0 0' }}>
            <b style={{ color: 'var(--t2)' }}>Tomorrow</b>
            {'  '}
            {tomorrow.length ? tomorrow.map((e) => `${hm(new Date(e.start))} ${e.course ? short(e.course) : e.title}`).join(' · ') : 'no classes'}
          </p>
        </div>
      ) : (
        <p className="meta" style={{ margin: 0 }}>Connect Google Calendar in Settings to see today’s classes here.</p>
      )}
      <div className="ln-rule" />
      <div className="panel-head">
        <h3 className="panel-title" style={{ fontSize: 16 }}>Exams</h3>
      </div>
      {exams.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {exams.slice(0, 6).map((x) => (
            <div key={x.id} className="ln-exam">
              <span className="ln-dot" style={{ background: byId.get(x.courseId)?.color }} />
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{x.title}</span>
                <span className="meta tnum">
                  {short(byId.get(x.courseId))} · {fmtDay(parseYmd(x.due))}
                  {x.time ? ` · ${x.time}` : ''}
                  {x.weight ? ` · ${x.weight}%` : ''}
                </span>
              </span>
              <span className="ln-exam-days">
                {x.days > 1 ? (
                  <>
                    <span className="serif tnum">{x.days}</span>
                    <span className="meta">days</span>
                  </>
                ) : (
                  <span className="serif" style={{ fontSize: 18, color: 'var(--acd)' }}>{x.days ? 'Tomorrow' : 'Today'}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="meta" style={{ margin: 0 }}>Add an exam to a course (kind “Exam”) to count down to it here.</p>
      )}
    </section>
  );
}

// ---------- courses ----------

function CoursesPanel({ learn, now, today, onChange, onOpen }: { learn: Learn; now: Date; today: Date; onChange: (l: Learn) => void; onOpen: (id: string) => void }) {
  const [adding, setAdding] = useState(false);
  const courses = learn.courses.filter((c) => !c.archived);
  const archived = learn.courses.length - courses.length;
  const studied = weekByCourse(learn, now);
  return (
    <section className="panel you-panel" aria-label="Courses">
      <div className="panel-head" style={{ flexWrap: 'wrap' }}>
        <h2 className="panel-title">Courses</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span className="meta">{archived ? `${archived} archived · ` : ''}Grades from what’s marked so far</span>
          <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)}>
            <i className="ph-duotone ph-plus" />
            Add course
          </button>
        </div>
      </div>
      {adding && <CourseForm learn={learn} onChange={onChange} onAdded={(id) => (setAdding(false), onOpen(id))} onCancel={() => setAdding(false)} />}
      <div className="ln-courses">
        {courses.map((c) => {
          const g = courseGrade(learn.assessments, c.id);
          const mins = studied[c.id] ?? 0;
          const next = nextUp(learn, c.id, today);
          const under = g.pct !== null && c.target > 0 && g.pct < c.target;
          return (
            <button key={c.id} className="ln-card" onClick={() => onOpen(c.id)}>
              <span className="ln-card-top">
                <span className="ln-dot" style={{ background: c.color }} />
                {c.code && <span className="mono meta">{c.code}</span>}
              </span>
              <span className="serif ln-card-name">{c.name}</span>
              {g.pct !== null ? (
                <span className="ln-card-grade">
                  <span className="serif tnum">{g.pct}%</span>
                  <span className="chip chip-neutral">{letterOf(g.pct)}</span>
                  {c.target > 0 && (
                    <span className={'ln-vs' + (under ? ' warn' : '')}>
                      target {letterOf(c.target)} · {under ? `${Math.round((c.target - g.pct) * 10) / 10} pts under` : 'on track'}
                    </span>
                  )}
                </span>
              ) : (
                <span className="meta" style={{ minHeight: 32, display: 'flex', alignItems: 'center' }}>Nothing marked yet</span>
              )}
              <span className="ln-bar-wrap">
                <span className="ln-track">
                  <span style={{ width: `${Math.min(100, g.marked)}%`, background: 'var(--t3)', opacity: 0.55 }} />
                </span>
                <span className="meta">{g.marked}% of the grade marked</span>
              </span>
              <span className="ln-bar-wrap">
                <span className="ln-track">
                  <span style={{ width: `${c.goalMin ? Math.min(100, (mins / c.goalMin) * 100) : 0}%`, background: c.color }} />
                </span>
                <span className="meta tnum">{fmtStudy(mins)}{c.goalMin ? ` of ${fmtStudy(c.goalMin)}` : ''} study this week</span>
              </span>
              <span className="ln-card-next">Next: {next ? `${next.title} · ${dueLabel(next, today)}` : 'nothing due'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ---------- study time ----------

function StudyPanel({ learn, now, onChange, notify }: { learn: Learn; now: Date; onChange: (l: Learn) => void; notify: Notify }) {
  const [logging, setLogging] = useState(false);
  const days = studyWeek(learn, now);
  const weeks = weeklyStudy(learn, now, 12);
  const streak = studyStreak(learn, now);
  const today = startOfDay(now);
  const courses = learn.courses.filter((c) => !c.archived);
  const total = days.reduce((s, d) => s + d.total, 0);
  const goal = courses.reduce((s, c) => s + c.goalMin, 0);
  const todayMin = days.find((d) => dayDiff(d.date, today) === 0)?.total ?? 0;
  const top = Math.max(60, ...days.map((d) => d.total));
  const topWeek = Math.max(60, ...weeks.map((w) => w.minutes));
  const byCourse = weekByCourse(learn, now);
  const order = [...courses.map((c) => c.id), ''];
  const recent = [...learn.sessions].reverse().slice(0, 5);
  const byId = new Map(learn.courses.map((c) => [c.id, c]));

  const remove = (id: string) => {
    const before = learn;
    onChange({ ...learn, sessions: learn.sessions.filter((s) => s.id !== id) });
    notify('Removed a study session', { label: 'Undo', run: () => onChange(before) });
  };

  return (
    <section className="panel you-panel ln-study" aria-label="Study time">
      <div className="panel-head">
        <h2 className="panel-title">Study time</h2>
        <button className="btn btn-ghost btn-small" onClick={() => setLogging((v) => !v)}>
          <i className="ph-duotone ph-plus" />
          Log time
        </button>
      </div>
      {logging && <LogTime learn={learn} today={today} onChange={onChange} onClose={() => setLogging(false)} />}
      <div className="tr-totals">
        <span>
          <b className="tnum">{fmtStudy(total)}</b>
          {goal ? `of ${fmtStudy(goal)} this week` : 'this week'}
        </span>
        <span>
          <b className="tnum">{streak} day{streak === 1 ? '' : 's'}</b>
          in a row
        </span>
        <span>
          <b className="tnum">{fmtStudy(todayMin)}</b>
          today
        </span>
      </div>
      <div className="ln-days" role="img" aria-label={`Study by day this week: ${days.map((d) => `${DOW[d.date.getDay()]} ${d.total ? fmtStudy(d.total) : 'none'}`).join(', ')}`}>
        {days.map((d) => {
          const o = dayDiff(today, d.date);
          return (
            <div key={d.date.getTime()} className={'ln-day' + (o === 0 ? ' today' : o > 0 ? ' ahead' : '')}>
              <span className="meta tnum">{d.total ? fmtStudy(d.total) : ''}</span>
              <span className="ln-day-col">
                {order.filter((k) => d.byCourse[k]).map((k) => (
                  <span key={k} style={{ height: `${(d.byCourse[k] / top) * 100}%`, background: colorOf(learn, k) }} />
                ))}
              </span>
              <span className="ln-day-label">{o === 0 ? 'Today' : DOW[d.date.getDay()]}</span>
            </div>
          );
        })}
      </div>
      <div className="ln-legend">
        {order.filter((k) => byCourse[k] || (k && byId.get(k))).map((k) => (
          <span key={k}>
            <span className="ln-dot" style={{ background: colorOf(learn, k) }} />
            {k ? byId.get(k)?.name : 'General'} <span className="tnum" style={{ color: 'var(--t3)' }}>{fmtStudy(byCourse[k] ?? 0)}</span>
          </span>
        ))}
      </div>
      <div className="ln-weeks-wrap">
        <span className="meta">Hours a week, last 12 weeks</span>
        <div className="ln-weeks" role="img" aria-label={`Hours a week, oldest first: ${weeks.map((w) => Math.round(w.minutes / 6) / 10).join(', ')}`}>
          {weeks.map((w, i) => (
            <span key={w.start.getTime()} title={`Week of ${fmtDay(w.start)}: ${fmtStudy(w.minutes)}`} className={i === weeks.length - 1 ? 'now' : ''} style={{ height: `${Math.max(2, (w.minutes / topWeek) * 100)}%` }} />
          ))}
        </div>
      </div>
      {recent.length > 0 && (
        <div className="ln-sessions">
          <span className="meta">Recent sessions</span>
          {recent.map((s) => {
            const at = new Date(s.start);
            return (
              <div key={s.id} className="ln-session">
                <span className="ln-dot" style={{ background: colorOf(learn, s.courseId) }} />
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.courseId ? byId.get(s.courseId)?.name ?? 'Removed course' : 'General'}</span>
                <span className="meta tnum">{shortDay(at, today)} {hm(at)}</span>
                <span className="tnum" style={{ textAlign: 'right', fontWeight: 600 }}>{fmtStudy(s.minutes)}</span>
                <button className="icon-btn" title="Remove this session" aria-label="Remove this session" onClick={() => remove(s.id)}>
                  <i className="ph-duotone ph-x" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function LogTime({ learn, today, onChange, onClose }: { learn: Learn; today: Date; onChange: (l: Learn) => void; onClose: () => void }) {
  const courses = learn.courses.filter((c) => !c.archived);
  const [d, setD] = useState({ courseId: courses[0]?.id ?? '', minutes: '', date: ymd(today) });
  const save = () => {
    const minutes = Math.round(Number(d.minutes));
    if (!minutes || minutes < 1) return;
    const now = new Date();
    // Today's goes in at the time it was logged, minus its length; an earlier day's at noon.
    const start = d.date === ymd(now) ? new Date(now.getTime() - minutes * 60000) : new Date(`${d.date}T12:00:00`);
    const sessions = [...learn.sessions, { id: newId('ss'), courseId: d.courseId, start: start.toISOString(), minutes }].sort((a, b) => a.start.localeCompare(b.start));
    onChange({ ...learn, sessions });
    onClose();
  };
  return (
    <form
      className="ln-form"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}
    >
      <label className="field" style={{ flex: '1 1 150px' }}>
        Course
        <select className="input sm" value={d.courseId} onChange={(e) => setD({ ...d, courseId: e.target.value })}>
          {courses.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
          <option value="">General</option>
        </select>
      </label>
      <label className="field" style={{ flex: '0 1 100px' }}>
        Minutes
        <input className="input sm tnum" type="number" min={1} max={720} autoFocus placeholder="45" value={d.minutes} onChange={(e) => setD({ ...d, minutes: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '0 1 150px' }}>
        Day
        <input className="input sm" type="date" max={ymd(today)} value={d.date} onChange={(e) => setD({ ...d, date: e.target.value })} />
      </label>
      <div className="ln-form-btns">
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary btn-small" disabled={!Number(d.minutes)}>
          Log
        </button>
      </div>
    </form>
  );
}

// ---------- on the side ----------

type SideDraft = { id: string | null; title: string; unit: string; done: string; total: string };

function SidePanel({ learn, now, onChange }: { learn: Learn; now: Date; onChange: (l: Learn) => void }) {
  const [draft, setDraft] = useState<SideDraft | null>(null);
  const today = startOfDay(now);
  const save = () => {
    if (!draft || !draft.title.trim()) return;
    const total = Math.max(1, Math.round(Number(draft.total) || 1));
    const item = { title: draft.title.trim(), unit: draft.unit.trim() || 'steps', total, done: Math.min(total, Math.max(0, Math.round(Number(draft.done) || 0))) };
    onChange({
      ...learn,
      side: draft.id ? learn.side.map((s) => (s.id === draft.id ? { ...s, ...item } : s)) : [...learn.side, { id: newId('sd'), lastAt: null, ...item }],
    });
    setDraft(null);
  };
  const bump = (s: SideLearning) => onChange({ ...learn, side: learn.side.map((x) => (x.id === s.id ? { ...x, done: Math.min(x.total, x.done + 1), lastAt: new Date().toISOString() } : x)) });

  return (
    <section className="panel you-panel ln-side" aria-label="Learning on the side">
      <div className="panel-head">
        <h2 className="panel-title">On the side</h2>
        <button className="btn btn-ghost btn-small" onClick={() => setDraft({ id: null, title: '', unit: 'lessons', done: '0', total: '' })}>
          <i className="ph-duotone ph-plus" />
          Add
        </button>
      </div>
      {draft && !draft.id && <SideForm draft={draft} onDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} />}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {learn.side.map((s) =>
          draft?.id === s.id ? (
            <SideForm
              key={s.id}
              draft={draft}
              onDraft={setDraft}
              onSave={save}
              onCancel={() => setDraft(null)}
              onDelete={() => {
                onChange({ ...learn, side: learn.side.filter((x) => x.id !== s.id) });
                setDraft(null);
              }}
            />
          ) : (
            <div key={s.id} className="ln-side-row">
              <button className="ln-side-body" title="Edit" onClick={() => setDraft({ id: s.id, title: s.title, unit: s.unit, done: String(s.done), total: String(s.total) })}>
                <span style={{ fontWeight: 500 }}>{s.title}</span>
                <span className="ln-track">
                  <span style={{ width: `${(s.done / s.total) * 100}%`, background: s.done >= s.total ? 'var(--acd)' : 'var(--ac)' }} />
                </span>
                <span className="meta tnum">
                  {s.done} of {s.total} {s.unit} · <SideSince s={s} today={today} />
                </span>
              </button>
              <button className="btn btn-secondary btn-small" disabled={s.done >= s.total} aria-label={`One more of ${s.title}`} onClick={() => bump(s)}>
                +1
              </button>
            </div>
          ),
        )}
        {!learn.side.length && !draft && <p className="meta" style={{ margin: 0 }}>Books, online courses, a language: anything you’re learning outside class, with how far through you are.</p>}
      </div>
      {learn.side.length > 0 && <p className="meta" style={{ margin: 0 }}>Turns orange after {SIDE_STALE_DAYS} days without progress.</p>}
    </section>
  );
}

function SideSince({ s, today }: { s: SideLearning; today: Date }) {
  if (s.done >= s.total) return <span style={{ color: 'var(--acd)', fontWeight: 600 }}>finished</span>;
  if (!s.lastAt) return <span>not started</span>;
  const days = dayDiff(new Date(s.lastAt), today);
  const text = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  return <span style={days >= SIDE_STALE_DAYS ? { color: 'var(--wn)', fontWeight: 600 } : undefined}>last {text}</span>;
}

function SideForm({ draft, onDraft, onSave, onCancel, onDelete }: { draft: SideDraft; onDraft: (d: SideDraft) => void; onSave: () => void; onCancel: () => void; onDelete?: () => void }) {
  return (
    <form
      className="ln-form"
      style={{ margin: '6px 0' }}
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onCancel())}
    >
      <label className="field" style={{ flex: '1 1 100%' }}>
        What you’re learning
        <input className="input sm" autoFocus placeholder="The Rust book" value={draft.title} onChange={(e) => onDraft({ ...draft, title: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 70px' }}>
        Done
        <input className="input sm tnum" type="number" min={0} value={draft.done} onChange={(e) => onDraft({ ...draft, done: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 70px' }}>
        Of
        <input className="input sm tnum" type="number" min={1} placeholder="20" value={draft.total} onChange={(e) => onDraft({ ...draft, total: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 100px' }}>
        Counted in
        <input className="input sm" placeholder="chapters" value={draft.unit} onChange={(e) => onDraft({ ...draft, unit: e.target.value })} />
      </label>
      <div className="ln-form-btns">
        {onDelete && (
          <button type="button" className="btn btn-ghost btn-small" style={{ color: 'var(--wn)', marginRight: 'auto' }} onClick={onDelete}>
            Remove
          </button>
        )}
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn btn-primary btn-small" disabled={!draft.title.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}

// ---------- course drawer ----------

export function CourseDrawer({ learn, courseId, focusItem, now, onChange, onClose, notify }: {
  learn: Learn;
  courseId: string;
  focusItem?: string;
  now: Date;
  onChange: (l: Learn) => void;
  onClose: () => void;
  notify: Notify;
}) {
  const course = learn.courses.find((c) => c.id === courseId);
  const [open, setOpen] = useState<string | null>(focusItem ?? null);
  const [adding, setAdding] = useState(false);
  const [topic, setTopic] = useState('');
  const [link, setLink] = useState({ name: '', url: '' });
  const today = startOfDay(now);
  const items = useMemo(
    () => learn.assessments.filter((a) => a.courseId === courseId).sort((x, y) => ((x.due || '9999') + x.time < (y.due || '9999') + y.time ? -1 : 1)),
    [learn.assessments, courseId],
  );
  useEffect(() => {
    if (focusItem) document.getElementById(`ln-item-${focusItem}`)?.scrollIntoView({ block: 'center' });
  }, [focusItem]);
  if (!course) return null;

  const g = courseGrade(learn.assessments, course.id);
  const need = course.target ? neededFor(g, course.target) : null;
  const patch = (p: Partial<Course>) => onChange({ ...learn, courses: learn.courses.map((c) => (c.id === course.id ? { ...c, ...p } : c)) });
  const patchItem = (id: string, p: Partial<Assessment>) => onChange({ ...learn, assessments: learn.assessments.map((a) => (a.id === id ? { ...a, ...p } : a)) });
  const removeItem = (a: Assessment) => {
    const before = learn;
    onChange({ ...learn, assessments: learn.assessments.filter((x) => x.id !== a.id) });
    notify(`Removed “${a.title}”`, { label: 'Undo', run: () => onChange(before) });
  };
  const studied = weekByCourse(learn, now)[course.id] ?? 0;
  const weeks = courseWeeks(learn, now, course.id);
  const topWeek = Math.max(course.goalMin, 60, ...weeks.map((w) => w.minutes));
  const termMin = learn.sessions.filter((s) => s.courseId === course.id).reduce((s, x) => s + x.minutes, 0);

  return (
    <>
      <div className="drawer-section">
        <label className="field">
          Name
          <input className="input" style={{ fontSize: 15, fontWeight: 500 }} value={course.name} onChange={(e) => patch({ name: e.target.value })} />
        </label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: '1 1 120px' }}>
            Code
            <input className="input sm mono" placeholder="CS 210" value={course.code} onChange={(e) => patch({ code: e.target.value })} />
          </label>
          <div className="field" style={{ flex: '2 1 200px' }}>
            Colour
            <div className="ln-swatches" role="radiogroup" aria-label="Colour">
              {COURSE_COLORS.map((c) => (
                <button key={c} role="radio" aria-checked={course.color === c} aria-label={c} className={'ln-swatch' + (course.color === c ? ' on' : '')} style={{ background: c }} onClick={() => patch({ color: c })} />
              ))}
            </div>
          </div>
        </div>
        {course.links.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {course.links.map((l, i) => (
              <span key={i} className="ln-link">
                <a className="btn btn-secondary btn-small" href={l.url} target="_blank" rel="noopener noreferrer">
                  {l.name}
                  <i className="ph-duotone ph-arrow-up-right" />
                </a>
                <button className="icon-btn" aria-label={`Remove the link ${l.name}`} title="Remove" onClick={() => patch({ links: course.links.filter((_, j) => j !== i) })}>
                  <i className="ph-duotone ph-x" />
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          className="ln-inline"
          onSubmit={(e) => {
            e.preventDefault();
            const url = /^https?:\/\//i.test(link.url.trim()) ? link.url.trim() : `https://${link.url.trim()}`;
            if (!link.url.trim()) return;
            patch({ links: [...course.links, { name: link.name.trim() || new URL(url).host, url }] });
            setLink({ name: '', url: '' });
          }}
        >
          <input className="input sm" style={{ flex: '1 1 100px' }} placeholder="Link name" aria-label="Link name" value={link.name} onChange={(e) => setLink({ ...link, name: e.target.value })} />
          <input className="input sm" style={{ flex: '2 1 160px' }} placeholder="Course site, recordings…" aria-label="Link address" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} />
          <button className="btn btn-secondary btn-small" disabled={!link.url.trim()}>
            <i className="ph-duotone ph-link-simple" />
            Add link
          </button>
        </form>
      </div>

      <div className="drawer-section">
        <span className="drawer-label">Grade</span>
        <div className="ln-card-grade">
          <span className="serif tnum" style={{ fontSize: 40 }}>{g.pct !== null ? `${g.pct}%` : '–'}</span>
          {g.pct !== null && <span className="chip chip-neutral">{letterOf(g.pct)}</span>}
          <span className="meta">{g.pct !== null ? `from the ${g.marked}% marked so far` : 'Nothing marked yet'}</span>
        </div>
        <span className="ln-track" style={{ height: 8 }} role="img" aria-label={`${g.marked}% of the grade marked`}>
          <span style={{ width: `${Math.min(100, g.marked)}%`, background: 'var(--ac)' }} />
        </span>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t2)' }}>
            Aim for
            <select className="input sm" value={course.target} onChange={(e) => patch({ target: Number(e.target.value) })}>
              <option value={0}>No target</option>
              {GRADES.filter(([, p]) => p > 0).map(([l, p]) => (
                <option key={l} value={p}>{l} ({p}%)</option>
              ))}
            </select>
          </label>
        </div>
        {course.target > 0 && (
          <p className="ln-need">
            {need === null
              ? g.pct !== null && g.pct >= course.target
                ? `Everything’s marked: you finished on ${letterOf(g.pct)}.`
                : 'Everything’s marked.'
              : need === 0
                ? `You’ve already got ${letterOf(course.target)}, even with zero on what’s left.`
                : need > 100
                  ? `${letterOf(course.target)} is out of reach now: it would take ${need}% on the remaining ${Math.round((100 - g.marked) * 10) / 10}%.`
                  : (
                    <>
                      To finish with <b>{letterOf(course.target)}</b> ({course.target}%), you need an average of <b className="tnum">{need}%</b> on the remaining {Math.round((100 - g.marked) * 10) / 10}% of the grade.
                    </>
                  )}
          </p>
        )}
        {g.totalWeight !== 100 && items.length > 0 && (
          <p className="meta" style={{ margin: 0 }}>The weights below add up to {g.totalWeight}%. The grade maths counts the course as 100%.</p>
        )}
      </div>

      <div className="drawer-section" style={{ gap: 0 }}>
        <div className="split" style={{ paddingBottom: 6 }}>
          <span className="drawer-label">Assessments</span>
          <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)}>
            <i className="ph-duotone ph-plus" />
            Add
          </button>
        </div>
        {adding && (
          <AddWork
            learn={learn}
            courseId={course.id}
            today={today}
            onAdd={(a) => onChange({ ...learn, assessments: [...learn.assessments, a] })}
            onClose={() => setAdding(false)}
          />
        )}
        {items.map((a) =>
          open === a.id ? (
            <ItemEditor key={a.id} a={a} onPatch={(p) => patchItem(a.id, p)} onRemove={() => removeItem(a)} onClose={() => setOpen(null)} />
          ) : (
            <button key={a.id} id={`ln-item-${a.id}`} className="ln-arow" onClick={() => setOpen(a.id)}>
              <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                <span style={{ fontWeight: 500 }}>{a.title}</span>
                <span className="meta">
                  {a.kind} · {a.due ? dueLabel(a, today) : 'no date'}
                </span>
              </span>
              <span className="tnum" style={{ color: 'var(--t2)', textAlign: 'right' }}>{a.weight}%</span>
              <span className="tnum" style={{ textAlign: 'right', fontWeight: a.score !== null ? 600 : 400, color: a.score !== null ? 'var(--tx)' : 'var(--t3)' }}>
                {a.score !== null ? `${a.score}%` : '–'}
              </span>
              <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <span className={'chip ' + (a.score !== null ? 'chip-accent' : a.status !== 'done' && a.due && dayDiff(today, parseYmd(a.due)) < 0 ? 'chip-warn' : 'chip-neutral')}>
                  {a.score !== null ? 'Marked' : STATUS_NAMES[a.status]}
                </span>
              </span>
            </button>
          ),
        )}
        {!items.length && !adding && <p className="meta" style={{ margin: 0 }}>Add each assignment, quiz and exam with how much of the grade it’s worth, then its score once it’s marked.</p>}
      </div>

      <div className="drawer-section">
        <div className="split">
          <span className="drawer-label">Study time</span>
          <label className="meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            Goal
            <input
              className="input sm tnum"
              style={{ width: 64 }}
              type="number"
              min={0}
              max={60}
              step={0.5}
              aria-label="Study goal, hours a week"
              value={course.goalMin ? course.goalMin / 60 : ''}
              placeholder="0"
              onChange={(e) => patch({ goalMin: Math.round((Number(e.target.value) || 0) * 60) })}
            />
            h a week
          </label>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="serif tnum" style={{ fontSize: 24 }}>{fmtStudy(studied)}</span>
          <span style={{ fontSize: 13, color: 'var(--t2)' }}>this week · {fmtStudy(termMin)} logged in all</span>
        </div>
        <div className="ln-weeks tall" role="img" aria-label={`Hours a week for the last 8 weeks, oldest first: ${weeks.map((w) => Math.round(w.minutes / 6) / 10).join(', ')}`}>
          {course.goalMin > 0 && <span className="ln-goal" style={{ bottom: `${(course.goalMin / topWeek) * 100}%` }} />}
          {weeks.map((w, i) => (
            <span key={w.start.getTime()} title={`Week of ${fmtDay(w.start)}: ${fmtStudy(w.minutes)}`} style={{ height: `${Math.max(2, (w.minutes / topWeek) * 100)}%`, background: course.color, opacity: i === weeks.length - 1 ? 1 : 0.55 }} />
          ))}
        </div>
        <span className="meta">Last 8 weeks{course.goalMin ? ' · the dashed line is your goal' : ''}</span>
      </div>

      <div className="drawer-section" style={{ gap: 2 }}>
        <div className="split" style={{ paddingBottom: 6 }}>
          <span className="drawer-label">Revise</span>
          <span className="meta">How sure you feel · click to change</span>
        </div>
        {course.topics.map((t, i) => (
          <div key={i} className="ln-topic">
            <button
              className="ln-topic-btn"
              aria-label={`${t.name}: ${['not yet', 'getting there', 'solid'][t.conf - 1]}. Click to change.`}
              onClick={() => patch({ topics: course.topics.map((x, j) => (j === i ? { ...x, conf: ((x.conf % 3) + 1) as 1 | 2 | 3 } : x)) })}
            >
              <span>{t.name}</span>
              <span className="ln-conf" aria-hidden="true">
                {[1, 2, 3].map((n) => (
                  <i key={n} className={n <= t.conf ? 'f' : ''} />
                ))}
              </span>
            </button>
            <button className="icon-btn" aria-label={`Remove ${t.name}`} title="Remove" onClick={() => patch({ topics: course.topics.filter((_, j) => j !== i) })}>
              <i className="ph-duotone ph-x" />
            </button>
          </div>
        ))}
        <form
          className="ln-inline"
          style={{ marginTop: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!topic.trim()) return;
            patch({ topics: [...course.topics, { name: topic.trim(), conf: 1 }] });
            setTopic('');
          }}
        >
          <input className="input sm" style={{ flex: 1 }} placeholder="Add a topic, e.g. Hash tables" aria-label="New topic" value={topic} onChange={(e) => setTopic(e.target.value)} />
          <button className="btn btn-secondary btn-small" disabled={!topic.trim()}>
            Add
          </button>
        </form>
      </div>

      <div className="split" style={{ alignItems: 'center', paddingTop: 10, borderTop: '1px solid var(--ln)' }}>
        <button className="btn btn-secondary" onClick={() => (patch({ archived: !course.archived }), onClose())}>
          <i className="ph-duotone ph-archive" />
          {course.archived ? 'Bring back' : 'Archive'}
        </button>
        <button
          className="btn btn-ghost"
          style={{ color: 'var(--wn)' }}
          onClick={() => {
            const before = learn;
            onChange({ ...learn, courses: learn.courses.filter((c) => c.id !== course.id), assessments: learn.assessments.filter((a) => a.courseId !== course.id) });
            onClose();
            notify(`Deleted ${course.name}`, { label: 'Undo', run: () => onChange(before) });
          }}
        >
          <i className="ph-duotone ph-trash" />
          Delete course
        </button>
      </div>
    </>
  );
}

/** One course's study minutes for the last 8 weeks, oldest first. */
function courseWeeks(learn: Learn, now: Date, courseId: string) {
  const only = { ...learn, sessions: learn.sessions.filter((s) => s.courseId === courseId), timer: learn.timer?.courseId === courseId ? learn.timer : null };
  return weeklyStudy(only, now, 8);
}

function ItemEditor({ a, onPatch, onRemove, onClose }: { a: Assessment; onPatch: (p: Partial<Assessment>) => void; onRemove: () => void; onClose: () => void }) {
  return (
    <div id={`ln-item-${a.id}`} className="ln-form ln-edit" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())}>
      <label className="field" style={{ flex: '1 1 100%' }}>
        Title
        <input className="input sm" autoFocus value={a.title} onChange={(e) => onPatch({ title: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 120px' }}>
        Kind
        <select className="input sm" value={a.kind} onChange={(e) => onPatch({ kind: e.target.value as AssessmentKind })}>
          {KINDS.map((k) => (
            <option key={k}>{k}</option>
          ))}
        </select>
      </label>
      <label className="field" style={{ flex: '1 1 80px' }}>
        % of grade
        <input className="input sm tnum" type="number" min={0} max={100} step="any" value={a.weight} onChange={(e) => onPatch({ weight: Number(e.target.value) || 0 })} />
      </label>
      <label className="field" style={{ flex: '1 1 140px' }}>
        Due
        <input className="input sm" type="date" value={a.due} onChange={(e) => onPatch({ due: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 100px' }}>
        Time
        <input className="input sm" type="time" value={a.time} onChange={(e) => onPatch({ time: e.target.value })} />
      </label>
      <label className="field" style={{ flex: '1 1 130px' }}>
        Status
        <select className="input sm" value={a.status} onChange={(e) => onPatch({ status: e.target.value as AssessmentStatus })}>
          {(Object.keys(STATUS_NAMES) as AssessmentStatus[]).map((s) => (
            <option key={s} value={s}>{STATUS_NAMES[s]}</option>
          ))}
        </select>
      </label>
      <label className="field" style={{ flex: '1 1 90px' }}>
        Score %
        <input
          className="input sm tnum"
          type="number"
          min={0}
          max={200}
          step="any"
          placeholder="Not marked"
          value={a.score ?? ''}
          onChange={(e) => onPatch(e.target.value === '' ? { score: null } : { score: Number(e.target.value), status: 'done' })}
        />
      </label>
      <div className="ln-form-btns">
        <button type="button" className="btn btn-ghost btn-small" style={{ color: 'var(--wn)', marginRight: 'auto' }} onClick={onRemove}>
          Remove
        </button>
        <button type="button" className="btn btn-primary btn-small" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
