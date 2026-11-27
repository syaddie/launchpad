// The tab's title and icon (docs/mission-layout.md, idea 26): before an event the title counts down to it ("T-08:12 ·
// Gym"), while studying it counts up ("T+24:10 · Studying ASE 301"), and the icon gets a flame when something is about
// to happen or is happening (inside the launch clock's ten minutes, or a study timer running). The maths is here, with
// no page in it (tested in test/tab-title.test.ts); hooks/useTabTitle.ts puts it on the page.

import { SOON_MS } from './mission';

/** Inside this long before an event starts, the tab counts down to it. Further off, it's just "Launchpad". */
export const TITLE_MS = 60 * 60_000;
export const BASE_TITLE = 'Launchpad';

const two = (n: number) => String(n).padStart(2, '0');

/** A length of time as the tab writes it: "08:12" under an hour, "1:08:12" from an hour, like Learn's timer. */
export function tabClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  return `${h ? `${h}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

export type TabState = {
  title: string;
  /** The icon with its flame: an event inside ten minutes, or studying. */
  lit: boolean;
  /** The title changes every second (it's counting), so it's worth a timer. */
  ticking: boolean;
};

/**
 * What the tab says at `now`, from the day's next event (its start and title) and a running study timer (its start, and
 * what's being studied). An event inside ten minutes comes first, then the study timer, then an event inside the hour.
 */
export function tabState(now: Date, next?: { s: Date; title: string } | null, timer?: { start: Date; what: string; maxMs?: number } | null): TabState {
  const left = next ? next.s.getTime() - now.getTime() : Infinity;
  const title = (next?.title ?? '').trim() || 'Next event';
  if (left > 0 && left <= SOON_MS) return { title: `T-${tabClock(left)} · ${title}`, lit: true, ticking: true };
  if (timer) {
    const ran = Math.min(timer.maxMs ?? Infinity, Math.max(0, now.getTime() - timer.start.getTime()));
    return { title: `T+${tabClock(ran)} · ${timer.what}`, lit: true, ticking: true };
  }
  if (left > 0 && left <= TITLE_MS) return { title: `T-${tabClock(left)} · ${title}`, lit: false, ticking: true };
  return { title: BASE_TITLE, lit: false, ticking: false };
}
