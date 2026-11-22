// The React side of motion (docs/motion.md): things that animate out before they go, figures whose
// digits roll when they change, highlights that glide between tabs, and lists that animate what's
// added to them. The keyframes and transitions are in motion.css.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { readoutCells, rollDirection } from '../motion';

/** The longest an exit may take before its element goes anyway (a page that isn't being drawn never finishes one). */
const EXIT_CAP_MS = 450;

/**
 * Keeps its children on the page for a moment after `show` turns false, marked `data-leaving` (and
 * inert, so nothing in them can be used or focused), while they animate out; then removes them.
 * The wrapper is `display: contents`, so it adds no box. Showing again while leaving brings them back.
 */
export function Presence({ show, children }: { show: boolean; children: ReactNode }) {
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
    const cap = window.setTimeout(finish, EXIT_CAP_MS);
    // Wait for the exit animations motion.css started (not endless ones, such as a spinner inside).
    const exits = ref.current?.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().iterations !== Infinity) ?? [];
    if (!exits.length) finish();
    else Promise.all(exits.map((a) => a.finished)).then(finish, finish);
    return () => {
      // Shown again (or gone): this exit no longer decides anything.
      done = true;
      window.clearTimeout(cap);
    };
  }, [leaving]);

  if (!mounted) return null;
  return (
    <div ref={ref} className="lp-presence" data-leaving={leaving ? '' : undefined} inert={leaving || undefined}>
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
