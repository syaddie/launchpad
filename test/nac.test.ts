// The NAC Slot Finder (server/src/nac.ts, shared/nac.ts) on saved pages in NAC's markup with
// made-up bookings (test/fixtures/nac/README.md). Nothing here asks NAC anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { NacPlace } from '../server/src/config';
import {
  clearOfScheduleSync,
  emptySlots,
  fetchFragment,
  fixtureFetcher,
  liveFetch,
  makeScheduler,
  NacError,
  nextCheck,
  nextSlot,
  parseCards,
  parseNacDate,
  parseNacRange,
  parseNacTime,
  parsePage,
  readSnapshot,
  refusal,
  runCheck,
  statusOf,
  unescapeHtml,
  writeSnapshot,
  type Fetcher,
} from '../server/src/nac';
import { ampm, fmtClock, fmtRange, sgtIso, slotView } from '../shared/nac';
import type { NacLocation, NacSlots } from '../shared/types';

const DIR = path.join(__dirname, 'fixtures/nac');
const META = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8')) as { today: string; now: string; later: string; mine: string };
const MINE = META.mine;
const NOW = new Date(META.now);
const LATER = new Date(META.later);
const read = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');

const PLACES: NacPlace[] = [
  { key: 'tampines', id: '9c962e64-ae46-40d2-9506-eb71639b274d', nac: 'MRT STATION - DTL TAMPINES', name: 'Tampines Interchange', short: 'Tampines' },
  { key: 'pasir-ris', id: '2df197be-cf61-4981-8aef-ebda3f353ec2', nac: 'MRT STATION - EWL PASIR RIS', name: 'Pasir Ris MRT', short: 'Pasir Ris' },
  { key: 'paya-lebar', id: 'c6f63ddc-3926-4a83-b59f-e7904989c7a0', nac: 'PAYA LEBAR SQUARE', name: 'Paya Lebar Square', short: 'Paya Lebar' },
  { key: 'changi-village', id: '8f102e44-7f8d-45bc-a1da-50aa8a6202fc', nac: 'CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3', name: 'Changi Village', short: 'Changi Village' },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-nac-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const freshFile = () => path.join(tmp, `run-${++n}`, 'snapshot.json');

/** A check on a fixtures folder, counting what it asked for. */
async function check(folder: string, opts: { file?: string; now?: Date; mineId?: string; fetcher?: Fetcher; places?: NacPlace[] } = {}) {
  const now = opts.now ?? NOW;
  const urls: string[] = [];
  const inner = opts.fetcher ?? fixtureFetcher(path.join(DIR, folder), PLACES, now);
  const logs: string[] = [];
  let waits = 0;
  const result = await runCheck({
    places: opts.places ?? PLACES,
    fetcher: (url, kind) => (urls.push(url), inner(url, kind)),
    wait: async () => void waits++,
    mineId: opts.mineId ?? MINE,
    file: opts.file ?? freshFile(),
    now: () => now,
    log: (m) => logs.push(m),
  });
  return { result, urls, waits, logs };
}

const loc = (s: NacSlots, key: string) => s.locations.find((l) => l.key === key)!;
const day = (l: NacLocation, date: string) => l.days.find((d) => d.date === date)!;

/** The first card in a fixture page, to build odd cases from NAC's own markup. */
const TEMPLATE = (() => {
  const html = read('pasir-ris.html');
  const start = html.indexOf('<div class="col-md-6');
  return html.slice(start, html.indexOf('<div class="col-md-6', start + 10));
})();
function card(o: { status?: string; date?: string | null; time?: string | null; profile?: string; booking?: string }): string {
  let c = TEMPLATE.replace(/(<a href="">)[^<]*(<img)/, `$1${o.status ?? 'Published'}$2`);
  if (o.date === null) c = c.replace(/<li><img[^>]*red-date\.png[^>]*>[^<]*<\/li>/, '');
  else if (o.date) c = c.replace(/(red-date\.png[^>]*>)[^<]*/, `$1${o.date}`);
  if (o.time === null) c = c.replace(/<li>\s*<img[^>]*red-clock\.png[^>]*>[^<]*<\/li>/, '');
  else if (o.time) c = c.replace(/(red-clock\.png[^>]*>)[^<]*/, `$1${o.time}\n                `);
  if (o.profile) c = c.replace(/(\/busker\/profile\/)[0-9a-f-]{36}/, `$1${o.profile}`);
  c = c.replace(/data-bookingid="[^"]*"/, `data-bookingid="${o.booking ?? `b-${Math.random().toString(36).slice(2)}`}"`);
  return c;
}
/** Pasir Ris' page with these cards in place of its own. */
function pageWith(cards: string[]): string {
  const html = read('pasir-ris.html');
  // Whatever the line endings: a checkout can change them.
  const start = html.indexOf('<div class="col-md-6');
  const end = html.search(/<\/div>\s*<div class="text-center/);
  if (start < 0 || end < start) throw new Error('pasir-ris.html isn’t laid out as pageWith expects');
  return html.slice(0, start) + cards.join('') + html.slice(end);
}
const onePlace = (html: string): Fetcher => async (_url, kind) => {
  if (kind === 'page') return html;
  throw new Error('no load-more expected');
};

// ---------- the helpers copied from schedule-sync ----------

describe('parse_date', () => {
  it('reads NAC’s dates, which have no year', () => {
    expect(parseNacDate('Fri, 20 November', '2026-11-20')).toBe('2026-11-20');
    expect(parseNacDate('Mon, 14 December', '2026-11-20')).toBe('2026-12-14');
    expect(parseNacDate(' Sun, 1 November ', '2026-11-20')).toBe('2026-11-01');
  });

  it('takes next year’s date over New Year (Dec to Jan)', () => {
    expect(parseNacDate('Thu, 31 December', '2026-12-28')).toBe('2026-12-31');
    expect(parseNacDate('Fri, 1 January', '2026-12-28')).toBe('2027-01-01');
    expect(parseNacDate('Mon, 18 January', '2026-12-28')).toBe('2027-01-18');
  });

  it('still reads a slot from the last days of the old year just after New Year', () => {
    expect(parseNacDate('Thu, 31 December', '2027-01-02')).toBe('2026-12-31');
    expect(parseNacDate('Fri, 1 January', '2027-01-02')).toBe('2027-01-01');
  });

  it('refuses a weekday that doesn’t fit, and a date before the list starts', () => {
    expect(() => parseNacDate('Mon, 20 November', '2026-11-20')).toThrow(NacError);
    expect(() => parseNacDate('Sat, 31 October', '2026-11-20')).toThrow(NacError);
    expect(() => parseNacDate('20/11/2026', '2026-11-20')).toThrow(NacError);
    expect(() => parseNacDate('Mon, 31 November', '2026-11-20')).toThrow(NacError);
  });
});

describe('parse_time', () => {
  it('reads NAC’s times', () => {
    expect(parseNacTime('06:00:PM')).toBe(18 * 60);
    expect(parseNacTime('12:00:PM')).toBe(12 * 60);
    expect(parseNacTime('12:00:AM')).toBe(0);
    expect(parseNacTime('10:30:AM')).toBe(10 * 60 + 30);
    expect(() => parseNacTime('13:00:PM')).toThrow(NacError);
    expect(() => parseNacTime('6pm')).toThrow(NacError);
  });

  it('reads ranges, with or without spaces, and midnight as an end', () => {
    expect(parseNacRange('11:00:AM-12:00:PM')).toEqual([660, 720]);
    expect(parseNacRange('10:00:AM - 02:00:PM')).toEqual([600, 840]);
    expect(parseNacRange('10:00:PM-12:00:AM')).toEqual([1320, 1440]);
    expect(() => parseNacRange('02:00:PM-01:00:PM')).toThrow(NacError);
    expect(() => parseNacRange('02:00:PM')).toThrow(NacError);
  });

  it('unescapes HTML like html.unescape', () => {
    expect(unescapeHtml('BLK 2 &amp; 3')).toBe('BLK 2 & 3');
    expect(unescapeHtml('it&#39;s &lt;b&gt; &#x26; &quot;x&quot;')).toBe('it\'s <b> & "x"');
    expect(unescapeHtml('&bogus; &')).toBe('&bogus; &');
  });
});

// ---------- reading the pages ----------

describe('reading NAC’s pages', () => {
  it('reads a location page: its name, open hours and first cards', () => {
    const p = parsePage(read('tampines.html'), META.today, MINE);
    expect(p).toMatchObject({ name: 'MRT STATION - DTL TAMPINES', open: 600, close: 840, pageSize: 12 });
    expect(p.cards).toHaveLength(12);
    // The slot that's over has no booking id.
    expect(p.cards[0]).toEqual({ status: 'Passed', mine: false, date: '2026-11-20', start: 600, end: 660, id: '' });
    expect(p.cards[1]).toMatchObject({ status: 'Published', date: '2026-11-20', start: 660, end: 720 });
    expect(p.cards[1].id).toMatch(/^b0000000-/);
  });

  it('reads pages the same whatever their line endings', () => {
    const crlf = read('tampines.html');
    const lf = crlf.replace(/\r\n/g, '\n');
    expect(lf).not.toContain('\r');
    expect(parsePage(lf, META.today, MINE)).toEqual(parsePage(crlf, META.today, MINE));
    const more = fetchFragment(read('tampines-more.json'));
    expect(parseCards(more.replace(/\r\n/g, '\n'), META.today, MINE)).toEqual(parseCards(more, META.today, MINE));
  });

  it('unescapes the location’s name (BLK 2 &amp; 3)', () => {
    expect(read('changi-village.html')).toContain('BLK 2 &amp; 3');
    const p = parsePage(read('changi-village.html'), META.today, MINE);
    expect(p.name).toBe('CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3');
    expect(p).toMatchObject({ open: 600, close: 1320 });
  });

  it('reads a load-more answer, a JSON string of cards with photos inline', () => {
    const body = read('paya-lebar-more.json');
    expect(body).toContain('data:image/jpeg;base64,');
    const fragment = fetchFragment(body);
    expect(fragment).not.toContain('data:image');
    const cards = parseCards(fragment, META.today, MINE);
    expect(cards.length).toBeGreaterThan(50);
    expect(cards.every((c) => c.date >= '2026-11-20' && c.date <= '2026-12-14' && c.end > c.start)).toBe(true);
  });

  it('keeps no name or profile ID, and tells yours apart by ID, not name', () => {
    const cards = [...parsePage(read('pasir-ris.html'), META.today, MINE).cards, ...parseCards(fetchFragment(read('pasir-ris-more.json')), META.today, MINE)];
    const text = JSON.stringify(cards);
    expect(text).not.toMatch(/TEST BUSKER|a0000000-|11111111-2222/);
    const mine = cards.filter((c) => c.mine);
    expect(mine.map((c) => [c.date, c.start, c.end])).toEqual([
      ['2026-11-24', 600, 720],
      ['2026-12-03', 720, 840],
    ]);
    // Busker 07 has your made-up name but another ID.
    const markup = read('pasir-ris.html') + (JSON.parse(read('pasir-ris-more.json')) as string);
    expect(markup).toContain(`profile/${MINE}"> TEST BUSKER 07 </a>`);
    expect(markup).toContain('profile/a0000000-0000-4000-8000-000000000007"> TEST BUSKER 07 </a>');
    expect(cards.filter((c) => c.date === '2026-12-03' && c.start === 600)).toEqual([expect.objectContaining({ mine: false })]);
    // Without NAC_BUSKER_ID nothing is yours.
    expect(parseCards(fetchFragment(read('pasir-ris-more.json')), META.today, '').some((c) => c.mine)).toBe(false);
  });

  it('fails on a card with no date, time or status rather than calling its slot free', () => {
    expect(() => parseCards(card({ date: null }), META.today, MINE)).toThrow(/no date or time/);
    expect(() => parseCards(card({ time: null }), META.today, MINE)).toThrow(/no date or time/);
    expect(() => parseCards(card({ status: '' }), META.today, MINE)).toThrow(/no status/);
    expect(() => parseCards(card({ date: 'Someday' }), META.today, MINE)).toThrow(NacError);
  });

  it('treats a bot-check page as blocked, and says nothing from inside it', () => {
    const blocked = read('blocked/tampines-more.json');
    expect(() => fetchFragment(blocked)).toThrow(/didn’t return JSON, so it may be blocking Launchpad/);
    expect(() => fetchFragment('{"html":"<h3>SOMEONE</h3>"}')).toThrow(/isn’t its usual list/);
    try {
      fetchFragment('{"html":"<h3>SOMEONE</h3>"}');
    } catch (e) {
      expect((e as Error).message).not.toContain('SOMEONE');
    }
    expect(() => parsePage(blocked, META.today, MINE)).toThrow(/other than its usual location page/);
    expect(() => parsePage('<html><head><title>Service Unavailable</title></head><body>down</body></html>', META.today, MINE)).toThrow(/“Service Unavailable”/);
  });
});

// ---------- a whole check ----------

describe('a check', () => {
  it('asks for each page and its load-more list, one at a time', async () => {
    const { result, urls, waits } = await check('.');
    expect(result.ok).toBe(true);
    expect(urls).toEqual(
      PLACES.flatMap((p) => [
        `https://eservices.nac.gov.sg/Busking/locations/${p.id}/events`,
        `https://eservices.nac.gov.sg/Busking/locations/${p.id}/events/more?skip=10&take=200`,
      ]),
    );
    // A pause before every request but the first.
    expect(waits).toBe(urls.length - 1);
  });

  it('works out free, taken and yours, from now to each location’s last booking', async () => {
    const { result } = await check('.');
    expect(result).toMatchObject({ checked_at: '2026-11-20T12:20:00+08:00', last_good_at: '2026-11-20T12:20:00+08:00', ok: true, error: null, failures: 0, mine_on: true, unknown_statuses: [] });
    expect(result.next_check).toBe('2026-11-20T12:45:00+08:00');
    expect(result.locations.map((l) => [l.key, l.open, l.close, l.horizon_end, l.days[0].date, l.days[l.days.length - 1].date])).toEqual([
      ['tampines', '10:00', '14:00', '2026-12-14', '2026-11-20', '2026-12-14'],
      ['pasir-ris', '10:00', '14:00', '2026-12-11', '2026-11-20', '2026-12-11'],
      ['paya-lebar', '10:00', '22:00', '2026-12-14', '2026-11-20', '2026-12-14'],
      ['changi-village', '10:00', '22:00', '2026-12-06', '2026-11-20', '2026-12-06'],
    ]);
    expect(loc(result, 'changi-village')).toMatchObject({ name: 'Changi Village', nac_name: 'CHANGI VILLAGE - SPACE BETWEEN BLK 2 & 3', url: `https://eservices.nac.gov.sg/Busking/locations/${PLACES[3].id}/events` });

    // The spec's example day.
    expect(day(loc(result, 'paya-lebar'), '2026-11-24')).toEqual({
      date: '2026-11-24',
      free: [{ start: '14:00', end: '15:00', new: false }, { start: '17:00', end: '19:00', new: false }],
      mine: [],
      taken: [{ start: '10:00', end: '14:00', status: 'Confirmed' }, { start: '15:00', end: '17:00', status: 'Published' }, { start: '19:00', end: '22:00', status: 'Published' }],
    });
    expect(day(loc(result, 'changi-village'), '2026-11-24').free).toEqual([{ start: '10:00', end: '11:00', new: false }]);
    expect(day(loc(result, 'tampines'), '2026-11-24')).toMatchObject({ free: [], taken: [{ start: '10:00', end: '14:00', status: 'Published' }] });
    expect(day(loc(result, 'pasir-ris'), '2026-11-24')).toEqual({ date: '2026-11-24', free: [{ start: '12:00', end: '14:00', new: false }], mine: [{ start: '10:00', end: '12:00', status: 'Confirmed' }], taken: [] });

    // Busker 07 shares your name; their slot is taken, yours is yours.
    expect(day(loc(result, 'pasir-ris'), '2026-12-03')).toMatchObject({ mine: [{ start: '12:00', end: '14:00' }], taken: [{ start: '10:00', end: '11:00' }], free: [{ start: '11:00', end: '12:00' }] });
    expect(day(loc(result, 'tampines'), '2026-11-29')).toMatchObject({ mine: [], taken: [{ start: '10:00', end: '11:00' }, { start: '13:00', end: '14:00' }], free: [{ start: '11:00', end: '13:00' }] });

    // A day inside the horizon with no bookings is free all day.
    expect(day(loc(result, 'tampines'), '2026-12-02')).toEqual({ date: '2026-12-02', free: [{ start: '10:00', end: '14:00', new: false }], mine: [], taken: [] });
    // Nothing past the last booking seen.
    expect(loc(result, 'changi-village').days.some((d) => d.date > '2026-12-06')).toBe(false);
    // The first check has nothing to compare with.
    expect(result.locations.flatMap((l) => l.days.flatMap((d) => d.free)).some((w) => w.new)).toBe(false);
  });

  it('leaves out today’s blocks that have ended', async () => {
    const { result } = await check('.');
    // At 12:20 the 10–11 (Passed) and 11–12 slots are over; 12–1 is still on.
    expect(day(loc(result, 'tampines'), '2026-11-20')).toEqual({ date: '2026-11-20', free: [], mine: [], taken: [{ start: '12:00', end: '13:00', status: 'Published' }, { start: '13:00', end: '14:00', status: 'Confirmed' }] });
    expect(day(loc(result, 'pasir-ris'), '2026-11-20')).toEqual({ date: '2026-11-20', free: [{ start: '13:00', end: '14:00', new: false }], mine: [], taken: [{ start: '12:00', end: '13:00', status: 'Confirmed' }] });
    // After Tampines closes, today isn't listed for it.
    const late = await check('.', { now: new Date('2026-11-20T14:05:00+08:00') });
    expect(loc(late.result, 'tampines').days[0].date).toBe('2026-11-21');
    expect(loc(late.result, 'paya-lebar').days[0]).toMatchObject({ date: '2026-11-20' });
    expect(loc(late.result, 'paya-lebar').days[0].free.every((w) => w.start >= '14:00')).toBe(true);
  });

  it('flags the windows that weren’t free at the check before: a cancellation, a new date', async () => {
    const file = freshFile();
    await check('.', { file });
    const { result } = await check('later', { file, now: LATER });
    expect(result.ok).toBe(true);
    const fresh = result.locations.flatMap((l) => l.days.flatMap((d) => d.free.filter((w) => w.new).map((w) => `${l.key} ${d.date} ${w.start}-${w.end}`)));
    expect(fresh).toEqual(['tampines 2026-12-15 10:00-13:00', 'paya-lebar 2026-11-24 14:00-19:00']);
    expect(loc(result, 'tampines').horizon_end).toBe('2026-12-15');
    // Taken since: less free, nothing new.
    expect(day(loc(result, 'pasir-ris'), '2026-11-24')).toMatchObject({ free: [{ start: '13:00', end: '14:00', new: false }], taken: [{ start: '12:00', end: '13:00', status: 'Published' }] });
    // And the check after that compares with this one.
    const again = await check('later', { file, now: new Date('2026-11-20T13:20:00+08:00') });
    expect(again.result.locations.flatMap((l) => l.days.flatMap((d) => d.free)).some((w) => w.new)).toBe(false);
  });

  it('never stores a name, profile ID or booking ID', async () => {
    const file = freshFile();
    await check('.', { file });
    const text = fs.readFileSync(file, 'utf8');
    expect(text).not.toMatch(/TEST BUSKER|a0000000-|b0000000-|c0000000-|11111111-2222/i);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['snapshot.json']);
  });

  it('keeps the last good data when NAC blocks it, says why, and backs off', async () => {
    const file = freshFile();
    const good = (await check('.', { file })).result;
    const { result, urls } = await check('blocked', { file, now: new Date('2026-11-20T12:45:00+08:00') });
    expect(urls).toHaveLength(2);
    expect(result).toMatchObject({ ok: false, failures: 1, checked_at: '2026-11-20T12:45:00+08:00', last_good_at: '2026-11-20T12:20:00+08:00' });
    expect(result.error).toBe('Tampines: NAC didn’t return JSON, so it may be blocking Launchpad');
    expect(result.locations).toEqual(good.locations);
    // Skips the 13:15 slot.
    expect(result.next_check).toBe('2026-11-20T13:45:00+08:00');
    const twice = (await check('blocked', { file, now: new Date('2026-11-20T13:45:00+08:00') })).result;
    expect(twice).toMatchObject({ failures: 2, next_check: '2026-11-20T15:15:00+08:00', last_good_at: '2026-11-20T12:20:00+08:00' });
    expect(twice.locations).toEqual(good.locations);
    // Working again: back to every slot, compared with the last good data.
    const back = (await check('.', { file, now: new Date('2026-11-20T15:15:00+08:00') })).result;
    expect(back).toMatchObject({ ok: true, failures: 0, error: null, next_check: '2026-11-20T15:45:00+08:00' });
  });

  it('fails the first check without inventing any data', async () => {
    const { result } = await check('blocked');
    expect(result).toMatchObject({ ok: false, failures: 1, last_good_at: null, locations: [] });
  });

  it('calls no bookings anywhere a failed check, not a free day', async () => {
    const file = freshFile();
    const good = (await check('.', { file })).result;
    const { result } = await check('none', { file });
    expect(result).toMatchObject({ ok: false, error: 'no bookings read at any location, so NAC’s pages may have changed' });
    expect(result.locations).toEqual(good.locations);
  });

  it('shows a location with no bookings as unknown, not free', async () => {
    const { result, urls } = await check('quiet');
    expect(result.ok).toBe(true);
    expect(loc(result, 'changi-village')).toMatchObject({ horizon_end: null, bookings: 0, days: [] });
    // A page with fewer cards than it holds has none to load.
    expect(urls.filter((u) => u.includes(PLACES[3].id))).toHaveLength(1);
    const v = slotView(result, NOW);
    expect(v.noBookings).toEqual(['Changi Village']);
    expect(v.days.every((d) => d.rows.find((r) => r.key === 'changi-village')!.kind === 'unknown')).toBe(true);
  });

  it('counts an unknown status as taken, and says which', async () => {
    const html = pageWith([card({ status: 'Cancelled', date: 'Mon, 23 November', time: '10:00:AM-11:00:AM' }), card({ status: 'Published', date: 'Mon, 23 November', time: '12:00:PM-01:00:PM' })]);
    const { result, logs } = await check('.', { places: [PLACES[1]], fetcher: onePlace(html) });
    expect(result.unknown_statuses).toEqual(['Cancelled']);
    expect(day(loc(result, 'pasir-ris'), '2026-11-23')).toEqual({
      date: '2026-11-23',
      free: [{ start: '11:00', end: '12:00', new: false }, { start: '13:00', end: '14:00', new: false }],
      mine: [],
      taken: [{ start: '10:00', end: '11:00', status: 'Cancelled' }, { start: '12:00', end: '13:00', status: 'Published' }],
    });
    expect(logs.some((l) => l.includes('“Cancelled”'))).toBe(true);
  });

  it('counts a Passed booking on a slot that hasn’t ended as taken', async () => {
    const html = pageWith([card({ status: 'Passed', date: 'Sat, 21 November', time: '10:00:AM-12:00:PM' })]);
    const { result, logs } = await check('.', { places: [PLACES[1]], fetcher: onePlace(html) });
    expect(day(loc(result, 'pasir-ris'), '2026-11-21')).toMatchObject({ free: [{ start: '12:00', end: '14:00' }], taken: [{ start: '10:00', end: '12:00', status: 'Passed' }] });
    expect(logs.filter((l) => l.includes('Passed'))).toHaveLength(1);
  });

  it('reads bookings across New Year', async () => {
    const html = pageWith([card({ date: 'Thu, 31 December', time: '12:00:PM-02:00:PM' }), card({ date: 'Fri, 1 January', time: '10:00:AM-11:00:AM' })]);
    const { result } = await check('.', { places: [PLACES[1]], fetcher: onePlace(html), now: new Date('2026-12-31T10:30:00+08:00') });
    const l = loc(result, 'pasir-ris');
    expect(l.horizon_end).toBe('2027-01-01');
    expect(l.days.map((d) => [d.date, d.free.map((w) => `${w.start}-${w.end}`), d.taken.map((w) => `${w.start}-${w.end}`)])).toEqual([
      ['2026-12-31', ['10:00-12:00'], ['12:00-14:00']],
      ['2027-01-01', ['11:00-14:00'], ['10:00-11:00']],
    ]);
  });

  it('fails when the list shifts between load-more calls, rather than skip a booking unseen', async () => {
    const inner = fixtureFetcher(DIR, PLACES, NOW);
    // As if two bookings near the top were cancelled between the page and the load-more call.
    const shifted: Fetcher = async (url, kind) => {
      const body = await inner(url, kind);
      if (kind !== 'more') return body;
      const cards = JSON.parse(body) as string;
      const parts = cards.split(/(?=    <div class="col-md-6)/);
      return JSON.stringify(parts.slice(3).join(''));
    };
    const { result } = await check('.', { places: [PLACES[0]], fetcher: shifted });
    expect(result).toMatchObject({ ok: false, error: 'Tampines: the list of bookings changed while it was being read, so it’ll try again' });
  });

  it('pages through a long list until a call returns fewer than asked for', async () => {
    const all = Array.from({ length: 450 }, (_, i) => card({ date: `${['Sat', 'Sun', 'Mon'][i % 3]}, ${21 + (i % 3)} November`, time: '10:00:AM-11:00:AM', booking: `id-${i}` }));
    const page = pageWith(all.slice(0, 12));
    const asked: string[] = [];
    const fetcher: Fetcher = async (url, kind) => {
      if (kind === 'page') return page;
      asked.push(url.slice(url.indexOf('?')));
      const q = new URL(url).searchParams;
      const skip = Number(q.get('skip'));
      return JSON.stringify(all.slice(skip, skip + Number(q.get('take'))).join(''));
    };
    const { result } = await check('.', { places: [PLACES[1]], fetcher });
    expect(asked).toEqual(['?skip=10&take=200', '?skip=208&take=200', '?skip=406&take=200']);
    expect(loc(result, 'pasir-ris').bookings).toBe(450);
  });
});

// ---------- asking NAC ----------

describe('asking NAC', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('stops at anything but a plain 200', async () => {
    const answer = (status: number) => vi.fn(async () => new Response('x', { status, headers: status === 302 ? { location: '/elsewhere' } : {} }));
    vi.stubGlobal('fetch', answer(403));
    await expect(liveFetch('https://eservices.nac.gov.sg/Busking/locations/x/events', 'page')).rejects.toThrow('NAC answered 403, so it may be blocking Launchpad, or it’s down');
    vi.stubGlobal('fetch', answer(302));
    await expect(liveFetch('https://eservices.nac.gov.sg/Busking/locations/x/events', 'page')).rejects.toThrow('NAC answered 302 (a redirect)');
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }))));
    await expect(liveFetch('https://eservices.nac.gov.sg/Busking/locations/x/events', 'page')).rejects.toThrow('couldn’t reach NAC (ENOTFOUND)');
  });

  it('sends schedule-sync’s headers: a generic User-Agent, XHR for load-more, no redirects followed', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('"x"', { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect(await liveFetch('https://eservices.nac.gov.sg/Busking/locations/x/events/more?skip=10&take=200', 'more')).toBe('"x"');
    const init = fetch.mock.calls[0][1]!;
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe('Mozilla/5.0 (launchpad slot finder)');
    expect(headers['User-Agent']).not.toMatch(/@/);
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(init.redirect).toBe('manual');
  });
});

// ---------- schedule and snapshot ----------

describe('when it checks', () => {
  it('checks on :15 and :45, out of schedule-sync’s :00 and :30', () => {
    const at = (s: string) => nextSlot(new Date(s)).toISOString();
    expect(at('2026-11-20T12:20:00+08:00')).toBe(new Date('2026-11-20T12:45:00+08:00').toISOString());
    expect(at('2026-11-20T12:44:59+08:00')).toBe(new Date('2026-11-20T12:45:00+08:00').toISOString());
    expect(at('2026-11-20T12:45:00+08:00')).toBe(new Date('2026-11-20T13:15:00+08:00').toISOString());
    expect(at('2026-11-20T23:50:00+08:00')).toBe(new Date('2026-11-21T00:15:00+08:00').toISOString());
  });

  it('waits longer after each failure in a row', () => {
    const after = (f: number) => nextCheck(new Date('2026-11-20T12:20:00+08:00'), f).toISOString();
    const t = (s: string) => new Date(`2026-11-20T${s}:00+08:00`).toISOString();
    expect([0, 1, 2, 3, 4, 9].map(after)).toEqual([t('12:45'), t('13:15'), t('13:45'), t('14:45'), t('16:45'), t('16:45')]);
  });

  it('stays clear of schedule-sync’s :00 and :30 when checking out of turn', () => {
    const at = (s: string) => clearOfScheduleSync(new Date(s)).toISOString();
    const t = (s: string) => new Date(s).toISOString();
    expect(at('2026-11-20T23:40:00+08:00')).toBe(t('2026-11-20T23:40:00+08:00'));
    expect(at('2026-11-20T23:57:59+08:00')).toBe(t('2026-11-20T23:57:59+08:00'));
    expect(at('2026-11-20T23:58:00+08:00')).toBe(t('2026-11-21T00:02:00+08:00'));
    expect(at('2026-11-21T00:01:30+08:00')).toBe(t('2026-11-21T00:02:00+08:00'));
    expect(at('2026-11-21T00:02:00+08:00')).toBe(t('2026-11-21T00:02:00+08:00'));
    expect(at('2026-11-20T12:29:00+08:00')).toBe(t('2026-11-20T12:32:00+08:00'));
    expect(at('2026-11-20T12:31:59+08:00')).toBe(t('2026-11-20T12:32:00+08:00'));
  });

  it('skips a slot within 10 minutes of the check before it', () => {
    expect(nextCheck(new Date('2026-11-20T23:40:00+08:00'), 0).toISOString()).toBe(new Date('2026-11-21T00:15:00+08:00').toISOString());
    expect(nextCheck(new Date('2026-11-20T23:34:00+08:00'), 0).toISOString()).toBe(new Date('2026-11-20T23:45:00+08:00').toISOString());
  });

  it('says why Check now can’t be used', () => {
    const at = (s: string) => new Date(`2026-11-20T${s}:00+08:00`);
    const good: NacSlots = { checked_at: '2026-11-20T23:45:00+08:00', ok: true, error: null, last_good_at: '2026-11-20T23:45:00+08:00', next_check: '2026-11-21T00:15:00+08:00', failures: 0, unknown_statuses: [], mine_on: true, locations: [] };
    expect(refusal(null, at('23:50'), false)).toBeNull();
    expect(refusal(null, at('23:50'), true)).toBe('A check is running now.');
    expect(refusal(good, at('23:50'), false)).toBe('The last check was at 23:45. You can ask for another from 23:55.');
    expect(refusal(good, at('23:55'), false)).toBeNull();
    const failed = { ...good, ok: false, error: 'Tampines: NAC answered 403', failures: 1, next_check: '2026-11-21T00:45:00+08:00' };
    expect(refusal(failed, at('23:58'), false)).toBe('The last check failed, so Launchpad leaves NAC alone until 00:45.');
    // Once the back-off's over, it can be asked for again.
    expect(refusal(failed, new Date('2026-11-21T00:46:00+08:00'), false)).toBeNull();
  });

  it('writes the snapshot whole, then renames it into place', () => {
    const file = freshFile();
    const s: NacSlots = { checked_at: null, ok: true, error: null, last_good_at: null, next_check: null, failures: 0, unknown_statuses: [], mine_on: false, locations: [] };
    writeSnapshot(s, file);
    writeSnapshot({ ...s, failures: 2 }, file);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['snapshot.json']);
    expect(readSnapshot(file)?.failures).toBe(2);
    fs.writeFileSync(file, '{"half');
    expect(readSnapshot(file)).toBeNull();
    expect(readSnapshot(path.join(tmp, 'nowhere.json'))).toBeNull();
  });
});

// ---------- the scheduler ----------

describe('the scheduler', () => {
  afterEach(() => vi.useRealTimers());
  const sgt = (s: string) => new Date(`2026-11-20T${s}+08:00`);
  const at = (d: Date) => sgtIso(d).slice(11, 19);

  /** A scheduler whose checks take a minute and write a result the way runCheck does. */
  function harness(start: string, initial: NacSlots | null, result: 'ok' | 'fail' = 'ok') {
    vi.useFakeTimers({ now: sgt(start) });
    let snap = initial;
    const calls: string[] = [];
    const check = async () => {
      const began = new Date();
      calls.push(at(began));
      await new Promise((r) => setTimeout(r, 60_000));
      const failures = result === 'ok' ? 0 : (snap?.failures ?? 0) + 1;
      snap = {
        ...(snap ?? emptySlots(true)),
        checked_at: sgtIso(began),
        ok: result === 'ok',
        error: result === 'ok' ? null : 'Tampines: NAC answered 403',
        last_good_at: result === 'ok' ? sgtIso(began) : (snap?.last_good_at ?? null),
        failures,
        next_check: sgtIso(nextCheck(new Date(), failures)),
      };
    };
    const s = makeScheduler({ check, read: () => snap });
    return { s, calls, snap: () => snap };
  }
  const until = (s: string) => vi.advanceTimersByTimeAsync(sgt(s).getTime() - Date.now());
  const untilIso = (iso: string) => vi.advanceTimersByTimeAsync(new Date(iso).getTime() - Date.now());
  const checked = (s: string): NacSlots => ({ checked_at: `2026-11-20T${s}+08:00`, ok: true, error: null, last_good_at: `2026-11-20T${s}+08:00`, next_check: sgtIso(nextCheck(sgt(s), 0)), failures: 0, unknown_statuses: [], mine_on: true, locations: [] });

  it('checks straight away when there’s no data yet, then on :15 and :45', async () => {
    const h = harness('23:33:00', null);
    h.s.start();
    await until('23:33:01');
    expect(h.calls).toEqual(['23:33:00']);
    await until('23:44:59');
    expect(h.calls).toEqual(['23:33:00']);
    await until('23:45:01');
    expect(h.calls).toEqual(['23:33:00', '23:45:00']);
    h.s.stop();
  });

  it('waits for schedule-sync’s :30 to pass before the first check', async () => {
    const h = harness('23:29:00', null);
    h.s.start();
    expect(h.s.state().queued).toBe(sgt('23:32:00').getTime());
    await until('23:31:59');
    expect(h.calls).toEqual([]);
    await until('23:32:01');
    expect(h.calls).toEqual(['23:32:00']);
    h.s.stop();
  });

  it('doesn’t check at startup when there’s data already', async () => {
    const h = harness('23:20:00', checked('23:15:00'));
    h.s.start();
    await until('23:44:59');
    expect(h.calls).toEqual([]);
    await until('23:45:01');
    expect(h.calls).toEqual(['23:45:00']);
    h.s.stop();
  });

  it('runs a check asked for at once, then refuses for 10 minutes, and skips a slot too close to it', async () => {
    const h = harness('23:35:00', checked('23:15:00'));
    h.s.start();
    expect(h.s.request()).toEqual({ ok: true, at: '2026-11-20T23:35:00+08:00' });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.s.state().running).toBe(true);
    expect(h.s.request()).toEqual({ ok: false, error: 'A check is running now.' });
    await until('23:40:00');
    expect(h.s.request()).toEqual({ ok: false, error: 'The last check was at 23:35. You can ask for another from 23:45.' });
    // The 23:45 slot is within 10 minutes of it, so the next one's at 00:15.
    expect(h.snap()!.next_check).toBe('2026-11-21T00:15:00+08:00');
    await until('23:50:00');
    expect(h.calls).toEqual(['23:35:00']);
    await untilIso('2026-11-21T00:15:01+08:00');
    expect(h.calls).toEqual(['23:35:00', '00:15:00']);
    h.s.stop();
  });

  it('lets a slot that comes while a check asked for is running wait for it', async () => {
    const h = harness('23:44:30', checked('23:15:00'));
    h.s.start();
    expect(h.s.request().ok).toBe(true);
    await until('23:46:00');
    expect(h.calls).toEqual(['23:44:30']);
    expect(h.snap()!.next_check).toBe('2026-11-21T00:15:00+08:00');
    h.s.stop();
  });

  it('puts one asked for on :59 off until schedule-sync’s :00 has passed', async () => {
    const h = harness('23:59:00', checked('23:15:00'));
    h.s.start();
    expect(h.s.request()).toEqual({ ok: true, at: '2026-11-21T00:02:00+08:00' });
    // Asking again just says when.
    expect(h.s.request()).toEqual({ ok: true, at: '2026-11-21T00:02:00+08:00' });
    await untilIso('2026-11-21T00:01:59+08:00');
    expect(h.calls).toEqual([]);
    await untilIso('2026-11-21T00:02:01+08:00');
    expect(h.calls).toEqual(['00:02:00']);
    h.s.stop();
  });

  it('won’t check by hand while it’s backing off after a failure', async () => {
    const h = harness('23:20:00', checked('23:15:00'), 'fail');
    h.s.start();
    // The 23:45 check takes its minute, then fails.
    await until('23:46:01');
    expect(h.snap()).toMatchObject({ ok: false, failures: 1, next_check: '2026-11-21T00:45:00+08:00' });
    await until('23:58:00');
    expect(h.s.request()).toEqual({ ok: false, error: 'The last check failed, so Launchpad leaves NAC alone until 00:45.' });
    h.s.stop();
  });

  it('tells the page what’s waiting and when the next check is', () => {
    const idle = { running: false, queued: null, planned: sgt('23:45:00').getTime() };
    expect(statusOf(null, { ...idle, queued: sgt('23:32:00').getTime() }, sgt('23:29:00'), true)).toMatchObject({ checked_at: null, next_check: '2026-11-20T23:32:00+08:00', queued_at: '2026-11-20T23:32:00+08:00', can_check: null, running: false });
    expect(statusOf(checked('23:15:00'), idle, sgt('23:30:00'), true)).toMatchObject({ next_check: '2026-11-20T23:45:00+08:00', queued_at: null, can_check: null });
    expect(statusOf(checked('23:15:00'), idle, sgt('23:20:00'), true).can_check).toBe('The last check was at 23:15. You can ask for another from 23:25.');
    // A next check missed while the server was down: the planned one instead.
    expect(statusOf(checked('20:15:00'), { ...idle, planned: sgt('23:45:00').getTime() }, sgt('23:40:00'), true).next_check).toBe('2026-11-20T23:45:00+08:00');
    expect(statusOf(checked('23:15:00'), { ...idle, running: true }, sgt('23:20:00'), true)).toMatchObject({ running: true, can_check: 'A check is running now.' });
  });
});

// ---------- what the page shows ----------

describe('the Music view’s slot list', () => {
  it('groups by date, then location, from today to the last day any location knows', async () => {
    const { result } = await check('.');
    const v = slotView(result, NOW);
    expect(v.days[0].date).toBe('2026-11-20');
    expect(v.days[v.days.length - 1].date).toBe('2026-12-14');
    expect(v.lastDate).toBe('2026-12-14');
    expect(v.days.every((d) => d.rows.map((r) => r.key).join() === 'tampines,pasir-ris,paya-lebar,changi-village')).toBe(true);
    const tue = v.days.find((d) => d.date === '2026-11-24')!;
    expect(tue.rows.map((r) => [r.short, r.kind, r.free.map(fmtRange), r.mine.map(fmtRange)])).toEqual([
      ['Tampines', 'full', [], []],
      ['Pasir Ris', 'open', ['12 PM – 2 PM'], ['10 AM – 12 PM']],
      ['Paya Lebar', 'open', ['2 PM – 3 PM', '5 PM – 7 PM'], []],
      ['Changi Village', 'open', ['10 AM – 11 AM'], []],
    ]);
    // Past a location's last booking: unknown, never free.
    const dec10 = v.days.find((d) => d.date === '2026-12-10')!;
    expect(dec10.rows.find((r) => r.key === 'changi-village')).toMatchObject({ kind: 'unknown', free: [] });
    expect(v.days.flatMap((d) => d.rows).filter((r) => r.kind === 'unknown').every((r) => !r.free.length && !r.mine.length)).toBe(true);
  });

  it('drops what has ended since the check, so old data never shows a slot that’s over', async () => {
    const { result } = await check('.');
    const v = slotView(result, new Date('2026-11-20T15:30:00+08:00'));
    const today = v.days[0].rows;
    expect(today.find((r) => r.key === 'tampines')!.kind).toBe('done');
    expect(today.find((r) => r.key === 'pasir-ris')!.kind).toBe('done');
    const paya = day(loc(result, 'paya-lebar'), '2026-11-20');
    const shown = today.find((r) => r.key === 'paya-lebar')!;
    // Every window still shown starts no earlier than the block 15:30 is in.
    expect(shown.free.every((w) => w.start >= '15:00' && w.end > '15:30')).toBe(true);
    expect(shown.free.length).toBeLessThanOrEqual(paya.free.length);
    // The next day, yesterday's data starts from today.
    expect(slotView(result, new Date('2026-11-21T09:00:00+08:00')).days[0].date).toBe('2026-11-21');
  });

  it('finds nothing free when everything is booked', async () => {
    const { result } = await check('full');
    const v = slotView(result, NOW);
    expect(v.freeWindows).toBe(0);
    expect(v.days.flatMap((d) => d.rows).every((r) => r.kind === 'full' || r.kind === 'done')).toBe(true);
  });

  it('says which day a time is on only when that isn’t clear', () => {
    const now = new Date('2026-11-20T23:50:00+08:00');
    expect(fmtClock('2026-11-20T22:42:00+08:00', now)).toBe('22:42');
    expect(fmtClock('2026-11-21T00:15:00+08:00', now)).toBe('00:15');
    expect(fmtClock('2026-11-21T13:15:00+08:00', now)).toBe('tomorrow 13:15');
    expect(fmtClock('2026-11-19T13:30:00+08:00', now)).toBe('yesterday 13:30');
    expect(fmtClock('2026-11-17T13:30:00+08:00', now)).toBe('Tue 17 Nov 13:30');
  });

  it('writes times the way the spec does', () => {
    expect(['14:00', '10:00', '12:00', '00:00', '24:00', '10:30'].map(ampm)).toEqual(['2 PM', '10 AM', '12 PM', '12 AM', '12 AM', '10:30 AM']);
    expect(fmtRange({ start: '14:00', end: '19:00' })).toBe('2 PM – 7 PM');
  });
});
