// The NAC Slot Finder's time maths and what the Music view shows, shared by the server
// (server/src/nac.ts) and the page. Everything is Singapore time, worked out from the
// moment itself rather than the runtime's time zone: SGT is UTC+8 all year.
import type { NacBooked, NacFree, NacPlace, NacSlots } from './types';

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

// ---------- the locations it checks ----------

/** Each location adds two requests and tens of MB (its busker photos) to every check, so not too many. */
export const NAC_MAX_PLACES = 8;
export const NAC_NAME_MAX = 50;
export const NAC_SHORT_MAX = 20;

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The location id in a NAC link (…/Busking/locations/<id>/events), or a bare id; '' when there's none. */
export function nacPlaceId(link: string): string {
  const s = String(link ?? '').trim();
  const inPath = /\/locations\/([0-9a-f-]{36})(?=[/?#]|$)/i.exec(s)?.[1];
  const id = inPath ?? (/^[0-9a-f-]{36}$/i.test(s) ? s : '');
  return GUID_RE.test(id) ? id.toLowerCase() : '';
}

/** Words kept in capitals when NAC's all-caps names are tidied: MRT lines and the like. */
const CAPS = new Set(['MRT', 'LRT', 'DTL', 'EWL', 'NSL', 'NEL', 'CCL', 'TEL', 'BPL', 'SKL', 'PGL', 'HDB', 'NAC', 'CBD', 'ITE', 'NUS', 'NTU', 'SMU', 'SUTD', 'SIT', 'SUSS', 'ION']);
const SMALL = new Set(['and', 'of', 'the', 'at', 'in', 'on', 'by']);
/** The bit before or after " - " that says nothing about where: "MRT STATION". */
const GENERIC = /^(?:(?:mrt|lrt)(?: station)?|station|bus interchange|interchange)$/i;
/** A line's code in front of a station: "DTL TAMPINES". */
const LINE = /^(?:dtl|ewl|nsl|nel|ccl|tel|bpl|skl|pgl)\s+/i;

const tidyWord = (w: string, i: number) => {
  const up = w.toUpperCase();
  if (CAPS.has(up) || /\d/.test(w) || !/[a-z]/i.test(w)) return CAPS.has(up) ? up : w;
  const low = w.toLowerCase();
  if (i > 0 && SMALL.has(low)) return low;
  return low.replace(/(^|[-'’(/])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase());
};
const tidy = (s: string) => s.trim().split(/\s+/).map(tidyWord).join(' ');

/**
 * Names to start from for a location NAC calls "MRT STATION - DTL TAMPINES": "MRT Station - DTL
 * Tampines" and "Tampines"; "CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3" gives "Changi Village".
 */
export function guessNacNames(nac: string): { name: string; short: string } {
  const name = tidy(nac.replace(/\s+/g, ' ')).slice(0, NAC_NAME_MAX).trim() || 'NAC location';
  const parts = nac.split(/\s+-\s+/).map((p) => p.trim()).filter(Boolean);
  const where = parts.find((p) => !GENERIC.test(p)) ?? parts[0] ?? nac;
  const short = tidy(where.replace(LINE, '')).slice(0, NAC_SHORT_MAX).trim();
  return { name, short: short || name.slice(0, NAC_SHORT_MAX).trim() };
}

/** A key for a new location from its short name: "Paya Lebar" → "paya-lebar", "paya-lebar-2" if that's taken. */
export function nacPlaceKey(short: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = short.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'place';
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}-${n}`;
  return key;
}

/** A name from the page or a backup, trimmed and cut to fit; '' when there's nothing left. */
const cleanName = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');

/**
 * A saved list of locations, checked: entries without a real id or a name are dropped, as are
 * repeats of an id or key; at most NAC_MAX_PLACES. Null when it isn't a list at all.
 */
export function cleanNacPlaces(v: unknown): NacPlace[] | null {
  if (!Array.isArray(v)) return null;
  const out: NacPlace[] = [];
  for (const p of v as Partial<NacPlace>[]) {
    if (!p || typeof p !== 'object' || out.length >= NAC_MAX_PLACES) continue;
    const id = nacPlaceId(String(p.id ?? ''));
    const name = cleanName(p.name, NAC_NAME_MAX);
    const short = cleanName(p.short, NAC_SHORT_MAX) || name.slice(0, NAC_SHORT_MAX).trim();
    const key = typeof p.key === 'string' && /^[a-z0-9-]{1,40}$/.test(p.key) ? p.key : nacPlaceKey(short, out.map((x) => x.key));
    if (!id || !name || out.some((x) => x.id === id || x.key === key)) continue;
    out.push({ key, id, nac: cleanName(p.nac, 120), name, short });
  }
  return out;
}

/**
 * Codes for the calendar's tight cells, unique among the locations: initials for a name of two
 * or more words ("Paya Lebar" → "PL"), the first three letters otherwise ("Tampines" → "TAM").
 */
export function nacCodes(places: { key: string; short: string }[]): Record<string, string> {
  const out: Record<string, string> = {};
  const used = new Set<string>();
  for (const p of places) {
    const words = p.short.toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const letters = words.join('');
    const tries = [words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3) : letters.slice(0, 3), letters.slice(0, 3), letters.slice(0, 2) + (letters[letters.length - 1] ?? '')].filter(Boolean);
    let code = tries.find((t) => !used.has(t)) ?? '';
    for (let n = 2; !code || used.has(code); n++) code = (tries[0] || 'L').slice(0, 2) + n;
    used.add(code);
    out[p.key] = code;
  }
  return out;
}

// ---------- the calendar ----------

/** Weeks of seven days, Monday first, from the week `from` is in to the week `to` is in. */
export function calendarWeeks(from: string, to: string): string[][] {
  const start = addDaysYmd(from, -((weekdayOf(from) + 6) % 7));
  const weeks: string[][] = [];
  for (let d = start; d <= to; d = addDaysYmd(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDaysYmd(d, i)));
  return weeks;
}

/** "November 2026", or "November – December 2026" across two, for the calendar's heading. */
export function monthsLabel(from: string, to: string): string {
  const name = (ymd: string) => MONTH_NAMES[Number(ymd.slice(5, 7)) - 1];
  const [y1, y2] = [from.slice(0, 4), to.slice(0, 4)];
  if (from.slice(0, 7) === to.slice(0, 7)) return `${name(from)} ${y1}`;
  return y1 === y2 ? `${name(from)} – ${name(to)} ${y2}` : `${name(from)} ${y1} – ${name(to)} ${y2}`;
}

/** Free hours in a row, for a calendar cell: 5, 1.5. */
export const freeHours = (free: { start: string; end: string }[]) => Math.round(free.reduce((n, w) => n + hoursOf(w), 0) * 10) / 10;
