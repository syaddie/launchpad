import { useEffect, useState } from 'react';
import type { AppState } from '../../../shared/types';
import { fmtDay, hm, inMinutes } from '../util';
import { todayAgenda } from './Today';

/** Bento's first tile: the clock, then what's happening now or next with its Join button. */
export function HeroPanel({ data, now, extras }: { data: AppState; now: Date; /** The rest of the top bar's summary line: overdue tasks, packages, the nearest countdown. */ extras: string }) {
  const [tick, setTick] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setTick(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);
  const { cur, next } = todayAgenda(data, now);
  const ev = cur || next;
  const cal = ev ? data.calendars.find((c) => c.id === ev.calendarId) : undefined;
  const label = !ev ? '' : cur ? `Now · ends ${hm(cur.e)}` : inMinutes(Math.max(1, Math.round((ev.s.getTime() - now.getTime()) / 60000)));
  return (
    <section className="panel hero-panel" style={{ gridArea: 'hero' }} aria-label="Clock and what's next">
      <div className="hero-date">{fmtDay(tick)}</div>
      <a className="hero-clock tnum clock-link" href="https://time.is/" target="_blank" rel="noopener" title="Check the time on time.is">{hm(tick)}</a>
      {ev ? (
        <div className="hero-next">
          <div className="hero-label">{label}</div>
          <div className="hero-title">{ev.title}</div>
          <div className="hero-meta">
            {hm(ev.s)}–{hm(ev.e)}
            {cal ? ` · ${cal.name}` : ''}
            {ev.conferenceType ? ` · ${ev.conferenceType}` : ev.location ? ` · ${ev.location}` : ''}
          </div>
          {ev.description && <div className="hero-desc">{ev.description.split('\n')[0]}</div>}
          <div className="hero-actions">
            {ev.conferenceUrl && (
              <a className="join" href={ev.conferenceUrl} target="_blank" rel="noopener">
                <i className="ph-duotone ph-video-camera" /> Join
              </a>
            )}
            {ev.htmlLink && (
              <a className="hero-link" href={ev.htmlLink} target="_blank" rel="noopener">
                Open in Calendar ↗
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="hero-next">
          <div className="hero-label">{data.google.connected ? 'Nothing else on today' : 'Connect Google to see what’s next'}</div>
        </div>
      )}
      {extras && <div className="hero-sub">{extras}</div>}
    </section>
  );
}
