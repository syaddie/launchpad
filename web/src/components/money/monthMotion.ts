// Changing month in Money › Month (docs/motion.md, "Changing month"). The old month's calendar stays on screen as a
// copy of itself, inert and hidden from screen readers, over the new one, which comes in behind a line crossing the
// calendar the way you went; the copy goes ahead of the line. Only the copy is made here: styles.css, designs.css and
// mission.css move it, each design in its own way, and the copy removes itself once it has gone.

/** Which way the month changed: later (`next`) or earlier (`prev`). */
export type MonthStep = 'next' | 'prev';

export function monthStep(from: string, to: string): MonthStep | null {
  return to === from ? null : to > from ? 'next' : 'prev';
}

/** The longest a copy stays, in case its animation never ends (a page that isn't being drawn, or no motion at all). */
const COPY_MS = 1500;

/**
 * Leaves a copy of the calendar's grid in `root` exactly over it, marked with the way the month is changing, to be
 * moved off as the next month's grid comes in. Call it just before the month changes. A copy still leaving from a
 * quicker change goes at once.
 */
export function leaveMonth(root: HTMLElement | null, step: MonthStep) {
  const cal = root?.querySelector<HTMLElement>('.cal');
  const grid = cal?.querySelector<HTMLElement>(':scope > .cal-grid');
  for (const old of cal?.querySelectorAll(':scope > .cal-sweep') ?? []) old.remove();
  if (!cal || !grid || document.visibilityState !== 'visible') return;

  const sweep = document.createElement('div');
  sweep.className = 'cal-sweep';
  sweep.dataset.step = step;
  sweep.setAttribute('aria-hidden', 'true');
  sweep.inert = true;
  Object.assign(sweep.style, { left: `${grid.offsetLeft}px`, top: `${grid.offsetTop}px`, width: `${grid.offsetWidth}px`, height: `${grid.offsetHeight}px` });

  const copy = grid.cloneNode(true) as HTMLElement;
  copy.classList.add('cal-copy');
  for (const name of ['role', 'aria-label', 'tabindex']) copy.removeAttribute(name);
  // Nothing in it is a day any more: what looks for a day by its date finds only the real one.
  for (const el of copy.querySelectorAll<HTMLElement>('[data-date]')) el.removeAttribute('data-date');

  // The line that crosses the calendar (each design draws it, or hides it).
  const line = document.createElement('i');
  line.className = 'cal-scan';
  sweep.append(copy, line);
  cal.append(sweep);

  let gone = false;
  const go = () => {
    if (gone) return;
    gone = true;
    window.clearTimeout(cap);
    sweep.remove();
  };
  const cap = window.setTimeout(go, COPY_MS);
  copy.addEventListener('animationend', (e) => e.target === copy && go());
}
