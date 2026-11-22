import { useEffect, useRef, type ReactNode } from 'react';
import { nacCodes } from '../../../../shared/nac';

const PORTAL = 'https://eservices.nac.gov.sg/Busking';

/** One mark from the page and what it means; the mark is the page's own (same classes), so every design draws it the same. */
function Item({ mark, children }: { mark: ReactNode; children: ReactNode }) {
  return (
    <>
      <dt className="guide-mark">{mark}</dt>
      <dd className="guide-means">{children}</dd>
    </>
  );
}

const chip = (code: string, o: { h?: string; star?: boolean; fresh?: boolean } = {}) => (
  <span className={'nac-chip sample' + (o.h ? '' : ' mine-only') + (o.fresh ? ' new' : '')}>
    {o.star && <span className="nac-chip-star">★</span>}
    <b>{code}</b>
    {o.h && <span className="nac-chip-h tnum">{o.h}</span>}
  </span>
);

/**
 * The Music-only page's one-page guide (web/src/guest.tsx, at #help): what each part of the busking
 * slots means, in plain words, for the person it's shared with. The locations' codes come from the
 * last reading kept on this device, so they match the calendar's.
 */
export function GuestGuide({ places }: { places: { key: string; short: string }[] }) {
  const title = useRef<HTMLHeadingElement>(null);
  const codes = nacCodes(places);
  const [a, b] = places;
  const ca = a ? codes[a.key] : 'PL';
  const cb = b ? codes[b.key] : 'CV';

  // Opened from the link at the top: start at the top, with the keyboard (and a screen reader) there too.
  useEffect(() => {
    window.scrollTo(0, 0);
    title.current?.closest('main')?.scrollTo(0, 0);
    title.current?.focus({ preventScroll: true });
  }, []);

  return (
    <main className="you guide" aria-label="How to read this page">
      <section className="panel you-panel guide-panel" aria-label="How to read this page">
        <div className="panel-head">
          <h2 className="panel-title" ref={title} tabIndex={-1}>
            How to read this page
          </h2>
        </div>

        <p className="guide-lead">
          This page shows which NAC busking slots are still <b>free</b> at the locations below. It reads NAC’s pages every 10 minutes, so it’s
          usually no more than 10 minutes old. <b>Booking is still done on the NAC portal</b>; this page only helps you see where to look.
        </p>

        {places.length > 0 && (
          <p className="guide-places">
            {places.map((p) => (
              <span key={p.key} className="nac-legend-item">
                <b className="nac-code">{codes[p.key]}</b> {p.short}
              </span>
            ))}
          </p>
        )}

        <h3 className="guide-h">The calendar</h3>
        <p className="guide-p">Each box is a day. Inside are the locations with free time that day. Tap a day to see its times.</p>
        <dl className="guide-list">
          <Item mark={chip(ca, { h: '3h' })}>
            {a ? a.short : 'This location'} has <b>3 hours free</b> that day, in total.
          </Item>
          <Item mark={chip(cb, { star: true })}>You have a booking there that day.</Item>
          <Item mark={chip(ca, { h: '2h', fresh: true })}>
            A dot (an underline on a phone) means it <b>became free since the last check</b>, often because someone cancelled. Worth a look.
          </Item>
          <Item mark={<span className="nac-cell-note">Full</span>}>Nothing free at any location that day.</Item>
          <Item mark={<span className="nac-cell-note">?</span>}>Not known yet: NAC hasn’t shown bookings that far ahead.</Item>
        </dl>
        <p className="guide-p meta">Greyed-out days are over, or too far ahead to know. Today has an outline.</p>

        <h3 className="guide-h">A day’s times</h3>
        <p className="guide-p">Beside the calendar (below it on a phone), each location for the day you picked:</p>
        <dl className="guide-list">
          <Item
            mark={
              <span className="nac-free">
                <span className="nac-range tnum">10 AM – 12 PM</span>
                <span className="nac-hours tnum">(2 h)</span>
              </span>
            }
          >
            Free from 10 to 12, two hours.
          </Item>
          <Item
            mark={
              <span className="nac-free new">
                <span className="nac-range tnum">5 PM – 7 PM</span>
                <b className="nac-new">NEW</b>
              </span>
            }
          >
            Free since the last check.
          </Item>
          <Item
            mark={
              <span className="nac-mine">
                <span aria-hidden="true">★</span> yours <span className="tnum">11 AM – 1 PM</span>
              </span>
            }
          >
            Your own booking.
          </Item>
          <Item mark={<span className="nac-note">Fully booked</span>}>Someone has every slot there that day.</Item>
          <Item mark={<span className="nac-note">Not known yet</span>}>Past the last booking NAC shows there, so it may not be open for booking yet.</Item>
        </dl>
        <p className="guide-p">
          <b>To book</b>, tap the location’s name: it opens that location on the{' '}
          <a className="btn-link" href={PORTAL} target="_blank" rel="noopener noreferrer">
            NAC portal
          </a>
          . Pressing and holding a location (right-click on a computer) gives the same link.
        </p>

        <h3 className="guide-h">Up to date?</h3>
        <dl className="guide-list">
          <Item mark={<span className="meta tnum">Last checked 04:45 · next check 04:55</span>}>When NAC was last read, and when it’s read next.</Item>
          <Item
            mark={
              <span className="btn btn-secondary btn-small guide-btn" aria-hidden="true">
                <i className="ph-duotone ph-arrows-clockwise" />
                Check now
              </span>
            }
          >
            Reads NAC straight away instead of waiting. It works once every 5 minutes, and is greyed out in between.
          </Item>
        </dl>
        <p className="guide-p meta">“Free” means nobody had booked it when NAC was last read. Someone else can still book it first, so don’t wait long.</p>

        <h3 className="guide-h">If something looks wrong</h3>
        <ul className="guide-ul">
          <li>
            <b>A yellow “NAC fetch failed” note:</b> NAC couldn’t be read just now. The slots you see are from the time it says, and it tries again
            by itself.
          </li>
          <li>
            <b>“Couldn’t refresh”:</b> this page can’t reach the server, usually the internet connection. It keeps showing the last slots it had.
          </li>
          <li>
            <b>Asked to sign in:</b> enter your email, then the 6-digit code that’s emailed to you (check spam). It keeps you signed in for a month
            on that phone or computer.
          </li>
        </ul>

        <p className="guide-back">
          <a className="btn btn-secondary btn-small" href="#slots">
            <i className="ph-duotone ph-arrow-left" aria-hidden="true" />
            Back to the slots
          </a>
        </p>
      </section>
    </main>
  );
}
