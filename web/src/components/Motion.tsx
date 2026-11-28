// The React side of motion (docs/motion.md): things that animate out before they go, figures whose
// digits roll when they change, highlights that glide between tabs, and lists that animate what's
// added to them. The keyframes and transitions are in motion.css.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { localGet, localSet } from '../api';
import { type PeriodStep, type Shown, keepGone, readoutCells, rollDirection, unseen } from '../motion';
import { leavePeriod, markAcross } from '../periodMotion';

/** The longest an exit may take before its element goes anyway (a page that isn't being drawn never finishes one). */
const EXIT_CAP_MS = 450;

/**
 * Keeps its children on the page for a moment after `show` turns false, marked `data-leaving` (and
 * inert, so nothing in them can be used or focused), while they animate out; then removes them.
 * The wrapper is `display: contents`, so it adds no box (unless `className` gives it one, as FoldRow's does). Showing
 * again while leaving brings them back. `cap` (ms): the longest the exit may take.
 */
export function Presence({ show, children, className, cap = EXIT_CAP_MS }: { show: boolean; children: ReactNode; className?: string; cap?: number }) {
  const last = useRef<ReactNode>(null);
  const [leaving, setLeaving] = useState(false);
  const [mounted, setMounted] = useState(show);
  const ref = useRef<HTMLDivElement>(null);
  if (show) last.current = children;

  // Kept in step with `show` while rendering (state from the last render, as React allows).
  if (show && !mounted) setMounted(true);
  if (show && leaving) setLeaving(false);
  if (!show && mounted && !leaving) setLeaving(true);

  useEffect(() => {
    if (!leaving) return;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      last.current = null;
      setLeaving(false);
      setMounted(false);
    };
    const timer = window.setTimeout(finish, cap);
    // Wait for the exit animations motion.css started (not endless ones, such as a spinner inside).
    const exits = ref.current?.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) ?? [];
    if (!exits.length) finish();
    else Promise.all(exits.map((a) => a.finished)).then(finish, finish);
    return () => {
      // Shown again (or gone): this exit no longer decides anything.
      done = true;
      window.clearTimeout(timer);
    };
  }, [leaving, cap]);

  if (!mounted) return null;
  return (
    <div ref={ref} className={'lp-presence' + (className ? ' ' + className : '')} data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
      {show ? children : last.current}
    </div>
  );
}

/**
 * False on a component's first frames, true once it has been drawn. A list marks itself
 * `data-settled` with it, and motion.css animates in only the items that arrive after that, not the
 * ones that were there when it appeared (those come in with the view). Waits two frames, so the first
 * items' styles are worked out before the mark goes on.
 */
export function useSettled(): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    let b = 0;
    const a = requestAnimationFrame(() => {
      b = requestAnimationFrame(() => setSettled(true));
    });
    return () => {
      cancelAnimationFrame(a);
      cancelAnimationFrame(b);
    };
  }, []);
  return settled;
}

/** Whether the page is in view (not a tab in the background), following it. */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const on = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * Which of `keys` are new since this device last showed them, so a design can light them once as they first appear
 * (Training's new bests, the Digest's new lessons) rather than every time the view opens. What's been seen is kept in
 * localStorage under `store`; with no record yet (the first time this runs) nothing is new, since what's there was there
 * before. Worked out while rendering, so what's new is marked from the first frame it's drawn in, and only while the
 * page is in view: what arrives while the tab is in the background is still new when you come back to it. They stay
 * marked for `hold` ms, or as long as the view is open when it's left out.
 */
export function useUnseen(store: string, keys: string[], hold?: number): ReadonlySet<string> {
  const sig = keys.join('\n');
  const visible = usePageVisible();
  const [state, setState] = useState(() => ({ sig: null as string | null, seen: localGet(store), fresh: NONE }));
  if (visible && state.sig !== sig) {
    const found = unseen(keys, state.seen);
    setState({ sig, seen: JSON.stringify(keys), fresh: found.length ? new Set(found) : state.fresh });
  }
  useEffect(() => {
    if (state.sig !== null) localSet(store, state.seen!);
  }, [store, state.sig, state.seen]);
  useEffect(() => {
    if (!hold || !state.fresh.size) return;
    const t = window.setTimeout(() => setState((s) => ({ ...s, fresh: NONE })), hold);
    return () => window.clearTimeout(t);
  }, [hold, state.fresh]);
  return state.fresh;
}

/** How long rows that just arrived stay marked: past the end of the longest way a design brings them in. */
const ARRIVED_MS = 2000;

/**
 * Which of `ids` just came into a list that's showing (new mail, an archived email brought back by Undo), so a design
 * can bring them in: those that weren't there the render before, for a moment. What's there as the list appears, or
 * comes in during its first frames, just shows (useSettled). Worked out while rendering, so a new row is marked from
 * the first frame it's drawn in.
 */
export function useArrived(ids: string[]): ReadonlySet<string> {
  const settled = useSettled();
  const sig = ids.join('\n');
  const [state, setState] = useState(() => ({ sig, ids: new Set(ids), fresh: NONE }));
  if (state.sig !== sig) {
    const came = settled ? ids.filter((id) => !state.ids.has(id)) : [];
    setState({ sig, ids: new Set(ids), fresh: came.length ? new Set([...state.fresh, ...came]) : state.fresh });
  }
  useEffect(() => {
    if (!state.fresh.size) return;
    const t = window.setTimeout(() => setState((s) => ({ ...s, fresh: NONE })), ARRIVED_MS);
    return () => window.clearTimeout(t);
  }, [state.fresh]);
  return state.fresh;
}

/** How long a row taken out of a list is kept, marked gone, for its FoldRow to see it go. */
const GONE_MS = 3000;

/**
 * A list as it's shown, with what's been taken out of it kept in its place for a moment, marked `gone`, so a FoldRow can
 * see it go (bills kept or dismissed are dropped from the list, not marked). What's added goes where the list has it.
 */
export function useWithGone<T>(items: T[], key: (item: T) => string): Shown<T>[] {
  const [state, setState] = useState(() => ({ items, shown: keepGone([], items, key, 0, GONE_MS) }));
  if (state.items !== items) setState({ items, shown: keepGone(state.shown, items, key, Date.now(), GONE_MS) });
  return state.shown;
}

/** The longest a row may take to go: sliding out, then the rows after it closing up (motion.css, ROWS). */
const FOLD_CAP_MS = 1200;

/**
 * A row in a list that can go (an email archived, a bill kept or dismissed) or arrive (new mail): while `show` is true
 * it's there; when it turns false it slides out and the rows after it close up, kept on the page (inert) by Presence
 * meanwhile. `arriving` brings a new one in, the list opening up for it; `i` orders several arriving at once (0 first).
 * Rows that go while one has the keyboard's focus should call focusPastRow first.
 */
export function FoldRow({ show, arriving, i, children }: { show: boolean; arriving?: boolean; i?: number; children: ReactNode }) {
  return (
    <Presence show={show} className="lp-fold" cap={FOLD_CAP_MS}>
      <div className="lp-fold-in" data-new={arriving ? '' : undefined} style={arriving && i ? ({ '--i': i } as CSSProperties) : undefined}>
        {children}
      </div>
    </Presence>
  );
}

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Before rows go (FoldRow), moves the keyboard's place out of one that has it to the next row in its list, or the one
 * before when it was the last, so the keys carry on down the list instead of starting again from the top of the page.
 * With no row left, to what's next to the list (a heading's button), or the panel itself. `going` says which rows go.
 */
export function focusPastRow(going: (row: Element) => boolean) {
  const row = document.activeElement?.closest('.lp-fold');
  if (!(row instanceof HTMLElement) || !going(row)) return;
  const stays = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.matches('.lp-fold:not([data-leaving])') && !going(el);
  const walk = (dir: 'nextElementSibling' | 'previousElementSibling') => {
    for (let el = row[dir]; el?.matches('.lp-fold'); el = el[dir]) if (stays(el)) return el;
    return null;
  };
  const near = (dir: 'nextElementSibling' | 'previousElementSibling') => {
    for (let el = row[dir]; el; el = el[dir]) if (!el.matches('.lp-fold')) return (el.matches(FOCUSABLE) ? el : el.querySelector(FOCUSABLE)) as HTMLElement | null;
    return null;
  };
  const to = walk('nextElementSibling') ?? walk('previousElementSibling');
  let target = (to?.querySelector(FOCUSABLE) as HTMLElement | null) ?? near('nextElementSibling') ?? near('previousElementSibling');
  if (!target) {
    const panel = row.closest('.panel');
    if (panel instanceof HTMLElement) {
      if (!panel.hasAttribute('tabindex')) panel.tabIndex = -1;
      target = panel;
    }
  }
  target?.focus();
}

/**
 * A highlight that glides to the active item of a row of tabs or the rail. Put `<span className="glide" />`
 * first in the row, and `ref` on the row (which must be positioned; motion.css positions the usual
 * rows). It sets `--glide-x`, `--glide-y`, `--glide-w` and `--glide-h` on the row, the active item's
 * box in px, and `data-glide`: `still` on the first placing (so it doesn't fly in from the corner),
 * `on` from then (motion.css glides it). Measured from layout, not the screen, so a pressed (scaled)
 * item doesn't throw it off; re-measured whenever `active` changes and when the row or its items
 * change size. With no active item, the highlight goes.
 */
export function useGlide(ref: RefObject<HTMLElement | null>, active: unknown, selector = '.on, .active, [aria-current="page"], [aria-selected="true"]') {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    let frame = 0;
    const place = () => {
      const on = [...row.querySelectorAll<HTMLElement>(selector)].find((el) => el.parentElement === row || el.offsetParent === row);
      if (!on || !on.offsetWidth) {
        row.removeAttribute('data-glide');
        return;
      }
      row.style.setProperty('--glide-x', `${on.offsetLeft}px`);
      row.style.setProperty('--glide-y', `${on.offsetTop}px`);
      row.style.setProperty('--glide-w', `${on.offsetWidth}px`);
      row.style.setProperty('--glide-h', `${on.offsetHeight}px`);
      if (!row.dataset.glide) {
        row.dataset.glide = 'still';
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          if (row.dataset.glide) row.dataset.glide = 'on';
        });
      }
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(row);
    for (const child of row.children) ro.observe(child);
    // A row whose items change width once its typeface has loaded.
    let live = true;
    document.fonts?.ready.then(() => live && place());
    return () => {
      live = false;
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [ref, active, selector]);
}

/**
 * The gliding highlight for a row of tabs or a segmented control, put first in the row: it lights
 * whichever item of the row is active (`selector`, as `useGlide`) and glides when `on` changes.
 * The row is the span's parent, so a row needs nothing else.
 */
export function Glide({ on, selector }: { on: unknown; selector?: string }) {
  const self = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLElement | null>(null);
  // Declared before useGlide, so the row is known when it first measures.
  useLayoutEffect(() => {
    row.current = self.current?.parentElement ?? null;
  });
  useGlide(row, on, selector);
  return <span ref={self} className="glide" aria-hidden="true" />;
}

/** How long a new period is marked as coming in: past the end of its longest animation (Mission's cells lighting up). */
const ARRIVING_MS = 1600;

/**
 * A period with arrows (a month, a year, a week) that moves the way you went when it changes (periodMotion.ts has the
 * parts and their classes). Put `ref` and `data-arrive={arrive}` on the host, which has the class `lp-scan`, and call
 * `go(step)` just before the period changes: the old grid is copied, and `arrive` says which way the new one comes in
 * for as long as it does. Only a change made with `go` moves: a period opened from elsewhere just shows.
 */
export function usePeriodScan<T extends HTMLElement = HTMLElement>() {
  const ref = useRef<T>(null);
  const [arrive, setArrive] = useState<{ step: PeriodStep; n: number } | null>(null);
  const go = (step: PeriodStep | null) => {
    if (!step) return;
    leavePeriod(ref.current, step);
    setArrive((a) => ({ step, n: (a?.n ?? 0) + 1 }));
  };
  useLayoutEffect(() => {
    if (arrive) markAcross(ref.current);
  }, [arrive]);
  useEffect(() => {
    if (!arrive) return;
    const t = window.setTimeout(() => setArrive(null), ARRIVING_MS);
    return () => window.clearTimeout(t);
  }, [arrive]);
  return { ref, arrive: arrive?.step, go };
}

/**
 * A period's name with each letter its own, so a design can light them one after another (Mission relights them like
 * the launch clock's dots, from the side the period came in). Screen readers get the text as it is. Key it by the
 * period, so a new name comes in whole.
 */
export function Glyphs({ text }: { text: string }) {
  return (
    <>
      <span className="lp-sr">{text}</span>
      <span className="lp-glyphs" aria-hidden="true">
        {[...text].map((ch, i, all) => (
          <span key={i} style={{ '--i': i, '--n': all.length } as CSSProperties}>
            {ch}
          </span>
        ))}
      </span>
    </>
  );
}

/**
 * What each readout showed last, by its `id`. Coming back to a view then shows a figure as it was,
 * with nothing moving, and one that changed meanwhile rolls from what was last seen. Forgotten on
 * reload, so a new page shows every figure fresh.
 */
const lastShown = new Map<string, string>();

/**
 * A figure whose digits roll when it changes, like a counter: each changed digit leaves as the new one
 * arrives, up when the figure grew and down when it shrank. Digits that didn't change stay still, and
 * the units stay put when it grows a digit. Screen readers get the text as it is.
 */
export function Readout({ text, id, className, title }: { text: string; id?: string; className?: string; title?: string }) {
  const before = useRef<string | undefined>(id ? lastShown.get(id) : undefined);
  const cells = readoutCells(text, before.current);
  const dir = rollDirection(text, before.current);
  useEffect(() => {
    before.current = text;
    if (id) lastShown.set(id, text);
  }, [id, text]);
  return (
    <span className={'readout' + (className ? ' ' + className : '')} title={title}>
      <span className="lp-sr">{text}</span>
      <span className="readout-cells" aria-hidden="true">
        {cells.map((cell, order) =>
          cell.digit ? <Digit key={cell.key} value={cell.char} from={cell.from} order={order} dir={dir} /> : <span key={cell.key}>{cell.char}</span>,
        )}
      </span>
    </span>
  );
}

/** One digit in its window. `from` is the digit it replaces as it appears (see readoutCells in motion.ts). */
function Digit({ value, from, order, dir }: { value: string; from: string | null | undefined; order: number; dir: 'up' | 'down' }) {
  const [shown, setShown] = useState(() => ({ value, out: from && from !== value ? from : null, turn: 0, dir }));
  // A new value: the one showing rolls out as the new one rolls in.
  if (shown.value !== value) setShown({ value, out: shown.value, turn: shown.turn + 1, dir });
  return (
    <span className={'digit' + (shown.out !== null ? ' rolling' : '')} data-dir={shown.dir} style={{ '--order': order } as CSSProperties}>
      {shown.out !== null && (
        <span key={`out${shown.turn}`} className="digit-out">
          {shown.out}
        </span>
      )}
      <span key={`in${shown.turn}`} className="digit-in">
        {shown.value}
      </span>
    </span>
  );
}
