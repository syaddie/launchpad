import { describe, expect, it } from 'vitest';
import { accountBalance, cleanMoney, newAccount, starterAccounts } from '../shared/money';
import {
  applyReview, asMove, bankAmount, patchAlike, bankDate, csvRows, describe as what, merchantOf, merchantsToAsk, parseStatement, reviewStatement, spentOn, splitTip, titleCase, type Review,
} from '../shared/statement';
import type { BuskSession, CalEvent, Money, MoneyEntry, NacSlots, StatementContext } from '../shared/types';
import { cleanAsk, emailsFrom, nacSessions, namesFrom, oneADay, sessionOf } from '../server/src/statement';

// The shape of POSB's export: a few lines about the account, a blank line, the header, newest first.
const HEAD = `Account Details For:,ePOSBkids Account 111-22222-3,,,,,,,
Statement as at:,22-Nov-26,,,,,,,
,,,,,,,,
Available Balance:,SGD 53.3,,,,,,,
Ledger Balance:,SGD 148.85,,,,,,,
,,,,,,,,
Transaction Date,Transaction Code,Description,Transaction Ref1,Transaction Ref2,Transaction Ref3,Status,Debit Amount,Credit Amount
`;
const tip = (date: string, ref: string, name: string, memo: string, amount: number) =>
  `${date},ICT,Incoming PayNow Ref ${ref} From: ${name} OTHR ${memo},Incoming PayNow Ref ${ref},From: ${name},OTHR ${memo},Settled,,${amount}`;
const LINES = [
  '22-Nov-26,ICT,Trus:0192555068:I-BANK Transfer OTHR 1795,Trus:0192555068:I-BANK,Transfer,OTHR 1795,Settled,150,',
  '22-Nov-26,IDT,GRABPAY TOPUP ALEX TAN B334 UBIL,GRABPAY TOPUP ALEX TAN,B334,UBIL,Settled,20,',
  '21-Nov-26,MST,GIANT-BEDOK MKT PL Si SGP 18NOV 4628-4500-7445-7657 0000035,GIANT-BEDOK MKT PL     Si SGP 18NOV,4628-4500-7445-7657,35,Settled,4.6,',
  '21-Nov-26,MST,BUS/MRT 969498440 SI SGP 16NOV 4628 0000036,BUS/MRT 969498440      SI SGP 16NOV,4628,36,Settled,1.94,',
  tip('21-Nov-26', '1', 'KOH LIN YIN', 'From Koh', 8),
  tip('21-Nov-26', '2', 'ANG ZHEN KAI', 'PayNow transfer', 2),
  tip('21-Nov-26', '3', 'SAHRIAH BTE MOHD', 'Busker', 5),
  '21-Nov-26,ICT,"Incoming PayNow Ref 4 From: NEO SHI HAN, YVONNE(LIANG SHI OTHR Send back 96475010",Incoming PayNow Ref 4,"From: NEO SHI HAN, YVONNE(LIANG SHI",OTHR Send back 96475010,Settled,,10',
  tip('14-Nov-26', '5', 'A ONE', 'PayNow Transfer', 2),
  tip('14-Nov-26', '6', 'B TWO', 'PayNow Transfer', 3),
  tip('14-Nov-26', '7', 'C THREE', 'PayNow Transfer', 1),
  tip('14-Nov-26', '8', 'D FOUR', 'PayNow Transfer', 5),
  tip('14-Nov-26', '9', 'E FIVE', 'PayNow Transfer', 4),
  tip('10-Nov-26', '10', 'LONE FRIEND', 'dinner', 12),
  '11-Nov-26,POS,"74457657,OLD CHANG KEE NETS CONTACTLESS 20261109101956000","74457657,OLD CHANG KEE",NETS CONTACTLESS,2.02611E+16,Settled,8.2,',
  '24-Sept-26,SAL,GE AVIATION ENGINE SERVICES SINGAPO PA01 2609,GE AVIATION ENGINE SERVICES SINGAPO,PA01,2609,Settled,,1200',
  '29-Oct-26,AWL,"74457657,CITY SQ MALL 2  ","74457657,CITY SQ MALL 2",,,Settled,40,',
  '13-Oct-26,ITR,FT2610 IB:SITI NORMALIS BINTE MOHAMED ISMA ,FT2610,IB:SITI NORMALIS BINTE MOHAMED ISMA,,Settled,,100',
  '24-Aug-26,MST,APPLE.COM/BILL ITUNES.COM IRL 23AUG 4628 0001,APPLE.COM/BILL ITUNES.COM IRL 23AUG,4628,1,Settled,12.98,',
  '20-Aug-26,IDT,GRABPAY TOPUP ALEX TAN C1 UBIL,GRABPAY TOPUP ALEX TAN,C1,UBIL,Pending,9,',
];
const CSV = HEAD + LINES.join('\r\n') + '\r\n';

let seq = 0;
const ent = (p: Partial<MoneyEntry>): MoneyEntry => ({ id: `x${seq++}`, date: '2026-11-01', kind: 'out', amount: 1, note: '', category: '', planned: false, account: 'posb', to: '', ...p });
const tracker = (p: Partial<Money> = {}): Money => ({ start: '2026-08-01', accounts: starterAccounts(500), entries: [], wishlist: [], invoices: [], subs: [], goals: [], ...p });
const NONE: StatementContext = { sessions: [], emails: [], names: {}, notes: [] };
const ids = () => {
  let n = 0;
  return () => `new${n++}`;
};
const find = (r: Review, note: RegExp) => r.proposals.find((p) => note.test(p.entry.note));

describe('reading the CSV', () => {
  it('reads quoted cells with commas and doubled quotes, and CRLF lines', () => {
    expect(csvRows('a,"b, c","say ""hi"""\r\nd,,\n')).toEqual([['a', 'b, c', 'say "hi"'], ['d', '', '']]);
  });
  it('reads the bank’s dates, Sept included, and amounts with SGD and commas', () => {
    expect(bankDate('22-Nov-26')).toBe('2026-11-22');
    expect(bankDate('24-Sept-26')).toBe('2026-09-24');
    expect(bankDate('1 Aug 2026')).toBe('2026-08-01');
    expect(bankDate('31-Feb-26')).toBe('');
    expect(bankAmount('SGD 1,234.5')).toBe(1234.5);
    expect(bankAmount('')).toBeNull();
  });
  it('reads the account, the balances and the settled lines, oldest first', () => {
    const st = parseStatement(CSV);
    expect(st.account).toBe('ePOSBkids Account 111-22222-3');
    expect(st.asOf).toBe('2026-11-22');
    expect([st.ledger, st.available]).toEqual([148.85, 53.3]);
    expect(st.unsettled).toBe(1);
    expect(st.lines).toHaveLength(LINES.length - 1);
    expect(st.lines[0].posted).toBe('2026-08-24');
    expect(st.lines.find((l) => l.code === 'SAL')).toMatchObject({ dir: 'in', amount: 1200 });
  });
  it('gives each line a key that’s the same in every export, and two identical lines different ones', () => {
    const a = parseStatement(CSV).lines.map((l) => l.key);
    const b = parseStatement(HEAD + [...LINES].reverse().join('\n')).lines.map((l) => l.key);
    expect(new Set(a)).toEqual(new Set(b));
    const twice = parseStatement(HEAD + [LINES[1], LINES[1]].join('\n')).lines.map((l) => l.key);
    expect(twice[0]).not.toBe(twice[1]);
  });
  it('says what’s wrong with a file that isn’t a statement', () => {
    expect(() => parseStatement('Date,Amount\n2026-01-01,5')).toThrow(/Transaction Date/);
    expect(() => parseStatement(HEAD)).toThrow(/no transactions/);
  });
  it('dates card payments on the day they happened, within two weeks of booking', () => {
    expect(spentOn('2026-11-21', 'GIANT Si SGP 18NOV', '')).toBe('2026-11-18');
    expect(spentOn('2027-01-03', 'SHOP SGP 30DEC', '')).toBe('2026-12-30');
    expect(spentOn('2026-11-11', '', 'OLD CHANG KEE NETS CONTACTLESS 20261109101956000')).toBe('2026-11-09');
    expect(spentOn('2026-11-21', 'SHOP SGP 18OCT', '')).toBe('2026-11-21');
  });
  it('finds the shop and country in a card payment', () => {
    expect(merchantOf('GIANT-BEDOK MKT PL     Si SGP 18NOV')).toEqual({ merchant: 'GIANT-BEDOK MKT PL', country: 'SGP' });
    expect(merchantOf('WWW.TADA.G* N01A1DB29A SI SGP 14NOV')).toEqual({ merchant: 'WWW.TADA.G*', country: 'SGP' });
    expect(merchantOf('XFT GRAND BATAM KO IDN 08NOV')).toEqual({ merchant: 'XFT GRAND BATAM KO', country: 'IDN' });
    expect(merchantOf('74457657,OLD CHANG KEE').merchant).toBe('OLD CHANG KEE');
    expect(titleCase('NEO SHI HAN, YVONNE(LIANG SHI')).toBe('Neo Shi Han, Yvonne');
  });
});

describe('what each line is', () => {
  const st = parseStatement(CSV);
  const line = (re: RegExp) => st.lines.find((l) => re.test(l.text))!;
  it('makes a transfer to your Trust Bank account a move, and money out when there’s no such account', () => {
    expect(what(line(/^Trus/), tracker(), 'posb')).toMatchObject({ kind: 'move', other: 'trust', note: 'To Trust Bank' });
    const noTrust = tracker({ accounts: starterAccounts(0).filter((a) => a.id !== 'trust') });
    expect(what(line(/^Trus/), noTrust, 'posb')).toMatchObject({ kind: 'out', note: 'Transfer to Trus…' });
  });
  it('makes a GrabPay top-up a move into a Grab account when there is one', () => {
    expect(what(line(/GRABPAY/), tracker(), 'posb')).toMatchObject({ kind: 'out', note: 'GrabPay top-up', merchant: 'GRABPAY TOPUP' });
    const grab = tracker({ accounts: [...starterAccounts(0), newAccount('grab', 'GrabPay', 'cash')] });
    expect(what(line(/GRABPAY/), grab, 'posb')).toMatchObject({ kind: 'move', other: 'grab' });
  });
  it('reads card payments, salary, the ATM, and transfers from people', () => {
    expect(what(line(/GIANT/), tracker(), 'posb')).toMatchObject({ note: 'Giant-Bedok Mkt Pl', category: 'Food', merchant: 'GIANT-BEDOK MKT PL' });
    expect(what(line(/BUS\/MRT/), tracker(), 'posb').category).toBe('Transport');
    expect(what(line(/GE AVIATION/), tracker(), 'posb')).toMatchObject({ category: 'Pay', note: 'Salary · Ge Aviation Engine Services Singapo' });
    expect(what(line(/CITY SQ/), tracker(), 'posb')).toMatchObject({ kind: 'move', other: 'cash' });
    expect(what(line(/SITI/), tracker(), 'posb')).toMatchObject({ kind: 'in', person: 'Siti Normalis Binte Mohamed Isma', merchant: '' });
    expect(what(line(/Send back/), tracker(), 'posb')).toMatchObject({ paynowIn: true, memo: 'Send back 96475010', person: 'Neo Shi Han, Yvonne' });
  });
});

describe('the review', () => {
  it('groups a session’s tips into one entry, and leaves out PayNows that aren’t tips', () => {
    const st = parseStatement(CSV);
    const r = reviewStatement(st, tracker(), { ...NONE, sessions: [{ date: '2026-11-21', late: false, where: 'Bedok', from: 'calendar' }] });
    const s = r.proposals.find((p) => p.session?.from === 'calendar')!;
    expect(s.entry).toMatchObject({ date: '2026-11-21', kind: 'in', amount: 15, category: 'Pay', note: 'Busking · Bedok · 3 tips' });
    expect(s.entry.refs).toHaveLength(3);
    expect(find(r, /Send back/)?.session).toBeUndefined();
    // Five small ones on a day with nothing on the calendar: probably busking, said so.
    expect(r.proposals.find((p) => p.session?.from === 'guess')?.entry).toMatchObject({ date: '2026-11-14', amount: 15 });
    // One PayNow on a day is just a PayNow.
    expect(find(r, /Lone Friend/)?.session).toBeUndefined();
  });
  it('gives the next day’s tips to a session that ran past midnight', () => {
    const st = parseStatement(HEAD + [tip('22-Nov-26', '1', 'A', 'x', 2), tip('21-Nov-26', '2', 'B', 'x', 3)].join('\n'));
    const r = reviewStatement(st, tracker(), { ...NONE, sessions: [{ date: '2026-11-21', late: true, where: 'Bugis', from: 'calendar' }] });
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0].entry).toMatchObject({ date: '2026-11-21', amount: 5 });
  });
  it('leaves out lines imported before, so a statement can be imported twice', () => {
    const st = parseStatement(CSV);
    const money = tracker();
    const once = applyReview(money, reviewStatement(st, money, NONE), ids()).money;
    const again = reviewStatement(st, once, NONE);
    expect(again.proposals).toHaveLength(0);
    expect(again.imported).toBe(st.lines.length);
    expect(merchantsToAsk(st, once)).toEqual([]);
  });
  it('matches what you typed by hand and ticks a planned entry the bank says happened', () => {
    const st = parseStatement(CSV);
    const typed = ent({ id: 'typed', date: '2026-11-19', amount: 4.6, note: 'groceries' });
    const planned = ent({ id: 'sub', date: '2026-08-20', amount: 12.98, note: 'Apple', planned: true });
    const money = tracker({ entries: [typed, planned] });
    const r = reviewStatement(st, money, NONE);
    expect(find(r, /Giant/)).toMatchObject({ action: 'merge', match: { id: 'typed', planned: false } });
    expect(find(r, /Apple/)).toMatchObject({ action: 'merge', match: { id: 'sub', planned: true } });
    const a = applyReview(money, r, ids());
    expect(a.money.entries.filter((e) => e.amount === 4.6)).toHaveLength(1);
    expect(a.money.entries.find((e) => e.id === 'sub')).toMatchObject({ planned: false, date: '2026-08-23' });
    expect(a.money.entries.find((e) => e.id === 'typed')?.refs).toHaveLength(1);
    expect(a.merged).toBe(2);
  });
  it('doesn’t match an entry from an earlier import: the same again is a second payment', () => {
    const st = parseStatement(HEAD + LINES[2]);
    const money = tracker({ entries: [ent({ date: '2026-11-18', amount: 4.6, refs: ['bother'] })] });
    expect(reviewStatement(st, money, NONE).proposals[0].match).toBeUndefined();
  });
  it('replaces a busking amount typed by hand, and adds to one from an earlier import', () => {
    const st = parseStatement(CSV);
    const sessions: BuskSession[] = [{ date: '2026-11-21', late: false, where: 'Bedok', from: 'calendar' }];
    const hand = tracker({ entries: [ent({ id: 'b', date: '2026-11-21', kind: 'in', amount: 20, note: 'Busking Bedok' })] });
    const r = reviewStatement(st, hand, { ...NONE, sessions });
    expect(r.proposals.find((p) => p.session?.from === 'calendar')?.match?.id).toBe('b');
    expect(applyReview(hand, r, ids()).money.entries.find((e) => e.id === 'b')?.amount).toBe(15);

    const imported = tracker({ entries: [ent({ id: 'b', date: '2026-11-21', kind: 'in', amount: 20, note: 'Busking · Bedok · 4 tips', refs: ['bearlier'] })] });
    const r2 = reviewStatement(st, imported, { ...NONE, sessions });
    expect(applyReview(imported, r2, ids()).money.entries.find((e) => e.id === 'b')?.amount).toBe(35);
  });
  it('matches bill emails: a shop’s name from the email, and Inbox’s suggestion cleared', () => {
    const st = parseStatement(CSV);
    const r = reviewStatement(st, tracker(), NONE, { pendingBills: [{ id: 'mail1', payee: 'Apple', subject: 'Your receipt from Apple', amount: 12.98, date: '2026-08-24', status: 'paid', category: 'Bills' }] });
    const p = r.proposals.find((x) => x.email)!;
    expect(p.entry.note).toBe('Apple');
    expect(applyReview(tracker(), r, ids()).dropBills).toEqual(['mail1']);
  });
  it('uses Claude’s names, but what you set before wins', () => {
    const st = parseStatement(CSV);
    const names = { 'GIANT-BEDOK MKT PL': { name: 'Giant (Bedok)', category: 'Shopping' as const } };
    const r = reviewStatement(st, tracker(), { ...NONE, names });
    // The built-in category beats Claude's; the name is Claude's.
    expect(find(r, /Giant/)?.entry).toMatchObject({ note: 'Giant (Bedok)', category: 'Food' });
    const learned = tracker({ rules: [{ id: 'm:GIANT-BEDOK MKT PL', name: 'Groceries', category: 'Family' }] });
    expect(reviewStatement(st, learned, { ...NONE, names }).proposals.find((p) => p.rule === 'm:GIANT-BEDOK MKT PL')?.entry).toMatchObject({ note: 'Groceries', category: 'Family' });
  });
  it('learns your names and categories, and someone being you, for the next statement', () => {
    const st = parseStatement(CSV);
    const money = tracker();
    let r = reviewStatement(st, money, NONE);
    const grab = r.proposals.find((p) => p.rule === 'm:GRABPAY TOPUP')!;
    const siti = r.proposals.find((p) => p.rule.startsWith('p:SITI'))!;
    r = { ...r, proposals: r.proposals.map((p) => (p === grab ? { ...p, entry: { ...p.entry, category: 'Food' } } : p === siti ? asMove(p, r, 'trust', money) : p)) };
    const after = applyReview(money, r, ids()).money;
    expect(after.rules).toEqual(expect.arrayContaining([{ id: 'm:GRABPAY TOPUP', name: 'GrabPay top-up', category: 'Food' }, { id: siti.rule, name: '', category: '', move: 'trust' }]));
    // The next statement: a new top-up and a new transfer from the same person.
    const next = parseStatement(HEAD + ['25-Nov-26,IDT,GRABPAY TOPUP ALEX TAN Z9 UBIL,GRABPAY TOPUP ALEX TAN,Z9,UBIL,Settled,15,', '26-Nov-26,ITR,FT2611 IB:SITI NORMALIS BINTE MOHAMED ISMA ,FT2611,IB:SITI NORMALIS BINTE MOHAMED ISMA,,Settled,,50'].join('\n'));
    const r2 = reviewStatement(next, cleanMoney(after), NONE);
    expect(r2.proposals.find((p) => /GrabPay/.test(p.entry.note))?.entry.category).toBe('Food');
    expect(r2.proposals.find((p) => p.entry.amount === 50)?.entry).toMatchObject({ kind: 'move', account: 'trust', to: 'posb', note: 'From Trust Bank' });
  });
  it('renames a shop and sets a category once for all its lines; a person’s notes stay their own', () => {
    const st = parseStatement(HEAD + [LINES[1], '20-Nov-26,IDT,GRABPAY TOPUP ALEX TAN B9 UBIL,GRABPAY TOPUP ALEX TAN,B9,UBIL,Settled,5,', tip('10-Nov-26', '1', 'MUM', 'groceries', 60), tip('12-Nov-26', '2', 'MUM', 'bus', 70)].join('\n'));
    let r = reviewStatement(st, tracker(), NONE);
    const grab = r.proposals.filter((p) => p.rule === 'm:GRABPAY TOPUP');
    r = patchAlike(r, grab[0].id, 'note', (p) => ({ ...p, entry: { ...p.entry, note: 'Grab' } }));
    r = patchAlike(r, grab[0].id, 'category', (p) => ({ ...p, entry: { ...p.entry, category: 'Food' } }));
    expect(r.proposals.filter((p) => p.rule === 'm:GRABPAY TOPUP').map((p) => [p.entry.note, p.entry.category])).toEqual([['Grab', 'Food'], ['Grab', 'Food']]);
    const mum = r.proposals.filter((p) => p.rule === 'p:MUM');
    r = patchAlike(r, mum[0].id, 'note', (p) => ({ ...p, entry: { ...p.entry, note: 'From Mum' } }));
    r = patchAlike(r, mum[0].id, 'category', (p) => ({ ...p, entry: { ...p.entry, category: 'Family' } }));
    expect(r.proposals.filter((p) => p.rule === 'p:MUM').map((p) => [p.entry.note, p.entry.category])).toEqual([['From Mum', 'Family'], ['PayNow from Mum · bus', 'Family']]);
  });
  it('takes one tip out of a session as its own entry', () => {
    const st = parseStatement(CSV);
    const money = tracker();
    const r = reviewStatement(st, money, { ...NONE, sessions: [{ date: '2026-11-21', late: false, where: 'Bedok', from: 'calendar' }] });
    const s = r.proposals.find((p) => p.session?.from === 'calendar')!;
    const out = splitTip(r, s.id, s.lines.find((l) => l.amount === 8)!.key, money);
    expect(out.proposals.find((p) => p.session?.from === 'calendar')?.entry).toMatchObject({ amount: 7, note: 'Busking · Bedok · 2 tips' });
    expect(out.proposals.find((p) => p.entry.amount === 8 && !p.session)?.entry.note).toMatch(/^PayNow from Koh Lin Yin/);
  });
});

describe('applying it', () => {
  it('leaves out lines from before Money starts, unless asked, and then keeps later balances the same', () => {
    const st = parseStatement(CSV);
    const money = tracker({ start: '2026-11-01' });
    const r = reviewStatement(st, money, NONE);
    expect(r.proposals.filter((p) => p.early).every((p) => p.action === 'skip')).toBe(true);
    const before = accountBalance(money, 'posb', '2026-11-01');
    const all: Review = { ...r, proposals: r.proposals.map((p) => ({ ...p, action: 'add' })) };
    const a = applyReview(money, all, ids()).money;
    expect(a.start).toBe('2026-08-23');
    expect(accountBalance(a, 'posb', '2026-10-31')).toBe(before);
    expect(accountBalance(a, 'trust', '2026-10-31')).toBe(accountBalance(money, 'trust', '2026-11-01'));
  });
  it('makes the balance match the bank’s when asked', () => {
    const st = parseStatement(CSV);
    const money = tracker();
    const r = reviewStatement(st, money, NONE);
    const plain = applyReview(money, r, ids());
    expect(plain.corrected).toBe(0);
    const fixed = applyReview(money, r, ids(), { correct: 'entry' });
    expect(fixed.corrected).toBeCloseTo(148.85 - plain.balance, 2);
    expect(accountBalance(fixed.money, 'posb', '2026-11-22', true)).toBe(148.85);
    expect(fixed.money.entries.find((e) => e.note === 'Balance correction (bank statement)')).toMatchObject({ planned: false, date: '2026-11-22' });
    // Or the starting balance was what was off: no entry, every day moves by the same amount.
    const start = applyReview(money, r, ids(), { correct: 'opening' });
    expect(accountBalance(start.money, 'posb', '2026-11-22', true)).toBe(148.85);
    expect(start.money.entries).toHaveLength(plain.money.entries.length);
    expect(start.money.accounts.find((a) => a.id === 'posb')?.opening).toBeCloseTo(500 + fixed.corrected, 2);
  });
  it('saves refs and rules, and drops broken ones', () => {
    const m = cleanMoney({
      ...tracker(),
      entries: [ent({ refs: ['babc', 'babc', 'not a ref', 5 as unknown as string] })],
      rules: [{ id: 'm:SHOP', name: 'Shop', category: 'Food' }, { id: 'x:bad', name: '', category: '' }, { id: 'p:ME', name: '', category: 'Nope', move: 'nowhere' }],
    });
    expect(m.entries[0].refs).toEqual(['babc']);
    expect(m.rules).toEqual([{ id: 'm:SHOP', name: 'Shop', category: 'Food' }, { id: 'p:ME', name: '', category: '' }]);
  });
});

describe('what the server adds', () => {
  const places = [{ key: 'pl', id: '1', nac: 'Paya Lebar Square', name: 'Paya Lebar Square', short: 'Paya Lebar' }];
  const ev = (p: Partial<CalEvent>): CalEvent => ({ id: 'e', calendarId: 'c', title: '', start: '2026-11-21T19:00:00+08:00', end: '2026-11-21T22:00:00+08:00', allDay: false, ...p });
  it('takes the dates and shops, checked', () => {
    expect(cleanAsk({ from: '2026-11-01', to: '2026-10-01', merchants: [] })).toBeNull();
    expect(cleanAsk({ from: '2025-01-01', to: '2026-11-01', merchants: [] })).toBeNull();
    expect(cleanAsk({ from: '2026-08-01', to: '2026-11-22', merchants: [{ text: ' GIANT ', dir: 'sideways', country: 'idn' }, { text: '' }] })).toEqual({ from: '2026-08-01', to: '2026-11-22', merchants: [{ text: 'GIANT', dir: 'out' }] });
  });
  it('finds busking on the calendar: the word, or a NAC place, and whether it ran past midnight', () => {
    expect(sessionOf(ev({ title: 'Busking' , location: 'Bedok Mall, Singapore' }), places)).toEqual({ date: '2026-11-21', late: false, where: 'Bedok Mall', from: 'calendar' });
    expect(sessionOf(ev({ title: 'Paya Lebar', end: '2026-11-22T01:00:00+08:00' }), places)).toMatchObject({ where: 'Paya Lebar', late: true });
    expect(sessionOf(ev({ title: 'Dentist' }), places)).toBeNull();
  });
  it('reads your NAC bookings and keeps one session a day', () => {
    const snap = { mine_on: true, locations: [{ short: 'Paya Lebar', name: 'Paya Lebar Square', days: [{ date: '2026-11-21', free: [], taken: [], mine: [{ start: '19:00', end: '22:00', status: 'Published' }] }] }] } as unknown as NacSlots;
    const nac = nacSessions(snap, '2026-11-01', '2026-11-30');
    expect(nac).toEqual([{ date: '2026-11-21', late: false, where: 'Paya Lebar', from: 'nac' }]);
    expect(nacSessions({ ...snap, mine_on: false }, '2026-11-01', '2026-11-30')).toEqual([]);
    expect(oneADay([{ date: '2026-11-21', late: false, where: '', from: 'calendar' }, ...nac])).toEqual([{ date: '2026-11-21', late: false, where: 'Paya Lebar', from: 'calendar' }]);
  });
  it('keeps Claude’s names for shops it was asked about, and SGD emails only', () => {
    const asked = [{ text: 'GIANT', dir: 'out' as const }];
    expect(namesFrom([{ i: 0, name: ' Giant ', category: 'Food' }, { i: 5, name: 'x', category: 'Food' }, { i: 0, name: '', category: 'Bad' }], asked)).toEqual({ GIANT: { name: 'Giant', category: 'Food' } });
    const bill = { id: 'm', threadId: 't', subject: 's', payee: 'P', amount: 5, currency: 'USD', status: 'paid' as const, date: '2026-11-01', category: '' as const, source: 'rules' as const };
    expect(emailsFrom([bill, { ...bill, id: 'n', currency: 'SGD' }]).map((e) => e.id)).toEqual(['n']);
  });
});
