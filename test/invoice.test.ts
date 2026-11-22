import { describe, expect, it } from 'vitest';
import { cleanInvoiceDoc, cleanInvoiceSetup, docFor, docTotal, fmtInvDate, fmtInvMoney, invoiceFileName, MAX_LINES, rememberClient, starterSetup } from '../shared/invoice';
import { cleanMoney, starterAccounts, suggestInvoiceNum } from '../shared/money';
import type { Invoice, InvoiceDoc, Money } from '../shared/types';

const doc = (p: Partial<InvoiceDoc> = {}): InvoiceDoc => ({
  issued: '2026-11-16',
  client: { company: 'Ape Works Pte Ltd', attn: 'Mabel', address: '114 Lavender Street\nSingapore 338729', phone: '' },
  eventDate: '2026-11-12',
  venue: 'Ngee Ann Polytechnic',
  lines: [
    { desc: 'Solo acoustic performance', note: 'Guitar & vocals', qty: 1, rate: 250 },
    { desc: 'Sound system fee', note: '', qty: 1, rate: 80 },
    { desc: 'Discount', note: '', qty: 1, rate: -100 },
  ],
  from: { name: 'A Musician', address: '1 Somewhere Road', phone: '8000 0000', email: 'me@example.com' },
  pay: [{ label: 'PayNow', value: 'S0000000A', note: 'NRIC' }],
  terms: 'Within 30 days.',
  thanks: 'Thank you for your business!',
  ...p,
});
const money = (p: Partial<Money> = {}): Money => ({ start: '2026-11-01', accounts: starterAccounts(), entries: [], wishlist: [], invoices: [], subs: [], goals: [], ...p });

describe('invoice documents', () => {
  it('adds up rows, discounts and part quantities to the cent', () => {
    expect(docTotal(doc().lines)).toBe(230);
    expect(docTotal([{ qty: 1.5, rate: 33.33 }, { qty: 3, rate: 0.1 }])).toBe(50.3);
    expect(docTotal([])).toBe(0);
  });

  it('shows money and dates the way an invoice does', () => {
    expect(fmtInvMoney(1250)).toBe('$1,250.00');
    expect(fmtInvMoney(-100)).toBe('−$100.00');
    expect(fmtInvMoney(0)).toBe('$0.00');
    expect(fmtInvDate('2026-10-06')).toBe('06 Oct 2026');
    expect(fmtInvDate('')).toBe('');
  });

  it('names the PDF like the old ones: number, event, date', () => {
    expect(invoiceFileName('013', 'NP RED Camp 2026', '2026-11-12')).toBe('INV013_NPRedCamp_12112026');
    expect(invoiceFileName('010', "PA Cares @ President's Challenge", '2026-10-06')).toBe('INV010_PACaresPresidentsChallenge_06102026');
    expect(invoiceFileName('INV-036', '', '2026-01-02')).toBe('INV036_02012026');
    expect(invoiceFileName('', '', '')).toBe('Invoice');
  });

  it('makes a one-row document for an invoice added before the form', () => {
    const inv: Invoice = { id: 'i1', num: '009', event: 'Wedding', amount: 450, due: '2026-12-01' };
    const d = docFor(inv, { ...starterSetup(), terms: 'Pay me' }, '2026-11-23');
    expect(d.lines).toEqual([{ desc: 'Wedding', note: '', qty: 1, rate: 450 }]);
    expect(d).toMatchObject({ issued: '2026-11-23', terms: 'Pay me', eventDate: '' });
  });

  it('remembers clients latest first, one per company', () => {
    const a = { company: 'Ape Works', attn: 'Mabel', address: '', phone: '' };
    const b = { company: 'First Wave', attn: 'Lewin', address: '', phone: '' };
    const list = rememberClient(rememberClient([], a), b);
    expect(list.map((c) => c.company)).toEqual(['First Wave', 'Ape Works']);
    expect(rememberClient(list, { ...a, company: ' ape works ', attn: 'New' })).toEqual([{ ...a, company: 'ape works', attn: 'New' }, b]);
    expect(rememberClient(list, { ...a, company: '  ' })).toBe(list);
  });
});

describe('cleaning invoice documents and setup', () => {
  it('keeps a good document and drops empty rows', () => {
    const d = doc({ lines: [...doc().lines, { desc: '  ', note: 'x', qty: 2, rate: 0 }] });
    expect(cleanInvoiceDoc(d)).toEqual(doc());
  });

  it('refuses a document without a date or any rows, and caps rows', () => {
    expect(cleanInvoiceDoc(doc({ issued: '2026-02-30' }))).toBeUndefined();
    expect(cleanInvoiceDoc(doc({ lines: [] }))).toBeUndefined();
    expect(cleanInvoiceDoc('junk')).toBeUndefined();
    const many = doc({ lines: Array.from({ length: 50 }, (_, i) => ({ desc: `Row ${i}`, note: '', qty: 1, rate: 1 })) });
    expect(cleanInvoiceDoc(many)!.lines).toHaveLength(MAX_LINES);
  });

  it('fixes odd values instead of failing', () => {
    const d = cleanInvoiceDoc({ issued: '2026-11-16', eventDate: 'soon', lines: [{ desc: 'Set', qty: 'two', rate: Infinity }], pay: [{ label: '', value: '' }, 5], client: null })!;
    expect(d.lines).toEqual([{ desc: 'Set', note: '', qty: 1, rate: 0 }]);
    expect(d).toMatchObject({ eventDate: '', pay: [], client: { company: '', attn: '', address: '', phone: '' }, terms: '' });
  });

  it('cleans the setup, keeping the starter rows only when none were sent', () => {
    expect(cleanInvoiceSetup(undefined)).toBeUndefined();
    const s = cleanInvoiceSetup({ dueDays: 400, items: [{ id: 'a', desc: 'Transport', rate: 30 }, { id: 'a', desc: 'Again' }, { id: 'b', desc: '' }], clients: [{ company: 'X' }, { company: 'x', attn: 'older' }], lastNum: '014' })!;
    expect(s.dueDays).toBe(30);
    expect(s.items).toEqual([{ id: 'a', desc: 'Transport', note: '', rate: 30 }]);
    expect(s.clients).toEqual([{ company: 'X', attn: '', address: '', phone: '' }]);
    expect(s).toMatchObject({ lastNum: '014', terms: starterSetup().terms, thanks: starterSetup().thanks });
    expect(cleanInvoiceSetup({ terms: '', thanks: '' })).toMatchObject({ terms: '', thanks: '' });
  });
});

describe('invoices with documents in Money', () => {
  it('works out an invoice’s amount from its rows, and its money follows', () => {
    const m = cleanMoney(money({ invoices: [{ id: 'i1', num: '013', event: 'NP RED Camp 2026', amount: 999, due: '2026-12-16', doc: doc() }] }));
    expect(m.invoices[0].amount).toBe(230);
    expect(m.invoices[0].doc).toEqual(doc());
    expect(m.entries.find((e) => e.invoice === 'i1')).toMatchObject({ amount: 230, date: '2026-12-16', kind: 'in', planned: true });
  });

  it('drops a document whose rows come to nothing, keeping the invoice', () => {
    const m = cleanMoney(money({ invoices: [{ id: 'i1', num: '013', event: '', amount: 50, due: '2026-12-16', doc: doc({ lines: [{ desc: 'Discount', note: '', qty: 1, rate: -10 }] }) }] }));
    expect(m.invoices).toEqual([{ id: 'i1', num: '013', event: '', amount: 50, due: '2026-12-16' }]);
  });

  it('keeps the setup through cleaning', () => {
    const setup = { ...starterSetup(), lastNum: '020' };
    expect(cleanMoney(money({ invoiceSetup: setup })).invoiceSetup).toEqual(setup);
    expect(cleanMoney(money()).invoiceSetup).toBeUndefined();
  });

  it('suggests the number after the highest in Owed or the last one made', () => {
    const inv = (num: string): Invoice => ({ id: num, num, event: '', amount: 1, due: '2026-12-01' });
    expect(suggestInvoiceNum(money({ invoices: [inv('012'), inv('013')] }))).toBe('014');
    expect(suggestInvoiceNum(money({ invoices: [inv('012')], invoiceSetup: { ...starterSetup(), lastNum: '015' } }))).toBe('016');
    expect(suggestInvoiceNum(money({ invoices: [inv('012')], invoiceSetup: { ...starterSetup(), lastNum: '010' } }))).toBe('013');
    expect(suggestInvoiceNum(money())).toBe('INV-001');
  });
});
