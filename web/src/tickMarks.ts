/** How long a box stays marked after it's ticked: long enough for its tick to land and its light to fade. */
export const TICK_MARK_MS = 2000;

/**
 * Marks a box ticked by hand. A `.check` clicked (or the one inside the row or label clicked) while it isn't ticked is
 * marked `data-ticked` for a moment; clicked while it is, the mark comes off. So a design can make a tick land with
 * some light only when it's ticked (Mission's flare, mission.css), not whenever a box already ticked comes into view:
 * the app opening, another notepad, another view. One listener for the whole app (App.tsx), ahead of every click
 * handler, so each box is marked before its own handler ticks it. Returns the way to take it off.
 */
export function markTicks(doc: Document = document): () => void {
  const timers = new WeakMap<HTMLElement, number>();
  const mark = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    const box = t?.closest<HTMLElement>('.check') ?? t?.closest('button, label')?.querySelector<HTMLElement>('.check');
    if (!box) return;
    window.clearTimeout(timers.get(box));
    if (box.classList.contains('on')) {
      delete box.dataset.ticked;
      return;
    }
    box.dataset.ticked = '';
    // Off again once the tick has landed, so the same element showing another box later (a list drawn again) isn't
    // taken for one just ticked.
    timers.set(
      box,
      window.setTimeout(() => delete box.dataset.ticked, TICK_MARK_MS),
    );
  };
  doc.addEventListener('click', mark, true);
  return () => doc.removeEventListener('click', mark, true);
}
