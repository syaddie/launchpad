import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';
import { fmtMoney, type MonthCalc, monthName } from '../../../../shared/money';
import { niceMax } from '../../util';
import { shortDate } from './shared';
import { Vehicle } from '../mission/Mark';

/** Axis labels: "$4k", "$1.5k", "−$500". */
function fmtAxis(v: number): string {
  const a = Math.abs(v);
  const s = a >= 1000 ? `$${+(a / 1000).toFixed(1)}k` : `$${Math.round(a)}`;
  return v < 0 ? '−' + s : s;
}

/** Even steps that land on $0, so a dip below zero shows against a labelled zero line. */
function axis(lo: number, hi: number): { top: number; bottom: number; ticks: number[] } {
  const step = Math.max(50, lo < 0 ? niceMax((hi - lo) / 3) : niceMax(hi) / 2);
  const top = Math.max(step, Math.ceil(hi / step) * step);
  const bottom = Math.floor(lo / step) * step;
  return { top, bottom, ticks: Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, i) => top - i * step) };
}

function YAxis({ ticks }: { ticks: number[] }) {
  return (
    <>
      <div className="sc-grid">
        {ticks.map((t) => (
          <span key={t} />
        ))}
      </div>
      <div className="sc-y tnum">
        {ticks.map((t) => (
          <span key={t}>{fmtAxis(t)}</span>
        ))}
      </div>
    </>
  );
}

function MonthAxis({ months, weights }: { months: MonthCalc[]; weights: number[] }) {
  return (
    <div className="sc-x" style={{ gridTemplateColumns: weights.map((w) => `minmax(0, ${w}fr)`).join(' ') }}>
      {months.map((m) => (
        <span key={m.key} className="bal-label">
          {months.length > 3 ? monthName(m.key, true) : monthName(m.key).replace(/ \d+$/, '')}
        </span>
      ))}
    </div>
  );
}

/** How many days either side of today the vehicle's heading is taken over, so one big day doesn't tip it over. */
const HEADING_DAYS = 3;
/** The steepest it climbs or dives, in degrees from level. */
const HEADING_MAX = 40;

/**
 * The end-of-day balance across every month: solid up to today, dashed for the forecast. In Mission it's flown like Home's
 * ascent: solid behind, dotted ahead, with the vehicle at today heading the way the balance goes (mission.css).
 */
export function BalanceChart({ months, today }: { months: MonthCalc[]; today: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const pts = months.flatMap((m) => m.balances.map((b, d) => ({ b, date: `${m.key}-${String(d + 1).padStart(2, '0')}` })));
  const n = pts.length;
  const { top, bottom, ticks } = axis(Math.min(0, ...pts.map((p) => p.b)), Math.max(0, ...pts.map((p) => p.b)));
  const y = (v: number) => ((top - v) / (top - bottom || 1)) * 100;
  const x = (i: number) => (n > 1 ? (i / (n - 1)) * 1000 : 500);
  const pct = (i: number) => `${(x(i) / 1000) * 100}%`;
  const t = pts.findIndex((p) => p.date === today);
  const cut = t < 0 ? n - 1 : t;
  const line = (from: number, to: number) => pts.slice(from, to + 1).map((p, i) => `${x(from + i).toFixed(1)},${y(p.b).toFixed(2)}`).join(' ');
  const h = hover !== null ? pts[hover] : null;
  const starts = months.slice(0, -1).reduce<number[]>((a, m) => [...a, (a[a.length - 1] ?? 0) + m.balances.length], []);
  // The plot's size on the screen, for the vehicle's heading (the line itself is stretched to fit).
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setBox((b) => (b && b.w === el.clientWidth && b.h === el.clientHeight ? b : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lo = Math.max(0, t - HEADING_DAYS);
  const hi = Math.min(n - 1, t + HEADING_DAYS);
  const heading =
    t >= 0 && box && hi > lo
      ? Math.max(-HEADING_MAX, Math.min(HEADING_MAX, (Math.atan2(((y(pts[hi].b) - y(pts[lo].b)) / 100) * box.h, ((x(hi) - x(lo)) / 1000) * box.w) * 180) / Math.PI))
      : 0;

  const onMove = (e: React.PointerEvent) => {
    const r = plotRef.current?.getBoundingClientRect();
    if (!r || !n) return;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((e.clientX - r.left) / r.width) * (n - 1)))));
  };

  return (
    <section className="panel you-panel m-chart" aria-label="Balance by day">
      <div className="panel-head">
        <h2 className="panel-title">Balance by day</h2>
        <span className="legend">
          <span className="legend-line" />
          So far
          <span className="legend-dash" style={{ borderTopColor: 'var(--ac)', marginLeft: 8 }} />
          Forecast
        </span>
      </div>
      <div className="bal-chart">
        <YAxis ticks={ticks} />
        <div ref={plotRef} className="sc-plot" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {starts.map((s) => (
            <span key={s} className="bal-month" style={{ left: `${(x(s - 0.5) / 1000) * 100}%` }} />
          ))}
          {bottom < 0 && <span className="bal-zero" style={{ top: `${y(0)}%` }} />}
          {t >= 0 && (
            <span className="bal-today" style={{ left: pct(t) }}>
              <span>Today</span>
            </span>
          )}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" role="img" aria-label={`Balance from ${fmtMoney(pts[0]?.b ?? 0)} to ${fmtMoney(pts[n - 1]?.b ?? 0)}`}>
            <polyline className="bal-flown" points={line(0, cut)} fill="none" stroke="var(--ac)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            {cut < n - 1 && <polyline className="bal-ahead" points={line(cut, n - 1)} fill="none" stroke="var(--ac)" strokeWidth="2" strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
          </svg>
          {t >= 0 && (
            // Mission's vehicle at today, for the eye only: the hover's dot and the label say the same.
            <span className="bal-craft" aria-hidden="true" style={{ left: pct(t), top: `${y(pts[t].b)}%`, '--at': n > 1 ? t / (n - 1) : 0 } as CSSProperties}>
              <svg viewBox="-20 -20 40 40">
                <circle className="ms-ring" r={6} />
                <g className="ms-craft">
                  <g transform={`rotate(${Math.round(heading + 90)}) scale(0.12) translate(-128 -110)`}>
                    <Vehicle small />
                  </g>
                </g>
              </svg>
            </span>
          )}
          {h && (
            <>
              <span className="bal-cross" style={{ left: pct(hover!) }} />
              <span className="bal-dot" style={{ left: pct(hover!), top: `${y(h.b)}%`, background: h.b < 0 ? 'var(--wn)' : 'var(--ac)' }} />
              <div className="popover chart-tip" style={{ left: pct(hover!), transform: `translateX(${hover! > n / 2 ? 'calc(-100% - 12px)' : '12px'})` }}>
                <b className="tnum" style={h.b < 0 ? { color: 'var(--wn)' } : undefined}>
                  {fmtMoney(h.b)}
                </b>
                <span className="meta">
                  End of {shortDate(h.date)}
                  {h.date > today ? ' · forecast' : ''}
                </span>
              </div>
            </>
          )}
        </div>
        <MonthAxis months={months} weights={months.map((m) => m.balances.length)} />
      </div>
    </section>
  );
}

export function InOutChart({ months }: { months: MonthCalc[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const { top, ticks } = axis(0, Math.max(0, ...months.flatMap((m) => [m.totalIn, m.totalOut])));
  const bar = (total: number, planned: number, color: string) => (
    <span className="io-bar" style={{ height: `${(total / top) * 100}%` }}>
      <span style={{ flex: planned, background: color, opacity: 0.4 }} />
      <span style={{ flex: total - planned, background: color }} />
    </span>
  );
  return (
    <section className="panel you-panel m-chart io" aria-label="Money in and out">
      <div className="panel-head">
        <h2 className="panel-title">In and out</h2>
        <span className="legend">
          <span className="legend-swatch" style={{ background: 'var(--ac)' }} />
          In
          <span className="legend-swatch" style={{ background: 'var(--t3)', marginLeft: 8 }} />
          Out
          <span className="legend-swatch" style={{ background: 'var(--t3)', opacity: 0.4, marginLeft: 8 }} />
          Planned
        </span>
      </div>
      <div className="bal-chart">
        <YAxis ticks={ticks} />
        <div className="sc-plot io-plot" onPointerLeave={() => setHover(null)}>
          {months.map((m, i) => (
            <div
              key={m.key}
              className={'io-col' + (hover === i ? ' on' : '')}
              onPointerEnter={() => setHover(i)}
              tabIndex={0}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
              aria-label={`${monthName(m.key)}: in ${fmtMoney(m.totalIn)}, out ${fmtMoney(m.totalOut)}`}
            >
              {bar(m.totalIn, m.plannedIn, 'var(--ac)')}
              {bar(m.totalOut, m.plannedOut, 'var(--t3)')}
              {hover === i && (
                <div className={'popover chart-tip' + (i >= months.length / 2 && months.length > 1 ? ' left' : '')}>
                  <span className="meta">{monthName(m.key)}</span>
                  <span className="tnum">
                    <span className="legend-line" /> In <b>{fmtMoney(m.totalIn)}</b>
                    {m.plannedIn > 0 && <span className="meta"> · {fmtMoney(m.plannedIn)} planned</span>}
                  </span>
                  <span className="tnum">
                    <span className="legend-line" style={{ background: 'var(--t3)' }} /> Out <b>{fmtMoney(m.totalOut)}</b>
                    {m.plannedOut > 0 && <span className="meta"> · {fmtMoney(m.plannedOut)} planned</span>}
                  </span>
                  <span className="tnum">
                    Net <b style={m.net < 0 ? { color: 'var(--wn)' } : undefined}>{fmtMoney(m.net, true)}</b>
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
        <MonthAxis months={months} weights={months.map(() => 1)} />
      </div>
    </section>
  );
}
