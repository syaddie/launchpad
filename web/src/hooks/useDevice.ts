import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { ViewKey } from '../../../shared/types';
import type { Layout } from '../layout';
import { hashFor, viewFromHash } from '../util';

/** The time, ticking on the minute. */
export function useMinuteNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let iv = 0;
    // Tick on the minute boundary so "in 28 min" labels change with the clock.
    const t = window.setTimeout(() => {
      setNow(new Date());
      iv = window.setInterval(() => setNow(new Date()), 60_000);
    }, 60_000 - (Date.now() % 60_000) + 50);
    return () => {
      clearTimeout(t);
      clearInterval(iv);
    };
  }, []);
  return now;
}

export function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const h = () => setDark(mq.matches);
    mq.addEventListener('change', h);
    return () => mq.removeEventListener('change', h);
  }, []);
  return dark;
}

/** Narrow, desktop or wide, from the width of `ref`'s element. */
export function useLayout(ref: RefObject<HTMLElement | null>): Layout {
  const [layout, setLayout] = useState<Layout>('desktop');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // A short screen (a phone on its side) gets the stacked, page-scrolling layout too:
    // the other layouts pin the panels to the window height, which squeezes them to nothing.
    const short = window.matchMedia('(max-height: 599px)');
    let w = el.clientWidth;
    const pick = () => setLayout(w < 760 || short.matches ? 'narrow' : w >= 2000 ? 'wide' : 'desktop');
    const ro = new ResizeObserver(([e]) => {
      w = e.contentRect.width;
      pick();
    });
    ro.observe(el);
    short.addEventListener('change', pick);
    return () => {
      ro.disconnect();
      short.removeEventListener('change', pick);
    };
  }, [ref]);
  return layout;
}

/**
 * The view lives in the URL's hash (#money), so a reload stays put and Back and Forward
 * move between views. Home has no hash, so a new tab is still the plain "/".
 * `move(from, to, apply)` changes the view (App animates it); Back and Forward go through it
 * too, unless the browser has already animated the change itself (a phone's back swipe).
 */
export function useHashView(move: (from: ViewKey, to: ViewKey, apply: () => void) => void) {
  const [view, setView] = useState<ViewKey>(() => viewFromHash(location.hash));
  const current = useRef(view);
  current.current = view;
  const moveRef = useRef(move);
  moveRef.current = move;
  useEffect(() => {
    if (viewFromHash(location.hash) !== view) history.pushState(null, '', hashFor(view) || location.pathname + location.search);
  }, [view]);
  useEffect(() => {
    const onNav = (e: Event) => {
      const to = viewFromHash(location.hash);
      if (to === current.current) return;
      if ((e as Event & { hasUAVisualTransition?: boolean }).hasUAVisualTransition) setView(to);
      else moveRef.current(current.current, to, () => setView(to));
    };
    window.addEventListener('popstate', onNav);
    window.addEventListener('hashchange', onNav);
    return () => {
      window.removeEventListener('popstate', onNav);
      window.removeEventListener('hashchange', onNav);
    };
  }, []);
  const go = useCallback((to: ViewKey) => moveRef.current(current.current, to, () => setView(to)), []);
  return [view, go] as const;
}
