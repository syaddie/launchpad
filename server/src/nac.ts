// NAC Slot Finder (docs/nac-slot-finder-spec.md): which busking slots are still free at the
// NAC locations on the list (config's four to start with, then Music › Busking slots ›
// Locations), for Music › Busking slots. Booking itself stays on the NAC portal.
//
// Every 10 minutes, on :05, :15, :25, :35, :45 and :55 (streamlit-portfolio's schedule-sync takes :00 and :30),
// it reads each location's public page and then its "load more" list, one request at a time
// about 2 s apart; works out which 1-hour blocks are yours, taken or free; joins free blocks
// into windows; flags the windows that weren't free at the check before; and keeps the result
// in DATA_DIR/nac/snapshot.json, the only thing it stores. A check that fails, or that NAC
// blocks, stops there, keeps the last good data with the reason, and waits longer before the
// next. It never tries to get around NAC's bot protection. Adding a location reads its page
// once to check it's a real one, in turn with the checks' requests, never alongside them.
//
// Kept apart from the other scrapers. fetchFragment, parseNacDate, parseNacTime, writeSnapshot
// and the keep-last-good run are TypeScript copies of schedule-sync's sync.py (fetch,
// parse_date, parse_time, write_csv, run), which can't be imported from here.
//
// No busker's name is ever read, and profile IDs are only compared with NAC_BUSKER_ID while a
// card is parsed: nothing stored, logged or sent to the page holds either.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, type NacPlace } from './config';
import { store } from './store';
import { addDaysYmd, daysBetween, DOW3, guessNacNames, hhmm, MONTH_NAMES, NAC_MAX_PLACES, NAC_NAME_MAX, NAC_SHORT_MAX, nacPlaceId, nacPlaceKey, sgtIso, sgtMinutes, sgtYmd, toMin, weekdayOf } from '../../shared/nac';
import type { NacBooked, NacDay, NacFree, NacLocation, NacLookup, NacSlots, NacStatus } from '../../shared/types';

const BASE_URL = 'https://eservices.nac.gov.sg/Busking';
/** schedule-sync's style: generic, nothing personal in it. */
const USER_AGENT = 'Mozilla/5.0 (launchpad slot finder)';
/** Load-more pages: 200 got all of a location's list in one call when the spec was written. */
export const TAKE = 200;
/**
 * Each load-more starts this many cards back from what's been read, and its first card must be
 * one of those: a booking cancelled between two calls shifts the list, and without the overlap
 * the card after it would be skipped unseen and its slot shown as free.
 */
export const OVERLAP = 2;
/** A safety stop, as in sync.py: 2,000 cards. */
const MAX_PAGES = 10;
/** Between one request and the next. */
const GAP_MS = 2000;
/** It checks every 10 minutes, this many minutes past each tenth: :05, :15 … :55, clear of schedule-sync's :00 and :30. */
const SLOT_MINUTES = 5;
const SLOT_MS = 10 * 60_000;
/** Slots skipped after 1, 2, 3, and 4 or more failed checks in a row: tries again after 1 h, 1.5 h, 2.5 h, then every 4.5 h. */
const BACKOFF = [5, 8, 14, 26];
/** The load-more answers carry every busker's photo inline (about 0.3 MB a card), so a big list is tens of MB. Past this, something's wrong. */
const MAX_BYTES = 250_000_000;
/** Statuses with a known meaning. Passed is "in the past"; anything else counts as taken (spec §4). */
const KNOWN = new Set(['published', 'confirmed', 'passed']);

/** Why a check failed, in words for the page (no names or IDs in it). */
export class NacError extends Error {}

// ---------- reading NAC's pages ----------

/** One booking card, with only what's needed. `mine` was worked out from the profile ID, which isn't kept. */
export interface NacCard {
  status: string;
  mine: boolean;
  date: string;
  start: number;
  end: number;
  /** NAC's booking id, to tell cards apart while a list is read; '' on past ones. Not kept either. */
  id: string;
}

export interface NacPage {
  /** NAC's name for the location. */
  name: string;
  open: number;
  close: number;
  /** Cards the page shows before "Load more"; null when it doesn't say. */
  pageSize: number | null;
  cards: NacCard[];
}

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Python's html.unescape for what NAC's pages use: "BLK 2 &amp; 3", and numeric references. */
export function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const clean = (s: string) => unescapeHtml(s).replace(/\s+/g, ' ').trim();

const MONTHS = MONTH_NAMES.map((m) => m.toLowerCase());

/**
 * "Fri, 20 November" → "2026-11-20" (sync.py's parse_date). NAC leaves the year out, so it's
 * the year whose date falls on that weekday: this year or next, as there, or last year for a
 * date up to a week back, so a past slot still on the list just after New Year reads too.
 * Before this month (or that week) isn't a date on the list, so it's not taken as one.
 */
export function parseNacDate(text: string, today: string): string {
  const m = /^\s*([a-z]{3,})\.?\s*,?\s*(\d{1,2})\s+([a-z]{3,})\s*$/i.exec(text);
  const dow = m ? DOW3.findIndex((d) => d.toLowerCase() === m[1].slice(0, 3).toLowerCase()) : -1;
  const month = m ? MONTHS.findIndex((x) => x === m[3].toLowerCase() || x.slice(0, 3) === m[3].toLowerCase()) : -1;
  if (m && dow >= 0 && month >= 0) {
    const day = Number(m[2]);
    const year = Number(today.slice(0, 4));
    const firstOfMonth = today.slice(0, 8) + '01';
    const weekBack = addDaysYmd(today, -7);
    const earliest = weekBack < firstOfMonth ? weekBack : firstOfMonth;
    for (const y of [year, year + 1, year - 1]) {
      const d = new Date(Date.UTC(y, month, day));
      // 31 November, or 29 February in a year without one.
      if (d.getUTCMonth() !== month || d.getUTCDate() !== day || d.getUTCDay() !== dow) continue;
      const ymd = `${y}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      if (ymd >= earliest) return ymd;
    }
  }
  throw new NacError(`a date NAC wrote that doesn’t read as one (“${text.trim().slice(0, 40)}”)`);
}

/** "06:00:PM" → 1080, minutes after midnight (sync.py's parse_time, '%I:%M:%p'). */
export function parseNacTime(text: string): number {
  const m = /^\s*(\d{1,2}):(\d{2}):\s*([ap])m\s*$/i.exec(text);
  const h = m ? Number(m[1]) : 0;
  const min = m ? Number(m[2]) : 0;
  if (!m || h < 1 || h > 12 || min > 59) throw new NacError(`a time NAC wrote that doesn’t read as one (“${text.trim().slice(0, 30)}”)`);
  return ((h % 12) + (m[3].toLowerCase() === 'p' ? 12 : 0)) * 60 + min;
}

/** "11:00:AM-12:00:PM" or "10:00:AM - 02:00:PM" → [660, 720]. An end of 12:00:AM is midnight. */
export function parseNacRange(text: string): [number, number] {
  const parts = text.split('-');
  if (parts.length !== 2) throw new NacError(`a time range NAC wrote that doesn’t read as one (“${text.trim().slice(0, 40)}”)`);
  const start = parseNacTime(parts[0]);
  let end = parseNacTime(parts[1]);
  if (end === 0) end = 24 * 60;
  if (end <= start) throw new NacError(`a time range that ends before it starts (“${text.trim().slice(0, 40)}”)`);
  return [start, end];
}

const CARD = /class="dash-bx-menus\b/g;
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The booking cards in a page or a load-more fragment. Each starts at its status menu
 * (`dash-bx-menus`) and runs to the next one. A card without a status, date or time means
 * NAC's markup has changed, and fails the check rather than leaving its slot looking free.
 */
export function parseCards(html: string, today: string, mineId: string): NacCard[] {
  const starts = [...html.matchAll(CARD)].map((m) => m.index);
  return starts.map((at, i) => {
    const card = html.slice(at, starts[i + 1] ?? html.length);
    const status = clean(/^class="dash-bx-menus[^"]*"[^>]*>\s*<li[^>]*>\s*<a[^>]*>([^<]*)</.exec(card)?.[1] ?? '');
    const date = /red-date\.png[^>]*>([^<]*)</.exec(card)?.[1];
    const time = /red-clock\.png[^>]*>([^<]*)</.exec(card)?.[1];
    if (!status) throw new NacError('a booking with no status, so NAC’s page may have changed');
    if (!date?.trim() || !time?.trim()) throw new NacError('a booking with no date or time, so NAC’s page may have changed');
    const [start, end] = parseNacRange(clean(time));
    const profile = new RegExp(`/busker/profile/(${GUID.source})`, 'i').exec(card)?.[1].toLowerCase() ?? '';
    return {
      status,
      mine: !!mineId && profile === mineId,
      date: parseNacDate(clean(date), today),
      start,
      end,
      id: /data-bookingid="([^"]*)"/.exec(card)?.[1].trim().toLowerCase() ?? '',
    };
  });
}

const titleOf = (html: string) => clean(/<title[^>]*>([^<]{1,120})/i.exec(html)?.[1] ?? '').slice(0, 80);

/** A location's page: its name and open hours from the header, then the first cards. */
export function parsePage(html: string, today: string, mineId: string): NacPage {
  const first = html.search(CARD);
  const head = first < 0 ? html : html.slice(0, first);
  const name = /id="div-header"[\s\S]*?<h2[^>]*>([^<]*)<\/h2>/i.exec(head)?.[1];
  const hours = /red-clock\.png[^>]*>\s*(\d{1,2}:\d{2}:\s*[ap]m\s*-\s*\d{1,2}:\d{2}:\s*[ap]m)\s*</i.exec(head)?.[1];
  if (!name?.trim() || !hours) {
    const title = titleOf(html);
    throw new NacError(`NAC sent something other than its usual location page${title ? ` (“${title}”)` : ''}, so it may be blocking Launchpad, or the page has changed`);
  }
  const [open, close] = parseNacRange(hours);
  const size = /id="take"[^>]*value="(\d+)"/i.exec(html)?.[1] ?? /value="(\d+)"[^>]*id="take"/i.exec(html)?.[1];
  return { name: clean(name), open, close, pageSize: size ? Number(size) : null, cards: parseCards(html.slice(Math.max(first, 0)), today, mineId) };
}

/**
 * A load-more answer is a JSON string of HTML cards (sync.py's fetch()). A bot check comes back
 * as an HTML page instead. Nothing of the answer itself goes into the message: it could hold names.
 */
export function fetchFragment(body: string): string {
  let v: unknown;
  try {
    v = JSON.parse(body);
  } catch {
    const title = /^\s*</.test(body) ? titleOf(body) : '';
    throw new NacError(`NAC didn’t return JSON${title ? ` but a page (“${title}”)` : ''}, so it may be blocking Launchpad`);
  }
  if (typeof v !== 'string') throw new NacError('NAC returned JSON that isn’t its usual list of bookings, so it may be blocking Launchpad, or it has changed');
  // The photos are no use here, and stripping them first keeps the rest quick to read.
  return v.replace(/src="data:[^"]*"/g, 'src=""');
}

// ---------- asking NAC ----------

/** Gets a page ('page') or a load-more answer ('more') and returns its body, or throws a NacError. */
export type Fetcher = (url: string, kind: 'page' | 'more') => Promise<string>;

export const pageUrl = (p: NacPlace) => `${BASE_URL}/locations/${p.id}/events`;
export const moreUrl = (p: NacPlace, skip: number, take: number) => `${BASE_URL}/locations/${p.id}/events/more?skip=${skip}&take=${take}`;

/** The live site: anything but a straight 200 stops the check (a redirect too: it'd be a challenge or an error page). */
export const liveFetch: Fetcher = async (url, kind) => {
  const headers: Record<string, string> =
    kind === 'page' ? { 'User-Agent': USER_AGENT, Accept: 'text/html' } : { 'User-Agent': USER_AGENT, Accept: 'application/json, text/html', 'X-Requested-With': 'XMLHttpRequest' };
  let res: Response;
  try {
    res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(kind === 'page' ? 30_000 : 180_000) });
  } catch (e) {
    throw new NacError(`couldn’t reach NAC (${reason(e)})`);
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => {});
    throw new NacError(`NAC answered ${res.status}${res.status >= 300 && res.status < 400 ? ' (a redirect)' : ''}, so it may be blocking Launchpad, or it’s down`);
  }
  if (Number(res.headers.get('content-length')) > MAX_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new NacError('NAC sent far more than usual');
  }
  try {
    return await res.text();
  } catch (e) {
    throw new NacError(`NAC stopped answering partway (${reason(e)})`);
  }
};

function reason(e: unknown): string {
  const err = e as Error & { cause?: { code?: string } };
  if (err?.name === 'TimeoutError') return 'it took too long';
  return err?.cause?.code || err?.message || String(e);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What one location's page and load-more list held. */
export interface NacRead {
  place: NacPlace;
  page: NacPage;
  cards: NacCard[];
}

const cardKey = (c: NacCard) => c.id || `${c.status}|${c.date}|${c.start}|${c.end}`;

/** A location's page, then its load-more list until a call returns fewer than `TAKE` (sync.py's fetch_cards). */
export async function readPlace(place: NacPlace, fetcher: Fetcher, wait: () => Promise<void>, today: string, mineId: string): Promise<NacRead> {
  const page = parsePage(await fetcher(pageUrl(place), 'page'), today, mineId);
  const cards = [...page.cards];
  const seen = new Set(cards.map(cardKey));
  // A page showing fewer cards than it can hold has shown them all.
  if (page.pageSize === null || page.cards.length >= page.pageSize) {
    let skip = Math.max(0, cards.length - OVERLAP);
    for (let n = 0; ; n++) {
      if (n === MAX_PAGES) throw new NacError(`more than ${MAX_PAGES * TAKE} bookings in the list, more than it reads`);
      await wait();
      const got = parseCards(fetchFragment(await fetcher(moreUrl(place, skip, TAKE), 'more')), today, mineId);
      if (skip > 0 && got.length && !seen.has(cardKey(got[0]))) throw new NacError('the list of bookings changed while it was being read, so it’ll try again');
      for (const c of got) {
        if (seen.has(cardKey(c))) continue;
        seen.add(cardKey(c));
        cards.push(c);
      }
      if (got.length < TAKE) break;
      skip += got.length - OVERLAP;
    }
  }
  return { place, page, cards };
}

/** Every location, one request at a time. The first failure stops the check. */
export async function readAll(places: NacPlace[], fetcher: Fetcher, wait: () => Promise<void>, today: string, mineId: string): Promise<NacRead[]> {
  const out: NacRead[] = [];
  for (const place of places) {
    if (out.length) await wait();
    try {
      out.push(await readPlace(place, fetcher, wait, today, mineId));
    } catch (e) {
      throw new NacError(`${place.short}: ${e instanceof NacError ? e.message : reason(e)}`);
    }
  }
  // Pages that read but hold no cards anywhere is what a change to NAC's markup looks like.
  if (!out.some((r) => r.cards.length)) throw new NacError('no bookings read at any location, so NAC’s pages may have changed');
  return out;
}

// ---------- free, taken, yours ----------

type Kind = 'free' | 'mine' | 'taken';
interface Block {
  start: number;
  end: number;
  kind: Kind;
  status: string;
}

/** Which status to show for a block more than one card covers: one NAC hasn't used before first, so it's seen. */
const rank = (status: string) => (KNOWN.has(status.toLowerCase()) ? ['confirmed', 'published', 'passed'].indexOf(status.toLowerCase()) + 1 : 0);

/** The location's day in 1-hour blocks from opening; the last is shorter if it closes off the hour. */
function blocksOf(open: number, close: number, from: number): { start: number; end: number }[] {
  const out = [];
  for (let s = open; s < close; s += 60) if (Math.min(s + 60, close) > from) out.push({ start: s, end: Math.min(s + 60, close) });
  return out;
}

/** Back-to-back blocks of one kind (and, for booked ones, one status) joined (the same idea as sync.py's build_rows). */
function runsOf(blocks: Block[], kind: Kind): { start: number; end: number; status: string }[] {
  const out: { start: number; end: number; status: string }[] = [];
  for (const b of blocks) {
    if (b.kind !== kind) continue;
    const last = out[out.length - 1];
    if (last && last.end === b.start && (kind === 'free' || last.status === b.status)) last.end = b.end;
    else out.push({ start: b.start, end: b.end, status: b.status });
  }
  return out;
}

/** The free blocks of a location's earlier result, as "date start" keys. */
function freeKeys(loc: NacLocation): Set<string> {
  const keys = new Set<string>();
  for (const d of loc.days) for (const w of d.free) for (let s = toMin(w.start); s < toMin(w.end); s += 60) keys.add(`${d.date} ${s}`);
  return keys;
}

/**
 * One location's days from today to the latest booking date seen (spec §5). Each block is yours
 * when one of your cards covers it, taken when anyone else's does, otherwise free; blocks that
 * have ended today are left out. Free windows that weren't free at the check before are new.
 * `prev` is that location in the last good result; without one nothing is new.
 */
export function buildLocation(read: NacRead, prev: NacLocation | undefined, now: Date, log: (msg: string) => void = () => {}): NacLocation {
  const { place, page, cards } = read;
  const today = sgtYmd(now);
  const nowMin = sgtMinutes(now);
  const horizon = cards.reduce<string | null>((a, c) => (!a || c.date > a ? c.date : a), null);
  const before = prev ? freeKeys(prev) : null;
  const days: NacDay[] = [];
  // Passed means in the past, and blocks that have ended are left out already. One on a block that
  // hasn't ended isn't what Passed is known to mean, so it counts as taken, like an unknown status.
  const oddPassed = new Set<NacCard>();
  for (let date = today; horizon && date <= horizon; date = addDaysYmd(date, 1)) {
    const onDay = cards.filter((c) => c.date === date);
    const blocks: Block[] = blocksOf(page.open, page.close, date === today ? nowMin : -1).map((b) => {
      const over = onDay.filter((c) => c.start < b.end && c.end > b.start);
      for (const c of over) if (c.status.toLowerCase() === 'passed') oddPassed.add(c);
      if (!over.length) return { ...b, kind: 'free', status: '' };
      const top = [...over].sort((x, y) => rank(x.status) - rank(y.status))[0];
      const mine = over.filter((c) => c.mine);
      return mine.length ? { ...b, kind: 'mine', status: [...mine].sort((x, y) => rank(x.status) - rank(y.status))[0].status } : { ...b, kind: 'taken', status: top.status };
    });
    if (!blocks.length) continue;
    const span = (r: { start: number; end: number }) => ({ start: hhmm(r.start), end: hhmm(r.end) });
    const free: NacFree[] = runsOf(blocks, 'free').map((r) => {
      let fresh = false;
      for (let s = r.start; before && s < r.end; s += 60) if (!before.has(`${date} ${s}`)) fresh = true;
      return { ...span(r), new: fresh };
    });
    const booked = (kind: Kind): NacBooked[] => runsOf(blocks, kind).map((r) => ({ ...span(r), status: r.status }));
    days.push({ date, free, mine: booked('mine'), taken: booked('taken') });
  }
  for (const c of oddPassed) log(`${place.short} ${c.date} ${hhmm(c.start)}-${hhmm(c.end)}: a Passed booking on a slot that hasn’t ended, counted as taken`);
  return {
    key: place.key,
    name: place.name,
    short: place.short,
    nac_name: page.name,
    url: pageUrl(place),
    open: hhmm(page.open),
    close: hhmm(page.close),
    horizon_end: horizon,
    bookings: cards.length,
    days,
  };
}

/** Statuses NAC used that have no known meaning; logged so we learn what they mean (spec §4). */
export function unknownStatuses(reads: NacRead[]): string[] {
  return [...new Set(reads.flatMap((r) => r.cards.map((c) => c.status)).filter((s) => !KNOWN.has(s.toLowerCase())))].sort();
}

// ---------- the snapshot ----------

export const snapshotFile = () => path.join(config.dataDir, 'nac', config.nac.fixtures ? 'snapshot-fixtures.json' : 'snapshot.json');

export function emptySlots(mineOn: boolean): NacSlots {
  return { checked_at: null, ok: true, error: null, last_good_at: null, next_check: null, failures: 0, unknown_statuses: [], mine_on: mineOn, locations: [] };
}

/** The last result, or null when there's none (or it can't be read). */
export function readSnapshot(file = snapshotFile()): NacSlots | null {
  let s: Partial<NacSlots>;
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || !Array.isArray(s.locations)) return null;
  return { ...emptySlots(false), ...s, unknown_statuses: Array.isArray(s.unknown_statuses) ? s.unknown_statuses : [], failures: Number(s.failures) || 0 };
}

/** Write then rename (sync.py's write_csv), so the page never reads a half-written file. */
export function writeSnapshot(s: NacSlots, file = snapshotFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// ---------- when to check ----------

/** The next :05, :15 … :55 after `now`. Singapore is a whole number of hours off UTC, so its minutes are UTC's. */
export function nextSlot(now: Date): Date {
  const t = now.getTime();
  let at = t - (t % SLOT_MS) + SLOT_MINUTES * 60_000;
  if (at <= t) at += SLOT_MS;
  return new Date(at);
}

/** The next check after `failures` failed ones in a row: the next slot, or a few slots later. */
export function nextCheck(now: Date, failures: number): Date {
  const skip = failures > 0 ? BACKOFF[Math.min(failures, BACKOFF.length) - 1] : 0;
  return new Date(nextSlot(now).getTime() + skip * SLOT_MS);
}

export interface CheckOptions {
  places?: NacPlace[];
  fetcher?: Fetcher;
  wait?: () => Promise<void>;
  mineId?: string;
  file?: string;
  /** The clock; called at the start (for what's ended) and at the end (for the next check). */
  now?: () => Date;
  log?: (msg: string) => void;
}

/**
 * One check (sync.py's run(sync_nac)): read every location, work out the slots and keep them.
 * A failure keeps the last good locations, records why, and pushes the next check back.
 */
export async function runCheck(opts: CheckOptions = {}): Promise<NacSlots> {
  const places = opts.places ?? nacPlaces();
  const mineId = opts.mineId ?? config.nac.buskerId;
  const file = opts.file ?? snapshotFile();
  const clock = opts.now ?? (() => new Date());
  const log = opts.log ?? ((m: string) => console.warn(`[nac] ${m}`));
  const fetcher = opts.fetcher ?? (config.nac.fixtures ? fixtureFetcher(config.nac.fixtures, [...places, ...config.nac.locations], clock()) : liveFetch);
  // Saved pages need no pause between them.
  const wait = opts.wait ?? (() => sleep(config.nac.fixtures ? 0 : GAP_MS));
  const prev = readSnapshot(file);
  const started = clock();
  let next: NacSlots;
  try {
    const reads = await readAll(places, fetcher, wait, sgtYmd(started), mineId);
    const unknown = unknownStatuses(reads);
    for (const s of unknown) log(`NAC used the status “${s}”, which isn’t one we know; those bookings count as taken`);
    const at = sgtIso(started);
    next = {
      checked_at: at,
      ok: true,
      error: null,
      last_good_at: at,
      next_check: sgtIso(nextCheck(clock(), 0)),
      failures: 0,
      unknown_statuses: unknown,
      mine_on: !!mineId,
      // The first check, or a location new to the list, has nothing to compare with, so nothing is new.
      locations: reads.map((r) => buildLocation(r, prev?.last_good_at ? prev.locations.find((l) => l.key === r.place.key && l.url === pageUrl(r.place)) : undefined, started, log)),
    };
  } catch (e) {
    const failures = (prev?.failures ?? 0) + 1;
    const error = e instanceof NacError ? e.message : `something went wrong (${reason(e)})`;
    next = { ...(prev ?? emptySlots(!!mineId)), checked_at: sgtIso(started), ok: false, error, failures, next_check: sgtIso(nextCheck(clock(), failures)) };
    log(`check failed (${failures} in a row): ${error}; next check ${next.next_check}`);
  }
  writeSnapshot(next, file);
  return next;
}

// ---------- schedule ----------

let planned: number | null = null;
let running: Promise<unknown> | null = null;
/** Checks and lookups take turns, so NAC is only ever asked one thing at a time. */
let turn: Promise<unknown> = Promise.resolve();
/** When NAC was last asked something, for the gap before a lookup. */
let lastAsked = 0;

function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const mine = turn.then(fn, fn);
  turn = mine.catch(() => {}).finally(() => (lastAsked = Date.now()));
  return mine;
}

/** Checks every 10 minutes from now on, or later while backing off after failures. With NAC_FIXTURES it checks once straight away too. */
export function startNac(): void {
  if (config.nac.buskerIdInvalid) console.warn('[nac] NAC_BUSKER_ID has no profile ID in it, so your own bookings will show as taken');
  if (config.nac.fixtures) console.log(`[nac] reading saved pages from ${config.nac.fixtures}, not NAC`);
  const plan = () => {
    const due = Date.parse(readSnapshot()?.next_check ?? '');
    const now = Date.now();
    // A next check in the past was missed while the server was down; one further off than the longest wait isn't one this set.
    planned = due > now && due - now <= (BACKOFF[BACKOFF.length - 1] + 1) * SLOT_MS ? due : nextSlot(new Date(now)).getTime();
    setTimeout(tick, planned - now);
  };
  const tick = () => {
    // With no locations on the list there's nothing to ask, but the clock keeps going for when one's added.
    running ??= (nacPlaces().length ? inTurn(() => runCheck()) : Promise.resolve())
      .catch((e) => console.error('[nac] check failed:', (e as Error).message))
      .finally(() => (running = null));
    running.then(plan);
  };
  if (config.nac.fixtures) tick();
  else plan();
}

/**
 * GET /api/nac. Only the locations on the list now, in its order and under their names now, so
 * a change to the list shows straight away; one added since the last check isn't in it yet.
 */
export function nacStatus(now = new Date()): NacStatus {
  const s = readSnapshot() ?? emptySlots(!!config.nac.buskerId);
  const places = nacPlaces();
  const due = Date.parse(s.next_check ?? '');
  const next = !places.length ? null : due > now.getTime() ? s.next_check : sgtIso(new Date(planned && planned > now.getTime() ? planned : nextSlot(now).getTime()));
  const locations = places.flatMap((p) => {
    const l = s.locations.find((x) => x.key === p.key && x.url === pageUrl(p));
    return l ? [{ ...l, name: p.name, short: p.short }] : [];
  });
  return {
    ...s,
    locations,
    next_check: next,
    watching: places.map((p) => ({ key: p.key, name: p.name, short: p.short, nac: p.nac, url: pageUrl(p) })),
    max_places: NAC_MAX_PLACES,
    fixtures: !!config.nac.fixtures,
  };
}

// ---------- the list of locations ----------

/** The locations it checks, in order: the list as last changed in the app, or config's to start with. */
export function nacPlaces(): NacPlace[] {
  return store.nacPlaces() ?? config.nac.locations;
}

/** Ids whose page was read lately, with NAC's name for them; only these can be added. */
const looked = new Map<string, { nac: string; at: number }>();
const LOOKED_FOR = 30 * 60_000;

/**
 * POST /api/nac/lookup: reads a location's page once, so it's only added when it's a real one
 * (a wrong id would fail every check after it), and says what NAC calls it and its hours.
 */
export async function lookupPlace(link: string, opts: { fetcher?: Fetcher; now?: Date } = {}): Promise<NacLookup> {
  const id = nacPlaceId(link);
  if (!id) throw new NacError('That isn’t a NAC location link. Open the location on the NAC portal and copy the address: it has /locations/ and a long id in it.');
  const places = nacPlaces();
  const now = opts.now ?? new Date();
  const fetcher = opts.fetcher ?? (config.nac.fixtures ? fixtureFetcher(config.nac.fixtures, [...places, ...config.nac.locations], now) : liveFetch);
  const place = { key: '', id, nac: '', name: '', short: '' };
  const page = await inTurn(async () => {
    if (!opts.fetcher && !config.nac.fixtures) await sleep(Math.max(0, lastAsked + GAP_MS - Date.now()));
    return parsePage(await fetcher(pageUrl(place), 'page'), sgtYmd(now), '');
  }).catch((e) => {
    throw new NacError(`Couldn’t read that location: ${e instanceof NacError ? e.message : reason(e)}`);
  });
  for (const [k, v] of looked) if (now.getTime() - v.at > LOOKED_FOR) looked.delete(k);
  looked.set(id, { nac: page.name, at: now.getTime() });
  return { id, nac: page.name, url: pageUrl(place), open: hhmm(page.open), close: hhmm(page.close), ...guessNacNames(page.name), watched: places.find((p) => p.id === id)?.name ?? null };
}

const nameOf = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max).trim() : '');

/** POST /api/nac/places: adds a location that was just looked up, at the end of the list. */
export function addPlace(body: { id?: unknown; name?: unknown; short?: unknown }, now = new Date()): NacPlace {
  const places = nacPlaces();
  const id = nacPlaceId(String(body?.id ?? ''));
  const seen = looked.get(id);
  if (places.length >= NAC_MAX_PLACES) throw new NacError(`That’s ${NAC_MAX_PLACES} locations already, the most it checks. Remove one first.`);
  const dup = places.find((p) => p.id === id);
  if (dup) throw new NacError(`That’s already on the list as ${dup.name}.`);
  if (!id || !seen || now.getTime() - seen.at > LOOKED_FOR) throw new NacError('Look the location up again first, so it’s known to be a real one.');
  const name = nameOf(body?.name, NAC_NAME_MAX);
  const short = nameOf(body?.short, NAC_SHORT_MAX) || name.slice(0, NAC_SHORT_MAX).trim();
  if (!name) throw new NacError('Give it a name.');
  const place = { key: nacPlaceKey(short, places.map((p) => p.key)), id, nac: seen.nac, name, short };
  store.setNacPlaces([...places, place]);
  return place;
}

/**
 * PUT /api/nac/places: the list's new order and names. Locations left out are removed; ones
 * not on the list are ignored (adding goes through a lookup). A blank name or short name keeps the old one.
 */
export function editPlaces(list: unknown): NacPlace[] {
  if (!Array.isArray(list)) throw new NacError('That isn’t a list of locations.');
  const places = nacPlaces();
  const out: NacPlace[] = [];
  for (const e of list as { key?: unknown; name?: unknown; short?: unknown }[]) {
    const p = places.find((x) => x.key === e?.key);
    if (!p || out.some((x) => x.key === p.key)) continue;
    out.push({ ...p, name: nameOf(e.name, NAC_NAME_MAX) || p.name, short: nameOf(e.short, NAC_SHORT_MAX) || p.short });
  }
  store.setNacPlaces(out);
  return out;
}

// ---------- saved pages instead of NAC (development) ----------

const DATE_TEXT = new RegExp(`\\b(${DOW3.join('|')}), (\\d{1,2}) (${MONTH_NAMES.join('|')})\\b`, 'g');

/**
 * NAC_FIXTURES: pages saved in a folder stand in for NAC, so the app runs without asking it
 * anything. <key>.html is a location's page and <key>-more.json its load-more answer (or <id>.html
 * and <id>-more.json, for one that isn't in `places`); a file
 * a folder doesn't have is read from the folder above (a later round only holds what changed),
 * and one neither has answers 404. Dates move so the folder's day (meta.json "today") is today.
 */
export function fixtureFetcher(dir: string, places: NacPlace[], now: Date): Fetcher {
  const find = (name: string) => [path.join(dir, name), path.join(dir, '..', name)].find((f) => fs.existsSync(f));
  const meta = find('meta.json');
  const base = meta ? (JSON.parse(fs.readFileSync(meta, 'utf8')) as { today?: string }).today : undefined;
  const shift = base ? daysBetween(base, sgtYmd(now)) : 0;
  const move = (text: string) =>
    !base || !shift
      ? text
      : text.replace(DATE_TEXT, (m) => {
          const d = addDaysYmd(parseNacDate(m, base), shift);
          return `${DOW3[weekdayOf(d)]}, ${Number(d.slice(8, 10))} ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]}`;
        });
  return async (url, kind) => {
    // By any key that location has on the list or in config, or by its id.
    const id = /\/locations\/([0-9a-f-]{36})\//i.exec(url)?.[1].toLowerCase() ?? '';
    const names = [...places.filter((p) => p.id === id).map((p) => p.key), id].filter(Boolean);
    const file = names.map((n) => find(`${n}${kind === 'page' ? '.html' : '-more.json'}`)).find(Boolean);
    if (!file) throw new NacError('NAC answered 404, so it may be blocking Launchpad, or it’s down');
    return move(fs.readFileSync(file, 'utf8'));
  };
}
