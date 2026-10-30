import { useMemo, useRef, useState } from 'react';
import { DOW, MON, dayDiff, startOfDay } from '../../../shared/dates';
import {
  MUSCLE_NAMES, fmtKg, fmtMinutes, fmtSet, liftTrends, minutes, prsByWorkout, setsPerMuscle, topSet, volumeKg, weekStreak, weekSummary, weeklyCounts,
  workingSets, workoutLabel, workoutsFromHevyCsv, type LiftTrend,
} from '../../../shared/training';
import type { Training, Workout } from '../../../shared/types';
import { localGet, localSet } from '../api';
import { fmtDay, hm } from '../util';
import { niceMax } from './Server';

interface Props {
  training: Training;
  now: Date;
  /** Replace every workout; the summary goes in a toast with Undo. */
  onImport: (t: Training, summary: string) => void;
}

/** A common target for growing a muscle; drawn as the dashed line in Sets per muscle. */
const SETS_A_WEEK = 10;
const kg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
const monthYear = (d: Date) => `${MON[d.getMonth()]} ${d.getFullYear()}`;

/** The Training view: workouts from Hevy's CSV export, by week, muscle and lift. */
export function TrainingView({ training, now, onImport }: Props) {
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const today = startOfDay(now);
  const ws = training.workouts;

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
          <div className="you-row">
            <ThisWeek workouts={ws} today={today} />
            <Muscles workouts={ws} today={today} />
          </div>
          <div className="you-row">
            <Lifts workouts={ws} today={today} />
            <Recent workouts={ws} />
          </div>
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

// ---------- this week ----------

function ThisWeek({ workouts, today }: { workouts: Workout[]; today: Date }) {
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
                    {workoutLabel(w)}
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

function Muscles({ workouts, today }: { workouts: Workout[]; today: Date }) {
  const [days, setDays] = useState(() => (localGet('trainingRange') === '7' ? 7 : 28));
  const rows = useMemo(() => setsPerMuscle(workouts, today, days), [workouts, today, days]);
  const goal = (SETS_A_WEEK * days) / 7;
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
            <span className="tr-bn tnum">{r.sets || '–'}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px' }}>
        <span className="legend">
          <span className="legend-dash" />
          {SETS_A_WEEK} sets a week{days > 7 ? ` (${goal} in ${days / 7} weeks)` : ''}
        </span>
        <span className="meta">Working sets, by each exercise’s main muscle</span>
      </div>
    </section>
  );
}

// ---------- lifts ----------

function liftValue(l: LiftTrend, v: number): string {
  if (l.measure === 'e1rm') return `${fmtKg(Math.round(v * 10) / 10)} kg`;
  if (l.measure === 'reps') return `${v} reps`;
  if (l.measure === 'km') return `${fmtKg(v)} km`;
  return fmtMinutes(Math.round(v / 60));
}

const MEASURE_NAMES = { e1rm: 'Est. 1-rep max', reps: 'Most reps', km: 'Longest', sec: 'Longest' };

function Spark({ points }: { points: { value: number }[] }) {
  const W = 96;
  const H = 28;
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const span = Math.max(...vals) - lo || 1;
  const xy = vals.map((v, i) => [vals.length > 1 ? (i / (vals.length - 1)) * W : W / 2, H - 3 - ((v - lo) / span) * (H - 6)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  return (
    <svg className="tr-spark" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      <polygon points={`${xy[0][0]},${H} ${line} ${lx},${H}`} fill="var(--act)" />
      <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.6" fill="var(--acd)" />
    </svg>
  );
}

function Lifts({ workouts, today }: { workouts: Workout[]; today: Date }) {
  const lifts = useMemo(() => liftTrends(workouts, today), [workouts, today]);
  return (
    <section className="panel you-panel tr-lifts" aria-label="Your lifts">
      <div className="panel-head">
        <h2 className="panel-title">Your lifts</h2>
        <span className="meta">Done most, last 12 weeks</span>
      </div>
      {lifts.length ? (
        <div className="tr-list">
          {lifts.map((l) => {
            const first = l.points[0]?.value ?? 0;
            const last = l.points[l.points.length - 1]?.value ?? 0;
            const diff = Math.round((last - first) * 10) / 10;
            return (
              <div key={l.title} className="tr-lift">
                <div style={{ minWidth: 0 }}>
                  <div className="tr-ln">
                    {l.title}
                    {l.pr && <span className="chip chip-accent" title="Best session yet">PR</span>}
                  </div>
                  <div className="meta">
                    {[l.top && `Last top set ${fmtSet(l.top)}`, `${l.points.length} sessions`].filter(Boolean).join(' · ')}
                  </div>
                </div>
                {l.points.length > 1 ? <Spark points={l.points} /> : <span />}
                <div className="tr-lv" title={MEASURE_NAMES[l.measure]}>
                  <span className="tnum">{liftValue(l, last)}</span>
                  <span className={'tr-ld tnum' + (diff > 0 ? ' up' : '')}>
                    {diff > 0 ? '+' : diff < 0 ? '−' : '±'}
                    {l.measure === 'sec' ? fmtMinutes(Math.round(Math.abs(diff) / 60)) : fmtKg(Math.abs(diff))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="meta">An exercise shows here once it’s in two sessions within 12 weeks.</p>
      )}
      <span className="meta">Est. 1-rep max is weight × (1 + reps ÷ 30) on your best working set of 20 reps or fewer. Change is since the first session in the 12 weeks.</span>
    </section>
  );
}

// ---------- recent sessions ----------

function Recent({ workouts }: { workouts: Workout[] }) {
  const prs = useMemo(() => prsByWorkout(workouts), [workouts]);
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
                  {workoutLabel(w)}
                  {pr && <span className="chip chip-accent" title={`Best yet: ${pr.join(', ')}`}>{pr.length > 1 ? `${pr.length} PRs` : 'PR'}</span>}
                </div>
                <div className="tr-sx" title={w.exercises.map((e) => e.title).join('\n')}>
                  {shown.map((e) => {
                    const t = topSet(e.sets);
                    return `${e.title}${t ? ' ' + fmtSet(t) : ''}`;
                  }).join(' · ')}
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

