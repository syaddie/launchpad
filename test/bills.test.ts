import { describe, expect, it } from 'vitest';
import { addFinds, fromClaude, readBill, withoutDueDate, type BillMail, type FoundBill } from '../server/src/bills';
import { billEntry, billLine, emailTask, liveEmails } from '../web/src/inboxActions';
import { starterMoney } from '../shared/money';
import type { BillSuggestion, InboxEmail, InboxItem } from '../shared/types';

// Thu 12 Nov 2026, 10:00.
const now = new Date(2026, 10, 12, 10, 0);

const bm = (p: Partial<BillMail>): BillMail => ({
  id: 'm1', threadId: 't1', from: 'Someone', fromEmail: 'someone@example.com', subject: '', at: '2026-11-05T02:00:00.000Z', text: '', ...p,
});
const billOf = (m: BillMail) => {
  const r = readBill(m);
  return r.kind === 'bill' ? r.bill : r.kind;
};

describe('readBill', () => {
  it('reads an SP Group bill: amount payable and due date', () => {
    expect(billOf(bm({ from: 'SP Group', fromEmail: 'ebill@spgroup.com.sg', subject: 'Your SP Group bill for October 2026', text: 'Dear customer,\nYour bill is ready.\nTotal Amount Payable: $45.20\nPayment Due Date: 20 Nov 2026\n' }))).toMatchObject({
      payee: 'SP Group', amount: 45.2, currency: 'SGD', status: 'due', date: '2026-11-20', category: 'Bills', source: 'rules',
    });
  });
  it('takes a card statement’s amount due, not the minimum payment', () => {
    const b = billOf(bm({ from: 'DBS Cards', fromEmail: 'ibanking.alert@dbs.com', subject: 'Your DBS Credit Card eStatement is ready', text: 'Statement Date: 05 Nov 2026\nMinimum Payment Due: SGD 50.00\nTotal Amount Due: SGD 1,234.56\nPayment Due Date: 30 Nov 2026' }));
    expect(b).toMatchObject({ payee: 'DBS', amount: 1234.56, status: 'due', date: '2026-11-30' });
  });
  it('reads Grab receipts as rides or food', () => {
    expect(billOf(bm({ from: 'Grab', fromEmail: 'no-reply@grab.com', subject: 'Your Grab E-Receipt', text: 'Hope you enjoyed your ride!\nTotal Paid S$ 18.40\nPaid by Visa' }))).toMatchObject({
      payee: 'Grab', amount: 18.4, status: 'paid', date: '2026-11-05', category: 'Transport',
    });
    expect(billOf(bm({ from: 'Grab', fromEmail: 'no-reply@grab.com', subject: 'Your Grab E-Receipt', text: 'GrabFood order from Hawker Corner\nSubtotal S$ 20.00\nTotal S$ 23.10' }))).toMatchObject({ amount: 23.1, category: 'Food' });
  });
  it('keeps the currency', () => {
    expect(billOf(bm({ from: 'Netflix', fromEmail: 'info@account.netflix.com', subject: 'Your payment receipt', text: 'Amount paid: US$15.49 on 4 Nov' }))).toMatchObject({ payee: 'Netflix', amount: 15.49, currency: 'USD', category: 'Fun' });
  });
  it('reads a receipt from an unknown sender, with no category', () => {
    expect(billOf(bm({ from: 'Kopi Corner Pte Ltd', subject: 'Receipt for your order', text: 'Grand Total: $8.50' }))).toMatchObject({ payee: 'Kopi Corner', amount: 8.5, status: 'paid', category: '' });
  });
  it('skips codes, parcels, refunds and promotions', () => {
    expect(billOf(bm({ from: 'Shopee', fromEmail: 'info@mail.shopee.sg', subject: 'Your order has been shipped', text: 'Order total $35.00' }))).toBe('none');
    expect(billOf(bm({ from: 'DBS', fromEmail: 'alert@dbs.com', subject: 'OTP for your payment', text: 'Your OTP for $120.00 is 123456' }))).toBe('none');
    expect(billOf(bm({ from: 'Lazada', subject: 'Your refund of $12.00 is on its way', text: '' }))).toBe('none');
    expect(billOf(bm({ from: 'Some Shop', subject: 'New arrivals this week', text: 'From $9.90' }))).toBe('none');
  });
  it('leaves what it can’t read to Claude', () => {
    // A statement without an amount (log in to see it), and a bill without its due date.
    expect(billOf(bm({ from: 'UOB', fromEmail: 'unialerts@uobgroup.com', subject: 'Your eStatement is ready', text: 'Log in to view your statement.' }))).toBe('unsure');
    const noDue = bm({ from: 'Singtel', fromEmail: 'ebill@singtel.com', subject: 'Your Singtel bill', text: 'Amount due: $68.90' });
    expect(billOf(noDue)).toBe('unsure');
    // Without Claude it's kept anyway, dated the day it came.
    expect(withoutDueDate(noDue)).toMatchObject({ payee: 'Singtel', amount: 68.9, status: 'due', date: '2026-11-05', noDate: true });
  });
});

describe('bills from Claude', () => {
  const mails = [bm({ id: 'a' }), bm({ id: 'b', from: 'Town Council' })];
  it('keeps real bills and checks what came back', () => {
    const out = fromClaude(
      [
        { email: 0, kind: 'none', amount: 0, currency: 'SGD', payee: '', date: '', category: '' },
        { email: 1, kind: 'due', amount: 72.5, currency: 'sgd', payee: 'Tampines Town Council', date: 'soon', category: 'Bills' },
        { email: 7, kind: 'paid', amount: 5, currency: 'SGD', payee: 'x', date: '2026-11-01', category: '' },
      ],
      mails,
    );
    expect(out).toEqual([
      { id: 'b', threadId: 't1', subject: '', payee: 'Tampines Town Council', amount: 72.5, currency: 'SGD', status: 'due', date: '2026-11-05', noDate: true, category: 'Bills', source: 'claude' },
    ]);
  });
});

describe('bill suggestions', () => {
  const at = new Date('2026-11-12T02:00:00Z');
  const find = (p: Partial<FoundBill>): FoundBill => ({ id: 'e1', threadId: 't', subject: 's', payee: 'SP Group', amount: 45.2, currency: 'SGD', status: 'due', date: '2026-11-20', category: 'Bills', source: 'rules', ...p });
  it('never suggests the same email or the same bill twice', () => {
    const first = addFinds([], [], [find({})], at);
    expect(first.pending).toHaveLength(1);
    // Dismissed: gone from pending, but still seen.
    const again = addFinds([], [...first.seen, 'e1'], [find({}), find({ id: 'e2', date: '2026-11-21' }), find({ id: 'e3', amount: 50 })], at);
    expect(again.pending.map((b) => b.id)).toEqual(['e3']);
  });
  it('drops suggestions left waiting a month', () => {
    const old: BillSuggestion = { ...find({ id: 'old' }), foundAt: '2026-10-01T00:00:00.000Z' };
    expect(addFinds([old], [], [], at).pending).toEqual([]);
  });
});

describe('inbox actions', () => {
  const email = (p: Partial<InboxEmail>): InboxEmail => ({ id: 'a', threadId: 'ta', from: 'IRAS', fromEmail: 'x@iras.gov.sg', subject: 'Tax bill', snippet: '', at: '', unread: true, category: 'primary', ...p });
  const item: InboxItem = { kind: 'action', headline: 'Pay your property tax', summary: 'IRAS says $480 is due.', due: 'by Fri 13 Nov', emails: ['a', 'b'] };
  it('makes a task from a digest item: its deadline and links to the emails', () => {
    const t = emailTask({ item, emails: [email({}), email({ id: 'b', threadId: 'tb' })] }, 'me@gmail.com', now);
    expect(t.title).toBe('Pay your property tax');
    expect(t.due).toBe('2026-11-13');
    expect(t.notes).toContain('https://mail.google.com/mail/u/me%40gmail.com/#all/ta');
    expect(t.notes).toContain('#all/tb');
    expect(emailTask({ email: email({}) }, undefined, now)).toEqual({ title: 'Tax bill', due: null, notes: 'From IRAS\nhttps://mail.google.com/mail/u/0/#all/ta' });
  });
  it('leaves archived emails out of an item', () => {
    const byId = new Map([email({}), email({ id: 'b', archived: true })].map((e) => [e.id, e]));
    expect(liveEmails(item, byId).map((e) => e.id)).toEqual(['a']);
  });
  it('says what Keep adds, and adds it planned or done', () => {
    const due: BillSuggestion = { id: 'e1', threadId: 't', subject: '', payee: 'SP Group', amount: 45.2, currency: 'SGD', status: 'due', date: '2026-11-20', category: 'Bills', source: 'rules', foundAt: '' };
    expect(billLine(due)).toBe('Add $45.20 to Money: SP Group bill, due Fri 20 Nov, Bills');
    const paid: BillSuggestion = { ...due, payee: 'Netflix', currency: 'USD', amount: 15.49, status: 'paid', date: '2026-11-04', category: 'Fun' };
    expect(billLine(paid)).toBe('Add USD 15.49 to Money: Netflix, paid Wed 4 Nov, Fun');
    const money = starterMoney(now);
    expect(billEntry(due, money, 'x')).toEqual({ id: 'x', date: '2026-11-20', kind: 'out', amount: 45.2, note: 'SP Group bill', category: 'Bills', planned: true, account: money.accounts[0].id, to: '' });
    expect(billEntry(paid, money, 'y')).toMatchObject({ planned: false, note: 'Netflix (USD 15.49)' });
  });
});
