// Changing a period with arrows (docs/motion.md, "Changing a period"): Money › Month, Mood's month, Year in pixels'
// year, Review's week and Training's week. The old period's grid stays on screen as a copy of itself, inert and hidden
// from screen readers, over the new one, which comes in behind a line crossing it the way you went; the copy goes
// ahead of the line. Only the copy and its marks are made here (`usePeriodScan` in Motion.tsx calls them): styles.css,
// designs.css and mission.css move them, each design in its own way, and the copy removes itself once it has gone.
//
// The parts, by class:
// - `lp-scan` on the host, which `usePeriodScan` marks `data-arrive` with the way the period changed while the new one
//   comes in;
// - `lp-scan-grid` on what changes, a new element for each period (keyed by it) so it comes in whole. Its offset
//   parent must be inside the host (the host itself will do: `lp-scan` positions it), and the copy goes there;
// - `lp-scan-cell` on what lights as the line passes it (Mission), given `--x`, its middle's place across the grid
//   from 0 (the left) to 1;
// - `lp-period-label` on the period's name, with `Glyphs` in it for Mission's letter-by-letter relight.

import type { PeriodStep } from './motion';

/** The longest a copy stays, in case its animation never ends (a page that isn't being drawn, or no motion at all). */
const COPY_MS = 1500;

const gridIn = (host: HTMLElement) => host.querySelector<HTMLElement>('.lp-scan-grid:not(.cal-copy)');

/**
 * Leaves a copy of the host's grid exactly over it, marked with the way the period is changing, to be moved off as
 * the next period's grid comes in. Call it just before the period changes. A copy still leaving from a quicker change
 * goes at once.
 */
export function leavePeriod(host: HTMLElement | null, step: PeriodStep) {
  if (!host) return;
  for (const old of host.querySelectorAll(':scope .cal-sweep')) old.remove();
  const grid = gridIn(host);
  const box = grid?.offsetParent;
  if (!grid || !(box instanceof HTMLElement) || !host.contains(box) || document.visibilityState !== 'visible') return;

  const sweep = document.createElement('div');
  sweep.className = 'cal-sweep';
  sweep.dataset.step = step;
  sweep.setAttribute('aria-hidden', 'true');
  sweep.inert = true;
  Object.assign(sweep.style, { left: `${grid.offsetLeft}px`, top: `${grid.offsetTop}px`, width: `${grid.offsetWidth}px`, height: `${grid.offsetHeight}px` });

  const copy = grid.cloneNode(true) as HTMLElement;
  copy.classList.add('cal-copy');
  for (const name of ['role', 'aria-label', 'tabindex', 'id']) copy.removeAttribute(name);
  // Nothing in it is a day any more: what looks for a day by its date finds only the real one.
  for (const el of copy.querySelectorAll<HTMLElement>('[data-date], [id]')) {
    el.removeAttribute('data-date');
    el.removeAttribute('id');
  }

  // The line that crosses the grid (each design draws it, or hides it).
  const line = document.createElement('i');
  line.className = 'cal-scan';
  sweep.append(copy, line);
  box.append(sweep);

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

/**
 * Gives each `lp-scan-cell` of the host's grid `--x`, where its middle is across the grid (0 to 1), so Mission can
 * light it as the line passes. Measured as a share of the grid's width, so a grid drawn scaled (Vista's views come in
 * scaled) gives the same answer.
 */
export function markAcross(host: HTMLElement | null) {
  const grid = host && gridIn(host);
  if (!grid) return;
  const g = grid.getBoundingClientRect();
  if (!g.width) return;
  for (const cell of grid.querySelectorAll<HTMLElement>('.lp-scan-cell')) {
    const r = cell.getBoundingClientRect();
    cell.style.setProperty('--x', String(Math.min(1, Math.max(0, Math.round(((r.left + r.width / 2 - g.left) / g.width) * 1000) / 1000))));
  }
}
