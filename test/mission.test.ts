import { describe, expect, it } from 'vitest';
import { along, apron, APRON_ROWS, ascentCurve, clearOf, clockText, countdown, dayFraction, finalCount, hoursOf, moonPath, moonPhase, moonTimes, moonTurn, orbPlace, pathTable, seeded, skyPoint, skyWeather, stagesShed, sunTimes } from '../web/src/mission';

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
  // Singapore time (the tests run in Asia/Singapore). The almanac's figures are timeanddate.com's for Singapore.
  const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);
  const minutesOff = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

  it('the sun rises and sets at Singapore’s real times, through the year', () => {
    const cases: [Date, Date, Date][] = [
      [at(2026, 11, 28, 9), at(2026, 11, 28, 6, 50), at(2026, 11, 28, 18, 54)],
      [at(2026, 11, 1, 15), at(2026, 11, 1, 6, 46), at(2026, 11, 1, 18, 50)],
      [at(2027, 2, 10, 2), at(2027, 2, 10, 7, 16), at(2027, 2, 10, 19, 20)],
    ];
    for (const [day, rise, set] of cases) {
      const s = sunTimes(day);
      expect(minutesOff(s.rise, rise)).toBeLessThan(2);
      expect(minutesOff(s.set, set)).toBeLessThan(2);
    }
  });

  it('the sun is on its arc from sunrise to sunset, highest between them, lighting the horizon only when low', () => {
    const { rise, set } = sunTimes(at(2026, 11, 28, 12));
    expect(orbPlace(rise, false)).toMatchObject({ f: 0, glow: 1 });
    expect(orbPlace(set, false).f).toBeCloseTo(1);
    const noon = new Date((rise.getTime() + set.getTime()) / 2);
    expect(orbPlace(noon, false).lift).toBeCloseTo(1);
    expect(orbPlace(noon, false).glow).toBe(0);
    expect(orbPlace(at(2026, 11, 28, 7, 15), false).glow).toBeGreaterThan(0.7);
    expect(orbPlace(at(2026, 11, 28, 10), false).glow).toBe(0);
  });

  it('the moon is lit as it really is, waxing and waning', () => {
    expect(moonPhase(at(2026, 11, 9, 15)).lit).toBeLessThan(0.01);
    expect(moonPhase(at(2026, 11, 24, 23)).lit).toBeGreaterThan(0.99);
    expect(moonPhase(at(2026, 11, 17, 20)).lit).toBeCloseTo(0.5, 1);
    expect(moonPhase(at(2026, 11, 17, 20)).waxing).toBe(true);
    expect(moonPhase(at(2026, 11, 28, 4)).lit).toBeCloseTo(0.854, 1);
    expect(moonPhase(at(2026, 11, 28, 4)).waxing).toBe(false);
  });

  it('the moon rises and sets at its real times', () => {
    // 28 Nov: it set at 10:25 and rises again at 22:52; on the 24th it rose at 18:34, full.
    const morning = moonTimes(at(2026, 11, 28, 4));
    expect(morning.up).toBe(true);
    expect(minutesOff(morning.rise!, at(2026, 11, 27, 21, 51))).toBeLessThan(6);
    expect(minutesOff(morning.set!, at(2026, 11, 28, 10, 25))).toBeLessThan(6);
    const evening = moonTimes(at(2026, 11, 28, 20));
    expect(evening.up).toBe(false);
    expect(minutesOff(evening.rise!, at(2026, 11, 28, 22, 52))).toBeLessThan(6);
    expect(minutesOff(moonTimes(at(2026, 11, 24, 21)).rise!, at(2026, 11, 24, 18, 34))).toBeLessThan(6);
  });

  it('its lit side faces the sun in the scene’s sky: the right in the evening, the left before dawn, down at midnight', () => {
    // Facing right is 0°, clockwise (down the screen is positive).
    const turnAt = (t: Date) => {
      const o = orbPlace(t, true);
      return moonTurn(o.f, o.sun);
    };
    const cos = (deg: number) => Math.cos((deg * Math.PI) / 180);
    const sin = (deg: number) => Math.sin((deg * Math.PI) / 180);
    // Waxing, an hour or two after sunset: the sun just under the right-hand horizon, so lit on its lower right.
    expect(cos(turnAt(at(2026, 11, 13, 19, 30)))).toBeGreaterThan(0.3);
    expect(sin(turnAt(at(2026, 11, 13, 19, 30)))).toBeGreaterThan(0.5);
    expect(cos(turnAt(at(2026, 11, 20, 21)))).toBeGreaterThan(0.3);
    // Waning, before dawn: the sun under the left-hand horizon (a crescent low in the east is lit mostly from below).
    expect(cos(turnAt(at(2026, 11, 5, 5, 30)))).toBeLessThan(0);
    expect(sin(turnAt(at(2026, 11, 5, 5, 30)))).toBeGreaterThan(0.5);
    expect(cos(turnAt(at(2026, 11, 28, 4)))).toBeLessThan(-0.2);
    // A full moon high at midnight is lit from below, and the sun's place under the horizon doesn't jump at midnight.
    expect(sin(turnAt(at(2026, 11, 25, 0, 30)))).toBeGreaterThan(0.8);
    expect(Math.abs(turnAt(at(2026, 11, 24, 23, 59)) - turnAt(at(2026, 11, 25, 0, 1)))).toBeLessThan(3);
  });

  it('puts the sun under the horizon by night, from where it set to where it will rise', () => {
    const evening = orbPlace(at(2026, 11, 28, 19, 30), false).sun;
    expect(evening.below).toBe(true);
    expect(evening.f).toBeLessThan(0.1);
    const dawn = orbPlace(at(2026, 11, 28, 6, 30), false).sun;
    expect(dawn.below).toBe(true);
    expect(dawn.f).toBeGreaterThan(0.95);
    // Just risen on the left with the sun set long ago: lit from below and to the right, toward it under the ground.
    const risen = moonTurn(0.02, { f: 0.37, below: true });
    expect(risen).toBeGreaterThan(25);
    expect(risen).toBeLessThan(70);
    // A sky point: rising on the left, highest in the middle, setting on the right.
    expect(skyPoint(0, 1000, 400)).toEqual({ x: 160, y: 390 });
    expect(skyPoint(0.5, 1000, 400).y).toBeCloseTo(390 - 264);
    expect(skyPoint(1, 1000, 400).x).toBeCloseTo(860);
  });

  it('by night the moon follows its own rise and set, and is gone when it’s down', () => {
    // Up from 21:51 on the 27th to 10:25 on the 28th: at 04:00 a little past halfway, waning.
    const o = orbPlace(at(2026, 11, 28, 4), true);
    expect(o.up).toBe(true);
    expect(o.f).toBeGreaterThan(0.45);
    expect(o.f).toBeLessThan(0.6);
    expect(o.moon?.lit).toBeCloseTo(0.854, 1);
    // At 20:00 on the 28th it hasn't risen.
    expect(orbPlace(at(2026, 11, 28, 20), true)).toMatchObject({ up: false, glow: 0 });
  });

  it('a thin moon lights the horizon less', () => {
    const full = orbPlace(at(2026, 11, 24, 19), true);
    const thin = orbPlace(at(2026, 11, 11, 19, 30), true);
    expect(full.up && thin.up).toBe(true);
    expect(thin.glow / Math.max(0.01, 1 - thin.lift * 1.5)).toBeLessThan(full.glow / Math.max(0.01, 1 - full.lift * 1.5));
  });

  it('sits low and late when the theme and the clock disagree', () => {
    expect(orbPlace(at(2026, 11, 28, 14), true)).toMatchObject({ f: 0.86, up: true });
    expect(orbPlace(at(2026, 11, 28, 22), false)).toMatchObject({ f: 0.86, up: true, moon: null });
  });

  it('draws the lit part from a crescent to full', () => {
    expect(moonPath(0)).toBe('M0 -1 A1 1 0 0 1 0 1 A1 1 0 0 0 0 -1Z');
    expect(moonPath(0.25)).toBe('M0 -1 A1 1 0 0 1 0 1 A0.5 1 0 0 0 0 -1Z');
    expect(moonPath(0.5)).toBe('M0 -1 A1 1 0 0 1 0 1 A0 1 0 0 1 0 -1Z');
    expect(moonPath(0.85)).toBe('M0 -1 A1 1 0 0 1 0 1 A0.7 1 0 0 1 0 -1Z');
    expect(moonPath(1)).toBe('M0 -1 A1 1 0 0 1 0 1 A1 1 0 0 1 0 -1Z');
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

describe('the countdown’s last ten seconds', () => {
  const next = { s: at(14) };
  it('starts once fewer than ten seconds are left and lasts until the event starts', () => {
    expect(finalCount(at(13, 59, 50), next)).toBe(false);
    expect(finalCount(at(13, 59, 51), next)).toBe(true);
    expect(finalCount(new Date(at(14).getTime() - 1), next)).toBe(true);
    expect(finalCount(at(14), next)).toBe(false);
  });
  it('is never on during an event or with nothing next', () => {
    expect(finalCount(at(13, 59, 55), next, { s: at(13) })).toBe(false);
    expect(finalCount(at(13, 59, 55), undefined)).toBe(false);
  });
  it('shows 09 down to 00 on the clock while it lasts', () => {
    expect(countdown(at(13, 59, 51), undefined, next).text).toBe('T-00:00:09');
    expect(countdown(new Date(at(14).getTime() - 400), undefined, next).text).toBe('T-00:00:00');
  });
});

describe('staging', () => {
  const ev = (id: string, h: number, m = 0) => ({ id, end: at(h, m) });
  const day = [ev('gym', 8, 15), ev('class', 12, 30), ev('lunch', 14), ev('dinner', 21, 30)];
  it('sheds a stage for an event that ended since the last tick', () => {
    expect(stagesShed(day, at(13, 59), at(14)).map((e) => e.id)).toEqual(['lunch']);
    expect(stagesShed(day, at(14), at(14, 1))).toEqual([]);
  });
  it('sheds only the last when several ended at once, and none when the clock stood still or went back', () => {
    expect(stagesShed(day, at(7), at(15)).map((e) => e.id)).toEqual(['lunch']);
    expect(stagesShed(day, at(14), at(14))).toEqual([]);
    expect(stagesShed(day, at(15), at(13))).toEqual([]);
  });
});
