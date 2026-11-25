import { describe, expect, it } from 'vitest';
import { DEFAULT_ENGINES, DEFAULT_PREFS } from '../shared/defaults';
import { cleanPrefs } from '../server/src/clean';
import {
  countdownNext, countdownPhrase, countdownProgress, dailyCounts, engineUrl, fmtDuration, longestGapMs, moodMonth, parseSearch, smokesOn, sortCountdowns,
} from '../shared/trackers';
import { DESIGN_KEYS, knownDesign, type Countdown } from '../shared/types';
import { latencyStats, mbps } from '../server/src/speedtest';
import { toContainers } from '../server/src/docker';
import { isPhysical, parseNetDev } from '../server/src/system';
import { pickAir, pickOutlook, pickRain, pickUv } from '../server/src/weather';
import { arrangeColumns, focusOrder, focusTab, gridLayout, narrowOrder, type Area } from '../web/src/layout';
import { slowTests } from '../web/src/components/Server';
import { searchRows } from '../web/src/components/TopBar';
import { hashFor, niceMax, psiBand, uvBand, viewFromHash } from '../web/src/util';

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
  it('lists every engine; a prefix goes straight to its engine', () => {
    expect(searchRows('git', DEFAULT_ENGINES).map((r) => r.key)).toEqual(DEFAULT_ENGINES.map((e) => 'e:' + e.prefix));
    expect(searchRows('gh launchpad', DEFAULT_ENGINES).map((r) => r.url)).toEqual(['https://github.com/search?q=launchpad']);
    expect(searchRows('  ', DEFAULT_ENGINES)).toEqual([]);
  });
});

describe('home grid', () => {
  const all: Area[] = ['today', 'notes'];
  it('arranges Poster: the agenda as a wide lead over a photo, then the notes over the other', () => {
    expect(gridLayout('desktop', new Set<Area>([...all, 'photo', 'photo2']), 'poster')).toEqual({
      areas: "'today notes' 'photo2 photo'",
      columns: 'minmax(0, 1.35fr) minmax(0, 1fr)',
      rows: 'minmax(0, 1.2fr) minmax(0, 0.8fr)',
      order: ['today', 'photo2', 'notes', 'photo'],
    });
    // No photos: each panel fills its column.
    expect(gridLayout('desktop', new Set(all), 'poster').areas).toBe("'today notes' 'today notes'");
  });
  it('lets the other panel fill a column and drops empty columns', () => {
    expect(gridLayout('desktop', new Set<Area>(['today']), 'poster')).toEqual({ areas: "'today' 'today'", columns: 'minmax(0, 1.35fr)', rows: 'minmax(0, 1.2fr) minmax(0, 0.8fr)', order: ['today'] });
    expect(gridLayout('wide', new Set<Area>(), 'poster')).toEqual({ areas: '', columns: 'minmax(0, 1fr)', rows: '', order: [] });
  });
  it('stacks shown panels on a phone in the usual order', () => {
    expect(gridLayout('narrow', new Set<Area>(['notes', 'today', 'photo']), 'vista').areas).toBe("'today' 'photo' 'notes'");
    expect(gridLayout('narrow', new Set<Area>(['today', 'hero']), 'focus').areas).toBe("'hero' 'today'");
  });
  it('gives Vista two tall panels, in even rows on a wide screen', () => {
    const g = gridLayout('wide', new Set(all), 'vista');
    expect(g).toEqual({ areas: "'today notes' 'today notes'", columns: 'minmax(0, 1.25fr) minmax(0, 1fr)', rows: 'minmax(0, 1fr) minmax(0, 1fr)', order: ['today', 'notes'] });
  });
});

describe('home arranged by hand', () => {
  const two = new Set<Area>(['today', 'notes']);
  it('uses a saved arrangement, each column as wide as its top panel’s built-in one', () => {
    const g = gridLayout('desktop', two, 'vista', { vista: [['notes'], ['today']] });
    expect(g.areas).toBe("'notes today' 'notes today'");
    expect(g.columns).toBe('minmax(0, 1fr) minmax(0, 1.25fr)');
    expect(g.order).toEqual(['notes', 'today']);
    // Only that design's: another design's arrangement doesn't touch it.
    expect(gridLayout('desktop', two, 'poster', { vista: [['notes']] }).areas).toBe("'today notes' 'today notes'");
  });
  it('falls back to the built-in layout when nothing usable is saved', () => {
    const built = gridLayout('desktop', two, 'vista');
    for (const saved of [{}, { vista: [] }, { vista: [[]] }, { vista: [['bogus', 'photo']] }, { vista: 'no' }, { vista: [null, 3] }, { vista: [['tasks'], ['pkgs', 'bm']] }]) {
      expect(gridLayout('desktop', two, 'vista', saved as never)).toEqual(built);
    }
  });
  it('drops unknown and repeated names and puts left-out panels back in their own column', () => {
    expect(arrangeColumns('poster', [['photo', 'nope', 'photo'], ['today']])).toEqual([['photo', 'photo2'], ['today', 'notes']]);
    expect(arrangeColumns('poster', [['notes']])).toEqual([['notes', 'today'], ['photo2', 'photo']]);
    // An arrangement from before Tasks, Packages and Bookmarks were retired keeps what's left of it.
    expect(arrangeColumns('poster', [['tasks', 'notes'], ['pkgs', 'today'], ['bm']])).toEqual([['notes', 'photo2'], ['today', 'photo']]);
  });
  it('splits a column of more than two', () => {
    expect(arrangeColumns('poster', [['today', 'notes', 'photo', 'photo2']])).toEqual([['today', 'notes'], ['photo', 'photo2']]);
    const one = arrangeColumns('poster', [['notes'], ['today'], ['photo2'], ['photo']])!;
    expect(one).toEqual([['notes'], ['today'], ['photo2'], ['photo']]);
  });
  it('drops a column whose panels are all hidden, and copes with every panel hidden', () => {
    const saved = { poster: [['today'], ['notes', 'photo']] as Area[][] };
    expect(gridLayout('desktop', new Set<Area>(['today']), 'poster', saved).areas).toBe("'today' 'today'");
    expect(gridLayout('desktop', new Set<Area>(['today', 'photo2']), 'poster', saved).areas).toBe("'today' 'photo2'");
    expect(gridLayout('desktop', new Set<Area>(), 'poster', saved)).toEqual({ areas: '', columns: 'minmax(0, 1fr)', rows: '', order: [] });
  });
  it('orders the phone column and Focus’s tabs as saved, the rest after', () => {
    expect(gridLayout('narrow', two, 'vista', { narrow: [['notes', 'today']] }).order).toEqual(['notes', 'today']);
    expect(narrowOrder({ narrow: [['bogus', 'notes', 'notes']] as never })).toEqual(['notes', 'hero', 'today', 'photo', 'photo2']);
    // Retired panels in an old phone order just drop out.
    expect(narrowOrder({ narrow: [['wx', 'pkgs', 'photo', 'bm']] as never })).toEqual(['photo', 'hero', 'today', 'notes', 'photo2']);
    const order = focusOrder({ focus: [['notes', 'today', 'pkgs']] as never });
    expect(order).toEqual(['notes', 'today']);
    expect(focusTab(null, two, order)).toBe('notes');
    expect(focusTab('tasks', new Set<Area>(['today']), order)).toBe('today');
  });
  it('is cleaned on the server like any other setting', () => {
    const prev = { ...DEFAULT_PREFS, homeLayouts: { vista: [['today']] as Area[][] } };
    // Missing: what was there stays. Bad shapes and names go; a panel only once per design.
    expect(cleanPrefs({ name: 'Me' }, prev).homeLayouts).toEqual(prev.homeLayouts);
    expect(cleanPrefs({ homeLayouts: 'no' as never }, prev).homeLayouts).toEqual(prev.homeLayouts);
    expect(cleanPrefs({ homeLayouts: { vista: [['notes', 'x', 'notes'], 'no', [], ['today']], evil: [['today']], bento: [] } as never }, prev).homeLayouts).toEqual({ vista: [['notes'], ['today']] });
    // A retired design's arrangement, and retired panels (the weather panel, Tasks, Packages, Bookmarks), go.
    expect(cleanPrefs({ homeLayouts: { broadsheet: [['notes']], narrow: [['wx', 'today'], ['tasks', 'bm']] } as never }, prev).homeLayouts).toEqual({ narrow: [['today']] });
    // An empty object is a reset of every design.
    expect(cleanPrefs({ homeLayouts: {} }, prev).homeLayouts).toEqual({});
    // Older saved prefs have none.
    const { homeLayouts: _, ...old } = DEFAULT_PREFS;
    expect(cleanPrefs({}, old as typeof DEFAULT_PREFS).homeLayouts).toEqual({});
  });
});

describe('retired designs', () => {
  it('shows the default for a design that’s gone, and keeps one that isn’t', () => {
    for (const d of ['broadsheet', 'console', 'bento', 'horizon', undefined, '', 7]) expect(knownDesign(d)).toBe('mission');
    for (const d of DESIGN_KEYS) expect(knownDesign(d)).toBe(d);
    expect(DEFAULT_PREFS.design).toBe('mission');
  });
  it('saves only known designs, and moves a stored retired one to the default', () => {
    const prev = { ...DEFAULT_PREFS, design: 'poster' as const };
    expect(cleanPrefs({ design: 'focus' }, prev).design).toBe('focus');
    expect(cleanPrefs({ design: 'console' as never }, prev).design).toBe('poster');
    // Saved before the designs were retired: the next save of anything moves it on.
    expect(cleanPrefs({ name: 'Me' }, { ...prev, design: 'bento' as never }).design).toBe('mission');
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

describe('view hash routing', () => {
  it('maps location hashes to views and back', () => {
    expect(viewFromHash('')).toBe('home');
    expect(viewFromHash('#')).toBe('home');
    expect(viewFromHash('#money')).toBe('money');
    expect(viewFromHash('#/training')).toBe('training');
    expect(viewFromHash('#SERVER')).toBe('server');
    expect(viewFromHash('#unknown')).toBe('home');
    expect(hashFor('home')).toBe('');
    expect(hashFor('money')).toBe('#money');
    expect(hashFor('learn')).toBe('#learn');
  });
});

