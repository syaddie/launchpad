import { useEffect, useState } from 'react';
import type { AppState } from '../../../../shared/types';
import { countdown } from '../../mission';
import { hm } from '../../util';
import { todayAgenda } from '../Today';

/**
 * Mission's words in the sky on Home, in place of the greeting: the launch clock counting to the next event (T-),
 * through the one that's on (T+), or showing the time when nothing is left; what it counts to; and the day's summary.
 */
export function MissionHero({ data, now, extras }: { data: AppState; now: Date; extras: string }) {
  // The clock's seconds are its own; the rest of the page ticks on the minute (`now`).
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const iv = window.setInterval(() => setTick(new Date()), 1000);
    return () => window.clearInterval(iv);
  }, []);
  // Whichever is later, so a minute tick is never behind the page's.
  const t = tick > now ? tick : now;

  const calOn = data.google.connected && data.prefs.sources.calendar;
  const { cur, next } = calOn ? todayAgenda(data, t) : { cur: undefined, next: undefined };
  const c = countdown(t, cur, next);
  const event = cur ?? next;

  const label = cur ? `Now · until ${hm(cur.e)}` : next ? `Next · ${hm(next.s)}` : 'Site time';
  const what = event
    ? event.title
    : data.google.signedOut
      ? 'Google signed out'
      : !data.google.connected
        ? 'Connect Google to see what’s next'
        : calOn
          ? 'Nothing else on the pad today'
          : `Good ${t.getHours() < 12 && t.getHours() >= 5 ? 'morning' : t.getHours() < 18 && t.getHours() >= 12 ? 'afternoon' : 'evening'}${data.prefs.name ? `, ${data.prefs.name}` : ''}`;
  const where = event ? [event.location, event.conferenceType].filter(Boolean).join(' · ') : data.google.signedOut ? 'Reconnect in Settings' : '';
  const sub = [where, extras].filter(Boolean).join(' · ');

  return (
    <div className={'ms-hero' + (c.soon ? ' ms-hero--soon' : '') + (c.state === 'now' ? ' ms-hero--now' : '')}>
      <span className="ms-hero-label">
        {(c.soon || c.state === 'now') && <span className="ms-beacon" aria-hidden="true" />}
        {label}
        {c.state === 'now' && <span className="ms-live">Live</span>}
      </span>
      {/* The unlit dots (data-ghost) sit behind the lit ones; a digit that changed relights (its key is its place and value). */}
      <span className="ms-matrix" data-ghost={c.text.replace(/\d/g, '8')} role="timer" aria-label={c.state === 'idle' ? `The time is ${hm(t)}` : `${c.state === 'now' ? 'Started' : 'Starts in'} ${c.text.slice(2)}`}>
        {[...c.text].map((ch, i) => (
          <span key={`${i}${ch}`} className="ms-cell" aria-hidden="true">
            {ch}
          </span>
        ))}
      </span>
      <h1 className="ms-hero-what" data-copy="title">
        {what}
      </h1>
      {sub && (
        <div className="ms-hero-sub" title={sub}>
          {sub}
        </div>
      )}
    </div>
  );
}
