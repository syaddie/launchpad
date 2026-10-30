import { useEffect, useMemo, useRef, useState } from 'react';
import { DOW, MON, addDays, dayDiff, parseYmd, startOfDay, ymd } from '../../../shared/dates';
import { fmtMoney, monthName } from '../../../shared/money';
import {
  MUSCLE_NAMES, SECONDARY_SHARE, cleanKg, exerciseHistory, fmtKg, fmtMinutes, fmtSet, gymPerSession, liftTrends, minutes, musclesOf, prsByWorkout, setsPerMuscle,
  topSet, volumeKg, weekStreak, weekSummary, weeklyCounts, weightChange, weightSeries, workingSets, workoutLabel, workoutsFromHevyCsv, type LiftMeasure, type WeightPoint,
} from '../../../shared/training';
import type { AppState, ExerciseMuscles, Training, Workout } from '../../../shared/types';
import { localGet, localSet } from '../api';
import { ago, fmtDay, hm } from '../util';
import { niceMax } from './Server';

type Muscles = Record<string, ExerciseMuscles>;

interface Props {
  data: AppState;
  now: Date;
  /** Claude is labelling exercises or writing the note. */
  noteBusy: boolean;
  /** Replace every workout; the summary goes in a toast with Undo. */
  onImport: (t: Training, summary: string) => void;
  onRefreshNote: () => void;
  onOpenExercise: (title: string) => void;
  onOpenSettings: () => void;
  /** Log body weight for a day, or remove it with null. */
  onWeight: (date: string, kg: number | null) => void;
  /** Bumped by ⌘K › Log your weight to focus the weight box. */
  weightSignal: number;
}

const kg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
const monthYear = (d: Date) => `${MON[d.getMonth()]} ${d.getFullYear()}`;
/** Sets per muscle can be halves, from secondary muscles. */
const fmtSets = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The Training view: workouts from Hevy's CSV export, by week, muscle and lift, beside the other logs. */
export function TrainingView({ data, now, noteBusy, onImport, onRefreshNote, onOpenExercise, onOpenSettings, onWeight, weightSignal }: Props) {
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const today = startOfDay(now);
  const ws = data.training.workouts;
  const muscles = data.exerciseMuscles;

  const importFile = async (f: File) => {
    setError('');
    try {
      const workouts = workoutsFromHevyCsv(await f.text());
      const sets = workouts.reduce((n, w) => n + workingSets(w), 0);
      const first = new Date(workouts[workouts.length - 1].start);
      onImport(
        { workouts, source: 'csv', importedAt: new Date().toISOString() },
        `Imported ${workouts.length} workout${workouts.length === 1 ? '' : 's'} and ${sets.toLocaleString('en-GB')} sets, back to ${fmtDay(first)} ${first.getFullYear()}`,
      );
    } catch (e) {
      setError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };

  const latest = ws[0] ? new Date(ws[0].start) : null;
  const behind = latest ? dayDiff(latest, today) : 0;

  return (
    <main className="you training" aria-label="Training">
      <div className="tr-head">
        <span className="meta">
          {latest
            ? `${ws.length} workouts since ${monthYear(new Date(ws[ws.length - 1].start))} · latest ${behind === 0 ? 'today' : behind === 1 ? 'yesterday' : fmtDay(latest)}${behind > 3 ? ' · export from Hevy again to bring in newer ones' : ''}`
            : ''}
        </span>
        <div className="tr-actions">
          {error && <span className="meta" style={{ color: 'var(--wn)' }}>{error}</span>}
          {ws.length > 0 && (
            <button className="btn btn-ghost btn-small" title="Read the workouts CSV that Hevy exports, replacing what’s here" onClick={() => fileRef.current?.click()}>
              <i className="ph-duotone ph-upload-simple" />
              Import Hevy .csv
            </button>
          )}
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) importFile(f);
          }}
        />
      </div>

      {ws.length ? (
        <>
          {data.newsSummaries && <Note state={data.trainingNote} busy={noteBusy} now={now} onRefresh={onRefreshNote} />}
          <div className="you-row">
            <ThisWeek workouts={ws} today={today} muscles={muscles} gymMonthly={data.prefs.gymMonthly} onOpenSettings={onOpenSettings} />
            <MusclePanel workouts={ws} today={today} muscles={muscles} goal={data.prefs.setsPerWeek} onOpenSettings={onOpenSettings} />
          </div>
          <div className="you-row">
            <Lifts workouts={ws} today={today} muscles={muscles} pinned={data.prefs.pinnedLifts} onOpen={onOpenExercise} />
            <BodyWeight weights={data.weights} today={today} focusSignal={weightSignal} onSave={onWeight} />
          </div>
          <Recent workouts={ws} muscles={muscles} onOpen={onOpenExercise} />
        </>
      ) : (
        <section className="panel you-panel">
          <div className="empty">
            <h2 className="panel-title">Bring in your workouts from Hevy</h2>
            <p>
              In the Hevy app, open Settings › Export &amp; Import Data and export your workouts. Then import the .csv here. Launchpad reads every set and
              shows your weeks, the muscles you’re training and how your lifts are moving. Importing again later replaces what’s here, so newer workouts come in.
            </p>
            <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
              <i className="ph-duotone ph-upload-simple" />
              Import Hevy .csv
            </button>
          </div>
        </section>
      )}
      {!ws.length && (
        <div className="you-row">
          <BodyWeight weights={data.weights} today={today} focusSignal={weightSignal} onSave={onWeight} />
        </div>
      )}
    </main>
  );
}

// ---------- Claude's note ----------

function Note({ state, busy, now, onRefresh }: { state: AppState['trainingNote']; busy: boolean; now: Date; onRefresh: () => void }) {
  const { note, error } = state;
  return (
    <section className="panel you-panel tr-note" aria-label="Note on your training" aria-busy={busy}>
      <div className="panel-head">
        <span className="sec-label">Claude’s read on your training</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {note && <span className="meta">{busy ? 'Writing a new one…' : `Written ${ago(note.writtenAt, now)}`}</span>}
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
        <p className="meta">{busy ? 'Reading your workouts and writing a note…' : 'A short note on your training appears here after an import.'}</p>
      ) : null}
      {error && !busy && <p className="meta" style={{ color: 'var(--wn)' }}>{error}</p>}
    </section>
  );
}

// ---------- this week ----------

function ThisWeek({ workouts, today, muscles, gymMonthly, onOpenSettings }: { workouts: Workout[]; today: Date; muscles: Muscles; gymMonthly: number; onOpenSettings: () => void }) {
  const week = useMemo(() => weekSummary(workouts, today), [workouts, today]);
  const weeks = useMemo(() => weeklyCounts(workouts, today, 12), [workouts, today]);
  const streak = useMemo(() => weekStreak(workouts, today), [workouts, today]);
  const sun = week.days[6].date;
  const top = Math.max(3, ...weeks.map((w) => w.count));

  return (
    <section className="panel you-panel tr-week" aria-label="This week">
      <div className="panel-head">
        <h2 className="panel-title">This week</h2>
        <span className="meta">
          {week.days[0].date.getDate()} {MON[week.days[0].date.getMonth()]} – {sun.getDate()} {MON[sun.getMonth()]}
        </span>
      </div>

      <div className="tr-days">
        {week.days.map(({ date, workouts: day }) => {
          const d = dayDiff(today, date);
          const w = day[0];
          return (
            <div key={date.getTime()} className={'tr-day' + (w ? ' done' : '') + (d === 0 ? ' today' : '') + (d > 0 ? ' ahead' : '')} title={day.map((x) => `${x.title} · ${hm(new Date(x.start))}`).join('\n') || undefined}>
              <span className="tr-dn">{d === 0 ? 'Today' : DOW[date.getDay()]}</span>
              {w ? (
                <>
                  <span className="tr-dt">
                    {workoutLabel(w, muscles)}
                    {day.length > 1 && ` +${day.length - 1}`}
                  </span>
                  <span className="tr-ds tnum">
                    {fmtMinutes(day.reduce((n, x) => n + minutes(x), 0))} · {day.reduce((n, x) => n + workingSets(x), 0)} sets
                  </span>
                </>
              ) : (
                <span className="tr-dt rest">{d < 0 ? 'Rest' : ''}</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="tr-totals">
        <div><b className="serif tnum">{week.sessions}</b>session{week.sessions === 1 ? '' : 's'}</div>
        <div><b className="serif tnum">{fmtMinutes(week.minutes)}</b>training</div>
        <div><b className="serif tnum">{week.sets}</b>working sets</div>
        <div><b className="serif tnum">{kg(week.volume)}</b>lifted</div>
      </div>

      <div className="tr-weeks-wrap">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span className="sec-label">Sessions a week</span>
          <span className="meta">{streak > 1 ? `${streak} weeks in a row` : streak === 1 ? 'Trained last week or this' : 'Last 12 weeks'}</span>
        </div>
        <div className="tr-weeks" role="img" aria-label={`Sessions a week, oldest first: ${weeks.map((w) => w.count).join(', ')}`}>
          {weeks.map((w, i) => (
            <div key={w.start.getTime()} className="tr-wcol" title={`Week of ${fmtDay(w.start)}: ${w.count}`}>
              <span className="tr-wn tnum">{w.count || ''}</span>
              <span className={'tr-wbar' + (i === weeks.length - 1 ? ' now' : '')} style={{ height: `${(w.count / top) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="axis tnum">
          <span>{fmtDay(weeks[0].start).slice(4)}</span>
          <span>This week</span>
        </div>
      </div>

      <GymCost workouts={workouts} today={today} monthly={gymMonthly} onOpenSettings={onOpenSettings} />
    </section>
  );
}

/** What each session this month cost, from the gym fee in Settings › Trackers. */
function GymCost({ workouts, today, monthly, onOpenSettings }: { workouts: Workout[]; today: Date; monthly: number; onOpenSettings: () => void }) {
  const month = ymd(today).slice(0, 7);
  const { sessions, perSession } = gymPerSession(monthly, workouts, month);
  return (
    <div className="you-foot tr-gym">
      {monthly > 0 ? (
        <>
          <span>
            <b>{perSession !== null ? fmtMoney(perSession) : '–'}</b> a session in {monthName(month).split(' ')[0]}
          </span>
          <span>
            {sessions} session{sessions === 1 ? '' : 's'} so far
          </span>
          <button className="btn-link" title="Change it in Settings › Trackers" onClick={onOpenSettings}>
            Gym {fmtMoney(monthly)} a month
          </button>
        </>
      ) : (
        <button className="btn-link" onClick={onOpenSettings}>
          Add what your gym costs a month in Settings to see what each session costs
        </button>
      )}
    </div>
  );
}

// ---------- muscles ----------

const RANGES = [
  { days: 7, name: '7 days' },
  { days: 28, name: '4 weeks' },
];

function MusclePanel({ workouts, today, muscles, goal: perWeek, onOpenSettings }: {
  workouts: Workout[];
  today: Date;
  muscles: Muscles;
  goal: number;
  onOpenSettings: () => void;
}) {
  const [days, setDays] = useState(() => (localGet('trainingRange') === '7' ? 7 : 28));
  const rows = useMemo(() => setsPerMuscle(workouts, today, days, muscles), [workouts, today, days, muscles]);
  const goal = (perWeek * days) / 7;
  const max = niceMax(Math.max(goal * 1.2, ...rows.map((r) => r.sets)));

  return (
    <section className="panel you-panel tr-musc" aria-label="Sets per muscle">
      <div className="panel-head">
        <h2 className="panel-title">Sets per muscle</h2>
        <div className="segmented" role="group" aria-label="Range">
          {RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? 'on' : ''} aria-pressed={days === r.days} onClick={() => (setDays(r.days), localSet('trainingRange', String(r.days)))}>
              {r.name}
            </button>
          ))}
        </div>
      </div>
      <div className="tr-bars">
        {rows.map((r) => (
          <div key={r.muscle} className={'tr-bar' + (r.sets ? '' : ' zero')}>
            <span className="tr-bl">{MUSCLE_NAMES[r.muscle]}</span>
            <span className="tr-track">
              <span className="tr-fill" style={{ width: `${(r.sets / max) * 100}%` }} />
              <span className="tr-goal" style={{ left: `${(goal / max) * 100}%` }} />
            </span>
            <span className="tr-bn tnum">{r.sets ? fmtSets(r.sets) : '–'}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px' }}>
        <span className="legend">
          <span className="legend-dash" />
          <button className="btn-link" title="Change it in Settings › Trackers" onClick={onOpenSettings}>
            {perWeek} sets a week
          </button>
          {days > 7 ? ` (${fmtSets(goal)} in ${days / 7} weeks)` : ''}
        </span>
        <span className="meta">
          Working sets; secondary muscles count {SECONDARY_SHARE === 0.5 ? 'half' : SECONDARY_SHARE}. Muscles {Object.keys(muscles).length ? 'read by Claude' : 'read from exercise names'}
        </span>
      </div>
    </section>
  );
}

// ---------- lifts ----------

export function liftValue(measure: LiftMeasure, v: number): string {
  if (measure === 'e1rm') return `${fmtKg(Math.round(v * 10) / 10)} kg`;
  if (measure === 'reps') return `${v} reps`;
  if (measure === 'km') return `${fmtKg(v)} km`;
  return fmtMinutes(Math.round(v / 60));
}

const MEASURE_NAMES: Record<LiftMeasure, string> = { e1rm: 'Est. 1-rep max', reps: 'Most reps', km: 'Longest', sec: 'Longest' };

function Spark({ values, w = 96, h = 28, wide }: { values: number[]; w?: number; h?: number; wide?: boolean }) {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const xy = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * w : w / 2, h - 3 - ((v - lo) / span) * (h - 6)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg className={wide ? 'tr-spark wide' : 'tr-spark'} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polygon points={`${xy[0][0]},${h} ${line} ${lx},${h}`} fill="var(--act)" />
      <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.6" fill="var(--acd)" />
    </svg>
  );
}

function Lifts({ workouts, today, muscles, pinned, onOpen }: { workouts: Workout[]; today: Date; muscles: Muscles; pinned: string[]; onOpen: (title: string) => void }) {
  const lifts = useMemo(() => liftTrends(workouts, today, { pinned, muscles }), [workouts, today, pinned, muscles]);
  return (
    <section className="panel you-panel tr-lifts" aria-label="Your lifts">
      <div className="panel-head">
        <h2 className="panel-title">Your lifts</h2>
        <span className="meta">{pinned.length ? 'Pinned, then done most' : 'Done most'}, last 12 weeks</span>
      </div>
      {lifts.length ? (
        <div className="tr-list">
          {lifts.map((l) => {
            const first = l.points[0]?.value ?? 0;
            const last = l.points[l.points.length - 1]?.value ?? 0;
            const diff = Math.round((last - first) * 10) / 10;
            return (
              <button key={l.title} className="tr-lift" title={`${l.title}: every session`} onClick={() => onOpen(l.title)}>
                <div style={{ minWidth: 0 }}>
                  <div className="tr-ln">
                    {l.pinned && <i className="ph-duotone ph-push-pin" aria-label="Pinned" />}
                    <span className="tr-ln-text">{l.title}</span>
                    {l.pr && <span className="chip chip-accent" title="Best session yet">PR</span>}
                  </div>
                  <div className="meta">{[l.top && `Last top set ${fmtSet(l.top)}`, `${l.sessions} session${l.sessions === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
                </div>
                {l.points.length > 1 ? <Spark values={l.points.map((p) => p.value)} /> : <span className="meta tr-spark-none">{l.points.length ? '' : 'Not in 12 weeks'}</span>}
                <div className="tr-lv" title={MEASURE_NAMES[l.measure]}>
                  <span className="tnum">{l.latest !== null ? liftValue(l.measure, l.latest) : '–'}</span>
                  {l.points.length > 1 && (
                    <span className={'tr-ld tnum' + (diff > 0 ? ' up' : '')}>
                      {diff > 0 ? '+' : diff < 0 ? '−' : '±'}
                      {l.measure === 'sec' ? fmtMinutes(Math.round(Math.abs(diff) / 60)) : fmtKg(Math.abs(diff))}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      ) : (
        <p className="meta">An exercise shows here once it’s in two sessions within 12 weeks.</p>
      )}
      <span className="meta">Est. 1-rep max is weight × (1 + reps ÷ 30) on your best working set of 20 reps or fewer. Click a lift for every session, and to pin it.</span>
    </section>
  );
}

// ---------- recent sessions ----------

function Recent({ workouts, muscles, onOpen }: { workouts: Workout[]; muscles: Muscles; onOpen: (title: string) => void }) {
  const prs = useMemo(() => prsByWorkout(workouts, muscles), [workouts, muscles]);
  return (
    <section className="panel you-panel tr-recent" aria-label="Recent sessions">
      <div className="panel-head">
        <h2 className="panel-title">Recent sessions</h2>
        <span className="meta">Top set of each exercise</span>
      </div>
      <div className="tr-list">
        {workouts.slice(0, 6).map((w) => {
          const start = new Date(w.start);
          const pr = prs.get(w.id);
          const shown = w.exercises.slice(0, 4);
          return (
            <div key={w.id} className="tr-ses">
              <span className="tr-sd tnum">
                {fmtDay(start)}
                <br />
                {hm(start)}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="tr-st">
                  {workoutLabel(w, muscles)}
                  {pr && <span className="chip chip-accent" title={`Best yet: ${pr.join(', ')}`}>{pr.length > 1 ? `${pr.length} PRs` : 'PR'}</span>}
                </div>
                <div className="tr-sx">
                  {shown.map((e, i) => {
                    const t = topSet(e.sets);
                    return (
                      <span key={i}>
                        {i > 0 && ' · '}
                        <button className="tr-exlink" onClick={() => onOpen(e.title)}>
                          {e.title}
                        </button>
                        {t ? ' ' + fmtSet(t) : ''}
                      </span>
                    );
                  })}
                  {w.exercises.length > shown.length && ` · ${w.exercises.length - shown.length} more`}
                </div>
              </div>
              <span className="tr-sm tnum">
                {fmtMinutes(minutes(w))} · {workingSets(w)} sets
                <br />
                {volumeKg(w) > 0 ? kg(volumeKg(w)) : ''}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ---------- body weight ----------

const WEIGHT_RANGES = [
  { days: 30, name: '30 days' },
  { days: 90, name: '90 days' },
  { days: 365, name: '1 year' },
];

function BodyWeight({ weights, today, focusSignal, onSave }: {
  weights: Record<string, number>;
  today: Date;
  focusSignal: number;
  onSave: (date: string, kg: number | null) => void;
}) {
  const [days, setDays] = useState(() => WEIGHT_RANGES.find((r) => String(r.days) === localGet('weightRange'))?.days ?? 90);
  const [date, setDate] = useState(() => ymd(today));
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusSignal) inputRef.current?.focus();
  }, [focusSignal]);

  const series = useMemo(() => weightSeries(weights), [weights]);
  const from = ymd(addDays(today, -(days - 1)));
  const shown = series.filter((p) => p.date >= from);
  const last = series[series.length - 1];
  const change = weightChange(series, days);
  const kg = cleanKg(text);
  const existing = weights[date];
  const save = () => {
    if (kg === null) return;
    onSave(date, kg);
    setText('');
  };
  const when = (d: string) => {
    const n = dayDiff(parseYmd(d), today);
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : fmtDay(parseYmd(d));
  };

  return (
    <section className="panel you-panel tr-weight" aria-label="Body weight">
      <div className="panel-head">
        <h2 className="panel-title">Body weight</h2>
        <div className="segmented" role="group" aria-label="Range">
          {WEIGHT_RANGES.map((r) => (
            <button key={r.days} className={days === r.days ? 'on' : ''} aria-pressed={days === r.days} onClick={() => (setDays(r.days), localSet('weightRange', String(r.days)))}>
              {r.name}
            </button>
          ))}
        </div>
      </div>

      <div className="tr-wt-top">
        {last ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="serif tnum tr-wt-now">{fmtKg(last.kg)}</span>
              <span style={{ fontSize: 13, color: 'var(--t2)' }}>kg {when(last.date)}</span>
            </span>
            <span className="meta tnum">
              7-day average {fmtKg(last.avg)} kg
              {change &&
                ` · ${change.kg > 0 ? '+' : change.kg < 0 ? '−' : '±'}${fmtKg(Math.abs(change.kg))} kg ${change.full ? `in ${WEIGHT_RANGES.find((r) => r.days === days)!.name}` : `since ${fmtDay(parseYmd(change.since))}`}`}
            </span>
          </div>
        ) : (
          <p className="meta" style={{ margin: 0, maxWidth: 360 }}>
            Log your weight here, or type “weight 72.4” in ⌘K. One a day is plenty; the line is the 7-day average, which evens out the day-to-day swings.
          </p>
        )}
        <form
          className="tr-wt-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input
            id="weight-date"
            className="input sm tnum"
            type="date"
            aria-label="Day"
            value={date}
            max={ymd(today)}
            onChange={(e) => e.target.value && setDate(e.target.value)}
          />
          <input
            id="weight-kg"
            ref={inputRef}
            className="input sm tnum"
            inputMode="decimal"
            aria-label="Weight in kg"
            placeholder={existing ? `${fmtKg(existing)} kg` : 'kg'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            style={{ width: 84 }}
          />
          <button className="btn btn-primary btn-small" type="submit" disabled={kg === null}>
            {existing ? 'Update' : 'Log'}
          </button>
          {existing !== undefined && (
            <button className="btn btn-ghost btn-small" type="button" title={`Remove ${fmtKg(existing)} kg on ${when(date)}`} onClick={() => onSave(date, null)}>
              Remove
            </button>
          )}
        </form>
      </div>

      {shown.length > 0 ? (
        <WeightChart points={shown} from={from} to={ymd(today)} />
      ) : (
        series.length > 0 && <p className="meta">Nothing logged in the last {WEIGHT_RANGES.find((r) => r.days === days)!.name}.</p>
      )}
    </section>
  );
}

/** Daily entries as dots and the 7-day average as a line, over the chosen range. */
function WeightChart({ points, from, to }: { points: WeightPoint[]; from: string; to: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth && setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = W < 420 ? 140 : 170;
  const L = 38;
  const R = 10;
  const T = 10;
  const B = 22;
  const vals = points.flatMap((p) => [p.kg, p.avg]);
  const span = Math.max(1, Math.max(...vals) - Math.min(...vals));
  const step = [0.5, 1, 2, 5, 10, 20].find((s) => span / s <= 4) ?? 50;
  const lo = Math.floor((Math.min(...vals) - span * 0.1) / step) * step;
  const hi = Math.ceil((Math.max(...vals) + span * 0.1) / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push(Math.round(t * 10) / 10);
  const total = Math.max(1, dayDiff(parseYmd(from), parseYmd(to)));
  const x = (d: string) => L + (dayDiff(parseYmd(from), parseYmd(d)) / total) * (W - L - R);
  const y = (v: number) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const line = points.map((p) => `${x(p.date).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  const mid = ymd(addDays(parseYmd(from), Math.round(total / 2)));

  return (
    <div ref={ref}>
    <svg className="tr-wt-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Body weight from ${points[0].kg} to ${last.kg} kg`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="var(--ln)" />
          <text x={L - 6} y={y(t) + 3.5} textAnchor="end">
            {fmtKg(t)}
          </text>
        </g>
      ))}
      {[from, mid, to].map((d, i) => (
        <text key={d} x={x(d)} y={H - 5} textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>
          {i === 2 ? 'Today' : `${parseYmd(d).getDate()} ${MON[parseYmd(d).getMonth()]}`}
        </text>
      ))}
      {points.map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.kg)} r="2.4" fill="var(--t3)" opacity="0.6">
          <title>{`${fmtDay(parseYmd(p.date))}: ${fmtKg(p.kg)} kg`}</title>
        </circle>
      ))}
      {points.length > 1 && <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      <circle cx={x(last.date)} cy={y(last.avg)} r="3.4" fill="var(--acd)" />
    </svg>
    </div>
  );
}

// ---------- one exercise ----------

/** Every session of one exercise, in the drawer. */
export function ExerciseDrawer({ title, data, pinned, onPin }: { title: string; data: AppState; pinned: boolean; onPin: () => void }) {
  const h = useMemo(() => exerciseHistory(data.training.workouts, title), [data.training.workouts, title]);
  const m = musclesOf(title, data.exerciseMuscles);
  const values = [...h.sessions].reverse().flatMap((s) => (s.best === null ? [] : [s.best]));

  return (
    <>
      <div className="drawer-section">
        <div className="split">
          <span className="meta">
            {MUSCLE_NAMES[m.primary]}
            {m.secondary.length > 0 && `, also ${m.secondary.map((x) => MUSCLE_NAMES[x]).join(', ')}`}
          </span>
          <button className={'btn btn-small ' + (pinned ? 'btn-secondary' : 'btn-ghost')} onClick={onPin}>
            <i className={'ph-duotone ' + (pinned ? 'ph-push-pin-slash' : 'ph-push-pin')} />
            {pinned ? 'Unpin from Your lifts' : 'Pin to Your lifts'}
          </button>
        </div>
        {h.best && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span className="meta">Best {MEASURE_NAMES[h.measure].toLowerCase()}</span>
            <span className="serif tnum" style={{ fontSize: 28, lineHeight: 1.1 }}>
              {liftValue(h.measure, h.best.value)}
            </span>
            <span className="meta">
              {fmtDay(new Date(h.best.at))} {new Date(h.best.at).getFullYear()} · {h.sessions.length} session{h.sessions.length === 1 ? '' : 's'} in all
            </span>
          </div>
        )}
        {values.length > 1 && <Spark values={values} w={300} h={70} wide />}
      </div>
      <div className="drawer-section" style={{ gap: 0 }}>
        <div className="drawer-label" style={{ paddingBottom: 6 }}>Every session</div>
        {h.sessions.map((s) => (
          <div key={s.workoutId} className="tr-hist">
            <span className="tr-sd tnum">
              {fmtDay(new Date(s.at))}
              <br />
              {new Date(s.at).getFullYear()}
            </span>
            <span className="tr-hist-sets">
              {s.sets.map((x, i) => (
                <span key={i} className={x.type === 'warmup' ? 'warm' : undefined} title={x.type === 'normal' ? undefined : x.type}>
                  {fmtSet(x)}
                  {x.rpe ? ` @${x.rpe}` : ''}
                </span>
              ))}
            </span>
            <span className="tr-hist-best tnum">
              {s.best !== null ? liftValue(h.measure, s.best) : ''}
              {s.pr && <span className="chip chip-accent">PR</span>}
            </span>
          </div>
        ))}
        {!h.sessions.length && <p className="meta">No sessions of this exercise in the imported workouts.</p>}
      </div>
    </>
  );
}
