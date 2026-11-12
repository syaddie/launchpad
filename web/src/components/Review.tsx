import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { DOW, MON, addDays, startOfDay, ymd } from '../../../shared/dates';
import { fmtStudy } from '../../../shared/learn';
import { fmtMoney } from '../../../shared/money';
import { weekReview } from '../../../shared/review';
import { MOOD_WORDS, STRENGTH_WORDS, smokeCountMap, triggerName } from '../../../shared/trackers';
import { fmtKg, fmtMinutes, weekStart } from '../../../shared/training';
import type { AppState, ViewKey } from '../../../shared/types';
import { api } from '../api';
import { ago } from '../util';
import { VIEWS } from './Rail';

const VIEW_NAMES = Object.fromEntries(VIEWS.map((v) => [v.key, v.name])) as Record<ViewKey, string>;

interface Props {
  data: AppState;
  now: Date;
  /** Claude is writing the recap. */
  busy: boolean;
  /** Write the recap of the week starting on this Monday again. */
  onRefresh: (week: string) => void;
  onView: (v: ViewKey) => void;
}

/** How far back the week can step. */
const OLDEST = -104;

const weekName = (offset: number) => (offset === 0 ? 'This week' : offset === -1 ? 'Last week' : `${-offset} weeks ago`);
const kg = (n: number) => `${Math.round(n).toLocaleString('en-GB')} kg`;
const signed = (n: number, fmt: (x: number) => string) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${fmt(Math.abs(n))}`;
const moodColor = (level: number) => `color-mix(in srgb, var(--ac) ${[18, 36, 56, 78, 100][level - 1]}%, var(--sf))`;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** The Review view: one week's numbers from every part of Launchpad, with Claude's recap. */
export function ReviewView({ data, now, busy, onRefresh, onView }: Props) {
  const [offset, setOffset] = useState(0);
  const today = startOfDay(now);
  const mon = addDays(weekStart(today), 7 * offset);
  const week = ymd(mon);
  const sun = addDays(mon, 6);

  // Tasks ticked off come from Google Tasks, so they're asked for each week.
  const [tasks, setTasks] = useState<Record<string, number | null | 'error'>>({});
  const googleTasks = data.google.connected && data.prefs.sources.tasks;
  useEffect(() => {
    if (!googleTasks) return;
    let live = true;
    api
      .reviewTasks(week)
      .then((r) => live && setTasks((t) => ({ ...t, [week]: r.done })))
      .catch(() => live && setTasks((t) => ({ ...t, [week]: 'error' })));
    return () => {
      live = false;
    };
  }, [week, googleTasks, data.tasks.length]);
  const taskCount = tasks[week];

  const counts = useMemo(() => smokeCountMap(data.smokes, data.smokeDays), [data.smokes, data.smokeDays]);
  const r = useMemo(
    () =>
      weekReview(
        {
          workouts: data.training.workouts,
          weights: data.weights,
          smokes: counts,
          cravings: data.cravings,
          moods: data.moods,
          learn: data.learn,
          money: data.money,
          prefs: data.prefs,
          delivered: data.delivered,
          tasksDone: typeof taskCount === 'number' ? taskCount : null,
        },
        mon,
        now,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, counts, week, taskCount, today.getTime()],
  );

  const note = data.reviewNotes.notes[week] ?? null;
  const { cigarettes: c, training: t, study: s } = r;
  const range = `${mon.getDate()} ${MON[mon.getMonth()]} – ${sun.getDate()} ${MON[sun.getMonth()]}${sun.getFullYear() !== today.getFullYear() ? ` ${sun.getFullYear()}` : ''}`;
  const moodDays = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(mon, i);
    return { d, m: data.moods[ymd(d)], ahead: d > today };
  });

  return (
    <main className="you review" aria-label="Review">
      <div className="tr-head">
        <h2 className="panel-title" style={{ margin: 0 }}>
          {weekName(offset)}
        </h2>
        <span className="mood-month">
          <button className="icon-btn" aria-label="Previous week" disabled={offset <= OLDEST} onClick={() => setOffset(offset - 1)}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <span className="meta" style={{ minWidth: 118, textAlign: 'center' }}>
            {range}
          </span>
          <button className="icon-btn" aria-label="Next week" disabled={offset >= 0} onClick={() => setOffset(offset + 1)}>
            <i className="ph-duotone ph-caret-right" />
          </button>
          {offset < 0 && (
            <button className="btn-link meta" style={{ marginLeft: 8 }} onClick={() => setOffset(0)}>
              This week
            </button>
          )}
        </span>
      </div>

      {data.newsSummaries && (
        <section className="panel you-panel tr-note" aria-label="Claude’s recap of the week" aria-busy={busy}>
          <div className="panel-head">
            <span className="sec-label">Claude’s recap</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {note && <span className="meta">{busy ? 'Writing a new one…' : `Written ${ago(note.writtenAt, now)}`}</span>}
              <button className="icon-btn" title="Write the recap again" disabled={busy} onClick={() => onRefresh(week)}>
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
          ) : (
            <p className="meta" style={{ margin: 0 }}>
              {busy ? 'Reading the week and writing a recap…' : offset === 0 ? 'Claude writes a short recap of the week on Sunday evening. Press refresh to have one now.' : 'No recap for this week. Press refresh to write one.'}
            </p>
          )}
          {data.reviewNotes.error && !busy && <p className="meta" style={{ margin: 0, color: 'var(--wn)' }}>{data.reviewNotes.error}</p>}
        </section>
      )}

      <div className="rv-grid">
        <Tile title="Training" icon="ph-barbell" view="training" onView={onView}>
          <Big n={t.sessions} unit={t.sessions === 1 ? 'session' : 'sessions'} />
          {t.sessions > 0 && <span className="rv-line tnum">{fmtMinutes(t.minutes)} · {t.sets} working sets · {kg(t.volume)}</span>}
          <span className="meta tnum">Week before: {plural(t.prevSessions, 'session')}{t.prevVolume ? `, ${kg(t.prevVolume)}` : ''}</span>
        </Tile>

        <Tile title="Body weight" icon="ph-scales" view="training" onView={onView}>
          {r.weight.avg !== null ? <Big n={fmtKg(Math.round(r.weight.avg * 10) / 10)} unit="kg, 7-day average" /> : <Big n="–" unit="not logged" />}
          <span className="rv-line tnum">{r.weight.change !== null ? `${signed(Math.round(r.weight.change * 10) / 10, (x) => `${fmtKg(x)} kg`)} on the week before` : r.weight.avg !== null ? 'Nothing logged the week before to compare' : 'Log it in Training or type “weight 72.4” in ⌘K'}</span>
        </Tile>

        <Tile title="Cigarettes" icon="ph-cigarette" view="you" onView={onView}>
          <Big n={c.count} unit={c.limit ? `of ${c.limit * r.daysIn} at your limit` : c.count === 1 ? 'cigarette' : 'cigarettes'} warn={c.limit > 0 && c.count > c.limit * r.daysIn} />
          <span className="rv-line tnum">
            {c.perDay} a day
            {c.limit > 0 && ` · over the limit on ${plural(c.daysOver, 'day')}`}
            {c.cost !== null && ` · ${fmtMoney(c.cost)}`}
          </span>
          <span className="meta tnum">Week before: {c.prevCount}</span>
        </Tile>

        <Tile title="Cravings" icon="ph-hand-palm" view="you" onView={onView}>
          <Big n={r.cravings.resisted} unit="resisted" />
          <span className="rv-line">
            {r.cravings.resisted
              ? [r.cravings.strong && `${r.cravings.strong} ${STRENGTH_WORDS[2].toLowerCase()}`, r.cravings.topTrigger && `most often ${triggerName(r.cravings.topTrigger).toLowerCase()}`].filter(Boolean).join(' · ') || 'No triggers noted'
              : 'None logged. Shift C logs one'}
          </span>
          <span className="meta tnum">Against {plural(c.count, 'cigarette')} smoked</span>
        </Tile>

        <Tile title="Mood" icon="ph-smiley" view="you" onView={onView}>
          {r.mood.avg !== null ? <Big n={r.mood.avg.toFixed(1)} unit={`of 5, ${MOOD_WORDS[Math.round(r.mood.avg) - 1].toLowerCase()} on average`} /> : <Big n="–" unit="not rated" />}
          <div className="rv-week" aria-hidden="true">
            {moodDays.map(({ d, m, ahead }) => (
              <span key={d.getTime()} className={'rv-day' + (ahead ? ' ahead' : '') + (m?.note ? ' written' : '')} title={`${DOW[d.getDay()]} ${d.getDate()}${m && m.level ? ` · ${MOOD_WORDS[m.level - 1]}` : ''}`} style={m && m.level ? { background: moodColor(m.level) } : undefined}>
                {DOW[d.getDay()][0]}
              </span>
            ))}
          </div>
          <span className="meta tnum">
            {plural(r.mood.logged, 'day')} rated · journal on {plural(r.mood.written, 'day')}
          </span>
        </Tile>

        <Tile title="Study" icon="ph-graduation-cap" view="learn" onView={onView}>
          <Big n={fmtStudy(s.minutes)} unit="studied" />
          {s.courses.length > 0 && (
            <div className="rv-list">
              {s.courses.slice(0, 4).map((x) => (
                <span key={x.id} className="rv-row tnum">
                  <span className="rv-row-name">{x.name}</span>
                  <span>
                    {fmtStudy(x.minutes)}
                    {x.goal ? <span className="meta"> of {fmtStudy(x.goal)}</span> : null}
                  </span>
                </span>
              ))}
            </div>
          )}
          <span className="rv-line">
            {s.met + s.late.length ? `${s.met} of ${s.met + s.late.length} due handed in` : 'Nothing was due'}
            {s.ahead > 0 && ` · ${s.ahead} more due this week`}
          </span>
          {s.late.length > 0 && <span className="meta" style={{ color: 'var(--wn)' }}>Not handed in: {s.late.join(', ')}</span>}
        </Tile>

        <Tile title="Money" icon="ph-wallet" view="money" onView={onView}>
          {r.money ? (
            <>
              <Big n={fmtMoney(r.money.closing)} unit={offset === 0 ? 'in the bank so far' : 'at the end of the week'} warn={r.money.closing < 0} />
              <span className="rv-line tnum">
                {fmtMoney(r.money.in)} in · {fmtMoney(r.money.out)} out
              </span>
              <span className="meta tnum">
                Forecast for Sunday {fmtMoney(r.money.forecast)}
                {r.money.closing !== r.money.forecast && ` (${signed(Math.round((r.money.closing - r.money.forecast) * 100) / 100, (x) => fmtMoney(x))} from what’s done)`}
              </span>
            </>
          ) : (
            <>
              <Big n="–" unit="not tracked" />
              <span className="rv-line">Plan the month in Money to see the week here</span>
            </>
          )}
        </Tile>

        <Tile title="Tasks" icon="ph-check-square" view="home" onView={onView}>
          {typeof taskCount === 'number' ? (
            <Big n={taskCount} unit={taskCount === 1 ? 'task done' : 'tasks done'} />
          ) : (
            <Big n="–" unit="tasks done" />
          )}
          <span className="rv-line">
            {!googleTasks ? 'Connect Google Tasks in Settings to count them' : taskCount === 'error' ? 'Couldn’t reach Google Tasks' : taskCount === undefined ? 'Asking Google Tasks…' : taskCount === null ? 'Google Tasks didn’t answer' : 'Ticked off in Google Tasks'}
          </span>
        </Tile>

        <Tile title="Packages" icon="ph-package" view="home" onView={onView}>
          <Big n={r.packages.length} unit="delivered" />
          {r.packages.length > 0 && <span className="rv-line">{r.packages.slice(0, 4).join(', ')}{r.packages.length > 4 ? ` and ${r.packages.length - 4} more` : ''}</span>}
        </Tile>
      </div>
    </main>
  );
}

function Tile({ title, icon, view, onView, children }: { title: string; icon: string; view: ViewKey; onView: (v: ViewKey) => void; children: ReactNode }) {
  return (
    <section className="panel you-panel rv-tile" aria-label={title}>
      <div className="panel-head">
        <span className="sec-label rv-title">
          <i className={'ph-duotone ' + icon} aria-hidden="true" />
          {title}
        </span>
        <button className="icon-btn" title={`Open ${VIEW_NAMES[view]}`} onClick={() => onView(view)}>
          <i className="ph-duotone ph-arrow-up-right" />
        </button>
      </div>
      {children}
    </section>
  );
}

function Big({ n, unit, warn }: { n: number | string; unit: string; warn?: boolean }) {
  return (
    <span className="rv-big">
      <span className="serif tnum" style={warn ? { color: 'var(--wn)' } : undefined}>
        {n}
      </span>
      <span>{unit}</span>
    </span>
  );
}
