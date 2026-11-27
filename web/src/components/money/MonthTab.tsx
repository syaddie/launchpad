import { type CSSProperties, Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { accountBalance, addMonths, balanceOn, calcMonths, fmtMoney, MAX_ENTRIES, monthKeys, monthName, type Repeat, repeatDates, sortEntries, toReview } from '../../../../shared/money';
import { looksLikeSub, markSub, seriesByEntry, unmarkSub } from '../../../../shared/subscriptions';
import type { Money, MoneyCategory, MoneyEntry } from '../../../../shared/types';
import { localGet, localSet } from '../../api';
import { newId } from '../../util';
import { copyText, menuProps } from '../ContextMenu';
import { periodStep } from '../../motion';
import { Glide, Glyphs, Readout, usePeriodScan } from '../Motion';
import { EntryRow } from './EntryRow';
import { MonthCalendar, type PickHow, TodayLine } from './MonthCalendar';
import { dayGroups, dayName, dayTitle, scrollFor } from './monthList';
import { WhatIf } from './WhatIf';
import { AccountSelect, Calc, CategoryCell, entryTitle, type Kind, KindSwitch, lastAccount, namesOf, type Notify, NumCell, otherAccount, shortDate, signed } from './shared';

export const REPEATS: { key: Repeat; name: string }[] = [
  { key: 'once', name: 'Once' },
  { key: 'week', name: 'Every week' },
  { key: 'fortnight', name: 'Every 2 weeks' },
  { key: 'month', name: 'Every month' },
];

/** `sub`: a repeat that's a subscription; null goes by whether the note looks like one. */
type Draft = { date: string; note: string; category: MoneyCategory | ''; kind: Kind; amount: number | null; account: string; to: string; repeat: Repeat; until: string; sub: boolean | null };

/** A change just made, with an Undo: `back` gets the money as it is when Undo is pressed. */
export type Undoable = (msg: string, back: (m: Money) => Money) => void;

/**
 * Somewhere in the list to bring into view once it has drawn: a day, an entry, or the add row.
 * `focus`: an entry opened from elsewhere takes focus, in its first field (from the keyboard) or as
 * a whole, so Esc closes it.
 */
type Target = { to: 'day'; date: string } | { to: 'entry'; id: string; block: 'center' | 'nearest'; focus?: 'field' | 'row'; flash?: boolean } | { to: 'add' };
type Jump = { target: Target; smooth: boolean; n: number };

/** Every review shows at most this many; the rest are marked Overdue in the list. */
const REVIEW_SHOWN = 3;

const less = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** What stays over the top (or bottom) of the screen while the page scrolls: a phone's rail. */
function covers(): { top: number; bottom: number } {
  const rail = document.querySelector<HTMLElement>('.lp-root .rail');
  if (!rail) return { top: 0, bottom: 0 };
  const cs = getComputedStyle(rail);
  const r = rail.getBoundingClientRect();
  const vh = window.innerHeight;
  if ((cs.position !== 'sticky' && cs.position !== 'fixed') || r.height > vh / 3) return { top: 0, bottom: 0 };
  return r.top < vh / 2 ? { top: r.height + Math.max(0, parseFloat(cs.top) || 0), bottom: 0 } : { top: 0, bottom: Math.max(0, vh - r.top) };
}

/**
 * Where a part of the list is from the top of all of it, by layout (not by what's on screen, which
 * a view coming in scales and moves).
 */
function offsetIn(el: HTMLElement, box: HTMLElement): number {
  let top = 0;
  for (let e: HTMLElement | null = el; e && e !== box; e = e.offsetParent as HTMLElement | null) {
    if (!box.contains(e)) return el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    top += e.offsetTop;
  }
  return top;
}

/** What scrolls to show a part of the tab: the list in its panel, or the tab itself; null for the page (a phone). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && !p.matches('.lp-root'); p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return null;
}

/**
 * Scrolls a part of the tab into view. Off a phone the list scrolls inside its panel (or, too
 * narrow for that, the tab scrolls), with a day's heading (stuck to its top) kept clear of an
 * entry; on a phone the page moves, with the rail kept clear.
 */
function bring(el: HTMLElement, block: 'start' | 'center' | 'nearest', smooth: boolean) {
  const behavior: ScrollBehavior = smooth && !less() ? 'smooth' : 'auto';
  const box = scrollerOf(el);
  if (box) {
    const head = el.matches('.day') ? null : el.closest('.day')?.querySelector<HTMLElement>('.day-head');
    const cover = head && getComputedStyle(head).position === 'sticky' ? head.offsetHeight : 0;
    box.scrollTo({ top: scrollFor({ top: offsetIn(el, box), height: el.offsetHeight }, { scrollTop: box.scrollTop, height: box.clientHeight }, block, cover), behavior });
    return;
  }
  const r = el.getBoundingClientRect();
  const c = covers();
  const view = { scrollTop: window.scrollY, height: window.innerHeight - c.bottom };
  window.scrollTo({ top: scrollFor({ top: r.top + window.scrollY - 8, height: r.height + 16 }, view, block, c.top), behavior });
}

/** A tint on what was just brought into view, fading, so the eye finds it (styles.css, `lp-found`). */
function flash(el: HTMLElement) {
  el.classList.remove('lp-found');
  void el.offsetWidth;
  el.classList.add('lp-found');
  const end = (ev: AnimationEvent) => {
    if (ev.target !== el) return;
    el.classList.remove('lp-found');
    el.removeEventListener('animationend', end);
  };
  el.addEventListener('animationend', end);
}

/**
 * Money › Month: the month's numbers, what's planned for days that have passed, the calendar and
 * the entries a day at a time. Off a phone the calendar and the list sit side by side and fill the
 * window: the calendar's weeks share its height and the list scrolls in its own panel, opening at
 * today. Picking a day on the calendar brings it up in the list and makes it the add row's day.
 */
export function MonthTab({ money, today, month, onMonth, onChange, onOpenOwed, together, notify, undo }: {
  money: Money;
  /** Show the calendar and the list side by side (on a wide enough screen). */
  together?: boolean;
  today: string;
  month: string;
  onMonth: (k: string) => void;
  onChange: (m: Money) => void;
  onOpenOwed: () => void;
  notify: Notify;
  undo: Undoable;
}) {
  // Include the month on screen, even one before the first or past the last.
  const keys = monthKeys({ ...money, start: `${month}-01` < money.start ? `${month}-01` : money.start }, month > today.slice(0, 7) ? `${month}-01` : today);
  const months = calcMonths(money, keys);
  const calc = months[keys.indexOf(month)] ?? months[0];
  const names = namesOf(money);
  const isNow = today.slice(0, 7) === month;
  const blank = (): Draft => {
    const account = lastAccount(money);
    return { date: isNow ? today : `${month}-01`, note: '', category: '', kind: 'out', amount: null, account, to: otherAccount(money, account), repeat: 'once', until: month, sub: null };
  };
  const [draft, setDraft] = useState<Draft>(blank);
  const [draftMonth, setDraftMonth] = useState(month);
  /** A day picked on the calendar that has nothing on it: the list shows it anyway, empty. */
  const [emptyDay, setEmptyDay] = useState<string | null>(null);
  if (draftMonth !== month) {
    setDraftMonth(month);
    setDraft(blank());
    setEmptyDay(null);
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
  const listShown = together || layout === 'list';

  /**
   * The way the month last changed, while the new one comes in (`data-arrive` on the tab): the calendar wipes across
   * that way, the title lights up from that side, and the list slides in from it. Only a change made here moves:
   * opening Month on a month from elsewhere just shows it. (The calendar's part is shared: usePeriodScan.)
   */
  const scan = usePeriodScan<HTMLDivElement>();
  const toMonth = (k: string) => {
    const step = periodStep(month, k);
    if (!step) return;
    scan.go(step);
    onMonth(k);
  };

  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState<Jump | null>(null);
  const jumps = useRef(0);
  /**
   * Off a phone, where the list stands for the month and account shown: at `at` (the add row's day
   * when they were picked) until the list is scrolled or anything is brought into view (`held`).
   */
  const anchor = useRef<{ key: string; at: string | null; held: boolean }>({ key: '', at: null, held: false });
  const hold = () => void (anchor.current.held = true);
  const go = (target: Target, smooth = true) => {
    hold();
    setJump({ target, smooth, n: ++jumps.current });
  };

  const inMonth = money.entries.filter((e) => e.date.slice(0, 7) === month);
  const entries = shown ? inMonth.filter((e) => e.account === shown.id || e.to === shown.id) : inMonth;
  const review = toReview(money, today).filter((e) => e.date.slice(0, 7) === month);
  // Accounts to filter by: those in use, and any old one this month's entries still mention.
  const filters = money.accounts.filter((a) => !a.archived || a.id === only || inMonth.some((e) => e.account === a.id || e.to === a.id));
  /** The add row's day, ringed on the calendar while it's in this month. */
  const picked = draft.date.slice(0, 7) === month ? draft.date : null;

  const setEntries = (list: MoneyEntry[]) => onChange({ ...money, entries: sortEntries(list) });
  const patch = (id: string, p: Partial<MoneyEntry>) => setEntries(money.entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  /** Deleting an invoice's money deletes the invoice too; Undo puts both back where they were. */
  const remove = (e: MoneyEntry) => {
    const inv = e.invoice ? money.invoices.find((i) => i.id === e.invoice) : undefined;
    const at = money.entries.indexOf(e);
    const invAt = inv ? money.invoices.indexOf(inv) : -1;
    onChange({ ...money, entries: money.entries.filter((x) => x.id !== e.id), invoices: inv ? money.invoices.filter((i) => i.id !== inv.id) : money.invoices });
    if (editing === e.id) setEditing(null);
    undo(`Deleted ${entryTitle(e, names)}${inv ? ' and its invoice' : ''}`, (m) => ({
      ...m,
      entries: m.entries.some((x) => x.id === e.id) ? m.entries : sortEntries([...m.entries.slice(0, at), e, ...m.entries.slice(at)]),
      invoices: inv && !m.invoices.some((i) => i.id === inv.id) ? [...m.invoices.slice(0, invAt), inv, ...m.invoices.slice(invAt)] : m.invoices,
    }));
  };
  /** Ticks off planned entries at once, with an Undo. */
  const markDone = (list: MoneyEntry[], msg: string) => {
    const ids = new Set(list.filter((e) => e.planned).map((e) => e.id));
    if (!ids.size) return;
    setEntries(money.entries.map((e) => (ids.has(e.id) ? { ...e, planned: false } : e)));
    undo(msg, (m) => ({ ...m, entries: m.entries.map((e) => (ids.has(e.id) ? { ...e, planned: true } : e)) }));
  };

  /** The add row takes a day (and a repeat runs at least to its month). */
  const withDate = (d: Draft, date: string): Draft => ({ ...d, date, until: d.until < date.slice(0, 7) ? date.slice(0, 7) : d.until });
  /**
   * A day picked on the calendar: it's the add row's day, and the list shows it (on a phone the list
   * opens for it). On a phone the arrow keys only move the ring, so the calendar stays.
   */
  const pick = (date: string, how: PickHow) => {
    setDraft((d) => withDate(d, date));
    if (how === 'key' && !together) return;
    if (!together) setLayout('list');
    setEmptyDay(date === today || entries.some((e) => e.date === date) ? null : date);
    go({ to: 'day', date }, how !== 'key');
  };
  /** Add something on a day: the add row takes it and its note takes focus. */
  const addOn = (date: string) => {
    setDraft((d) => withDate(d, date));
    if (!together) setLayout('list');
    go({ to: 'add' });
  };
  /** Open an entry for changing, from elsewhere ("Change it"): the list shows it, in the middle. */
  const change = (e: MoneyEntry, keyboard: boolean) => {
    if (!together) setLayout('list');
    if (shown && e.account !== shown.id && e.to !== shown.id) setOnly('');
    setEditing(e.id);
    go({ to: 'entry', id: e.id, block: 'center', focus: keyboard ? 'field' : 'row' });
  };

  useEffect(() => {
    if (!jump) return;
    const t = jump.target;
    if (t.to === 'add') {
      const box = addRef.current;
      if (!box) return;
      bring(box, 'nearest', jump.smooth);
      box.querySelector<HTMLInputElement>('.composer-note')?.focus({ preventScroll: true });
      return;
    }
    const list = listRef.current;
    if (!list) return;
    let el: HTMLElement | null = null;
    if (t.to === 'entry') el = list.querySelector<HTMLElement>(`[data-entry="${t.id}"]`);
    else {
      // The day, or where it would be: today's line when nothing's on today, else the next day there is.
      el = list.querySelector<HTMLElement>(`[data-day="${t.date}"]`) ?? (t.date === today ? list.querySelector<HTMLElement>('[data-today]') : null);
      el ??= [...list.querySelectorAll<HTMLElement>('[data-day]')].find((d) => d.dataset.day! > t.date) ?? null;
    }
    if (!el) return;
    bring(el, t.to === 'entry' ? t.block : 'start', jump.smooth);
    if (t.to === 'day' || t.block === 'center' || t.flash) flash(el);
    if (t.to === 'entry' && t.focus) (t.focus === 'field' ? el.querySelector<HTMLElement>('.ent-form :is(input, select, button)') : el)?.focus({ preventScroll: true });
    // Only when a jump is asked for, not on every change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  // Off a phone the list opens at the add row's day (today, in this month), and stays on that day
  // when the account shown changes. Until it's moved, it keeps to it as the entries come in or
  // change. (Not where the list goes under the calendar and the tab scrolls instead.)
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!together || !list || getComputedStyle(list).overflowY === 'visible') return;
    const key = `${month}|${only}`;
    if (anchor.current.key !== key) anchor.current = { key, at: picked ?? (isNow ? today : null), held: false };
    const { at, held } = anchor.current;
    if (held) return;
    const el = at ? (list.querySelector<HTMLElement>(`[data-day="${at}"]`) ?? (at === today ? list.querySelector<HTMLElement>('[data-today]') : null) ?? [...list.querySelectorAll<HTMLElement>('[data-day]')].find((d) => d.dataset.day! > at)) : null;
    const top = el ? offsetIn(el, list) : 0;
    if (Math.abs(list.scrollTop - top) > 1) list.scrollTop = top;
  });

  const repeats = repeatDates(draft.date || today, draft.repeat, draft.until);
  const move = draft.kind === 'move';
  const canAdd = !!draft.date && draft.amount !== null && money.entries.length < MAX_ENTRIES && (!move || (!!draft.to && draft.to !== draft.account));
  const canSub = draft.kind === 'out' && draft.repeat !== 'once';
  const isSub = canSub && (draft.sub ?? looksLikeSub(draft.note));
  /** The entries the add row would add; repeats share a series. */
  const drafted = (series = ''): MoneyEntry[] =>
    repeats.slice(0, MAX_ENTRIES - money.entries.length).map((date): MoneyEntry => ({
      id: newId('e'),
      date,
      kind: draft.kind,
      amount: Math.abs(draft.amount ?? 0),
      note: draft.note.trim(),
      category: move ? '' : draft.category,
      planned: date > today,
      account: draft.account,
      to: move ? draft.to : '',
      ...(series ? { series } : {}),
    }));
  const add = () => {
    if (!canAdd) return;
    const series = draft.repeat !== 'once' ? newId('s') : '';
    const added = drafted(series);
    const every = draft.repeat === 'once' ? null : draft.repeat;
    onChange({ ...money, entries: sortEntries([...money.entries, ...added]), subs: isSub && every ? [...money.subs, { id: series, every, review: false, since: '' }] : money.subs });
    localSet('moneyAccount', draft.account);
    setDraft({ ...blank(), date: draft.date, kind: draft.kind, account: draft.account, to: draft.to });
    // The list shows what went in (the first of a repeat in this month).
    const here = added.find((e) => e.date.slice(0, 7) === month);
    if (here) go({ to: 'entry', id: here.id, block: 'nearest', flash: true });
  };

  // The entries a day at a time, each day ending on its balance (and the picked day, if it has none).
  const days = dayGroups(entries, emptyDay);
  const todayAt = isNow ? days.findIndex((d) => d.date > today) : -2;
  const lowIndex = calc.balances.indexOf(calc.lowest);
  const lowDate = `${month}-${String(lowIndex + 1).padStart(2, '0')}`;
  const balanceAt = (date: string) => (shown ? accountBalance(money, shown.id, date) : calc.balances[Number(date.slice(8)) - 1]);
  const series = seriesByEntry(money);
  const subIds = new Set(money.subs.map((x) => x.id));
  const pickAccount = (account: string) => setDraft({ ...draft, account, to: draft.to === account ? otherAccount(money, account) : draft.to });
  const plannedCount = entries.filter((e) => e.planned).length;

  const listPart = (
    <>
      <div
        ref={addRef}
        className="composer month-add"
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
        <div className="composer-opts">
          <input type="date" className="cell composer-field tnum" aria-label="New entry date" value={draft.date} onChange={(e) => setDraft(e.target.value ? withDate(draft, e.target.value) : { ...draft, date: '' })} />
          {move ? (
            <>
              <span className="meta">from</span>
              <AccountSelect money={money} value={draft.account} label="Move from" className="composer-field" onChange={pickAccount} />
              <span className="meta">to</span>
              <AccountSelect money={money} value={draft.to} label="Move to" className="composer-field" onChange={(to) => setDraft({ ...draft, to })} />
            </>
          ) : (
            <>
              <span className="meta">{draft.kind === 'in' ? 'into' : 'from'}</span>
              <AccountSelect money={money} value={draft.account} label={draft.kind === 'in' ? 'Paid into' : 'Paid from'} className="composer-field" onChange={pickAccount} />
              <CategoryCell value={draft.category} label="New entry category" className="composer-field" empty="Category" onChange={(category) => setDraft({ ...draft, category })} />
            </>
          )}
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
          {canSub && (
            <label className="meta composer-sub" title="List it in Subscriptions, with what it costs a month and a year">
              <input type="checkbox" checked={isSub} onChange={(e) => setDraft({ ...draft, sub: e.target.checked })} />
              Subscription
            </label>
          )}
          {draft.kind === 'in' && (
            <button className="btn-link meta" onClick={onOpenOwed}>
              Gig pay? Add it as an invoice in Owed
            </button>
          )}
          <span className="meta composer-hint">{!draft.date ? 'Pick a day for it' : draft.date > today ? 'Goes in as planned: tick it once it’s happened' : 'Goes in as done'}</span>
        </div>
        {canAdd && draft.kind !== 'in' && !!draft.amount && <WhatIf money={money} add={drafted()} today={today} label={repeats.length > 1 ? `If you add these ${repeats.length}` : 'If you add this'} />}
      </div>

      <section className="panel days" aria-label={`Entries for ${monthName(month)}`}>
        <div className="days-head">
          {money.accounts.length > 1 && (
            <label className="days-show">
              <span className="meta">Show</span>
              <select className={'input sm days-pick' + (shown ? ' on' : '')} value={shown ? shown.id : ''} onChange={(e) => setOnly(e.target.value)}>
                <option value="">All accounts</option>
                {filters.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="meta days-count">
            {entries.length ? `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}` : 'No entries'}
            {plannedCount > 0 && ` · ${plannedCount} planned`}
          </span>
          {isNow && (
            <button className="btn btn-ghost btn-small days-today" title="Show today in the list, and add to it" onClick={() => pick(today, 'click')}>
              <i className="ph-duotone ph-calendar-dot" />
              Today
            </button>
          )}
        </div>
        {/* A new one for each month, so the month coming in comes in whole (the list opens at its day again anyway). */}
        <div key={month} className="days-scroll" ref={listRef} onWheel={hold} onTouchStart={hold} onPointerDown={hold} onKeyDown={hold}>
          {days.map((d, i) => {
            const t = dayTitle(d.date, today);
            return (
              <Fragment key={d.date}>
                {i === todayAt && <TodayLine money={money} today={today} account={shown} now={days[i - 1]?.date === today} />}
                <div className={'day' + (d.list.length ? '' : ' day-empty')} data-day={d.date}>
                  <div className="day-head">
                    <h3 className="day-title">
                      {t.rel && <span className={'day-rel' + (t.rel === 'Today' ? ' now' : '')}>{t.rel}</span>}
                      {t.full}
                    </h3>
                    <span className="day-bal">
                      {!shown && d.date === lowDate && calc.lowest < calc.opening && <span className="chip chip-warn">Lowest</span>}
                      <Calc v={balanceAt(d.date)} title={`End of ${shortDate(d.date)}: ${shown ? `what’s in ${shown.name}` : 'your day-to-day accounts'}, counting everything up to then, planned or done`} />
                    </span>
                  </div>
                  {d.list.length ? (
                    d.list.map((e) => (
                      <EntryRow
                        key={e.id}
                        e={e}
                        series={series.get(e.id)}
                        isSub={!!e.series && subIds.has(e.series)}
                        onSub={(on) => {
                          const s = series.get(e.id);
                          if (s) onChange(on ? markSub(money, s, newId('s')) : unmarkSub(money, s.id));
                        }}
                        money={money}
                        today={today}
                        open={editing === e.id}
                        onOpen={() => {
                          setEditing(e.id);
                          go({ to: 'entry', id: e.id, block: 'nearest' });
                        }}
                        onClose={() => setEditing(null)}
                        onPatch={(p) => {
                          patch(e.id, p);
                          // Moved to another day: the list follows it there.
                          if (p.date && p.date !== e.date) go({ to: 'entry', id: e.id, block: 'nearest' });
                        }}
                        onDelete={() => remove(e)}
                        onOpenOwed={onOpenOwed}
                        notify={notify}
                      />
                    ))
                  ) : (
                    <div className="day-none" {...menuProps(() => [{ label: 'Add to this day', icon: 'ph-plus', onSelect: () => addOn(d.date) }], dayName(d.date, today))}>
                      <span>{shown ? `Nothing in or out of ${shown.name} on this day.` : 'Nothing in or out on this day.'}</span>
                      <button className="btn btn-ghost btn-small" onClick={() => addOn(d.date)}>
                        <i className="ph-duotone ph-plus" />
                        Add to this day
                      </button>
                    </div>
                  )}
                </div>
              </Fragment>
            );
          })}
          {todayAt === -1 && <TodayLine money={money} today={today} account={shown} now={days[days.length - 1]?.date === today} />}
          {!entries.length && (
            <p className="month-empty">
              {shown
                ? `Nothing in or out of ${shown.name} in ${monthName(month)}.`
                : `Nothing in ${monthName(month)} yet. Plan what you expect to spend and earn, then tick, change or delete entries as the days go by.`}
            </p>
          )}
          {entries.length > 0 && (
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
        </div>
      </section>
    </>
  );

  const calendar = <MonthCalendar month={month} money={money} entries={inMonth} calc={calc} today={today} picked={picked} onPick={pick} onAdd={addOn} onDone={(date) => markDone(inMonth.filter((e) => e.date === date), `Marked ${shortDate(date)} as done`)} notify={notify} />;
  const stats = [
    isNow
      ? { label: 'In the bank now', value: balanceOn(money, today, true), note: 'from what’s done', title: 'Your day-to-day accounts, counting only what’s done' }
      : { label: 'Started with', value: calc.opening, note: month <= keys[0] ? 'what your accounts opened with' : 'last month’s closing balance', title: 'Your day-to-day accounts at the start of the month' },
    { label: `End of ${monthName(month, true)}`, value: calc.closing, note: calc.plannedIn || calc.plannedOut ? 'if the plan holds' : 'all of it done', title: 'Your day-to-day accounts at the end of the month, counting what’s planned' },
    { label: 'Money in', value: calc.totalIn, sign: true, tone: 'in' as const, note: calc.plannedIn ? `${fmtMoney(calc.plannedIn)} still to come` : 'all of it done' },
    { label: 'Money out', value: -calc.totalOut, sign: true, note: calc.plannedOut ? `${fmtMoney(calc.plannedOut)} still to come` : 'all of it done' },
  ];

  const reviewBar = review.length > 0 && (
    <div className="review-bar">
      <div className="review-head">
        <i className="ph-duotone ph-clock-countdown" />
        <b>Did {review.length === 1 ? 'this' : 'these'} happen?</b>
        <span>Planned for a day that’s passed.</span>
        {review.length > 1 && (
          <button className="btn btn-secondary btn-small" onClick={() => markDone(review, `Marked ${review.length} as done`)}>
            Mark all {review.length} as done
          </button>
        )}
      </div>
      {review.slice(0, REVIEW_SHOWN).map((e) => (
        <div
          key={e.id}
          className="review-item"
          {...menuProps(
            () => [
              { label: 'Yes, it’s done', icon: 'ph-check-circle', onSelect: () => patch(e.id, { planned: false }) },
              { label: 'Change it', icon: 'ph-pencil-simple', onSelect: () => change(e, false) },
              'sep',
              { label: 'Copy', icon: 'ph-copy', onSelect: () => copyText(`${shortDate(e.date)} · ${entryTitle(e, names)} · ${fmtMoney(e.kind === 'move' ? e.amount : signed(e), e.kind !== 'move')} (planned)`, notify) },
              'sep',
              { label: e.invoice ? 'Delete, along with its invoice' : 'Delete', icon: 'ph-trash', danger: true, onSelect: () => remove(e) },
            ],
            entryTitle(e, names),
          )}
        >
          <span className="review-what">
            {entryTitle(e, names)} <span className="meta">· {shortDate(e.date)}</span>
          </span>
          <b className="tnum">{fmtMoney(e.kind === 'move' ? e.amount : signed(e), e.kind !== 'move')}</b>
          <span className="review-acts">
            <button className="btn btn-small review-yes" onClick={() => patch(e.id, { planned: false })}>
              Yes, it’s done
            </button>
            <button className="btn btn-ghost btn-small" onClick={(ev) => change(e, ev.detail === 0)}>
              Change it
            </button>
          </span>
        </div>
      ))}
      {review.length > REVIEW_SHOWN && <span className="review-more">and {review.length - REVIEW_SHOWN} more, marked Overdue in the list</span>}
    </div>
  );

  return (
    <div ref={scan.ref} className={'money-body month-tab lp-scan' + (together ? ' together' : '')} data-arrive={scan.arrive}>
      <div className="month-top">
        <div className="month-lead">
          <div className="month-bar">
            <div className="month-nav">
              <button className="icon-btn md lp-step prev" aria-label="Previous month" disabled={month <= addMonths(keys[0], -1)} onClick={() => toMonth(addMonths(month, -1))}>
                <i className="ph-duotone ph-caret-left" />
              </button>
              {/* Each letter its own, so a design can light them one after another (Mission's dot-matrix relight). */}
              <h2 key={month} className="serif month-title lp-period-label">
                <Glyphs text={monthName(month)} />
              </h2>
              <button className="icon-btn md lp-step next" aria-label="Next month" disabled={month >= addMonths(today.slice(0, 7), 24)} onClick={() => toMonth(addMonths(month, 1))}>
                <i className="ph-duotone ph-caret-right" />
              </button>
              {!isNow && (
                <button className="btn btn-ghost btn-small month-now" onClick={() => toMonth(today.slice(0, 7))}>
                  This month
                </button>
              )}
            </div>
            {!together && (
              <div className="tabs layout-tabs" role="group" aria-label="Show as">
                <Glide on={layout} />
                {(['list', 'calendar'] as const).map((l) => (
                  <button key={l} className={'tab' + (layout === l ? ' active' : '')} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                    <i className={'ph-duotone ' + (l === 'list' ? 'ph-list-bullets' : 'ph-calendar-blank')} />
                    {l === 'list' ? 'List' : 'Calendar'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <p key={month} className="month-foot">
            {isNow && (
              <span>
                Started with <Calc v={calc.opening} title="What your day-to-day accounts had at the start of the month" strong />
              </span>
            )}
            {calc.lowest < calc.opening && (
              <span>
                <i className="ph-duotone ph-trend-down" aria-hidden="true" />
                Lowest <Calc v={calc.lowest} title="The lowest end-of-day balance this month" strong /> on {shortDate(lowDate)}
              </span>
            )}
          </p>
        </div>
        <section className="month-sum" aria-label={`${monthName(month)} in numbers`} data-copy="the month’s numbers" data-copy-text={[monthName(month), ...stats.map((s) => `${s.label}: ${fmtMoney(s.value, s.sign)} (${s.note})`)].join('\n')}>
          {stats.map((s, i) => (
            <div key={s.label} className={'m-stat' + (i === 0 ? ' hero' : '')} title={s.title} style={{ '--i': i } as CSSProperties}>
              <span className="meta">{s.label}</span>
              <span className={'serif tnum' + (s.tone === 'in' ? ' m-in' : '')} style={s.value < 0 && !s.sign ? { color: 'var(--wn)' } : undefined}>
                {/* By its place, not its name ("End of Nov"), so each figure rolls from last month's to this one's. */}
                <Readout text={fmtMoney(s.value, s.sign)} id={`month-stat-${i}`} />
              </span>
              <span className="meta">{s.note}</span>
            </div>
          ))}
        </section>
      </div>

      {!together && reviewBar}

      {together ? (
        <div className="month-split">
          {calendar}
          <div className="month-list-col">
            {reviewBar}
            {listPart}
          </div>
        </div>
      ) : listShown ? (
        listPart
      ) : (
        calendar
      )}
    </div>
  );
}
