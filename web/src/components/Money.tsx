import { Fragment, useEffect, useRef, useState } from 'react';
import { ymd } from '../../../shared/dates';
import {
  ACCOUNT_KINDS, CATEGORIES, MAX_ACCOUNTS, MAX_ENTRIES, MAX_WISHES, PRIORITIES, STATUSES, accountBalance, addMonths, affordableFrom, balanceOn, byCategory,
  calcMonths, calcTotals, daysIn, effectOn, fmtMoney, goalPerMonth, isDone, lowestAhead, mainAccount, monthKeys, monthName, moneyFromWorkbook, newAccount,
  parseMoney, repeatDates, sortEntries, spendableKind, toReview, wishStats, type MonthCalc, type Repeat,
} from '../../../shared/money';
import type { Money, MoneyAccount, MoneyCategory, MoneyEntry, WishItem } from '../../../shared/types';
import { readXlsx } from '../../../shared/xlsx';
import { localGet, localSet } from '../api';
import { fmtDay, newId, parseYmd } from '../util';
import { Drawer } from './Drawers';
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
      const m = moneyFromWorkbook(await readXlsx(await f.arrayBuffer()), importMonth, today, money.accounts);
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
      {tab === 'overview' && <Overview money={money} today={today} onOpenMonth={openMonth} onChange={onChange} />}
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
                const entry: MoneyEntry = { id: newId('e'), date: today, kind: 'out', amount: w.price!, note: w.name, category: 'Shopping', planned: false, account: lastAccount(m), to: '' };
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
function DateCell({ value, onChange, label, r, c }: { value: string; onChange: (v: string) => void; label: string; r?: number; c?: number }) {
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

function CategoryCell({ value, onChange, label, className = '', empty = '–' }: {
  value: MoneyCategory | '';
  onChange: (v: MoneyCategory | '') => void;
  label: string;
  className?: string;
  /** What "no category" shows as. */
  empty?: string;
}) {
  return (
    <select className={'cell pick ' + className + (value ? ' tone-neutral' : '')} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as MoneyCategory | '')} onKeyDown={cellKeys}>
      <option value="">{empty}</option>
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

type Kind = MoneyEntry['kind'];
type Draft = { date: string; note: string; category: MoneyCategory | ''; kind: Kind; amount: number | null; account: string; to: string; repeat: Repeat; until: string };

const signed = (e: MoneyEntry) => (e.kind === 'in' ? e.amount : e.kind === 'out' ? -e.amount : 0);

/** Account names by id. */
const namesOf = (money: Money) => new Map(money.accounts.map((a) => [a.id, a.name]));

/** What an entry is called in a list: its note, or for a move where it went. */
const entryTitle = (e: MoneyEntry, names: Map<string, string>) => (e.kind === 'move' ? `${names.get(e.account) ?? '?'} → ${names.get(e.to) ?? '?'}` : e.note || 'No note');

/** The account the last entry went into, if it's still in use. */
function lastAccount(money: Money): string {
  const id = localGet('moneyAccount');
  return money.accounts.some((a) => a.id === id && !a.archived) ? id! : mainAccount(money.accounts);
}

/** Another account in use, for the other end of a move. */
const otherAccount = (money: Money, id: string) => (money.accounts.find((a) => a.id !== id && !a.archived) ?? money.accounts.find((a) => a.id !== id))?.id ?? '';

function MonthTab({ money, today, month, onMonth, onChange }: { money: Money; today: string; month: string; onMonth: (k: string) => void; onChange: (m: Money) => void }) {
  // Include the month on screen, even one before the first or past the last.
  const keys = monthKeys({ ...money, start: `${month}-01` < money.start ? `${month}-01` : money.start }, month > today.slice(0, 7) ? `${month}-01` : today);
  const months = calcMonths(money, keys);
  const calc = months[keys.indexOf(month)] ?? months[0];
  const names = namesOf(money);
  const isNow = today.slice(0, 7) === month;
  const blank = (): Draft => {
    const account = lastAccount(money);
    return { date: isNow ? today : `${month}-01`, note: '', category: '', kind: 'out', amount: null, account, to: otherAccount(money, account), repeat: 'once', until: month };
  };
  const [draft, setDraft] = useState<Draft>(blank);
  const [draftMonth, setDraftMonth] = useState(month);
  if (draftMonth !== month) {
    setDraftMonth(month);
    setDraft(blank());
  }
  /** The entry open for changing, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Only the entries of one account, or all of them. */
  const [only, setOnlyState] = useState(() => localGet('moneyOnly') ?? '');
  const setOnly = (id: string) => {
    setOnlyState(id);
    localSet('moneyOnly', id);
  };
  const shown = money.accounts.find((a) => a.id === only);
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

  const inMonth = money.entries.filter((e) => e.date.slice(0, 7) === month);
  const entries = shown ? inMonth.filter((e) => e.account === shown.id || e.to === shown.id) : inMonth;
  const review = toReview(money, today).filter((e) => e.date.slice(0, 7) === month);
  // Accounts to filter by: those in use, and any old one this month's entries still mention.
  const filters = money.accounts.filter((a) => !a.archived || a.id === only || inMonth.some((e) => e.account === a.id || e.to === a.id));

  const setEntries = (list: MoneyEntry[]) => onChange({ ...money, entries: sortEntries(list) });
  const patch = (id: string, p: Partial<MoneyEntry>) => setEntries(money.entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  const remove = (id: string) => setEntries(money.entries.filter((x) => x.id !== id));

  const repeats = repeatDates(draft.date || today, draft.repeat, draft.until);
  const move = draft.kind === 'move';
  const canAdd = !!draft.date && draft.amount !== null && money.entries.length < MAX_ENTRIES && (!move || (!!draft.to && draft.to !== draft.account));
  const add = () => {
    if (!canAdd) return;
    setEntries([
      ...money.entries,
      ...repeats.slice(0, MAX_ENTRIES - money.entries.length).map((date): MoneyEntry => ({
        id: newId('e'),
        date,
        kind: draft.kind,
        amount: Math.abs(draft.amount!),
        note: draft.note.trim(),
        category: move ? '' : draft.category,
        planned: date > today,
        account: draft.account,
        to: move ? draft.to : '',
      })),
    ]);
    localSet('moneyAccount', draft.account);
    setDraft({ ...blank(), date: draft.date, kind: draft.kind, account: draft.account, to: draft.to });
  };

  // The entries a day at a time, each day ending on its balance.
  const days: { date: string; list: MoneyEntry[] }[] = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last?.date === e.date) last.list.push(e);
    else days.push({ date: e.date, list: [e] });
  }
  const todayAt = isNow ? days.findIndex((d) => d.date > today) : -2;
  const lowIndex = calc.balances.indexOf(calc.lowest);
  const lowDate = `${month}-${String(lowIndex + 1).padStart(2, '0')}`;
  const balanceAt = (date: string) => (shown ? accountBalance(money, shown.id, date) : calc.balances[Number(date.slice(8)) - 1]);
  const pickAccount = (account: string) => setDraft({ ...draft, account, to: draft.to === account ? otherAccount(money, account) : draft.to });

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
          {!isNow && (
            <button className="btn btn-ghost btn-small" onClick={() => onMonth(today.slice(0, 7))}>
              This month
            </button>
          )}
        </div>
        <div className="tabs layout-tabs" role="group" aria-label="Show as">
          {(['list', 'calendar'] as const).map((l) => (
            <button key={l} className={'tab' + (layout === l ? ' active' : '')} aria-pressed={layout === l} onClick={() => setLayout(l)}>
              <i className={'ph-duotone ' + (l === 'list' ? 'ph-list-bullets' : 'ph-calendar-blank')} />
              {l === 'list' ? 'List' : 'Calendar'}
            </button>
          ))}
        </div>
      </div>

      <section className="month-sum" aria-label={`${monthName(month)} in numbers`}>
        <div className="m-stats">
          {isNow ? (
            <MonthStat label="In the bank now" value={balanceOn(money, today, true)} note="day-to-day accounts, from what’s done" hero />
          ) : (
            <MonthStat label="Started with" value={calc.opening} note={month <= keys[0] ? 'what your day-to-day accounts opened with' : 'last month’s closing balance'} hero />
          )}
          <MonthStat label={`End of ${monthName(month, true)}`} value={calc.closing} note={calc.plannedIn || calc.plannedOut ? 'if the plan holds' : 'all of it done'} />
          <MonthStat label="Money in" value={calc.totalIn} sign tone="in" note={calc.plannedIn ? `${fmtMoney(calc.plannedIn)} still to come` : 'all of it done'} />
          <MonthStat label="Money out" value={-calc.totalOut} sign note={calc.plannedOut ? `${fmtMoney(calc.plannedOut)} still to come` : 'all of it done'} />
        </div>
        <p className="month-foot">
          {isNow && (
            <span>
              Started the month with <Calc v={calc.opening} title="What your day-to-day accounts had at the start of the month" strong />
            </span>
          )}
          {calc.lowest < calc.opening && (
            <span>
              <i className="ph-duotone ph-trend-down" aria-hidden="true" />
              Lowest point <Calc v={calc.lowest} title="The lowest end-of-day balance this month" strong /> on {shortDate(lowDate)}
            </span>
          )}
        </p>
      </section>

      {review.length > 0 && (
        <div className="review-bar">
          <div className="review-head">
            <i className="ph-duotone ph-clock-countdown" />
            <b>Did {review.length === 1 ? 'this' : 'these'} happen?</b>
            <span>Planned for a day that’s passed.</span>
            {review.length > 1 && (
              <button className="btn btn-secondary btn-small" onClick={() => setEntries(money.entries.map((e) => (review.includes(e) ? { ...e, planned: false } : e)))}>
                Mark all {review.length} as done
              </button>
            )}
          </div>
          {review.slice(0, 5).map((e) => (
            <div key={e.id} className="review-item">
              <span className="review-what">
                {entryTitle(e, names)} <span className="meta">· {shortDate(e.date)}</span>
              </span>
              <b className="tnum">{fmtMoney(e.kind === 'move' ? e.amount : signed(e), e.kind !== 'move')}</b>
              <button className="btn btn-small review-yes" onClick={() => patch(e.id, { planned: false })}>
                Yes, it’s done
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => (setLayout('list'), setOnly(''), setEditing(e.id))}>
                Change it
              </button>
            </div>
          ))}
          {review.length > 5 && <span className="review-more">and {review.length - 5} more, marked Overdue in the list</span>}
        </div>
      )}

      {layout === 'calendar' ? (
        <MonthCalendar month={month} money={money} entries={inMonth} calc={calc} today={today} onPick={addOn} />
      ) : (
        <>
          <div
            className="composer"
            role="group"
            aria-label="Add an entry"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                e.preventDefault();
                add();
              }
            }}
          >
            <div className="composer-main">
              <KindSwitch kind={draft.kind} label="New entry is" onChange={(kind) => setDraft({ ...draft, kind })} />
              <input
                className="composer-note"
                aria-label="New entry note"
                placeholder={move ? 'What’s it for? (optional)' : 'What’s it for?'}
                maxLength={120}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
              <NumCell value={draft.amount} label="New entry amount" className="composer-amt" onChange={(v) => setDraft({ ...draft, amount: v === null ? null : Math.abs(v) })} />
              <button className="btn btn-primary composer-add" disabled={!canAdd} onClick={add}>
                {repeats.length > 1 ? `Add ${repeats.length}` : 'Add'}
              </button>
            </div>
            <div className="composer-acct">
              {move ? (
                <>
                  <span className="meta">From</span>
                  <AccountSelect money={money} value={draft.account} label="Move from" className="composer-field" onChange={pickAccount} />
                  <span className="meta">to</span>
                  <AccountSelect money={money} value={draft.to} label="Move to" className="composer-field" onChange={(to) => setDraft({ ...draft, to })} />
                </>
              ) : (
                <>
                  <span className="meta">{draft.kind === 'in' ? 'Paid into' : 'Paid from'}</span>
                  <div className="acct-chips" role="radiogroup" aria-label={draft.kind === 'in' ? 'Paid into' : 'Paid from'}>
                    {money.accounts
                      .filter((a) => !a.archived || a.id === draft.account)
                      .map((a) => (
                        <button key={a.id} type="button" role="radio" aria-checked={draft.account === a.id} className={'acct-chip' + (draft.account === a.id ? ' on' : '')} onClick={() => pickAccount(a.id)}>
                          {a.name}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
            <div className="composer-opts">
              <input type="date" className="cell composer-field tnum" aria-label="New entry date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              {!move && <CategoryCell value={draft.category} label="New entry category" className="composer-field" empty="Category" onChange={(category) => setDraft({ ...draft, category })} />}
              <select className="cell pick composer-field" aria-label="Repeat" value={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.value as Repeat })}>
                {REPEATS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              {draft.repeat !== 'once' && (
                <>
                  <span className="meta">until the end of</span>
                  <input className="cell composer-field tnum" type="month" aria-label="Repeat until" min={draft.date.slice(0, 7)} value={draft.until} onChange={(e) => e.target.value && setDraft({ ...draft, until: e.target.value })} />
                </>
              )}
              <span className="meta composer-hint">{draft.date > today ? 'Goes in as planned: tick it once it’s happened' : 'Goes in as done'}</span>
            </div>
          </div>

          {money.accounts.length > 1 && (
            <div className="acct-filter" role="group" aria-label="Show entries for">
              <span className="meta">Show</span>
              <button className={'acct-chip' + (!shown ? ' on' : '')} aria-pressed={!shown} onClick={() => setOnly('')}>
                All accounts
              </button>
              {filters.map((a) => (
                <button key={a.id} className={'acct-chip' + (shown?.id === a.id ? ' on' : '')} aria-pressed={shown?.id === a.id} onClick={() => setOnly(a.id)}>
                  {a.name}
                </button>
              ))}
            </div>
          )}

          <section className="panel days" aria-label={`Entries for ${monthName(month)}`}>
            {days.length > 0 && (
              <div className="days-key meta">
                <span>
                  <span className="ent-tick on" aria-hidden="true" />
                  Done
                </span>
                <span>
                  <span className="ent-tick" aria-hidden="true" />
                  Planned
                </span>
                <span>{shown ? `Each day ends on what’s in ${shown.name}` : 'Each day ends on your day-to-day balance, planned and done together'}</span>
              </div>
            )}
            {days.map((d, i) => (
              <Fragment key={d.date}>
                {i === todayAt && <TodayLine money={money} today={today} account={shown} />}
                <div className="day">
                  <div className="day-head">
                    <h3>{shortDate(d.date)}</h3>
                    <span className="day-bal">
                      {!shown && d.date === lowDate && calc.lowest < calc.opening && <span className="chip chip-warn">Lowest</span>}
                      <Calc v={balanceAt(d.date)} title={`End of ${shortDate(d.date)}: ${shown ? `what’s in ${shown.name}` : 'your day-to-day accounts'}, counting everything up to then, planned or done`} />
                    </span>
                  </div>
                  {d.list.map((e) => (
                    <EntryRow
                      key={e.id}
                      e={e}
                      money={money}
                      today={today}
                      open={editing === e.id}
                      onOpen={() => setEditing(e.id)}
                      onClose={() => setEditing(null)}
                      onPatch={(p) => patch(e.id, p)}
                      onDelete={() => remove(e.id)}
                    />
                  ))}
                </div>
              </Fragment>
            ))}
            {todayAt === -1 && <TodayLine money={money} today={today} account={shown} />}
            {!entries.length && (
              <p className="month-empty">
                {shown
                  ? `Nothing in or out of ${shown.name} in ${monthName(month)}.`
                  : `Nothing in ${monthName(month)} yet. Plan what you expect to spend and earn, then tick, change or delete entries as the days go by.`}
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function MonthStat({ label, value, note, sign, tone, hero }: { label: string; value: number; note: string; sign?: boolean; tone?: 'in'; hero?: boolean }) {
  return (
    <div className={'m-stat' + (hero ? ' hero' : '')}>
      <span className="meta">{label}</span>
      <span className={'serif tnum' + (tone === 'in' ? ' m-in' : '')} style={value < 0 && !sign ? { color: 'var(--wn)' } : undefined}>
        {fmtMoney(value, sign)}
      </span>
      <span className="meta">{note}</span>
    </div>
  );
}

function KindSwitch({ kind, label, onChange }: { kind: Kind; label: string; onChange: (k: Kind) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {(['out', 'in', 'move'] as const).map((k) => (
        <button key={k} type="button" className={kind === k ? 'on' : undefined} aria-pressed={kind === k} title={k === 'move' ? 'Move money from one account to another' : undefined} onClick={() => onChange(k)}>
          {k === 'out' ? 'Out' : k === 'in' ? 'In' : 'Move'}
        </button>
      ))}
    </div>
  );
}

/** Picks one of the accounts in use (or the one already picked, if it's archived). `bare` drops the cell look, for forms. */
function AccountSelect({ money, value, label, id, bare, className = '', onChange }: {
  money: Money;
  value: string;
  label: string;
  id?: string;
  bare?: boolean;
  className?: string;
  onChange: (id: string) => void;
}) {
  return (
    <select id={id} className={(bare ? '' : 'cell pick tone-neutral ') + className} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={bare ? undefined : cellKeys}>
      {money.accounts
        .filter((a) => !a.archived || a.id === value)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
    </select>
  );
}

/** One entry: a tick, what it was, its account and the amount. Click it to change it. */
function EntryRow({ e, money, today, open, onOpen, onClose, onPatch, onDelete }: {
  e: MoneyEntry;
  money: Money;
  today: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPatch: (p: Partial<MoneyEntry>) => void;
  onDelete: () => void;
}) {
  const late = e.planned && e.date < today;
  const names = namesOf(money);
  const title = entryTitle(e, names);
  const tick = (
    <button
      className="ent-check"
      title={e.planned ? 'Planned. Tick it once it’s happened' : 'Done. Untick to make it planned again'}
      aria-label={e.planned ? `Mark ${title} as done` : `Mark ${title} as planned`}
      aria-pressed={!e.planned}
      onClick={() => onPatch({ planned: !e.planned })}
    >
      <span className={'ent-tick' + (e.planned ? '' : ' on') + (late ? ' late' : '')}>{!e.planned && <i className="ph-bold ph-check" />}</span>
    </button>
  );
  const del = (
    <button className="icon-btn ent-x" title="Delete" aria-label={`Delete ${title}`} onClick={onDelete}>
      <i className="ph-duotone ph-x" />
    </button>
  );

  if (open) {
    const setKind = (kind: Kind) => onPatch(kind === 'move' ? { kind, category: '', to: e.to && e.to !== e.account ? e.to : otherAccount(money, e.account) } : { kind, to: '' });
    return (
      <div
        className="ent editing"
        onKeyDown={(k) => {
          if (k.key === 'Escape' || (k.key === 'Enter' && (k.target as HTMLElement).tagName !== 'BUTTON')) {
            k.preventDefault();
            onClose();
          }
        }}
      >
        {tick}
        <div className="ent-form">
          <TextCell value={e.note} label="Note" max={120} placeholder="Note" className="ent-field ent-field-note" onChange={(note) => onPatch({ note })} />
          <DateCell value={e.date} label="Date" onChange={(date) => onPatch({ date })} />
          <KindSwitch kind={e.kind} label="Entry is" onChange={setKind} />
          <NumCell value={e.amount} label="Amount" className="ent-field ent-field-amt" onChange={(v) => onPatch({ amount: Math.abs(v ?? 0) })} />
          <AccountSelect
            money={money}
            value={e.account}
            label={e.kind === 'move' ? 'From' : e.kind === 'in' ? 'Into' : 'From'}
            onChange={(account) => onPatch(account === e.to ? { account, to: e.account } : { account })}
          />
          {e.kind === 'move' ? (
            <>
              <span className="meta">to</span>
              <AccountSelect money={money} value={e.to} label="To" onChange={(to) => onPatch(to === e.account ? { to, account: e.to } : { to })} />
            </>
          ) : (
            <CategoryCell value={e.category} label="Category" className="ent-field" empty="Category" onChange={(category) => onPatch({ category })} />
          )}
          <button className="btn btn-primary btn-small" onClick={onClose}>
            Done
          </button>
          {del}
        </div>
      </div>
    );
  }

  return (
    <div className={'ent' + (e.planned ? ' planned' : '') + (late ? ' late' : '') + (e.kind === 'move' ? ' move' : '')}>
      {tick}
      <button className="ent-main" title="Change this entry" onClick={onOpen}>
        <span className="ent-note">
          {e.kind === 'move' && <i className="ph-bold ph-arrows-left-right ent-move" aria-hidden="true" />}
          {e.kind !== 'move' && !e.note ? <span className="ent-none">No note</span> : title}
        </span>
        <span className="ent-meta">
          {e.kind === 'move' ? e.note || 'Moved between accounts' : e.category || 'No category'}
          {e.kind !== 'move' && money.accounts.length > 1 && <span className="ent-acct">{names.get(e.account)}</span>}
          {late && <span className="chip chip-warn">Overdue</span>}
        </span>
      </button>
      <span className="ent-acts">
        <button className="icon-btn ent-x" title="Change" aria-label={`Change ${title}`} onClick={onOpen}>
          <i className="ph-duotone ph-pencil-simple" />
        </button>
        {del}
      </span>
      <span className={'ent-amt tnum' + (e.kind === 'in' ? ' in' : '')}>{e.kind === 'move' ? fmtMoney(e.amount) : fmtMoney(signed(e), true)}</span>
    </div>
  );
}

/**
 * The month as a calendar: each day's money in, money out and end-of-day balance, for the
 * day-to-day accounts (a move to or from set-aside money counts as out or in). Click a day to add to it.
 */
function MonthCalendar({ month, money, entries, calc, today, onPick }: { month: string; money: Money; entries: MoneyEntry[]; calc: MonthCalc; today: string; onPick: (date: string) => void }) {
  const lead = (parseYmd(`${month}-01`).getDay() + 6) % 7;
  const byDay = new Map<string, MoneyEntry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const lowest = calc.balances.indexOf(calc.lowest);
  const names = namesOf(money);
  const spendable = money.accounts.filter((a) => a.spendable).map((a) => a.id);
  const effect = (e: MoneyEntry) => spendable.reduce((a, id) => a + effectOn(e, id), 0);

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
          const inn = list.reduce((a, e) => a + Math.max(0, effect(e)), 0);
          const out = list.reduce((a, e) => a - Math.min(0, effect(e)), 0);
          const late = list.some((e) => e.planned && e.date < today);
          const title = [
            `${shortDate(date)} · balance ${fmtMoney(bal)}${date > today ? ' (forecast)' : ''}`,
            ...list.map((e) => `${e.kind === 'move' ? `${fmtMoney(e.amount)} ${entryTitle(e, names)}` : `${fmtMoney(signed(e), true)}${e.note ? ` ${e.note}` : ''}`}${e.planned ? ' (planned)' : ''}`),
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
          <b className="cal-in">+In</b> · <b className="cal-out">−Out</b> · your day-to-day balance at the end of the day, counting what’s planned
        </span>
        <span>Days in italics are only planned so far · click a day to add to it</span>
      </div>
    </section>
  );
}

function TodayLine({ money, today, account }: { money: Money; today: string; account?: MoneyAccount }) {
  const actual = account ? accountBalance(money, account.id, today, true) : balanceOn(money, today, true);
  const forecast = account ? accountBalance(money, account.id, today) : balanceOn(money, today);
  return (
    <div className="today-line">
      <b>Today · {shortDate(today)}</b>
      <span>
        <b className={'tnum' + (actual < 0 ? ' neg' : '')}>{fmtMoney(actual)}</b> {account ? `in ${account.name}` : 'in the bank'} from what’s done
        {forecast !== actual && <span className="meta"> · the plan had {fmtMoney(forecast)} by today</span>}
      </span>
    </div>
  );
}

// ---------- overview ----------

function Overview({ money, today, onOpenMonth, onChange }: { money: Money; today: string; onOpenMonth: (k: string) => void; onChange: (m: Money) => void }) {
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
          <span className="meta">day-to-day accounts, from what’s done</span>
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

      <AccountsPanel money={money} today={today} onChange={onChange} />

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

// ---------- accounts ----------

/** Colours for each account's share of the total, in account order. */
const SHARE = ['var(--acd)', '#c9a77a', 'var(--ac)', '#6f8fae', '#a7869e', '#b9b2a8'];

type AccountRow = { a: MoneyAccount; now: number; end: number; change: number; color: string };

const lastDay = (key: string) => `${key}-${String(daysIn(key)).padStart(2, '0')}`;
const monthYear = (key: string) => `${monthName(key, true)} ${key.slice(0, 4)}`;
const isZero = (n: number) => Math.abs(n) < 0.005;

/** Where the money is today: each account, the total and how it splits, and the latest moves between them. */
function AccountsPanel({ money, today, onChange }: { money: Money; today: string; onChange: (m: Money) => void }) {
  const [open, setOpen] = useState<{ kind: 'account'; id: string | null } | { kind: 'move' } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const month = today.slice(0, 7);
  const prevEnd = lastDay(addMonths(month, -1));
  const names = namesOf(money);

  // Esc closes the drawer. Caught first, so the page's own Esc (back to Home) doesn't also run.
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(null);
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  const rows: AccountRow[] = money.accounts.map((a, i) => {
    const now = accountBalance(money, a.id, today, true);
    return { a, now, end: accountBalance(money, a.id, lastDay(month)), change: now - accountBalance(money, a.id, prevEnd, true), color: SHARE[i % SHARE.length] };
  });
  const archived = rows.filter((r) => r.a.archived);
  const sum = (list: AccountRow[]) => list.reduce((s, r) => s + r.now, 0);
  const groups = [
    { name: 'Day to day', amount: sum(rows.filter((r) => r.a.spendable)) },
    { name: 'Set aside', amount: sum(rows.filter((r) => !r.a.spendable && r.a.kind !== 'invest')) },
    { name: 'Invested', amount: sum(rows.filter((r) => !r.a.spendable && r.a.kind === 'invest')) },
  ].filter((g) => !isZero(g.amount));
  const share = rows.filter((r) => r.now > 0);
  const positive = sum(share);
  const pct = (r: AccountRow) => Math.round((r.now / positive) * 100);
  const moves = money.entries.filter((e) => e.kind === 'move' && e.date <= today).slice(-4).reverse();

  return (
    <section className="panel you-panel accts" aria-label="Accounts">
      <div className="panel-head accts-head">
        <div>
          <h2 className="panel-title">Accounts</h2>
          <span className="meta">Where your money is today, from what’s done · click one to change it</span>
        </div>
        {money.accounts.length > 1 && (
          <button className="btn btn-primary btn-small" onClick={() => setOpen({ kind: 'move' })}>
            <i className="ph-bold ph-arrows-left-right" />
            Move money
          </button>
        )}
      </div>

      <div className="acct-grid">
        {rows
          .filter((r) => showArchived || !r.a.archived)
          .map((r) => (
            <AccountCard key={r.a.id} row={r} today={today} onOpen={() => setOpen({ kind: 'account', id: r.a.id })} />
          ))}
        {money.accounts.length < MAX_ACCOUNTS && (
          <button className="acct-card acct-add" onClick={() => setOpen({ kind: 'account', id: null })}>
            <span className="acct-icon">
              <i className="ph-bold ph-plus" aria-hidden="true" />
            </span>
            <b>Add account</b>
            <span className="meta">A bank, cash, investments, or a pot for something you’re saving for</span>
          </button>
        )}
      </div>

      <div className="acct-total">
        <div className="acct-total-head">
          <span>
            Total <span className={'serif tnum acct-total-v' + (sum(rows) < 0 ? ' neg' : '')}>{fmtMoney(sum(rows))}</span>
          </span>
          {groups.length > 1 && (
            <span className="acct-groups">
              {groups.map((g) => (
                <span key={g.name}>
                  {g.name} <b className="tnum">{fmtMoney(g.amount)}</b>
                </span>
              ))}
            </span>
          )}
        </div>
        {share.length > 1 && (
          <>
            <div className="acct-share" role="img" aria-label={`Share of the total: ${share.map((r) => `${r.a.name} ${pct(r)}%`).join(', ')}`}>
              {share.map((r) => (
                <span key={r.a.id} style={{ flexGrow: r.now, background: r.color }} />
              ))}
            </div>
            <div className="acct-legend">
              {share.map((r) => (
                <span key={r.a.id}>
                  <span className="acct-swatch" style={{ background: r.color }} />
                  {r.a.name} {pct(r)}%
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {moves.length > 0 && (
        <div className="acct-moves">
          <h3 className="drawer-label">Latest moves</h3>
          {moves.map((e) => (
            <div key={e.id} className="acct-move">
              <span className="meta tnum">{shortDate(e.date)}</span>
              <span className="acct-move-what">
                {entryTitle(e, names)}
                {e.note && <span className="meta"> · {e.note}</span>}
                {e.planned && <span className="chip chip-muted">Planned</span>}
              </span>
              <span className="tnum">{fmtMoney(e.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <button className="btn-link meta acct-archived" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived accounts' : `Show ${archived.length} archived account${archived.length === 1 ? '' : 's'}`}
        </button>
      )}

      {open?.kind === 'account' && <AccountDrawer money={money} today={today} id={open.id} onChange={onChange} onClose={() => setOpen(null)} />}
      {open?.kind === 'move' && <MoveDrawer money={money} today={today} onChange={onChange} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AccountCard({ row: { a, now, end, change }, today, onOpen }: { row: AccountRow; today: string; onOpen: () => void }) {
  const kind = ACCOUNT_KINDS.find((k) => k.key === a.kind) ?? ACCOUNT_KINDS[0];
  const month = today.slice(0, 7);
  return (
    <button className={'acct-card' + (a.archived ? ' archived' : '')} title={`Change ${a.name}`} onClick={onOpen}>
      <span className="acct-name">
        <span className="acct-icon">
          <i className={'ph-duotone ' + kind.icon} aria-hidden="true" />
        </span>
        <span className="acct-name-in">
          <b>{a.name}</b>
          <span className="meta">{a.archived ? 'Archived' : a.spendable ? 'Day to day' : kind.name}</span>
        </span>
      </span>
      <span className={'serif tnum acct-bal' + (now < 0 ? ' neg' : '')}>{fmtMoney(now)}</span>
      {a.goal !== null ? (
        <span className="acct-lines">
          <span className="acct-bar" role="img" aria-label={`${Math.round((Math.max(0, now) / a.goal) * 100)}% of the goal`}>
            <span style={{ width: `${Math.min(100, Math.max(0, (now / a.goal) * 100))}%` }} />
          </span>
          <span className="meta">
            {fmtMoney(now)} of {fmtMoney(a.goal)}
            {a.goalBy && ` · by ${monthYear(a.goalBy)}`}
          </span>
          <span className={'meta' + (now >= a.goal ? ' acct-up' : '')}>
            {now >= a.goal
              ? 'Goal reached'
              : a.goalBy > month
                ? `About ${fmtMoney(goalPerMonth(now, a.goal, a.goalBy, today))} a month to get there`
                : `${fmtMoney(a.goal - now)} to go`}
          </span>
        </span>
      ) : (
        <span className="acct-lines meta">
          <span className={change > 0 && !isZero(change) ? 'acct-up' : undefined}>{isZero(change) ? 'No change this month' : `${fmtMoney(change, true)} this month`}</span>
          {!isZero(end - now) && (
            <span>
              End of {monthName(month, true)} {fmtMoney(end)}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

/** An amount in a form field: shows "$1,200" and edits as "1200". */
function AmountInput({ id, value, onChange }: { id: string; value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseMoney(text) === undefined;
  return (
    <input
      id={id}
      className={'input tnum' + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      placeholder="$0"
      aria-invalid={bad || undefined}
      value={text ?? (value === null ? '' : fmtMoney(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** Adds an account, or changes one: its name, kind, starting balance and goal; correcting what's in it; archiving it. */
function AccountDrawer({ money, today, id, onChange, onClose }: { money: Money; today: string; id: string | null; onChange: (m: Money) => void; onClose: () => void }) {
  const existing = money.accounts.find((a) => a.id === id);
  const [draft, setDraft] = useState<MoneyAccount>(() => existing ?? newAccount(newId('a'), '', 'pot'));
  // Picking a kind sets whether it's day-to-day money, until that's set by hand.
  const [spendSet, setSpendSet] = useState(!!existing);
  const [plan, setPlan] = useState(true);
  const [from, setFrom] = useState(() => mainAccount(money.accounts));
  const [actual, setActual] = useState<number | null>(null);
  const month = today.slice(0, 7);
  const balance = existing ? accountBalance(money, existing.id, today, true) : draft.opening;
  const perMonth = draft.goal && draft.goalBy > month ? goalPerMonth(balance, draft.goal, draft.goalBy, today) : 0;
  const used = money.entries.some((e) => e.account === id || e.to === id);
  const name = draft.name.trim();
  const planning = !existing && plan && perMonth > 0 && money.accounts.length > 0;

  const save = () => {
    if (!name) return;
    const account: MoneyAccount = { ...draft, name, goalBy: draft.goal ? draft.goalBy : '' };
    let entries = money.entries;
    if (planning) {
      // A planned monthly move from the next month on, on today's day (or the 28th, so every month has it).
      const first = `${addMonths(month, 1)}-${String(Math.min(Number(today.slice(8)), 28)).padStart(2, '0')}`;
      const moves = repeatDates(first, 'month', account.goalBy).map(
        (date): MoneyEntry => ({ id: newId('e'), date, kind: 'move', amount: perMonth, note: `Saving for ${name}`, category: '', planned: true, account: from, to: account.id }),
      );
      entries = sortEntries([...entries, ...moves.slice(0, MAX_ENTRIES - entries.length)]);
    }
    onChange({ ...money, accounts: existing ? money.accounts.map((a) => (a.id === id ? account : a)) : [...money.accounts, account], entries });
    onClose();
  };
  /** Records the difference between what the app has and what the account really has today, as done money in or out. */
  const correct = () => {
    if (!existing || actual === null || isZero(actual - balance)) return;
    const diff = actual - balance;
    const entry: MoneyEntry = { id: newId('e'), date: today, kind: diff > 0 ? 'in' : 'out', amount: Math.abs(Math.round(diff * 100) / 100), note: 'Balance correction', category: '', planned: false, account: existing.id, to: '' };
    onChange({ ...money, entries: sortEntries([...money.entries, entry]) });
    setActual(null);
  };
  const setArchived = (archived: boolean) => {
    onChange({ ...money, accounts: money.accounts.map((a) => (a.id === id ? { ...a, archived } : a)) });
    onClose();
  };

  return (
    <Drawer title={existing ? existing.name : 'Add an account'} onClose={onClose}>
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          Name
          <input className="input" maxLength={40} placeholder="Like Japan trip" autoFocus={!existing} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>

        <fieldset className="acct-kinds" role="radiogroup" aria-label="What kind?">
          <legend className="field">What kind?</legend>
          {ACCOUNT_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={draft.kind === k.key}
              className={'acct-kind' + (draft.kind === k.key ? ' on' : '')}
              onClick={() => setDraft({ ...draft, kind: k.key, spendable: spendSet ? draft.spendable : spendableKind(k.key) })}
            >
              <i className={'ph-duotone ' + k.icon} aria-hidden="true" />
              <span>
                <b>{k.name}</b>
                <span className="meta">{k.note}</span>
              </span>
            </button>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor="acct-opening">{existing ? `What it had on ${shortDate(money.start)}, when tracking started` : 'Money in it now'}</label>
          <AmountInput id="acct-opening" value={draft.opening} onChange={(v) => setDraft({ ...draft, opening: v ?? 0 })} />
        </div>

        <div className="acct-goal-box">
          <b>
            Goal <span className="meta">(optional)</span>
          </b>
          <div className="acct-row">
            <div className="field">
              <label htmlFor="acct-goal">Save up</label>
              <AmountInput id="acct-goal" value={draft.goal} onChange={(v) => setDraft({ ...draft, goal: v && v > 0 ? v : null, goalBy: draft.goalBy || addMonths(month, 6) })} />
            </div>
            <label className="field">
              By
              <input className="input tnum" type="month" min={month} disabled={!draft.goal} value={draft.goalBy} onChange={(e) => setDraft({ ...draft, goalBy: e.target.value })} />
            </label>
          </div>
          {perMonth > 0 && (
            <span className="meta">
              That’s about <b>{fmtMoney(perMonth)} a month</b> from {monthYear(addMonths(month, 1))}.
            </span>
          )}
          {!existing && perMonth > 0 && money.accounts.length > 0 && (
            <label className="acct-check">
              <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
              <span>
                Plan a monthly move of {fmtMoney(perMonth)} from{' '}
                <AccountSelect bare money={money} value={from} label="Move from" className="input sm acct-inline" onChange={setFrom} />
              </span>
            </label>
          )}
        </div>

        <label className="acct-check">
          <input
            type="checkbox"
            checked={draft.spendable}
            onChange={(e) => {
              setSpendSet(true);
              setDraft({ ...draft, spendable: e.target.checked });
            }}
          />
          <span>
            Count it as day-to-day money
            <span className="meta">“In the bank now”, the month’s balances and the forecasts only count day-to-day accounts. Leave it off for pots and investments.</span>
          </span>
        </label>

        <div className="acct-actions">
          <button type="submit" className="btn btn-primary" disabled={!name}>
            {existing ? 'Save' : name ? `Add ${name}` : 'Add account'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>

      {existing && (
        <div className="drawer-section">
          <h3 className="drawer-label">Correct the balance</h3>
          <span className="meta">
            The app has {fmtMoney(balance)} in {existing.name} today. If the real balance is different (say investments went up or down), type it here and the difference goes in as done money in or out.
          </span>
          <div className="acct-row">
            <div className="field">
              <label htmlFor="acct-actual">What it really has today</label>
              <AmountInput id="acct-actual" value={actual} onChange={setActual} />
            </div>
            <button type="button" className="btn btn-secondary acct-row-btn" disabled={actual === null || isZero(actual - balance)} onClick={correct}>
              {actual === null || isZero(actual - balance) ? 'Correct it' : `Add ${fmtMoney(actual - balance, true)}`}
            </button>
          </div>
        </div>
      )}

      {existing && (
        <div className="drawer-section">
          <h3 className="drawer-label">{existing.archived ? 'Archived' : 'Done with it?'}</h3>
          <span className="meta">
            {existing.archived
              ? 'It keeps its history but isn’t offered for new entries.'
              : 'Archiving keeps its history and balance but stops offering it for new entries.'}
          </span>
          <div className="acct-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setArchived(!existing.archived)}>
              {existing.archived ? 'Bring it back' : 'Archive'}
            </button>
            {!used && money.accounts.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost acct-delete"
                onClick={() => {
                  onChange({ ...money, accounts: money.accounts.filter((a) => a.id !== id) });
                  onClose();
                }}
              >
                Delete it
              </button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Moves money from one account to another, once or on repeat. The total stays the same. */
function MoveDrawer({ money, today, onChange, onClose }: { money: Money; today: string; onChange: (m: Money) => void; onClose: () => void }) {
  const [from, setFrom] = useState(() => lastAccount(money));
  const [to, setTo] = useState(() => otherAccount(money, lastAccount(money)));
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [repeat, setRepeat] = useState<Repeat>('once');
  const [until, setUntil] = useState(today.slice(0, 7));
  const [note, setNote] = useState('');
  const dates = repeatDates(date || today, repeat, until);
  const ok = !!date && !!amount && !!to && from !== to && money.entries.length + dates.length <= MAX_ENTRIES;
  const spend = (id: string) => money.accounts.find((a) => a.id === id)?.spendable ?? false;
  const after = (id: string, sign: number) => accountBalance(money, id, today, true) + (date <= today && amount ? sign * amount : 0);

  const add = () => {
    if (!ok) return;
    const moves = dates.map((d): MoneyEntry => ({ id: newId('e'), date: d, kind: 'move', amount: Math.abs(amount!), note: note.trim(), category: '', planned: d > today, account: from, to }));
    onChange({ ...money, entries: sortEntries([...money.entries, ...moves]) });
    localSet('moneyAccount', from);
    onClose();
  };

  return (
    <Drawer title="Move money" onClose={onClose}>
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="acct-row move-ends">
          <div className="field">
            <label htmlFor="move-from">From</label>
            <AccountSelect id="move-from" bare money={money} value={from} label="From" className="input" onChange={(id) => (setFrom(id), id === to && setTo(from))} />
            <span className="meta tnum">
              {fmtMoney(accountBalance(money, from, today, true))}
              {date <= today && amount ? ` → ${fmtMoney(after(from, -1))}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn md move-swap"
            title="Swap"
            aria-label="Swap from and to"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            <i className="ph-bold ph-arrows-left-right" />
          </button>
          <div className="field">
            <label htmlFor="move-to">To</label>
            <AccountSelect id="move-to" bare money={money} value={to} label="To" className="input" onChange={(id) => (setTo(id), id === from && setFrom(to))} />
            <span className="meta tnum">
              {fmtMoney(accountBalance(money, to, today, true))}
              {date <= today && amount ? ` → ${fmtMoney(after(to, 1))}` : ''}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="move-amount">Amount</label>
          <AmountInput id="move-amount" value={amount} onChange={(v) => setAmount(v === null ? null : Math.abs(v))} />
        </div>
        <div className="acct-row">
          <label className="field">
            Date
            <input className="input tnum" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            Repeat
            <select className="input" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              {REPEATS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {repeat !== 'once' && (
            <label className="field">
              Until the end of
              <input className="input tnum" type="month" min={date.slice(0, 7)} value={until} onChange={(e) => e.target.value && setUntil(e.target.value)} />
            </label>
          )}
        </div>
        <label className="field">
          Note (optional)
          <input className="input" maxLength={120} placeholder="Like Monthly invest" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="acct-note">
          {dates.length > 1 ? `${dates.length} moves, the first ` : 'It goes in '}
          {date > today ? 'as planned: tick it in Month once it’s happened.' : 'as done.'}{' '}
          {spend(from) === spend(to)
            ? 'Your total and day-to-day balance stay the same; only where the money sits changes.'
            : spend(from)
              ? `Your total stays the same, but it leaves your day-to-day money, so it counts as money out in Month.`
              : `Your total stays the same, but it comes into your day-to-day money, so it counts as money in in Month.`}
        </p>
        <div className="acct-actions">
          <button type="submit" className="btn btn-primary" disabled={!ok}>
            {amount ? `Move ${fmtMoney(amount)}${dates.length > 1 ? ` × ${dates.length}` : ''}` : 'Move'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        {from === to && <span className="meta">Pick two different accounts.</span>}
      </form>
    </Drawer>
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
