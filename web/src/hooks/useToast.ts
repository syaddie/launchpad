import { useCallback, useRef, useState } from 'react';

export type ToastAction = { label: string; run: () => void };
export type Notify = (msg: string, action?: ToastAction) => void;
/** A message at the bottom of the page; `id` is new for each one, so each animates in afresh. `life` is how long it stays, in ms. */
export type Toast = { id: number; msg: string; action?: ToastAction; life: number };

/**
 * One message at a time at the bottom of the page; one with an action (Undo) stays longer. While
 * pointed at (`holdToast(true)`), it stays, and goes after the time it had left once the pointer leaves.
 */
export function useToast() {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef(0);
  const count = useRef(0);
  const endsAt = useRef(0);
  const left = useRef<number | null>(null);
  const showToast: Notify = useCallback((msg, action) => {
    const life = action ? 6000 : 4000;
    count.current += 1;
    setToast({ id: count.current, msg, action, life });
    clearTimeout(timer.current);
    left.current = null;
    endsAt.current = Date.now() + life;
    timer.current = window.setTimeout(() => setToast(null), life);
  }, []);
  const hideToast = useCallback(() => {
    clearTimeout(timer.current);
    left.current = null;
    setToast(null);
  }, []);
  const holdToast = useCallback((hold: boolean) => {
    if (hold) {
      if (left.current !== null) return;
      clearTimeout(timer.current);
      left.current = Math.max(0, endsAt.current - Date.now());
    } else if (left.current !== null) {
      const rest = Math.max(400, left.current);
      left.current = null;
      endsAt.current = Date.now() + rest;
      timer.current = window.setTimeout(() => setToast(null), rest);
    }
  }, []);
  return { toast, showToast, hideToast, holdToast };
}

/** A "Saved" mark that shows for a moment after each save. */
export function useFlash(ms = 1500) {
  const [on, setOn] = useState(false);
  const timer = useRef(0);
  const flash = useCallback(() => {
    setOn(true);
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setOn(false), ms);
  }, [ms]);
  return [on, flash, setOn] as const;
}
