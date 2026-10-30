import { useState } from 'react';
import { DOW, addDays, dayDiff, parseYmd, startOfDay } from '../../../shared/dates';
import { fmtMinutes, gymWorkout, minutes, workingSets, workoutLabel } from '../../../shared/training';
import type { AppState, CalEvent } from '../../../shared/types';
import { ago, fmtDay, hm, inMinutes } from '../util';

interface Props {
  data: AppState;
  now: Date;
  wide: boolean;
  /** Shorter panel (a photo sits below it): tomorrow and later this week start collapsed. */
  compact: boolean;
  onConnect: () => void;
  onRetry: () => Promise<void>;
}

export interface TimedEvent extends CalEvent {
  s: Date;
  e: Date;
}

/** Visible timed events overlapping today, plus the current and next one. */
export function todayAgenda(data: AppState, now: Date) {
  const hidden = new Set(data.prefs.hiddenCalendars);
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  const timed: TimedEvent[] = data.events
    .filter((e) => !e.allDay && !hidden.has(e.calendarId))
    .map((e) => ({ ...e, s: new Date(e.start), e: new Date(e.end) }));
  const todays = timed.filter((e) => e.s < tomorrow && e.e > today);
  const cur = todays.find((e) => e.s <= now && now < e.e);
  const next = todays.find((e) => e.s > now);
  return { timed, todays, cur, next, hidden };
}

export function Today({ data, now, wide, compact, onConnect, onRetry }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [weekOpen, setWeekOpen] = useState(false);
  const [tomorrowOpen, setTomorrowOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const connected = data.google.connected;
  const sync = data.sync.calendar;
  const calOn = data.prefs.sources.calendar;
  const error = connected && calOn && !!sync.lastError;
  const colors = new Map(data.calendars.map((c) => [c.id, c]));
  const today = startOfDay(now);

  const { timed, todays, cur, next, hidden } = todayAgenda(data, now);
  const focus = cur || next;
  const tomorrowEvents = timed.filter((e) => dayDiff(today, e.s) === 1);
  const laterEvents = timed.filter((e) => {
    const o = dayDiff(today, e.s);
    return o >= 2 && o <= 6;
  });
  const allDay = data.events
    .filter((e) => e.allDay && !hidden.has(e.calendarId))
    .filter((e) => {
      const s = parseYmd(e.start);
      const end = parseYmd(e.end);
      return end > today && dayDiff(today, s) <= 6;
    });

  const weekFixed = wide && !compact;
  const showWeek = weekOpen || weekFixed;
  const showTomorrow = tomorrowOpen || !compact;
  const count = (n: number) => `${n} event${n === 1 ? '' : 's'}`;

  const row = (e: TimedEvent, kind: 'today' | 'tmr' | 'week') => {
    const cal = colors.get(e.calendarId);
    const past = kind === 'today' && e.e <= now;
    const isFocus = !!focus && kind === 'today' && e.id === focus.id;
    const isCur = !!cur && e.id === cur.id;
    const meta = [cal?.name, e.location, e.conferenceType].filter(Boolean).join(' · ');
    const gym = kind !== 'week' && data.training.workouts.length ? gymWorkout(e, data.training.workouts) : null;
    const label = isFocus ? (isCur ? `now · ends ${hm(e.e)}` : inMinutes(Math.max(1, Math.round((e.s.getTime() - now.getTime()) / 60000)))) : '';
    const open = expanded === e.id;
    const startsBefore = kind === 'today' && e.s < today;
    return (
      <div key={e.id} className={'event' + (isFocus ? ' focus' : '')} style={{ opacity: past && !gym ? 0.5 : 1 }}>
        <div className="event-row" onClick={() => setExpanded(open ? null : e.id)}>
          <div className="event-time">
            {kind === 'week' ? DOW[e.s.getDay()] : startsBefore ? '…' : hm(e.s)}
            {kind === 'today' && <div className="end">{hm(e.e)}</div>}
            {kind === 'week' && <div className="end">{hm(e.s)}</div>}
          </div>
          <span className="dot" style={{ width: 8, height: 8, marginTop: 6, background: cal?.color || 'var(--t3)' }} />
          <div style={{ minWidth: 0 }}>
            <div className="event-title" style={{ fontWeight: isFocus ? 600 : 400, color: kind === 'today' ? 'var(--tx)' : 'var(--t2)' }}>
              {e.title}
            </div>
            {meta && <div className="event-meta">{meta}</div>}
            {gym && (
              <div className="event-gym">
                <i className="ph-duotone ph-check-circle" aria-hidden="true" />
                Logged in Hevy · {workoutLabel(gym, data.exerciseMuscles)} · {fmtMinutes(minutes(gym))} · {workingSets(gym)} sets
              </div>
            )}
          </div>
          <div className="event-side">
            {label && <span className="event-label">{label}</span>}
            {isFocus && e.conferenceUrl && (
              <a className="join" href={e.conferenceUrl} target="_blank" rel="noopener" onClick={(ev) => ev.stopPropagation()}>
                <i className="ph-duotone ph-video-camera" style={{ fontSize: 14 }} />
                Join
              </a>
            )}
          </div>
        </div>
        {open && (
          <div className="event-more">
            {e.location && (
              <div className="line">
                <i className="ph-duotone ph-map-pin" style={{ color: 'var(--t3)' }} />
                {e.location}
              </div>
            )}
            {e.conferenceUrl && (
              <a className="line" href={e.conferenceUrl} target="_blank" rel="noopener" style={{ color: 'var(--acd)' }}>
                <i className="ph-duotone ph-video-camera" />
                {e.conferenceUrl.replace(/^https?:\/\//, '')}
              </a>
            )}
            {e.description && <div className="desc">{e.description}</div>}
            <a className="line" href={e.htmlLink || 'https://calendar.google.com'} target="_blank" rel="noopener" style={{ fontSize: 12, color: 'var(--t3)' }}>
              Open in Google Calendar
              <i className="ph-duotone ph-arrow-up-right" />
            </a>
          </div>
        )}
      </div>
    );
  };

  const retry = async () => {
    setRetrying(true);
    await onRetry().finally(() => setRetrying(false));
  };

  return (
    <section className="panel" style={{ gridArea: 'today' }} aria-label="Today">
      <div className="panel-head">
        <h2 className="panel-title">Today</h2>
        <span className="meta">{connected && calOn && !error && sync.lastSuccess ? `Synced ${ago(sync.lastSuccess, now)}` : ''}</span>
      </div>
      {(error || retrying) && (
        <div className="status-line">
          <i className="ph-duotone ph-cloud-slash" style={{ fontSize: 14 }} />
          {retrying ? (
            <span>Syncing…</span>
          ) : (
            <>
              <span>Couldn’t sync{sync.lastSuccess ? ` · showing data from ${hm(new Date(sync.lastSuccess))}` : ''}</span>
              <span style={{ color: 'var(--t3)' }}>·</span>
              <button className="btn-link" style={{ color: 'var(--wn)' }} onClick={retry} title={sync.lastError || ''}>
                Retry
              </button>
            </>
          )}
        </div>
      )}
      {connected && calOn ? (
        <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: error ? 0.85 : 1, transition: 'opacity .3s' }}>
          {allDay.map((a) => {
            const s = parseYmd(a.start);
            const day = s < today ? today : s;
            return (
              <div key={a.id} className="allday">
                <span className="dot" style={{ width: 6, height: 6, background: colors.get(a.calendarId)?.color || 'var(--t3)' }} />
                <span className="tnum" style={{ color: 'var(--t3)' }}>
                  {DOW[day.getDay()]} {day.getDate()}
                </span>
                <span>{a.title}</span>
                <span style={{ marginLeft: 'auto', color: 'var(--t3)' }}>All day</span>
              </div>
            );
          })}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {todays.map((e) => row(e, 'today'))}
            {!todays.length && <div style={{ padding: '5px 10px', fontSize: 13, color: 'var(--t3)' }}>Nothing scheduled today.</div>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {compact && tomorrowEvents.length > 0 ? (
              <button className="section-toggle" style={{ cursor: 'pointer' }} aria-expanded={tomorrowOpen} onClick={() => setTomorrowOpen(!tomorrowOpen)}>
                <span className="label">Tomorrow</span>
                <span className="tnum">{count(tomorrowEvents.length)}</span>
                <i className={'ph-duotone ' + (tomorrowOpen ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
              </button>
            ) : (
              <div className="section-toggle">
                <span className="label">Tomorrow</span>
                <span className="tnum">{compact ? 'Nothing yet' : fmtDay(addDays(today, 1))}</span>
              </div>
            )}
            {showTomorrow && tomorrowEvents.map((e) => row(e, 'tmr'))}
            {!compact && !tomorrowEvents.length && <div style={{ padding: '3px 10px', fontSize: 13, color: 'var(--t3)' }}>Nothing yet.</div>}
          </div>
          {laterEvents.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <button className="section-toggle" style={{ cursor: weekFixed ? 'default' : 'pointer' }} onClick={() => !weekFixed && setWeekOpen(!weekOpen)}>
                <span className="label">Later this week</span>
                <span className="tnum">{count(laterEvents.length)}</span>
                {!weekFixed && <i className={'ph-duotone ' + (showWeek ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />}
              </button>
              {showWeek && laterEvents.map((e) => row(e, 'week'))}
            </div>
          )}
        </div>
      ) : connected ? (
        <div className="empty">
          <p>Calendar sync is off. Turn it on in Settings.</p>
        </div>
      ) : (
        <div className="empty">
          <p>Connect your Google account to see today’s agenda here.</p>
          <button className="btn btn-primary" onClick={onConnect}>
            <i className="ph-duotone ph-google-logo" style={{ fontSize: 16 }} />
            Connect Google
          </button>
        </div>
      )}
    </section>
  );
}
