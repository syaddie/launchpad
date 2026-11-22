// Moving from one view to the next. Most designs use the browser's view transitions: the browser
// keeps a picture of the page as it was, the app changes it, and motion.css animates between the two
// in the way `step` names. A design whose --m-view-mode is `enter` (Vista, whose glass can't be
// pictured) changes at once instead, and its new view's panels come in by themselves (data-entering).
// Where the browser has no view transitions, or the page isn't being drawn, the view simply changes.

import { flushSync } from 'react-dom';
import type { ViewStep } from './motion';

let current: ViewTransition | null = null;
let entering = 0;

/** Ends the opening sequence the first view gets as the app starts (motion.css), so nothing later replays it. */
export function endOpening() {
  document.documentElement.classList.remove('lp-opening');
}

/** A duration token from motion.css, in ms. */
function token(name: string): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  return Number.isFinite(n) ? (raw.endsWith('ms') ? n : n * 1000) : 0;
}

/** Runs `update` (which changes the view), moving the way `step` says. */
export function viewTransition(step: ViewStep, update: () => void) {
  endOpening();
  const root = document.documentElement;
  if (step === 'none') {
    update();
    return;
  }
  if (getComputedStyle(root).getPropertyValue('--m-view-mode').trim() === 'enter') {
    // Marked while the new view's panels come in, then unmarked (their animations have ended by then).
    root.dataset.entering = step;
    flushSync(update);
    window.clearTimeout(entering);
    entering = window.setTimeout(() => delete root.dataset.entering, token('--m-view') * 2 + 200);
    return;
  }
  if (typeof document.startViewTransition !== 'function' || document.visibilityState !== 'visible') {
    update();
    return;
  }
  root.dataset.step = step;
  let updated = false;
  // React draws the new view before the callback returns, so the browser's picture of it is whole.
  const started = document.startViewTransition(() => {
    updated = true;
    flushSync(update);
  });
  current = started;
  // The browser changes the view at its next frame. If it isn't drawing frames (a tab that says it's
  // visible but isn't being painted), change it anyway, without the motion, rather than wait.
  const late = window.setTimeout(() => {
    if (!updated) started.skipTransition();
  }, 300);
  const done = () => {
    window.clearTimeout(late);
    if (current !== started) return;
    current = null;
    delete root.dataset.step;
  };
  started.finished.then(done, done);
  // Starting another transition skips this one, which is expected; its update still runs.
  started.ready.catch(() => {});
  started.updateCallbackDone.catch((error: unknown) => console.error(error));
}
