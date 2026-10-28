// The money tracker. What's stored is a starting balance and a list of dated
// entries, each money in or out and either planned (the forecast) or done (it
// happened). Everything else is worked out here: day-by-day balances, the
// monthly summary, what still needs checking and when a wishlist item fits.
// Also cleaning for what the page sends, and reading the old workbook on import.
import { MON, addDays, pad2, parseYmd, ymd } from './dates';
import type { Money, MoneyCategory, MoneyEntry, WishItem, WishPriority, WishStatus } from './types';
import type { XCell, XSheet } from './xlsx';

export const MAX_ENTRIES = 5000;
export const MAX_WISHES = 200;
export const CATEGORIES: MoneyCategory[] = ['Food', 'Transport', 'Shopping', 'Bills', 'Family', 'Fun', 'Travel', 'Pay', 'Other'];
export const PRIORITIES: Exclude<WishPriority, ''>[] = ['High', 'Medium', 'Low'];
export const STATUSES: Exclude<WishStatus, ''>[] = ['Wanted', 'Saving up', 'Purchased', 'Dropped'];

/** A fresh tracker starts on the 1st of this month with $0. */
export const starterMoney = (today: Date): Money => ({ start: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), opening: 0, entries: [], wishlist: [] });

/** Cents, so 0.1 + 0.2 shows as $0.30 and not a long tail. */
const cents = (n: number) => Math.round(n * 100) / 100;
const signed = (e: MoneyEntry) => (e.kind === 'in' ? e.amount : -e.amount);

// ---------- months ----------

/** "2026-10" → "October 2026"; short: "Oct". */
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (key: string, short = false) => {
  const [y, m] = key.split('-').map(Number);
  return short ? MON[m - 1] : `${MONTH_NAMES[m - 1]} ${y}`;
};
export const addMonths = (key: string, n: number) => {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
};
export const daysIn = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m, 0).getDate();
};

/** Every month from the start (or the earliest entry) to this month or the last entry, whichever is later. */
export function monthKeys(money: Money, today: string): string[] {
  const dates = money.entries.map((e) => e.date);
  const first = [money.start, ...dates].reduce((a, b) => (b < a ? b : a)).slice(0, 7);
  const last = [today, ...dates].reduce((a, b) => (b > a ? b : a)).slice(0, 7);
  const keys: string[] = [];
  for (let k = first; k <= last && keys.length < 240; k = addMonths(k, 1)) keys.push(k);
  return keys;
}

export function sortEntries(list: MoneyEntry[]): MoneyEntry[] {
  return list.map((e, i) => [e, i] as const).sort((a, b) => (a[0].date < b[0].date ? -1 : a[0].date > b[0].date ? 1 : a[1] - b[1])).map(([e]) => e);
}

// ---------- formulas ----------

export interface MonthCalc {
  key: string;
  opening: number;
  /** The balance at the end of each day of the month: everything planned or done up to then. */
  balances: number[];
  totalIn: number;
  totalOut: number;
  net: number;
  closing: number;
  lowest: number;
  daysBelow: number;
  /** How much of the month's in and out is still only planned. */
  plannedIn: number;
  plannedOut: number;
}

/** Each month's numbers. A month opens with the previous month's closing balance. */
export function calcMonths(money: Money, keys: string[]): MonthCalc[] {
  const byDay = new Map<string, MoneyEntry[]>();
  for (const e of money.entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  let bal = money.opening;
  return keys.map((key) => {
    const opening = bal;
    let totalIn = 0, totalOut = 0, plannedIn = 0, plannedOut = 0;
    const balances: number[] = [];
    for (let d = 1; d <= daysIn(key); d++) {
      for (const e of byDay.get(`${key}-${pad2(d)}`) ?? []) {
        if (e.kind === 'in') {
          totalIn += e.amount;
          if (e.planned) plannedIn += e.amount;
        } else {
          totalOut += e.amount;
          if (e.planned) plannedOut += e.amount;
        }
        bal = cents(bal + signed(e));
      }
      balances.push(bal);
    }
    return {
      key,
      opening,
      balances,
      totalIn: cents(totalIn),
      totalOut: cents(totalOut),
      net: cents(totalIn - totalOut),
      closing: bal,
      lowest: Math.min(...balances),
      daysBelow: balances.filter((b) => b < 0).length,
      plannedIn: cents(plannedIn),
      plannedOut: cents(plannedOut),
    };
  });
}

/** The "All months" row of the summary. */
export function calcTotals(money: Money, months: MonthCalc[]): Omit<MonthCalc, 'key' | 'balances'> {
  const sum = (f: (m: MonthCalc) => number) => cents(months.reduce((a, m) => a + f(m), 0));
  const totalIn = sum((m) => m.totalIn);
  const totalOut = sum((m) => m.totalOut);
  return {
    opening: money.opening,
    totalIn,
    totalOut,
    net: cents(totalIn - totalOut),
    closing: months.length ? months[months.length - 1].closing : money.opening,
    lowest: months.length ? Math.min(...months.map((m) => m.lowest)) : money.opening,
    daysBelow: months.reduce((a, m) => a + m.daysBelow, 0),
    plannedIn: sum((m) => m.plannedIn),
    plannedOut: sum((m) => m.plannedOut),
  };
}

/** The balance at the end of a day: with `doneOnly`, counting only what actually happened. */
export function balanceOn(money: Money, date: string, doneOnly = false): number {
  return cents(money.entries.reduce((a, e) => (e.date <= date && !(doneOnly && e.planned) ? a + signed(e) : a), money.opening));
}

/** Planned entries whose day has passed: they either happened (tick them) or didn't (delete or change them). */
export const toReview = (money: Money, today: string) => money.entries.filter((e) => e.planned && e.date < today);

/** The lowest forecast balance from today to the end of the last month, and the first day it's reached. */
export function lowestAhead(months: MonthCalc[], today: string): { balance: number; date: string } | null {
  let best: { balance: number; date: string } | null = null;
  for (const m of months) {
    m.balances.forEach((b, i) => {
      const date = `${m.key}-${pad2(i + 1)}`;
      if (date >= today && (!best || b < best.balance)) best = { balance: b, date };
    });
  }
  return best;
}

/**
 * The first day from today on that `price` could come out of the forecast balance
 * without it going below $0 on any later day of the tracked months; null if none.
 */
export function affordableFrom(price: number, months: MonthCalc[], today: string): string | null {
  const days = months.flatMap((m) => m.balances.map((b, i) => ({ date: `${m.key}-${pad2(i + 1)}`, b }))).filter((d) => d.date >= today);
  let min = Infinity;
  let found: string | null = null;
  for (let i = days.length - 1; i >= 0; i--) {
    min = Math.min(min, days[i].b);
    if (min >= price) found = days[i].date;
  }
  return found;
}

export const isDone = (w: WishItem) => w.status === 'Purchased' || w.status === 'Dropped';

/** The wishlist's totals. "Still to buy" leaves out what's bought and what's dropped. */
export function wishStats(list: WishItem[]) {
  const sum = (items: WishItem[]) => cents(items.reduce((a, w) => a + (w.price ?? 0), 0));
  const total = sum(list);
  const purchased = sum(list.filter((w) => w.status === 'Purchased'));
  const dropped = sum(list.filter((w) => w.status === 'Dropped'));
  return { items: list.filter((w) => w.name.trim()).length, total, purchased, stillToBuy: cents(total - purchased - dropped) };
}

/** Money out per category for some entries, biggest first. Uncategorised spending is "Not set". */
export function byCategory(entries: MoneyEntry[]): { category: string; amount: number }[] {
  const totals = new Map<string, number>();
  for (const e of entries) if (e.kind === 'out') totals.set(e.category || 'Not set', (totals.get(e.category || 'Not set') ?? 0) + e.amount);
  return [...totals].map(([category, amount]) => ({ category, amount: cents(amount) })).sort((a, b) => b.amount - a.amount);
}

export type Repeat = 'once' | 'week' | 'fortnight' | 'month';

/** The dates a repeating entry lands on, from `date` to the end of the month `until` (YYYY-MM). Monthly ones keep their day, or the month's last. */
export function repeatDates(date: string, repeat: Repeat, until: string): string[] {
  if (repeat === 'once') return [date];
  const out: string[] = [];
  const first = parseYmd(date);
  for (let i = 0; out.length < 400; i++) {
    let d: Date;
    if (repeat === 'month') {
      const m = new Date(first.getFullYear(), first.getMonth() + i, 1);
      d = new Date(m.getFullYear(), m.getMonth(), Math.min(first.getDate(), new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate()));
    } else d = addDays(first, i * (repeat === 'week' ? 7 : 14));
    const s = ymd(d);
    if (s.slice(0, 7) > until) break;
    out.push(s);
  }
  return out;
}

// ---------- typing and showing amounts ----------

/** "$1,200", "−$35", "$12.50"; with `sign`, "+$700" for gains. */
export function fmtMoney(n: number, sign = false): string {
  const v = cents(n);
  const abs = Math.abs(v);
  const s = '$' + abs.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(abs) ? 0 : 2, maximumFractionDigits: 2 });
  return v < 0 ? '−' + s : sign && v > 0 ? '+' + s : s;
}

/** What someone typed into an amount cell: a number, null for an empty cell, or undefined when it isn't an amount. */
export function parseMoney(text: string): number | null | undefined {
  const t = text.trim().replace(/[$,\s]/g, '').replace(/^[−–]/, '-');
  if (!t) return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) && Math.abs(n) < 1e10 ? cents(n) : undefined;
}

// ---------- cleaning what the page sends ----------

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const amount = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e10 ? cents(v) : null);
const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(parseYmd(v)) === v;

function ids<T extends { id: string }>(list: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return list.map((x, i) => {
    const id = x.id && !seen.has(x.id) ? x.id : `${prefix}${i}-${Date.now().toString(36)}`;
    seen.add(id);
    return { ...x, id };
  });
}

/** Coerces anything into a valid Money: real dates, positive amounts, known categories, sane lengths. */
export function cleanMoney(v: unknown, today = new Date()): Money {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<Money>;
  const entries = (Array.isArray(m.entries) ? m.entries : [])
    .slice(0, MAX_ENTRIES)
    .flatMap((x: Partial<MoneyEntry>): MoneyEntry[] => {
      const a = amount(x?.amount);
      if (!x || !isDate(x.date) || a === null) return [];
      // A negative amount is the other direction.
      const kind = (x.kind === 'in') !== a < 0 ? 'in' : 'out';
      return [{
        id: str(x.id, 40),
        date: x.date,
        kind,
        amount: Math.abs(a),
        note: str(x.note, 120),
        category: CATEGORIES.includes(x.category as MoneyCategory) ? (x.category as MoneyCategory) : '',
        planned: x.planned !== false,
      }];
    });
  const wishlist = (Array.isArray(m.wishlist) ? m.wishlist : []).slice(0, MAX_WISHES).map((x: Partial<WishItem>): WishItem => ({
    id: str(x?.id, 40),
    name: str(x?.name, 80),
    category: str(x?.category, 40),
    priority: PRIORITIES.includes(x?.priority as never) ? x!.priority! : '',
    status: STATUSES.includes(x?.status as never) ? x!.status! : '',
    price: amount(x?.price),
    target: typeof x?.target === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(x.target) ? x.target : '',
    notes: str(x?.notes, 200),
  }));
  return {
    start: isDate(m.start) ? m.start : starterMoney(today).start,
    opening: amount(m.opening) ?? 0,
    entries: sortEntries(ids(entries, 'e')),
    wishlist: ids(wishlist, 'w'),
  };
}

// ---------- importing the old workbook ----------

function cellText(c: XCell | undefined): string {
  if (!c || c.v === null) return '';
  if (typeof c.v === 'number' && c.date) {
    // Excel's day 0 is 30 Dec 1899; 25569 is 1 Jan 1970.
    const d = new Date(Math.round((c.v - 25569) * 86_400_000));
    return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const s = String(c.v).trim();
  // Google Sheets keeps formulas it can't export (like =AI(…)) as their own text.
  return s.startsWith('=') ? '' : s;
}

/** A date cell as YYYY-MM, for a wishlist target. */
function cellMonth(c: XCell | undefined): string {
  if (!c || typeof c.v !== 'number' || !c.date) return '';
  const d = new Date(Math.round((c.v - 25569) * 86_400_000));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

const cellNum = (c: XCell | undefined) => (c && typeof c.v === 'number' ? cents(c.v) : null);
const at = (s: XSheet, r: number, c: number) => s.cells.get(`${r}:${c}`);
const same = (c: XCell | undefined, word: string) => cellText(c).toLowerCase() === word.toLowerCase();
const rowOf = (k: string) => Number(k.split(':')[0]);

/** Every "Day | Out | In | …" header in the sheets: the month blocks of the Tracker sheet, left to right. */
function findMonthBlocks(sheets: XSheet[]): { sheet: XSheet; row: number; col: number }[] {
  for (const sheet of sheets) {
    const found = [...sheet.cells.keys()]
      .map((k) => k.split(':').map(Number) as [number, number])
      .filter(([r, c]) => same(at(sheet, r, c), 'Day') && same(at(sheet, r, c + 1), 'Out') && same(at(sheet, r, c + 2), 'In'))
      .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (found.length) return found.map(([row, col]) => ({ sheet, row, col }));
  }
  return [];
}

/**
 * Reads the "Money tracker" workbook: each month block of the Tracker sheet becomes
 * entries in a calendar month, from `firstMonth` (YYYY-MM) on. Each filled Out or In
 * cell is one entry with its note; ones dated before `today` count as done, later
 * ones as planned. Day 31 of a shorter month lands on its last day. The Wishlist
 * sheet's columns are found by their header names.
 */
export function moneyFromWorkbook(sheets: XSheet[], firstMonth: string, today: string): Money {
  const entries: MoneyEntry[] = [];
  let opening = 0;
  findMonthBlocks(sheets).forEach(({ sheet, row, col }, i) => {
    const key = addMonths(firstMonth, i);
    if (i === 0) {
      // The first month's opening is a typed number; later ones are carried over by formula.
      for (let c = col; c <= col + 5; c++) {
        const cell = at(sheet, row - 1, c);
        if (cell && typeof cell.v === 'number' && !cell.formula) {
          opening = cents(cell.v);
          break;
        }
      }
    }
    for (let r = row + 1; r <= row + 40; r++) {
      const day = at(sheet, r, col);
      if (same(day, 'Total')) break;
      if (!day || typeof day.v !== 'number' || day.v < 1 || day.v > 31) continue;
      const date = `${key}-${pad2(Math.min(Math.round(day.v), daysIn(key)))}`;
      const add = (kind: 'in' | 'out', a: number | null, note: string) => {
        if (a) entries.push({ id: `e${entries.length + 1}`, date, kind, amount: Math.abs(a), note, category: '', planned: date >= today });
      };
      add('out', cellNum(at(sheet, r, col + 1)), cellText(at(sheet, r, col + 3)));
      add('in', cellNum(at(sheet, r, col + 2)), cellText(at(sheet, r, col + 4)));
    }
  });

  const wishlist: WishItem[] = [];
  for (const sheet of sheets) {
    const head = [...sheet.cells.entries()].find(([k, c]) => same(c, 'Name') && [...sheet.cells.entries()].some(([k2, c2]) => rowOf(k2) === rowOf(k) && same(c2, 'Price')));
    if (!head) continue;
    const headRow = rowOf(head[0]);
    const cols: Record<string, number> = {};
    for (const [k, c] of sheet.cells) {
      const name = cellText(c).toLowerCase();
      if (rowOf(k) === headRow && ['name', 'category', 'priority', 'status', 'price', 'notes'].includes(name) && !(name in cols)) cols[name] = Number(k.split(':')[1]);
    }
    const lastRow = Math.max(...[...sheet.cells.keys()].map(rowOf));
    const get = (r: number, name: string) => (name in cols ? at(sheet, r, cols[name]) : undefined);
    const pick = <T extends string>(options: T[], text: string) => options.find((o) => o.toLowerCase() === text.toLowerCase()) ?? '';
    for (let r = headRow + 1; r <= lastRow && wishlist.length < MAX_WISHES; r++) {
      // The old Notes column held the month an item was wanted by; that's a target now.
      const notesCell = get(r, 'notes');
      const target = cellMonth(notesCell);
      const item: WishItem = {
        id: `w${wishlist.length + 1}`,
        name: cellText(get(r, 'name')),
        category: cellText(get(r, 'category')),
        priority: pick(PRIORITIES, cellText(get(r, 'priority'))),
        status: pick(STATUSES, cellText(get(r, 'status'))),
        price: cellNum(get(r, 'price')),
        target,
        notes: target ? '' : cellText(notesCell),
      };
      if (item.name || item.category || item.price !== null || item.notes || item.target) wishlist.push(item);
    }
    break;
  }

  return cleanMoney({ start: `${firstMonth}-01`, opening, entries, wishlist });
}
