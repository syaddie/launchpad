import { useState, type FormEvent } from 'react';
import { ampm, fmtClock, fmtNacDay, fmtRange, fmtWatch, hhmm, toMin, type SlotRow } from '../../../../shared/nac';
import type { NacStatus, NacWatch } from '../../../../shared/types';

/** What a row in the day's times needs to watch its slots (SlotFinder.tsx). */
export interface WatchProps {
  date: string;
  /** Minutes since midnight when the day is today (blocks that have ended can't be watched), else null. */
  fromMin: number | null;
  watches: NacWatch[];
  alerts: NacStatus['watch_alerts'];
  busy: boolean;
  now: Date;
  onAdd: (w: { place: string; date: string; start: string; end: string }) => Promise<boolean>;
  onRemove: (id: string) => void;
}

/** Whether a watch reaches the phone, in words, or '' when it does. */
export const alertsNote = (a: NacStatus['watch_alerts']) =>
  a === 'no-topic' ? 'Phone alerts aren’t set up yet, so a watch can’t reach you: set them up in Settings › Alerts.' : a === 'off' ? 'Busking slot alerts are off in Settings › Alerts, so a watch won’t reach your phone.' : '';

/** The 1-hour blocks a slot can start and end on, from the location's hours. */
function blocks(row: SlotRow, fromMin: number | null) {
  const open = toMin(row.open);
  const close = toMin(row.close);
  const out: { start: string; end: string }[] = [];
  for (let m = open; m < close; m += 60) if (fromMin === null || Math.min(m + 60, close) > fromMin) out.push({ start: hhmm(m), end: hhmm(Math.min(m + 60, close)) });
  return out;
}

/**
 * Tell me when … frees up: a slot at this location on this day, picked from its hours, with the
 * times booked by others (and the whole day) as quick picks. A cancellation, or the day opening
 * for booking, goes to the phone once (server/src/nac.ts alertWatches).
 */
export function WatchForm({ row, w, onClose }: { row: SlotRow; w: WatchProps; onClose: () => void }) {
  const all = blocks(row, w.fromMin);
  const whole = all.length ? { start: all[0].start, end: all[all.length - 1].end } : null;
  const picks = [...(whole ? [{ label: 'Any time', ...whole }] : []), ...row.taken.map((t) => ({ label: fmtRange(t), start: t.start, end: t.end }))];
  const first = row.taken[0] ?? whole;
  const [start, setStart] = useState(first?.start ?? '');
  const [end, setEnd] = useState(first?.end ?? '');
  const note = alertsNote(w.alerts);
  if (!whole) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (toMin(start) >= toMin(end)) return;
    void w.onAdd({ place: row.key, date: w.date, start, end }).then((ok) => ok && onClose());
  };
  const ends = all.filter((b) => toMin(b.end) > toMin(start));
  return (
    <form className="nac-watch-form" onSubmit={submit} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onClose())} aria-label={`Watch a slot at ${row.short}, ${fmtNacDay(w.date)}`}>
      <span className="nac-watch-picks" role="group" aria-label="Quick picks">
        {picks.map((p) => (
          <button
            key={p.label}
            type="button"
            className={'btn btn-small nac-watch-pick' + (p.start === start && p.end === end ? ' on' : '')}
            aria-pressed={p.start === start && p.end === end}
            onClick={() => {
              setStart(p.start);
              setEnd(p.end);
            }}
          >
            {p.label}
          </button>
        ))}
      </span>
      <span className="nac-watch-when">
        <span>Tell me when</span>
        <select
          className="input sm"
          aria-label="From"
          value={start}
          onChange={(e) => {
            setStart(e.target.value);
            if (toMin(end) <= toMin(e.target.value)) setEnd(all.find((b) => b.start === e.target.value)!.end);
          }}
        >
          {all.map((b) => (
            <option key={b.start} value={b.start}>
              {ampm(b.start)}
            </option>
          ))}
        </select>
        <span>to</span>
        <select className="input sm" aria-label="To" value={end} onChange={(e) => setEnd(e.target.value)}>
          {ends.map((b) => (
            <option key={b.end} value={b.end}>
              {ampm(b.end)}
            </option>
          ))}
        </select>
        <span>frees up</span>
      </span>
      <span className="nac-place-btns">
        <button className="btn btn-primary btn-small" disabled={w.busy}>
          <i className={'ph-duotone ' + (w.busy ? 'ph-circle-notch spin' : 'ph-bell-ringing')} aria-hidden="true" />
          Watch
        </button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>
          Cancel
        </button>
      </span>
      {note && <p className="meta nac-watch-note">{note}</p>}
    </form>
  );
}

/** The slots watched at one location on one day, under its row: watching, or freed up and when. */
export function WatchLines({ row, w }: { row: SlotRow; w: WatchProps }) {
  return (
    <span className="nac-watch-lines">
      {w.watches.map((x) => (
        <span key={x.id} className={'nac-watch' + (x.freed ? ' freed' : '')}>
          <i className={'ph-duotone ' + (x.freed ? 'ph-check-circle' : 'ph-bell-ringing')} aria-hidden="true" />
          {x.freed ? (
            <span>
              {x.found.map(fmtRange).join(', ')} freed up at {fmtClock(x.freed, w.now)}.{' '}
              <a className="btn-link" href={row.url} target="_blank" rel="noopener noreferrer">
                Book it on NAC
              </a>
            </span>
          ) : (
            <span>Watching {fmtWatch(x, row.open, row.close)}</span>
          )}
          <button type="button" className="icon-btn nac-watch-x" title={x.freed ? 'Clear' : 'Stop watching'} aria-label={`${x.freed ? 'Clear' : 'Stop watching'} ${fmtWatch(x)} at ${row.short}`} onClick={() => w.onRemove(x.id)}>
            <i className="ph-duotone ph-x" />
          </button>
        </span>
      ))}
    </span>
  );
}

/**
 * Every slot watched, soonest first, above the calendar: what's watched where, and any that
 * have freed up. Picking one shows its day.
 */
export function WatchList({ s, now, onPick, onRemove }: { s: NacStatus; now: Date; onPick: (date: string) => void; onRemove: (id: string) => void }) {
  const byKey = new Map(s.watching.map((p) => [p.key, p]));
  const loc = new Map(s.locations.map((l) => [l.key, l]));
  const list = [...s.watches].sort((a, b) => (a.freed ? 0 : 1) - (b.freed ? 0 : 1) || a.date.localeCompare(b.date) || a.start.localeCompare(b.start));
  if (!list.length) return null;
  const note = alertsNote(s.watch_alerts);
  const watching = list.filter((x) => !x.freed).length;
  return (
    <section className="nac-watches" aria-label="Watched slots">
      <h3 className="nac-watches-title">
        <i className="ph-duotone ph-bell-ringing" aria-hidden="true" />
        {watching ? `Watching ${watching} slot${watching === 1 ? '' : 's'}` : 'Watched slots'}
      </h3>
      <ul className="nac-watch-list">
        {list.map((x) => {
          const p = byKey.get(x.place);
          const l = loc.get(x.place);
          return (
            <li key={x.id} className={'nac-watch' + (x.freed ? ' freed' : '')}>
              {x.freed && <i className="ph-duotone ph-check-circle" aria-hidden="true" />}
              <button type="button" className="btn-link nac-watch-go" onClick={() => onPick(x.date)}>
                {p?.short ?? x.place} · {fmtNacDay(x.date)} · {x.freed ? x.found.map(fmtRange).join(', ') : fmtWatch(x, l?.open, l?.close)}
              </button>
              {x.freed && (
                <span className="nac-watch-freed">
                  freed up at {fmtClock(x.freed, now)}.{' '}
                  <a className="btn-link" href={p?.url} target="_blank" rel="noopener noreferrer">
                    Book it
                  </a>
                </span>
              )}
              <button type="button" className="icon-btn nac-watch-x" title={x.freed ? 'Clear' : 'Stop watching'} aria-label={`${x.freed ? 'Clear' : 'Stop watching'} ${p?.short ?? ''} ${fmtNacDay(x.date)}`} onClick={() => onRemove(x.id)}>
                <i className="ph-duotone ph-x" />
              </button>
            </li>
          );
        })}
      </ul>
      {note && watching > 0 && <p className="meta nac-watch-note">{note}</p>}
    </section>
  );
}
