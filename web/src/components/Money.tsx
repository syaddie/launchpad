import { useRef, useState } from 'react';
import {
  MAX_MONTHS, MAX_WISHES, PRIORITIES, STATUSES, blankMonth, calcMonths, calcTotals, fmtMoney, isDone, moneyFromWorkbook, parseMoney, wishStats, type MonthCalc,
} from '../../../shared/money';
import type { Money, MoneyDay, MoneyMonth, WishItem } from '../../../shared/types';
import { readXlsx } from '../../../shared/xlsx';
import { localGet, localSet } from '../api';
import { newId } from '../util';
import { niceMax } from './Server';

type Tab = 'summary' | 'tracker' | 'wishlist';
const TABS: { key: Tab; name: string }[] = [
  { key: 'summary', name: 'Summary' },
  { key: 'tracker', name: 'Tracker' },
  { key: 'wishlist', name: 'Wishlist' },
];

interface Props {
  money: Money;
  saved: boolean;
  onChange: (m: Money) => void;
  /** A workbook was read; the page swaps it in and offers an undo. */
  onImport: (m: Money, summary: string) => void;
}

/**
 * The Money view: the "Money tracker" workbook as a page. Its three sheets are tabs.
 * White cells are inputs; balances, totals and the summary are worked out (shared/money.ts).
 */
export function MoneyView({ money, saved, onChange, onImport }: Props) {
  const [tab, setTabState] = useState<Tab>(() => (TABS.some((t) => t.key === localGet('moneyTab')) ? (localGet('moneyTab') as Tab) : 'tracker'));
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const months = calcMonths(money);

  const setTab = (t: Tab) => {
    setTabState(t);
    localSet('moneyTab', t);
  };

  const importFile = async (f: File) => {
    setImportError('');
    try {
      const m = moneyFromWorkbook(await readXlsx(await f.arrayBuffer()));
      const filled = m.months.reduce((a, x) => a + x.days.filter((d) => d.in !== null || d.out !== null).length, 0);
      onImport(m, `Imported ${m.months.length} month${m.months.length === 1 ? '' : 's'} (${filled} days with money in or out) and ${m.wishlist.length} wishlist item${m.wishlist.length === 1 ? '' : 's'}`);
    } catch (e) {
      setImportError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };

  const addMonth = () => {
    const name = `Month ${money.months.length + 1}`;
    onChange({ ...money, months: [...money.months, blankMonth(newId('m'), name)] });
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
          {tab === 'tracker' && money.months.length < MAX_MONTHS && (
            <button className="btn btn-ghost btn-small" onClick={addMonth}>
              <i className="ph-duotone ph-plus" />
              Add month
            </button>
          )}
          <button className="btn btn-ghost btn-small" title="Read the Tracker and Wishlist sheets of an .xlsx file, replacing what’s here" onClick={() => fileRef.current?.click()}>
            <i className="ph-duotone ph-upload-simple" />
            Import .xlsx
          </button>
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
      {tab === 'summary' && <Summary money={money} months={months} />}
      {tab === 'tracker' && <Tracker money={money} months={months} onChange={onChange} />}
      {tab === 'wishlist' && <Wishlist list={money.wishlist} onChange={(wishlist) => onChange({ ...money, wishlist })} />}
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
  if (!step || el.tagName === 'SELECT') return;
  const grid = el.closest('[data-grid]');
  const next = grid?.querySelector<HTMLInputElement>(`[data-r="${Number(el.dataset.r) + step}"][data-c="${el.dataset.c}"]`);
  e.preventDefault();
  if (next) {
    next.focus();
    requestAnimationFrame(() => next.select());
  } else if (e.key === 'Enter') el.blur();
}

/** An amount: shows "$1,200" and edits as "1200". The page recalculates as you type. */
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
      title={value.length > 14 ? value : undefined}
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

/** A worked-out value: not editable, and negative balances in the warning colour. */
function Calc({ v, sign, title, strong }: { v: number; sign?: boolean; title: string; strong?: boolean }) {
  return (
    <span className={'calc tnum' + (v < 0 ? ' neg' : '') + (strong ? ' strong' : '')} title={title}>
      {fmtMoney(v, sign)}
    </span>
  );
}

// ---------- tracker ----------

function Tracker({ money, months, onChange }: { money: Money; months: MonthCalc[]; onChange: (m: Money) => void }) {
  const setMonth = (i: number, m: MoneyMonth) => onChange({ ...money, months: money.months.map((x, j) => (j === i ? m : x)) });
  const removeMonth = (i: number) => {
    const m = money.months[i];
    const used = m.days.some((d) => d.in !== null || d.out !== null || d.outNote || d.inNote);
    if (used && !confirm(`Remove ${m.name} and everything typed in it?`)) return;
    // Removing the first month keeps the balance it handed on, so later months don't jump.
    const opening = i === 0 && money.months.length > 1 ? months[0].closing : money.opening;
    onChange({ ...money, opening, months: money.months.filter((_, j) => j !== i) });
  };

  return (
    <div className="mt-row">
      {money.months.map((m, i) => (
        <MonthBlock
          key={m.id}
          month={m}
          calc={months[i]}
          prevName={i > 0 ? money.months[i - 1].name : ''}
          opening={i === 0 ? money.opening : null}
          onOpening={(v) => onChange({ ...money, opening: v ?? 0 })}
          onChange={(x) => setMonth(i, x)}
          onRemove={money.months.length > 1 ? () => removeMonth(i) : undefined}
        />
      ))}
    </div>
  );
}

const DAY_COLS: { key: keyof MoneyDay; name: string }[] = [
  { key: 'out', name: 'Out' },
  { key: 'in', name: 'In' },
  { key: 'outNote', name: 'Out note' },
  { key: 'inNote', name: 'In note' },
];

function MonthBlock({ month, calc, prevName, opening, onOpening, onChange, onRemove }: {
  month: MoneyMonth;
  calc: MonthCalc;
  prevName: string;
  /** The first month's typed opening balance; null for months that carry one over. */
  opening: number | null;
  onOpening: (v: number | null) => void;
  onChange: (m: MoneyMonth) => void;
  onRemove?: () => void;
}) {
  const setDay = (d: number, patch: Partial<MoneyDay>) => onChange({ ...month, days: month.days.map((x, j) => (j === d ? { ...x, ...patch } : x)) });

  return (
    <section className="panel mt-block" aria-label={month.name} data-grid>
      <div className="mt-head">
        <input className="mt-name serif" aria-label="Month name" value={month.name} maxLength={40} onChange={(e) => onChange({ ...month, name: e.target.value })} onKeyDown={cellKeys} />
        {onRemove && (
          <button className="icon-btn" title={`Remove ${month.name}`} aria-label={`Remove ${month.name}`} onClick={onRemove}>
            <i className="ph-duotone ph-trash" />
          </button>
        )}
      </div>
      <div className="mt-opening">
        {opening !== null ? (
          <>
            <span>Opening balance</span>
            <NumCell value={opening} label="Opening balance" className="opening" onChange={onOpening} />
          </>
        ) : (
          <>
            <span>
              Opening balance <span className="meta">carried from {prevName || 'the month before'}</span>
            </span>
            <Calc v={calc.opening} title={`${prevName}’s closing balance`} strong />
          </>
        )}
      </div>
      <div className="mt-scroll">
        <table className="sheet">
          <colgroup>
            <col style={{ width: 42 }} />
            <col style={{ width: '17%' }} />
            <col style={{ width: '17%' }} />
            <col />
            <col />
            <col style={{ width: '19%' }} />
          </colgroup>
          <thead>
            <tr>
              <th className="day-h">Day</th>
              <th className="r">Out</th>
              <th className="r">In</th>
              <th>Out note</th>
              <th>In note</th>
              <th className="r">Balance</th>
            </tr>
          </thead>
          <tbody>
            {month.days.map((d, i) => (
              <tr key={i} className={d.in !== null || d.out !== null ? 'has' : undefined}>
                <td className="day tnum">{i + 1}</td>
                {DAY_COLS.map((col, c) => (
                  <td key={col.key} className={col.key === 'in' && d.in !== null ? 'in' : undefined}>
                    {col.key === 'out' || col.key === 'in' ? (
                      <NumCell value={d[col.key]} label={`${month.name}, day ${i + 1}, ${col.name.toLowerCase()}`} r={i} c={c} onChange={(v) => setDay(i, { [col.key]: v })} />
                    ) : (
                      <TextCell value={d[col.key]} label={`${month.name}, day ${i + 1}, ${col.name.toLowerCase()}`} r={i} c={c} max={120} onChange={(v) => setDay(i, { [col.key]: v })} />
                    )}
                  </td>
                ))}
                <td className="r">
                  <Calc v={calc.balances[i]} title="Opening balance + money in − money out, up to this day" />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th className="day-h">Total</th>
              <td className="r">
                <Calc v={calc.totalOut} title="Money out this month" strong />
              </td>
              <td className="r">
                <Calc v={calc.totalIn} title="Money in this month" strong />
              </td>
              <td colSpan={2} className="r meta">
                Closing
              </td>
              <td className="r">
                <Calc v={calc.closing} title="The balance after day 31" strong />
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

// ---------- summary ----------

function Summary({ money, months }: { money: Money; months: MonthCalc[] }) {
  const all = calcTotals(money, months);
  return (
    <div className="money-body">
      <div className="m-stats">
        <Stat label="Closing balance" v={all.closing} hero />
        <Stat label="Net, all months" v={all.net} sign />
        <Stat label="Total in" v={all.totalIn} />
        <Stat label="Total out" v={all.totalOut} />
        <Stat label="Lowest balance" v={all.lowest} />
        <div className="m-stat">
          <span className="meta">Days below $0</span>
          <span className="serif tnum" style={all.daysBelow ? { color: 'var(--wn)' } : undefined}>
            {all.daysBelow}
          </span>
        </div>
      </div>

      <section className="panel you-panel" aria-label="Cash flow summary">
        <div className="panel-head">
          <h2 className="panel-title">Cash flow summary</h2>
          <span className="meta">Rolls up the tracker</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet sum">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r">Opening</th>
                <th className="r">Total in</th>
                <th className="r">Total out</th>
                <th className="r">Net</th>
                <th className="r">Closing</th>
                <th className="r">Lowest balance</th>
                <th className="r">Days below $0</th>
              </tr>
            </thead>
            <tbody>
              {money.months.map((m, i) => (
                <SumRow key={m.id} name={m.name} c={months[i]} />
              ))}
            </tbody>
            <tfoot>
              <SumRow name="All months" c={all} />
            </tfoot>
          </table>
        </div>
      </section>

      <div className="you-row">
        <BalanceChart money={money} months={months} />
        <InOutChart money={money} months={months} />
      </div>
    </div>
  );
}

function Stat({ label, v, sign, hero }: { label: string; v: number; sign?: boolean; hero?: boolean }) {
  return (
    <div className={'m-stat' + (hero ? ' hero' : '')}>
      <span className="meta">{label}</span>
      <span className="serif tnum" style={v < 0 ? { color: 'var(--wn)' } : undefined}>
        {fmtMoney(v, sign)}
      </span>
    </div>
  );
}

function SumRow({ name, c }: { name: string; c: Omit<MonthCalc, 'balances'> }) {
  return (
    <tr>
      <th>{name}</th>
      <td className="r">
        <Calc v={c.opening} title="Opening balance" />
      </td>
      <td className="r">
        <Calc v={c.totalIn} title="Money in" />
      </td>
      <td className="r">
        <Calc v={c.totalOut} title="Money out" />
      </td>
      <td className="r">
        <Calc v={c.net} sign title="Money in − money out" />
      </td>
      <td className="r">
        <Calc v={c.closing} title="Closing balance" strong />
      </td>
      <td className="r">
        <Calc v={c.lowest} title="The lowest daily balance" />
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

/** One line through every day of every month: each month opens where the last one closed. */
function BalanceChart({ money, months }: { money: Money; months: MonthCalc[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const pts = months.flatMap((m, mi) => m.balances.map((b, d) => ({ b, mi, d })));
  const n = pts.length;
  const lo = Math.min(0, ...pts.map((p) => p.b));
  const hi = Math.max(0, ...pts.map((p) => p.b));
  // Even steps that land on $0, so a dip below zero shows against a labelled zero line.
  const step = Math.max(50, lo < 0 ? niceMax((hi - lo) / 3) : niceMax(hi) / 2);
  const top = Math.max(step, Math.ceil(hi / step) * step);
  const bottom = Math.floor(lo / step) * step;
  const ticks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, i) => top - i * step);
  const y = (v: number) => ((top - v) / (top - bottom || 1)) * 100;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const line = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.b).toFixed(2)}`).join(' ');
  const h = hover !== null ? pts[hover] : null;
  const day = h ? money.months[h.mi].days[h.d] : null;

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || !n) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  return (
    <section className="panel you-panel m-chart" aria-label="Running balance by day">
      <div className="panel-head">
        <h2 className="panel-title">Running balance by day</h2>
        <span className="meta">{months.length} month{months.length === 1 ? '' : 's'}, back to back</span>
      </div>
      <div className="bal-chart">
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
        <div ref={plotRef} className="sc-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {months.slice(1).map((_, i) => (
            <span key={i} className="bal-month" style={{ left: `${(x((i + 1) * 31 - 0.5) / 1000) * 100}%` }} />
          ))}
          {bottom < 0 && <span className="bal-zero" style={{ top: `${y(0)}%` }} />}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`Balance from ${fmtMoney(months[0]?.opening ?? 0)} to ${fmtMoney(pts[n - 1]?.b ?? 0)}`}>
            <polyline points={line} fill="none" stroke="var(--ac)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          </svg>
          {h && (
            <>
              <span className="bal-cross" style={{ left: `${(x(hover!) / 1000) * 100}%` }} />
              <span className="bal-dot" style={{ left: `${(x(hover!) / 1000) * 100}%`, top: `${y(h.b)}%`, background: h.b < 0 ? 'var(--wn)' : 'var(--ac)' }} />
              <div className="popover chart-tip" style={{ left: `${(x(hover!) / 1000) * 100}%`, transform: `translateX(${hover! > n / 2 ? 'calc(-100% - 12px)' : '12px'})` }}>
                <b className="tnum" style={h.b < 0 ? { color: 'var(--wn)' } : undefined}>{fmtMoney(h.b)}</b>
                <span className="meta">
                  {money.months[h.mi].name} · day {h.d + 1}
                </span>
                {day && (day.in !== null || day.out !== null) && (
                  <span className="meta tnum">
                    {[day.in !== null && `In ${fmtMoney(day.in)}`, day.out !== null && `Out ${fmtMoney(day.out)}`].filter(Boolean).join(' · ')}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
        <div className="sc-x" style={{ gridTemplateColumns: `repeat(${Math.max(1, months.length)}, minmax(0, 1fr))` }}>
          {money.months.map((m) => (
            <span key={m.id} className="bal-label">
              {m.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function InOutChart({ money, months }: { money: Money; months: MonthCalc[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(0, ...months.flatMap((m) => [m.totalIn, m.totalOut])));
  return (
    <section className="panel you-panel m-chart io" aria-label="Money in vs out">
      <div className="panel-head">
        <h2 className="panel-title">Money in vs out</h2>
        <span className="legend">
          <span className="legend-swatch" style={{ background: 'var(--ac)' }} />
          In
          <span className="legend-swatch" style={{ background: 'var(--t3)', marginLeft: 8 }} />
          Out
        </span>
      </div>
      <div className="bal-chart">
        <div className="sc-grid">
          <span />
          <span />
          <span />
        </div>
        <div className="sc-y tnum">
          <span>{fmtAxis(top)}</span>
          <span>{fmtAxis(top / 2)}</span>
          <span>$0</span>
        </div>
        <div className="sc-plot io-plot" onPointerLeave={() => setHover(null)}>
          {months.map((m, i) => (
            <div key={money.months[i].id} className={'io-col' + (hover === i ? ' on' : '')} onPointerEnter={() => setHover(i)} tabIndex={0} onFocus={() => setHover(i)} onBlur={() => setHover(null)} aria-label={`${money.months[i].name}: in ${fmtMoney(m.totalIn)}, out ${fmtMoney(m.totalOut)}`}>
              <span className="io-bar" style={{ height: `${(m.totalIn / top) * 100}%`, background: 'var(--ac)' }} />
              <span className="io-bar" style={{ height: `${(m.totalOut / top) * 100}%`, background: 'var(--t3)' }} />
              {hover === i && (
                <div className={'popover chart-tip' + (i >= months.length / 2 && months.length > 1 ? ' left' : '')}>
                  <span className="meta">{money.months[i].name}</span>
                  <span className="tnum">
                    <span className="legend-line" /> In <b>{fmtMoney(m.totalIn)}</b>
                  </span>
                  <span className="tnum">
                    <span className="legend-line" style={{ background: 'var(--t3)' }} /> Out <b>{fmtMoney(m.totalOut)}</b>
                  </span>
                  <span className="tnum">
                    Net <b style={m.net < 0 ? { color: 'var(--wn)' } : undefined}>{fmtMoney(m.net, true)}</b>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="sc-x" style={{ gridTemplateColumns: `repeat(${Math.max(1, months.length)}, minmax(0, 1fr))` }}>
          {money.months.map((m) => (
            <span key={m.id} className="bal-label">
              {m.name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

// ---------- wishlist ----------

const blankWish = (id: string): WishItem => ({ id, name: '', category: '', priority: '', status: '', price: null, notes: '' });

function Wishlist({ list, onChange }: { list: WishItem[]; onChange: (l: WishItem[]) => void }) {
  // The empty row at the end becomes a real item as soon as something is typed in it.
  // Its id is made up front, so the row keeps its key (and focus) when that happens.
  const [ghostId, setGhostId] = useState(() => newId('w'));
  const stats = wishStats(list);
  const rows = list.length < MAX_WISHES ? [...list, blankWish(ghostId)] : list;

  const set = (item: WishItem, patch: Partial<WishItem>) => {
    const next = { ...item, ...patch };
    if (item.id === ghostId) {
      onChange([...list, next]);
      setGhostId(newId('w'));
    } else onChange(list.map((w) => (w.id === item.id ? next : w)));
  };

  return (
    <div className="money-body">
      <div className="m-stats">
        <div className="m-stat">
          <span className="meta">Items</span>
          <span className="serif tnum">{stats.items}</span>
        </div>
        <Stat label="Total price" v={stats.total} />
        <Stat label="Purchased" v={stats.purchased} />
        <Stat label="Still to buy" v={stats.stillToBuy} hero />
      </div>
      <section className="panel you-panel" aria-label="Wishlist" data-grid>
        <div className="panel-head">
          <h2 className="panel-title">Wishlist</h2>
          <span className="meta">Things to buy · type in the last row to add one</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet wish">
            <colgroup>
              <col style={{ width: '26%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 118 }} />
              <col style={{ width: 110 }} />
              <col />
              <col style={{ width: 42 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="r">Price</th>
                <th>Notes</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w, r) => {
                const ghost = w.id === ghostId;
                return (
                  <tr key={w.id} className={(isDone(w) ? 'done' : '') + (ghost ? ' ghost' : '')}>
                    <td>
                      <TextCell value={w.name} label="Name" r={r} c={0} max={80} placeholder={ghost ? 'Add an item…' : undefined} className="wish-name" onChange={(v) => set(w, { name: v })} />
                    </td>
                    <td>
                      <TextCell value={w.category} label="Category" r={r} c={1} max={40} onChange={(v) => set(w, { category: v })} />
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.priority)} aria-label="Priority" data-r={r} data-c={2} value={w.priority} onChange={(e) => set(w, { priority: e.target.value as WishItem['priority'] })} onKeyDown={cellKeys}>
                        <option value="">–</option>
                        {PRIORITIES.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.status)} aria-label="Status" data-r={r} data-c={3} value={w.status} onChange={(e) => set(w, { status: e.target.value as WishItem['status'] })} onKeyDown={cellKeys}>
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
                      <TextCell value={w.notes} label="Notes" r={r} c={5} max={200} onChange={(v) => set(w, { notes: v })} />
                    </td>
                    <td>
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

/** Colour only where it means something: high priority and bought things in the accent, dropped ones muted. */
function pickTone(v: string): string {
  if (v === 'High' || v === 'Purchased') return 'tone-accent';
  if (v === 'Low' || v === 'Dropped') return 'tone-muted';
  return v ? 'tone-neutral' : '';
}
