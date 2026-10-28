import { useRef, useState } from 'react';
import { ymd } from '../../../shared/dates';
import {
  CATEGORIES, MAX_ENTRIES, MAX_WISHES, PRIORITIES, STATUSES, addMonths, affordableFrom, balanceOn, byCategory, calcMonths, calcTotals, fmtMoney, isDone,
  lowestAhead, monthKeys, monthName, moneyFromWorkbook, parseMoney, repeatDates, sortEntries, toReview, wishStats, type MonthCalc, type Repeat,
} from '../../../shared/money';
import type { Money, MoneyCategory, MoneyEntry, WishItem } from '../../../shared/types';
import { readXlsx } from '../../../shared/xlsx';
import { localGet, localSet } from '../api';
import { fmtDay, newId, parseYmd } from '../util';
import { niceMax } from './Server';

type Tab = 'overview' | 'month' | 'wishlist';
const TABS: { key: Tab; name: string }[] = [
  { key: 'overview', name: 'Overview' },
  { key: 'month', name: 'Month' },
  { key: 'wishlist', name: 'Wishlist' },
];

type Notify = (msg: string, action?: { label: string; run: () => void }) => void;

interface Props {
  money: Money;
  now: Date;
  saved: boolean;
  onChange: (m: Money) => void;
  /** A workbook was read; the page swaps it in and offers an undo. */
  onImport: (m: Money, summary: string) => void;
  notify: Notify;
}

/**
 * The Money view. Entries are planned (the forecast) or done (it happened): plan the
 * month ahead, then tick, change or delete entries as the days go by. Balances, the
 * monthly summary and the charts are worked out from the entries (shared/money.ts).
 */
export function MoneyView({ money, now, saved, onChange, onImport, notify }: Props) {
  const today = ymd(now);
  const [tab, setTabState] = useState<Tab>(() => (TABS.some((t) => t.key === localGet('moneyTab')) ? (localGet('moneyTab') as Tab) : 'month'));
  const [month, setMonth] = useState(today.slice(0, 7));
  const [importing, setImporting] = useState(false);
  const [importMonth, setImportMonth] = useState(today.slice(0, 7));
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // For toast actions that run after more edits.
  const latest = useRef(money);
  latest.current = money;

  const setTab = (t: Tab) => {
    setTabState(t);
    localSet('moneyTab', t);
  };
  const openMonth = (key: string) => {
    setMonth(key);
    setTab('month');
  };

  const importFile = async (f: File) => {
    setImportError('');
    try {
      const m = moneyFromWorkbook(await readXlsx(await f.arrayBuffer()), importMonth, today);
      if (!m.entries.length && !m.wishlist.length) throw new Error('no Tracker or Wishlist sheet found');
      const planned = m.entries.filter((e) => e.planned).length;
      onImport(m, `Imported ${m.entries.length} entries from ${monthName(importMonth)} on (${planned} still planned) and ${m.wishlist.length} wishlist item${m.wishlist.length === 1 ? '' : 's'}`);
      setImporting(false);
      setMonth(importMonth);
    } catch (e) {
      setImportError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <main className="money" aria-label="Money">
      <div className="money-head">
        <div className="tabs money-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              {t.name}
            </button>
          ))}
        </div>
        <div className="money-actions">
          <span className={'meta saved' + (saved ? ' on' : '')} aria-live="polite">
            {saved ? 'Saved' : ''}
          </span>
          {importError && <span className="meta" style={{ color: 'var(--wn)' }}>{importError}</span>}
          {importing ? (
            <>
              <label className="meta" htmlFor="money-import-month">
                Month 1 of the workbook is
              </label>
              <input id="money-import-month" className="input sm" type="month" value={importMonth} onChange={(e) => e.target.value && setImportMonth(e.target.value)} />
              <button className="btn btn-primary btn-small" onClick={() => fileRef.current?.click()}>
                Choose file…
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => (setImporting(false), setImportError(''))}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn-ghost btn-small" title="Read the Tracker and Wishlist sheets of the Money tracker workbook, replacing what’s here" onClick={() => setImporting(true)}>
              <i className="ph-duotone ph-upload-simple" />
              Import .xlsx
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) importFile(f);
            }}
          />
        </div>
      </div>
      {tab === 'overview' && <Overview money={money} today={today} onOpenMonth={openMonth} />}
      {tab === 'month' && <MonthTab money={money} today={today} month={month} onMonth={setMonth} onChange={onChange} />}
      {tab === 'wishlist' && (
        <Wishlist
          money={money}
          today={today}
          onChange={(wishlist) => onChange({ ...money, wishlist })}
          onPurchased={(w) => {
            if (!w.price) return;
            notify(`Marked ${w.name || 'it'} as purchased.`, {
              label: `Add ${fmtMoney(w.price)} as money out today`,
              run: () => {
                const m = latest.current;
                const entry: MoneyEntry = { id: newId('e'), date: today, kind: 'out', amount: w.price!, note: w.name, category: 'Shopping', planned: false };
                onChange({ ...m, entries: sortEntries([...m.entries, entry]) });
              },
            });
          }}
        />
      )}
    </main>
  );
}

// ---------- cells ----------

/** Enter and ↑/↓ move between rows of the same column, like a spreadsheet; Esc leaves the cell. */
function cellKeys(e: React.KeyboardEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (e.key === 'Escape') {
    e.stopPropagation();
    el.blur();
    return;
  }
  const step = e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey) ? 1 : e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 0;
  if (!step || el.tagName === 'SELECT' || !el.dataset.r) return;
  const grid = el.closest('[data-grid]');
  const next = grid?.querySelector<HTMLInputElement>(`[data-r="${Number(el.dataset.r) + step}"][data-c="${el.dataset.c}"]`);
  e.preventDefault();
  if (next) {
    next.focus();
    requestAnimationFrame(() => next.select?.());
  } else if (e.key === 'Enter') el.blur();
}

/** An amount: shows "$1,200" and edits as "1200". Balances recalculate as you type. */
function NumCell({ value, onChange, label, r, c, className = '' }: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  r?: number;
  c?: number;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseMoney(text) === undefined;
  return (
    <input
      className={'cell num tnum ' + className + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad || undefined}
      title={bad ? 'Type an amount, like 120 or 45.50' : undefined}
      data-r={r}
      data-c={c}
      value={text ?? (value === null ? '' : fmtMoney(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
      onKeyDown={cellKeys}
    />
  );
}

function TextCell({ value, onChange, label, r, c, max, placeholder, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  r?: number;
  c?: number;
  max: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      className={'cell ' + className}
      autoComplete="off"
      aria-label={label}
      title={value.length > 18 ? value : undefined}
      data-r={r}
      data-c={c}
      value={value}
      maxLength={max}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={cellKeys}
    />
  );
}

/** A date that only commits when you leave the cell, so a row doesn't re-sort while you type. */
function DateCell({ value, onChange, label, r, c }: { value: string; onChange: (v: string) => void; label: string; r: number; c: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft && draft !== value) onChange(draft);
    setDraft(null);
  };
  return (
    <input
      type="date"
      className="cell date tnum"
      aria-label={label}
      data-r={r}
      data-c={c}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        cellKeys(e);
      }}
    />
  );
}

function CategoryCell({ value, onChange, label }: { value: MoneyCategory | ''; onChange: (v: MoneyCategory | '') => void; label: string }) {
  return (
    <select className={'cell pick' + (value ? ' tone-neutral' : '')} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as MoneyCategory | '')} onKeyDown={cellKeys}>
      <option value="">–</option>
      {CATEGORIES.map((x) => (
        <option key={x}>{x}</option>
      ))}
    </select>
  );
}

/** A worked-out value: not editable, and negative ones in the warning colour. */
function Calc({ v, sign, title, strong }: { v: number; sign?: boolean; title: string; strong?: boolean }) {
  return (
    <span className={'calc tnum' + (v < 0 ? ' neg' : '') + (strong ? ' strong' : '')} title={title}>
      {fmtMoney(v, sign)}
    </span>
  );
}

const shortDate = (d: string) => fmtDay(parseYmd(d));

// ---------- month ----------

const REPEATS: { key: Repeat; name: string }[] = [
  { key: 'once', name: 'Once' },
  { key: 'week', name: 'Every week' },
  { key: 'fortnight', name: 'Every 2 weeks' },
  { key: 'month', name: 'Every month' },
];

type Draft = { date: string; note: string; category: MoneyCategory | ''; out: number | null; in: number | null; repeat: Repeat; until: string };

function MonthTab({ money, today, month, onMonth, onChange }: { money: Money; today: string; month: string; onMonth: (k: string) => void; onChange: (m: Money) => void }) {
  // Include the month on screen, even one before the first or past the last.
  const keys = monthKeys({ ...money, start: `${month}-01` < money.start ? `${month}-01` : money.start }, month > today.slice(0, 7) ? `${month}-01` : today);
  const months = calcMonths(money, keys);
  const calc = months[keys.indexOf(month)] ?? months[0];
  const entries = money.entries.filter((e) => e.date.slice(0, 7) === month);
  const review = toReview(money, today).filter((e) => e.date.slice(0, 7) === month);
  const isFirst = month <= keys[0];
  const blank = (): Draft => ({ date: today.slice(0, 7) === month ? today : `${month}-01`, note: '', category: '', out: null, in: null, repeat: 'once', until: month });
  const [draft, setDraft] = useState<Draft>(blank);
  const [draftMonth, setDraftMonth] = useState(month);
  if (draftMonth !== month) {
    setDraftMonth(month);
    setDraft(blank());
  }
  const [layout, setLayoutState] = useState<'list' | 'calendar'>(() => (localGet('moneyLayout') === 'calendar' ? 'calendar' : 'list'));
  const setLayout = (l: 'list' | 'calendar') => {
    setLayoutState(l);
    localSet('moneyLayout', l);
  };
  /** From the calendar: go to the list with the add row set to that day. */
  const addOn = (date: string) => {
    setDraft({ ...blank(), date });
    setLayout('list');
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="New entry note"]')?.focus());
  };

  const setEntries = (list: MoneyEntry[]) => onChange({ ...money, entries: sortEntries(list) });
  const patch = (id: string, p: Partial<MoneyEntry>) => setEntries(money.entries.map((e) => (e.id === id ? { ...e, ...p } : e)));

  const amount = draft.in ?? draft.out;
  const repeats = repeatDates(draft.date || today, draft.repeat, draft.until);
  const canAdd = !!draft.date && amount !== null && money.entries.length < MAX_ENTRIES;
  const add = () => {
    if (!canAdd) return;
    const kind = draft.in !== null ? 'in' : 'out';
    setEntries([
      ...money.entries,
      ...repeats.slice(0, MAX_ENTRIES - money.entries.length).map((date): MoneyEntry => ({ id: newId('e'), date, kind, amount: Math.abs(amount!), note: draft.note.trim(), category: draft.category, planned: date > today })),
    ]);
    setDraft({ ...blank(), date: draft.date });
  };

  const lastOfDay = new Set(entries.filter((e, i) => entries[i + 1]?.date !== e.date).map((e) => e.id));
  const todayAt = today.slice(0, 7) === month ? entries.findIndex((e) => e.date > today) : -2;

  return (
    <div className="money-body month-tab">
      <div className="month-bar">
        <div className="month-nav">
          <button className="icon-btn md" aria-label="Previous month" disabled={month <= addMonths(keys[0], -1)} onClick={() => onMonth(addMonths(month, -1))}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <h2 className="serif month-title">{monthName(month)}</h2>
          <button className="icon-btn md" aria-label="Next month" disabled={month >= addMonths(today.slice(0, 7), 24)} onClick={() => onMonth(addMonths(month, 1))}>
            <i className="ph-duotone ph-caret-right" />
          </button>
          {month !== today.slice(0, 7) && (
            <button className="btn btn-ghost btn-small" onClick={() => onMonth(today.slice(0, 7))}>
              This month
            </button>
          )}
          <div className="tabs layout-tabs" role="group" aria-label="Show as">
            {(['list', 'calendar'] as const).map((l) => (
              <button key={l} className={'tab' + (layout === l ? ' active' : '')} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                <i className={'ph-duotone ' + (l === 'list' ? 'ph-list-bullets' : 'ph-calendar-blank')} />
                {l === 'list' ? 'List' : 'Calendar'}
              </button>
            ))}
          </div>
        </div>
        <div className="month-sums">
          <span>
            Opening{' '}
            {isFirst ? (
              <NumCell value={money.opening} label="Opening balance" className="opening" onChange={(v) => onChange({ ...money, opening: v ?? 0, start: `${keys[0]}-01` })} />
            ) : (
              <Calc v={calc.opening} title="Last month’s closing balance" strong />
            )}
          </span>
          <span>
            In <Calc v={calc.totalIn} title={calc.plannedIn ? `${fmtMoney(calc.plannedIn)} of it still planned` : 'All of it done'} strong />
          </span>
          <span>
            Out <Calc v={calc.totalOut} title={calc.plannedOut ? `${fmtMoney(calc.plannedOut)} of it still planned` : 'All of it done'} strong />
          </span>
          <span>
            Closing <Calc v={calc.closing} title="The balance after the last day, counting everything planned" strong />
          </span>
          <span>
            Lowest <Calc v={calc.lowest} title="The lowest end-of-day balance this month" strong />
          </span>
        </div>
      </div>

      {review.length > 0 && (
        <div className="review-bar">
          <i className="ph-duotone ph-clock-countdown" />
          <span>
            {review.length} planned {review.length === 1 ? 'entry has' : 'entries have'} passed. Tick what happened, and change or delete the rest.
          </span>
          <button className="btn btn-secondary btn-small" onClick={() => setEntries(money.entries.map((e) => (review.includes(e) ? { ...e, planned: false } : e)))}>
            Mark all as done
          </button>
        </div>
      )}

      {layout === 'calendar' ? (
        <MonthCalendar month={month} entries={entries} calc={calc} today={today} onPick={addOn} />
      ) : (
        <section className="panel you-panel ledger" aria-label={`Entries for ${monthName(month)}`} data-grid>
          <div className="sum-scroll">
            <table className="sheet entries">
              <colgroup>
                <col style={{ width: 36 }} />
                <col style={{ width: 132 }} />
                <col />
                <col style={{ width: 112 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 108 }} />
                <col style={{ width: 34 }} />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="Done" />
                  <th>Date</th>
                  <th>Note</th>
                  <th>Category</th>
                  <th className="r">Out</th>
                  <th className="r">In</th>
                  <th className="r">Balance</th>
                  <th aria-label="Remove" />
                </tr>
                <tr
                  className="add-row"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                      e.preventDefault();
                      add();
                    }
                  }}
                >
                  <td className="c">
                    <i className="ph-duotone ph-plus add-plus" aria-hidden="true" />
                  </td>
                  <td>
                    <input type="date" className="cell date tnum" aria-label="New entry date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
                  </td>
                  <td>
                    <input className="cell" aria-label="New entry note" placeholder="Add money in or out…" maxLength={120} value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} />
                  </td>
                  <td>
                    <CategoryCell value={draft.category} label="New entry category" onChange={(category) => setDraft({ ...draft, category })} />
                  </td>
                  <td>
                    <NumCell value={draft.out} label="New entry money out" onChange={(v) => setDraft({ ...draft, out: v, in: v === null ? draft.in : null })} />
                  </td>
                  <td className="in">
                    <NumCell value={draft.in} label="New entry money in" onChange={(v) => setDraft({ ...draft, in: v, out: v === null ? draft.out : null })} />
                  </td>
                  <td colSpan={2} className="r">
                    <button className="btn btn-primary btn-small" disabled={!canAdd} onClick={add}>
                      {repeats.length > 1 ? `Add ${repeats.length}` : 'Add'}
                    </button>
                  </td>
                </tr>
                <tr className="add-opts">
                  <td />
                  <td colSpan={7}>
                    <div className="add-opts-in">
                      <select className="cell pick inline" aria-label="Repeat" value={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.value as Repeat })}>
                        {REPEATS.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                      {draft.repeat !== 'once' && (
                        <>
                          <span className="meta">until the end of</span>
                          <input className="cell inline tnum" type="month" aria-label="Repeat until" min={draft.date.slice(0, 7)} value={draft.until} onChange={(e) => e.target.value && setDraft({ ...draft, until: e.target.value })} />
                        </>
                      )}
                      <span className="meta">
                        {draft.date > today ? 'Goes in as planned: tick it once it’s happened' : 'Goes in as done'}
                      </span>
                    </div>
                  </td>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, r) => {
                  const late = e.planned && e.date < today;
                  return [
                    r === todayAt && <TodayRow key="today" money={money} today={today} />,
                    <tr key={e.id} className={(e.planned ? 'planned' : '') + (late ? ' late' : '') + (r > 0 && entries[r - 1].date !== e.date ? ' new-day' : r > 0 ? ' same-day' : '')}>
                      <td className="c">
                        <button
                          className={'check' + (e.planned ? '' : ' on')}
                          title={e.planned ? 'Planned. Tick it once it’s happened' : 'Done. Untick to make it planned again'}
                          aria-label={e.planned ? 'Mark as done' : 'Mark as planned'}
                          aria-pressed={!e.planned}
                          onClick={() => patch(e.id, { planned: !e.planned })}
                        >
                          {!e.planned && <i className="ph-bold ph-check" />}
                        </button>
                      </td>
                      <td>
                        <DateCell value={e.date} label="Date" r={r} c={0} onChange={(date) => patch(e.id, { date })} />
                      </td>
                      <td>
                        <TextCell value={e.note} label="Note" r={r} c={1} max={120} onChange={(note) => patch(e.id, { note })} />
                      </td>
                      <td>
                        <CategoryCell value={e.category} label="Category" onChange={(category) => patch(e.id, { category })} />
                      </td>
                      <td>
                        <NumCell
                          value={e.kind === 'out' && e.amount ? e.amount : null}
                          label="Money out"
                          r={r}
                          c={3}
                          onChange={(v) => (v === null ? e.kind === 'out' && patch(e.id, { amount: 0 }) : patch(e.id, { kind: 'out', amount: Math.abs(v) }))}
                        />
                      </td>
                      <td className={e.kind === 'in' ? 'in' : undefined}>
                        <NumCell
                          value={e.kind === 'in' && e.amount ? e.amount : null}
                          label="Money in"
                          r={r}
                          c={4}
                          onChange={(v) => (v === null ? e.kind === 'in' && patch(e.id, { amount: 0 }) : patch(e.id, { kind: 'in', amount: Math.abs(v) }))}
                        />
                      </td>
                      <td className="r">
                        {lastOfDay.has(e.id) && (
                          <Calc v={calc.balances[Number(e.date.slice(8)) - 1]} title={`End of ${shortDate(e.date)}: the opening balance plus everything in and out up to then, planned or done`} />
                        )}
                      </td>
                      <td className="c">
                        <button className="icon-btn row-x" title="Delete" aria-label={`Delete ${e.note || 'entry'}`} onClick={() => setEntries(money.entries.filter((x) => x.id !== e.id))}>
                          <i className="ph-duotone ph-x" />
                        </button>
                      </td>
                    </tr>,
                  ];
                })}
                {todayAt === -1 && <TodayRow money={money} today={today} />}
              </tbody>
            </table>
            {!entries.length && (
              <p className="month-empty">
                Nothing in {monthName(month)} yet. Plan what you expect to spend and earn, then tick, change or delete entries as the days go by.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/** The month as a calendar: each day's money in, money out and end-of-day balance. Click a day to add to it. */
function MonthCalendar({ month, entries, calc, today, onPick }: { month: string; entries: MoneyEntry[]; calc: MonthCalc; today: string; onPick: (date: string) => void }) {
  const lead = (parseYmd(`${month}-01`).getDay() + 6) % 7;
  const byDay = new Map<string, MoneyEntry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const lowest = calc.balances.indexOf(calc.lowest);

  return (
    <section className="panel you-panel cal" aria-label={`${monthName(month)} as a calendar`}>
      <div className="cal-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={'l' + i} />
        ))}
        {calc.balances.map((bal, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const list = byDay.get(date) ?? [];
          const sum = (kind: 'in' | 'out') => list.reduce((a, e) => (e.kind === kind ? a + e.amount : a), 0);
          const inn = sum('in');
          const out = sum('out');
          const late = list.some((e) => e.planned && e.date < today);
          const title = [
            `${shortDate(date)} · balance ${fmtMoney(bal)}${date > today ? ' (forecast)' : ''}`,
            ...list.map((e) => `${e.kind === 'in' ? '+' : '−'}${fmtMoney(e.amount)}${e.note ? ` ${e.note}` : ''}${e.planned ? ' (planned)' : ''}`),
            'Click to add to this day',
          ].join('\n');
          return (
            <button
              key={date}
              className={'cal-day' + (date === today ? ' today' : '') + (date < today ? ' past' : '') + (list.length && list.every((e) => e.planned) ? ' planned' : '') + (list.length ? ' has' : '')}
              title={title}
              onClick={() => onPick(date)}
            >
              <span className="cal-num tnum">
                {i + 1}
                {late && <span className="cal-late" aria-label="Has planned entries that have passed" />}
                {i === lowest && calc.lowest < calc.opening && <span className="cal-low">lowest</span>}
              </span>
              <span className="cal-amts tnum">
                {inn > 0 && <span className="cal-in">+{fmtMoney(inn)}</span>}
                {out > 0 && <span className="cal-out">−{fmtMoney(out)}</span>}
              </span>
              <span className={'cal-bal tnum' + (bal < 0 ? ' neg' : '')}>{fmtMoney(bal)}</span>
            </button>
          );
        })}
      </div>
      <div className="cal-foot meta">
        <span>
          <b className="cal-in">+In</b> · <b className="cal-out">−Out</b> · balance at the end of the day, counting what’s planned
        </span>
        <span>Days in italics are only planned so far · click a day to add to it</span>
      </div>
    </section>
  );
}

function TodayRow({ money, today }: { money: Money; today: string }) {
  const actual = balanceOn(money, today, true);
  const forecast = balanceOn(money, today);
  return (
    <tr className="today-row">
      <td colSpan={8}>
        Today · <b className={'tnum' + (actual < 0 ? ' neg' : '')}>{fmtMoney(actual)}</b> from what’s done
        {forecast !== actual && <span className="meta"> · the plan had {fmtMoney(forecast)} by today</span>}
      </td>
    </tr>
  );
}

// ---------- overview ----------

function Overview({ money, today, onOpenMonth }: { money: Money; today: string; onOpenMonth: (k: string) => void }) {
  const keys = monthKeys(money, today);
  const months = calcMonths(money, keys);
  const all = calcTotals(money, months);
  const thisMonth = months.find((m) => m.key === today.slice(0, 7)) ?? months[months.length - 1];
  const actual = balanceOn(money, today, true);
  const low = lowestAhead(months, today);
  const review = toReview(money, today);
  const cats = byCategory(money.entries.filter((e) => e.date.slice(0, 7) === thisMonth.key));
  const showCats = cats.some((c) => c.category !== 'Not set');

  return (
    <div className="money-body">
      <div className="m-stats">
        <div className="m-stat hero">
          <span className="meta">Balance today</span>
          <span className="serif tnum" style={actual < 0 ? { color: 'var(--wn)' } : undefined}>
            {fmtMoney(actual)}
          </span>
          <span className="meta">from what’s done</span>
        </div>
        <div className="m-stat">
          <span className="meta">End of {monthName(thisMonth.key, true)}</span>
          <span className="serif tnum" style={thisMonth.closing < 0 ? { color: 'var(--wn)' } : undefined}>
            {fmtMoney(thisMonth.closing)}
          </span>
          <span className="meta">forecast</span>
        </div>
        <div className="m-stat">
          <span className="meta">Lowest ahead</span>
          <span className="serif tnum" style={low && low.balance < 0 ? { color: 'var(--wn)' } : undefined}>
            {low ? fmtMoney(low.balance) : '—'}
          </span>
          <span className="meta">{low ? (low.date === today ? 'today' : `on ${shortDate(low.date)}`) : 'nothing ahead'}</span>
        </div>
        <button className={'m-stat' + (review.length ? ' warn' : '')} disabled={!review.length} onClick={() => onOpenMonth(review[0].date.slice(0, 7))}>
          <span className="meta">To check</span>
          <span className="serif tnum">{review.length}</span>
          <span className="meta">{review.length ? 'planned entries that have passed ›' : 'all caught up'}</span>
        </button>
      </div>

      <section className="panel you-panel" aria-label="Month by month">
        <div className="panel-head">
          <h2 className="panel-title">Month by month</h2>
          <span className="meta">Planned and done together · open a month to edit it</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet sum">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r">Opening</th>
                <th className="r">In</th>
                <th className="r">Out</th>
                <th className="r">Net</th>
                <th className="r">Closing</th>
                <th className="r">Lowest balance</th>
                <th className="r">Days below $0</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <SumRow
                  key={m.key}
                  c={m}
                  name={
                    <button className="month-link" onClick={() => onOpenMonth(m.key)}>
                      {monthName(m.key)}
                      {m.key === today.slice(0, 7) ? <span className="chip chip-accent">Now</span> : m.key > today ? <span className="chip chip-muted">Plan</span> : null}
                    </button>
                  }
                />
              ))}
            </tbody>
            <tfoot>
              <SumRow name="All months" c={all} />
            </tfoot>
          </table>
        </div>
      </section>

      <div className="you-row">
        <BalanceChart months={months} today={today} />
        <InOutChart months={months} />
        {showCats && <CategoryPanel cats={cats} month={thisMonth.key} />}
      </div>
    </div>
  );
}

function SumRow({ name, c }: { name: React.ReactNode; c: Omit<MonthCalc, 'key' | 'balances'> }) {
  return (
    <tr>
      <th>{name}</th>
      <td className="r">
        <Calc v={c.opening} title="Opening balance" />
      </td>
      <td className="r">
        <Calc v={c.totalIn} title={c.plannedIn ? `${fmtMoney(c.plannedIn)} of it still planned` : 'Money in'} />
      </td>
      <td className="r">
        <Calc v={c.totalOut} title={c.plannedOut ? `${fmtMoney(c.plannedOut)} of it still planned` : 'Money out'} />
      </td>
      <td className="r">
        <Calc v={c.net} sign title="Money in − money out" />
      </td>
      <td className="r">
        <Calc v={c.closing} title="Closing balance" strong />
      </td>
      <td className="r">
        <Calc v={c.lowest} title="The lowest end-of-day balance" />
      </td>
      <td className={'r tnum' + (c.daysBelow ? ' neg' : '')}>{c.daysBelow}</td>
    </tr>
  );
}

/** Axis labels: "$4k", "$1.5k", "−$500". */
function fmtAxis(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1000 ? `$${+(a / 1000).toFixed(1)}k` : `$${Math.round(a)}`;
  return v < 0 ? '−' + s : s;
}

/** Even steps that land on $0, so a dip below zero shows against a labelled zero line. */
function axis(lo: number, hi: number): { top: number; bottom: number; ticks: number[] } {
  const step = Math.max(50, lo < 0 ? niceMax((hi - lo) / 3) : niceMax(hi) / 2);
  const top = Math.max(step, Math.ceil(hi / step) * step);
  const bottom = Math.floor(lo / step) * step;
  return { top, bottom, ticks: Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, i) => top - i * step) };
}

function YAxis({ ticks }: { ticks: number[] }) {
  return (
    <>
      <div className="sc-grid">
        {ticks.map((t) => (
          <span key={t} />
        ))}
      </div>
      <div className="sc-y tnum">
        {ticks.map((t) => (
          <span key={t}>{fmtAxis(t)}</span>
        ))}
      </div>
    </>
  );
}

function MonthAxis({ months, weights }: { months: MonthCalc[]; weights: number[] }) {
  return (
    <div className="sc-x" style={{ gridTemplateColumns: weights.map((w) => `minmax(0, ${w}fr)`).join(' ') }}>
      {months.map((m) => (
        <span key={m.key} className="bal-label">
          {months.length > 3 ? monthName(m.key, true) : monthName(m.key).replace(/ \d+$/, '')}
        </span>
      ))}
    </div>
  );
}

/** The end-of-day balance across every month: solid up to today, dashed for the forecast. */
function BalanceChart({ months, today }: { months: MonthCalc[]; today: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const pts = months.flatMap((m) => m.balances.map((b, d) => ({ b, date: `${m.key}-${String(d + 1).padStart(2, '0')}` })));
  const n = pts.length;
  const { top, bottom, ticks } = axis(Math.min(0, ...pts.map((p) => p.b)), Math.max(0, ...pts.map((p) => p.b)));
  const y = (v: number) => ((top - v) / (top - bottom || 1)) * 100;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const pct = (i: number) => `${(x(i) / 1000) * 100}%`;
  const t = pts.findIndex((p) => p.date === today);
  const cut = t < 0 ? n - 1 : t;
  const line = (from: number, to: number) => pts.slice(from, to + 1).map((p, i) => `${x(from + i).toFixed(1)},${y(p.b).toFixed(2)}`).join(' ');
  const h = hover !== null ? pts[hover] : null;
  const starts = months.slice(0, -1).reduce<number[]>((a, m) => [...a, (a[a.length - 1] ?? 0) + m.balances.length], []);

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || !n) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  return (
    <section className="panel you-panel m-chart" aria-label="Balance by day">
      <div className="panel-head">
        <h2 className="panel-title">Balance by day</h2>
        <span className="legend">
          <span className="legend-line" />
          So far
          <span className="legend-dash" style={{ borderTopColor: 'var(--ac)', marginLeft: 8 }} />
          Forecast
        </span>
      </div>
      <div className="bal-chart">
        <YAxis ticks={ticks} />
        <div ref={plotRef} className="sc-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {starts.map((s) => (
            <span key={s} className="bal-month" style={{ left: `${(x(s - 0.5) / 1000) * 100}%` }} />
          ))}
          {bottom < 0 && <span className="bal-zero" style={{ top: `${y(0)}%` }} />}
          {t >= 0 && (
            <span className="bal-today" style={{ left: pct(t) }}>
              <span>Today</span>
            </span>
          )}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`Balance from ${fmtMoney(pts[0]?.b ?? 0)} to ${fmtMoney(pts[n - 1]?.b ?? 0)}`}>
            <polyline points={line(0, cut)} fill="none" stroke="var(--ac)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {cut < n - 1 && <polyline points={line(cut, n - 1)} fill="none" stroke="var(--ac)" strokeWidth="2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
          </svg>
          {h && (
            <>
              <span className="bal-cross" style={{ left: pct(hover!) }} />
              <span className="bal-dot" style={{ left: pct(hover!), top: `${y(h.b)}%`, background: h.b < 0 ? 'var(--wn)' : 'var(--ac)' }} />
              <div className="popover chart-tip" style={{ left: pct(hover!), transform: `translateX(${hover! > n / 2 ? 'calc(-100% - 12px)' : '12px'})` }}>
                <b className="tnum" style={h.b < 0 ? { color: 'var(--wn)' } : undefined}>
                  {fmtMoney(h.b)}
                </b>
                <span className="meta">
                  End of {shortDate(h.date)}
                  {h.date > today ? ' · forecast' : ''}
                </span>
              </div>
            </>
          )}
        </div>
        <MonthAxis months={months} weights={months.map((m) => m.balances.length)} />
      </div>
    </section>
  );
}

function InOutChart({ months }: { months: MonthCalc[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = axis(0, Math.max(0, ...months.flatMap((m) => [m.totalIn, m.totalOut])));
  const bar = (total: number, planned: number, color: string) => (
    <span className="io-bar" style={{ height: `${(total / top) * 100}%` }}>
      <span style={{ flex: planned, background: color, opacity: 0.4 }} />
      <span style={{ flex: total - planned, background: color }} />
    </span>
  );
  return (
    <section className="panel you-panel m-chart io" aria-label="Money in and out">
      <div className="panel-head">
        <h2 className="panel-title">In and out</h2>
        <span className="legend">
          <span className="legend-swatch" style={{ background: 'var(--ac)' }} />
          In
          <span className="legend-swatch" style={{ background: 'var(--t3)', marginLeft: 8 }} />
          Out
          <span className="legend-swatch" style={{ background: 'var(--t3)', opacity: 0.4, marginLeft: 8 }} />
          Planned
        </span>
      </div>
      <div className="bal-chart">
        <YAxis ticks={ticks} />
        <div className="sc-plot io-plot" onPointerLeave={() => setHover(null)}>
          {months.map((m, i) => (
            <div
              key={m.key}
              className={'io-col' + (hover === i ? ' on' : '')}
              onPointerEnter={() => setHover(i)}
              tabIndex={0}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${monthName(m.key)}: in ${fmtMoney(m.totalIn)}, out ${fmtMoney(m.totalOut)}`}
            >
              {bar(m.totalIn, m.plannedIn, 'var(--ac)')}
              {bar(m.totalOut, m.plannedOut, 'var(--t3)')}
              {hover === i && (
                <div className={'popover chart-tip' + (i >= months.length / 2 && months.length > 1 ? ' left' : '')}>
                  <span className="meta">{monthName(m.key)}</span>
                  <span className="tnum">
                    <span className="legend-line" /> In <b>{fmtMoney(m.totalIn)}</b>
                    {m.plannedIn > 0 && <span className="meta"> · {fmtMoney(m.plannedIn)} planned</span>}
                  </span>
                  <span className="tnum">
                    <span className="legend-line" style={{ background: 'var(--t3)' }} /> Out <b>{fmtMoney(m.totalOut)}</b>
                    {m.plannedOut > 0 && <span className="meta"> · {fmtMoney(m.plannedOut)} planned</span>}
                  </span>
                  <span className="tnum">
                    Net <b style={m.net < 0 ? { color: 'var(--wn)' } : undefined}>{fmtMoney(m.net, true)}</b>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <MonthAxis months={months} weights={months.map(() => 1)} />
      </div>
    </section>
  );
}

function CategoryPanel({ cats, month }: { cats: { category: string; amount: number }[]; month: string }) {
  const max = Math.max(...cats.map((c) => c.amount), 1);
  return (
    <section className="panel you-panel m-chart cats" aria-label={`Spending by category, ${monthName(month)}`}>
      <div className="panel-head">
        <h2 className="panel-title">Spending</h2>
        <span className="meta">{monthName(month)}</span>
      </div>
      <div className="cat-list">
        {cats.map((c) => (
          <div key={c.category} className="cat-row">
            <span className={c.category === 'Not set' ? 'meta' : undefined}>{c.category}</span>
            <span className="cat-track">
              <span style={{ width: `${(c.amount / max) * 100}%`, opacity: c.category === 'Not set' ? 0.45 : 1 }} />
            </span>
            <span className="tnum">{fmtMoney(c.amount)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- wishlist ----------

const blankWish = (id: string): WishItem => ({ id, name: '', category: '', priority: '', status: '', price: null, target: '', notes: '' });

function Wishlist({ money, today, onChange, onPurchased }: { money: Money; today: string; onChange: (l: WishItem[]) => void; onPurchased: (w: WishItem) => void }) {
  const list = money.wishlist;
  // The empty row at the end becomes a real item as soon as something is typed in it.
  // Its id is made up front, so the row keeps its key (and focus) when that happens.
  const [ghostId, setGhostId] = useState(() => newId('w'));
  const stats = wishStats(list);
  const rows = list.length < MAX_WISHES ? [...list, blankWish(ghostId)] : list;
  const months = calcMonths(money, monthKeys(money, today));
  const lastKey = months[months.length - 1].key;

  const set = (item: WishItem, patch: Partial<WishItem>) => {
    const next = { ...item, ...patch };
    if (item.id === ghostId) {
      onChange([...list, next]);
      setGhostId(newId('w'));
    } else onChange(list.map((w) => (w.id === item.id ? next : w)));
    if (patch.status === 'Purchased' && item.status !== 'Purchased') onPurchased(next);
  };

  return (
    <div className="money-body">
      <div className="m-stats">
        <div className="m-stat">
          <span className="meta">Items</span>
          <span className="serif tnum">{stats.items}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Total price</span>
          <span className="serif tnum">{fmtMoney(stats.total)}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Purchased</span>
          <span className="serif tnum">{fmtMoney(stats.purchased)}</span>
        </div>
        <div className="m-stat hero">
          <span className="meta">Still to buy</span>
          <span className="serif tnum">{fmtMoney(stats.stillToBuy)}</span>
        </div>
      </div>
      <section className="panel you-panel" aria-label="Wishlist" data-grid>
        <div className="panel-head">
          <h2 className="panel-title">Wishlist</h2>
          <span className="meta">Type in the last row to add one · “Fits from” is the first day your forecast stays above the price</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet wish">
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 112 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 96 }} />
              <col />
              <col style={{ width: 34 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="r">Price</th>
                <th>Want it by</th>
                <th>Fits from</th>
                <th>Notes</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w, r) => {
                const ghost = w.id === ghostId;
                const fits = !ghost && !isDone(w) && w.price ? affordableFrom(w.price, months, today) : undefined;
                const late = !!fits && !!w.target && fits.slice(0, 7) > w.target;
                return (
                  <tr key={w.id} className={(isDone(w) ? 'done' : '') + (ghost ? ' ghost' : '')}>
                    <td>
                      <TextCell value={w.name} label="Name" r={r} c={0} max={80} placeholder={ghost ? 'Add an item…' : undefined} className="wish-name" onChange={(v) => set(w, { name: v })} />
                    </td>
                    <td>
                      <TextCell value={w.category} label="Category" r={r} c={1} max={40} onChange={(v) => set(w, { category: v })} />
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.priority)} aria-label="Priority" value={w.priority} onChange={(e) => set(w, { priority: e.target.value as WishItem['priority'] })} onKeyDown={cellKeys}>
                        <option value="">–</option>
                        {PRIORITIES.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.status)} aria-label="Status" value={w.status} onChange={(e) => set(w, { status: e.target.value as WishItem['status'] })} onKeyDown={cellKeys}>
                        <option value="">–</option>
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <NumCell value={w.price} label="Price" r={r} c={4} onChange={(v) => set(w, { price: v })} />
                    </td>
                    <td>
                      <input className={'cell tnum' + (w.target ? '' : ' unset')} type="month" aria-label="Want it by" value={w.target} onChange={(e) => set(w, { target: e.target.value })} onKeyDown={cellKeys} />
                    </td>
                    <td className="fits">
                      {fits !== undefined && (
                        <span
                          className={fits === null || late ? 'neg' : fits === today ? 'ok' : undefined}
                          title={fits === null ? `The forecast doesn’t stay above ${fmtMoney(w.price!)} through ${monthName(lastKey)}` : late ? `That’s after ${monthName(w.target)}` : `From then on, the forecast stays above ${fmtMoney(w.price!)}`}
                        >
                          {fits === null ? `Not by ${monthName(lastKey, true)}` : fits === today ? 'Now' : shortDate(fits).replace(/^\w+ /, '')}
                        </span>
                      )}
                    </td>
                    <td>
                      <TextCell value={w.notes} label="Notes" r={r} c={7} max={200} onChange={(v) => set(w, { notes: v })} />
                    </td>
                    <td className="c">
                      {!ghost && (
                        <button className="icon-btn row-x" title={`Remove ${w.name || 'this item'}`} aria-label={`Remove ${w.name || 'this item'}`} onClick={() => onChange(list.filter((x) => x.id !== w.id))}>
                          <i className="ph-duotone ph-x" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Colour only where it means something: high priority and bought things in the accent, the rest neutral or muted. */
function pickTone(v: string): string {
  if (v === 'High' || v === 'Purchased') return 'tone-accent';
  if (v === 'Low' || v === 'Dropped') return 'tone-muted';
  return v ? 'tone-neutral' : '';
}
