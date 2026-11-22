// Invoices as documents: what an invoice in Owed prints as (its rows, who it's billed to, your
// details), the setup each new one starts from, and cleaning both. The money side of an invoice
// (its amount as planned money in) stays in money.ts; an invoice made here has its amount worked
// out from its rows.
import { MON, pad2, parseYmd, ymd } from './dates';
import type { Invoice, InvoiceClient, InvoiceDoc, InvoiceFrom, InvoiceItem, InvoiceLine, InvoicePay, InvoiceSetup } from './types';

export const MAX_LINES = 30;
export const MAX_CLIENTS = 30;
export const MAX_ITEMS = 20;
export const MAX_PAY = 3;
/** Printed beside the amount due; everything in Money is Singapore dollars. */
export const CURRENCY = 'SGD';
export const DEFAULT_TERMS = 'Payment within 30 days of the invoice date.';
export const DEFAULT_THANKS = 'Thank you for your business!';

const cents = (n: number) => Math.round(n * 100) / 100;

export const lineAmount = (l: Pick<InvoiceLine, 'qty' | 'rate'>) => cents(l.qty * l.rate);
export const docTotal = (lines: Pick<InvoiceLine, 'qty' | 'rate'>[]) => cents(lines.reduce((a, l) => a + lineAmount(l), 0));

/** "$1,250.00", "−$100.00": an invoice always shows the cents. */
export function fmtInvMoney(n: number): string {
  const v = cents(n);
  const s = '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return v < 0 ? '−' + s : s;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && ymd(parseYmd(v)) === v;

/** "06 Oct 2026", or empty for no date. */
export function fmtInvDate(s: string): string {
  if (!isDate(s)) return '';
  const d = parseYmd(s);
  return `${pad2(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}`;
}

/** "1", "2.5" */
export const fmtQty = (n: number) => String(cents(n));

/**
 * The PDF's name, the way the old ones were named: "INV013_NPRedCamp_16112026" for invoice 013
 * for "NP RED Camp 2026" dated 16 Nov 2026. Short words stay as typed ("NP"), longer ones are
 * capitalised ("RED" → "Red"), and a year in the event's name is left out (the date has it).
 */
export function invoiceFileName(num: string, event: string, issued: string): string {
  const n = num.replace(/[^A-Za-z0-9]/g, '');
  const head = !n ? 'Invoice' : /^[A-Za-z]/.test(n) ? n : 'INV' + n;
  const words = event
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter((w) => w && !/^(19|20)\d\d$/.test(w))
    .map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()));
  const d = isDate(issued) ? parseYmd(issued) : null;
  return [head, words.join('').slice(0, 60), d ? `${pad2(d.getDate())}${pad2(d.getMonth() + 1)}${d.getFullYear()}` : ''].filter(Boolean).join('_');
}

export const emptyFrom = (): InvoiceFrom => ({ name: '', address: '', phone: '', email: '' });
export const emptyClient = (): InvoiceClient => ({ company: '', attn: '', address: '', phone: '' });

/** Before the first invoice: nothing about you (that's typed in once), and a few rows to add in a tap. */
export const starterSetup = (): InvoiceSetup => ({
  from: emptyFrom(),
  pay: [],
  terms: DEFAULT_TERMS,
  thanks: DEFAULT_THANKS,
  dueDays: 30,
  clients: [],
  items: [
    { id: 'q-discount', desc: 'Discount', note: '', rate: null },
    { id: 'q-sound', desc: 'Sound system fee', note: '', rate: null },
    { id: 'q-festive', desc: 'Festive period fee', note: '', rate: null },
  ],
  lastNum: '',
});

/** For an invoice added before there was a form: its amount as one row, dated today, from you as you are now. */
export function docFor(inv: Invoice, setup: InvoiceSetup, today: string): InvoiceDoc {
  return {
    issued: today,
    client: emptyClient(),
    eventDate: '',
    venue: '',
    lines: [{ desc: inv.event || 'Performance', note: '', qty: 1, rate: inv.amount }],
    from: { ...setup.from },
    pay: setup.pay.map((p) => ({ ...p })),
    terms: setup.terms,
    thanks: setup.thanks,
  };
}

const sameCompany = (a: InvoiceClient, b: InvoiceClient) => a.company.trim().toLowerCase() === b.company.trim().toLowerCase();

/** Remembers who an invoice went to: first in the list, replacing the same company's old details. */
export function rememberClient(list: InvoiceClient[], c: InvoiceClient): InvoiceClient[] {
  if (!c.company.trim()) return list;
  return [{ ...c, company: c.company.trim() }, ...list.filter((x) => !sameCompany(x, c))].slice(0, MAX_CLIENTS);
}

// ---------- cleaning what the page sends ----------

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9 ? cents(v) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function cleanFrom(v: unknown): InvoiceFrom {
  const x = obj(v);
  return { name: str(x.name, 80), address: str(x.address, 240), phone: str(x.phone, 40), email: str(x.email, 120) };
}

function cleanClient(v: unknown): InvoiceClient {
  const x = obj(v);
  return { company: str(x.company, 120), attn: str(x.attn, 80), address: str(x.address, 240), phone: str(x.phone, 40) };
}

function cleanPay(v: unknown): InvoicePay[] {
  return list(v)
    .map((p) => obj(p))
    .map((p) => ({ label: str(p.label, 40), value: str(p.value, 60), note: str(p.note, 60) }))
    .filter((p) => p.label.trim() || p.value.trim())
    .slice(0, MAX_PAY);
}

function cleanLine(v: unknown): InvoiceLine | null {
  const x = obj(v);
  const qty = finite(x.qty);
  const rate = finite(x.rate);
  const line = { desc: str(x.desc, 160), note: str(x.note, 160), qty: qty ?? 1, rate: rate ?? 0 };
  return line.desc.trim() || line.rate ? line : null;
}

/** An invoice's document, or nothing when it has no date or no rows. */
export function cleanInvoiceDoc(v: unknown): InvoiceDoc | undefined {
  const x = obj(v);
  const lines = list(x.lines).slice(0, MAX_LINES).map(cleanLine).filter((l): l is InvoiceLine => l !== null);
  if (!isDate(x.issued) || !lines.length) return undefined;
  return {
    issued: x.issued,
    client: cleanClient(x.client),
    eventDate: isDate(x.eventDate) ? x.eventDate : '',
    venue: str(x.venue, 120),
    lines,
    from: cleanFrom(x.from),
    pay: cleanPay(x.pay),
    terms: str(x.terms, 1000),
    thanks: str(x.thanks, 120),
  };
}

/** The invoice form's setup, or nothing when none was sent. */
export function cleanInvoiceSetup(v: unknown): InvoiceSetup | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const x = obj(v);
  const base = starterSetup();
  const days = typeof x.dueDays === 'number' && Number.isInteger(x.dueDays) && x.dueDays >= 0 && x.dueDays <= 365 ? x.dueDays : base.dueDays;
  const seen = new Set<string>();
  const items = list(x.items).flatMap((it): InvoiceItem[] => {
    const i = obj(it);
    const id = str(i.id, 40);
    const desc = str(i.desc, 160);
    if (!id || seen.has(id) || !desc.trim()) return [];
    seen.add(id);
    return [{ id, desc, note: str(i.note, 160), rate: finite(i.rate) }];
  });
  const clients = list(x.clients)
    .map(cleanClient)
    .reduceRight((acc: InvoiceClient[], c) => rememberClient(acc, c), [])
    .slice(0, MAX_CLIENTS);
  return {
    from: cleanFrom(x.from),
    pay: cleanPay(x.pay),
    terms: typeof x.terms === 'string' ? str(x.terms, 1000) : base.terms,
    thanks: typeof x.thanks === 'string' ? str(x.thanks, 120) : base.thanks,
    dueDays: days,
    clients,
    items: items.slice(0, MAX_ITEMS),
    lastNum: str(x.lastNum, 24),
  };
}
