import { useEffect, useRef } from 'react';

/** For a `.tabs` row that scrolls sideways on a phone: keeps the active tab in sight, so a
 *  remembered tab at the far end isn't hidden off the edge when the view opens. Only the row
 *  scrolls, never the page. */
export function useActiveTabInView<T extends HTMLElement = HTMLDivElement>(active: unknown) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const row = ref.current;
    const tab = row?.querySelector<HTMLElement>('.tab.active');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const left = tab.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft;
    const right = left + tab.offsetWidth;
    if (left < row.scrollLeft) row.scrollLeft = left - 8;
    else if (right > row.scrollLeft + row.clientWidth) row.scrollLeft = right - row.clientWidth + 8;
  }, [active]);
  return ref;
}
