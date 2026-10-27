// Pull tracking numbers out of shipping emails. Kept free of I/O so it can be unit tested.
import { detectCarrier } from '../../shared/carriers';
import type { InboxEmail } from '../../shared/types';

export interface Candidate {
  number: string;
  carrier: string;
}

// Formats distinctive enough to trust anywhere in an email.
const DISTINCT: RegExp[] = [
  /\bSP[A-Z]{2,4}\d{9,15}\b/g, // SingPost Speedpost, e.g. SPNSV000000518244
  /\b[A-Z]{2}\d{9}SG\b/g, // SingPost registered / UPU
  /\bNV[A-Z0-9]{10,24}\b/g, // Ninja Van
  /\bJT\d{10,16}[A-Z]{0,2}\b/g, // J&T Express
  /\b1Z[A-Z0-9]{16}\b/g, // UPS
  /\bQX[A-Z0-9]{8,20}\b/g, // Qxpress
];

// Generic numbers (DHL's 10 digits, FedEx's 12) only count right after a tracking keyword.
const KEYWORD = /(?:tracking|track(?:ing)?\s*(?:no|number|#)|awb|air\s*waybill|waybill|consignment)\b[^A-Za-z0-9]{0,40}([A-Z0-9]{8,30})\b/gi;

const SENDER_CARRIER: [RegExp, string][] = [
  [/dhl/i, 'DHL'],
  [/fedex/i, 'FedEx'],
  [/ups\.com/i, 'UPS'],
  [/singpost|speedpost/i, 'SingPost'],
  [/ninjavan/i, 'Ninja Van'],
  [/jtexpress|j&t/i, 'J&T Express'],
  [/qxpress/i, 'Qxpress'],
];

const digitCount = (s: string) => (s.match(/\d/g) || []).length;

export function extractTrackingNumbers(text: string, from = ''): Candidate[] {
  const found = new Map<string, string>();
  for (const re of DISTINCT) {
    for (const m of text.matchAll(re)) {
      const n = m[0];
      if (digitCount(n) >= 6) found.set(n, detectCarrier(n));
    }
  }
  for (const m of text.matchAll(KEYWORD)) {
    const n = m[1].toUpperCase();
    if (found.has(n) || digitCount(n) < 6) continue;
    let carrier = detectCarrier(n);
    if (!carrier) carrier = SENDER_CARRIER.find(([re]) => re.test(from))?.[1] || '';
    if (carrier) found.set(n, carrier);
  }
  return [...found].filter(([, c]) => c).map(([number, carrier]) => ({ number, carrier }));
}

/** "Shopee <info@mail.shopee.sg>" → "Shopee". */
export function senderName(from: string): string {
  const name = from.replace(/<[^>]*>/, '').replace(/"/g, '').trim();
  if (name) return name;
  const domain = from.match(/@([^>\s]+)/)?.[1] || '';
  const base = domain.split('.').filter((p) => !/^(mail|email|e|info|noreply|no-reply|com|sg|co|net)$/i.test(p))[0] || domain;
  return base ? base[0].toUpperCase() + base.slice(1) : 'Email';
}

export function labelFor(from: string, subject: string): string {
  const s = subject.replace(/^(re|fwd?):\s*/i, '').trim();
  const label = `${senderName(from)}: ${s || 'parcel'}`;
  return label.length > 60 ? label.slice(0, 57).trimEnd() + '…' : label;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/[ \t]+/g, ' ');
}

// ---------- inbox ----------

/** An inbox email plus the excerpt of its body that goes to Claude (never sent to the page). */
export interface StoredEmail extends InboxEmail {
  body: string;
}

const CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: 'primary',
  CATEGORY_UPDATES: 'updates',
  CATEGORY_PROMOTIONS: 'promotions',
  CATEGORY_SOCIAL: 'social',
  CATEGORY_FORUMS: 'forums',
};

/** Promotions and social notifications are summed up from the subject and snippet alone. */
export const BODY_CATEGORIES = new Set(['primary', 'updates', 'forums']);
const BODY_CHARS = 1000;

/** Body text trimmed for a prompt: no quoted replies, links or runs of blank lines. */
export function cleanBody(text: string, max = BODY_CHARS): string {
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const l = line.trim();
    // Everything after "On Mon, 27 Oct … wrote:" or a forwarded/quoted block is older mail.
    if (/^On .{6,120}wrote:$/.test(l) || /^-{2,}\s*(Original|Forwarded) Message/i.test(l) || /^>/.test(l)) break;
    lines.push(l.replace(/https?:\/\/\S+/g, '').replace(/[ \t]{2,}/g, ' ').trim());
  }
  const out = lines.join('\n').replace(/\n{2,}/g, '\n').trim();
  return out.length > max ? out.slice(0, max).trimEnd() + '…' : out;
}

/** "DBS <alerts@dbs.com>" → "alerts@dbs.com". */
export function senderEmail(from: string): string {
  return (from.match(/<([^>]+)>/)?.[1] || from).trim().toLowerCase();
}

const decodeEntities = (s: string) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** A Gmail API message (format=full) and its body text → what the inbox keeps. */
export function parseInboxMessage(msg: any, body: string): StoredEmail {
  const headers: { name: string; value: string }[] = msg.payload?.headers || [];
  const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value || '';
  const labels: string[] = msg.labelIds || [];
  const from = h('from');
  const category = labels.map((l) => CATEGORIES[l]).find(Boolean) || 'primary';
  return {
    id: msg.id,
    threadId: msg.threadId || msg.id,
    from: senderName(from),
    fromEmail: senderEmail(from),
    subject: h('subject').trim() || '(no subject)',
    // Gmail escapes snippets as HTML.
    snippet: decodeEntities(msg.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    at: new Date(Number(msg.internalDate) || Date.parse(h('date')) || Date.now()).toISOString(),
    unread: labels.includes('UNREAD'),
    category,
    body: BODY_CATEGORIES.has(category) ? cleanBody(body) : '',
  };
}
