import { describe, expect, it } from 'vitest';
import { along, apron, APRON_ROWS, ascentCurve, clearOf, clockText, countdown, dayFraction, hoursOf, orbPlace, pathTable, seeded, skyWeather } from '../web/src/mission';

const at = (h: number, m = 0, s = 0) => new Date(2026, 10, 25, h, m, s);

describe('the day along the ascent', () => {
  it('runs from 06:00 on the pad to midnight in orbit', () => {
    expect(dayFraction(6)).toBe(0);
    expect(dayFraction(15)).toBe(0.5);
    expect(dayFraction(24)).toBe(1);
  });
  it('stays on the pad before 06:00 and in orbit after midnight', () => {
    expect(dayFraction(3)).toBe(0);
    expect(dayFraction(25)).toBe(1);
  });
  it('reads a time of day as hours', () => {
    expect(hoursOf(at(14, 30))).toBe(14.5);
  });
});

describe('the path', () => {
  const curve = ascentCurve(1200, 100, 340, 110, false);
  const T = pathTable(curve);
  it('starts on the pad and ends at orbit height on the far side', () => {
    expect(along(T, 0)).toMatchObject({ x: 100, y: 340 });
    const end = along(T, 1);
    expect(end.x).toBeCloseTo(1156);
    expect(end.y).toBeCloseTo(110);
  });
  it('leaves the pad going straight up and arrives going level', () => {
    expect(Math.abs(Math.sin(along(T, 0.01).a))).toBeGreaterThan(0.95);
    expect(Math.abs(Math.sin(along(T, 0.99).a))).toBeLessThan(0.1);
  });
  it('places by distance: halfway along is half the length from each end', () => {
    const mid = along(T, 0.5);
    expect(T.len[mid.i - 1]).toBeLessThanOrEqual(T.total / 2);
    expect(T.len[mid.i]).toBeGreaterThanOrEqual(T.total / 2);
  });
  it('never climbs back down, and never goes off the sky', () => {
    for (let i = 1; i < T.pts.length; i++) {
      expect(T.pts[i].y).toBeLessThanOrEqual(T.pts[i - 1].y + 0.5);
      expect(T.pts[i].x).toBeGreaterThanOrEqual(100 - 0.5);
      expect(T.pts[i].x).toBeLessThanOrEqual(1200);
    }
  });
  it('holds outside 0 to 1', () => {
    expect(along(T, -1)).toMatchObject({ x: 100, y: 340 });
    expect(along(T, 2).x).toBeCloseTo(1156);
  });
  it('bends sooner in a phone’s sky and still fits it', () => {
    const phone = pathTable(ascentCurve(390, 46, 250, 84, true));
    for (const p of phone.pts) expect(p.x).toBeLessThanOrEqual(390);
    expect(along(phone, 1).x).toBeCloseTo(372);
  });
});

describe('the sun and the moon', () => {
  it('the sun rises at 07:00, is highest at 13:00 and sets at 19:00', () => {
    expect(orbPlace(7, false)).toMatchObject({ f: 0, glow: 1 });
    expect(orbPlace(13, false).lift).toBeCloseTo(1);
    expect(orbPlace(13, false).glow).toBe(0);
    expect(orbPlace(19, false).f).toBe(1);
  });
  it('lights the horizon only when it’s low', () => {
    expect(orbPlace(7.5, false).glow).toBeGreaterThan(0.7);
    expect(orbPlace(10, false).glow).toBe(0);
    expect(orbPlace(18.5, false).glow).toBeGreaterThan(0.7);
  });
  it('the moon is up from 19:00 to 07:00, across midnight', () => {
    expect(orbPlace(19, true).f).toBe(0);
    expect(orbPlace(1, true).f).toBe(0.5);
    expect(orbPlace(6, true).f).toBeCloseTo(11 / 12);
  });
  it('sits low and late when the theme and the clock disagree', () => {
    expect(orbPlace(14, true).f).toBe(0.86);
    expect(orbPlace(22, false).f).toBe(0.86);
  });
});

describe('the launch clock', () => {
  it('writes a length of time as hours, minutes and seconds', () => {
    expect(clockText(54 * 60_000 + 38_000)).toBe('00:54:38');
    expect(clockText(26 * 3600_000)).toBe('26:00:00');
    expect(clockText(-5)).toBe('00:00:00');
  });
  it('counts down to the next event', () => {
    expect(countdown(at(14, 5, 22), undefined, { s: at(15) })).toEqual({ state: 'next', text: 'T-00:54:38', soon: false });
  });
  it('turns to the colour of now inside ten minutes', () => {
    expect(countdown(at(14, 50), undefined, { s: at(15) }).soon).toBe(true);
    expect(countdown(at(14, 49, 59), undefined, { s: at(15) }).soon).toBe(false);
  });
  it('counts up through the event that’s on, even with another coming', () => {
    expect(countdown(at(15, 12, 40), { s: at(15) }, { s: at(18, 30) })).toEqual({ state: 'now', text: 'T+00:12:40', soon: false });
  });
  it('shows the time of day when nothing is left', () => {
    expect(countdown(at(22, 4, 9), undefined, undefined)).toEqual({ state: 'idle', text: '22:04:09', soon: false });
  });
});

describe('the sky’s weather', () => {
  it('reads the forecast’s own words', () => {
    expect(skyWeather('Fair & Warm')).toBe('clear');
    expect(skyWeather('Fair (Night)')).toBe('clear');
    expect(skyWeather('Partly Cloudy (Day)')).toBe('cloud');
    expect(skyWeather('Hazy')).toBe('cloud');
    expect(skyWeather('Thundery Showers')).toBe('rain');
    expect(skyWeather('Light Rain')).toBe('rain');
  });
  it('is clear with no forecast', () => {
    expect(skyWeather(null)).toBe('clear');
    expect(skyWeather(undefined)).toBe('clear');
  });
});

describe('small things', () => {
  it('gives the same stars for the same seed', () => {
    const a = seeded(7);
    const b = seeded(7);
    const first = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(first);
    for (const n of first) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
  it('slips a point out from behind words, to the nearer side', () => {
    const box = { left: 400, top: 200, right: 900, bottom: 330 };
    expect(clearOf({ x: 600, y: 300 }, [box], 400, 70)).toEqual({ x: 600, y: 356 });
    expect(clearOf({ x: 600, y: 210 }, [box], 400, 70)).toEqual({ x: 600, y: 174 });
  });
  it('goes above when below would be under the horizon, and leaves a clear point alone', () => {
    const box = { left: 400, top: 200, right: 900, bottom: 390 };
    expect(clearOf({ x: 600, y: 380 }, [box], 400, 70).y).toBe(174);
    expect(clearOf({ x: 100, y: 300 }, [box], 400, 70)).toEqual({ x: 100, y: 300 });
  });
});

describe('the apron with no photos', () => {
  const { lamps, paint, dashes } = apron(1440, 545);
  it('keeps every light inside the ground, below the haze at the horizon', () => {
    expect(lamps.length).toBeGreaterThan(40);
    for (const l of lamps) {
      expect(l.x).toBeGreaterThanOrEqual(-l.r);
      expect(l.x).toBeLessThanOrEqual(1440 + l.r);
      expect(l.y).toBeGreaterThanOrEqual(22);
      expect(l.y).toBeLessThanOrEqual(545);
    }
  });
  it('crowds the rows together and shrinks the lights toward the horizon', () => {
    const centre = lamps.filter((l) => l.seq && l.x === 720).sort((a, b) => a.row - b.row);
    expect(centre.length).toBe(APRON_ROWS);
    for (let i = 2; i < centre.length; i++) {
      expect(centre[i].y).toBeLessThan(centre[i - 1].y);
      expect(centre[i - 1].y - centre[i].y).toBeLessThanOrEqual(centre[i - 2].y - centre[i - 1].y);
      expect(centre[i].r).toBeLessThanOrEqual(centre[i - 1].r);
    }
  });
  it('runs every line of lights to the middle of the horizon', () => {
    for (const row of [0, 5, 12]) {
      const xs = lamps.filter((l) => l.row === row && l.seq).map((l) => l.x - 720);
      const y = lamps.find((l) => l.row === row)!.y;
      // The runway's edges are as far out as the ground is deep at that row: in line with the middle of the top edge.
      expect(Math.max(...xs) / y).toBeCloseTo(0.4, 1);
    }
  });
  it('flashes the runway in sequence and keeps the taxiways steady, every other row', () => {
    expect(lamps.filter((l) => l.seq).every((l) => Math.abs(l.x - 720) <= 0.4 * 545 + 1)).toBe(true);
    const taxi = lamps.filter((l) => !l.seq);
    expect(taxi.length).toBeGreaterThan(0);
    expect(taxi.every((l) => l.row % 2 === 0)).toBe(true);
  });
  it('paints its lines, and leaves a box too small to see alone', () => {
    expect(paint).toMatch(/^M720 0 L/);
    expect(dashes.split('M').length - 1).toBeGreaterThan(5);
    expect(apron(30, 400).lamps).toEqual([]);
  });
  it('leaves out the lights a narrow band can’t show', () => {
    const band = apron(390, 390);
    expect(band.lamps.every((l) => l.x >= -l.r && l.x <= 390 + l.r)).toBe(true);
    expect(band.lamps.length).toBeLessThan(lamps.length);
  });
});
