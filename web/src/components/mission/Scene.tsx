import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { along, ascentCurve, clearOf, dayFraction, hoursOf, moonPath, moonTurn, orbPlace, pathTable, seeded, skyPoint, stagesShed, type PathTable, type SkyWeather } from '../../mission';
import { buzz } from '../../buzz';
import { hm } from '../../util';
import { api } from '../../api';
import { nightWatch, powerDown, powerText, twilight } from '../../mission';
import { Vehicle } from './Mark';

/** An event on the day's ascent: when it starts (its waypoint) and ends (a stage shed). */
export type SkyEvent = { id: string; at: Date; end: Date; name: string };

/** A spent stage falling away from the vehicle on the ascent: where it parted, the vehicle's heading then, its fall. */
type Stage = { key: string; x: number; y: number; deg: number; k: number; fx: number; fy: number; spin: number };
/** How long a spent stage falls and fades (mission.css's msStageFall, three of Mission's 900ms sweeps), and a little
 * more before it's taken away. */
const STAGE_MS = 2800;

/** A recovery (idea 6): this long after a launch, a far point of light comes back down to the horizon and lands... */
const RECOVERY_MS = 3 * 60_000;
/** ...or as soon after as Home is in view, up to this much later; past that it's missed. */
const RECOVERY_KEEP_MS = 15 * 60_000;
/** How long it's on the sky (mission.css's msRecoveryFall, sixteen of Mission's 900ms sweeps), and a little more. */
const RECOVERY_SHOW_MS = 16_000;

/** How often the site reads the server's power while Home is in view (idea 8). */
const POWER_MS = 60_000;
/** How wide a letter of the power's label is (mission.css's .ms-power-text: 10.5px mono, spaced), a little over. */
const POWER_LETTER = 7.2;

/**
 * The server as the site's power (idea 8): the containers that are down, read once a minute while `on` (Home is in
 * view, in Mission, and Server isn't hidden) and the page is. Nothing while Docker can't be reached (not known isn't
 * down), and no more asking once the server says Docker isn't connected at all.
 */
function useSitePower(on: boolean): string[] {
  const [down, setDown] = useState<string[]>([]);
  const none = useRef(false);
  useEffect(() => {
    if (!on || none.current) return;
    let live = true;
    let busy = false;
    let timer = 0;
    const read = () => {
      window.clearTimeout(timer);
      if (busy || document.hidden) return;
      busy = true;
      api
        .server()
        .then((st) => {
          if (!live) return;
          if (!st.containers && !st.containersError) {
            none.current = true;
            setDown([]);
            return;
          }
          const next = powerDown(st.containers);
          setDown((was) => (was.join(',') === next.join(',') ? was : next));
          timer = window.setTimeout(read, POWER_MS);
        })
        .catch(() => {
          if (live) timer = window.setTimeout(read, POWER_MS);
        })
        .finally(() => {
          busy = false;
        });
    };
    read();
    const seen = () => !document.hidden && read();
    document.addEventListener('visibilitychange', seen);
    return () => {
      live = false;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', seen);
    };
  }, [on]);
  return on ? down : [];
}

/** Everything the scene draws from, measured off the page (the strip, the top bar, where the panels start). */
type Geo = {
  w: number;
  h: number;
  /** The horizon, from the top. */
  hz: number;
  padX: number;
  /** The site's scale. */
  k: number;
  /** Whether the pad and its vehicle are shown (Home, with a sky tall enough). */
  site: boolean;
  /** Where the ascent levels off; null when there is no ascent (other views). */
  arcTop: number | null;
  /** Room above the ascent for the events' names. */
  names: boolean;
  orbX: number;
  orbY: number;
  glow: number;
  /** Whether the sun or moon is up: by night the moon may not have risen. */
  orbUp: boolean;
  /** By night, the moon's phase: how much is lit, and which way its lit side faces (toward the sun, mission.ts). */
  moon: { lit: number; turn: number } | null;
};

type Particle = { k: 'ex' | 'smoke' | 'vap'; x: number; y: number; vx: number; vy: number; life: number; age: number; size: number };

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Mission's launch site, behind everything: a sky that follows the hour and the weather, the sun or moon on its arc,
 * stars or clouds, the sea at the horizon, the pad with its tower and masts and a vehicle venting on it, and over the
 * sky the day's ascent, each event a waypoint and now a vehicle climbing it. `launch` is a count: each time it goes up
 * the vehicle on the pad lifts off, and the next rolls out. It is drawn for the eye only (aria-hidden): every event on
 * it is a row in Today too. docs/mission-layout.md; the look is mission.css.
 */
export function MissionScene({ now, dark, narrow, home, events, wx, launch, power = false }: {
  now: Date;
  dark: boolean;
  /** A phone: the scene scrolls with the page instead of standing behind it. */
  narrow: boolean;
  home: boolean;
  events: SkyEvent[];
  wx: SkyWeather;
  launch: number;
  /** Whether the site shows the server's power (Server isn't hidden); not in a preview. */
  power?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const starsRef = useRef<HTMLCanvasElement>(null);
  const fxRef = useRef<HTMLCanvasElement>(null);
  const liftRef = useRef<SVGGElement>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const live = useRef<{ geo: Geo | null; here: { x: number; y: number; a: number } | null }>({ geo: null, here: null });
  const hour = hoursOf(now);
  // Dawn's and dusk's own skies, cross-faded over the theme's by the clock, and the night watch from 23:00 to sunrise.
  const minute = Math.floor(now.getTime() / 60_000);
  const tw = useMemo(() => twilight(now), [minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const watch = useMemo(() => nightWatch(now), [minute]); // eslint-disable-line react-hooks/exhaustive-deps
  const down = useSitePower(home && power);

  // ---------- measuring ----------

  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.parentElement;
    if (!el || !root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      const top = (sel: string) => {
        const n = root.querySelector(sel);
        return n ? n.getBoundingClientRect() : null;
      };
      const main = top('.lp-inner > main');
      const bar = top('.topbar');
      const rail = top('.rail');
      const tools = top('.top-tools');
      const hero = top('.ms-hero');
      if (!main || !bar) return;
      const w = root.clientWidth;
      // On Home the horizon is just above what stands on the ground (the panels; on a phone, the row of tools), so the
      // pad is in full view. Other views have a short sky, and their panels overlap it.
      const hz = Math.round((narrow ? (home && tools ? tools.top - 14 : main.top + 12) : home ? main.top - 14 : main.top + 26) - box.top);
      const h = narrow ? hz + 170 : window.innerHeight;
      const k = narrow ? 0.22 : w >= 2000 ? 0.36 : 0.3;
      const padX = narrow ? 46 : bar.left - box.left + 64;
      const site = home && hz >= 250;
      // The ascent levels off just above the words in the sky, under the strip.
      const words = narrow ? hero : bar;
      const band = narrow ? 58 : rail ? rail.bottom - box.top : 60;
      const arcTop = site && words ? Math.max(band + 14, words.top - box.top - (narrow ? 26 : 38)) : null;
      const names = !narrow && arcTop !== null && arcTop - band >= 46;
      // The sun and moon at their real times for Singapore (mission.ts), the moon at its real phase.
      const orb = orbPlace(now, dark);
      const boxes = [hero, narrow ? top('.clock-row') : top('.top-right'), narrow ? tools : rail, home ? null : top('.top-left')]
        .filter((b): b is DOMRect => !!b)
        .map((b) => ({ left: b.left - box.left, top: b.top - box.top, right: b.right - box.left, bottom: b.bottom - box.top }));
      const at = clearOf(skyPoint(orb.f, w, hz), boxes, hz - 4, narrow ? 20 : 70);
      const moon = orb.moon ? { lit: orb.moon.lit, turn: moonTurn(orb.f, orb.sun) } : null;
      const next: Geo = {
        w,
        h,
        hz,
        padX: Math.round(padX),
        k,
        site,
        arcTop: arcTop === null ? null : Math.round(arcTop),
        names,
        orbX: Math.round(at.x),
        orbY: Math.round(at.y),
        glow: r2(orb.glow),
        orbUp: orb.up,
        moon,
      };
      setGeo((g) => (g && JSON.stringify(g) === JSON.stringify(next) ? g : next));
    };
    measure();
    // The view's own code may arrive a moment later, and typefaces change how tall the words are.
    const frame = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const sel of ['.lp-inner', '.topbar', '.lp-inner > main']) {
      const n = root.querySelector(sel);
      if (n) ro.observe(n);
    }
    let on = true;
    document.fonts?.ready.then(() => on && measure());
    window.addEventListener('resize', measure);
    return () => {
      on = false;
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [narrow, home, dark, hour, events.length]);

  // ---------- the ascent ----------

  const arc = useMemo(() => {
    if (!geo || geo.arcTop === null) return null;
    const fromY = geo.hz - 60 * (geo.k / 0.3) - 6;
    const curve = ascentCurve(geo.w, geo.padX, fromY, geo.arcTop, narrow);
    const T: PathTable = pathTable(curve);
    const fn = dayFraction(hour);
    const here = along(T, fn);
    let flown = '';
    for (let i = 0; i < here.i; i++) flown += `${i ? ' L' : 'M'}${r2(T.pts[i].x)} ${r2(T.pts[i].y)}`;
    flown += ` L${r2(here.x)} ${r2(here.y)}`;
    const ticks = [9, 12, 15, 18, 21].map((h) => {
      const p = along(T, dayFraction(h));
      const nx = Math.cos(p.a + Math.PI / 2) * 4;
      const ny = Math.sin(p.a + Math.PI / 2) * 4;
      return `M${r2(p.x - nx)} ${r2(p.y - ny)} L${r2(p.x + nx)} ${r2(p.y + ny)}`;
    });
    const ways = events.map((e) => {
      const f = dayFraction(hoursOf(e.at));
      const p = along(T, f);
      return { id: e.id, name: e.name, at: hm(e.at), x: r2(p.x), y: r2(p.y), past: f < fn, steep: Math.abs(Math.sin(p.a)) > 0.62 };
    });
    // Names that would run into the one before are left to Today's list.
    let lastRight = -Infinity;
    const named = ways.map((wp) => {
      if (!geo.names || wp.steep) return { ...wp, label: geo.names && wp.steep };
      const half = Math.min(90, wp.name.length * 3.4 + 8);
      const fits = wp.x - half > lastRight + 6 && wp.x + half < geo.w - 8;
      if (fits) lastRight = wp.x + half;
      return { ...wp, label: fits };
    });
    const c = curve;
    return {
      d: `M${r2(c[0].x)} ${r2(c[0].y)} C${r2(c[1].x)} ${r2(c[1].y)} ${r2(c[2].x)} ${r2(c[2].y)} ${r2(c[3].x)} ${r2(c[3].y)}`,
      flown,
      ticks,
      ways: named,
      here,
    };
  }, [geo, hour, events, narrow]);

  useEffect(() => {
    live.current = { geo, here: arc?.here ?? null };
  }, [geo, arc]);

  // ---------- staging: as each event ends, the vehicle sheds a spent stage that falls away and fades ----------

  const [stages, setStages] = useState<Stage[]>([]);
  const lastTick = useRef(now);
  const stageTimers = useRef<number[]>([]);
  useEffect(() => () => stageTimers.current.forEach((t) => window.clearTimeout(t)), []);
  useEffect(() => {
    const before = lastTick.current;
    lastTick.current = now;
    const here = live.current.here;
    if (!here || calm() || document.hidden) return;
    const shed = stagesShed(events, before, now);
    if (!shed.length) return;
    // In the vehicle's own frame (nose up, a 256 box): the stage drops back along its axis and, as it slows, falls
    // toward the ground, tumbling. "Down" on the screen is (sin, cos) of the heading in that frame.
    const deg = (here.a * 180) / Math.PI + 90;
    const th = (deg * Math.PI) / 180;
    const fall = 600;
    const add = shed.map((e) => ({ key: `${e.id}:${e.end.getTime()}`, x: r2(here.x), y: r2(here.y), deg: r2(deg), k: narrow ? 0.11 : 0.15, fx: r2(Math.sin(th) * fall), fy: r2(300 + Math.cos(th) * fall), spin: Math.sin(th) >= 0 ? 38 : -38 }));
    setStages((list) => [...list, ...add]);
    stageTimers.current.push(window.setTimeout(() => setStages((list) => list.filter((x) => !add.includes(x))), STAGE_MS));
  }, [now]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- stars ----------

  const twinkles = useMemo(() => {
    const rnd = seeded(71);
    return Array.from({ length: 12 }, (_, i) => ({ i, left: r2(rnd() * 100), top: r2(rnd() * rnd() * 92), d: r2(-rnd() * 4) }));
  }, []);
  useEffect(() => {
    const c = starsRef.current;
    const el = ref.current;
    if (!c || !el || !geo) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = geo.w * dpr;
    c.height = geo.hz * dpr;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.fillStyle = getComputedStyle(el).getPropertyValue('--ms-star').trim() || 'transparent';
    const rnd = seeded(20261125);
    const n = Math.round((geo.w * geo.hz) / 2600);
    for (let i = 0; i < n; i++) {
      // Denser toward the top of the sky.
      const x = rnd() * geo.w;
      const y = rnd() * rnd() * geo.hz;
      const big = rnd() > 0.9;
      ctx.globalAlpha = 0.25 + rnd() * 0.75;
      ctx.beginPath();
      ctx.arc(x, y, big ? 1.1 : 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [geo?.w, geo?.hz, dark]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- particles and the launch ----------

  const engine = useRef<{ launch: () => void } | null>(null);
  useEffect(() => {
    const el = ref.current;
    const canvas = fxRef.current;
    const ctx = canvas?.getContext('2d');
    if (!el || !canvas || !ctx) return;
    const parts: Particle[] = [];
    let raf = 0;
    let last = 0;
    let acc = 0;
    let vap = 0;
    let colours = { ex: '', core: '', smoke: '' };
    let L: { t: number; y: number; dx: number; rot: number } | null = null;
    const timers: number[] = [];
    const readColours = () => {
      const cs = getComputedStyle(el);
      colours = { ex: cs.getPropertyValue('--ms-ignition').trim(), core: cs.getPropertyValue('--ms-flame-core').trim(), smoke: cs.getPropertyValue('--ms-smoke').trim() };
    };
    const emit = (k: Particle['k'], x: number, y: number, vx: number, vy: number, life: number, size: number) => {
      if (parts.length < 900) parts.push({ k, x, y, vx, vy, life, age: 0, size });
    };
    const ambient = (dt: number, g: Geo) => {
      if (L || !g.site) return;
      acc += dt * 26;
      vap += dt * 4;
      const h = live.current.here;
      while (acc > 1) {
        acc -= 1;
        if (!h) continue;
        const back = h.a + Math.PI + (Math.random() - 0.5) * 0.5;
        const sp = 26 + Math.random() * 30;
        emit('ex', h.x - Math.cos(h.a) * 12, h.y - Math.sin(h.a) * 12, Math.cos(back) * sp, Math.sin(back) * sp, 0.5 + Math.random() * 0.5, 1.6 + Math.random() * 1.6);
      }
      while (vap > 1) {
        vap -= 1;
        const s = g.k / 0.3;
        emit('vap', g.padX + 9 * s, g.hz - (30 + Math.random() * 14) * s, 5 + Math.random() * 8, -3 - Math.random() * 5, 2.2 + Math.random() * 1.6, 2 + Math.random() * 2);
      }
    };
    /** Ignition and the cloud along the ground, then the climb, slowly then faster, leaning downrange; then the next vehicle rolls out. */
    const stepLaunch = (dt: number, g: Geo) => {
      if (!L) return;
      const s = g.k / 0.3;
      const lift = liftRef.current;
      L.t += dt;
      if (L.t > 0.9) {
        const tt = L.t - 0.9;
        L.y = 34 * tt * tt + 5 * tt;
        L.dx = Math.pow(L.y, 1.3) * 0.011;
        L.rot = Math.min(18, L.y / 20);
        if (lift) lift.style.transform = `translate(${r2(L.dx / s)}px, ${r2(-L.y / s)}px) rotate(${r2(L.rot)}deg)`;
      }
      const nx = g.padX + L.dx;
      const ny = g.hz - 13 * s - L.y;
      for (let i = 0; i < 5; i++) emit('ex', nx + (Math.random() - 0.5) * 5 * s, ny + 4, (Math.random() - 0.5) * 26 - L.rot * 3, 70 + Math.random() * 130, 0.35 + Math.random() * 0.6, (2.6 + Math.random() * 3) * s);
      if (L.y < 150) {
        for (let j = 0; j < 3; j++) {
          const side = Math.random() < 0.5 ? -1 : 1;
          emit('smoke', g.padX + side * 6, g.hz - 6, side * (30 + Math.random() * 110), -4 - Math.random() * 26, 2.4 + Math.random() * 2.2, (5 + Math.random() * 8) * s);
        }
      }
      if (L.y > 26 && Math.random() < 0.8) emit('smoke', nx, ny + 10, (Math.random() - 0.5) * 12, 16 + Math.random() * 16, 2.6 + Math.random() * 1.8, (3 + Math.random() * 4) * s);
      // The sky shakes by a pixel or two, and settles.
      const amp = L.t < 3 ? 2.2 * Math.exp(-L.t / 1.2) : 0;
      el.style.translate = amp > 0.05 ? `${r2((Math.random() - 0.5) * amp * 2)}px ${r2((Math.random() - 0.5) * amp * 2)}px` : '';
      if (L.y > g.hz + 150) {
        L = null;
        el.style.translate = '';
        el.classList.remove('ms-ignited');
        el.classList.add('ms-away');
        timers.push(
          window.setTimeout(() => {
            if (lift) lift.style.transform = '';
            el.classList.remove('ms-away');
            el.classList.add('ms-rollout');
            timers.push(window.setTimeout(() => el.classList.remove('ms-rollout'), 2600));
          }, 1800),
        );
      }
    };
    const frame = (t: number) => {
      raf = 0;
      const g = live.current.geo;
      if (!g) return;
      const dt = Math.min(0.05, (t - (last || t)) / 1000);
      last = t;
      if (canvas.width !== g.w || canvas.height !== g.h) {
        canvas.width = g.w;
        canvas.height = g.h;
      }
      // Leaving Home ends a launch where it is: no pad, no fire, no smoke left hanging over another view.
      if (!g.site && (L || parts.length)) {
        L = null;
        parts.length = 0;
        timers.splice(0).forEach((x) => window.clearTimeout(x));
        el.classList.remove('ms-ignited', 'ms-away', 'ms-rollout');
        el.style.translate = '';
      }
      const awake = !document.hidden && !calm();
      if (awake) ambient(dt, g);
      stepLaunch(dt, g);
      ctx.clearRect(0, 0, g.w, g.h);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        p.age += dt;
        if (p.age >= p.life) {
          parts.splice(i, 1);
          continue;
        }
        const u = p.age / p.life;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        if (p.k === 'smoke') {
          p.vx *= 0.985;
          p.vy *= 0.97;
          if (p.y > g.hz - 2) {
            p.y = g.hz - 2;
            p.vy = -Math.abs(p.vy) * 0.3;
          }
        }
        if (p.k === 'ex') {
          ctx.globalAlpha = Math.pow(1 - u, 1.6) * 0.9;
          ctx.fillStyle = u < 0.22 ? colours.core : colours.ex;
        } else {
          ctx.globalAlpha = (p.k === 'vap' ? 0.34 : 0.5) * (1 - u) * Math.min(1, u * 6);
          ctx.fillStyle = colours.smoke;
        }
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (p.k === 'ex' ? 1 + u * 0.8 : 1 + u * 2.6), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // It draws only while there is something to draw: a site with its vapour and exhaust, a launch, or what's left of one.
      if ((awake && g.site) || L || parts.length) kick();
      else last = 0;
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    engine.current = {
      launch: () => {
        const g = live.current.geo;
        if (L || !g?.site || calm() || el.classList.contains('ms-away') || el.classList.contains('ms-rollout')) return;
        readColours();
        L = { t: 0, y: 0, dx: 0, rot: 0 };
        el.classList.add('ms-ignited');
        buzz('launch');
        kick();
      },
    };
    readColours();
    kick();
    const wake = () => {
      readColours();
      kick();
    };
    document.addEventListener('visibilitychange', wake);
    // The theme changing changes the colours of fire and smoke.
    const mo = new MutationObserver(wake);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    const iv = window.setInterval(kick, 2000);
    return () => {
      engine.current = null;
      cancelAnimationFrame(raf);
      window.clearInterval(iv);
      timers.forEach((t) => window.clearTimeout(t));
      document.removeEventListener('visibilitychange', wake);
      mo.disconnect();
      el.classList.remove('ms-ignited', 'ms-away', 'ms-rollout');
      el.style.translate = '';
    };
  }, []);

  // The count going up is a launch; the first value is only where it started. Minutes after one that went up, the
  // recovery: a far point of light comes back down to the horizon and lands (only where it can be seen: on Home, with
  // the page in view; a launch's recovery that can't be seen within a quarter of an hour is missed).
  const launched = useRef(launch);
  const [recovery, setRecovery] = useState(0);
  const recoverTimer = useRef(0);
  const recoverEnd = useRef(0);
  useEffect(() => {
    if (launch === launched.current) return;
    launched.current = launch;
    // It went up if it ignited just now (not if one was already climbing, or it couldn't: off Home, less motion).
    const el = ref.current;
    const was = !!el?.classList.contains('ms-ignited');
    engine.current?.launch();
    if (was || !el?.classList.contains('ms-ignited')) return;
    const from = Date.now();
    const due = () => {
      window.clearTimeout(recoverTimer.current);
      const wait = from + RECOVERY_MS - Date.now();
      if (wait > 0) {
        recoverTimer.current = window.setTimeout(due, wait);
        return;
      }
      if (-wait > RECOVERY_KEEP_MS) return;
      if (!live.current.geo?.site || document.hidden || calm()) {
        recoverTimer.current = window.setTimeout(due, 15_000);
        return;
      }
      setRecovery((n) => n + 1);
      window.clearTimeout(recoverEnd.current);
      recoverEnd.current = window.setTimeout(() => setRecovery(0), RECOVERY_SHOW_MS);
    };
    due();
  }, [launch]);
  useEffect(
    () => () => {
      window.clearTimeout(recoverTimer.current);
      window.clearTimeout(recoverEnd.current);
    },
    [],
  );

  // ---------- the pointer: the sky's layers part, and it throws light on the glass under it ----------

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    let at: PointerEvent | null = null;
    const apply = () => {
      frame = 0;
      const e = at;
      if (!e || calm() || e.pointerType === 'touch') return;
      el.style.setProperty('--px', String(r2((e.clientX / window.innerWidth) * 2 - 1)));
      el.style.setProperty('--py', String(r2((e.clientY / window.innerHeight) * 2 - 1)));
      const glass = e.target instanceof Element ? e.target.closest<HTMLElement>('.panel, .rail') : null;
      if (glass) {
        const b = glass.getBoundingClientRect();
        glass.style.setProperty('--mx', `${Math.round(e.clientX - b.left)}px`);
        glass.style.setProperty('--my', `${Math.round(e.clientY - b.top)}px`);
      }
    };
    const move = (e: PointerEvent) => {
      at = e;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', move, { passive: true });
    return () => {
      window.removeEventListener('pointermove', move);
      cancelAnimationFrame(frame);
    };
  }, []);

  const style = geo
    ? ({
        '--hz': `${geo.hz}px`,
        '--orb-x': `${geo.orbX}px`,
        '--orb-y': `${geo.orbY}px`,
        '--glow': geo.glow,
        '--pad-x': `${geo.padX}px`,
        '--dawn': tw.dawn,
        '--dusk': tw.dusk,
        '--tw': Math.max(tw.dawn, tw.dusk),
        height: narrow ? geo.h : undefined,
      } as CSSProperties)
    : undefined;
  const s = geo ? geo.k / 0.3 : 1;
  const here = arc?.here;

  return (
    <div ref={ref} className={'ms-scene' + (narrow ? ' ms-scene--page' : '')} data-wx={wx} data-watch={watch ? '' : undefined} aria-hidden="true" style={style}>
      <div className="ms-sky" />
      <div className="ms-dawn" />
      <div className="ms-dusk" />
      <canvas ref={starsRef} className="ms-stars" />
      <div className="ms-glow" />
      <i
        className="ms-orb"
        data-moon={geo?.moon ? '' : undefined}
        data-down={geo && !geo.orbUp ? '' : undefined}
        style={geo?.moon ? ({ '--lit': geo.moon.lit, '--moon-turn': `${geo.moon.turn}deg` } as CSSProperties) : undefined}
      >
        {geo?.moon && (
          <svg className="ms-moon" viewBox="-1 -1 2 2">
            <circle className="ms-moon-dim" r="1" />
            <path className="ms-moon-lit" d={moonPath(geo.moon.lit)} />
          </svg>
        )}
      </i>
      <div className="ms-clouds">
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="ms-twinkles">
        {twinkles.map((t) => (
          <i key={t.i} style={{ left: `${t.left}%`, top: `${t.top}%`, '--d': `${t.d}s` } as CSSProperties} />
        ))}
      </div>
      <i className="ms-sat" />
      <i className="ms-trace" />
      <div className="ms-rain" />
      <div className="ms-ground" />
      {recovery > 0 && geo?.site && (
        // Downrange, far off: the point of light coming back down, and its touchdown on the horizon.
        <div key={recovery} className="ms-recovery" style={{ '--land-x': `${Math.round(geo.padX + (geo.w - geo.padX) * (narrow ? 0.72 : 0.66))}px` } as CSSProperties}>
          <i className="ms-recovery-craft" />
          <i className="ms-recovery-touch" />
        </div>
      )}
      {geo && (
        <svg className="ms-svg" viewBox={`0 0 ${geo.w} ${geo.h}`}>
          {arc && here && (
            <g className="ms-arc">
              <path className="ms-fp-ahead" d={arc.d} />
              <path className="ms-fp-flown" pathLength={1} d={arc.flown} />
              {arc.ticks.map((d) => (
                <path key={d} className="ms-fp-tick" d={d} />
              ))}
              {arc.ways.map((wp, n) => (
                <g key={wp.id} className="ms-way" style={{ '--at': `${400 + n * 90}ms` } as CSSProperties}>
                  <circle className={'ms-fp-way' + (wp.past ? ' ms-fp-way--past' : '')} cx={wp.x} cy={wp.y} r={narrow ? 4 : 5} />
                  {wp.label &&
                    (wp.steep ? (
                      <>
                        <text className="ms-fp-name ms-fp-side" x={wp.x + 14} y={wp.y + 1}>
                          {wp.name.length > 26 ? wp.name.slice(0, 25) + '…' : wp.name}
                        </text>
                        <text className="ms-fp-at ms-fp-side" x={wp.x + 14} y={wp.y + 15}>
                          {wp.at}
                        </text>
                      </>
                    ) : (
                      <>
                        <text className="ms-fp-name" x={wp.x} y={wp.y - 27}>
                          {wp.name.length > 26 ? wp.name.slice(0, 25) + '…' : wp.name}
                        </text>
                        <text className="ms-fp-at" x={wp.x} y={wp.y - 13}>
                          {wp.at}
                        </text>
                      </>
                    ))}
                </g>
              ))}
              {stages.map((st) => (
                <g key={st.key} transform={`translate(${st.x} ${st.y}) rotate(${st.deg}) scale(${st.k}) translate(-128 -110)`}>
                  <g className="ms-stage" style={{ '--fx': `${st.fx}px`, '--fy': `${st.fy}px`, '--spin': `${st.spin}deg` } as CSSProperties}>
                    <path className="ms-stage-body" d="M90 172 H166 V222 H90 Z" />
                    <path className="ms-hull-shade" d="M128 172 H166 V222 H128 Z" />
                    <path className="ms-stage-bell" d="M108 222 H148 L156 244 H100 Z" />
                    <path className="ms-stage-ember" d="M110 244 H146 L142 252 H114 Z" />
                  </g>
                </g>
              ))}
              <circle className="ms-ring" cx={r2(here.x)} cy={r2(here.y)} r={10} />
              <g className="ms-craft">
                <g transform={`translate(${r2(here.x)} ${r2(here.y)}) rotate(${r2((here.a * 180) / Math.PI + 90)}) scale(${narrow ? 0.11 : 0.15}) translate(-128 -110)`}>
                  <Vehicle small />
                </g>
              </g>
            </g>
          )}
          {geo.site && down.length > 0 && (
            // Why its lights are out, in a small label by the site, with the poll's scrub mark.
            // It stands on the horizon; names that wouldn't fit in the sky's width are counted instead.
            <g className="ms-power" transform={`translate(${Math.round(geo.padX + (narrow ? 126 : 142) * s)} ${geo.hz - 4})`}>
              <rect className="ms-power-mark" x={0} y={-7} width={6} height={6} rx={1} transform="rotate(45 3 -4)" />
              <text className="ms-power-text" x={12} y={0}>
                {powerText(down, Math.floor((geo.w - geo.padX - (narrow ? 126 : 142) * s - 20) / POWER_LETTER))}
              </text>
            </g>
          )}
          {geo.site && (
            // The site, built round the pad at (0, 0) with up as negative.
            <g className="ms-site" transform={`translate(${geo.padX} ${geo.hz}) scale(${r2(s)})`}>
              {/* The server's power (idea 8): a container down puts a floodlight out and turns its mast's lamp steady. */}
              <path className="ms-flood" data-out={down.length > 1 ? '' : undefined} d="M-104 -3 L-7 -58 L-7 -24 Z" />
              <path className="ms-flood" data-out={down.length > 0 ? '' : undefined} d="M108 -3 L7 -58 L7 -24 Z" />
              <path className="ms-land" d="M-120 0 Q-60 -9 0 -9 Q60 -9 130 0 Z" />
              <path className="ms-land" d="M-16 -9 h32 v-6 h-32 z" />
              <path
                className="ms-land-line"
                d="M-40 -9 V-104 M-30 -9 V-104 M-40 -104 H-30 M-40 -84 L-30 -64 M-30 -84 L-40 -64 M-40 -64 L-30 -44 M-30 -64 L-40 -44 M-40 -44 L-30 -24 M-30 -44 L-40 -24 M-40 -84 H-30 M-40 -64 H-30 M-40 -44 H-30 M-40 -24 H-30 M-30 -58 H-12 M-30 -30 H-12"
              />
              <path className="ms-land-line ms-land-thin" d="M-66 -7 V-128 M30 -9 V-128 M56 -7 V-128" />
              <circle className="ms-lamp" data-steady={down.length > 1 ? '' : undefined} cx={-66} cy={-130} r={2.2} />
              <circle className="ms-lamp" data-steady={down.length > 2 ? '' : undefined} style={{ '--d': '-0.8s' } as CSSProperties} cx={30} cy={-130} r={2.2} />
              <circle className="ms-lamp" data-steady={down.length > 0 ? '' : undefined} style={{ '--d': '-1.6s' } as CSSProperties} cx={56} cy={-130} r={2.2} />
              <circle className="ms-lamp" style={{ '--d': '-0.4s' } as CSSProperties} cx={-35} cy={-107} r={2} />
              {!narrow && (
                <>
                  <circle className="ms-land" cx={92} cy={-34} r={9} />
                  <path className="ms-land-line" d="M92 -26 V-7 M86 -27 L82 -7 M98 -27 L102 -7" />
                </>
              )}
              <g ref={liftRef} className="ms-lift">
                <g className="ms-pad-vehicle" transform="translate(0 -15) scale(0.3) translate(-128 -170)">
                  <Vehicle />
                </g>
              </g>
            </g>
          )}
        </svg>
      )}
      <canvas ref={fxRef} className="ms-fx" />
      <div className="ms-flash" />
    </div>
  );
}
