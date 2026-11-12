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

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

// Longest first, so "friday" isn't read as "fri" + "day".
const WEEKDAY = Object.keys(DAYW).sort((a, b) => b.length - a.length).join('|');
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

// Written-out dates: "14 nov", "14th November 2026", "nov 14", "Nov 14, 2026", "14/11", "14/11/2026", "2026-11-14".
const EXPLICIT = [
  `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})\\.?(?:,?\\s+(\\d{4}))?`,
  `(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
  `(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2,4}))?`,
  `(\\d{4})-(\\d{2})-(\\d{2})`,
];
/** A written-out date, optionally after its weekday ("Fri 31 Oct"). */
const WRITTEN = `(?:(?:${WEEKDAY}),?\\s+)?(?:${EXPLICIT.join('|')})`;
/** A day said relative to today. */
const RELATIVE = `today|tod|tonight|tomorrow|tmr|tmrw|tmw|next week|in\\s+\\d{1,2}\\s+(?:days?|weeks?)|(?:next\\s+|this\\s+)?(?:${WEEKDAY})`;
/** Any one way of saying a day. */
const DAY = `${WRITTEN}|${RELATIVE}`;

/**
 * A date without a year is the one nearest today: up to two months back (a deadline just
 * missed) or otherwise ahead, so "5 jan" said in November is next January.
 */
function nearestYear(month: number, day: number, today: Date): Date | null {
  if (!(month >= 0 && month < 12)) return null;
  for (const y of [today.getFullYear() - 1, today.getFullYear(), today.getFullYear() + 1]) {
    const d = exact(y, month, day);
    if (!d) return null;
    const off = dayDiff(today, d);
    if (off >= -60 && off < 306) return d;
  }
  return null;
}

function exact(y: number, month: number, day: number): Date | null {
  const d = new Date(y < 100 ? 2000 + y : y, month, day);
  return d.getMonth() === month && d.getDate() === day ? d : null;
}

/** One way of saying a day (anything DAY matches) → the date it means, or null. A weekday is the next one, never today. */
export function readDay(phrase: string, today: Date): Date | null {
  const p = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
  const t = startOfDay(today);
  const dow = t.getDay();
  if (p === 'today' || p === 'tod' || p === 'tonight') return t;
  if (p === 'tomorrow' || p === 'tmr' || p === 'tmrw' || p === 'tmw') return addDays(t, 1);
  if (p === 'next week') return addDays(t, ((1 - dow + 7) % 7) || 7);
  let m = p.match(/^in (\d{1,2}) (day|week)s?$/);
  if (m) return addDays(t, Number(m[1]) * (m[2] === 'week' ? 7 : 1));
  m = p.match(new RegExp(`^(next |this )?(${WEEKDAY})$`));
  if (m) {
    // "next fri" is the Friday of next week (weeks start on Monday).
    if (m[1] === 'next ') return addDays(t, (((1 - dow + 7) % 7) || 7) + ((DAYW[m[2]] + 6) % 7));
    return addDays(t, ((DAYW[m[2]] - dow + 7) % 7) || 7);
  }
  const bare = p.replace(new RegExp(`^(?:${WEEKDAY}),? `), '');
  const n = Number;
  if ((m = bare.match(new RegExp(`^${EXPLICIT[0]}$`)))) return m[3] ? exact(n(m[3]), MONTHS[m[2]], n(m[1])) : nearestYear(MONTHS[m[2]], n(m[1]), t);
  if ((m = bare.match(new RegExp(`^${EXPLICIT[1]}$`)))) return m[3] ? exact(n(m[3]), MONTHS[m[1]], n(m[2])) : nearestYear(MONTHS[m[1]], n(m[2]), t);
  if ((m = bare.match(new RegExp(`^${EXPLICIT[2]}$`)))) return m[3] ? exact(n(m[3]), n(m[2]) - 1, n(m[1])) : nearestYear(n(m[2]) - 1, n(m[1]), t);
  if ((m = bare.match(new RegExp(`^${EXPLICIT[3]}$`)))) return exact(n(m[1]), n(m[2]) - 1, n(m[3]));
  return null;
}

/**
 * Split a trailing date off a new task: "call bank fri" → { title: "call bank", due: <Fri> }.
 * Supports today/tod, tomorrow/tmr/tmrw, weekday names (next occurrence, never today),
 * "next week" (next Monday), "in 3 days" and dates like "14 nov" or "14/11".
 */
export function parseDue(text: string, today: Date): { title: string; due?: string } {
  const m = text.trim().match(new RegExp(`^(.+?)\\s+(?:(?:on|by|due)\\s+)?(${DAY})$`, 'i'));
  const d = m && readDay(m[2], today);
  if (!m || !d) return { title: text.trim() };
  return { title: m[1].trim(), due: ymd(d) };
}

/** A due date typed on its own ("fri", "14 nov", "tmr"): the day, '' to clear it ("none", "no date"), or undefined when it doesn't read as one. */
export function parseDueWord(text: string, today: Date): string | undefined {
  const t = text.trim().replace(/^(on|by|due)\s+/i, '');
  if (/^(none|no date|clear|never|-)?$/i.test(t)) return '';
  if (!new RegExp(`^(?:${DAY})$`, 'i').test(t)) return undefined;
  const d = readDay(t, today);
  return d ? ymd(d) : undefined;
}

/**
 * The first date in some text, e.g. a deadline the inbox digest found ("by Fri 31 Oct",
 * "pay before 20/11"). A written-out date wins over a weekday or "tomorrow". Null when there's none.
 */
export function findDay(text: string, today: Date): string | null {
  for (const src of [WRITTEN, RELATIVE]) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w/-])(?:${src})(?![\\w/-])`, 'gi'))) {
      const d = readDay(m[0], today);
      if (d) return ymd(d);
    }
  }
  return null;
}

// ---------- calendar events ----------

/** What "lunch w/ Dan fri 1pm" was read as. Times are minutes from midnight on `date`; `end` can pass midnight. */
export interface EventDraft {
  title: string;
  /** YYYY-MM-DD it starts on. */
  date: string;
  allDay: boolean;
  start: number;
  end: number;
  /** A day, a time or "all day" was found. Without one it's today, all day. */
  understood: boolean;
}

/** How long an event without an end time lasts. */
export const DEFAULT_EVENT_MINUTES = 60;

const AMPM = '(am|pm|a\\.m\\.|p\\.m\\.)';
const CLOCK = `(\\d{1,2})(?:[:.](\\d{2}))?\\s*${AMPM}?`;
const AFTER = '(?=[\\s,.;]|$)';

function toMinutes(h: string, m: string | undefined, ampm: string | undefined): number | null {
  let hour = Number(h);
  const min = m ? Number(m) : 0;
  if (min > 59) return null;
  const half = ampm?.[0].toLowerCase();
  if (half) {
    if (hour < 1 || hour > 12) return null;
    if (half === 'p' && hour < 12) hour += 12;
    if (half === 'a' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return hour * 60 + min;
}

/** "1-2pm": the start takes the end's am/pm, unless that puts it after the end ("11-1pm" is 11am). And the other way round. */
function rangeMinutes(h1: string, m1: string | undefined, a1: string | undefined, h2: string, m2: string | undefined, a2: string | undefined): [number, number] | null {
  const flip = (a: string) => (/^p/i.test(a) ? 'am' : 'pm');
  let half1 = a1;
  let half2 = a2;
  if (!half1 && half2) {
    half1 = half2;
    const a = toMinutes(h1, m1, half1);
    const b = toMinutes(h2, m2, half2);
    if (a !== null && b !== null && a > b && Number(h1) !== 12) half1 = flip(half2);
  } else if (half1 && !half2) {
    half2 = half1;
    const a = toMinutes(h1, m1, half1);
    const b = toMinutes(h2, m2, half2);
    if (a !== null && b !== null && b <= a && Number(h2) !== 12) half2 = flip(half1);
  }
  const start = toMinutes(h1, m1, half1);
  let end = toMinutes(h2, m2, half2);
  if (start === null || end === null) return null;
  if (end <= start) end += 1440;
  return [start, end];
}

/**
 * Read a new calendar event typed in plain words: "lunch w/ Dan fri 1pm",
 * "dentist 14 nov 3:30-4:30pm", "flight to KL sat all day", "gym tmr 7am for 90 min".
 * A day without a time is all day; a time without a day is today, or tomorrow once it's
 * passed. Without an end it lasts an hour.
 */
export function parseEvent(text: string, now: Date): EventDraft {
  let s = ` ${text.trim()} `;
  /** Find `re` and take what it matched out of the text. */
  const cut = (re: RegExp, ok: (m: RegExpMatchArray) => boolean = () => true): RegExpMatchArray | null => {
    const m = s.match(re);
    if (!m || !ok(m)) return null;
    s = s.slice(0, m.index!) + ' ' + s.slice(m.index! + m[0].length);
    return m;
  };
  let allDay = !!cut(/\sall[- ]?day(?=[\s,.;])/i);
  let start: number | null = null;
  let end: number | null = null;

  // A range: "3:30-4:30pm", "1-2pm", "10am to 12pm", "from 9:00 till 11:30". One side needs am/pm
  // or minutes, so "3-4" alone isn't taken for a time.
  const range = cut(
    new RegExp(`\\s(?:from\\s+|at\\s+|@\\s*)?${CLOCK}\\s*(?:-|–|to|till|until)\\s*${CLOCK}${AFTER}`, 'i'),
    (m) => !!(m[2] || m[3] || m[5] || m[6]) && !!rangeMinutes(m[1], m[2], m[3], m[4], m[5], m[6]),
  );
  if (range) [start, end] = rangeMinutes(range[1], range[2], range[3], range[4], range[5], range[6])!;
  else {
    const named = cut(new RegExp(`\\s(?:at\\s+|@\\s*)?(noon|midday|midnight)${AFTER}`, 'i'));
    const one = named ? null : cut(new RegExp(`\\s(?:at\\s+|@\\s*)?(\\d{1,2})(?:[:.](\\d{2}))?\\s*${AMPM}${AFTER}`, 'i'), (m) => toMinutes(m[1], m[2], m[3]) !== null);
    const clock = named || one ? null : cut(new RegExp(`\\s(?:at\\s+|@\\s*)?(\\d{1,2}):(\\d{2})${AFTER}`), (m) => toMinutes(m[1], m[2], undefined) !== null);
    // A bare "at 3" is in the afternoon; "at 9" in the morning.
    const bare = named || one || clock ? null : cut(new RegExp(`\\s(?:at|@)\\s*(\\d{1,2})${AFTER}`, 'i'), (m) => Number(m[1]) <= 23);
    if (named) start = /night/i.test(named[1]) ? 0 : 720;
    else if (one) start = toMinutes(one[1], one[2], one[3]);
    else if (clock) start = toMinutes(clock[1], clock[2], undefined);
    else if (bare) start = toMinutes(bare[1], undefined, Number(bare[1]) >= 1 && Number(bare[1]) <= 6 ? 'pm' : undefined);
  }
  const dur = cut(new RegExp(`\\sfor\\s+(an?|half an|\\d+(?:\\.\\d+)?)\\s*(h|hrs?|hours?|m|mins?|minutes?)${AFTER}`, 'i'));
  if (start !== null && end === null) {
    let minutes = DEFAULT_EVENT_MINUTES;
    if (dur) {
      const n = /^half/i.test(dur[1]) ? 0.5 : /^an?$/i.test(dur[1]) ? 1 : Number(dur[1]);
      minutes = Math.round(/^h/i.test(dur[2]) ? n * 60 : n);
    }
    end = start + Math.max(5, minutes);
  }

  const day = cut(new RegExp(`\\s(?:on\\s+)?(${DAY})${AFTER}`, 'i'), (m) => !!readDay(m[1], now));
  let date = day ? readDay(day[1], now)! : null;
  const understood = !!(date || start !== null || allDay);
  if (!date) {
    // A time with no day: today, or tomorrow if that time has already gone.
    const mins = now.getHours() * 60 + now.getMinutes();
    date = start !== null && start <= mins ? addDays(startOfDay(now), 1) : startOfDay(now);
  }
  if (start === null) {
    allDay = true;
    start = 0;
    end = 1440;
  } else allDay = false;
  const title = s
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(?:\s+|^)(?:at|on|from|for|@|-|,)$/i, '')
    .replace(/^(?:-|,)\s*/, '')
    .trim();
  return { title, date: ymd(date), allDay, start, end: end!, understood };
}
