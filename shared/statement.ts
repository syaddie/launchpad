// Importing a bank statement into Money: POSB / DBS's "transaction history" CSV.
//
//   parseStatement   the CSV → its lines, each with a key that stays the same in every export
//   reviewStatement  the lines → proposed entries: what each line is, busking tips grouped by
//                    session, names and categories (learned → built-in rules → Claude → an email),
//                    and what's already in Money (lines imported before, entries typed by hand,
//                    planned ones the bank says happened, bill emails)
//   applyReview      the choices made in the review → the new Money, with what was learned
//
// Free of I/O so it can be unit tested. The server finds busking sessions, bill emails and
// Claude's names for the review (server/src/statement.ts); the page shows it (StatementDrawer).
import { addDays, dayDiff, MON, pad2, parseYmd, ymd } from './dates';
import { accountBalance, CATEGORIES, effectOn, MAX_ENTRIES, MAX_REFS, MAX_RULES, sortEntries } from './money';
import type { BuskSession, Money, MoneyCategory, MoneyEntry, MoneyRule, StatementAsk, StatementContext, StatementEmail } from './types';

// ---------- reading the CSV ----------

/** One line of the statement. Amounts are positive; `dir` says which way. */
export interface BankLine {
  /** Stays the same for this line in any export that has it, so a second import skips it. */
  key: string;
  /** The day the bank booked it. */
  posted: string;
  /** The day it happened: a card payment's own date (often a few days earlier), or `posted`. */
  date: string;
  code: string;
  /** The description, spaces squashed. */
  text: string;
  ref1: string;
  ref2: string;
  ref3: string;
  dir: 'in' | 'out';
  amount: number;
}

export interface Statement {
  /** "ePOSBkids Account 112-68508-1" */
  account: string;
  /** The day the statement was made. */
  asOf: string;
  /** What the bank says the account has: booked (ledger) and spendable now (available). */
  ledger: number | null;
  available: number | null;
  /** Oldest first. */
  lines: BankLine[];
  /** Lines not settled yet, left out: the next statement has them. */
  unsettled: number;
}

export class StatementError extends Error {}

/** CSV rows, with quoted cells (commas and "" inside) read properly. */
export function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (src[i + 1] === '"') (cell += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows;
}

const MONTHS = MON.map((m) => m.toLowerCase());
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const cents = (n: number) => Math.round(n * 100) / 100;

/** "22-Nov-26", "24-Sept-26", "22 Nov 2026", "22/11/2026" or "2026-11-22" → YYYY-MM-DD; '' if it isn't a date. */
export function bankDate(s: string): string {
  const t = s.trim();
  let y: number, m: number, d: number;
  let r: RegExpExecArray | null;
  if ((r = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) [y, m, d] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else if ((r = /^(\d{1,2})[-\s]([A-Za-z]{3,9})[-\s](\d{2}|\d{4})$/.exec(t))) {
    m = MONTHS.indexOf(r[2].slice(0, 3).toLowerCase()) + 1;
    [d, y] = [Number(r[1]), Number(r[3])];
  } else if ((r = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t))) [d, m, y] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else return '';
  if (y < 100) y += 2000;
  if (!m || m > 12 || !d || d > 31) return '';
  const out = `${y}-${pad2(m)}-${pad2(d)}`;
  return ymd(parseYmd(out)) === out ? out : '';
}

/** "SGD 1,234.50", "1234.5", "" → a number, or null. */
export function bankAmount(s: string): number | null {
  const t = s.replace(/SGD|S\$|\$|,|\s/gi, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? cents(n) : null;
}

/** Two 32-bit FNV-style hashes, so ~5000 lines a year have next to no chance of two sharing a key. */
function hash(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 16777619);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 13;
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/**
 * A card or NETS payment's own date: "… SGP 18NOV" at the end of Ref1, or NETS's
 * "20261111101956…" in the description. Only trusted within two weeks before it was booked.
 */
export function spentOn(posted: string, ref1: string, text: string): string {
  const p = parseYmd(posted);
  const near = (d: string) => (d && dayDiff(parseYmd(d), p) >= 0 && dayDiff(parseYmd(d), p) <= 14 ? d : '');
  const card = /\b(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)\s*$/i.exec(ref1.trim());
  if (card) {
    const month = MONTHS.indexOf(card[2].toLowerCase()) + 1;
    // A December payment booked in January was last year's.
    const year = p.getFullYear() - (month > p.getMonth() + 1 ? 1 : 0);
    const d = near(bankDate(`${year}-${pad2(month)}-${card[1]}`));
    if (d) return d;
  }
  const nets = /\b(20\d{2})(\d{2})(\d{2})\d{6}/.exec(text);
  if (nets) {
    const d = near(bankDate(`${nets[1]}-${nets[2]}-${nets[3]}`));
    if (d) return d;
  }
  return posted;
}

/** Reads POSB / DBS's transaction history CSV (digibank › Accounts › your account › Download › CSV). */
export function parseStatement(csv: string): Statement {
  const rows = csvRows(csv);
  const head = rows.findIndex((r) => r[0]?.trim().toLowerCase() === 'transaction date');
  if (head < 0) throw new StatementError('it doesn’t look like a POSB or DBS transaction history: there’s no “Transaction Date” column. In digibank, open the account, then Download › CSV.');
  const info = (label: string) => rows.slice(0, head).find((r) => r[0]?.trim().toLowerCase().startsWith(label))?.[1]?.trim() ?? '';
  const cols = rows[head].map((c) => c.trim().toLowerCase());
  const col = (name: string) => cols.indexOf(name);
  const at = { date: col('transaction date'), code: col('transaction code'), text: col('description'), r1: col('transaction ref1'), r2: col('transaction ref2'), r3: col('transaction ref3'), status: col('status'), debit: col('debit amount'), credit: col('credit amount') };
  if (at.debit < 0 || at.credit < 0) throw new StatementError('it has no Debit Amount and Credit Amount columns.');
  const cell = (r: string[], i: number) => (i >= 0 ? r[i] ?? '' : '');

  const lines: BankLine[] = [];
  const seen = new Map<string, number>();
  let unsettled = 0;
  for (const r of rows.slice(head + 1)) {
    const posted = bankDate(cell(r, at.date));
    if (!posted) continue;
    const status = cell(r, at.status).trim().toLowerCase();
    if (status && status !== 'settled') {
      unsettled++;
      continue;
    }
    const debit = bankAmount(cell(r, at.debit)) ?? 0;
    const credit = bankAmount(cell(r, at.credit)) ?? 0;
    const signed = cents(credit - debit);
    if (!signed) continue;
    const [code, text, ref1, ref2, ref3] = [cell(r, at.code), cell(r, at.text), cell(r, at.r1), cell(r, at.r2), cell(r, at.r3)].map(squash);
    const dir = signed > 0 ? 'in' : 'out';
    const amount = Math.abs(signed);
    // The same line twice (two identical top-ups on a day) gets #2, in the order the bank lists them.
    const base = `b${hash(`${posted}|${code}|${text}|${dir}|${amount.toFixed(2)}`)}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    lines.push({ key: n > 1 ? `${base}-${n}` : base, posted, date: spentOn(posted, ref1, text), code, text, ref1, ref2, ref3, dir, amount });
  }
  if (!lines.length && !unsettled) throw new StatementError('it has no transactions in it.');
  // The bank lists the newest first.
  lines.sort((a, b) => (a.posted < b.posted ? -1 : a.posted > b.posted ? 1 : 0));
  const asOf = bankDate(info('statement as at')) || lines[lines.length - 1]?.posted || '';
  return { account: info('account details for'), asOf, ledger: bankAmount(info('ledger balance')), available: bankAmount(info('available balance')), lines, unsettled };
}

// ---------- what each line is ----------

/** "KOH LIN YIN" → "Koh Lin Yin"; a name the bank cut off mid-bracket loses the bracket. */
export function titleCase(s: string): string {
  return squash(s.replace(/\([^)]*$/, ''))
    .toLowerCase()
    .replace(/(^|[\s\-/(.'&])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
}

const COUNTRY = /^(SGP|IRL|USA|GBR|AUS|NLD|LUX|HKG|JPN|KOR|CHN|TWN|MYS|IDN|THA|VNM|PHL|IND|DEU|FRA|CAN|ARE)$/;
/** Words a card payment's Ref1 ends with that aren't the shop's name. */
const TAIL = /^(SI|SIN|SG|SGP|SINGAPORE|SINGAPO|SINGAP|S|PTE|LTD|PTE\.|LTD\.)$/i;

/** A card payment's shop and country, from Ref1: "GIANT-BEDOK MKT PL Si SGP 18NOV" → GIANT-BEDOK MKT PL, SGP. */
export function merchantOf(ref1: string): { merchant: string; country: string } {
  const words = squash(ref1.replace(/^\d{6,},/, '')).split(' ');
  let country = '';
  if (/^\d{2}[A-Z]{3}$/i.test(words[words.length - 1] ?? '')) words.pop();
  while (words.length > 1) {
    const w = words[words.length - 1];
    if (!country && COUNTRY.test(w)) country = w;
    else if (!(TAIL.test(w) || /^\d+$/.test(w) || (/\d/.test(w) && /[A-Z]/i.test(w) && w.length >= 6))) break;
    words.pop();
  }
  return { merchant: words.join(' ').toUpperCase(), country };
}

/** A PayNow or transfer memo that says something: not "PayNow Transfer", "OTHR" or just numbers. */
function memoOf(s: string): string {
  const t = squash(s.replace(/^OTHR\s*/i, '').replace(/\bOTHR\b/gi, ''));
  return /^(paynow transfer|paynow|transfer|transfer - mobile|othr|\d*)$/i.test(t) ? '' : t;
}

/** Built-in categories for shops, checked after what you've set before. */
export const SHOP_RULES: [RegExp, MoneyCategory][] = [
  [/BUS\/MRT|SIMPLYGO|TRANSITLINK|EZ-?LINK|SMRT|SBS TRANSIT|GOJEK|TADA|COMFORT|CDG|ZIG|RYDE|GRAB\s?(RIDE|CAR|TAXI)|SHELL|ESSO|CALTEX|SINOPEC|PARKING/, 'Transport'],
  [/GIANT|FAIRPRICE|NTUC|SHENG SIONG|COLD STORAGE|DON DON DONKI|PRIME SUPERMARKET|OLD CHANG KEE|STARBUCKS|MCDONALD|KFC|BURGER KING|SUBWAY|MOS BURGER|KOPITIAM|FOOD|CAFE|COFFEE|BAKERY|TOAST|YA KUN|KOI|LIHO|CHICHA|GONG CHA|MR COCONUT|VENDING|POKKA|YOCHI|FOODPANDA|DELIVEROO|GRABFOOD|BREAD|CHICKEN|NOODLE|RESTAURANT|EATERY|KITCHEN|HAWKER|7-ELEVEN|7 ELEVEN|CHEERS/, 'Food'],
  [/SHOPEE|LAZADA|AMAZON|TAOBAO|ALIEXPRESS|TEMU|UNIQLO|DAISO|POPULAR|IKEA|GUARDIAN|WATSONS|DECATHLON|COURTS|CHALLENGER|MUJI|H&M|ZARA|COTTON ON|MINISO|VALUE DOLLAR/, 'Shopping'],
  [/SINGTEL|STARHUB|\bM1\b|CIRCLES|GOMO|SIMBA|GIGA|SP DIGITAL|SP SERVICES|SP GROUP|APPLE\.COM|ICLOUD|GOOGLE|SPOTIFY|NETFLIX|DISNEY|YOUTUBE|MICROSOFT|ADOBE|OPENAI|ANTHROPIC|CLAUDE|CHATGPT|DROPBOX|NOTION|INSURANCE|PRUDENTIAL|AIA|INCOME|GREAT EASTERN|TOWN COUNCIL|IRAS|HDB|CPF/, 'Bills'],
  [/STEAM|NINTENDO|PLAYSTATION|XBOX|GOLDEN VILLAGE|\bGV\b|SHAW|CATHAY|CINEMA|KARAOKE|TEO HENG|BOWLING|ARCADE|TIMEZONE|KLOOK|SISTIC|TICKET/, 'Fun'],
  [/AIRLINE|AIRWAYS|SCOOT|JETSTAR|AIRASIA|SINGAPORE AIR|AGODA|BOOKING\.COM|EXPEDIA|TRIP\.COM|AIRBNB|HOTEL|FERRY|BATAMFAST|MAJESTIC FAST|SINDO/, 'Travel'],
];

export const shopCategory = (merchant: string): MoneyCategory | '' => SHOP_RULES.find(([re]) => re.test(merchant))?.[1] ?? '';

/** What a line is, before what you've set before or Claude has a say. */
export interface Draft {
  kind: 'in' | 'out' | 'move';
  /** For a move: the other account (it goes there, or comes from there into the statement's). */
  other: string;
  note: string;
  category: MoneyCategory | '';
  /** A shop as the bank writes it (rule key `m:` and what Claude is asked about); '' when it's a person. */
  merchant: string;
  country: string;
  /** Someone's name, for PayNow and transfers (rule key `p:`). Never sent to Claude. */
  person: string;
  memo: string;
  /** Incoming PayNow that could be a busking tip. */
  paynowIn: boolean;
}

const findAccount = (money: Money, not: string, test: (name: string) => boolean, kind?: string) =>
  money.accounts.find((a) => a.id !== not && !a.archived && (kind ? a.kind === kind : test(a.name.toLowerCase())))?.id ?? '';

/** What a line is: money in, out, or a move to one of your other accounts, with a note and maybe a category. */
export function describe(l: BankLine, money: Money, account: string): Draft {
  const d: Draft = { kind: l.dir, other: '', note: '', category: '', merchant: '', country: '', person: '', memo: '', paynowIn: false };
  const moveWith = (other: string, note: string) => (other ? { ...d, kind: 'move' as const, other, note } : null);
  const T = l.text.toUpperCase();

  if (/^INCOMING PAYNOW/.test(T)) {
    const person = titleCase(l.ref2.replace(/^From:\s*/i, ''));
    const memo = memoOf(l.ref3);
    return { ...d, person, memo, paynowIn: true, note: `PayNow from ${person || 'someone'}${memo ? ` · ${memo}` : ''}` };
  }
  if (/^PAYNOW TRANSFER/.test(T)) {
    const name = titleCase(l.ref2.replace(/^To:\s*/i, ''));
    const memo = memoOf(l.ref3);
    // Paying a shop's PayNow QR: the "person" is the shop.
    if (/^QR/i.test(memo)) return { ...d, merchant: l.ref2.replace(/^To:\s*/i, '').toUpperCase(), note: name, category: shopCategory(name.toUpperCase()) };
    return { ...d, person: name, memo, note: `PayNow ${l.dir === 'in' ? 'from' : 'to'} ${name || 'someone'}${memo ? ` · ${memo}` : ''}` };
  }
  // Your own accounts at other banks: "Trus:0192555068:I-BANK Transfer" → an account whose name starts "Trus".
  const own = /^([A-Za-z]{3,6}):\d+:/.exec(l.text);
  if (own) {
    const prefix = own[1].toLowerCase();
    const other = findAccount(money, account, (n) => n.startsWith(prefix));
    const named = money.accounts.find((a) => a.id === other)?.name ?? titleCase(own[1]);
    return moveWith(other, `${l.dir === 'out' ? 'To' : 'From'} ${named}`) ?? { ...d, note: `Transfer ${l.dir === 'out' ? 'to' : 'from'} ${named}…`, merchant: `TRANSFER ${own[1].toUpperCase()}` };
  }
  if (/GRABPAY TOP\s?UP/.test(T)) {
    return moveWith(findAccount(money, account, (n) => n.includes('grab')), 'GrabPay top-up') ?? { ...d, note: 'GrabPay top-up', merchant: 'GRABPAY TOPUP' };
  }
  if (/PAYLAH/.test(T)) {
    return moveWith(findAccount(money, account, (n) => n.includes('paylah')), `${l.dir === 'in' ? 'From' : 'To'} PayLah!`) ?? { ...d, note: `${l.dir === 'in' ? 'From' : 'To'} PayLah! wallet`, merchant: 'PAYLAH' };
  }
  switch (l.code) {
    case 'SAL':
      return { ...d, note: `Salary · ${titleCase(l.ref1)}`, category: 'Pay' };
    case 'INT':
      return { ...d, note: 'Interest', category: 'Other' };
    case 'SC':
      return { ...d, note: 'Bank service charge', category: 'Bills' };
    case 'AWL':
      return moveWith(findAccount(money, account, () => true, 'cash'), 'Cash from the ATM') ?? { ...d, note: 'Cash from the ATM', category: 'Other' };
    case 'CAM':
      return moveWith(findAccount(money, account, () => true, 'cash'), 'Cash paid in') ?? { ...d, note: 'Cash paid in', category: 'Other' };
    case 'MST':
    case 'POS': {
      const { merchant, country } = merchantOf(l.ref1);
      const name = titleCase(merchant);
      return { ...d, merchant, country, note: l.dir === 'in' ? `Refund · ${name}` : name, category: shopCategory(merchant) };
    }
    case 'ITR': {
      const person = titleCase(l.ref2.replace(/^IB:\s*/i, ''));
      const memo = memoOf(l.ref3);
      return { ...d, person, memo, note: `${l.dir === 'in' ? 'From' : 'To'} ${person || 'a transfer'}${memo ? ` · ${memo}` : ''}` };
    }
    case 'RTF': {
      const payer = l.ref2 || l.ref1;
      return { ...d, merchant: payer.toUpperCase(), note: `${l.dir === 'in' ? 'From' : 'To'} ${titleCase(payer)}` };
    }
  }
  const text = l.ref1 || l.text;
  return { ...d, note: titleCase(text) || (l.dir === 'in' ? 'Money in' : 'Money out'), merchant: text.toUpperCase().slice(0, 60) };
}

// ---------- busking tips ----------

/** Above this, a PayNow is someone paying you, not a tip. */
export const TIP_MAX = 50;
/** A day with this many small PayNows and no session on the calendar is probably busking all the same. */
export const GUESS_MIN = 5;
const NOT_A_TIP = /\b(send ?back|sendback|pay ?back|payback|repay|refund|return|owe|owed|loan|rent|split|deposit)\b/i;

export const tipLike = (l: BankLine, d: Draft) => d.paynowIn && l.dir === 'in' && l.amount <= TIP_MAX && !NOT_A_TIP.test(d.memo);

// ---------- the review ----------

/** A line already in Money: an entry typed in, a planned one, or a session typed as one amount. */
export interface EntryMatch {
  id: string;
  note: string;
  date: string;
  amount: number;
  planned: boolean;
  /** It came from an earlier import (it has bank lines), so tips add to it rather than replace it. */
  imported: boolean;
}

export type Action = 'add' | 'merge' | 'skip';

export interface Proposal {
  /** The first line's key. */
  id: string;
  lines: BankLine[];
  /** What would be added; its id is set when it is. */
  entry: MoneyEntry;
  /** A busking session's tips, as one entry. */
  session?: { where: string; from: 'calendar' | 'nac' | 'guess' };
  /** Rule key for remembering its name and category: `m:` merchant or `p:` person; '' when there's nothing to remember it by. */
  rule: string;
  /** Where its name and category came from. */
  from: 'learned' | 'rule' | 'claude' | 'email' | 'bank';
  match?: EntryMatch;
  email?: StatementEmail & { pending: boolean };
  /** Before the first day Money tracks. */
  early: boolean;
  action: Action;
}

export interface Review {
  statement: Statement;
  /** The Money account the statement is for. */
  account: string;
  proposals: Proposal[];
  /** Lines already imported before, not shown again. */
  imported: number;
}

/** The Money account a statement is for: one named like it (POSB, DBS), or else the main one. */
export function accountFor(st: Statement, money: Money): string {
  const words = st.account.toLowerCase();
  const live = money.accounts.filter((a) => !a.archived);
  const named = live.find((a) => a.kind === 'bank' && words.includes(a.name.toLowerCase().split(' ')[0]));
  return (named ?? live.find((a) => a.spendable) ?? money.accounts[0]).id;
}

const days = (a: string, b: string) => Math.abs(dayDiff(parseYmd(a), parseYmd(b)));
const looksLikeBusking = (e: MoneyEntry) => e.kind === 'in' && (/busk|tips?\b|nac\b/i.test(e.note) || (!!e.refs?.length && /^Busking/.test(e.note)));

/** Which days' tips each session gets: its own day, and the next for one that ran past midnight. */
function sessionDays(sessions: BuskSession[]): Map<string, BuskSession[]> {
  const map = new Map<string, BuskSession[]>();
  const add = (d: string, s: BuskSession) => map.set(d, [...(map.get(d) ?? []), s]);
  for (const s of sessions) add(s.date, s);
  for (const s of sessions) {
    const next = ymd(addDays(parseYmd(s.date), 1));
    if (s.late && !map.has(next)) add(next, s);
  }
  return map;
}

const placeNames = (list: BuskSession[]) => [...new Set(list.map((s) => s.where).filter(Boolean))].join(' & ');

/**
 * Proposed entries for a statement's new lines. `ctx` is what the server found (it can be
 * empty: no Google, no Claude); `pendingBills` are the email suggestions waiting in Inbox.
 */
export function reviewStatement(st: Statement, money: Money, ctx: StatementContext, opts: { account?: string; pendingBills?: StatementEmail[] } = {}): Review {
  const account = opts.account && money.accounts.some((a) => a.id === opts.account) ? opts.account : accountFor(st, money);
  const done = new Set(money.entries.flatMap((e) => e.refs ?? []));
  const fresh = st.lines.filter((l) => !done.has(l.key));
  const rules = new Map((money.rules ?? []).map((r) => [r.id, r]));
  const byDay = sessionDays(ctx.sessions);

  // Tips first: per day, the small PayNows of a session (or of a day that looks like one).
  const drafts = new Map(fresh.map((l) => [l.key, describe(l, money, account)]));
  const tips = new Map<string, { lines: BankLine[]; date: string; where: string; from: 'calendar' | 'nac' | 'guess' }>();
  const tipDays = new Map<string, BankLine[]>();
  for (const l of fresh) if (tipLike(l, drafts.get(l.key)!)) tipDays.set(l.posted, [...(tipDays.get(l.posted) ?? []), l]);
  for (const [day, lines] of tipDays) {
    const list = byDay.get(day);
    if (list?.length) {
      // A late session's next-day tips go to the session's own day.
      const date = list[0].date;
      const g = tips.get(date) ?? { lines: [], date, where: placeNames(list), from: list[0].from };
      g.lines.push(...lines);
      tips.set(date, g);
    } else if (lines.length >= GUESS_MIN) tips.set(day, { lines, date: day, where: '', from: 'guess' });
  }
  const inSession = new Set([...tips.values()].flatMap((g) => g.lines.map((l) => l.key)));

  const proposals: Proposal[] = [];
  const base = (lines: BankLine[], date: string): Omit<Proposal, 'entry' | 'rule' | 'from'> => ({ id: lines[0].key, lines, early: date < money.start, action: 'add' });
  for (const g of tips.values()) {
    const total = cents(g.lines.reduce((s, l) => s + l.amount, 0));
    const note = `Busking${g.where ? ` · ${g.where}` : ''} · ${g.lines.length} tip${g.lines.length === 1 ? '' : 's'}`;
    proposals.push({
      ...base(g.lines, g.date),
      entry: { id: '', date: g.date, kind: 'in', amount: total, note, category: 'Pay', planned: false, account, to: '', refs: g.lines.map((l) => l.key) },
      session: { where: g.where, from: g.from },
      rule: '',
      from: 'bank',
    });
  }
  for (const l of fresh) {
    if (inSession.has(l.key)) continue;
    let d = drafts.get(l.key)!;
    const rule = d.merchant ? `m:${d.merchant}` : d.person ? `p:${d.person.toUpperCase()}` : '';
    const learned = rule ? rules.get(rule) : undefined;
    // Someone marked as you: money with them is a move to or from that account.
    const yours = learned?.move && learned.move !== account ? money.accounts.find((a) => a.id === learned.move) : undefined;
    if (yours && d.kind !== 'move') d = { ...d, kind: 'move', other: yours.id, note: `${l.dir === 'in' ? 'From' : 'To'} ${yours.name}` };
    const claude = d.merchant ? ctx.names[d.merchant] : undefined;
    const note = (learned?.name || (claude?.name && d.kind !== 'move' ? (l.dir === 'in' && l.code !== 'RTF' ? `Refund · ${claude.name}` : claude.name) : '') || d.note).slice(0, 120);
    const category = d.kind === 'move' ? '' : learned?.category || d.category || claude?.category || '';
    const move = d.kind === 'move';
    proposals.push({
      ...base([l], l.date),
      entry: {
        id: '',
        date: l.date,
        kind: d.kind,
        amount: l.amount,
        note,
        category,
        planned: false,
        // A move out of the statement's account goes to the other one; one into it comes from there.
        account: move && l.dir === 'in' ? d.other : account,
        to: move ? (l.dir === 'in' ? account : d.other) : '',
        refs: [l.key],
      },
      rule: move && !yours ? '' : rule,
      from: yours || (learned && (learned.name || learned.category)) ? 'learned' : d.category ? 'rule' : claude ? 'claude' : 'bank',
    });
  }

  matchEntries(proposals, money, account);
  matchEmails(proposals, ctx.emails, opts.pendingBills ?? []);
  for (const p of proposals) p.action = p.early ? 'skip' : p.match ? 'merge' : 'add';
  proposals.sort((a, b) => (a.entry.date < b.entry.date ? -1 : a.entry.date > b.entry.date ? 1 : 0));
  return { statement: st, account, proposals, imported: st.lines.length - fresh.length };
}

/**
 * Lines that are already in Money, typed in by hand or planned: the same kind and amount in
 * the same account within a few days (a week for a planned one). A busking session matches
 * money in on its day that says busking or tips, whatever the amount. Each entry matches once.
 */
function matchEntries(proposals: Proposal[], money: Money, account: string) {
  const pairs: { p: Proposal; e: MoneyEntry; score: number }[] = [];
  const candidates = money.entries.filter((e) => !e.invoice && (e.account === account || e.to === account));
  for (const p of proposals) {
    const x = p.entry;
    for (const e of candidates) {
      if (p.session) {
        if (!looksLikeBusking(e) || e.account !== account) continue;
        const gap = days(e.date, x.date);
        if (gap <= 1) pairs.push({ p, e, score: gap });
        continue;
      }
      // Entries from an earlier import are the bank's own lines: one the same again is a second payment.
      if (e.refs?.length || e.kind !== x.kind || Math.abs(e.amount - x.amount) > 0.004) continue;
      if (x.kind === 'move' ? e.account !== x.account || e.to !== x.to : e.account !== account) continue;
      const gap = Math.min(days(e.date, x.date), days(e.date, p.lines[0].posted));
      if (gap <= (e.planned ? 7 : 4)) pairs.push({ p, e, score: gap + (e.planned ? 0.5 : 0) });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const used = new Set<string>();
  for (const { p, e } of pairs) {
    if (p.match || used.has(e.id)) continue;
    used.add(e.id);
    p.match = { id: e.id, note: e.note, date: e.date, amount: e.amount, planned: e.planned, imported: !!e.refs?.length };
  }
}

/** Money out the same as a bill or receipt email within five days. A shop's name from the email beats the bank's. */
function matchEmails(proposals: Proposal[], found: StatementEmail[], pending: StatementEmail[]) {
  const all = [...pending.map((e) => ({ ...e, pending: true })), ...found.filter((f) => !pending.some((p) => p.id === f.id)).map((e) => ({ ...e, pending: false }))];
  const pairs: { p: Proposal; m: (typeof all)[number]; score: number }[] = [];
  for (const p of proposals) {
    if (p.session || p.entry.kind !== 'out') continue;
    for (const m of all) {
      if (Math.abs(m.amount - p.entry.amount) > 0.004) continue;
      const gap = Math.min(days(m.date, p.entry.date), days(m.date, p.lines[0].posted));
      if (gap <= 5) pairs.push({ p, m, score: gap });
    }
  }
  pairs.sort((a, b) => a.score - b.score);
  const used = new Set<string>();
  for (const { p, m } of pairs) {
    if (p.email || used.has(m.id)) continue;
    used.add(m.id);
    p.email = m;
    // Only a name you set before beats the email's; the built-in rules only give categories.
    if (p.from !== 'learned') {
      if (m.payee) p.entry = { ...p.entry, note: m.payee.slice(0, 120) };
      if (!p.entry.category && m.category) p.entry = { ...p.entry, category: m.category };
      p.from = 'email';
    }
  }
}

// ---------- changing a proposal ----------

/** Takes one tip out of its session, as its own entry; a session left with none goes. */
export function splitTip(r: Review, sessionId: string, key: string, money: Money): Review {
  const s = r.proposals.find((p) => p.id === sessionId);
  const line = s?.lines.find((l) => l.key === key);
  if (!s || !line) return r;
  const d = describe(line, money, r.account);
  const lone: Proposal = {
    id: line.key,
    lines: [line],
    entry: { id: '', date: line.date, kind: 'in', amount: line.amount, note: d.note, category: '', planned: false, account: r.account, to: '', refs: [line.key] },
    rule: d.person ? `p:${d.person.toUpperCase()}` : '',
    from: 'bank',
    early: line.date < money.start,
    action: line.date < money.start ? 'skip' : 'add',
  };
  const rule = money.rules?.find((x) => x.id === lone.rule);
  if (rule?.category) lone.entry.category = rule.category;
  const lines = s.lines.filter((l) => l.key !== key);
  const rest: Proposal | null = lines.length
    ? {
        ...s,
        id: lines[0].key,
        lines,
        entry: { ...s.entry, amount: cents(lines.reduce((t, l) => t + l.amount, 0)), note: s.entry.note.replace(/\d+ tips?$/, `${lines.length} tip${lines.length === 1 ? '' : 's'}`), refs: lines.map((l) => l.key) },
      }
    : null;
  const proposals = r.proposals.flatMap((p) => (p === s ? (rest ? [rest, lone] : [lone]) : [p]));
  return { ...r, proposals };
}

export const patchProposal = (r: Review, id: string, f: (p: Proposal) => Proposal): Review => ({ ...r, proposals: r.proposals.map((p) => (p.id === id ? f(p) : p)) });

/**
 * Makes a PayNow or transfer a move between the statement's account and `other` (yours at
 * another bank), or back to money in or out with `other` ''. The import remembers it for the person.
 */
export function asMove(p: Proposal, r: Review, other: string, money: Money): Proposal {
  const l = p.lines[0];
  if (!other) {
    const d = describe(l, money, r.account);
    return { ...p, entry: { ...p.entry, kind: l.dir, account: r.account, to: '', note: d.note, category: '' } };
  }
  const name = money.accounts.find((a) => a.id === other)?.name ?? 'another account';
  return { ...p, entry: { ...p.entry, kind: 'move', category: '', account: l.dir === 'in' ? other : r.account, to: l.dir === 'in' ? r.account : other, note: `${l.dir === 'in' ? 'From' : 'To'} ${name}` } };
}

/**
 * Changes one proposal and every other one from the same shop or person, so a shop is
 * renamed or put in a category once for the whole statement. A person's note stays per
 * line (each has its own memo): `what` 'note' only spreads to shops.
 */
export function patchAlike(r: Review, id: string, what: 'note' | 'category' | 'move', f: (p: Proposal) => Proposal): Review {
  const rule = r.proposals.find((p) => p.id === id)?.rule ?? '';
  const spread = !!rule && (what !== 'note' || rule.startsWith('m:')) && (what !== 'move' || rule.startsWith('p:'));
  return { ...r, proposals: r.proposals.map((p) => (p.id === id || (spread && p.rule === rule && !p.session) ? f(p) : p)) };
}

/** A PayNow or bank transfer with a person, which could be you at another bank. */
export const canBeYou = (p: Proposal) => !p.session && p.rule.startsWith('p:');

// ---------- applying it ----------

export interface Applied {
  money: Money;
  added: number;
  merged: number;
  /** Bill suggestions in Inbox that are now in Money, to take out of Inbox. */
  dropBills: string[];
  /** What the account has on the statement's day once this is in, and what the bank says. */
  balance: number;
  /** How far it was moved to match the bank, when asked: a correction entry, or the starting balance. */
  corrected: number;
}

/** Making Money's balance match the bank's: a correction on the statement's day, or a different starting balance. */
export type Correction = 'entry' | 'opening' | false;

/**
 * The review's choices → the new Money. Merging ticks a planned entry done on the bank's
 * day, or keeps the one you typed and links it to the bank's lines; a session's tips replace
 * a busking amount typed by hand, or add to one from an earlier import. Lines from before
 * Money's first day move that day back, with the starting balances worked back so every
 * later day's balance stays as it was. `correct` makes up the difference from the bank's
 * balance: as done money in or out on the statement's day ('entry'), or in the account's
 * starting balance ('opening'), for when that was what was off.
 */
export function applyReview(money: Money, r: Review, newId: () => string, opts: { correct?: Correction } = {}): Applied {
  const chosen = r.proposals.filter((p) => p.action !== 'skip');
  const merges = new Map(chosen.filter((p) => p.action === 'merge' && p.match).map((p) => [p.match!.id, p]));
  let entries = money.entries.map((e): MoneyEntry => {
    const p = merges.get(e.id);
    if (!p) return e;
    const refs = [...new Set([...(e.refs ?? []), ...(p.entry.refs ?? [])])].slice(0, MAX_REFS);
    const amount = p.session ? (e.refs?.length ? cents(e.amount + p.entry.amount) : p.entry.amount) : p.entry.amount;
    const note = p.session && !e.refs?.length && /^\s*$/.test(e.note) ? p.entry.note : e.note || p.entry.note;
    return { ...e, planned: false, date: e.planned ? p.entry.date : e.date, amount, note, category: e.category || p.entry.category, refs };
  });
  const adds = chosen.filter((p) => p.action === 'add' || (p.action === 'merge' && !p.match)).map((p): MoneyEntry => ({ ...p.entry, id: newId() }));
  const room = Math.max(0, MAX_ENTRIES - entries.length);
  const added = adds.slice(0, room);
  entries = sortEntries([...entries, ...added]);

  // Lines from before the first day tracked: start earlier, and work each opening balance back.
  let { start, accounts } = money;
  const early = added.filter((e) => e.date < money.start);
  if (early.length) {
    start = early.reduce((a, e) => (e.date < a ? e.date : a), money.start);
    accounts = accounts.map((a) => ({ ...a, opening: cents(a.opening - early.reduce((s, e) => s + effectOn(e, a.id), 0)) }));
  }

  // Remember what each shop and person was called and put under, newest last.
  const learned = new Map((money.rules ?? []).map((x) => [x.id, x]));
  for (const p of chosen) {
    if (!p.rule || p.session) continue;
    const other = p.entry.kind === 'move' ? (p.entry.account === r.account ? p.entry.to : p.entry.account) : '';
    // Only a person can be you; a shop's move (a wallet top-up) is worked out from the bank's text each time.
    if (other && !p.rule.startsWith('p:')) continue;
    learned.delete(p.rule);
    // Nothing worth remembering: no category, and the name the bank's text gives anyway.
    const named = p.rule.startsWith('m:') && p.entry.note !== describe(p.lines[0], money, r.account).note;
    if (!other && !p.entry.category && !named) continue;
    learned.set(p.rule, other ? { id: p.rule, name: '', category: '', move: other } : { id: p.rule, name: p.rule.startsWith('m:') ? p.entry.note : '', category: p.entry.category });
  }
  const rules: MoneyRule[] = [...learned.values()].slice(-MAX_RULES);

  let next: Money = { ...money, start, accounts, entries, ...(rules.length ? { rules } : {}) };
  const balance = accountBalance(next, r.account, r.statement.asOf, true);
  let corrected = 0;
  const bank = r.statement.ledger;
  if (opts.correct && bank !== null && Math.abs(bank - balance) >= 0.005) {
    corrected = cents(bank - balance);
    if (opts.correct === 'opening') next = { ...next, accounts: next.accounts.map((a) => (a.id === r.account ? { ...a, opening: cents(a.opening + corrected) } : a)) };
    else if (next.entries.length < MAX_ENTRIES) {
      const fix: MoneyEntry = { id: newId(), date: r.statement.asOf, kind: corrected > 0 ? 'in' : 'out', amount: Math.abs(corrected), note: 'Balance correction (bank statement)', category: '', planned: false, account: r.account, to: '' };
      next = { ...next, entries: sortEntries([...next.entries, fix]) };
    } else corrected = 0;
  }
  const dropBills = [...new Set(chosen.flatMap((p) => (p.email?.pending ? [p.email.id] : [])))];
  return { money: next, added: added.length, merged: merges.size, dropBills, balance, corrected };
}

// ---------- for the review's summary ----------

export const isCategory = (v: string): v is MoneyCategory => (CATEGORIES as string[]).includes(v);

/** Merchants to ask Claude about: shops with no name or category learned yet. */
export function merchantsToAsk(st: Statement, money: Money): StatementAsk['merchants'] {
  const done = new Set(money.entries.flatMap((e) => e.refs ?? []));
  const rules = new Map((money.rules ?? []).map((r) => [r.id, r]));
  const account = accountFor(st, money);
  const out = new Map<string, StatementAsk['merchants'][number]>();
  for (const l of st.lines) {
    if (done.has(l.key)) continue;
    const d = describe(l, money, account);
    if (!d.merchant || d.kind === 'move' || out.has(d.merchant)) continue;
    const r = rules.get(`m:${d.merchant}`);
    if (r?.name && r.category) continue;
    out.set(d.merchant, { text: d.merchant, dir: l.dir, ...(d.country ? { country: d.country } : {}) });
  }
  return [...out.values()];
}
