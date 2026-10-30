import { useEffect, useState } from 'react';
import { DOW, MON, addDays, dayDiff, startOfDay, ymd } from '../../../shared/dates';
import {
  MOOD_WORDS, countdownNext, countdownPhrase, countdownProgress, dailyCounts, fmtDuration, longestGapMs, moodMonth, smokesOn, sortCountdowns,
} from '../../../shared/trackers';
import type { AppState, Countdown, Mood } from '../../../shared/types';
import { fmtDay, hm, newId } from '../util';

interface Props {
  data: AppState;
  now: Date;
  /** Bumped by ⌘K › Add a countdown to open the form. */
  addSignal: number;
  onCountdowns: (list: Countdown[]) => void;
  onLogSmoke: () => void;
  onUndoSmoke: (at: string) => void;
  onMood: (date: string, mood: Mood | null) => void;
}

/** The "You" view: countdowns, the cigarette log and a daily mood. */
export function You({ data, now, addSignal, onCountdowns, onLogSmoke, onUndoSmoke, onMood }: Props) {
  return (
    <main className="you">
      <Countdowns list={data.countdowns} now={now} addSignal={addSignal} onChange={onCountdowns} />
      <div className="you-row">
        <Cigarettes smokes={data.smokes} limit={data.prefs.cigaretteLimit} now={now} onLog={onLogSmoke} onUndo={onUndoSmoke} />
        <MoodPanel moods={data.moods} now={now} onMood={onMood} />
      </div>
    </main>
  );
}

// ---------- countdowns ----------

type Draft = { id: string | null; title: string; date: string; yearly: boolean };

function Countdowns({ list, now, addSignal, onChange }: { list: Countdown[]; now: Date; addSignal: number; onChange: (l: Countdown[]) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const today = startOfDay(now);
  const blank = (): Draft => ({ id: null, title: '', date: ymd(addDays(startOfDay(new Date()), 7)), yearly: false });
  useEffect(() => {
    if (addSignal) setDraft(blank());
  }, [addSignal]);
  const sorted = sortCountdowns(list, today);

  const save = () => {
    if (!draft || !draft.title.trim() || !draft.date) return;
    const item = { title: draft.title.trim(), date: draft.date, yearly: draft.yearly };
    onChange(
      draft.id
        ? list.map((c) => (c.id === draft.id ? { ...c, ...item } : c))
        : [...list, { id: newId('c'), createdAt: new Date().toISOString(), ...item }],
    );
    setDraft(null);
  };

  return (
    <section className="panel you-panel" aria-label="Countdowns">
      <div className="panel-head">
        <h2 className="panel-title">Countdowns</h2>
        <button className="btn btn-ghost btn-small" onClick={() => setDraft(blank())}>
          <i className="ph-duotone ph-plus" />
          Add countdown
        </button>
      </div>
      <div className="cd-grid">
        {draft && !draft.id && <CountdownForm draft={draft} onDraft={setDraft} onSave={save} onCancel={() => setDraft(null)} />}
        {sorted.map((c, i) => {
          if (draft?.id === c.id) {
            return (
              <CountdownForm
                key={c.id}
                draft={draft}
                onDraft={setDraft}
                onSave={save}
                onCancel={() => setDraft(null)}
                onDelete={() => {
                  onChange(list.filter((x) => x.id !== c.id));
                  setDraft(null);
                }}
              />
            );
          }
          const next = countdownNext(c, today);
          const first = i === 0 && next.days >= 0;
          return (
            <button
              key={c.id}
              className={'cd-card' + (first ? ' first' : '') + (next.days < 0 ? ' past' : '')}
              title="Edit"
              onClick={() => setDraft({ id: c.id, title: c.title, date: c.date, yearly: c.yearly })}
            >
              <span className="cd-top">
                <span className="cd-title">{c.title}</span>
                <span className="meta">{fmtDay(next.date)}</span>
              </span>
              <span className="cd-num">
                {next.days > 1 ? (
                  <>
                    <span className="serif tnum">{next.days}</span>
                    <span className="cd-unit">days</span>
                  </>
                ) : (
                  <span className="serif cd-word">{countdownPhrase(next.days)[0].toUpperCase() + countdownPhrase(next.days).slice(1)}</span>
                )}
                {c.yearly && <span className="chip chip-neutral" style={{ marginLeft: 'auto' }}>Every year</span>}
              </span>
              <span className="cd-bar">
                <span style={{ width: `${Math.round(countdownProgress(c, today) * 100)}%` }} />
              </span>
            </button>
          );
        })}
        {!list.length && !draft && (
          <div className="empty" style={{ padding: 0 }}>
            <p>Count down to trips, birthdays and deadlines. The nearest one also shows under the greeting.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function CountdownForm({ draft, onDraft, onSave, onCancel, onDelete }: {
  draft: Draft;
  onDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  return (
    <form
      className="cd-card cd-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onCancel())}
    >
      <input className="input sm" autoFocus placeholder="What’s coming up?" aria-label="Countdown name" value={draft.title} onChange={(e) => onDraft({ ...draft, title: e.target.value })} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input className="input sm" type="date" aria-label="Date" value={draft.date} onChange={(e) => onDraft({ ...draft, date: e.target.value })} style={{ flex: 1, minWidth: 130 }} />
        <label className="cd-yearly">
          <input type="checkbox" checked={draft.yearly} onChange={(e) => onDraft({ ...draft, yearly: e.target.checked })} />
          Every year
        </label>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button type="submit" className="btn btn-primary btn-small" disabled={!draft.title.trim() || !draft.date}>
          Save
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="btn btn-ghost btn-small" style={{ marginLeft: 'auto', color: 'var(--wn)' }} onClick={onDelete}>
            Delete
          </button>
        )}
      </div>
    </form>
  );
}

// ---------- cigarettes ----------

const UNDO_FOR = 10 * 60_000;
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function Cigarettes({ smokes, limit, now, onLog, onUndo }: {
  smokes: string[];
  limit: number;
  now: Date;
  onLog: () => void;
  onUndo: (at: string) => void;
}) {
  const today = startOfDay(now);
  const todays = smokesOn(smokes, now);
  const count = todays.length;
  const last = smokes[smokes.length - 1];
  const lastAt = last ? new Date(last) : null;
  const canUndo = !!lastAt && now.getTime() - lastAt.getTime() < UNDO_FOR;
  const days = dailyCounts(smokes, today, 14);
  const week = days.slice(7).reduce((a, d) => a + d.count, 0);
  const before = days.slice(0, 7).reduce((a, d) => a + d.count, 0);
  const gap = longestGapMs(smokes, now);
  const top = Math.max(4, limit, ...days.map((d) => d.count)) * 1.15;
  const over = limit > 0 && count > limit;
  const pct = (d: Date) => ((d.getTime() - today.getTime()) / 86_400_000) * 100;

  return (
    <section className="panel you-panel cig" aria-label="Cigarettes">
      <div className="panel-head">
        <h2 className="panel-title">Cigarettes</h2>
        <span className="meta">{limit ? `Daily limit ${limit}` : 'No daily limit · set one in Settings › Trackers'}</span>
      </div>

      <div className="cig-top">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span className="serif tnum cig-count" style={over ? { color: 'var(--wn)' } : undefined}>
              {count}
            </span>
            <span style={{ fontSize: 13, color: 'var(--t2)' }}>{limit ? `today, of ${limit}` : 'today'}</span>
          </div>
          {limit > 0 && (
            <div className="pips" aria-hidden="true">
              {Array.from({ length: Math.max(limit, count) }, (_, i) => (
                <span key={i} style={{ background: i < count ? (i >= limit ? 'var(--wn)' : 'var(--t2)') : 'var(--ln)' }} />
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span className="meta">Last one</span>
          <span className="serif" style={{ fontSize: 22, lineHeight: 1.1 }}>
            {lastAt ? (now.getTime() - lastAt.getTime() < 60_000 ? 'Just now' : `${fmtDuration(now.getTime() - lastAt.getTime())} ago`) : '—'}
          </span>
          {lastAt && <span className="meta">{dayDiff(lastAt, today) === 0 ? `at ${hm(lastAt)}` : `${fmtDay(lastAt)}, ${hm(lastAt)}`}</span>}
        </div>
        <span style={{ flex: 1 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {canUndo && (
            <button className="btn btn-ghost" onClick={() => onUndo(last!)}>
              Undo
            </button>
          )}
          <button className="btn btn-primary cig-log" onClick={onLog}>
            <i className="ph-duotone ph-plus" />
            Log one
            <span className="kbd on-accent">C</span>
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className="sec-label">Today</span>
        <div className="day-line" role="img" aria-label={count ? `Today at ${todays.map(hm).join(', ')}` : 'None today'}>
          <span className="day-line-track" />
          <span className="day-line-past" style={{ width: `${pct(now)}%` }} />
          {todays.map((d) => (
            <span key={d.getTime()} className="day-line-dot" title={hm(d)} style={{ left: `${pct(d)}%` }} />
          ))}
          <span className="day-line-now" style={{ left: `${pct(now)}%` }} />
        </div>
        <div className="axis tnum">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      </div>

      <div className="cig-chart-wrap">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span className="sec-label">Last 14 days</span>
          {limit > 0 && (
            <span className="legend">
              <span className="legend-dash" />
              Limit
            </span>
          )}
        </div>
        <div className="cig-chart" role="img" aria-label={`Per day: ${days.map((d) => d.count).join(', ')}`}>
          {limit > 0 && <span className="cig-limit" style={{ bottom: `${(limit / top) * 100}%` }} />}
          {days.map((d, i) => {
            const isToday = i === days.length - 1;
            const high = limit > 0 && d.count > limit;
            return (
              <div key={d.date.getTime()} className="cig-col" title={`${fmtDay(d.date)} · ${d.count}`}>
                <span className="cig-n tnum">{d.count || ''}</span>
                <span
                  className="cig-bar"
                  style={{
                    height: `${(d.count / top) * 100}%`,
                    background: high ? 'var(--wn)' : isToday ? 'var(--ac)' : 'var(--t3)',
                    opacity: high || isToday ? 1 : 0.55,
                  }}
                />
              </div>
            );
          })}
        </div>
        <div className="cig-days">
          {days.map((d, i) => (
            <span key={d.date.getTime()} style={i === days.length - 1 ? { color: 'var(--tx)', fontWeight: 600 } : undefined}>
              {DAY_LETTERS[d.date.getDay()]}
            </span>
          ))}
        </div>
      </div>

      <div className="you-foot">
        <span>
          Last 7 days <b>{week}</b> · {(week / 7).toFixed(1)} a day
        </span>
        <span>
          Week before <b>{before}</b>
        </span>
        {gap !== null && (
          <span>
            Longest gap, last 7 days <b>{fmtDuration(gap)}</b>
          </span>
        )}
      </div>
    </section>
  );
}

// ---------- mood ----------

export const moodColor = (level: number) => `color-mix(in srgb, var(--ac) ${[18, 36, 56, 78, 100][level - 1]}%, var(--sf))`;

function MoodPanel({ moods, now, onMood }: { moods: Record<string, Mood>; now: Date; onMood: (date: string, mood: Mood | null) => void }) {
  const todayKey = ymd(now);
  // The day being edited: today unless an earlier day in the calendar was picked.
  const [picked, setPicked] = useState<string | null>(null);
  const selKey = picked && picked < todayKey ? picked : todayKey;
  const isToday = selKey === todayKey;
  const selDay = new Date(`${selKey}T00:00:00`);
  const mine = moods[selKey];
  const [note, setNote] = useState(mine?.note ?? '');
  const [offset, setOffset] = useState(0);
  useEffect(() => setNote(moods[selKey]?.note ?? ''), [moods, selKey]);

  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const y = month.getFullYear();
  const m = month.getMonth();
  const daysIn = new Date(y, m + 1, 0).getDate();
  const lead = (month.getDay() + 6) % 7;
  const { avg, logged } = moodMonth(moods, y, m);
  const elapsed = offset === 0 ? now.getDate() : daysIn;

  const pick = (level: number) => onMood(selKey, mine?.level === level ? null : { level, note });
  const saveNote = () => mine && note.trim() !== mine.note && onMood(selKey, { level: mine.level, note: note.trim() });
  const backToToday = () => {
    setPicked(null);
    setOffset(0);
  };

  return (
    <section className="panel you-panel mood" aria-label="Mood">
      <div className="panel-head">
        <h2 className="panel-title">Mood</h2>
        <span className="mood-month">
          <button className="icon-btn" aria-label="Previous month" onClick={() => setOffset(offset - 1)}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <span className="meta" style={{ minWidth: 64, textAlign: 'center' }}>
            {MON[m]} {y}
          </span>
          <button className="icon-btn" aria-label="Next month" disabled={offset >= 0} onClick={() => setOffset(offset + 1)}>
            <i className="ph-duotone ph-caret-right" />
          </button>
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 13, color: 'var(--t2)' }}>
          {isToday ? 'How’s today going?' : `How was ${DOW[selDay.getDay()]} ${selDay.getDate()} ${MON[selDay.getMonth()]}?`}
          {!isToday && (
            <button className="btn-link" onClick={backToToday}>
              Back to today
            </button>
          )}
        </span>
        <div className="mood-pick">
          {MOOD_WORDS.map((w, i) => {
            const level = i + 1;
            const on = mine?.level === level;
            return (
              <button
                key={w}
                aria-pressed={on}
                className={'mood-btn' + (on ? ' on' : '')}
                style={on ? { background: moodColor(level), color: level >= 4 ? 'var(--on)' : 'var(--tx)' } : undefined}
                onClick={() => pick(level)}
              >
                <span className="serif">{level}</span>
                <span>{w}</span>
              </button>
            );
          })}
        </div>
        <input
          className="input sm"
          aria-label={isToday ? 'Note for today' : `Note for ${selKey}`}
          placeholder={mine ? 'Add a note, if you like' : 'Pick a mood first, then add a note'}
          disabled={!mine}
          value={note}
          maxLength={280}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
      </div>

      <div className="mood-grid">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <span key={i} className="mood-dow">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={'l' + i} />
        ))}
        {Array.from({ length: daysIn }, (_, i) => {
          const day = new Date(y, m, i + 1);
          const key = ymd(day);
          const v = moods[key];
          const diff = dayDiff(now, day);
          const title = `${DOW[day.getDay()]} ${i + 1} ${MON[m]}${v ? ` · ${MOOD_WORDS[v.level - 1]}${v.note ? ` · ${v.note}` : ''}` : ''}`;
          const cls =
            'mood-cell tnum' + (diff === 0 ? ' today' : '') + (diff > 0 ? ' future' : '') + (!v && diff < 0 ? ' missed' : '') + (key === selKey && !isToday ? ' sel' : '');
          const style = v ? { background: moodColor(v.level), color: v.level >= 4 ? 'var(--on)' : 'var(--tx)' } : undefined;
          // Today and earlier days can be picked to log or change their mood; future days can't.
          return diff > 0 ? (
            <span key={key} title={title} className={cls} style={style}>
              {i + 1}
            </span>
          ) : (
            <button key={key} title={title} aria-label={title} aria-pressed={key === selKey} className={cls} style={style} onClick={() => setPicked(diff === 0 ? null : key)}>
              {i + 1}
            </button>
          );
        })}
      </div>

      <div className="you-foot" style={{ marginTop: 'auto', justifyContent: 'space-between' }}>
        <span>
          {avg !== null ? (
            <>
              Average <b>{avg.toFixed(1)}</b> · logged {logged} of {elapsed} days
            </>
          ) : (
            'Nothing logged this month'
          )}
        </span>
        <span className="legend">
          Rough
          {[1, 2, 3, 4, 5].map((l) => (
            <span key={l} className="legend-swatch" style={{ background: moodColor(l) }} />
          ))}
          Great
        </span>
      </div>
    </section>
  );
}

/** Nearest upcoming countdown for the line under the greeting: "Japan in 23 days". */
export function nearestCountdown(list: Countdown[], now: Date): string {
  const today = startOfDay(now);
  const next = sortCountdowns(list, today)[0];
  if (!next) return '';
  const { days } = countdownNext(next, today);
  return days >= 0 ? `${next.title} ${countdownPhrase(days)}` : '';
}
