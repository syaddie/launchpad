import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DOW, MON, addDays, dayDiff, parseYmd, startOfDay, ymd } from '../../../shared/dates';
import { fmtMoney, monthName } from '../../../shared/money';
import {
  MUSCLE_NAMES, SECONDARY_SHARE, cleanKg, exerciseHistory, fmtKg, fmtMinutes, fmtSet, gymPerSession, liftTrends, minutes, musclesOf, prsByWorkout, setsPerMuscle,
  topSet, trainingWeeks, volumeKg, weekStart, weekStreak, weekSummary, weeklyCounts, weightChange, weightSeries, workingSets, workoutLabel, workoutsFromHevyCsv, type LiftMeasure, type TrainingWeek, type WeightPoint,
} from '../../../shared/training';
import type { AppState, ExerciseMuscles, Training, Workout, WorkoutSet } from '../../../shared/types';
import { localGet, localSet } from '../api';
import { ago, fmtDay, hm, niceMax } from '../util';
import { copyText, menuProps } from './ContextMenu';
import { landedDay, periodStep, unseen } from '../motion';
import { Glide, Glyphs, Readout, usePeriodScan, useSettled } from './Motion';
import { EmptyArt } from './mission/EmptyArt';

type Muscles = Record<string, ExerciseMuscles>;

interface Props {
  data: AppState;
  now: Date;
  /** Replace every workout; the summary goes in a toast with Undo. */
  onImport: (t: Training, summary: string) => void;
  /** Download from Hevy now, when the server has a key. */
  onSync: () => Promise<void>;
  onOpenExercise: (title: string) => void;
  /** One session, with every exercise and set, in the drawer. */
  onOpenWorkout: (id: string) => void;
  onOpenSettings: () => void;
  /** Log body weight for a day, or remove it with null. */
  onWeight: (date: string, kg: number | null) => void;
  /** Bumped by ⌘K › Log your weight to focus the weight box. */
  weightSignal: number;
  notify: (msg: string) => void;
}

const kg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
const monthYear = (d: Date) => `${MON[d.getMonth()]} ${d.getFullYear()}`;
/** Sets per muscle can be halves, from secondary muscles. */
const fmtSets = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** The Training view: workouts from Hevy, by week, muscle and lift, beside the other logs. */
export function TrainingView({ data, now, onImport, onSync, onOpenExercise, onOpenWorkout, onOpenSettings, onWeight, weightSignal, notify }: Props) {
  const [error, setError] = useState('');
  const [bwWeeks, setBwWeeks] = useState(() => BW_RANGES.find((r) => String(r.weeks) === localGet('bwRange'))?.weeks ?? 12);
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
  // Sessions that came in while Training was showing slide in (a sync, an import, another device's).
  const arrived = useArrivals(latest ? latest.getTime() : null);

  // With a key on the server, importing a file is only for when the sync isn't working.
  const live = data.hevy;
  const { lastSuccess, lastError } = data.sync.hevy;
  const canImport = !live || !!lastError;
  const [syncing, setSyncing] = useState(false);
  /** Whether a sync has run since Training opened, so the line it gives way to comes back in. */
  const [synced, setSynced] = useState(false);
  const sync = () => {
    setSyncing(true);
    onSync().finally(() => {
      setSyncing(false);
      setSynced(true);
    });
  };
  const pickFile = () => fileRef.current?.click();
  const syncedWords = !live || lastError ? '' : lastSuccess ? `synced with Hevy ${ago(lastSuccess, now)}` : 'waiting for the first sync with Hevy';
  const stale = !live && behind > 3 ? 'export from Hevy again to bring in newer ones' : '';
  const syncButton = (className: string) => (
    <button className={className} title="Download your workouts from Hevy now" disabled={syncing} onClick={sync}>
      <i className="ph-duotone ph-arrows-clockwise" />
      {syncing ? 'Syncing…' : 'Sync now'}
    </button>
  );
  const importButton = (className: string) => (
    <button
      className={className}
      title={live ? 'Read the workouts CSV that Hevy exports. The next sync that works replaces it' : 'Read the workouts CSV that Hevy exports, replacing what’s here'}
      onClick={pickFile}
    >
      <i className="ph-duotone ph-upload-simple" />
      Import Hevy .csv
    </button>
  );
  const menu = menuProps(
    () => [
      // As the button: one sync at a time.
      ...(live ? [{ label: syncing ? 'Syncing…' : 'Sync now', icon: 'ph-arrows-clockwise', onSelect: sync, disabled: syncing }] : []),
      { label: 'Import Hevy .csv', icon: 'ph-upload-simple', onSelect: pickFile },
    ],
    'Workouts from Hevy',
  );

  return (
    <main className="you training" aria-label="Training">
      <div className="tr-head" {...menu}>
        {syncing ? (
          // While a sync runs: a downlink, in each design's way (styles.css, TRAINING; Mission's in mission.css).
          <span key="downlink" className="meta tr-downlink" role="status">
            <span className="tr-dl-mono" aria-hidden="true">
              Downlink
            </span>
            <span className="tr-dl-bars" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <i key={i} style={{ '--i': i } as CSSProperties} />
              ))}
            </span>
            <span className="tr-dl-words">Downloading from Hevy…</span>
            <span className="tr-dl-stream" aria-hidden="true">
              <i />
            </span>
          </span>
        ) : (
          <span key="meta" className="meta" data-back={synced ? '' : undefined}>
            {latest
              ? [`${ws.length} workout${ws.length === 1 ? '' : 's'} since ${monthYear(new Date(ws[ws.length - 1].start))}`, `latest ${behind === 0 ? 'today' : behind === 1 ? 'yesterday' : fmtDay(latest)}`, syncedWords, stale]
                  .filter(Boolean)
                  .join(' · ')
              : ''}
          </span>
        )}
        <div className="tr-actions">
          {error && <span className="meta" style={{ color: 'var(--wn)' }}>{error}</span>}
          {ws.length > 0 && live && lastError && (
            <span className="meta" style={{ color: 'var(--wn)' }}>
              Couldn’t sync with Hevy: {lastError}
            </span>
          )}
          {ws.length > 0 && live && syncButton('btn btn-ghost btn-small')}
          {ws.length > 0 && canImport && importButton('btn btn-ghost btn-small')}
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
            <ThisWeek workouts={ws} today={today} muscles={muscles} gymMonthly={data.prefs.gymMonthly} arrived={arrived} onOpenSettings={onOpenSettings} />
            <MusclePanel workouts={ws} today={today} muscles={muscles} goal={data.prefs.setsPerWeek} onOpenSettings={onOpenSettings} />
          </div>
          <div className="you-row">
            <Lifts workouts={ws} today={today} muscles={muscles} pinned={data.prefs.pinnedLifts} onOpen={onOpenExercise} />
            <BodyWeight weights={data.weights} today={today} focusSignal={weightSignal} onSave={onWeight} />
          </div>
          <div className="you-row">
            <WeightAndTraining workouts={ws} weights={data.weights} today={today} weeks={bwWeeks} onWeeks={(n) => (setBwWeeks(n), localSet('bwRange', String(n)))} />
            <Recent workouts={ws} muscles={muscles} arrived={arrived} onOpen={onOpenWorkout} notify={notify} />
          </div>
        </>
      ) : (
        <section className="panel you-panel" {...menu}>
          <div className="empty">
            <EmptyArt kind={!live ? 'away' : lastError ? 'scrubbed' : lastSuccess ? 'clear' : 'away'} />
            <h2 className="panel-title">{live ? 'Your workouts from Hevy' : 'Bring in your workouts from Hevy'}</h2>
            {live ? (
              <>
                <p>
                  Launchpad checks Hevy every 15 minutes. Once your workouts arrive, it shows your weeks, the muscles you’re training and how your lifts are moving.
                </p>
                {lastError ? (
                  <p style={{ color: 'var(--wn)' }}>Couldn’t sync with Hevy: {lastError} You can import Hevy’s .csv export meanwhile.</p>
                ) : (
                  lastSuccess && <p>Hevy had no workouts when last checked, {ago(lastSuccess, now)}.</p>
                )}
                {syncButton('btn btn-primary')}
                {canImport && importButton('btn btn-ghost')}
              </>
            ) : (
              <>
                <p>
                  In the Hevy app, open Settings › Export &amp; Import Data and export your workouts. Then import the .csv here. Launchpad reads every set and
                  shows your weeks, the muscles you’re training and how your lifts are moving. Importing again later replaces what’s here, so newer workouts come in.
                </p>
                {importButton('btn btn-primary')}
              </>
            )}
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

// ---------- sessions arriving ----------

/** How long sessions that just arrived are marked as arriving: past the end of the longest way a design brings them in. */
const ARRIVING_MS = 2000;

/**
 * Sessions that arrive while Training is showing (Sync now, an import, a sync on the server or another device's), so a
 * design can bring them in: for a moment, the start (ms) of the newest session shown before they came, so every session
 * after it is new; otherwise null. What's there as Training opens, or comes in during its first frames, just shows
 * (useSettled). Worked out while rendering, so the new rows are marked from the first frame they're drawn in.
 */
function useArrivals(newest: number | null): number | null {
  const settled = useSettled();
  const [shown, setShown] = useState(newest);
  const [after, setAfter] = useState<{ at: number } | null>(null);
  if (newest !== shown) {
    setShown(newest);
    // Two arrivals close together: the first's are still coming in, so they stay marked.
    if (settled && newest !== null && shown !== null && newest > shown) setAfter({ at: after ? Math.min(after.at, shown) : shown });
  }
  useEffect(() => {
    if (!after) return;
    const t = window.setTimeout(() => setAfter(null), ARRIVING_MS);
    return () => window.clearTimeout(t);
  }, [after]);
  return after?.at ?? null;
}

// ---------- week ----------

const weekName = (offset: number) => (offset === 0 ? 'This week' : offset === -1 ? 'Last week' : `${-offset} weeks ago`);

function ThisWeek({ workouts, today, muscles, gymMonthly, arrived, onOpenSettings }: {
  workouts: Workout[];
  today: Date;
  muscles: Muscles;
  gymMonthly: number;
  /** Sessions after this (ms) just arrived (useArrivals): their day brings them in. */
  arrived: number | null;
  onOpenSettings: () => void;
}) {
  /** Weeks back from this one: 0 is this week, -1 last week. */
  const [offset, setOffset] = useState(0);
  // The arrows and the columns move the week the way you went (periodMotion.ts).
  const scan = usePeriodScan();
  const toOffset = (o: number) => {
    scan.go(periodStep(offset, o));
    setOffset(o);
  };
  const week = useMemo(() => weekSummary(workouts, addDays(today, 7 * offset)), [workouts, today, offset]);
  const weeks = useMemo(() => weeklyCounts(workouts, today, 12), [workouts, today]);
  const streak = useMemo(() => weekStreak(workouts, today), [workouts, today]);
  const mon = week.days[0].date;
  const sun = week.days[6].date;
  const top = Math.max(3, ...weeks.map((w) => w.count));
  // Back as far as the week of the first workout.
  const oldest = -dayDiff(weekStart(new Date(workouts[workouts.length - 1].start)), weekStart(today)) / 7;

  return (
    <section ref={scan.ref} className="panel you-panel tr-week lp-scan" aria-label={weekName(offset)} data-arrive={scan.arrive}>
      <div className="panel-head">
        <h2 key={offset} className="panel-title lp-period-label">
          <Glyphs text={weekName(offset)} />
        </h2>
        <span className="mood-month">
          <button className="icon-btn lp-step prev" aria-label="Previous week" disabled={offset <= oldest} onClick={() => toOffset(offset - 1)}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <span key={offset} className="meta lp-period-label" style={{ minWidth: 108, textAlign: 'center' }}>
            <Glyphs text={`${mon.getDate()} ${MON[mon.getMonth()]} – ${sun.getDate()} ${MON[sun.getMonth()]}${sun.getFullYear() !== today.getFullYear() ? ` ${sun.getFullYear()}` : ''}`} />
          </span>
          <button className="icon-btn lp-step next" aria-label="Next week" disabled={offset >= 0} onClick={() => toOffset(offset + 1)}>
            <i className="ph-duotone ph-caret-right" />
          </button>
        </span>
      </div>

      {/* A new row of days for each week, so it comes in whole. */}
      <div key={offset} className="tr-days lp-scan-grid">
        {week.days.map(({ date, workouts: day }) => {
          const d = dayDiff(today, date);
          const w = day[0];
          const isNew = arrived !== null && day.some((x) => Date.parse(x.start) > arrived);
          return (
            <div
              key={date.getTime()}
              className={'tr-day lp-scan-cell' + (w ? ' done' : '') + (d === 0 ? ' today' : '') + (d > 0 ? ' ahead' : '')}
              title={day.map((x) => `${x.title} · ${hm(new Date(x.start))}`).join('\n') || undefined}
              data-new={isNew ? '' : undefined}
            >
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
        <div><b className="serif tnum"><Readout text={String(week.sessions)} id="tr-week-sessions" /></b>session{week.sessions === 1 ? '' : 's'}</div>
        <div><b className="serif tnum"><Readout text={fmtMinutes(week.minutes)} id="tr-week-minutes" /></b>training</div>
        <div><b className="serif tnum"><Readout text={String(week.sets)} id="tr-week-sets" /></b>working sets</div>
        <div><b className="serif tnum"><Readout text={kg(week.volume)} id="tr-week-volume" /></b>lifted</div>
      </div>

      <div className="tr-weeks-wrap">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span className="sec-label">Sessions a week</span>
          <span className="meta">{streak > 1 ? `${streak} weeks in a row` : streak === 1 ? 'Trained last week or this' : 'Last 12 weeks'}</span>
        </div>
        <div className="tr-weeks" role="group" aria-label={`Sessions a week, oldest first: ${weeks.map((w) => w.count).join(', ')}`}>
          {weeks.map((w, i) => {
            const o = i - (weeks.length - 1);
            return (
              <button
                key={w.start.getTime()}
                className="tr-wcol"
                title={`Week of ${fmtDay(w.start)}: ${w.count}`}
                aria-label={`${weekName(o)}: ${w.count} session${w.count === 1 ? '' : 's'}`}
                aria-pressed={o === offset}
                disabled={o < oldest}
                onClick={() => toOffset(o)}
              >
                <span className="tr-wn tnum">{w.count || ''}</span>
                <span className={'tr-wbar' + (o === offset ? ' now' : '')} style={{ height: `${(w.count / top) * 100}%` }} />
              </button>
            );
          })}
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
          <Glide on={days} />
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

/**
 * A lift's recent sessions as a line. `fresh` (a new best since it was last seen): Mission draws the line on from the
 * session before to the new high, which pulses once (mission.css, TRAINING). The line and its fill are in one group so
 * they can be drawn on together; `--from` is how far across the session before is.
 */
function Spark({ values, w = 96, h = 28, wide, fresh }: { values: number[]; w?: number; h?: number; wide?: boolean; fresh?: boolean }) {
  const lo = Math.min(...values);
  const span = Math.max(...values) - lo || 1;
  const xy = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * w : w / 2, h - 3 - ((v - lo) / span) * (h - 6)]);
  const line = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [lx, ly] = xy[xy.length - 1];
  const from = values.length > 1 ? (values.length - 2) / (values.length - 1) : 0;
  return (
    <svg
      className={wide ? 'tr-spark wide' : 'tr-spark'}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden="true"
      data-new={fresh ? '' : undefined}
      style={fresh ? ({ '--from': `${(from * 100).toFixed(1)}%` } as CSSProperties) : undefined}
    >
      <g className="tr-spark-line">
        <polygon points={`${xy[0][0]},${h} ${line} ${lx},${h}`} fill="var(--act)" />
        <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      </g>
      {fresh && <circle className="tr-spark-pulse" cx={lx} cy={ly} r="2.6" fill="none" stroke="var(--ac)" strokeWidth="1.2" />}
      <circle className="tr-spark-high" cx={lx} cy={ly} r="2.6" fill="var(--acd)" />
    </svg>
  );
}

/** Lifts in the list; it scrolls past the first several. */
const LIFTS_SHOWN = 40;

/** A best as the list shows it: the lift and its new high, so the same best is the same key however often it's drawn. */
const bestKey = (l: { title: string; latest: number | null }) => `${l.title}|${l.latest}`;

/**
 * The bests (`bestKey`) that are new since this device last showed Your lifts, so a design can light them once when
 * they land (Mission does) rather than every time Training opens. Worked out while rendering, so a new best's chip is
 * marked from the first frame it's drawn in, and only while the page is in view, so one that arrives with a sync while
 * the tab is in the background is still new when you come back to it.
 */
function useNewBests(keys: string[]): ReadonlySet<string> {
  const sig = keys.join('\n');
  const visible = usePageVisible();
  const [state, setState] = useState(() => ({ sig: null as string | null, seen: localGet('seenBests'), fresh: new Set<string>() as ReadonlySet<string> }));
  if (visible && state.sig !== sig) {
    const found = unseen(keys, state.seen);
    setState({ sig, seen: JSON.stringify(keys), fresh: found.length ? new Set(found) : state.fresh });
  }
  useEffect(() => {
    if (state.sig !== null) localSet('seenBests', state.seen!);
  }, [state.sig, state.seen]);
  return state.fresh;
}

/** Whether the page is in view (not a tab in the background), following it. */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function Lifts({ workouts, today, muscles, pinned, onOpen }: { workouts: Workout[]; today: Date; muscles: Muscles; pinned: string[]; onOpen: (title: string) => void }) {
  const lifts = useMemo(() => liftTrends(workouts, today, { pinned, muscles, n: LIFTS_SHOWN }), [workouts, today, pinned, muscles]);
  const fresh = useNewBests(useMemo(() => lifts.filter((l) => l.pr).map(bestKey), [lifts]));
  return (
    <section className="panel you-panel tr-lifts" aria-label="Your lifts">
      <div className="panel-head">
        <h2 className="panel-title">Your lifts</h2>
        <span className="meta">{pinned.length ? 'Pinned, then done most' : 'Done most'}, last 12 weeks</span>
      </div>
      {lifts.length ? (
        <div className="tr-list tr-scroll tr-scroll-lifts" tabIndex={0} aria-label={`${lifts.length} lift${lifts.length === 1 ? '' : 's'}`}>
          {lifts.map((l) => {
            const first = l.points[0]?.value ?? 0;
            const last = l.points[l.points.length - 1]?.value ?? 0;
            const diff = Math.round((last - first) * 10) / 10;
            const isNew = l.pr && fresh.has(bestKey(l));
            return (
              <button key={l.title} className="tr-lift" title={`${l.title}: every session`} data-new={isNew ? '' : undefined} onClick={() => onOpen(l.title)}>
                <div style={{ minWidth: 0 }}>
                  <div className="tr-ln">
                    {l.pinned && <i className="ph-duotone ph-push-pin" aria-label="Pinned" />}
                    <span className="tr-ln-text">{l.title}</span>
                    {l.pr && <span className="chip chip-accent tr-pr" title="Best session yet">PR</span>}
                  </div>
                  <div className="meta">{[l.top && `Last top set ${fmtSet(l.top)}`, `${l.sessions} session${l.sessions === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
                </div>
                {l.points.length > 1 ? <Spark values={l.points.map((p) => p.value)} fresh={isNew} /> : <span className="meta tr-spark-none">{l.points.length ? '' : 'Not in 12 weeks'}</span>}
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

const RECENT_SHOWN = 15;

/** A session as plain text, for Copy: the day and totals, then each exercise's sets. */
function workoutText(w: Workout, label: string): string {
  const start = new Date(w.start);
  const lines = [`${label} · ${fmtDay(start)} ${start.getFullYear()} ${hm(start)} · ${fmtMinutes(minutes(w))} · ${workingSets(w)} sets${volumeKg(w) > 0 ? ` · ${kg(volumeKg(w))}` : ''}`];
  for (const e of w.exercises) {
    lines.push('', e.title);
    e.sets.forEach((x, i) => lines.push(`  ${i + 1}. ${fmtSet(x)}${x.type === 'normal' ? '' : ` (${SET_TYPE_NAMES[x.type]})`}${x.rpe ? ` @${x.rpe}` : ''}`));
    if (e.notes) lines.push(`  ${e.notes}`);
  }
  return lines.join('\n');
}

const SET_TYPE_NAMES: Record<WorkoutSet['type'], string> = { normal: '', warmup: 'warm-up', dropset: 'drop set', failure: 'to failure' };

function Recent({ workouts, muscles, arrived, onOpen, notify }: {
  workouts: Workout[];
  muscles: Muscles;
  /** Sessions after this (ms) just arrived (useArrivals): they slide in at the top. */
  arrived: number | null;
  onOpen: (id: string) => void;
  notify: (msg: string) => void;
}) {
  const prs = useMemo(() => prsByWorkout(workouts, muscles), [workouts, muscles]);
  const list = workouts.slice(0, RECENT_SHOWN);
  // By start, not id: an import's ids and Hevy's differ for the same session, which isn't new.
  const fresh = arrived === null ? 0 : list.filter((w) => Date.parse(w.start) > arrived).length;
  return (
    <section className="panel you-panel tr-recent" aria-label="Recent sessions">
      <div className="panel-head">
        <h2 className="panel-title">Recent sessions</h2>
        <span className="meta">Last {list.length} · click one for every set</span>
      </div>
      <div className="tr-list tr-scroll tr-scroll-recent" tabIndex={0} aria-label={`${list.length} most recent sessions`}>
        {list.map((w, i) => {
          const start = new Date(w.start);
          const pr = prs.get(w.id);
          const shown = w.exercises.slice(0, 4);
          const label = workoutLabel(w, muscles);
          return (
            <button
              key={w.id}
              className="tr-ses"
              title={`${label}: every exercise and set`}
              // The oldest of those arriving comes in first, nearest the ones already there.
              data-new={i < fresh ? '' : undefined}
              style={i < fresh ? ({ '--i': fresh - 1 - i } as CSSProperties) : undefined}
              onClick={() => onOpen(w.id)}
              {...menuProps(
                () => [
                  { label: 'Open session', icon: 'ph-arrow-square-in', onSelect: () => onOpen(w.id) },
                  { label: 'Copy session', icon: 'ph-copy', onSelect: () => copyText(workoutText(w, label), notify, 'Session copied') },
                ],
                `${label}, ${fmtDay(start)}`,
              )}
            >
              <span className="tr-sd tnum">
                {fmtDay(start)}
                <br />
                {hm(start)}
              </span>
              <span className="tr-sb">
                <span className="tr-st">
                  {label}
                  {pr && <span className="chip chip-accent" title={`Best yet: ${pr.join(', ')}`}>{pr.length > 1 ? `${pr.length} PRs` : 'PR'}</span>}
                </span>
                <span className="tr-sx">
                  {shown
                    .map((e) => {
                      const t = topSet(e.sets);
                      return e.title + (t ? ' ' + fmtSet(t) : '');
                    })
                    .join(' · ')}
                  {w.exercises.length > shown.length && ` · ${w.exercises.length - shown.length} more`}
                </span>
              </span>
              <span className="tr-sm tnum">
                {fmtMinutes(minutes(w))} · {workingSets(w)} sets
                <br />
                {volumeKg(w) > 0 ? kg(volumeKg(w)) : ''}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** One session in the drawer: its totals, then every exercise with every set. */
export function WorkoutDrawer({ id, data, onOpenExercise, notify }: { id: string; data: AppState; onOpenExercise: (title: string) => void; notify: (msg: string) => void }) {
  const ws = data.training.workouts;
  const prs = useMemo(() => prsByWorkout(ws, data.exerciseMuscles), [ws, data.exerciseMuscles]);
  const w = ws.find((x) => x.id === id);
  if (!w) return <p className="meta drawer-section">This session isn’t in your workouts any more; importing again may have replaced it.</p>;
  const start = new Date(w.start);
  const end = new Date(w.end);
  const pr = prs.get(w.id) ?? [];

  return (
    <>
      <div className="drawer-section">
        <div className="split">
          <span className="meta">
            {fmtDay(start)} {start.getFullYear()} · {hm(start)}
            {end > start && `–${hm(end)}`}
          </span>
          <button className="btn btn-small btn-ghost" onClick={() => copyText(workoutText(w, workoutLabel(w, data.exerciseMuscles)), notify, 'Session copied')}>
            <i className="ph-duotone ph-copy" />
            Copy
          </button>
        </div>
        <div className="tr-totals">
          <div><b className="serif tnum">{fmtMinutes(minutes(w))}</b>training</div>
          <div><b className="serif tnum">{w.exercises.length}</b>exercise{w.exercises.length === 1 ? '' : 's'}</div>
          <div><b className="serif tnum">{workingSets(w)}</b>working sets</div>
          {volumeKg(w) > 0 && <div><b className="serif tnum">{kg(volumeKg(w))}</b>lifted</div>}
        </div>
        {pr.length > 0 && (
          <span className="meta">
            <span className="chip chip-accent">{pr.length > 1 ? `${pr.length} PRs` : 'PR'}</span> Best yet: {pr.join(', ')}
          </span>
        )}
      </div>
      {w.exercises.map((e, i) => {
        const m = musclesOf(e.title, data.exerciseMuscles);
        let n = 0;
        return (
          <div key={i} className="drawer-section tr-wx">
            <div className="tr-wx-head">
              <button className="tr-exlink tr-wx-title" title={`${e.title}: every session`} onClick={() => onOpenExercise(e.title)}>
                {e.title}
              </button>
              {pr.includes(e.title) && <span className="chip chip-accent">PR</span>}
              <span className="meta tr-wx-musc">{MUSCLE_NAMES[m.primary]}</span>
            </div>
            <ol className="tr-wx-sets">
              {e.sets.map((x, j) => {
                const warm = x.type === 'warmup';
                if (!warm) n++;
                return (
                  <li key={j} className={warm ? 'warm' : undefined}>
                    <span className="tr-wx-n tnum">{warm ? 'W' : n}</span>
                    <span className="tnum">{fmtSet(x)}</span>
                    {x.rpe ? <span className="meta tnum">RPE {x.rpe}</span> : null}
                    {x.type !== 'normal' && <span className="meta">{SET_TYPE_NAMES[x.type]}</span>}
                  </li>
                );
              })}
            </ol>
            {e.notes && <p className="meta tr-wx-note">{e.notes}</p>}
          </div>
        );
      })}
      {!w.exercises.length && <p className="meta drawer-section">No exercises logged in this session.</p>}
    </>
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
  // A weight logged (here, in ⌘K, or on another device) drops onto the chart.
  const landing = useLanding(weights);

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
          <Glide on={days} />
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
              <span className="serif tnum tr-wt-now">
                <Readout text={fmtKg(last.kg)} id="weight-now" />
              </span>
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
        <WeightChart points={shown} from={from} to={ymd(today)} landing={landing} />
      ) : (
        series.length > 0 && <p className="meta">Nothing logged in the last {WEIGHT_RANGES.find((r) => r.days === days)!.name}.</p>
      )}
    </section>
  );
}

/** A day's weight just logged or changed, and what it was before (null if it's new); `n` counts them, so each lands afresh. */
type Landing = { date: string; was: number | null; n: number };

/** How long a weight logged is marked as landing: past the end of the longest way a design brings it in. */
const LANDING_MS = 2200;

/**
 * The weight just logged, for a moment (landedDay: one day added or changed; not a removal or a restore of many). Worked
 * out while rendering, so its dot is marked from the first frame it's drawn in. Not in the panel's first frames
 * (useSettled): those weights were there.
 */
function useLanding(weights: Record<string, number>): Landing | null {
  const settled = useSettled();
  const [before, setBefore] = useState(weights);
  const [landing, setLanding] = useState<Landing | null>(null);
  if (weights !== before) {
    setBefore(weights);
    const day = settled ? landedDay(before, weights) : null;
    if (day) setLanding({ date: day, was: before[day] ?? null, n: (landing?.n ?? 0) + 1 });
  }
  useEffect(() => {
    if (!landing) return;
    const t = window.setTimeout(() => setLanding(null), LANDING_MS);
    return () => window.clearTimeout(t);
  }, [landing]);
  return landing;
}

/**
 * Daily entries as dots and the 7-day average as a line, over the chosen range. A weight just logged (`landing`) drops
 * onto it, from above the chart (from where it was, if it changed), and the line runs on to it when it's the latest:
 * each design in its own way (styles.css and designs.css, TRAINING; Mission's touchdown in mission.css).
 */
function WeightChart({ points, from, to, landing }: { points: WeightPoint[]; from: string; to: string; landing: Landing | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth && setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // One logged before the chart was drawn (its first weight, a range that just took it in) just shows, as the chart does.
  const mounted = useRef(landing?.n);
  const land = landing && landing.n !== mounted.current && points.some((p) => p.date === landing.date) ? landing : null;
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
  const last = points[points.length - 1];
  // The latest weight landing: the line stops at the day before, and its last stretch runs on to the new average.
  const runOn = !!land && land.date === last.date && points.length > 1;
  const linePoints = runOn ? points.slice(0, -1) : points;
  const line = linePoints.map((p) => `${x(p.date).toFixed(1)},${y(p.avg).toFixed(1)}`).join(' ');
  const prev = points[points.length - 2];
  const mid = ymd(addDays(parseYmd(from), Math.round(total / 2)));
  const landKg = land ? points.find((p) => p.date === land.date)!.kg : 0;
  // From just above the chart for a new day, from where it was for one changed.
  const drop = land ? (land.was !== null ? y(land.was) : T - 6) - y(landKg) : 0;

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
      {points.map((p) => {
        const landsHere = land?.date === p.date;
        return (
          <circle
            key={landsHere ? `${p.date}:${land!.n}` : p.date}
            className={landsHere ? 'tr-wt-drop' : undefined}
            style={landsHere ? ({ '--drop': `${drop.toFixed(1)}px` } as CSSProperties) : undefined}
            cx={x(p.date)}
            cy={y(p.kg)}
            r="2.4"
            fill="var(--t3)"
            opacity="0.6"
          >
            <title>{`${fmtDay(parseYmd(p.date))}: ${fmtKg(p.kg)} kg`}</title>
          </circle>
        );
      })}
      {land && <circle key={`touch:${land.n}`} className="tr-wt-touch" cx={x(land.date)} cy={y(landKg)} r="2.4" fill="none" stroke="var(--ac)" strokeWidth="1.2" aria-hidden="true" />}
      {linePoints.length > 1 && <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
      {runOn && (
        <line
          key={`run:${land!.n}`}
          className="tr-wt-run"
          x1={x(prev.date)}
          y1={y(prev.avg)}
          x2={x(last.date)}
          y2={y(last.avg)}
          pathLength={1}
          stroke="var(--ac)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      )}
      <circle key={runOn ? `end:${land!.n}` : 'end'} className="tr-wt-end" data-land={runOn ? '' : undefined} cx={x(last.date)} cy={y(last.avg)} r="3.4" fill="var(--acd)" />
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

// ---------- body weight against training ----------

const BW_RANGES = [
  { weeks: 12, name: '12 weeks' },
  { weeks: 26, name: '6 months' },
  { weeks: 52, name: '1 year' },
];

/** Follows its container's width, for the SVG charts. */
function useWidth(initial = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => el.clientWidth && setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const signedKg = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmtKg(Math.abs(n))} kg`;

/** Weekly volume as bars, sessions over them, and the 7-day average body weight as a line. */
function WeightAndTraining({ workouts, weights, today, weeks, onWeeks }: {
  workouts: Workout[];
  weights: Record<string, number>;
  today: Date;
  weeks: number;
  onWeeks: (n: number) => void;
}) {
  const rows = useMemo(() => trainingWeeks(workouts, weights, today, weeks), [workouts, weights, today, weeks]);
  const [ref, W] = useWidth();
  const H = W < 420 ? 170 : 200;
  const L = 44;
  const R = 40;
  const T = 18;
  const B = 22;
  const vmax = niceMax(Math.max(1000, ...rows.map((r) => r.volume)));
  const kgs = rows.flatMap((r) => (r.weight === null ? [] : [r.weight]));
  const span = kgs.length ? Math.max(1, Math.max(...kgs) - Math.min(...kgs)) : 1;
  const lo = kgs.length ? Math.floor(Math.min(...kgs) - span * 0.4) : 0;
  const hi = kgs.length ? Math.ceil(Math.max(...kgs) + span * 0.4) : 1;
  const slot = (W - L - R) / rows.length;
  const x = (i: number) => L + slot * (i + 0.5);
  const yv = (v: number) => H - B - (v / vmax) * (H - T - B);
  const yw = (k: number) => T + ((hi - k) / (hi - lo)) * (H - T - B);
  const line = rows.flatMap((r, i) => (r.weight === null ? [] : [`${x(i).toFixed(1)},${yw(r.weight).toFixed(1)}`])).join(' ');
  const bar = Math.min(26, slot * 0.6);
  const sessions = rows.reduce((a, r) => a + r.sessions, 0);
  const volume = rows.reduce((a, r) => a + r.volume, 0);
  const firstKg = rows.find((r) => r.weight !== null)?.weight ?? null;
  const lastKg = [...rows].reverse().find((r) => r.weight !== null)?.weight ?? null;
  const change = firstKg !== null && lastKg !== null && kgs.length > 1 ? Math.round((lastKg - firstKg) * 10) / 10 : null;
  const label = (r: TrainingWeek) =>
    `Week of ${fmtDay(parseYmd(r.start))}: ${r.sessions} session${r.sessions === 1 ? '' : 's'}, ${kg(r.volume)}${r.weight !== null ? `, ${fmtKg(r.weight)} kg average` : ''}`;
  const first = parseYmd(rows[0].start);

  return (
    <section className="panel you-panel tr-bvt" aria-label="Body weight against training">
      <div className="panel-head">
        <h2 className="panel-title">Weight and training</h2>
        <div className="segmented" role="group" aria-label="Range">
          <Glide on={weeks} />
          {BW_RANGES.map((r) => (
            <button key={r.weeks} className={weeks === r.weeks ? 'on' : ''} aria-pressed={weeks === r.weeks} onClick={() => onWeeks(r.weeks)}>
              {r.name}
            </button>
          ))}
        </div>
      </div>
      <div ref={ref}>
        <svg className="tr-wt-chart" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly volume and body weight. ${rows.map(label).join('; ')}`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={L} x2={W - R} y1={yv(vmax * f)} y2={yv(vmax * f)} stroke="var(--ln)" />
              <text x={L - 6} y={yv(vmax * f) + 3.5} textAnchor="end">
                {f ? `${fmtKg(Math.round((vmax * f) / 100) / 10)} t` : '0'}
              </text>
            </g>
          ))}
          {kgs.length > 0 &&
            [lo, (lo + hi) / 2, hi].map((t) => (
              <text key={t} x={W - R + 6} y={yw(t) + 3.5} textAnchor="start">
                {fmtKg(Math.round(t * 10) / 10)}
              </text>
            ))}
          {rows.map((r, i) => (
            <g key={r.start}>
              <rect
                x={x(i) - bar / 2}
                y={yv(r.volume)}
                width={bar}
                height={Math.max(r.volume ? 2 : 0, H - B - yv(r.volume))}
                rx="2"
                fill="var(--t3)"
                opacity={i === rows.length - 1 ? 0.8 : 0.4}
              >
                <title>{label(r)}</title>
              </rect>
              {weeks <= 26 && r.sessions > 0 && (
                <text x={x(i)} y={yv(r.volume) - 4} textAnchor="middle">
                  {r.sessions}
                </text>
              )}
            </g>
          ))}
          {kgs.length > 1 && <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
          {rows.map((r, i) =>
            r.weight === null ? null : (
              <circle key={r.start} cx={x(i)} cy={yw(r.weight)} r={i === rows.length - 1 ? 3.4 : 2.2} fill={i === rows.length - 1 ? 'var(--acd)' : 'var(--ac)'}>
                <title>{label(r)}</title>
              </circle>
            ),
          )}
          <text x={x(0) - bar / 2} y={H - 5} textAnchor="start">
            {`${first.getDate()} ${MON[first.getMonth()]}`}
          </text>
          <text x={x(rows.length - 1) + bar / 2} y={H - 5} textAnchor="end">
            This week
          </text>
        </svg>
      </div>
      <span className="legend">
        <span className="legend-swatch" style={{ background: 'var(--t3)', opacity: 0.5 }} />
        Lifted a week{weeks <= 26 ? ', sessions on top' : ''}
        <span className="legend-line" style={{ marginLeft: 8 }} />
        Body weight, 7-day average
      </span>
      <div className="you-foot" style={{ marginTop: 'auto' }}>
        <span>
          <b>{sessions}</b> sessions · {(sessions / weeks).toFixed(1)} a week
        </span>
        <span>
          <b>{kg(volume)}</b> lifted
        </span>
        {change !== null ? (
          <span>
            Weight <b>{signedKg(change)}</b>
          </span>
        ) : (
          <span>{kgs.length ? 'One week with a weigh-in so far' : 'Log your weight in Body weight to see it here'}</span>
        )}
      </div>
    </section>
  );
}
