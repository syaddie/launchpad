// The NAC Slot Finder's time maths and what the Music view shows, shared by the server
// (server/src/nac.ts) and the page. Everything is Singapore time, worked out from the
// moment itself rather than the runtime's time zone: SGT is UTC+8 all year.
import type { NacBooked, NacFree, NacSlots } from './types';

const SGT_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

export const DOW3 = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** The day in Singapore, YYYY-MM-DD. */
export function sgtYmd(d: Date): string {
  const t = new Date(d.getTime() + SGT_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Minutes since midnight in Singapore. */
export function sgtMinutes(d: Date): number {
  const t = new Date(d.getTime() + SGT_MS);
  return t.getUTCHours() * 60 + t.getUTCMinutes();
}

/** "2026-11-20T14:30:00+08:00" */
export function sgtIso(d: Date): string {
  const t = new Date(d.getTime() + SGT_MS);
  return `${sgtYmd(d)}T${pad2(t.getUTCHours())}:${pad2(t.getUTCMinutes())}:${pad2(t.getUTCSeconds())}+08:00`;
}

const utcOf = (ymd: string) => Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));

export function addDaysYmd(ymd: string, n: number): string {
  const t = new Date(utcOf(ymd) + n * DAY_MS);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** Whole days from `a` to `b`. */
export const daysBetween = (a: string, b: string) => Math.round((utcOf(b) - utcOf(a)) / DAY_MS);

/** 0 for Sunday. */
export const weekdayOf = (ymd: string) => new Date(utcOf(ymd)).getUTCDay();

/** "14:30" → 870. */
export function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/** 870 → "14:30"; 1440 is "24:00". */
export const hhmm = (min: number) => `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`;

/** "14:00" → "2 PM", "10:30" → "10:30 AM", "12:00" → "12 PM", "24:00" → "12 AM". */
export function ampm(t: string): string {
  const min = toMin(t);
  const h = Math.floor(min / 60) % 24;
  const m = min % 60;
  return `${h % 12 || 12}${m ? `:${pad2(m)}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Hours in a range: 5, 1.5. */
export const hoursOf = (r: { start: string; end: string }) => Math.round(((toMin(r.end) - toMin(r.start)) / 60) * 10) / 10;

/** "2 PM – 7 PM" */
export const fmtRange = (r: { start: string; end: string }) => `${ampm(r.start)} – ${ampm(r.end)}`;

/** "Tue 24 Nov" for a YYYY-MM-DD. */
export function fmtNacDay(ymd: string): string {
  return `${DOW3[weekdayOf(ymd)]} ${Number(ymd.slice(8, 10))} ${MONTH_NAMES[Number(ymd.slice(5, 7)) - 1].slice(0, 3)}`;
}

/**
 * "14:30" from an ISO time, in Singapore. Seen from `now`, a time on another day says which
 * ("yesterday 23:50", "tomorrow 09:15", "Sat 21 Nov 10:00"), except one in the next 12 hours:
 * at 23:50, "00:15" can only be the one coming.
 */
export function fmtClock(iso: string, now?: Date): string {
  const d = new Date(iso);
  const t = hhmm(sgtMinutes(d));
  if (!now) return t;
  const day = sgtYmd(d);
  const today = sgtYmd(now);
  const ahead = d.getTime() - now.getTime();
  if (day === today || (ahead > 0 && ahead < 12 * 3_600_000)) return t;
  if (day === addDaysYmd(today, 1)) return `tomorrow ${t}`;
  if (day === addDaysYmd(today, -1)) return `yesterday ${t}`;
  return `${fmtNacDay(day)} ${t}`;
}

// ---------- what the Music view shows ----------

/**
 * One location on one day:
 * - open: free windows (and maybe yours too)
 * - full: nothing free, every block yours or someone else's
 * - unknown: past the last booking seen there, so maybe just not open for booking yet; never free
 * - done: today, and its last block has ended
 */
export interface SlotRow {
  key: string;
  short: string;
  name: string;
  url: string;
  kind: 'open' | 'full' | 'unknown' | 'done';
  free: NacFree[];
  mine: NacBooked[];
}

export interface SlotDay {
  date: string;
  rows: SlotRow[];
}

export interface SlotView {
  days: SlotDay[];
  /** The last day any location knows about. */
  lastDate: string | null;
  freeWindows: number;
  newWindows: number;
  /** Locations with no bookings seen at all, so none of their days are known. */
  noBookings: string[];
}

/**
 * Drop the blocks of a run that have ended by `now` (minutes, today only). Windows are whole
 * 1-hour blocks from their start, so what's left starts at the block now is in.
 */
function ahead<T extends { start: string; end: string }>(runs: T[], nowMin: number | null): T[] {
  if (nowMin === null) return runs;
  return runs.flatMap((r) => {
    const s = toMin(r.start);
    const e = toMin(r.end);
    if (e <= nowMin) return [];
    const start = s + 60 * Math.max(0, Math.floor((nowMin - s) / 60));
    return [start === s ? r : { ...r, start: hhmm(start) }];
  });
}

/**
 * The days to show, grouped by date and then location (in config order), from today to the last
 * day any location knows. The server already left out blocks that had ended when it checked;
 * this drops the ones that have ended since, so data from a failed check's last good run never
 * shows a slot that's over as free.
 */
export function slotView(s: Pick<NacSlots, 'locations'>, now: Date): SlotView {
  const today = sgtYmd(now);
  const nowMin = sgtMinutes(now);
  const ends = s.locations.map((l) => l.horizon_end).filter((d): d is string => !!d && d >= today);
  const lastDate = ends.length ? ends.reduce((a, b) => (b > a ? b : a)) : null;
  const days: SlotDay[] = [];
  let freeWindows = 0;
  let newWindows = 0;
  for (let date = today; lastDate && date <= lastDate; date = addDaysYmd(date, 1)) {
    const rows = s.locations.map((l): SlotRow => {
      const base = { key: l.key, short: l.short, name: l.name, url: l.url, free: [] as NacFree[], mine: [] as NacBooked[] };
      if (!l.horizon_end || date > l.horizon_end) return { ...base, kind: 'unknown' };
      const day = l.days.find((d) => d.date === date);
      // Inside the horizon every day is listed, except today once its last block has ended.
      if (!day) return { ...base, kind: date === today ? 'done' : 'unknown' };
      const cut = date === today ? nowMin : null;
      const free = ahead(day.free, cut);
      const mine = ahead(day.mine, cut);
      if (!free.length && !mine.length && !ahead(day.taken, cut).length) return { ...base, kind: 'done' };
      freeWindows += free.length;
      newWindows += free.filter((w) => w.new).length;
      return { ...base, kind: free.length ? 'open' : 'full', free, mine };
    });
    // Late in the day, once every location's slots are over, today has nothing to say.
    if (date === today && rows.every((r) => r.kind === 'done' || r.kind === 'unknown')) continue;
    days.push({ date, rows });
  }
  return { days, lastDate, freeWindows, newWindows, noBookings: s.locations.filter((l) => !l.horizon_end).map((l) => l.short) };
}
