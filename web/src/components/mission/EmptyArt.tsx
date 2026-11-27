// Mission's three empty-state drawings (docs/mission-layout.md), a small line drawing of the launch site over an empty
// state's words: put one first in the state, `<EmptyArt kind="clear" />`. Only Mission shows them (mission.css, EMPTY
// STATES); the other layouts keep their plain words.
import { Vehicle } from './Mark';

/**
 * - `clear`: pad clear. Nothing to do: nothing due, an empty trash or inbox, nothing found.
 * - `away`: vehicle away. What isn't set up yet: Google, SSH, the API key, a source switched off.
 * - `scrubbed`: launch scrubbed. What failed to load, and a view that hit a problem.
 */
export type EmptyKind = 'clear' | 'away' | 'scrubbed';

const TOWER = 'M34 54 V14 M40 54 V14 M33 14 H41 M34 22 H40 M34 30 H40 M34 38 H40 M34 46 H40 M34 22 L40 30 M40 22 L34 30 M34 38 L40 46 M40 38 L34 46 M40 26 H51 M40 42 H51';

/** Nothing (no drawing) for `null` or `false`, so a state that's only sometimes empty can pass its condition. */
export function EmptyArt({ kind }: { kind: EmptyKind | null | false | undefined }) {
  if (!kind) return null;
  return (
    <svg className={'ms-empty-art ms-empty-art--' + kind} viewBox="0 0 120 60" aria-hidden="true" focusable="false">
      {kind === 'clear' && (
        <>
          <circle className="ms-ea-star" cx={78} cy={10} r={1} />
          <circle className="ms-ea-star" cx={102} cy={18} r={0.8} />
          <circle className="ms-ea-star" cx={16} cy={14} r={0.8} />
          <circle className="ms-ea-star" cx={64} cy={22} r={0.7} />
        </>
      )}
      <path className="ms-ea-line ms-ea-ground" d="M3 54 H117" />
      <path className="ms-ea-line" d="M46 54 V51 H74 V54" />
      <path className="ms-ea-line ms-ea-thin" d={TOWER} />
      <path className="ms-ea-line ms-ea-thin" d="M93 54 V22" />
      <circle className="ms-lamp" cx={93} cy={20} r={1.7} />
      {kind === 'away' && (
        // Where the vehicle will stand, once it's rolled out: its outline, dashed.
        <g className="ms-ea-ghost" transform="translate(60 51) scale(0.2) translate(-128 -192)">
          <Vehicle />
        </g>
      )}
      {kind === 'scrubbed' && (
        <>
          {/* On the pad with its engine out, venting, and the poll's scrub mark beside it. */}
          <g className="ms-ea-vehicle" transform="translate(60 51) scale(0.2) translate(-128 -192)">
            <Vehicle />
          </g>
          <path className="ms-ea-line ms-ea-thin ms-ea-vent" d="M69 47 q5 -2 8 1 q4 3 9 0" />
          <rect className="ms-ea-scrub" x={81} y={27} width={8} height={8} rx={1.2} transform="rotate(45 85 31)" />
        </>
      )}
    </svg>
  );
}
