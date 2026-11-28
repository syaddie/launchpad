// How things move (docs/motion.md). The pure parts, tested in test/motion.test.ts: which way a change
// of view goes, and how a figure's characters line up between two values so only the digits that
// changed roll.

import type { ViewKey } from '../../shared/types';

/** The order of the views on the rail, which a change of view follows. */
const ORDER: ViewKey[] = ['home', 'digest', 'inbox', 'you', 'training', 'learn', 'money', 'server', 'review', 'music'];

/**
 * How a change of view moves: toward a view further along the rail is `next` (it comes in from
 * below, or from the right where the rail runs across), back toward Home is `prev`.
 */
export type ViewStep = 'next' | 'prev' | 'none';

export function viewStep(from: ViewKey, to: ViewKey): ViewStep {
  if (from === to) return 'none';
  return ORDER.indexOf(to) > ORDER.indexOf(from) ? 'next' : 'prev';
}

/**
 * Which way a period with arrows changed (a month, a year, a week; periodMotion.ts): to a later one is `next`, to an
 * earlier one `prev`, and the same one is no change. Months as "2026-11" compare as text, years and offsets as numbers.
 */
export type PeriodStep = 'next' | 'prev';

export function periodStep<T extends string | number>(from: T, to: T): PeriodStep | null {
  return to === from ? null : to > from ? 'next' : 'prev';
}

/**
 * One character of a readout. `key` is its place counted from the right, so the units stay put
 * when a value grows a digit ("9 min" to "10 min"). `from` is the digit that was in its place
 * before: undefined when there was no value before (the readout is new), null when there was no
 * digit in that place.
 */
export type ReadoutCell = { char: string; digit: boolean; key: string; from: string | null | undefined };

const isDigit = (char: string | undefined) => char !== undefined && char >= '0' && char <= '9';

export function readoutCells(text: string, previous?: string): ReadoutCell[] {
  const chars = [...text];
  const before = previous === undefined ? null : [...previous];
  return chars.map((char, i) => {
    const place = chars.length - 1 - i;
    const digit = isDigit(char);
    let from: string | null | undefined;
    if (before) {
      const old = before[before.length - 1 - place];
      from = isDigit(old) ? old! : null;
    }
    return { char, digit, key: `${digit ? 'd' : 'c'}${place}`, from };
  });
}

/**
 * Which way a readout's digits roll: up when the figure grew, down when it shrank (a countdown
 * ticking). Compares the digits as one number, so "12:59" to "13:00" goes up; a minus sign counts.
 */
export function rollDirection(text: string, previous: string | undefined): 'up' | 'down' {
  if (previous === undefined) return 'up';
  const value = (s: string) => {
    const digits = s.replace(/[^0-9.]/g, '');
    const n = Number(digits);
    return /[-−]/.test(s) ? -n : n;
  };
  const a = value(previous);
  const b = value(text);
  return Number.isFinite(a) && Number.isFinite(b) && b < a ? 'down' : 'up';
}

/**
 * Which of `keys` are new since they were last shown, for something that lights up once when it first appears
 * (Training's new bests). `seen` is the record saved last time (`JSON.stringify` of the keys then). With no record yet,
 * or one that can't be read, nothing is new: what's there when the record starts was there before it.
 */
export function unseen(keys: string[], seen: string | null): string[] {
  if (seen === null) return [];
  let was: unknown;
  try {
    was = JSON.parse(seen);
  } catch {
    return [];
  }
  if (!Array.isArray(was)) return [];
  const known = new Set(was);
  return keys.filter((k) => !known.has(k));
}

/**
 * The one day whose weight was just logged or changed, comparing the weights by day before and after (Training's body
 * weight drops it onto its chart). Null when nothing was added or changed (a day only removed, the same weights saved
 * back), or when several days changed at once, which is a restore or an import rather than a weight logged.
 */
export function landedDay(before: Record<string, number>, after: Record<string, number>): string | null {
  const changed = Object.keys(after).filter((d) => before[d] !== after[d]);
  return changed.length === 1 ? changed[0] : null;
}

/**
 * The one item just added to a list, comparing it before and after (a cigarette logged drops onto the day's line). Null
 * when nothing was added, or when several were at once (a restore, or a sync bringing a day's worth). What was taken
 * away at the same time (an old day falling out of the log) doesn't matter.
 */
export function addedOne(before: readonly string[], after: readonly string[]): string | null {
  const was = new Set(before);
  const added = after.filter((x) => !was.has(x));
  return added.length === 1 ? added[0] : null;
}

/**
 * Which countdowns due today still have to lift off (once a day each, remembered across reloads), and the record to
 * keep. `record` is what was saved last (`{ day, ids }` as JSON): a record from another day, or one that can't be read,
 * counts as none, so a countdown due today lifts off the first time it's seen even on the day this first runs.
 */
export function liftoffs(due: readonly string[], record: string | null, today: string): { lift: string[]; record: string } {
  let done: string[] = [];
  try {
    const was = record === null ? null : (JSON.parse(record) as unknown);
    if (was && typeof was === 'object' && (was as { day?: unknown }).day === today && Array.isArray((was as { ids?: unknown }).ids)) {
      done = ((was as { ids: unknown[] }).ids).filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // Nothing usable: as if there were no record.
  }
  const lift = due.filter((id) => !done.includes(id));
  return { lift, record: JSON.stringify({ day: today, ids: [...done, ...lift] }) };
}
