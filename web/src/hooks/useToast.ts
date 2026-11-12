import { useCallback, useRef, useState } from 'react';

export type ToastAction = { label: string; run: () => void };
export type Notify = (msg: string, action?: ToastAction) => void;

/** One message at a time at the bottom of the page; one with an action (Undo) stays longer. */
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; action?: ToastAction } | null>(null);
  const timer = useRef(0);
  const showToast: Notify = useCallback((msg, action) => {
    setToast({ msg, action });
    clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), action ? 6000 : 4000);
  }, []);
  const hideToast = useCallback(() => setToast(null), []);
  return { toast, showToast, hideToast };
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
