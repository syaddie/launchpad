import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../shared/defaults';
import { knownTheme } from '../shared/types';
import { cleanPrefs } from '../server/src/clean';
import { sunTimes } from '../web/src/mission';
import { nextSunChange, sunDown, sunMinutes, themeDark } from '../web/src/theme';

const at = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+08:00`);

describe('Follow the sun', () => {
  // 28 Nov 2026 in Singapore: sunrise about 06:50, sunset about 18:54 (mission.test.ts checks sunTimes against the almanac).
  const { rise, set } = sunTimes(at('2026-11-28', '12:00'));

  it('is dark before sunrise and from sunset, light between', () => {
    expect(sunDown(at('2026-11-28', '03:00'))).toBe(true);
    expect(sunDown(new Date(rise.getTime() - 1000))).toBe(true);
    expect(sunDown(rise)).toBe(false);
    expect(sunDown(at('2026-11-28', '12:00'))).toBe(false);
    expect(sunDown(new Date(set.getTime() - 1000))).toBe(false);
    expect(sunDown(set)).toBe(true);
    expect(sunDown(at('2026-11-28', '23:30'))).toBe(true);
  });

  it('changes next at sunrise, then sunset, then the next day’s sunrise', () => {
    expect(nextSunChange(at('2026-11-28', '03:00'))).toEqual(rise);
    expect(nextSunChange(at('2026-11-28', '12:00'))).toEqual(set);
    const tomorrow = sunTimes(at('2026-11-29', '12:00')).rise;
    expect(nextSunChange(at('2026-11-28', '21:00'))).toEqual(tomorrow);
    expect(nextSunChange(set)).toEqual(tomorrow);
  });

  it('gives sunrise and sunset in minutes of Singapore’s day, for the first paint', () => {
    const [r, s] = sunMinutes(at('2026-11-28', '12:00'));
    expect(r).toBeGreaterThan(6 * 60 + 45);
    expect(r).toBeLessThan(6 * 60 + 55);
    expect(s).toBeGreaterThan(18 * 60 + 50);
    expect(s).toBeLessThan(19 * 60);
  });

  it('shows dark only when the theme says so', () => {
    expect(themeDark('dark', false, false)).toBe(true);
    expect(themeDark('light', true, true)).toBe(false);
    expect(themeDark('system', true, false)).toBe(true);
    expect(themeDark('system', false, true)).toBe(false);
    expect(themeDark('sun', false, true)).toBe(true);
    expect(themeDark('sun', true, false)).toBe(false);
  });

  it('is a theme the server keeps, and older and unknown values still work', () => {
    expect(cleanPrefs({ theme: 'sun' }, DEFAULT_PREFS).theme).toBe('sun');
    for (const t of ['system', 'light', 'dark'] as const) expect(cleanPrefs({ theme: t }, { ...DEFAULT_PREFS, theme: 'sun' }).theme).toBe(t);
    // Something this version doesn't know keeps what was there.
    expect(cleanPrefs({ theme: 'moon' as never }, { ...DEFAULT_PREFS, theme: 'sun' }).theme).toBe('sun');
    expect(cleanPrefs({}, { ...DEFAULT_PREFS, theme: 'dark' }).theme).toBe('dark');
    // On a page, a theme from a newer version (or none) follows the device.
    expect(knownTheme('sun')).toBe('sun');
    expect(knownTheme('dark')).toBe('dark');
    expect(knownTheme('moon')).toBe('system');
    expect(knownTheme(undefined)).toBe('system');
  });
});
