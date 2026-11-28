// The Mission layout's maths, with no page in it (tested in test/mission.test.ts). The scene that draws with it is
// components/mission/Scene.tsx; the look is mission.css; docs/mission-layout.md says what the layout is.


export type Pt = { x: number; y: number };
export type Curve = [Pt, Pt, Pt, Pt];

/** The day the ascent covers: on the pad at 06:00, in orbit at midnight. */
export const DAY_START = 6;
export const DAY_END = 24;

/** A time of day as hours, e.g. 14.08 for 14:05. */
export function hoursOf(d: Date): number {
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}

/** How far along the ascent an hour of the day is, 0 to 1. Before 06:00 is still on the pad. */
export function dayFraction(hour: number): number {
  return Math.max(0, Math.min(1, (hour - DAY_START) / (DAY_END - DAY_START)));
}

function cubic(P: Curve, t: number): Pt {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * P[0].x + b * P[1].x + c * P[2].x + d * P[3].x, y: a * P[0].y + b * P[1].y + c * P[2].y + d * P[3].y };
}

export type PathTable = { pts: Pt[]; len: number[]; total: number };

/** A curve as points with the distance along it to each, so a place can be found by distance, not by `t`. */
export function pathTable(P: Curve, steps = 240): PathTable {
  const pts = [cubic(P, 0)];
  const len = [0];
  for (let i = 1; i <= steps; i++) {
    const p = cubic(P, i / steps);
    const q = pts[i - 1];
    pts.push(p);
    len.push(len[i - 1] + Math.hypot(p.x - q.x, p.y - q.y));
  }
  return { pts, len, total: len[steps] };
}

/** The point a fraction `f` of the way along by distance, the path's direction there (radians), and the index it falls before. */
export function along(T: PathTable, f: number): Pt & { a: number; i: number } {
  const want = Math.max(0, Math.min(1, f)) * T.total;
  let i = 1;
  while (i < T.len.length - 1 && T.len[i] < want) i++;
  const a = T.pts[i - 1];
  const b = T.pts[i];
  const span = T.len[i] - T.len[i - 1] || 1;
  const k = (want - T.len[i - 1]) / span;
  return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, a: Math.atan2(b.y - a.y, b.x - a.x), i };
}

/**
 * The ascent's curve in a sky `w` wide: straight up off the pad at (`padX`, `fromY`), then over, flattening toward
 * orbit at height `top`. A narrow sky bends sooner.
 */
export function ascentCurve(w: number, padX: number, fromY: number, top: number, compact: boolean): Curve {
  return [
    { x: padX, y: fromY },
    { x: padX + 6, y: fromY - (fromY - top) * (compact ? 0.92 : 0.74) },
    { x: Math.max(padX + 60, w * (compact ? 0.24 : 0.27)), y: top + (compact ? 6 : 12) },
    { x: w - (compact ? 18 : 44), y: top },
  ];
}

// ---------- the sun and the moon, at their real times ----------
// The usual low-precision formulas (Astronomy Answers' and Meeus's): a minute or two off for the sun and a few
// minutes for the moon, which is plenty for a sky. Nothing is asked of the network.

/** Where the sky is drawn for: Singapore, in degrees north and east. */
export const SKY_AT = { lat: 1.3521, lon: 103.8198 };

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
/** Days since noon UTC on 1 January 2000 (J2000). */
const daysOf = (ms: number) => ms / DAY_MS - 10957.5;
const msOf = (days: number) => (days + 10957.5) * DAY_MS;
/** The tilt of the Earth's axis. */
const OBLIQUITY = 23.4397 * RAD;

const rightAscension = (l: number, b: number) => Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l: number, b: number) => Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
/** Local sidereal time, radians, `lon` east in radians. */
const sidereal = (d: number, lon: number) => RAD * (280.16 + 360.9856235 * d) + lon;
const altitudeOf = (H: number, lat: number, dec: number) => Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));

const sunAnomaly = (d: number) => RAD * (357.5291 + 0.98560028 * d);
function sunLongitude(M: number) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}
function sunCoords(d: number) {
  const L = sunLongitude(sunAnomaly(d));
  return { ra: rightAscension(L, 0), dec: declination(L, 0) };
}

/**
 * Sunrise and sunset on the day `day` falls on (in the page's own time zone), for a place, with the sun's edge on a
 * horizon lowered by refraction, as almanacs give them.
 */
export function sunTimes(day: Date, at = SKY_AT): { rise: Date; set: Date } {
  const noon = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 12).getTime();
  const lw = -at.lon * RAD;
  const lat = at.lat * RAD;
  // (The usual 0.0009 days for Terrestrial Time is left out: it's for clocks running on TT, and ours run on UTC. With
  // it, every time comes out a minute and a bit late against the almanacs.)
  const n = Math.round(daysOf(noon) - lw / (2 * Math.PI));
  const transitNear = (ht: number) => (ht + lw) / (2 * Math.PI) + n;
  const ds = transitNear(0);
  const M = sunAnomaly(ds);
  const L = sunLongitude(M);
  const dec = declination(L, 0);
  const transit = (d: number) => d + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const noonDay = transit(ds);
  const w = Math.acos((Math.sin(-0.833 * RAD) - Math.sin(lat) * Math.sin(dec)) / (Math.cos(lat) * Math.cos(dec)));
  const set = transit(transitNear(w));
  return { rise: new Date(msOf(noonDay - (set - noonDay))), set: new Date(msOf(set)) };
}

function moonCoords(d: number) {
  // Mean longitude, the moon's and the sun's mean anomalies, the elongation, the distance from the node; then the
  // biggest periodic terms (the equation of the centre, evection, variation, the annual equation).
  const L = 218.316 + 13.176396 * d;
  const Mm = RAD * (134.963 + 13.064993 * d);
  const Ms = RAD * (357.529 + 0.98560028 * d);
  const D = RAD * (297.85 + 12.190749 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = RAD * (L + 6.289 * Math.sin(Mm) + 1.274 * Math.sin(2 * D - Mm) + 0.658 * Math.sin(2 * D) + 0.214 * Math.sin(2 * Mm) - 0.186 * Math.sin(Ms) - 0.114 * Math.sin(2 * F));
  const b = RAD * (5.128 * Math.sin(F) + 0.281 * Math.sin(Mm + F) + 0.278 * Math.sin(Mm - F) + 0.173 * Math.sin(2 * D - F));
  const dist = 385001 - 20905 * Math.cos(Mm) - 3699 * Math.cos(2 * D - Mm) - 2956 * Math.cos(2 * D);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist };
}

/** How high the moon's centre is, in degrees, seen from the Earth's centre (moonTimes allows for its parallax). */
function moonAltitude(ms: number, at: { lat: number; lon: number }): number {
  const d = daysOf(ms);
  const m = moonCoords(d);
  return altitudeOf(sidereal(d, at.lon * RAD) - m.ra, at.lat * RAD, m.dec) / RAD;
}

/** The moon at a moment: `lit` is how much of it is lit (0 new, 1 full), and `waxing` whether that's growing. */
export function moonPhase(t: Date): { lit: number; waxing: boolean } {
  const d = daysOf(t.getTime());
  const s = sunCoords(d);
  const m = moonCoords(d);
  const sunDist = 149598000;
  const elong = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(sunDist * Math.sin(elong), m.dist - sunDist * Math.cos(elong));
  // Where the sun is from the moon's middle (from north, through east): to the west while it's waxing.
  const limb = Math.atan2(Math.cos(s.dec) * Math.sin(s.ra - m.ra), Math.sin(s.dec) * Math.cos(m.dec) - Math.cos(s.dec) * Math.sin(m.dec) * Math.cos(s.ra - m.ra));
  return { lit: (1 + Math.cos(inc)) / 2, waxing: limb < 0 };
}

/**
 * Where something on the sky's arc is drawn in a sky `w` wide with its horizon at `hz` (both px): `f` from rising (0,
 * on the left) to setting (1, on the right), `lift` how high (sin πf: 0 on the horizon, 1 at the top).
 */
export function skyPoint(f: number, w: number, hz: number): Pt {
  return { x: w * (0.16 + 0.7 * f), y: hz - 10 - Math.sin(Math.PI * f) * hz * 0.66 };
}

/**
 * Which way the moon's lit side faces: toward the sun in the scene's own sky, in degrees clockwise from facing right.
 * The scene's sky runs from rising on the left to setting on the right, so this follows it rather than the real sky's
 * compass, which turns round when the moon passes north of overhead (often, this near the equator). By day the sun is
 * on the arc; by night it's on the same arc turned under the horizon, from where it set on the right (`f` 0) to where it
 * will rise on the left (1), lowest at midnight: in the evening a waxing moon is lit on the right, before dawn a waning
 * one on the left, and at midnight a full one from below. Worked out across the sky's 180° by its 90°, not the screen's
 * pixels, which are far wider than they're tall and would flatten every direction toward the horizon.
 */
export function moonTurn(moonF: number, sun: { f: number; below: boolean }): number {
  const moon = { x: moonF * 180, y: Math.sin(Math.PI * moonF) * 90 };
  const there = sun.below ? { x: (1 - sun.f) * 180, y: -Math.sin(Math.PI * sun.f) * 90 } : { x: sun.f * 180, y: Math.sin(Math.PI * sun.f) * 90 };
  // Up the sky is up the screen, which counts down.
  const deg = (Math.atan2(moon.y - there.y, there.x - moon.x) * 180) / Math.PI;
  return Math.round(((deg % 360) + 360) % 360);
}

/** The moon's centre at rising and setting, seen from the Earth's centre: its parallax less refraction and its radius. */
const MOON_H0 = 0.125;
const MOON_STEP = 10 * 60_000;

/**
 * Whether the moon is up at `t`, and if it is, when it rose and when it will set (found by following its height in
 * ten-minute steps, each crossing worked out between them). If it isn't, `rise` is when it next comes up.
 */
export function moonTimes(t: Date, at = SKY_AT): { up: boolean; rise: Date | null; set: Date | null } {
  const now = t.getTime();
  const h = (ms: number) => moonAltitude(ms, at) - MOON_H0;
  const cross = (a: number, ha: number, hb: number) => new Date(a + (MOON_STEP * ha) / (ha - hb));
  const up = h(now) > 0;
  let rise: Date | null = null;
  let set: Date | null = null;
  if (up) {
    // Back to when it came up, and on to when it goes down: within a day and a bit either way.
    for (let a = now, ha = h(a); a > now - 30 * 3_600_000; a -= MOON_STEP) {
      const b = a - MOON_STEP;
      const hb = h(b);
      if (hb <= 0) {
        rise = cross(b, hb, ha);
        break;
      }
      ha = hb;
    }
  }
  for (let a = now, ha = h(a); a < now + 30 * 3_600_000; a += MOON_STEP) {
    const b = a + MOON_STEP;
    const hb = h(b);
    if (up && hb <= 0) {
      set = cross(a, ha, hb);
      break;
    }
    if (!up && hb > 0) {
      rise = cross(a, ha, hb);
      break;
    }
    ha = hb;
  }
  return { up, rise, set };
}

/**
 * The sun or the moon in the sky: see orbPlace. `sun` is where the sun is (sunPoint), so the moon's lit side can face it.
 */
export type Orb = { f: number; lift: number; glow: number; up: boolean; moon: { lit: number; waxing: boolean } | null; sun: { f: number; below: boolean } };

/** Where it sits when the theme and the clock disagree (Night at noon, Day at midnight): low and late, not under the horizon. */
const LOW_AND_LATE = 0.86;

/**
 * Where the sun (by day) or the moon (by night) is, at their real times for the sky's place: `f` from rising (0) to
 * setting (1), `lift` its height (0 at the horizon, 1 at its highest), and `glow` how much it lights the horizon (1 as
 * it rises and sets, 0 when it's high; less for a thin moon). By night the moon is drawn at its real phase (`moon`), and
 * when it's down (`up` false: near new moon it's up by day instead) there's none. When the theme and the clock
 * disagree, it sits low and late rather than under the horizon.
 */
export function orbPlace(now: Date, dark: boolean, at = SKY_AT): Orb {
  const t = now.getTime();
  const today = sunTimes(now, at);
  const rise = today.rise.getTime();
  const set = today.set.getTime();
  const day = t >= rise && t <= set;
  // By night, how far from the last sunset to the next sunrise (yesterday's or tomorrow's, either side of midnight).
  const other = sunTimes(new Date(t + (t > set ? 1 : -1) * DAY_MS), at);
  const sun = day ? { f: (t - rise) / (set - rise), below: false } : t > set ? { f: (t - set) / (other.rise.getTime() - set), below: true } : { f: (t - other.set.getTime()) / (rise - other.set.getTime()), below: true };
  const place = (f: number, glow = 1) => {
    const lift = Math.sin(Math.PI * f);
    return { f, lift, glow: Math.max(0, Math.min(1, 1 - lift * 1.5)) * glow };
  };
  if (!dark) return { ...place(day ? sun.f : LOW_AND_LATE), up: true, moon: null, sun };
  const p = moonPhase(now);
  const moon = { lit: Math.round(p.lit * 1000) / 1000, waxing: p.waxing };
  const dim = 0.25 + 0.75 * p.lit;
  if (day) return { ...place(LOW_AND_LATE, dim), up: true, moon, sun };
  const m = moonTimes(now, at);
  if (!m.up) return { f: 0, lift: 0, glow: 0, up: false, moon, sun };
  // Up longer than the search reaches either way (not at this latitude): high in the middle.
  const f = m.rise && m.set ? (t - m.rise.getTime()) / (m.set.getTime() - m.rise.getTime()) : 0.5;
  return { ...place(Math.max(0, Math.min(1, f)), dim), up: true, moon, sun };
}

/**
 * The moon's lit part as an SVG path in a circle of radius 1 at the origin, lit on the right (turn it to face the sun):
 * the lit limb's half circle, then back along the terminator, a half ellipse as wide as |2·lit − 1|, bulging toward the
 * lit side while it's a crescent and away from it once it's gibbous.
 */
export function moonPath(lit: number): string {
  const k = Math.max(0, Math.min(1, lit));
  const rx = Math.round(Math.abs(2 * k - 1) * 1000) / 1000;
  return `M0 -1 A1 1 0 0 1 0 1 A${rx} 1 0 0 ${k < 0.5 ? 0 : 1} 0 -1Z`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** A length of time as the launch clock writes it: 00:54:38. */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${two(Math.floor(s / 3600))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

export type Countdown =
  | { state: 'next'; text: string; soon: boolean }
  | { state: 'now'; text: string; soon: false }
  | { state: 'idle'; text: string; soon: false };

/** Inside this long, the clock turns to the colour of now. */
export const SOON_MS = 10 * 60_000;

/**
 * What the launch clock shows: T- to the next event's start, T+ since the current one's, or the time of day when
 * nothing is left. The current event wins, as the summary line's does.
 */
export function countdown(now: Date, cur: { s: Date } | undefined, next: { s: Date } | undefined): Countdown {
  if (cur) return { state: 'now', text: `T+${clockText(now.getTime() - cur.s.getTime())}`, soon: false };
  if (next) {
    const left = next.s.getTime() - now.getTime();
    return { state: 'next', text: `T-${clockText(left)}`, soon: left <= SOON_MS };
  }
  return { state: 'idle', text: `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`, soon: false };
}

export type SkyWeather = 'clear' | 'cloud' | 'rain';

/** The sky a forecast calls for (data.gov.sg's words: "Partly Cloudy (Day)", "Thundery Showers", "Fair & Warm"…). */
export function skyWeather(forecast: string | null | undefined): SkyWeather {
  const f = (forecast ?? '').toLowerCase();
  if (/rain|shower|thunder|drizzle/.test(f)) return 'rain';
  if (/cloud|overcast|haz|mist|fog/.test(f)) return 'cloud';
  return 'clear';
}

/** The same numbers every time for a seed, so the stars are where they were. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Keeps a point clear of boxes of words: caught inside one (with `gap` round it), it slips just above or below. */
export function clearOf(p: Pt, boxes: { left: number; top: number; right: number; bottom: number }[], floor: number, ceiling: number, gap = 26): Pt {
  let y = p.y;
  for (const b of boxes) {
    const top = b.top - gap;
    const bottom = b.bottom + gap;
    if (p.x > b.left - gap && p.x < b.right + gap && y > top && y < bottom) {
      const below = bottom <= floor;
      y = below && (bottom - y < y - top || top < ceiling) ? bottom : Math.max(ceiling, top);
    }
  }
  return { x: p.x, y };
}

/** A light on the apron: where it is, how big (it shrinks with distance), its row from the nearest (0), and whether it
 * flashes in the sequence that runs toward the horizon (the runway's) or burns steady (the taxiways'). */
export type ApronLamp = { x: number; y: number; r: number; row: number; seq: boolean };

/** The runway's lines (its edges and centre) and the taxiways' further out, as how far each is from the middle at
 * the foot of the ground, in heights of the ground: at that slope the runway stays in the open ground between the
 * panels, and the taxiways pass under them and come in from the sides. */
export const APRON_RUNWAY = [-0.4, 0, 0.4];
export const APRON_TAXI = [-1.05, 1.05, -1.9, 1.9];
/** How many rows the sequence runs through before it starts again. */
export const APRON_ROWS = 20;

/**
 * The launch site's apron, for Home's ground when there are no photos: rows of lights in perspective, each line running
 * from the foot of a `w`×`h` box to the horizon at the middle of its top edge. Rows are evenly spaced on the ground, so
 * on the screen they crowd together toward the horizon and the lights get smaller. Also the painted lines (`paint`,
 * an SVG path): each line of lights, the runway's centre dashed between its lights, and a joint across every third row.
 */
export function apron(w: number, h: number): { lamps: ApronLamp[]; paint: string; dashes: string } {
  if (w < 40 || h < 40) return { lamps: [], paint: '', dashes: '' };
  const mid = w / 2;
  // Distance on the ground, the nearest row 1 (just inside the foot of the box).
  const z = (row: number) => 1.04 + row * 0.42;
  const yOf = (d: number) => h / d;
  const near = Math.min(3.6, Math.max(1.8, h * 0.0062));
  const lamps: ApronLamp[] = [];
  const r2 = (n: number) => Math.round(n * 10) / 10;
  for (let row = 0; row < APRON_ROWS; row++) {
    const d = z(row);
    const y = yOf(d);
    // Lost in the haze at the horizon.
    if (y < 22) break;
    const r = Math.max(0.7, near / d);
    for (const [seq, list] of [[true, APRON_RUNWAY], [false, APRON_TAXI]] as const) {
      for (const s of list) {
        // The taxiways' lights are half as many: every other row.
        if (!seq && row % 2) continue;
        const x = mid + (s * h) / d;
        if (x < -r || x > w + r) continue;
        lamps.push({ x: r2(x), y: r2(y), r: r2(r), row, seq });
      }
    }
  }
  const lines = [...APRON_RUNWAY.filter((s) => s !== 0), ...APRON_TAXI].map((s) => `M${r2(mid)} 0 L${r2(mid + s * h)} ${r2(h)}`);
  const joints: string[] = [];
  for (let row = 1; row < APRON_ROWS; row += 3) {
    const y = yOf(z(row) + 0.21);
    if (y < 22) break;
    joints.push(`M0 ${r2(y)} H${r2(w)}`);
  }
  // The centre line: a dash in the middle of the gap between each light and the next, as long as a third of the gap.
  const dashes: string[] = [];
  for (let row = 0; row < APRON_ROWS - 1; row++) {
    const a = yOf(z(row) + 0.14);
    const b = yOf(z(row) + 0.28);
    if (b < 22) break;
    dashes.push(`M${r2(mid)} ${r2(a)} V${r2(b)}`);
  }
  return { lamps, paint: [...lines, ...joints].join(' '), dashes: dashes.join(' ') };
}

/** Inside this long before an event, the launch clock's last seconds: a soft ring each second, the vehicle brighter. */
export const FINAL_MS = 10_000;

/** Whether the launch clock is in its last ten seconds before `next` starts (the T- face reads 09 down to 00). */
export function finalCount(now: Date, next: { s: Date } | undefined, cur?: unknown): boolean {
  if (cur || !next) return false;
  const left = next.s.getTime() - now.getTime();
  return left > 0 && left < FINAL_MS;
}

/**
 * The events that ended between two ticks of the clock (after `before`, by `now`): each one is a stage the vehicle on
 * the ascent sheds. Only the last of them when several ended at once (the page asleep, or a long gap), so a return
 * doesn't drop a stack of stages; none when the clock went back or stood still.
 */
export function stagesShed<E extends { id: string; end: Date }>(events: E[], before: Date, now: Date): E[] {
  if (now <= before) return [];
  const ended = events.filter((e) => e.end > before && e.end <= now).sort((a, b) => a.end.getTime() - b.end.getTime());
  return ended.slice(-1);
}

/**
 * How long since something, as mission elapsed time for the dot-matrix face: "T+02:13:45", and past a day
 * "T+1:02:13:45" (days, then the clock). Never below zero.
 */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(s / 86_400);
  return `T+${days ? `${days}:` : ''}${clockText((s % 86_400) * 1000)}`;
}

/** Time to go in a small label, by the second: "T-04:12" inside an hour, "T-1:04:12" past one, "T-00:00" once due. */
export function minusText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  return `T-${h ? `${h}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
}

/** A countdown's days left for the dot-matrix face: "T-05", "T-27", "T-124". */
export function daysText(days: number): string {
  return `T-${two(Math.max(0, days))}`;
}
