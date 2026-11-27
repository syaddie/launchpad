// The Mission layout's maths, with no page in it (tested in test/mission.test.ts). The scene that draws with it is
// components/mission/Scene.tsx; the look is mission.css; docs/mission-layout.md says what the layout is.


export type Pt = { x: number; y: number };
export type Curve = [Pt, Pt, Pt, Pt];

/** The day the ascent covers: on the pad at 06:00, in orbit at midnight. */
export const DAY_START = 6;
export const DAY_END = 24;
/** When the sun is up. Singapore's sunrise and sunset stay within twenty minutes of these all year. */
export const SUNRISE = 7;
export const SUNSET = 19;

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

/**
 * Where the sun (by day) or the moon (by night) is: `f` from rising (0) to setting (1), `lift` its height (0 at the
 * horizon, 1 at its highest), and `glow` how much it lights the horizon (1 as it rises and sets, 0 when it's high).
 * When the theme and the clock disagree (Night at noon), it sits low and late rather than under the horizon.
 */
export function orbPlace(hour: number, dark: boolean): { f: number; lift: number; glow: number } {
  let f = dark ? ((hour - SUNSET + 24) % 24) / (24 - SUNSET + SUNRISE) : (hour - SUNRISE) / (SUNSET - SUNRISE);
  if (!(f >= 0 && f <= 1)) f = 0.86;
  const lift = Math.sin(Math.PI * f);
  return { f, lift, glow: Math.max(0, Math.min(1, 1 - lift * 1.5)) };
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
