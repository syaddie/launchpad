/**
 * A short vibration in answer to a tick, a launch or a lock-on, where the device can (`navigator.vibrate`: Android's
 * browsers; Safari on an iPhone has none, so nothing happens there). Ticks are every layout's (a box or an entry ticked
 * by hand); launches and lock-ons are Mission's (a liftoff or an ignition you're looking at, a day locked on to). Never
 * while the page is hidden, never with less motion, and Settings › General can turn it off on this device.
 */

export type BuzzKind = 'tick' | 'lock' | 'launch';

/** Short and few: a tick is one tap, a lock-on two, a launch a tap and a longer rumble. Milliseconds on, off, on. */
export const BUZZ_PATTERNS: Record<BuzzKind, number[]> = { tick: [10], lock: [8, 50, 12], launch: [18, 60, 36] };

/** Closer to the last one than this, a buzz is dropped, so several at once (two goals reached together) are felt as one. */
export const BUZZ_GAP_MS = 300;

/** What a buzz depends on, so the rule can be tested without a phone. `since` is how long ago the last one was. */
export interface BuzzWhen {
  /** The device can vibrate (canVibrate). */
  can: boolean;
  /** Not switched off in Settings. */
  on: boolean;
  /** The page is in view. */
  visible: boolean;
  /** Less motion is asked for. */
  still: boolean;
  /** The page is in Mission. */
  mission: boolean;
  since: number;
}

/** The pattern to play for `kind`, or null for none. */
export function buzzPattern(kind: BuzzKind, w: BuzzWhen): number[] | null {
  if (!w.can || !w.on || !w.visible || w.still) return null;
  if (kind !== 'tick' && !w.mission) return null;
  if (w.since < BUZZ_GAP_MS) return null;
  return BUZZ_PATTERNS[kind];
}

/**
 * Whether this device can vibrate: it has `navigator.vibrate` and a touch screen for its main pointer. (A desk's Chrome
 * has `navigator.vibrate` too, and it does nothing, so the setting is shown only on phones and tablets.)
 */
export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function' && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

const KEY = 'launchpad:vibrate';

/** On unless switched off on this device: it's about this phone's buzzer, so it isn't one of the settings every device shares. */
export function vibrateOn(): boolean {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setVibrateOn(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Storage blocked: it stays as it was.
  }
}

let last = -Infinity;

/** Vibrates for `kind` if everything above allows it. True if the device took it. */
export function buzz(kind: BuzzKind): boolean {
  if (typeof document === 'undefined') return false;
  const now = performance.now();
  const pattern = buzzPattern(kind, {
    can: canVibrate(),
    on: vibrateOn(),
    visible: document.visibilityState === 'visible',
    still: matchMedia('(prefers-reduced-motion: reduce)').matches,
    mission: document.documentElement.dataset.design === 'mission',
    since: now - last,
  });
  if (!pattern) return false;
  last = now;
  try {
    return navigator.vibrate(pattern.length === 1 ? pattern[0] : pattern);
  } catch {
    return false;
  }
}

/** The CSS animations that are a launch: Mission's ignitions (mission.css, msIgnite). */
const LAUNCHES = new Set(['msIgnite']);

/**
 * Buzzes for a launch as each of Mission's ignitions starts: a countdown, a savings goal or an account's goal lifting
 * off, the study timer igniting, a Minecraft server coming up. They're all `msIgnite`, played only in Mission, only with
 * motion, and only at their moment (after any delay), so the buzz lands with what you see. One listener for the whole
 * app (App.tsx). Home's launch is drawn, not animated in CSS, so the scene buzzes for it itself (Scene.tsx).
 */
export function buzzLaunches(doc: Document = document): () => void {
  const on = (e: AnimationEvent) => {
    if (LAUNCHES.has(e.animationName)) buzz('launch');
  };
  doc.addEventListener('animationstart', on);
  return () => doc.removeEventListener('animationstart', on);
}
