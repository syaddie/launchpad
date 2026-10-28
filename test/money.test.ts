import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { STARTER_MONEY, calcMonths, calcTotals, cleanMoney, fmtMoney, moneyFromWorkbook, parseMoney, wishStats } from '../shared/money';
import type { Money } from '../shared/types';
import { readXlsx } from '../shared/xlsx';

const money = (): Money => {
  const m = cleanMoney(STARTER_MONEY);
  m.opening = 100;
  m.months[0].days[0] = { out: 150, in: null, outNote: 'rent', inNote: '' };
  m.months[0].days[9] = { out: null, in: 200, outNote: '', inNote: 'pay' };
  m.months[1].days[4] = { out: 0.1, in: 0.2, outNote: '', inNote: '' };
  return m;
};

describe('money formulas', () => {
  it('runs the balance day by day and carries each closing into the next month', () => {
    const [a, b, c] = calcMonths(money());
    expect(a.balances[0]).toBe(-50);
    expect(a.balances[9]).toBe(150);
    expect(a).toMatchObject({ opening: 100, totalIn: 200, totalOut: 150, net: 50, closing: 150, lowest: -50, daysBelow: 9 });
    expect(b.opening).toBe(150);
    expect(b.closing).toBe(150.1);
    expect(c.opening).toBe(150.1);
  });
  it('rolls every month up like the Summary sheet', () => {
    expect(calcTotals(money())).toMatchObject({ opening: 100, totalIn: 200.2, totalOut: 150.1, net: 50.1, closing: 150.1, lowest: -50, daysBelow: 9 });
  });
  it('leaves bought and dropped things out of still to buy', () => {
    const w = (status: string, price: number) => ({ id: status, name: status, category: '', priority: '' as const, status: status as never, price, notes: '' });
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
    const m = cleanMoney({ opening: 'x', months: [{ id: 'a', name: '', days: [{ out: 'no', in: 5 }] }], wishlist: [{ id: 'w', name: 'Cam', priority: 'Urgent', status: 'Wanted', price: 9 }] });
    expect(m.opening).toBe(0);
    expect(m.months[0].name).toBe('Month 1');
    expect(m.months[0].days).toHaveLength(31);
    expect(m.months[0].days[0]).toEqual({ out: null, in: 5, outNote: '', inNote: '' });
    expect(m.wishlist[0]).toMatchObject({ priority: '', status: 'Wanted', price: 9, notes: '' });
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
    const m = moneyFromWorkbook(await readXlsx(xlsx));
    expect(m.opening).toBe(250);
    expect(m.months.map((x) => x.name)).toEqual(['Month 1']);
    expect(m.months[0].days[0]).toEqual({ out: 60, in: null, outNote: 'weekly', inNote: '' });
    expect(m.months[0].days[1].in).toBe(1200);
    expect(m.wishlist).toEqual([{ id: 'w1', name: 'Korea & Japan', category: '', priority: '', status: 'Saving up', price: 3000, notes: 'Dec 2026' }]);
  });
  it('says so when the file isn’t a workbook', async () => {
    await expect(readXlsx(new TextEncoder().encode('hello').buffer as ArrayBuffer)).rejects.toThrow(/isn’t an Excel/);
  });
});
