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
