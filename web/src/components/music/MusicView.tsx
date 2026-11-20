import { SlotFinder } from './SlotFinder';

/**
 * The Music view, the whole screen like the other views. Busking slots is its only panel for
 * now; others go beside it in a `.you-row`, or below it, the way You and Training lay theirs out.
 */
export function MusicView({ now }: { now: Date }) {
  return (
    <main className="you music" aria-label="Music">
      <SlotFinder now={now} />
    </main>
  );
}
