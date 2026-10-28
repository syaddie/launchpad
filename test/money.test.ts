import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  affordableFrom, balanceOn, byCategory, calcMonths, calcTotals, cleanMoney, fmtMoney, lowestAhead, monthKeys, moneyFromWorkbook, parseMoney, repeatDates, toReview, wishStats,
} from '../shared/money';
import type { Money, MoneyEntry } from '../shared/types';
import { readXlsx } from '../shared/xlsx';

let seq = 0;
const e = (date: string, kind: 'in' | 'out', amount: number, planned = false, category: MoneyEntry['category'] = ''): MoneyEntry => ({ id: `e${seq++}`, date, kind, amount, note: '', category, planned });
const money = (): Money => ({
  start: '2026-10-01',
  opening: 100,
  entries: [e('2026-10-01', 'out', 150, false, 'Food'), e('2026-10-10', 'in', 200), e('2026-10-27', 'out', 30, true), e('2026-11-05', 'out', 0.1, true), e('2026-11-05', 'in', 0.2, true)],
  wishlist: [],
});

describe('money formulas', () => {
  it('shows every month from the start to this month or the last entry', () => {
    expect(monthKeys(money(), '2026-10-28')).toEqual(['2026-10', '2026-11']);
    expect(monthKeys({ ...money(), entries: [] }, '2027-01-03')).toEqual(['2026-10', '2026-11', '2026-12', '2027-01']);
  });
  it('runs the balance day by day over real month lengths and carries it into the next month', () => {
    const [oct, nov] = calcMonths(money(), ['2026-10', '2026-11']);
    expect(oct.balances).toHaveLength(31);
    expect(nov.balances).toHaveLength(30);
    expect(oct.balances[0]).toBe(-50);
    expect(oct.balances[9]).toBe(150);
    expect(oct).toMatchObject({ opening: 100, totalIn: 200, totalOut: 180, net: 20, closing: 120, lowest: -50, daysBelow: 9, plannedOut: 30, plannedIn: 0 });
    expect(nov).toMatchObject({ opening: 120, closing: 120.1, plannedIn: 0.2 });
    expect(calcTotals(money(), [oct, nov])).toMatchObject({ opening: 100, totalIn: 200.2, totalOut: 180.1, closing: 120.1, lowest: -50, daysBelow: 9 });
  });
  it('tells what happened apart from the plan', () => {
    expect(balanceOn(money(), '2026-10-28', true)).toBe(150);
    expect(balanceOn(money(), '2026-10-28')).toBe(120);
    expect(toReview(money(), '2026-10-28').map((x) => x.date)).toEqual(['2026-10-27']);
  });
  it('finds the lowest balance ahead and when a price fits', () => {
    const months = calcMonths(money(), ['2026-10', '2026-11']);
    expect(lowestAhead(months, '2026-10-28')).toEqual({ balance: 120, date: '2026-10-28' });
    expect(affordableFrom(100, months, '2026-10-28')).toBe('2026-10-28');
    expect(affordableFrom(120.05, months, '2026-10-28')).toBe('2026-11-05');
    expect(affordableFrom(500, months, '2026-10-28')).toBeNull();
  });
  it('repeats an entry weekly, fortnightly or monthly up to a month', () => {
    expect(repeatDates('2026-10-04', 'week', '2026-10')).toEqual(['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']);
    expect(repeatDates('2026-10-28', 'fortnight', '2026-11')).toEqual(['2026-10-28', '2026-11-11', '2026-11-25']);
    expect(repeatDates('2026-10-31', 'month', '2027-01')).toEqual(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-31']);
    expect(repeatDates('2026-10-31', 'once', '2027-01')).toEqual(['2026-10-31']);
  });
  it('totals spending by category', () => {
    expect(byCategory(money().entries)).toEqual([{ category: 'Food', amount: 150 }, { category: 'Not set', amount: 30.1 }]);
  });
  it('leaves bought and dropped things out of still to buy', () => {
    const w = (status: string, price: number) => ({ id: status, name: status, category: '', priority: '' as const, status: status as never, price, target: '', notes: '' });
    expect(wishStats([w('Wanted', 100), w('Purchased', 40), w('Dropped', 10)])).toEqual({ items: 3, total: 150, purchased: 40, stillToBuy: 100 });
  });
});

describe('amounts', () => {
  it('reads what people type', () => {
    expect(parseMoney('$1,200')).toBe(1200);
    expect(parseMoney(' 45.5 ')).toBe(45.5);
    expect(parseMoney('−20')).toBe(-20);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('12abc')).toBeUndefined();
  });
  it('shows cents only when there are some', () => {
    expect(fmtMoney(1200)).toBe('$1,200');
    expect(fmtMoney(-35)).toBe('−$35');
    expect(fmtMoney(12.5)).toBe('$12.50');
    expect(fmtMoney(700, true)).toBe('+$700');
  });
  it('cleans what the page sends', () => {
    const m = cleanMoney(
      {
        opening: 'x',
        entries: [
          { id: 'b', date: '2026-10-05', kind: 'out', amount: -20, category: 'Snacks' },
          { id: 'a', date: '2026-10-02', kind: 'out', amount: 10, planned: false },
          { id: 'c', date: '2026-02-30', kind: 'in', amount: 5 },
        ],
        wishlist: [{ id: 'w', name: 'Cam', priority: 'Urgent', status: 'Wanted', price: 9, target: '2026-13' }],
      },
      new Date(2026, 9, 28),
    );
    expect(m.start).toBe('2026-10-01');
    expect(m.opening).toBe(0);
    expect(m.entries).toEqual([
      { id: 'a', date: '2026-10-02', kind: 'out', amount: 10, note: '', category: '', planned: false },
      { id: 'b', date: '2026-10-05', kind: 'in', amount: 20, note: '', category: '', planned: true },
    ]);
    expect(m.wishlist[0]).toMatchObject({ priority: '', status: 'Wanted', price: 9, target: '' });
  });
});

/** A minimal .xlsx: just the parts readXlsx looks at, deflated like Excel does. */
function zip(files: Record<string, string>): ArrayBuffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(8, 8);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  const all = Buffer.concat([...local, cd, end]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}

const row = (r: number, cells: string) => `<row r="${r}">${cells}</row>`;
const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
const n = (ref: string, v: number) => `<c r="${ref}"><v>${v}</v></c>`;
const sheet = (rows: string) => `<worksheet><sheetData>${rows}</sheetData></worksheet>`;

describe('importing the workbook', () => {
  it('finds the month blocks and the wishlist by their headers', async () => {
    const strings = ['Month 1', 'Opening balance', 'Day', 'Out', 'In', 'Out note', 'In note', 'Balance', 'Total', 'Name', 'Price', 'Status', 'Notes', 'Korea &amp; Japan', 'saving up', 'weekly', '=AI("x")', 'Category'];
    const xlsx = zip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Tracker" sheetId="1" r:id="rId1"/><sheet name="Wishlist" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
      'xl/styles.xml': '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="mmm-yy"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
      'xl/worksheets/sheet1.xml': sheet(
        row(4, s('A4', 0)) +
        row(5, s('A5', 1) + n('F5', 250)) +
        row(6, ['A', 'B', 'C', 'D', 'E', 'F'].map((c, i) => s(`${c}6`, 2 + i)).join('')) +
        row(7, n('A7', 1) + n('B7', 60) + s('D7', 15) + '<c r="F7"><f>$F$5-B7</f><v>190</v></c>') +
        row(8, n('A8', 2) + n('C8', 1200)) +
        row(9, s('A9', 8) + n('B9', 60)),
      ),
      'xl/worksheets/sheet2.xml': sheet(
        row(8, s('B8', 9) + s('C8', 17) + s('D8', 11) + s('E8', 10) + s('F8', 12)) +
        row(9, s('B9', 13) + s('C9', 16) + s('D9', 14) + n('E9', 3000) + '<c r="F9" s="1"><v>46357</v></c>') +
        row(10, '<c r="B10" s="0"/>'),
      ),
    });
    const m = moneyFromWorkbook(await readXlsx(xlsx), '2026-10', '2026-10-02');
    expect(m).toMatchObject({ start: '2026-10-01', opening: 250 });
    expect(m.entries.map(({ date, kind, amount, note, planned }) => ({ date, kind, amount, note, planned }))).toEqual([
      { date: '2026-10-01', kind: 'out', amount: 60, note: 'weekly', planned: false },
      { date: '2026-10-02', kind: 'in', amount: 1200, note: '', planned: true },
    ]);
    expect(m.wishlist).toEqual([{ id: 'w1', name: 'Korea & Japan', category: '', priority: '', status: 'Saving up', price: 3000, target: '2026-12', notes: '' }]);
  });
  it('says so when the file isn’t a workbook', async () => {
    await expect(readXlsx(new TextEncoder().encode('hello').buffer as ArrayBuffer)).rejects.toThrow(/isn’t an Excel/);
  });
});
