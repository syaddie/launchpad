import { useEffect, useState } from 'react';
import { countText } from '../../mission';

/**
 * Mission's count to a start, in the launch clock's dot-matrix face: T-3, T-2, T-1 from `at` (when it was asked for),
 * then T+ as it runs (countText in mission.ts). Each figure relights as it changes, as the clock's do. It ticks only
 * while it's shown; the words beside it say the same thing plainly, so it's hidden from screen readers. The other
 * layouts hide it (mission.css shows `.ms-count`).
 */
export function LaunchCount({ at }: { at: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, []);
  const text = countText(now - at);
  return (
    <span className="ms-matrix ms-count" data-ghost={text.replace(/\d/g, '8')} aria-hidden="true">
      <span key={text} className="ms-cell">
        {text}
      </span>
    </span>
  );
}
