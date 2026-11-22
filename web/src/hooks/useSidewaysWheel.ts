import { useEffect } from 'react';

/** The rows of tabs that scroll sideways when they don't fit (a note's tabs, a view's tabs). */
const ROWS = '.tabs, .note-tabs';
/** A wheel that counts in lines or pages rather than pixels (Firefox on some mice). */
const LINE_PX = 16;

/**
 * A mouse wheel only scrolls up and down, so a row of tabs that's too wide could only be scrolled
 * with a trackpad or by dragging. Over such a row, this turns the wheel into a sideways scroll.
 * Mounted once, in App, so every row gets it. At either end the wheel scrolls the page as usual.
 */
export function useSidewaysWheel() {
  useEffect(() => {
    const wheel = (e: WheelEvent) => {
      // A trackpad already scrolls sideways; Shift is the browser's own sideways wheel; Ctrl zooms.
      if (e.ctrlKey || e.shiftKey || !e.deltaY || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>(ROWS) : null;
      if (!row) return;
      const max = row.scrollWidth - row.clientWidth;
      if (max < 1) return;
      const dy = e.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? e.deltaY : e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : row.clientWidth);
      // Already at the end it's heading for: leave the wheel to the page.
      if ((dy < 0 && row.scrollLeft <= 0) || (dy > 0 && row.scrollLeft >= max - 1)) return;
      e.preventDefault();
      row.scrollLeft += dy;
    };
    // Not passive, so it can stop the page scrolling while the row does.
    window.addEventListener('wheel', wheel, { passive: false });
    return () => window.removeEventListener('wheel', wheel);
  }, []);
}
