// Music › Busking slots › Locations (server/src/nac.ts, shared/nac.ts): looking a location up
// before it's added, adding, renaming, ordering and removing, and the calendar's helpers.
// Nothing here asks NAC anything: pages come from test/fixtures/nac.
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { config } from '../server/src/config';
import { addPlace, editPlaces, fixtureFetcher, lookupPlace, NacError, nacPlaces, nacStatus, requestNacCheck, runCheck, snapshotFile, writeSnapshot, type Fetcher } from '../server/src/nac';
import { store } from '../server/src/store';
import { calendarWeeks, cleanNacPlaces, freeHours, guessNacNames, monthsLabel, NAC_MAX_PLACES, nacCodes, nacPlaceId, nacPlaceKey } from '../shared/nac';
import type { NacPlace, NacSlots } from '../shared/types';

const DIR = path.join(__dirname, 'fixtures/nac');
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const NOW = new Date('2026-11-20T12:20:00+08:00');
const DEFAULTS = config.nac.locations;
/** A made-up location id, standing in for one not on the list. */
const NEW_ID = 'd0000000-0000-4000-8000-000000000001';
const link = (id: string) => `https://eservices.nac.gov.sg/Busking/locations/${id}/events`;
/** Answers every page with this one. */
const pageOf = (html: string): Fetcher => async (_url, kind) => {
  if (kind === 'page') return html;
  throw new Error('no load-more expected');
};

beforeEach(() => store.setNacPlaces(DEFAULTS));

describe('location links and names', () => {
  it('finds the id in a location link, or takes a bare one', () => {
    expect(nacPlaceId(link(DEFAULTS[0].id))).toBe(DEFAULTS[0].id);
    expect(nacPlaceId(`${link(DEFAULTS[0].id)}?x=1`)).toBe(DEFAULTS[0].id);
    expect(nacPlaceId(`https://eservices.nac.gov.sg/Busking/locations/${DEFAULTS[1].id.toUpperCase()}`)).toBe(DEFAULTS[1].id);
    expect(nacPlaceId(`  ${DEFAULTS[2].id} `)).toBe(DEFAULTS[2].id);
    // A busker's profile has an id too, but isn't a location.
    expect(nacPlaceId(`https://eservices.nac.gov.sg/Busking/busker/profile/${DEFAULTS[0].id}`)).toBe('');
    expect(['', 'paya lebar', 'https://example.com/locations/123/events', 'd0000000-0000-4000-8000-00000000000'].map(nacPlaceId)).toEqual(['', '', '', '']);
  });

  it('tidies NAC’s capitals into names to start from', () => {
    expect(DEFAULTS.map((p) => guessNacNames(p.nac))).toEqual([
      { name: 'MRT Station - DTL Tampines', short: 'Tampines' },
      { name: 'MRT Station - EWL Pasir Ris', short: 'Pasir Ris' },
      { name: 'Paya Lebar Square', short: 'Paya Lebar Square' },
      { name: 'Changi Village - Space Between Blk 2 & 3', short: 'Changi Village' },
    ]);
    expect(guessNacNames('')).toEqual({ name: 'NAC location', short: 'NAC location' });
    expect(guessNacNames('A'.repeat(200)).name.length).toBeLessThanOrEqual(50);
  });

  it('gives each location a short code for the calendar, never the same twice', () => {
    expect(nacCodes(DEFAULTS)).toEqual({ tampines: 'TAM', 'pasir-ris': 'PR', 'paya-lebar': 'PL', 'changi-village': 'CV' });
    const same = nacCodes([
      { key: 'a', short: 'Paya Lebar' },
      { key: 'b', short: 'Paya Lebar' },
      { key: 'c', short: 'Paya Lebar' },
      { key: 'd', short: 'Paya Lebar' },
    ]);
    expect(new Set(Object.values(same)).size).toBe(4);
    expect(Object.values(same).every((c) => c.length <= 3)).toBe(true);
    expect(nacCodes([{ key: 'x', short: '★' }]).x).toMatch(/^\S{1,3}$/);
  });

  it('makes keys from short names that don’t clash', () => {
    expect(nacPlaceKey('Paya Lebar', [])).toBe('paya-lebar');
    expect(nacPlaceKey('Paya Lebar', ['paya-lebar', 'paya-lebar-2'])).toBe('paya-lebar-3');
    expect(nacPlaceKey('★', [])).toBe('place');
  });

  it('checks a saved list: no bad ids, no repeats, no more than the most', () => {
    expect(cleanNacPlaces(null)).toBeNull();
    expect(cleanNacPlaces({})).toBeNull();
    const ok = { key: 'bugis', id: NEW_ID, nac: 'BUGIS', name: '  Bugis   Junction ', short: '' };
    expect(cleanNacPlaces([ok, { ...ok, key: 'again' }, { ...ok, id: 'nope', key: 'x' }, { ...ok, id: DEFAULTS[0].id, name: '' }, null, 'x'])).toEqual([
      { key: 'bugis', id: NEW_ID, nac: 'BUGIS', name: 'Bugis Junction', short: 'Bugis Junction' },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => ({ key: `p${i}`, id: `d0000000-0000-4000-8000-${String(i).padStart(12, '0')}`, nac: '', name: `Place ${i}`, short: `P${i}` }));
    expect(cleanNacPlaces(many)).toHaveLength(NAC_MAX_PLACES);
  });
});

describe('looking a location up and adding it', () => {
  it('reads what NAC calls it and its hours', async () => {
    const got = await lookupPlace(link(NEW_ID), { fetcher: pageOf(read('changi-village.html')), now: NOW });
    expect(got).toEqual({
      id: NEW_ID,
      nac: 'CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3',
      url: link(NEW_ID),
      open: '10:00',
      close: '22:00',
      name: 'Changi Village - Space Between Blk 2 & 3',
      short: 'Changi Village',
      watched: null,
    });
    // One already on the list says so.
    expect((await lookupPlace(DEFAULTS[2].id, { fetcher: pageOf(read('paya-lebar.html')), now: NOW })).watched).toBe('Paya Lebar Square');
  });

  it('says why a link won’t do, without adding anything', async () => {
    await expect(lookupPlace('https://eservices.nac.gov.sg/Busking/busker/profile/x', { fetcher: pageOf('') })).rejects.toThrow(/isn’t a NAC location link/);
    const blocked = '<html><head><title>Request unsuccessful. Incapsula incident</title></head><body></body></html>';
    await expect(lookupPlace(link(NEW_ID), { fetcher: pageOf(blocked) })).rejects.toThrow('Couldn’t read that location: NAC sent something other than its usual location page (“Request unsuccessful. Incapsula incident”)');
    const down: Fetcher = async () => {
      throw new NacError('NAC answered 404, so it may be blocking Launchpad, or it’s down');
    };
    await expect(lookupPlace(link(NEW_ID), { fetcher: down })).rejects.toBeInstanceOf(NacError);
    expect(nacPlaces()).toEqual(DEFAULTS);
  });

  it('only adds a location that was looked up, once, up to the most', async () => {
    const id = 'd0000000-0000-4000-8000-0000000000a1';
    expect(() => addPlace({ id, name: 'Bugis' })).toThrow(/Look the location up/);
    await lookupPlace(id, { fetcher: pageOf(read('changi-village.html')) });
    expect(() => addPlace({ id, name: '   ' })).toThrow('Give it a name.');
    const added = addPlace({ id, name: '  Bugis   Junction ', short: 'Bugis' });
    expect(added).toEqual({ key: 'bugis', id, nac: 'CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3', name: 'Bugis Junction', short: 'Bugis' });
    expect(nacPlaces().map((p) => p.key)).toEqual(['tampines', 'pasir-ris', 'paya-lebar', 'changi-village', 'bugis']);
    expect(() => addPlace({ id, name: 'Again' })).toThrow('That’s already on the list as Bugis Junction.');

    for (let i = nacPlaces().length; i < NAC_MAX_PLACES; i++) {
      const more = `d0000000-0000-4000-8000-0000000000b${i}`;
      await lookupPlace(more, { fetcher: pageOf(read('changi-village.html')) });
      addPlace({ id: more, name: `Place ${i}` });
    }
    const last = 'd0000000-0000-4000-8000-0000000000c1';
    await lookupPlace(last, { fetcher: pageOf(read('changi-village.html')) });
    expect(() => addPlace({ id: last, name: 'One too many' })).toThrow(`That’s ${NAC_MAX_PLACES} locations already`);
    expect(nacPlaces()).toHaveLength(NAC_MAX_PLACES);
  });

  it('reads a location by its id in the fixtures, whatever its key on the list', async () => {
    const fetch = fixtureFetcher(DIR, [{ ...DEFAULTS[3], key: 'cv-2' }, ...DEFAULTS], NOW);
    expect(await fetch(link(DEFAULTS[3].id), 'page')).toContain('CHANGI VILLAGE');
    await expect(fetch(link(NEW_ID), 'page')).rejects.toThrow(/404/);
  });
});

describe('ordering, renaming and removing', () => {
  it('takes the new order and names, and drops the ones left out', () => {
    const out = editPlaces([
      { key: 'paya-lebar', name: 'PLS', short: 'PL Square' },
      { key: 'tampines', name: '   ', short: '' },
      { key: 'paya-lebar', name: 'twice' },
      { key: 'nowhere', name: 'Not on the list' },
    ]);
    // Blank names keep the old ones; a location named twice counts once.
    expect(out.map((p) => [p.key, p.name, p.short, p.id])).toEqual([
      ['paya-lebar', 'PLS', 'PL Square', DEFAULTS[2].id],
      ['tampines', 'Tampines Interchange', 'Tampines', DEFAULTS[0].id],
    ]);
    expect(nacPlaces()).toEqual(out);
    expect(() => editPlaces('nope')).toThrow(NacError);
  });

  it('can take every location off, and then checks nothing', async () => {
    editPlaces([]);
    expect(nacPlaces()).toEqual([]);
    const s = nacStatus(NOW);
    expect(s).toMatchObject({ watching: [], locations: [], next_check: null, can_check: 'There are no locations on the list to check.' });
    expect(requestNacCheck()).toEqual({ ok: false, error: 'There are no locations on the list to check.' });
  });

  it('shows only what’s on the list, in its order and under its names, straight away', async () => {
    const result = await runCheck({ places: DEFAULTS, fetcher: fixtureFetcher(DIR, DEFAULTS, NOW), wait: async () => {}, mineId: '', file: snapshotFile(), now: () => NOW, log: () => {} });
    expect(result.locations).toHaveLength(4);
    editPlaces([
      { key: 'changi-village', name: 'Changi', short: 'Changi' },
      { key: 'tampines', name: 'Tampines Interchange', short: 'Tampines' },
    ]);
    const s = nacStatus(NOW);
    expect(s.watching.map((w) => [w.key, w.short, w.nac])).toEqual([
      ['changi-village', 'Changi', DEFAULTS[3].nac],
      ['tampines', 'Tampines', DEFAULTS[0].nac],
    ]);
    expect(s.locations.map((l) => [l.key, l.name, l.short])).toEqual([
      ['changi-village', 'Changi', 'Changi'],
      ['tampines', 'Tampines Interchange', 'Tampines'],
    ]);
    expect(s.max_places).toBe(NAC_MAX_PLACES);
  });

  it('checks the list as it is now, and a location put back under an old key isn’t taken for another', async () => {
    editPlaces([{ key: 'paya-lebar' }]);
    const file = snapshotFile();
    const r = await runCheck({ fetcher: fixtureFetcher(DIR, DEFAULTS, NOW), wait: async () => {}, mineId: '', file, now: () => NOW, log: () => {} });
    expect(r.locations.map((l) => l.key)).toEqual(['paya-lebar']);
    // A snapshot that has a "paya-lebar" for some other id doesn't count as this one's.
    const other: NacSlots = { ...r, locations: r.locations.map((l) => ({ ...l, url: link(NEW_ID) })) };
    writeSnapshot(other, file);
    expect(nacStatus(NOW).locations).toEqual([]);
  });
});

describe('the calendar', () => {
  it('lays days out in weeks from Monday, the whole of each week', () => {
    const weeks = calendarWeeks('2026-11-20', '2026-12-14');
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0]).toBe('2026-11-16');
    expect(weeks[0]).toContain('2026-11-20');
    expect(weeks[4][6]).toBe('2026-12-20');
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // A Sunday is the end of its week, not the start of the next.
    expect(calendarWeeks('2026-11-22', '2026-11-22')).toEqual([['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']]);
    // Across New Year.
    expect(calendarWeeks('2026-12-30', '2027-01-04').map((w) => w[0])).toEqual(['2026-12-28', '2027-01-04']);
  });

  it('names the months it covers', () => {
    expect(monthsLabel('2026-11-20', '2026-11-30')).toBe('November 2026');
    expect(monthsLabel('2026-11-20', '2026-12-14')).toBe('November – December 2026');
    expect(monthsLabel('2026-12-20', '2027-01-14')).toBe('December 2026 – January 2027');
  });

  it('adds up a day’s free hours', () => {
    expect(freeHours([])).toBe(0);
    expect(freeHours([{ start: '10:00', end: '11:00' }, { start: '14:00', end: '19:00' }])).toBe(6);
    expect(freeHours([{ start: '21:00', end: '22:30' }])).toBe(1.5);
  });
});
