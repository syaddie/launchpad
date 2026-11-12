import { useCallback, useEffect, useMemo, useRef } from 'react';

/**
 * Debounced saver for whole-document PUTs, flushed when the tab closes. Saves go one at a
 * time, so each starts from the version the last one made. `save` resolves to a value when
 * that should be saved next instead (a merge after another device saved first).
 */
export function useSaver<T>(save: (v: T, opts: { keepalive: boolean; unchecked: boolean }) => Promise<T | void>, delay: number, onSaved?: () => void, onError?: (e: Error) => void) {
  const timer = useRef(0);
  const latest = useRef<T | null>(null);
  const inflight = useRef(0);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback(
    function flush(keepalive = false) {
      clearTimeout(timer.current);
      const v = latest.current;
      if (v === null) return;
      latest.current = null;
      // The tab is closing and can't wait its turn: send now, without the version check.
      if (keepalive && inflight.current) {
        save(v, { keepalive, unchecked: true }).catch(() => {});
        return;
      }
      inflight.current++;
      chain.current = chain.current
        .then(() => save(v, { keepalive, unchecked: false }))
        .then((again) => {
          if (again === undefined) return onSaved?.();
          latest.current = again;
          flush();
        })
        .catch((e) => onError?.(e))
        .finally(() => inflight.current--);
    },
    [save, onSaved, onError],
  );
  const schedule = useCallback(
    (v: T) => {
      latest.current = v;
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => flush(), delay);
    },
    [delay, flush],
  );
  useEffect(() => {
    const h = () => flush(true);
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  }, [flush]);
  const busy = useCallback(() => latest.current !== null || inflight.current > 0, []);
  return useMemo(() => ({ schedule, busy }), [schedule, busy]);
}

export type Saver<T> = ReturnType<typeof useSaver<T>>;
