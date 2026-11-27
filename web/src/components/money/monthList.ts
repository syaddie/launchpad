// The pure parts of Money › Month's list and calendar (MonthTab.tsx, MonthCalendar.tsx), tested in
// test/money-month.test.ts: the entries a day at a time, what each day is called, where the arrow
// keys go on the calendar and how far to scroll the list to show a day or an entry.
import { addDays, dayDiff, parseYmd, ymd } from '../../../../shared/dates';
import type { MoneyEntry } from '../../../../shared/types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** One day of the list. A day with no entries is only there when it's the one picked on the calendar. */
export interface DayGroup {
  date: string;
  list: MoneyEntry[];
}

/**
 * The entries a day at a time (they come sorted by date). `empty` is a day picked on the calendar:
 * when it has no entries it gets a group of its own anyway, in its place, so the list can show it
 * has nothing on it.
 */
export function dayGroups(entries: MoneyEntry[], empty?: string | null): DayGroup[] {
  const days: DayGroup[] = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last?.date === e.date) last.list.push(e);
    else days.push({ date: e.date, list: [e] });
  }
  if (empty && !days.some((d) => d.date === empty)) {
    const at = days.findIndex((d) => d.date > empty);
    days.splice(at < 0 ? days.length : at, 0, { date: empty, list: [] });
  }
  return days;
}

/** A day's heading: "Today", "Yesterday" or "Tomorrow" when it's one of those, and the date in full ("Thursday 19 November"). */
export function dayTitle(date: string, today: string): { rel: string; full: string } {
  const d = parseYmd(date);
  const diff = dayDiff(parseYmd(today), d);
  const rel = diff === 0 ? 'Today' : diff === -1 ? 'Yesterday' : diff === 1 ? 'Tomorrow' : '';
  return { rel, full: `${DAY_NAMES[d.getDay()]} ${d.getDate()} ${MONTH_NAMES[d.getMonth()]}` };
}

/** "Thursday 19 November", or "Today, Friday 27 November": a day as a screen reader and a menu say it. */
export function dayName(date: string, today: string): string {
  const t = dayTitle(date, today);
  return t.rel ? `${t.rel}, ${t.full}` : t.full;
}

/**
 * Where a key moves the picked day on the calendar (weeks from Monday): a day either way, a week up
 * or down, Home and End to the first and last of the month. Null for any other key, or past either
 * end of the month (`month` is YYYY-MM).
 */
export function stepDay(date: string, key: string, month: string): string | null {
  const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[key];
  const first = `${month}-01`;
  const last = ymd(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0));
  const to = step ? ymd(addDays(parseYmd(date), step)) : key === 'Home' ? first : key === 'End' ? last : null;
  return to && to >= first && to <= last ? to : null;
}

/**
 * How far to scroll a list so a part of it shows. `part.top` is from the top of everything in the
 * list; `cover` is what sits over the list's top edge (a day's heading that sticks there, or a
 * phone's rail over the page). `start` puts the part just under the cover, `center` in the middle
 * of what's left, and `nearest` scrolls the least that brings all of it into view (a part taller
 * than the view shows from its top), or not at all.
 */
export function scrollFor(part: { top: number; height: number }, view: { scrollTop: number; height: number }, block: 'start' | 'center' | 'nearest', cover = 0): number {
  const room = view.height - cover;
  const atTop = part.top - cover;
  if (block === 'start') return Math.max(0, atTop);
  if (block === 'center') return Math.max(0, Math.round(atTop - Math.max(0, room - part.height) / 2));
  if (atTop < view.scrollTop || part.height > room) return Math.max(0, atTop);
  if (part.top + part.height > view.scrollTop + view.height) return Math.max(0, part.top + part.height - view.height);
  return view.scrollTop;
}
