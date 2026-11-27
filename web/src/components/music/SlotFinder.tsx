import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { addDaysYmd, fmtClock, fmtNacDay, fmtRange, hoursOf, nacCodes, sgtMinutes, sgtYmd, slotView, type SlotDay, type SlotRow } from '../../../../shared/nac';
import type { NacBooked, NacFree, NacStatus } from '../../../../shared/types';
import { api, cachedNac, cacheNac } from '../../api';
import { NacPlaces } from './NacPlaces';
import { SlotCalendar } from './SlotCalendar';
import { menuProps } from '../ContextMenu';
import { rowMenu, WatchForm, WatchLines, WatchList, type WatchProps } from './SlotWatch';
import { EmptyArt } from '../mission/EmptyArt';

/** The server checks NAC every 10 minutes; this only reads what it found, so asking often costs nothing. */
const POLL = 60_000;
/** While a check is running or about to, so its result shows as soon as it's in. */
const POLL_BUSY = 3_000;
const PORTAL = 'https://eservices.nac.gov.sg/Busking';

const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** "at 23:15", "tomorrow at 00:15", "on Sat 21 Nov at 00:15". */
function atClock(iso: string, now: Date): string {
  const c = fmtClock(iso, now);
  const sp = c.lastIndexOf(' ');
  if (sp < 0) return `at ${c}`;
  const day = c.slice(0, sp);
  return `${day === 'tomorrow' || day === 'yesterday' ? day : `on ${day}`} at ${c.slice(sp + 1)}`;
}
/** The server's reason, ending in a full stop. */
const sentence = (t: string | null) => (!t ? 'no reason given.' : /[.?!]$/.test(t) ? t : `${t}.`);

/** Where the slots come from: yours (/api/nac), or the Music-only page's (/api/guest/nac, server/src/access.ts). */
export interface SlotSource {
  /** The last reading kept on this device, to open on while a fresh one loads. */
  initial: () => NacStatus | null;
  load: () => Promise<NacStatus>;
  check: () => Promise<{ at: string }>;
}

const OWN: SlotSource = {
  initial: cachedNac,
  load: () => api.nacSlots().then((r) => (cacheNac(r), r)),
  check: () => api.checkNac(),
};

/**
 * Music › Busking slots: which slots are still free at the NAC locations, from the server's last
 * check (server/src/nac.ts), as a calendar; a day's times by location beside or below it.
 * Locations opens the list of places it checks. Booking stays on the NAC portal.
 *
 * With `guest` (the Music-only page, web/src/guest.tsx), it reads from there instead and is for
 * looking only: no Locations to change and no slots to watch. Your bookings come to it as taken.
 */
export function SlotFinder({ now, notify, guest }: { now: Date; notify: (msg: string) => void; guest?: SlotSource }) {
  const source = guest ?? OWN;
  // Open on the last reading while a fresh one loads.
  const [s, setS] = useState<NacStatus | null>(source.initial);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [watchBusy, setWatchBusy] = useState(false);
  /** A day to show in the calendar, picked from the watched slots (n so picking the same one again still jumps). */
  const [jump, setJump] = useState<{ date: string; n: number } | null>(null);
  /** The check asked for here, by when the one before it was made, so its result can be told when it's in. */
  const askedAfter = useRef<string | null | undefined>(undefined);

  const load = useCallback(() => {
    source
      .load()
      .then((r) => {
        setS(r);
        setLoadError('');
      })
      .catch((e) => setLoadError((e as Error).message));
  }, [source]);

  const busy = asking || !!s?.running || !!s?.queued_at;
  useEffect(() => {
    load();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), busy ? POLL_BUSY : POLL);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, busy]);

  // The check asked for has finished: say how it went.
  useEffect(() => {
    if (!s || busy || askedAfter.current === undefined || s.checked_at === askedAfter.current) return;
    askedAfter.current = undefined;
    const free = slotView(s, new Date()).freeWindows;
    notify(s.ok ? `Checked NAC: ${plural(free, 'free window')}.` : `The check failed: ${sentence(s.error)}`);
  }, [s, busy, notify]);

  const checkNow = () => {
    if (!s || busy) return;
    if (s.can_check) return notify(s.can_check);
    setAsking(true);
    askedAfter.current = s.checked_at;
    source
      .check()
      .then((r) => setS((x) => (x ? { ...x, queued_at: r.at } : x)))
      .catch((e) => {
        askedAfter.current = undefined;
        notify((e as Error).message);
      })
      .finally(() => {
        setAsking(false);
        load();
      });
  };

  const today = sgtYmd(now);
  const view = useMemo(() => (s ? slotView(s, now) : null), [s, now]);
  const watching = list((s?.watching ?? []).map((w) => w.short));
  const codes = useMemo(() => nacCodes(s?.watching ?? []), [s?.watching]);
  const saved = (r: NacStatus) => {
    setS(r);
    cacheNac(r);
  };
  const waiting = s?.queued_at && !s.running && Date.parse(s.queued_at) > now.getTime() + 30_000 ? fmtClock(s.queued_at, now) : '';

  const addWatch = (w: { place: string; date: string; start: string; end: string }) => {
    setWatchBusy(true);
    return api
      .nacWatch(w)
      .then((r) => (saved(r), true))
      .catch((e) => (notify((e as Error).message), false))
      .finally(() => setWatchBusy(false));
  };
  const removeWatch = (id: string) =>
    api
      .nacUnwatch(id)
      .then(saved)
      .catch((e) => notify((e as Error).message));
  /** What a day's rows need to watch their slots. */
  const watchOf = (date: string): WatchProps | null =>
    s && !guest ? { date, fromMin: date === today ? sgtMinutes(now) : null, watches: (s.watches ?? []).filter((x) => x.date === date), alerts: s.watch_alerts ?? 'ok', busy: watchBusy, now, onAdd: addWatch, onRemove: removeWatch } : null;
  const watched = useMemo(() => new Set((s?.watches ?? []).filter((x) => !x.freed).map((x) => x.date)), [s?.watches]);

  return (
    <section className={'panel you-panel nac' + (s && !s.ok ? ' stale' : '')} aria-label="Busking slots">
      <div className="panel-head nac-head">
        <span className="panel-title">Busking slots</span>
        <span className="nac-when">
          {s?.fixtures && <span className="chip chip-warn">Test data</span>}
          {s && (
            <span className="meta tnum" aria-live="polite">
              {s.running || (busy && !waiting)
                ? 'Checking NAC now…'
                : waiting
                  ? `Checking at ${waiting}, once schedule-sync is done`
                  : `${s.checked_at ? `Last checked ${fmtClock(s.checked_at, now)}` : 'Not checked yet'}${s.next_check ? ` · ${s.checked_at ? 'next check' : 'first check'} ${fmtClock(s.next_check, now)}` : ''}`}
            </span>
          )}
          {s && (
            <button
              className={'btn btn-secondary btn-small nac-check' + (s.can_check && !busy ? ' off' : '')}
              disabled={busy}
              aria-disabled={busy || !!s.can_check}
              // Its name in menus too (the page-wide menu offers the header's buttons); the tooltip says more.
              aria-label={busy ? 'Checking NAC' : 'Check now'}
              title={busy ? undefined : (s.can_check ?? 'Ask NAC now instead of waiting for the next check')}
              onClick={checkNow}
            >
              <i className={'ph-duotone ph-arrows-clockwise' + (busy ? ' spin' : '')} aria-hidden="true" />
              {busy ? 'Checking…' : 'Check now'}
            </button>
          )}
          {s && !guest && (
            <button type="button" className={'btn btn-ghost btn-small nac-places-btn' + (editing ? ' on' : '')} aria-expanded={editing} onClick={() => setEditing(!editing)}>
              <i className="ph-duotone ph-map-pin" aria-hidden="true" />
              Locations
            </button>
          )}
        </span>
      </div>
      {s && editing && !guest && <NacPlaces s={s} codes={codes} now={now} onSaved={saved} onClose={() => setEditing(false)} />}

      {!s ? (
        <>
          {loadError && <EmptyArt kind="scrubbed" />}
          <p className="meta nac-empty">{loadError ? `Couldn’t load the slots: ${loadError}` : 'Loading…'}</p>
        </>
      ) : (
        <>
          {!s.ok && (
            <div className="nac-warn" role="status">
              <i className="ph-duotone ph-warning" aria-hidden="true" />
              <span>
                {s.last_good_at ? (
                  <>
                    Data is from <b className="tnum">{fmtClock(s.last_good_at, now)}</b>, NAC fetch failed: {sentence(s.error)}
                  </>
                ) : (
                  <>No slot data yet. NAC fetch failed: {sentence(s.error)}</>
                )}
                {s.failures > 1 && ` That’s ${s.failures} checks in a row, so it’s waiting longer between them.`}
                {s.next_check && <> Next try {fmtClock(s.next_check, now)}.</>}
              </span>
            </div>
          )}
          {loadError && <p className="meta nac-note-line">Couldn’t refresh: {loadError}</p>}

          {!s.watching.length ? (
            guest ? (
              <div className="nac-empty">
                <EmptyArt kind="away" />
                <p>No locations are being checked at the moment.</p>
              </div>
            ) : !editing && (
              <div className="nac-empty">
                <EmptyArt kind="away" />
                <p>No locations on the list, so nothing is checked.</p>
                <p>
                  <button type="button" className="btn btn-secondary btn-small" onClick={() => setEditing(true)}>
                    <i className="ph-duotone ph-plus" aria-hidden="true" />
                    Add a location
                  </button>
                </p>
              </div>
            )
          ) : !s.locations.length ? (
            <div className="nac-empty">
              <EmptyArt kind={s.ok ? 'away' : 'scrubbed'} />
              <p>{s.ok ? `No slot data yet. The ${s.checked_at ? 'next' : 'first'} check is ${s.next_check ? atClock(s.next_check, now) : 'within 10 minutes'}, then every 10 minutes.` : 'Nothing to show until a check works.'}</p>
              {watching && <p className="meta">Watching {watching}.</p>}
            </div>
          ) : (
            <>
              <Notes s={s} noBookings={view!.noBookings} guest={!!guest} />
              {!guest && <WatchList s={{ ...s, watches: s.watches ?? [] }} now={now} onPick={(date) => setJump((j) => ({ date, n: (j?.n ?? 0) + 1 }))} onAdd={addWatch} onRemove={removeWatch} />}
              {view!.days.length > 0 && (
                <p className="nac-sum">
                  {view!.freeWindows ? (
                    <>
                      <b>{plural(view!.freeWindows, 'free window')}</b>
                      {view!.newWindows > 0 && <>, {view!.newWindows} new</>} from now to {fmtNacDay(view!.lastDate!)}.
                    </>
                  ) : (
                    <>Nothing free at any location up to {fmtNacDay(view!.lastDate!)}.</>
                  )}{' '}
                  <span className="meta">Later days aren’t known yet: nobody has booked that far ahead.</span>
                </p>
              )}
              {view!.days.length ? (
                <SlotCalendar view={view!} today={today} codes={codes} places={s.locations} watched={watched} jump={jump} mine={s.mine_on} detail={(d) => <Day day={d} today={today} w={watchOf(d.date)} />} />
              ) : (
                <>
                  <EmptyArt kind="scrubbed" />
                  <p className="nac-empty">The last good data doesn’t reach today, so there’s nothing to show until a check works.</p>
                </>
              )}
            </>
          )}
          <p className="meta nac-foot">
            Free means no one has booked it; booking is on the{' '}
            <a className="btn-link" href={PORTAL} target="_blank" rel="noopener noreferrer">
              NAC portal
            </a>
            . NEW: free since the check before.
          </p>
        </>
      )}
    </section>
  );
}

/** What to know about the data itself: your bookings, statuses NAC hasn't used before, locations with no bookings or not checked yet. */
function Notes({ s, noBookings, guest }: { s: NacStatus; noBookings: string[]; guest: boolean }) {
  const notes: string[] = [];
  const unchecked = s.watching.filter((w) => !s.locations.some((l) => l.key === w.key)).map((w) => w.short);
  if (unchecked.length) notes.push(`${list(unchecked)} ${unchecked.length === 1 ? 'isn’t' : 'aren’t'} checked yet: ${unchecked.length === 1 ? 'its' : 'their'} slots come with the next check${s.next_check ? `, at ${fmtClock(s.next_check, new Date())}` : ''}.`);
  if (!s.mine_on && !guest) notes.push('Your own bookings show as taken: set NAC_BUSKER_ID on the server to see them as yours.');
  if (s.unknown_statuses.length) notes.push(`NAC marked some bookings ${list(s.unknown_statuses.map((x) => `“${x}”`))}, which isn’t a status known yet. They count as taken.`);
  if (noBookings.length) notes.push(`No bookings seen at ${list(noBookings)}, so which of ${noBookings.length === 1 ? 'its' : 'their'} days are open for booking isn’t known.`);
  if (!notes.length) return null;
  return (
    <ul className="nac-notes">
      {notes.map((n) => (
        <li key={n}>
          <i className="ph-duotone ph-info" aria-hidden="true" />
          {n}
        </li>
      ))}
    </ul>
  );
}

function Day({ day, today, w }: { day: SlotDay; today: string; w: WatchProps | null }) {
  const label = fmtNacDay(day.date);
  const rel = day.date === today ? 'Today' : day.date === addDaysYmd(today, 1) ? 'Tomorrow' : '';
  const open = day.rows.some((r) => r.kind === 'open');
  return (
    <article className={'nac-day' + (open ? '' : ' none')} aria-label={rel ? `${rel}, ${label}` : label}>
      <h3 className="nac-date">
        {rel && <span className="nac-rel">{rel}</span>}
        <span>{label}</span>
      </h3>
      <ul className="nac-rows">
        {day.rows.map((r) => (
          <Row key={r.key} row={r} w={w && { ...w, watches: w.watches.filter((x) => x.place === r.key) }} />
        ))}
      </ul>
    </article>
  );
}

const freeLabel = (w: NacFree) => `Free ${fmtRange(w).replace('–', 'to')}, ${hoursOf(w)} hours${w.new ? ', new since the check before' : ''}`;
const usual = (b: NacBooked) => ['published', 'confirmed'].includes(b.status.toLowerCase());

function Row({ row, w }: { row: SlotRow; w: WatchProps | null }) {
  const [watching, setWatching] = useState(false);
  const on = !!w?.watches.some((x) => !x.freed);
  // A day that's over has nothing left to free up.
  const canWatch = !!w && row.kind !== 'done';
  return (
    <li className={'nac-row ' + row.kind + (canWatch ? ' watchable' : '')} {...menuProps(() => rowMenu(row, w, { canWatch, openForm: () => setWatching(true) }), w ? `${row.short}, ${fmtNacDay(w.date)}` : row.short)}>
      <a className="nac-loc" href={row.url} target="_blank" rel="noopener noreferrer" title={`${row.name} on the NAC portal`}>
        {row.short}
      </a>
      <span className="nac-slots">
        {row.free.map((w) => (
          <span key={w.start} className={'nac-free' + (w.new ? ' new' : '')} aria-label={freeLabel(w)}>
            <span className="nac-range tnum">{fmtRange(w)}</span>
            <span className="nac-hours tnum">({hoursOf(w)} h)</span>
            {w.new && <b className="nac-new">NEW</b>}
          </span>
        ))}
        {row.kind === 'full' && <span className="nac-note">Fully booked</span>}
        {row.kind === 'unknown' && (
          <span className="nac-note" title="Past the last booking seen here, so it may just not be open for booking yet">
            Not known yet
          </span>
        )}
        {row.kind === 'done' && <span className="nac-note">No slots left today</span>}
        {row.mine.map((m) => (
          <span key={'m' + m.start} className="nac-mine">
            <span aria-hidden="true">★</span> yours <span className="tnum">{fmtRange(m)}</span>
            {!usual(m) && <span className="nac-status"> ({m.status})</span>}
          </span>
        ))}
      </span>
      {canWatch && (
        <button
          type="button"
          className={'icon-btn nac-watch-btn' + (on || watching ? ' on' : '')}
          aria-expanded={watching}
          title={on ? 'Watching: tell me about another slot here' : 'Watch a slot here: tell me when it frees up'}
          aria-label={`Watch a slot at ${row.short}`}
          onClick={() => setWatching(!watching)}
        >
          <i className={'ph-duotone ' + (on ? 'ph-bell-ringing' : 'ph-bell')} />
        </button>
      )}
      {w && w.watches.length > 0 && <WatchLines row={row} w={w} />}
      {canWatch && watching && <WatchForm row={row} w={w!} onClose={() => setWatching(false)} />}
    </li>
  );
}
