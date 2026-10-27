// Pull tracking numbers out of shipping emails. Kept free of I/O so it can be unit tested.
import { detectCarrier } from '../../shared/carriers';

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
