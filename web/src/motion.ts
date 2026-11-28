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

/** An entry of a list as it's shown: `gone` once it's been taken out of the list, since `at` (ms). */
export type Shown<T> = { item: T; gone: boolean; at: number };

/**
 * A list as it's shown, after it changed (useWithGone in Motion.tsx, for rows that fold away as they go): what's in it
 * now, in its order, with what's just been taken out kept in its place (after what was before it, if that's still
 * there) and marked gone, for `keepFor` ms from when it went. One taken out and put back is simply there again.
 */
export function keepGone<T>(shown: Shown<T>[], items: T[], key: (item: T) => string, now: number, keepFor: number): Shown<T>[] {
  const keys = new Set(items.map(key));
  const out: Shown<T>[] = items.map((item) => ({ item, gone: false, at: 0 }));
  shown.forEach((p, n) => {
    if (keys.has(key(p.item)) || (p.gone && now - p.at > keepFor)) return;
    let at = 0;
    for (let j = n - 1; j >= 0; j--) {
      const found = out.findIndex((s) => key(s.item) === key(shown[j].item));
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    out.splice(at, 0, { item: p.item, gone: true, at: p.gone ? p.at : now });
  });
  return out;
}
