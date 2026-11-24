// Mission's mark: the vehicle on the night pad with its engine lit (docs/mission-layout.md; the design system's Logo
// card has the geometry in words). Drawn inline so its flame lives; the files in public/ are for outside the app.

/** The vehicle in a 256 box. The nose is a parabola; the right half is in shadow; a blue band and a porthole. */
const FULL = {
  body: 'M128 26 Q161 62 161 108 L161 170 L95 170 L95 108 Q95 62 128 26 Z',
  shade: 'M128 26 Q161 62 161 108 L161 170 L128 170 Z',
  finR: 'M161 124 L194 172 L194 192 L161 170 Z',
  finL: 'M95 124 L62 172 L62 192 L95 170 Z',
  band: [95, 134, 66, 11],
  port: [128, 100, 12] as number[] | null,
  flame: 'M106 178 L150 178 Q148 210 128 236 Q108 210 106 178 Z',
  core: 'M117 178 L139 178 Q138 198 128 214 Q118 198 117 178 Z',
  rail: 'M50 244 H206',
  railW: 8,
};
/** 36px and below: no porthole, a fuller body and fins, a deeper band, or the parts merge. */
const SMALL: typeof FULL = {
  body: 'M128 22 Q168 60 168 110 L168 168 L88 168 L88 110 Q88 60 128 22 Z',
  shade: 'M128 22 Q168 60 168 110 L168 168 L128 168 Z',
  finR: 'M168 116 L206 170 L206 194 L168 168 Z',
  finL: 'M88 116 L50 170 L50 194 L88 168 Z',
  band: [88, 128, 80, 16],
  port: null,
  flame: 'M100 178 L156 178 Q154 212 128 240 Q102 212 100 178 Z',
  core: 'M114 178 L142 178 Q141 200 128 218 Q115 200 114 178 Z',
  rail: 'M44 248 H212',
  railW: 14,
};

/** The vehicle and its flame, as SVG to put inside any drawing (the mark, the pad, the ascent). */
export function Vehicle({ small }: { small?: boolean }) {
  const g = small ? SMALL : FULL;
  return (
    <>
      <g className="ms-flames">
        <path className="ms-flame" d={g.flame} />
        <path className="ms-flame-core" d={g.core} />
      </g>
      <g className="ms-vehicle">
        <path className="ms-fin" d={g.finL} />
        <path className="ms-fin" d={g.finR} />
        <path className="ms-hull" d={g.body} />
        <path className="ms-hull-shade" d={g.shade} />
        <rect className="ms-band" x={g.band[0]} y={g.band[1]} width={g.band[2]} height={g.band[3]} />
        {g.port && <circle className="ms-port" cx={g.port[0]} cy={g.port[1]} r={g.port[2]} />}
      </g>
    </>
  );
}

/**
 * The mark on its tile. `liftoff` is a count: each time it goes up, the vehicle leaves out of the top of the tile
 * and the next one rolls up from below (mission.css).
 */
export function Mark({ small, liftoff = 0 }: { small?: boolean; liftoff?: number }) {
  const g = small ? SMALL : FULL;
  return (
    <span className="ms-tile">
      {/* Keyed by the count, so the animation plays again for each launch. */}
      <svg key={liftoff} className={'ms-logo' + (liftoff ? ' ms-logo--liftoff' : '')} viewBox="0 0 256 256" aria-hidden="true">
        <path className="ms-railline" d={g.rail} strokeWidth={g.railW} />
        <Vehicle small={small} />
      </svg>
    </span>
  );
}
