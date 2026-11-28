import type { ThemeMode } from '../../shared/types';
import { sunTimes } from './mission';

const DAY_MS = 86_400_000;

/** Whether the sun is down at `now`: before today's sunrise or from today's sunset (Singapore's times, mission.ts). */
export function sunDown(now: Date): boolean {
  const { rise, set } = sunTimes(now);
  return now < rise || now >= set;
}

/** When the sun next rises or sets after `now`: the moment Follow the sun changes the theme. */
export function nextSunChange(now: Date): Date {
  const { rise, set } = sunTimes(now);
  if (now < rise) return rise;
  if (now < set) return set;
  return sunTimes(new Date(now.getTime() + DAY_MS)).rise;
}

/** Whether a theme shows dark, with the device's own choice and whether the sun is down. */
export function themeDark(theme: ThemeMode, systemDark: boolean, isSunDown: boolean): boolean {
  return theme === 'dark' || (theme === 'system' && systemDark) || (theme === 'sun' && isSunDown);
}

/** Minutes into Singapore's day (UTC+8, no summer time). */
const sgMinutes = (d: Date) => Math.round(((d.getTime() / 60_000 + 480) % 1440 + 1440) % 1440);

/**
 * Sunrise and sunset on `day`'s date as minutes into Singapore's day, for the page to paint a new tab right before the
 * app has loaded (index.html keeps the last ones the app saved).
 */
export function sunMinutes(day: Date): [number, number] {
  const { rise, set } = sunTimes(day);
  return [sgMinutes(rise), sgMinutes(set)];
}
