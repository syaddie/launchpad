// The money tracker: the formulas from the "Money tracker" workbook (Summary,
// Tracker and Wishlist sheets), cleaning for what the page sends, and reading
// the workbook itself when it's imported. Only typed-in values are stored;
// everything here is worked out from them.
import type { Money, MoneyDay, MoneyMonth, WishItem, WishPriority, WishStatus } from './types';
import type { XCell, XSheet } from './xlsx';

export const MONEY_DAYS = 31;
export const MAX_MONTHS = 36;
export const MAX_WISHES = 200;
export const PRIORITIES: Exclude<WishPriority, ''>[] = ['High', 'Medium', 'Low'];
export const STATUSES: Exclude<WishStatus, ''>[] = ['Wanted', 'Saving up', 'Purchased', 'Dropped'];

export const blankDay = (): MoneyDay => ({ out: null, in: null, outNote: '', inNote: '' });
export const blankMonth = (id: string, name: string): MoneyMonth => ({ id, name, days: Array.from({ length: MONEY_DAYS }, blankDay) });

export const STARTER_MONEY: Money = {
  opening: 0,
  months: [1, 2, 3].map((n) => blankMonth('m' + n, `Month ${n}`)),
  wishlist: [],
};

/** Cents, so 0.1 + 0.2 shows as $0.30 and not a long tail. */
const cents = (n: number) => Math.round(n * 100) / 100;

// ---------- formulas ----------

export interface MonthCalc {
  opening: number;
  /** Running balance after each day: opening + money in so far − money out so far. */
  balances: number[];
  totalIn: number;
  totalOut: number;
  net: number;
  closing: number;
  lowest: number;
  daysBelow: number;
}

/** Each month's numbers; a month opens with the previous month's closing balance. */
export function calcMonths(money: Money): MonthCalc[] {
  let opening = money.opening;
  return money.months.map((m) => {
    let totalIn = 0;
    let totalOut = 0;
    const balances = m.days.map((d) => {
      totalIn += d.in ?? 0;
      totalOut += d.out ?? 0;
      return cents(opening + totalIn - totalOut);
    });
    const closing = balances.length ? balances[balances.length - 1] : opening;
    const calc: MonthCalc = {
      opening,
      balances,
      totalIn: cents(totalIn),
      totalOut: cents(totalOut),
      net: cents(totalIn - totalOut),
      closing,
      lowest: balances.length ? Math.min(...balances) : opening,
      daysBelow: balances.filter((b) => b < 0).length,
    };
    opening = closing;
    return calc;
  });
}

/** The "All months" row of the Summary sheet. */
export function calcTotals(money: Money, months = calcMonths(money)): Omit<MonthCalc, 'balances'> {
  const totalIn = cents(months.reduce((a, m) => a + m.totalIn, 0));
  const totalOut = cents(months.reduce((a, m) => a + m.totalOut, 0));
  return {
    opening: money.opening,
    totalIn,
    totalOut,
    net: cents(totalIn - totalOut),
    closing: months.length ? months[months.length - 1].closing : money.opening,
    lowest: months.length ? Math.min(...months.map((m) => m.lowest)) : money.opening,
    daysBelow: months.reduce((a, m) => a + m.daysBelow, 0),
  };
}

export const isDone = (w: WishItem) => w.status === 'Purchased' || w.status === 'Dropped';

/** The Wishlist sheet's totals. "Still to buy" leaves out what's bought and what's dropped. */
export function wishStats(list: WishItem[]) {
  const sum = (items: WishItem[]) => cents(items.reduce((a, w) => a + (w.price ?? 0), 0));
  const total = sum(list);
  const purchased = sum(list.filter((w) => w.status === 'Purchased'));
  const dropped = sum(list.filter((w) => w.status === 'Dropped'));
  return { items: list.filter((w) => w.name.trim()).length, total, purchased, stillToBuy: cents(total - purchased - dropped) };
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

function ids<T extends { id: string }>(list: T[], prefix: string): T[] {
  const seen = new Set<string>();
  return list.map((x, i) => {
    const id = x.id && !seen.has(x.id) ? x.id : `${prefix}${i}-${Date.now().toString(36)}`;
    seen.add(id);
    return { ...x, id };
  });
}

/** Coerces anything into a valid Money: 31 days a month, known priorities and statuses, sane lengths. */
export function cleanMoney(v: unknown): Money {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<Money>;
  const months = (Array.isArray(m.months) ? m.months : []).slice(0, MAX_MONTHS).map((x: Partial<MoneyMonth>, i): MoneyMonth => {
    const days = Array.isArray(x?.days) ? x.days : [];
    return {
      id: str(x?.id, 40),
      name: str(x?.name, 40) || `Month ${i + 1}`,
      days: Array.from({ length: MONEY_DAYS }, (_, d): MoneyDay => {
        const day = (days[d] ?? {}) as Partial<MoneyDay>;
        return { out: amount(day.out), in: amount(day.in), outNote: str(day.outNote, 120), inNote: str(day.inNote, 120) };
      }),
    };
  });
  const wishlist = (Array.isArray(m.wishlist) ? m.wishlist : []).slice(0, MAX_WISHES).map((x: Partial<WishItem>): WishItem => ({
    id: str(x?.id, 40),
    name: str(x?.name, 80),
    category: str(x?.category, 40),
    priority: PRIORITIES.includes(x?.priority as never) ? x!.priority! : '',
    status: STATUSES.includes(x?.status as never) ? x!.status! : '',
    price: amount(x?.price),
    notes: str(x?.notes, 200),
  }));
  return { opening: amount(m.opening) ?? 0, months: ids(months, 'm'), wishlist: ids(wishlist, 'w') };
}

// ---------- importing the workbook ----------

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function cellText(c: XCell | undefined): string {
  if (!c || c.v === null) return '';
  if (typeof c.v === 'number' && c.date) {
    // Excel's day 0 is 30 Dec 1899; 25569 is 1 Jan 1970.
    const d = new Date(Math.round((c.v - 25569) * 86_400_000));
    return `${MON3[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  const s = String(c.v).trim();
  // Google Sheets keeps formulas it can't export (like =AI(…)) as their own text.
  return s.startsWith('=') ? '' : s;
}

const cellNum = (c: XCell | undefined) => (c && typeof c.v === 'number' ? cents(c.v) : null);
const at = (s: XSheet, r: number, c: number) => s.cells.get(`${r}:${c}`);
const same = (c: XCell | undefined, word: string) => cellText(c).toLowerCase() === word.toLowerCase();

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
 * Reads the Tracker and Wishlist sheets of the Money tracker workbook. Each month
 * block is found by its "Day / Out / In / Out note / In note / Balance" header, with
 * its name two rows up and the opening balance on the row between. Wishlist columns
 * are found by their header names, so moved or extra columns don't matter.
 */
export function moneyFromWorkbook(sheets: XSheet[]): Money {
  const blocks = findMonthBlocks(sheets);
  let opening = 0;
  const months = blocks.map(({ sheet, row, col }, i): MoneyMonth => {
    const month = blankMonth(`m${i + 1}`, cellText(at(sheet, row - 2, col)) || `Month ${i + 1}`);
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
      if (!day || typeof day.v !== 'number' || day.v < 1 || day.v > MONEY_DAYS) continue;
      month.days[Math.round(day.v) - 1] = {
        out: cellNum(at(sheet, r, col + 1)),
        in: cellNum(at(sheet, r, col + 2)),
        outNote: cellText(at(sheet, r, col + 3)),
        inNote: cellText(at(sheet, r, col + 4)),
      };
    }
    return month;
  });

  const wishlist: WishItem[] = [];
  for (const sheet of sheets) {
    const head = [...sheet.cells.entries()].find(([k, c]) => {
      const [r] = k.split(':').map(Number);
      return same(c, 'Name') && [...sheet.cells.entries()].some(([k2, c2]) => Number(k2.split(':')[0]) === r && same(c2, 'Price'));
    });
    if (!head) continue;
    const headRow = Number(head[0].split(':')[0]);
    const cols: Record<string, number> = {};
    for (const [k, c] of sheet.cells) {
      const [r, col] = k.split(':').map(Number);
      const name = cellText(c).toLowerCase();
      if (r === headRow && ['name', 'category', 'priority', 'status', 'price', 'notes'].includes(name) && !(name in cols)) cols[name] = col;
    }
    const lastRow = Math.max(...[...sheet.cells.keys()].map((k) => Number(k.split(':')[0])));
    const get = (r: number, name: string) => (name in cols ? at(sheet, r, cols[name]) : undefined);
    const pick = <T extends string>(options: T[], text: string) => options.find((o) => o.toLowerCase() === text.toLowerCase()) ?? '';
    for (let r = headRow + 1; r <= lastRow && wishlist.length < MAX_WISHES; r++) {
      const item: WishItem = {
        id: `w${wishlist.length + 1}`,
        name: cellText(get(r, 'name')),
        category: cellText(get(r, 'category')),
        priority: pick(PRIORITIES, cellText(get(r, 'priority'))),
        status: pick(STATUSES, cellText(get(r, 'status'))),
        price: cellNum(get(r, 'price')),
        notes: cellText(get(r, 'notes')),
      };
      if (item.name || item.category || item.price !== null || item.notes) wishlist.push(item);
    }
    break;
  }

  return cleanMoney({ opening, months: months.length ? months : STARTER_MONEY.months, wishlist });
}
