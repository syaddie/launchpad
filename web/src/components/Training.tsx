import { useMemo, useRef, useState } from 'react';
import { DOW, MON, dayDiff, startOfDay, ymd } from '../../../shared/dates';
import { fmtMoney } from '../../../shared/money';
import {
  MIN_SPLIT_DAYS, MUSCLE_NAMES, SECONDARY_SHARE, exerciseHistory, fmtKg, fmtMinutes, fmtSet, gymCost, liftTrends, minutes, musclesOf, prsByWorkout, setsPerMuscle,
  topSet, trainingVsRest, volumeKg, weekStreak, weekSummary, weeklyCounts, workingSets, workoutLabel, workoutsFromHevyCsv, type LiftMeasure, type Split,
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
}

const kg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
const monthYear = (d: Date) => `${MON[d.getMonth()]} ${d.getFullYear()}`;
/** Sets per muscle can be halves, from secondary muscles. */
const fmtSets = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The Training view: workouts from Hevy's CSV export, by week, muscle and lift, beside the other logs. */
export function TrainingView({ data, now, noteBusy, onImport, onRefreshNote, onOpenExercise, onOpenSettings }: Props) {
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
            <ThisWeek workouts={ws} today={today} muscles={muscles} />
            <MusclePanel workouts={ws} today={today} muscles={muscles} goal={data.prefs.setsPerWeek} onOpenSettings={onOpenSettings} />
          </div>
          <div className="you-row">
            <Lifts workouts={ws} today={today} muscles={muscles} pinned={data.prefs.pinnedLifts} onOpen={onOpenExercise} />
            <Recent workouts={ws} muscles={muscles} onOpen={onOpenExercise} />
          </div>
          <Alongside data={data} today={today} />
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

function ThisWeek({ workouts, today, muscles }: { workouts: Workout[]; today: Date; muscles: Muscles }) {
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
    </section>
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

// ---------- alongside the other logs ----------

function SplitTile({ name, split, fmt, unit, empty }: { name: string; split: Split | null; fmt: (n: number) => string; unit: string; empty: string }) {
  const enough = split && split.trained.days >= MIN_SPLIT_DAYS && split.rest.days >= MIN_SPLIT_DAYS;
  return (
    <div className="tr-tile">
      <span className="sec-label">{name}</span>
      {enough ? (
        <div className="tr-split">
          {(['trained', 'rest'] as const).map((k) => (
            <div key={k}>
              <span className="meta">{k === 'trained' ? 'Days you trained' : 'Rest days'}</span>
              <span className="serif tnum tr-split-v">
                {fmt(split[k].avg!)} <small>{unit}</small>
              </span>
              <span className="meta tnum">{split[k].days} days</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="meta">
          {split
            ? `Shows once there are ${MIN_SPLIT_DAYS} days of each in the last 60; there are ${split.trained.days} training and ${split.rest.days} rest days so far.`
            : empty}
        </p>
      )}
    </div>
  );
}

function Alongside({ data, today }: { data: AppState; today: Date }) {
  const ws = data.training.workouts;
  const split = useMemo(() => trainingVsRest(ws, data.smokes, data.moods, today), [ws, data.smokes, data.moods, today]);
  const month = ymd(today).slice(0, 7);
  const cost = gymCost(data.money.entries, ws, month);

  return (
    <section className="panel you-panel tr-along" aria-label="Alongside your other logs">
      <div className="panel-head">
        <h2 className="panel-title">Alongside your other logs</h2>
        <span className="meta">Last 60 days, not counting today</span>
      </div>
      <div className="tr-tiles">
        <SplitTile name="Cigarettes" split={split.smokes} fmt={(n) => n.toFixed(1)} unit="a day" empty="Log cigarettes in You (or press C) to compare them with training days." />
        <SplitTile name="Mood" split={split.mood} fmt={(n) => n.toFixed(1)} unit="of 5" empty="Log a mood in You to compare it with training days." />
        <div className="tr-tile">
          <span className="sec-label">Gym cost this month</span>
          {cost ? (
            <div className="tr-split">
              <div>
                <span className="meta">In Money</span>
                <span className="serif tnum tr-split-v">{fmtMoney(cost.cost)}</span>
              </div>
              <div>
                <span className="meta">A session</span>
                <span className="serif tnum tr-split-v">{cost.sessions ? fmtMoney(cost.cost / cost.sessions) : '–'}</span>
                <span className="meta tnum">{cost.sessions} so far</span>
              </div>
            </div>
          ) : (
            <p className="meta">Add your gym membership in Money with “gym” in the note to see what each session costs.</p>
          )}
        </div>
      </div>
    </section>
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
