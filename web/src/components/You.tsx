import { useEffect, useMemo, useRef, useState } from 'react';
import { DOW, MON, addDays, dayDiff, parseYmd, startOfDay, ymd } from '../../../shared/dates';
import { fmtMoney } from '../../../shared/money';
import {
  CRAVING_TRIGGERS, MAX_JOURNAL, MOOD_WORDS, STRENGTH_WORDS, cigPrice, countdownNext, countdownPhrase, countdownProgress, cravingSummary, cravingsOn, dailyCounts, fmtDuration,
  longestGapMs, moodMonth, moodYear, savedUnderLimit, searchJournal, smokeCountMap, smokeSpend, smokesOn, sortCountdowns, triggerName,
} from '../../../shared/trackers';
import type { AppState, Countdown, Craving, Mood, Prefs } from '../../../shared/types';
import { fmtDay, hm, newId } from '../util';
import { NoteLines, toggleLine } from './Notes';

interface Props {
  data: AppState;
  now: Date;
  /** Bumped by ⌘K › Add a countdown to open the form. */
  addSignal: number;
  onCountdowns: (list: Countdown[]) => void;
  onLogSmoke: () => void;
  onUndoSmoke: (at: string) => void;
  onMood: (date: string, mood: Mood | null) => void;
  onLogCraving: () => void;
  /** Add a craving or change one. */
  onCraving: (c: Craving) => void;
  onRemoveCraving: (id: string) => void;
  onOpenSettings: () => void;
}

/** The "You" view: countdowns, the cigarette log and what it costs, cravings, a daily mood and journal, and the year in pixels. */
export function You({ data, now, addSignal, onCountdowns, onLogSmoke, onUndoSmoke, onMood, onLogCraving, onCraving, onRemoveCraving, onOpenSettings }: Props) {
  const counts = useMemo(() => smokeCountMap(data.smokes, data.smokeDays), [data.smokes, data.smokeDays]);
  // The day open in the mood panel: today unless an earlier one was picked in its calendar or the year.
  const [picked, setPicked] = useState<string | null>(null);
  const moodRef = useRef<HTMLElement>(null);
  const openDay = (date: string) => {
    setPicked(date === ymd(now) ? null : date);
    moodRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  return (
    <main className="you">
      <Countdowns list={data.countdowns} now={now} addSignal={addSignal} onChange={onCountdowns} />
      <div className="you-row">
        <Cigarettes smokes={data.smokes} counts={counts} prefs={data.prefs} now={now} onLog={onLogSmoke} onUndo={onUndoSmoke} onOpenSettings={onOpenSettings} />
        <MoodPanel ref={moodRef} moods={data.moods} now={now} picked={picked} onPick={setPicked} onMood={onMood} />
      </div>
      <div className="you-row">
        <Cravings cravings={data.cravings} counts={counts} now={now} onLog={onLogCraving} onSave={onCraving} onRemove={onRemoveCraving} />
        <YearPixels moods={data.moods} now={now} selected={picked ?? ymd(now)} onOpen={openDay} />
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

function Cigarettes({ smokes, counts, prefs, now, onLog, onUndo, onOpenSettings }: {
  smokes: string[];
  counts: Map<string, number>;
  prefs: Prefs;
  now: Date;
  onLog: () => void;
  onUndo: (at: string) => void;
  onOpenSettings: () => void;
}) {
  const limit = prefs.cigaretteLimit;
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

      <CigCost counts={counts} prefs={prefs} today={today} onOpenSettings={onOpenSettings} />

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

/** What they cost today, this week, this month and over the last year, and what staying under the limit saved. */
function CigCost({ counts, prefs, today, onOpenSettings }: { counts: Map<string, number>; prefs: Prefs; today: Date; onOpenSettings: () => void }) {
  const price = cigPrice(prefs);
  if (!price) {
    return (
      <button className="btn-link meta" style={{ alignSelf: 'flex-start' }} onClick={onOpenSettings}>
        Add what a pack costs in Settings to see what they cost
      </button>
    );
  }
  const spend = smokeSpend(counts, today, price);
  const limit = prefs.cigaretteLimit;
  const month = savedUnderLimit(counts, today, limit, price, ymd(new Date(today.getFullYear(), today.getMonth(), 1)));
  const year = savedUnderLimit(counts, today, limit, price, ymd(addDays(today, -365)));
  const cells: [string, { count: number; cost: number }][] = [
    ['Today', spend.today],
    ['This week', spend.week],
    ['This month', spend.month],
    ['Last year', spend.year],
  ];
  return (
    <div className="cig-cost">
      <div className="tr-totals">
        {cells.map(([name, s]) => (
          <div key={name} title={`${s.count} cigarette${s.count === 1 ? '' : 's'}`}>
            <b className="serif tnum">{fmtMoney(s.cost)}</b>
            {name}
          </div>
        ))}
      </div>
      <span className="meta">
        {fmtMoney(prefs.packPrice)} for {prefs.packSize}, so {fmtMoney(price)} each.
        {limit > 0 && year.days > 0 && ` Staying under ${limit} a day saved ${fmtMoney(month.saved)} this month and ${fmtMoney(year.saved)} over the last year, against smoking the limit every day.`}
      </span>
    </div>
  );
}

// ---------- cravings ----------

/** Cravings not acted on: log one, set how strong and what set it off, and see them against cigarettes smoked. */
function Cravings({ cravings, counts, now, onLog, onSave, onRemove }: {
  cravings: Craving[];
  counts: Map<string, number>;
  now: Date;
  onLog: () => void;
  onSave: (c: Craving) => void;
  onRemove: (id: string) => void;
}) {
  const today = startOfDay(now);
  const two = useMemo(() => cravingSummary(cravings, counts, today, 14), [cravings, counts, today.getTime()]);
  const month = useMemo(() => cravingSummary(cravings, counts, today, 30), [cravings, counts, today.getTime()]);
  const todays = cravingsOn(cravings, now).length;
  const smoked = counts.get(ymd(now)) ?? 0;
  const [open, setOpen] = useState<string | null>(null);
  // One that was just logged opens for its details.
  const newest = cravings[cravings.length - 1];
  const seen = useRef(newest?.id);
  useEffect(() => {
    if (newest && newest.id !== seen.current && Date.now() - Date.parse(newest.at) < 60_000) setOpen(newest.id);
    seen.current = newest?.id;
  }, [newest]);
  const recent = cravings.slice(-5).reverse();
  const top = Math.max(3, ...two.byDay.map((d) => Math.max(d.resisted, d.smoked))) * 1.15;
  const maxTrigger = Math.max(1, ...month.triggers.map((t) => t.count));

  return (
    <section className="panel you-panel crv" aria-label="Cravings">
      <div className="panel-head">
        <h2 className="panel-title">Cravings</h2>
        <span className="meta">Ones you didn’t act on</span>
      </div>

      <div className="cig-top">
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="serif tnum cig-count">{todays}</span>
          <span style={{ fontSize: 13, color: 'var(--t2)' }}>
            resisted today{smoked ? `, ${smoked} smoked` : ''}
          </span>
        </div>
        <span style={{ flex: 1 }} />
        <button className="btn btn-secondary cig-log" onClick={onLog}>
          <i className="ph-duotone ph-hand-palm" />
          Log a craving
          <span className="kbd">⇧C</span>
        </button>
      </div>

      {recent.length > 0 ? (
        <div className="crv-list">
          {recent.map((c) => (
            <CravingRow key={c.id} c={c} today={today} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)} onSave={onSave} onRemove={(id) => (onRemove(id), setOpen(null))} />
          ))}
        </div>
      ) : (
        <p className="meta" style={{ margin: 0 }}>
          When you want one and don’t have it, log it here or press Shift C anywhere. Note how strong it was and what set it off, and the common triggers show up below.
        </p>
      )}

      <div className="cig-chart-wrap" style={{ minHeight: 130 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span className="sec-label">Last 14 days</span>
          <span className="legend">
            <span className="legend-swatch" style={{ background: 'var(--ac)' }} />
            Resisted
            <span className="legend-swatch" style={{ background: 'var(--t3)', opacity: 0.55, marginLeft: 6 }} />
            Smoked
          </span>
        </div>
        <div className="cig-chart" role="img" aria-label={`Resisted and smoked per day: ${two.byDay.map((d) => `${d.resisted}/${d.smoked}`).join(', ')}`}>
          {two.byDay.map((d) => (
            <div key={d.date} className="cig-col crv-col" title={`${fmtDay(parseYmd(d.date))} · ${d.resisted} resisted, ${d.smoked} smoked`}>
              <span className="crv-pair">
                <span className="cig-bar" style={{ height: `${(d.resisted / top) * 100}%`, background: 'var(--ac)' }} />
                <span className="cig-bar" style={{ height: `${(d.smoked / top) * 100}%`, background: 'var(--t3)', opacity: 0.55 }} />
              </span>
            </div>
          ))}
        </div>
        <div className="cig-days">
          {two.byDay.map((d, i) => (
            <span key={d.date} style={i === two.byDay.length - 1 ? { color: 'var(--tx)', fontWeight: 600 } : undefined}>
              {DAY_LETTERS[parseYmd(d.date).getDay()]}
            </span>
          ))}
        </div>
      </div>

      {month.triggers.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span className="sec-label">What sets them off, last 30 days</span>
          <div className="tr-bars">
            {month.triggers.slice(0, 5).map((t) => (
              <div key={t.trigger} className="tr-bar">
                <span className="tr-bl">{triggerName(t.trigger)}</span>
                <span className="tr-track">
                  <span className="tr-fill" style={{ width: `${(t.count / maxTrigger) * 100}%` }} />
                </span>
                <span className="tr-bn tnum">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="you-foot" style={{ marginTop: 'auto' }}>
        <span>
          Last 30 days <b>{month.resisted}</b> resisted · <b>{month.smoked}</b> smoked
        </span>
        {month.resisted + month.smoked > 0 && (
          <span>
            Resisted <b>{Math.round((month.resisted / (month.resisted + month.smoked)) * 100)}%</b> of the urges logged
          </span>
        )}
      </div>
    </section>
  );
}

function CravingRow({ c, today, open, onToggle, onSave, onRemove }: {
  c: Craving;
  today: Date;
  open: boolean;
  onToggle: () => void;
  onSave: (c: Craving) => void;
  onRemove: (id: string) => void;
}) {
  const [note, setNote] = useState(c.note);
  useEffect(() => setNote(c.note), [c.note]);
  const at = new Date(c.at);
  const saveNote = () => note.trim() !== c.note && onSave({ ...c, note: note.trim() });
  return (
    <div className={'crv-row' + (open ? ' open' : '')}>
      <button className="crv-sum" aria-expanded={open} onClick={onToggle}>
        <span className="tnum crv-time">{dayDiff(at, today) === 0 ? hm(at) : `${fmtDay(at)}, ${hm(at)}`}</span>
        <span className="crv-str" aria-hidden="true">
          {[1, 2, 3].map((i) => (
            <span key={i} className={i <= c.strength ? 'on' : ''} />
          ))}
        </span>
        <span className="crv-what">
          {STRENGTH_WORDS[c.strength - 1]}
          {c.trigger && ` · ${triggerName(c.trigger)}`}
          {c.note && <span className="crv-note"> · {c.note}</span>}
        </span>
        <i className={'ph-duotone ' + (open ? 'ph-caret-up' : 'ph-caret-down')} aria-hidden="true" />
      </button>
      {open && (
        <div className="crv-edit" onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onToggle())}>
          <div className="segmented" role="group" aria-label="How strong">
            {STRENGTH_WORDS.map((w, i) => (
              <button key={w} className={c.strength === i + 1 ? 'on' : ''} aria-pressed={c.strength === i + 1} onClick={() => onSave({ ...c, strength: (i + 1) as 1 | 2 | 3 })}>
                {w}
              </button>
            ))}
          </div>
          <div className="crv-triggers" role="group" aria-label="What set it off">
            {CRAVING_TRIGGERS.map((t) => (
              <button key={t.key} className={'crv-chip' + (c.trigger === t.key ? ' on' : '')} aria-pressed={c.trigger === t.key} onClick={() => onSave({ ...c, trigger: c.trigger === t.key ? '' : t.key })}>
                {t.name}
              </button>
            ))}
          </div>
          <input
            className="input sm"
            aria-label="Note"
            placeholder="A note, if you like: where you were, what helped"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-ghost btn-small" onClick={onToggle}>
              Done
            </button>
            <button className="btn btn-ghost btn-small" style={{ marginLeft: 'auto', color: 'var(--wn)' }} onClick={() => onRemove(c.id)}>
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- mood and journal ----------

export const moodColor = (level: number) => `color-mix(in srgb, var(--ac) ${[18, 36, 56, 78, 100][level - 1]}%, var(--sf))`;
const moodInk = (level: number) => (level >= 4 ? 'var(--on)' : 'var(--tx)');

function MoodPanel({ ref, moods, now, picked, onPick, onMood }: {
  ref: React.Ref<HTMLElement>;
  moods: Record<string, Mood>;
  now: Date;
  picked: string | null;
  onPick: (date: string | null) => void;
  onMood: (date: string, mood: Mood | null) => void;
}) {
  const todayKey = ymd(now);
  const selKey = picked && picked < todayKey ? picked : todayKey;
  const isToday = selKey === todayKey;
  const selDay = parseYmd(selKey);
  const mine = moods[selKey];
  const level = mine?.level ?? 0;
  const [offset, setOffset] = useState(0);
  // A day picked elsewhere (the year in pixels, a search) brings its month into view.
  useEffect(() => {
    setOffset((selDay.getFullYear() - now.getFullYear()) * 12 + selDay.getMonth() - now.getMonth());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  const month = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const y = month.getFullYear();
  const m = month.getMonth();
  const daysIn = new Date(y, m + 1, 0).getDate();
  const lead = (month.getDay() + 6) % 7;
  const { avg, logged } = moodMonth(moods, y, m);
  const elapsed = offset === 0 ? now.getDate() : daysIn;

  /** Picking the same mood again takes it off; the journal entry stays. */
  const pick = (l: number) => {
    const note = moods[selKey]?.note ?? '';
    const next = level === l ? 0 : l;
    onMood(selKey, next || note.trim() ? { level: next, note } : null);
  };

  return (
    <section ref={ref} className="panel you-panel mood" aria-label="Mood and journal">
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
          {isToday ? 'How’s today going?' : `How was ${DOW[selDay.getDay()]} ${selDay.getDate()} ${MON[selDay.getMonth()]}${selDay.getFullYear() !== now.getFullYear() ? ` ${selDay.getFullYear()}` : ''}?`}
          {!isToday && (
            <button className="btn-link" onClick={() => onPick(null)}>
              Back to today
            </button>
          )}
        </span>
        <div className="mood-pick">
          {MOOD_WORDS.map((w, i) => {
            const l = i + 1;
            const on = level === l;
            return (
              <button key={w} aria-pressed={on} className={'mood-btn' + (on ? ' on' : '')} style={on ? { background: moodColor(l), color: moodInk(l) } : undefined} onClick={() => pick(l)}>
                <span className="serif">{l}</span>
                <span>{w}</span>
              </button>
            );
          })}
        </div>
        <Journal key={selKey} date={selKey} mood={mine} isToday={isToday} onSave={(note) => onMood(selKey, level || note.trim() ? { level, note } : null)} />
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
          const rated = !!v && v.level >= 1;
          const diff = dayDiff(now, day);
          const title = `${DOW[day.getDay()]} ${i + 1} ${MON[m]}${rated ? ` · ${MOOD_WORDS[v.level - 1]}` : ''}${v?.note ? ` · ${firstLine(v.note)}` : ''}`;
          const cls =
            'mood-cell tnum' + (diff === 0 ? ' today' : '') + (diff > 0 ? ' future' : '') + (!rated && diff < 0 ? ' missed' : '') + (key === selKey && !isToday ? ' sel' : '') + (v?.note ? ' written' : '');
          const style = rated ? { background: moodColor(v.level), color: moodInk(v.level) } : undefined;
          // Today and earlier days can be picked to log or change their mood; future days can't.
          return diff > 0 ? (
            <span key={key} title={title} className={cls} style={style}>
              {i + 1}
            </span>
          ) : (
            <button key={key} title={title} aria-label={title} aria-pressed={key === selKey} className={cls} style={style} onClick={() => onPick(diff === 0 ? null : key)}>
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

const firstLine = (s: string) => {
  const line = s.trim().split('\n')[0];
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
};

/** How long typing has to pause before the entry is saved. */
const JOURNAL_SAVE_AFTER = 800;

/** A day's journal entry: light Markdown like Notes, saved as you type. */
function Journal({ date, mood, isToday, onSave }: { date: string; mood: Mood | undefined; isToday: boolean; onSave: (note: string) => void }) {
  const stored = mood?.note ?? '';
  const [text, setText] = useState(stored);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const timer = useRef(0);
  const pending = useRef<string | null>(null);
  const save = useRef(onSave);
  save.current = onSave;

  // What another tab or device saved shows here, except while typing.
  useEffect(() => {
    if (!editing && pending.current === null) setText(stored);
  }, [stored, editing]);

  const flush = () => {
    window.clearTimeout(timer.current);
    if (pending.current === null) return;
    const t = pending.current;
    pending.current = null;
    if (t.trimEnd() !== stored) {
      save.current(t.trimEnd());
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
    }
  };
  // Leaving the day (or the view) saves what's typed.
  useEffect(() => () => flush(), []);

  const change = (t: string) => {
    setText(t);
    setSaved(false);
    pending.current = t;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, JOURNAL_SAVE_AFTER);
  };
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;

  return (
    <div className="journal">
      <div className="journal-head">
        <span className="sec-label">Journal</span>
        <span className="saved" style={{ opacity: saved ? 1 : 0 }}>
          Saved
        </span>
        {words > 0 && <span className="meta tnum">{words} word{words === 1 ? '' : 's'}</span>}
      </div>
      {editing ? (
        <textarea
          className="journal-text"
          autoFocus
          aria-label={`Journal for ${date}`}
          value={text}
          maxLength={MAX_JOURNAL}
          placeholder="What happened, what you’re thinking about. “- ” bullets, “- [ ]” checklists and **bold** work as in Notes."
          onChange={(e) => change(e.target.value)}
          onBlur={() => {
            flush();
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), e.currentTarget.blur())}
        />
      ) : (
        <div
          className="journal-view"
          role="button"
          tabIndex={0}
          aria-label={`Write in the journal for ${date}`}
          onClick={() => setEditing(true)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setEditing(true))}
        >
          {text ? (
            <NoteLines text={text} onToggle={(i, c) => change(toggleLine(text, i, c))} />
          ) : (
            <span className="meta">{isToday ? 'Click to write about today.' : 'Nothing written for this day. Click to add to it.'}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- year in pixels ----------

const MONTH_LETTERS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

/** Every day of a year as a square, coloured by mood; click one to open it. With a search across the journal. */
function YearPixels({ moods, now, selected, onOpen }: { moods: Record<string, Mood>; now: Date; selected: string; onOpen: (date: string) => void }) {
  const thisYear = now.getFullYear();
  const first = Object.keys(moods).reduce((a, d) => Math.min(a, Number(d.slice(0, 4)) || a), thisYear);
  const [year, setYear] = useState(thisYear);
  const [q, setQ] = useState('');
  const stats = moodYear(moods, year);
  const found = useMemo(() => (q.trim() ? searchJournal(moods, q) : []), [moods, q]);
  const todayKey = ymd(now);

  return (
    <section className="panel you-panel pix" aria-label="Year in pixels">
      <div className="panel-head">
        <h2 className="panel-title">Year in pixels</h2>
        <span className="mood-month">
          <button className="icon-btn" aria-label="Previous year" disabled={year <= first} onClick={() => setYear(year - 1)}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <span className="meta tnum" style={{ minWidth: 40, textAlign: 'center' }}>
            {year}
          </span>
          <button className="icon-btn" aria-label="Next year" disabled={year >= thisYear} onClick={() => setYear(year + 1)}>
            <i className="ph-duotone ph-caret-right" />
          </button>
        </span>
      </div>

      <div className="pix-grid" role="grid" aria-label={`Moods in ${year}`}>
        <span />
        {Array.from({ length: 31 }, (_, d) => (
          <span key={d} className={'pix-num tnum' + ((d + 1) % 10 === 5 ? ' mid' : '')} aria-hidden="true">
            {(d + 1) % 5 === 0 || d === 0 ? d + 1 : ''}
          </span>
        ))}
        {MONTH_LETTERS.map((letter, mi) => (
          <div key={mi} role="row" style={{ display: 'contents' }}>
            <span className="pix-mon" title={MON[mi]}>
              {letter}
            </span>
            {Array.from({ length: 31 }, (_, d) => {
              const day = new Date(year, mi, d + 1);
              if (day.getMonth() !== mi) return <span key={d} className="pix-cell none" aria-hidden="true" />;
              const key = ymd(day);
              const v = moods[key];
              const rated = !!v && v.level >= 1;
              const future = key > todayKey;
              const title = `${DOW[day.getDay()]} ${d + 1} ${MON[mi]} ${year}${rated ? ` · ${MOOD_WORDS[v.level - 1]}` : ''}${v?.note ? ` · ${firstLine(v.note)}` : ''}`;
              const cls = 'pix-cell' + (rated ? '' : ' empty') + (future ? ' future' : '') + (v?.note ? ' written' : '') + (key === selected ? ' sel' : '') + (key === todayKey ? ' today' : '');
              return future ? (
                <span key={d} className={cls} aria-hidden="true" />
              ) : (
                <button key={d} role="gridcell" className={cls} title={title} aria-label={title} style={rated ? { background: moodColor(v.level) } : undefined} onClick={() => onOpen(key)} />
              );
            })}
          </div>
        ))}
      </div>

      <input className="input sm" type="search" aria-label="Search the journal" placeholder="Search the journal" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))} />
      {q.trim() && (
        <div className="pix-found">
          {found.length ? (
            found.map((f) => {
              const d = parseYmd(f.date);
              return (
                <button key={f.date} className="pix-hit" onClick={() => onOpen(f.date)}>
                  <span className="legend-swatch" style={{ background: f.level ? moodColor(f.level) : 'var(--ln)', flex: 'none' }} />
                  <span className="tnum pix-hit-day">
                    {fmtDay(d)}
                    {d.getFullYear() !== thisYear ? ` ${d.getFullYear()}` : ''}
                  </span>
                  <span className="pix-hit-text">{f.snippet}</span>
                </button>
              );
            })
          ) : (
            <span className="meta">Nothing in the journal mentions that.</span>
          )}
        </div>
      )}

      <div className="you-foot" style={{ marginTop: 'auto', justifyContent: 'space-between' }}>
        <span>
          {stats.avg !== null ? (
            <>
              Average <b>{stats.avg.toFixed(1)}</b> · {stats.logged} days rated
            </>
          ) : (
            'No moods this year'
          )}
          {stats.written > 0 && ` · ${stats.written} with an entry`}
        </span>
        <span className="legend">
          <span className="pix-cell written" style={{ width: 12, height: 12 }} />
          Has an entry
        </span>
      </div>
    </section>
  );
}
