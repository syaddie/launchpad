import { useEffect, useRef } from 'react';

/** For a `.tabs` row that scrolls sideways on a phone: keeps the active tab in sight, so a
 *  remembered tab at the far end isn't hidden off the edge when the view opens. Only the row
 *  scrolls, never the page. `selector` picks the active item; with `followResize` it's brought
 *  back into sight whenever the row changes size too (the rail, which turns from a column into
 *  a row when the window narrows). */
export function useActiveTabInView<T extends HTMLElement = HTMLDivElement>(active: unknown, selector = '.tab.active', followResize = false) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const row = ref.current;
    if (!row) return;
    const show = () => {
      const tab = row.querySelector<HTMLElement>(selector);
      if (!tab || row.scrollWidth <= row.clientWidth) return;
      const left = tab.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
      const right = left + tab.offsetWidth;
      if (left < row.scrollLeft) row.scrollLeft = left - 8;
      else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
    };
    show();
    if (!followResize || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(show);
    ro.observe(row);
    // A row that keeps its size (one that spans the window) still gets wider inside
    // once its typeface has loaded.
    let live = true;
    document.fonts?.ready.then(() => live && requestAnimationFrame(() => live && show()));
    return () => {
      live = false;
      ro.disconnect();
    };
  }, [active, selector, followResize]);
  return ref;
}
