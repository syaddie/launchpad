// Calendar-day helpers. Everything works in the runtime's local time zone,
// which is Asia/Singapore both in the browser and in the container (TZ env).

export const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const pad2 = (n: number) => String(n).padStart(2, '0');

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** YYYY-MM-DD for the local calendar day of d. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local midnight of a YYYY-MM-DD string. */
export function parseYmd(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole calendar days from `from` to `to` (local days, DST-safe). */
export function dayDiff(from: Date, to: Date): number {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86400000);
}

const DAYW: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};

/**
 * Split a trailing date word off a new task: "call bank fri" → { title: "call bank", due: <Fri> }.
 * Supports today/tod, tomorrow/tmr/tmrw, weekday names (next occurrence, never today) and "next week" (next Monday).
 */
export function parseDue(text: string, today: Date): { title: string; due?: string } {
  const m = text.trim().match(/^(.+?)\s+(today|tod|tomorrow|tmr|tmrw|next week|[a-z]+)$/i);
  if (!m) return { title: text.trim() };
  const w = m[2].toLowerCase();
  const dow = today.getDay();
  let offset: number | undefined;
  if (w === 'today' || w === 'tod') offset = 0;
  else if (w === 'tomorrow' || w === 'tmr' || w === 'tmrw') offset = 1;
  else if (w === 'next week') offset = ((1 - dow + 7) % 7) || 7;
  else if (w in DAYW) offset = ((DAYW[w] - dow + 7) % 7) || 7;
  if (offset === undefined) return { title: text.trim() };
  return { title: m[1].trim(), due: ymd(addDays(today, offset)) };
}
