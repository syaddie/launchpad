import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { addDaysYmd, calendarWeeks, DOW3, fmtNacDay, freeHours, MONTH_NAMES, monthsLabel, type SlotDay, type SlotView } from '../../../../shared/nac';

/** Monday first, as the weeks are laid out. */
const HEAD = [1, 2, 3, 4, 5, 6, 0].map((d) => DOW3[d]);
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The day to show first: the first with something free, or the first there is. */
const firstPick = (days: SlotDay[]) => (days.find((d) => d.rows.some((r) => r.kind === 'open')) ?? days[0])?.date ?? '';

/** What a day holds, for a screen reader: the cell itself only shows codes. */
function dayLabel(d: SlotDay, rel: string): string {
  const open = d.rows.filter((r) => r.kind === 'open');
  const mine = d.rows.filter((r) => r.mine.length);
  const parts: string[] = [];
  if (open.length) parts.push(`free at ${list(open.map((r) => `${r.short} for ${freeHours(r.free)} hours${r.free.some((w) => w.new) ? ', new' : ''}`))}`);
  if (mine.length) parts.push(`yours at ${list(mine.map((r) => r.short))}`);
  if (!parts.length) parts.push(d.rows.every((r) => r.kind === 'unknown') ? 'not known yet' : 'nothing free');
  return `${rel ? `${rel}, ` : ''}${fmtNacDay(d.date)}: ${parts.join('; ')}`;
}

/**
 * Music › Busking slots as a month calendar, Monday first: each day lists the locations with
 * free time (code and hours) and your own bookings (★), and picking a day shows its times in
 * `detail` beside or below. Days before today and past the last one known are greyed out.
 *
 * `scan` carries a check's motion (Mission, mission.css MUSIC): `searching` while one asked for runs, a line sweeps
 * the calendar; `found` while its result comes in (periodMotion.ts), the free windows lighting as the line finds them.
 */
export function SlotCalendar({
  view,
  today,
  codes,
  places,
  watched,
  pinged,
  scan,
  jump,
  mine = true,
  detail,
}: {
  view: SlotView;
  today: string;
  codes: Record<string, string>;
  places: { key: string; short: string }[];
  /** Days with a slot being watched, for a bell by the date. */
  watched?: Set<string>;
  /** Days where a watched slot has just freed up, pinged once. */
  pinged?: Set<string>;
  scan?: { ref: RefObject<HTMLDivElement | null>; found: boolean; searching: boolean };
  /** A day to show, picked elsewhere (the list of watched slots); n changes each time. */
  jump?: { date: string; n: number } | null;
  /** Bookings can be yours (NAC_BUSKER_ID is set, and this isn't the Music-only page), so the legend says what ★ means. */
  mine?: boolean;
  detail: (day: SlotDay) => ReactNode;
}) {
  const byDate = useMemo(() => new Map(view.days.map((d) => [d.date, d])), [view.days]);
  const [sel, setSel] = useState(() => firstPick(view.days));
  // New data that no longer has the picked day (it's over, or the list changed): back to the first.
  const picked = byDate.get(sel) ?? byDate.get(firstPick(view.days));
  const grid = useRef<HTMLDivElement>(null);
  const shown = useRef<HTMLDivElement>(null);
  const moved = useRef<'key' | 'click' | null>(null);

  const first = view.days[0]?.date ?? today;
  const last = view.lastDate && view.lastDate > first ? view.lastDate : first;
  const weeks = useMemo(() => calendarWeeks(first, last), [first, last]);

  useEffect(() => {
    if (!moved.current || !picked) return;
    if (moved.current === 'key') grid.current?.querySelector<HTMLElement>(`[data-date="${picked.date}"]`)?.focus();
    // On a phone the day's times are under the calendar: bring them up if they're off screen.
    else shown.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    moved.current = null;
  }, [picked]);

  const pick = (date: string, how: 'key' | 'click') => {
    if (!byDate.has(date)) return false;
    moved.current = how;
    setSel(date);
    return true;
  };

  useEffect(() => {
    if (jump) pick(jump.date, 'click');
    // Only when a day is picked from outside, not when the data changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump]);

  const onKey = (e: KeyboardEvent) => {
    if (!picked) return;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    let to = '';
    if (step) to = addDaysYmd(picked.date, step);
    else if (e.key === 'Home') to = view.days[0].date;
    else if (e.key === 'End') to = view.days[view.days.length - 1].date;
    else return;
    e.preventDefault();
    pick(to, 'key');
  };

  return (
    <div className="nac-cal-wrap">
      <div className="nac-cal-split">
        <div ref={scan?.ref} className="nac-cal-main lp-scan" data-found={scan?.found ? '' : undefined} data-searching={scan?.searching ? '' : undefined}>
          <h3 className="nac-cal-title">{monthsLabel(first, last)}</h3>
          <div className="nac-cal lp-scan-grid" role="grid" aria-label="Busking slots by day" ref={grid} onKeyDown={onKey}>
            {scan?.searching && (
              <span className="nac-hunt" aria-hidden="true">
                <i />
              </span>
            )}
            <div className="nac-cal-row nac-cal-head" role="row">
              {HEAD.map((d, i) => (
                <span key={d} className={'nac-cal-dow' + (i > 4 ? ' wkend' : '')} role="columnheader" aria-label={d}>
                  <span className="full">{d}</span>
                  <span className="one" aria-hidden="true">
                    {d[0]}
                  </span>
                </span>
              ))}
            </div>
            {weeks.map((w) => (
              <div key={w[0]} className="nac-cal-row" role="row">
                {w.map((date) => (
                  <Cell key={date} date={date} day={byDate.get(date)} today={today} first={date === weeks[0][0]} on={picked?.date === date} watched={!!watched?.has(date)} ping={!!pinged?.has(date)} codes={codes} onPick={() => pick(date, 'click')} />
                ))}
              </div>
            ))}
          </div>
          <Legend codes={codes} places={places} mine={mine} />
        </div>
        <div className="nac-cal-detail" ref={shown} aria-live="polite">
          {picked && detail(picked)}
        </div>
      </div>
    </div>
  );
}

function Cell({ date, day, today, first, on, watched, ping, codes, onPick }: { date: string; day: SlotDay | undefined; today: string; first: boolean; on: boolean; watched: boolean; ping: boolean; codes: Record<string, string>; onPick: () => void }) {
  const n = Number(date.slice(8, 10));
  // The month goes by the 1st, and by the first day of all, so each month is named once.
  const num = (
    <span className="nac-cell-num">
      {n}
      {(n === 1 || first) && <span className="nac-cell-mon"> {MONTH_NAMES[Number(date.slice(5, 7)) - 1].slice(0, 3)}</span>}
    </span>
  );
  const cls = 'nac-cell' + (date === today ? ' today' : '');
  if (!day) {
    return (
      <div className={cls + ' out'} role="gridcell" aria-disabled="true">
        {num}
      </div>
    );
  }
  const rel = date === today ? 'Today' : date === addDaysYmd(today, 1) ? 'Tomorrow' : '';
  const chips = day.rows.filter((r) => r.kind === 'open' || r.mine.length);
  const none = !chips.length;
  return (
    <div className="nac-cell-at lp-scan-cell" role="gridcell" aria-selected={on}>
      <button type="button" className={cls + (on ? ' on' : '') + (none ? ' none' : '')} data-date={date} data-ping={ping ? '' : undefined} tabIndex={on ? 0 : -1} onClick={onPick} aria-label={dayLabel(day, rel) + (watched ? '; a slot is watched' : '')}>
        <span className="nac-cell-top">
          {num}
          {/* A watched slot here has just freed up: a beacon by the date (Mission). */}
          {ping && <i className="nac-cell-ping" aria-hidden="true" />}
          {/* Cells too narrow for "★PLQ" put the star by the date instead (styles.css). */}
          {chips.some((r) => r.mine.length) && (
            <span className="nac-cell-star" aria-hidden="true">
              ★
            </span>
          )}
          {watched && <i className="ph-duotone ph-bell-ringing nac-cell-bell" aria-hidden="true" />}
        </span>
        <span className="nac-chips" aria-hidden="true">
          {chips.map((r) => (
            <span key={r.key} className={'nac-chip' + (r.kind === 'open' ? '' : ' mine-only') + (r.free.some((w) => w.new) ? ' new' : '')}>
              {r.mine.length > 0 && <span className="nac-chip-star">★</span>}
              <b>{codes[r.key] ?? r.short.slice(0, 3)}</b>
              {r.kind === 'open' && <span className="nac-chip-h tnum">{freeHours(r.free)}h</span>}
            </span>
          ))}
          {none && <span className="nac-cell-note">{day.rows.every((r) => r.kind === 'unknown') ? '?' : 'Full'}</span>}
        </span>
      </button>
    </div>
  );
}

/** Which code is which location, and what the marks mean. */
function Legend({ codes, places, mine }: { codes: Record<string, string>; places: { key: string; short: string }[]; mine: boolean }) {
  return (
    <div className="nac-legend meta">
      <span className="nac-legend-places">
        {places.map((p) => (
          <span key={p.key} className="nac-legend-item">
            <b className="nac-code">{codes[p.key]}</b> {p.short}
          </span>
        ))}
      </span>
      <span className="nac-legend-marks">
        <span className="nac-legend-item">
          <span className="nac-chip sample" aria-hidden="true">
            <span className="nac-chip-h tnum">3h</span>
          </span>{' '}
          hours free
        </span>
        {mine && <span className="nac-legend-item">★ yours</span>}
        <span className="nac-legend-item">
          <span className="nac-new-dot" aria-hidden="true" /> new since the check before
        </span>
        <span className="nac-legend-item">? not known yet</span>
      </span>
    </div>
  );
}
