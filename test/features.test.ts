import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINES } from '../shared/defaults';
import {
  countdownNext, countdownPhrase, countdownProgress, dailyCounts, engineUrl, fmtDuration, longestGapMs, moodMonth, parseSearch, smokesOn, sortCountdowns,
} from '../shared/trackers';
import type { Countdown } from '../shared/types';
import { latencyStats, mbps } from '../server/src/speedtest';
import { isPhysical, parseNetDev, toContainers } from '../server/src/system';
import { pickAir, pickOutlook, pickRain, pickUv } from '../server/src/weather';
import { gridLayout, type Area } from '../web/src/layout';
import { niceMax, slowTests } from '../web/src/components/Server';
import { searchRows } from '../web/src/components/TopBar';
import { psiBand, uvBand } from '../web/src/util';

const tue = new Date(2026, 9, 27); // Tue 27 Oct 2026
const cd = (p: Partial<Countdown>): Countdown => ({ id: 'x', title: 'X', date: '2026-11-19', yearly: false, createdAt: '2026-10-01T00:00:00+08:00', ...p });

describe('countdowns', () => {
  it('counts calendar days to a one-off date', () => {
    expect(countdownNext(cd({}), tue).days).toBe(23);
    expect(countdownNext(cd({ date: '2026-10-25' }), tue).days).toBe(-2);
  });
  it('rolls a yearly date to the next occurrence, today included', () => {
    expect(countdownNext(cd({ date: '1970-12-07', yearly: true }), tue)).toMatchObject({ days: 41 });
    expect(countdownNext(cd({ date: '1990-10-27', yearly: true }), tue).days).toBe(0);
    const passed = countdownNext(cd({ date: '1990-10-20', yearly: true }), tue);
    expect(passed.date).toEqual(new Date(2027, 9, 20));
  });
  it('measures progress from when it was added', () => {
    // 1 Oct → 19 Nov is 49 days; 26 of them have gone.
    expect(countdownProgress(cd({}), tue)).toBeCloseTo(26 / 49);
    expect(countdownProgress(cd({ date: '2026-10-01' }), tue)).toBe(1);
  });
  it('sorts soonest first and passed ones last', () => {
    const list = [cd({ id: 'a', date: '2026-12-25' }), cd({ id: 'b', date: '2026-10-20' }), cd({ id: 'c', date: '2026-11-01' }), cd({ id: 'd', date: '2026-10-26' })];
    expect(sortCountdowns(list, tue).map((c) => c.id)).toEqual(['c', 'a', 'd', 'b']);
  });
  it('phrases days', () => {
    expect([0, 1, 5, -1, -3].map(countdownPhrase)).toEqual(['today', 'tomorrow', 'in 5 days', 'yesterday', '3 days ago']);
  });
});

describe('cigarette log', () => {
  const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
  const log = [at(25, 9), at(25, 21), at(26, 8), at(26, 12, 30), at(27, 7, 40)];
  it('counts per local day', () => {
    expect(smokesOn(log, tue).length).toBe(1);
    expect(dailyCounts(log, tue, 3).map((d) => d.count)).toEqual([2, 2, 1]);
  });
  it('finds the longest gap, including the one still running', () => {
    expect(longestGapMs(log, new Date(2026, 9, 27, 9))).toBe((19 * 60 + 10) * 60_000);
    expect(longestGapMs(log, new Date(2026, 9, 28, 7, 40))).toBe(24 * 3600_000);
    expect(longestGapMs([], tue)).toBeNull();
  });
  it('formats durations', () => {
    expect([45, 125, 49 * 60].map((m) => fmtDuration(m * 60_000))).toEqual(['45 min', '2 h 05 min', '2 d 1 h']);
  });
});

describe('mood', () => {
  it('averages a month and counts logged days', () => {
    const moods = { '2026-10-01': { level: 4, note: '' }, '2026-10-02': { level: 2, note: '' }, '2026-09-30': { level: 5, note: '' } };
    expect(moodMonth(moods, 2026, 9)).toEqual({ avg: 3, logged: 2 });
    expect(moodMonth(moods, 2026, 10)).toEqual({ avg: null, logged: 0 });
  });
});

describe('search fallbacks', () => {
  it('splits a known prefix off the search', () => {
    expect(parseSearch('yt lofi beats', DEFAULT_ENGINES)).toMatchObject({ engine: { name: 'YouTube' }, term: 'lofi beats' });
    expect(parseSearch('YT lofi', DEFAULT_ENGINES).engine?.prefix).toBe('yt');
    expect(parseSearch('lofi beats', DEFAULT_ENGINES)).toEqual({ engine: null, term: 'lofi beats' });
    expect(parseSearch('yt', DEFAULT_ENGINES)).toEqual({ engine: null, term: 'yt' });
  });
  it('fills in %s, or appends the words', () => {
    expect(engineUrl(DEFAULT_ENGINES[0], 'a&b c')).toBe('https://www.google.com/search?q=a%26b%20c');
    expect(engineUrl({ prefix: 'x', name: 'X', url: 'https://x.test/?q=' }, 'hi')).toBe('https://x.test/?q=hi');
  });
  it('lists bookmarks first, then every engine; a prefix goes straight to its engine', () => {
    const bms = [{ id: '1', name: 'GitHub', url: 'https://github.com' }];
    expect(searchRows('git', bms, DEFAULT_ENGINES).map((r) => r.key)).toEqual(['b:1', ...DEFAULT_ENGINES.map((e) => 'e:' + e.prefix)]);
    expect(searchRows('gh launchpad', bms, DEFAULT_ENGINES).map((r) => r.url)).toEqual(['https://github.com/search?q=launchpad']);
    expect(searchRows('  ', bms, DEFAULT_ENGINES)).toEqual([]);
  });
});

describe('home grid', () => {
  const all: Area[] = ['today', 'tasks', 'notes', 'pkgs', 'bm'];
  it('matches the original desktop layout', () => {
    expect(gridLayout('desktop', new Set(all))).toEqual({
      areas: "'today tasks pkgs' 'today notes pkgs' 'bm bm bm'",
      columns: 'minmax(0, 1fr) minmax(0, 1.08fr) minmax(0, 1fr)',
      rows: 'minmax(0, 1.2fr) minmax(0, 0.8fr) auto',
    });
    expect(gridLayout('desktop', new Set<Area>([...all, 'photo', 'photo2'])).areas).toBe("'today tasks photo' 'photo2 notes pkgs' 'bm bm bm'");
  });
  it('lets the other panel fill a column and drops empty columns', () => {
    expect(gridLayout('desktop', new Set<Area>(['today', 'tasks', 'pkgs', 'bm'])).areas).toBe("'today tasks pkgs' 'today tasks pkgs' 'bm bm bm'");
    const g = gridLayout('desktop', new Set<Area>(['today', 'tasks', 'notes']));
    expect(g).toEqual({ areas: "'today tasks' 'today notes'", columns: 'minmax(0, 1fr) minmax(0, 1.08fr)', rows: 'minmax(0, 1.2fr) minmax(0, 0.8fr)' });
    expect(gridLayout('wide', new Set<Area>(['bm']))).toEqual({ areas: "'bm'", columns: 'minmax(0, 1fr)', rows: 'auto' });
  });
  it('stacks shown panels on a phone in the usual order', () => {
    expect(gridLayout('narrow', new Set<Area>(['bm', 'notes', 'today', 'photo'])).areas).toBe("'today' 'photo' 'notes' 'bm'");
  });
});

describe('weather extras', () => {
  const place = { latitude: 1.324, longitude: 103.93 }; // Bedok
  it('takes PSI for the nearest region', () => {
    const psi = {
      data: {
        regionMetadata: [
          { name: 'east', labelLocation: { latitude: 1.35735, longitude: 103.94 } },
          { name: 'west', labelLocation: { latitude: 1.35735, longitude: 103.7 } },
        ],
        items: [{ timestamp: '2026-10-27T22:00:00+08:00', readings: { psi_twenty_four_hourly: { east: 64, west: 73 }, pm25_twenty_four_hourly: { east: 23, west: 31 } } }],
      },
    };
    expect(pickAir(psi, place)).toEqual({ region: 'east', psi: 64, pm25: 23, at: '2026-10-27T22:00:00+08:00' });
    expect(pickAir({ data: { items: [] } }, place)).toBeNull();
  });
  it('takes the latest UV reading and the day’s peak', () => {
    const uv = { data: { records: [{ timestamp: 'x', index: [{ hour: '2026-10-27T15:00:00+08:00', value: 6 }, { hour: '2026-10-27T13:00:00+08:00', value: 8 }, { hour: '2026-10-27T14:00:00+08:00', value: 7 }] }] } };
    expect(pickUv(uv)).toEqual({ value: 6, at: '2026-10-27T15:00:00+08:00', peak: 8, peakAt: '2026-10-27T13:00:00+08:00' });
  });
  it('sums the last hour of rain at the nearest gauge', () => {
    const reading = (time: string, near: number) => ({ timestamp: `2026-10-27T${time}:00+08:00`, data: [{ stationId: 'S1', value: near }, { stationId: 'S2', value: 3 }] });
    const rain = {
      data: {
        stations: [
          { id: 'S1', name: 'Bedok North', location: { latitude: 1.33, longitude: 103.93 } },
          { id: 'S2', name: 'Jurong', location: { latitude: 1.34, longitude: 103.7 } },
        ],
        // Newest first, as the API sends them; the 21:50 one is over an hour before the latest.
        readings: [reading('22:55', 0.4), reading('22:50', 0.2), reading('22:45', 0), reading('22:00', 0.6), reading('21:50', 9)],
      },
    };
    const r = pickRain(rain, place, new Date('2026-10-27T22:56:00+08:00'));
    expect(r).toMatchObject({ station: 'Bedok North', mmLastHour: 1.2, raining: true });
    expect(r!.steps.map((s) => s.mm)).toEqual([0.6, 0, 0.2, 0.4]);
  });
  it('reads the 4-day outlook', () => {
    const j = { data: { records: [{ forecasts: [{ timestamp: '2026-10-28T00:00:00+08:00', forecast: { text: 'Thundery Showers' }, temperature: { low: 24, high: 33 } }, { timestamp: 'bad' }] }] } };
    expect(pickOutlook(j)).toEqual([{ date: '2026-10-28', forecast: 'Thundery Showers', low: 24, high: 33 }]);
  });
  it('bands PSI and UV the way NEA does', () => {
    expect([50, 51, 101, 201, 301].map((p) => psiBand(p).name)).toEqual(['Good', 'Moderate', 'Unhealthy', 'Very unhealthy', 'Hazardous']);
    expect(psiBand(120).bad).toBe(true);
    expect([2, 3, 6, 8, 11].map((u) => uvBand(u).name)).toEqual(['Low', 'Moderate', 'High', 'Very high', 'Extreme']);
  });
});

describe('server health', () => {
  it('parses /proc/net/dev', () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  123456     100    0    0    0     0          0         0   123456     100    0    0    0     0       0          0
  eno1: 987654321  5000    0    0    0     0          0        10 12345678   4000    0    0    0     0       0          0`;
    const m = parseNetDev(text);
    expect(m.get('eno1')).toEqual({ rx: 987654321, tx: 12345678 });
    expect(m.get('lo')).toEqual({ rx: 123456, tx: 123456 });
  });
  it('hides loopback and Docker plumbing', () => {
    expect(['eno1', 'eth0', 'wlan0', 'lo', 'docker0', 'veth12ab', 'br-1234', 'ifb0'].filter(isPhysical)).toEqual(['eno1', 'eth0', 'wlan0']);
  });
  it('lists running containers first', () => {
    expect(
      toContainers([
        { Names: ['/zeta'], Image: 'a', State: 'exited', Status: 'Exited (0) 2 days ago' },
        { Names: ['/launchpad'], Image: 'ghcr.io/x', State: 'running', Status: 'Up 3 hours (healthy)' },
      ]).map((c) => c.name),
    ).toEqual(['launchpad', 'zeta']);
  });
  it('works out speeds and latency', () => {
    expect(mbps(125_000_000, 1000)).toBe(1000);
    expect(latencyStats([10, 12, 11, 30])).toEqual({ pingMs: 11.5, jitterMs: 7.3 });
    expect(slowTests([900, 910, 300, 905, 890].map((d, i) => ({ at: String(i), downMbps: d, upMbps: 0, pingMs: 0, jitterMs: 0 }))).map((t) => t.downMbps)).toEqual([300]);
  });
  it('rounds chart tops to tidy numbers', () => {
    expect([7, 64, 1050, 2600].map(niceMax)).toEqual([8, 80, 1200, 3000]);
  });
});
