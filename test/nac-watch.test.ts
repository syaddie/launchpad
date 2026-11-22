// Watched busking slots (server/src/nac.ts, shared/nac.ts): watching a slot, noticing when any of
// it frees up after a check, telling the phone once, and the watch going when its day or place does.
// Checks read test/fixtures/nac; nothing here asks NAC, and nothing is sent: `send` is a stand-in.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../server/src/config';
import { addWatch, alertWatches, editPlaces, fixtureFetcher, NacError, nacStatus, removeWatch, runCheck } from '../server/src/nac';
import { store } from '../server/src/store';
import { DEFAULT_PREFS } from '../shared/defaults';
import { addDaysYmd, cleanNacWatches, fmtWatch, NAC_MAX_WATCHES, watchHits } from '../shared/nac';
import type { NacSlots, NacWatch } from '../shared/types';

const DIR = path.join(__dirname, 'fixtures/nac');
const META = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8')) as { now: string; later: string };
const NOW = new Date(META.now);
const LATER = new Date(META.later);
const DEFAULTS = config.nac.locations;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-nac-watch-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The check on the fixtures, then the one after it (later/): a cancellation at Paya Lebar on Tue 24 Nov, 2 PM to 7 PM, and Tampines opening Tue 15 Dec. */
async function twoChecks(): Promise<NacSlots> {
  const file = path.join(tmp, `snap-${Math.random().toString(36).slice(2)}.json`);
  const run = (folder: string, now: Date) => runCheck({ places: DEFAULTS, fetcher: fixtureFetcher(path.join(DIR, folder), DEFAULTS, now), wait: async () => {}, mineId: '', file, now: () => now, log: () => {} });
  await run('.', NOW);
  return run('later', LATER);
}

/** A stand-in for notify(), keeping what would have gone to the phone. */
function sender() {
  const sent: { kind: string; key: string; title: string; body?: string; click?: string }[] = [];
  const send = async (a: (typeof sent)[number]) => (sent.push(a), 'sent' as const);
  return { sent, send };
}

beforeEach(() => {
  store.setNacPlaces(DEFAULTS);
  store.setNacWatches([]);
  store.setAlertTopic('');
  store.setPrefs({ ...DEFAULT_PREFS });
});

describe('a watched slot', () => {
  it('is a real day, real hours and one of each, at most the most', () => {
    const w = { id: 'w1abcd', place: 'paya-lebar', date: '2026-11-24', start: '14:00', end: '19:00', created: '2026-11-20T04:00:00.000Z', freed: null, found: [] };
    expect(cleanNacWatches(null)).toEqual([]);
    expect(cleanNacWatches([w, { ...w }])).toEqual([w]);
    const bad = [
      { ...w, id: 'x' },
      { ...w, id: 'w2abcd', date: '2026-02-30' },
      { ...w, id: 'w3abcd', start: '19:00', end: '14:00' },
      { ...w, id: 'w4abcd', end: '25:00' },
      { ...w, id: 'w5abcd', place: 'Paya Lebar!' },
    ];
    expect(cleanNacWatches(bad)).toEqual([]);
    const many = Array.from({ length: 40 }, (_, i) => ({ ...w, id: `w-${String(i).padStart(4, '0')}` }));
    expect(cleanNacWatches(many)).toHaveLength(NAC_MAX_WATCHES);
  });

  it('is hit only by a window that’s just freed up, cut to the hours watched', () => {
    const w = { date: '2026-11-24', start: '15:00', end: '18:00' };
    expect(watchHits(w, undefined)).toEqual([]);
    expect(watchHits(w, { free: [{ start: '14:00', end: '19:00', new: false }] })).toEqual([]);
    expect(watchHits(w, { free: [{ start: '14:00', end: '19:00', new: true }] })).toEqual([{ start: '15:00', end: '18:00' }]);
    expect(watchHits(w, { free: [{ start: '10:00', end: '15:00', new: true }, { start: '17:00', end: '20:00', new: true }] })).toEqual([{ start: '17:00', end: '18:00' }]);
    expect(fmtWatch({ start: '10:00', end: '22:00' }, '10:00', '22:00')).toBe('any time');
    expect(fmtWatch({ start: '14:00', end: '19:00' }, '10:00', '22:00')).toBe('2 PM – 7 PM');
  });
});

describe('watching', () => {
  it('takes a slot at a location on the list, today up to 60 days ahead', () => {
    const w = addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00' }, NOW);
    expect(w).toMatchObject({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00', freed: null, found: [] });
    // The same slot again is the same watch.
    expect(addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00' }, NOW).id).toBe(w.id);
    expect(store.nacWatches()).toHaveLength(1);
    const no = (body: Record<string, string>, why: RegExp) => expect(() => addWatch(body, NOW)).toThrow(why);
    no({ place: 'bugis', date: '2026-11-24', start: '15:00', end: '18:00' }, /isn’t on the list/);
    no({ place: 'paya-lebar', date: '2026-11-19', start: '15:00', end: '18:00' }, /has passed/);
    no({ place: 'paya-lebar', date: '2027-01-20', start: '15:00', end: '18:00' }, /60 days ahead/);
    no({ place: 'paya-lebar', date: '2026-11-31', start: '15:00', end: '18:00' }, /isn’t a day/);
    no({ place: 'paya-lebar', date: '2026-11-24', start: '18:00', end: '15:00' }, /don’t read as a slot/);
    expect(() => addWatch({}, NOW)).toThrow(NacError);
  });

  it('stops at the most, and can be stopped', () => {
    // One a day for a month.
    for (let i = 0; i < NAC_MAX_WATCHES; i++) addWatch({ place: 'tampines', date: addDaysYmd('2026-11-21', i), start: '10:00', end: '12:00' }, NOW);
    expect(store.nacWatches()).toHaveLength(NAC_MAX_WATCHES);
    expect(() => addWatch({ place: 'tampines', date: '2026-11-20', start: '10:00', end: '12:00' }, NOW)).toThrow(`That’s ${NAC_MAX_WATCHES} slots watched already`);
    const id = store.nacWatches()[0].id;
    removeWatch(id);
    expect(store.nacWatches().some((w) => w.id === id)).toBe(false);
    expect(store.nacWatches()).toHaveLength(NAC_MAX_WATCHES - 1);
    // Stopping one that's gone already is fine.
    removeWatch(id);
  });

  it('goes with its location when that comes off the list', () => {
    addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00' }, NOW);
    addWatch({ place: 'tampines', date: '2026-11-24', start: '10:00', end: '12:00' }, NOW);
    editPlaces(DEFAULTS.filter((p) => p.key !== 'paya-lebar'));
    expect(store.nacWatches().map((w) => w.place)).toEqual(['tampines']);
  });
});

describe('after a check', () => {
  it('tells the phone once about each watched slot that’s just freed up, with a link to book it', async () => {
    const cancelled = addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00' }, NOW);
    const opened = addWatch({ place: 'tampines', date: '2026-12-15', start: '10:00', end: '14:00' }, NOW);
    const quiet = addWatch({ place: 'paya-lebar', date: '2026-11-25', start: '15:00', end: '18:00' }, NOW);
    const result = await twoChecks();
    const { sent, send } = sender();
    const freed = await alertWatches(result, LATER, send);
    expect(freed.map((w) => w.id).sort()).toEqual([cancelled.id, opened.id].sort());
    expect(sent).toHaveLength(2);
    const pl = sent.find((a) => a.key === `busking:${cancelled.id}`)!;
    expect(pl).toEqual({
      kind: 'busking',
      key: `busking:${cancelled.id}`,
      title: 'Busking slot free: Paya Lebar, Tue 24 Nov',
      body: '3 PM – 6 PM is free now at Paya Lebar Square. Book it on the NAC portal before someone else does.',
      click: `https://eservices.nac.gov.sg/Busking/locations/${DEFAULTS[2].id}/events`,
    });
    // The day opening for booking counts as freeing up.
    expect(sent.find((a) => a.key === `busking:${opened.id}`)!.body).toMatch(/^10 AM – 1 PM is free now at Tampines Interchange/);
    const kept = store.nacWatches();
    expect(kept.find((w) => w.id === cancelled.id)).toMatchObject({ freed: LATER.toISOString(), found: [{ start: '15:00', end: '18:00' }] });
    expect(kept.find((w) => w.id === quiet.id)).toMatchObject({ freed: null, found: [] });
    // Once only.
    const again = sender();
    expect(await alertWatches(result, LATER, again.send)).toEqual([]);
    expect(again.sent).toEqual([]);
  });

  it('says nothing after a failed check, and drops watches whose day is over', async () => {
    addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '15:00', end: '18:00' }, NOW);
    const result = await twoChecks();
    const { sent, send } = sender();
    expect(await alertWatches({ ...result, ok: false }, LATER, send)).toEqual([]);
    expect(sent).toEqual([]);
    await alertWatches(result, new Date('2026-11-25T09:00:00+08:00'), send);
    expect(sent).toEqual([]);
    expect(store.nacWatches()).toEqual([]);
  });

  it('nothing new on the day: nothing sent', async () => {
    addWatch({ place: 'paya-lebar', date: '2026-11-24', start: '10:00', end: '12:00' }, NOW);
    const { sent, send } = sender();
    await alertWatches(await twoChecks(), LATER, send);
    expect(sent).toEqual([]);
  });
});

describe('what the page is told', () => {
  it('lists the watches from today on, at locations on the list, and whether they reach the phone', () => {
    const today = new Date('2026-11-24T09:00:00+08:00');
    store.setNacWatches(cleanNacWatches([
      { id: 'w-past', place: 'tampines', date: '2026-11-23', start: '10:00', end: '11:00', created: '', freed: null, found: [] },
      { id: 'w-today', place: 'tampines', date: '2026-11-24', start: '10:00', end: '11:00', created: '', freed: null, found: [] },
      { id: 'w-gone', place: 'bugis', date: '2026-11-25', start: '10:00', end: '11:00', created: '', freed: null, found: [] },
    ] as NacWatch[]));
    const s = nacStatus(today);
    expect(s.watches.map((w) => w.id)).toEqual(['w-today']);
    expect(s.watch_alerts).toBe('no-topic');
    store.setAlertTopic('https://ntfy.sh/launchpad-test-topic');
    expect(nacStatus(today).watch_alerts).toBe('ok');
    store.setPrefs({ ...DEFAULT_PREFS, alerts: { ...DEFAULT_PREFS.alerts, busking: false } });
    expect(nacStatus(today).watch_alerts).toBe('off');
  });
});
