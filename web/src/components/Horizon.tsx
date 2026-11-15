import { useEffect, useRef, useState, type ReactNode } from 'react';
import { addDays, dayDiff, DOW, parseDue, parseYmd, startOfDay } from '../../../shared/dates';
import { fmtStudy, timerMinutes } from '../../../shared/learn';
import { smokesOn } from '../../../shared/trackers';
import type { AppState, CalEvent, Package, Task } from '../../../shared/types';
import { chipOf, fmtDay, hm, inMinutes, segColor, statusText, weatherLabel } from '../util';
import { KeyFigures } from './KeyFigures';
import { todayAgenda } from './Today';

// Horizon's home: everything sorted by when, not by what. A ribbon of today's
// hours across the top, then four columns: Now, Later today, This week, Anytime.
// Notes, photos and bookmarks keep their own panels inside Anytime.

interface Props {
  data: AppState;
  now: Date;
  smokesToday: number;
  /** The nearest countdown, already phrased ("Japan trip in 22 days"). */
  countdown: string;
  onConnect: () => void;
  onAddTask: (listId: string, title: string, due: string | null) => void;
  /** Called once the 5-second undo window has passed. */
  onCompleteTask: (t: Task, keepalive?: boolean) => void;
  onOpenPackage: (id: string) => void;
  onAddPackage: () => void;
  onKeepPackage: (id: string) => void;
  onDismissPackage: (id: string) => void;
  onLogSmoke: () => void;
  onOpenLearn: () => void;
  notify: (msg: string, action?: { label: string; run: () => void }) => void;
  /** Hidden panels (Settings › Panels) drop out of the columns too. */
  show: { today: boolean; tasks: boolean; packages: boolean };
  notes: ReactNode;
  photos: ReactNode;
  bookmarks: ReactNode;
}

const UNDO_MS = 5000;
type Timed = CalEvent & { s: Date; e: Date };

/** The ribbon runs 06:00 to midnight, earlier if something starts before six. */
function ribbonRange(events: Timed[], today: Date): { from: number; to: number } {
  const first = events.reduce((m, e) => Math.min(m, Math.max(0, (e.s.getTime() - today.getTime()) / 3600_000)), 6);
  return { from: Math.floor(Math.min(6, first)), to: 24 };
}

export function HorizonHome(props: Props) {
  const { data, now, show } = props;
  const today = startOfDay(now);
  const { timed, todays, cur, next, hidden } = todayAgenda(data, now);
  const colors = new Map(data.calendars.map((c) => [c.id, c.color]));
  const connected = data.google.connected;
  const calOn = connected && data.prefs.sources.calendar && show.today;
  const tasksOn = connected && data.prefs.sources.tasks && show.tasks;

  // ---- tasks, with the same 5-second undo as the Tasks panel ----
  const [pending, setPending] = useState<string[]>([]);
  const timers = useRef(new Map<string, { t: number; task: Task }>());
  const finalize = (id: string, keepalive = false) => {
    const p = timers.current.get(id);
    if (!p) return;
    clearTimeout(p.t);
    timers.current.delete(id);
    props.onCompleteTask(p.task, keepalive);
    setPending((l) => l.filter((x) => x !== id));
  };
  useEffect(() => {
    const h = () => [...timers.current.keys()].forEach((id) => finalize(id, true));
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  });
  const toggle = (t: Task) => {
    const p = timers.current.get(t.id);
    if (p) {
      clearTimeout(p.t);
      timers.current.delete(t.id);
      setPending((l) => l.filter((x) => x !== t.id));
      return;
    }
    timers.current.set(t.id, { task: t, t: window.setTimeout(() => finalize(t.id), UNDO_MS) });
    setPending((l) => [...l, t.id]);
    props.notify(`Completed “${t.title}”`, {
      label: 'Undo',
      run: () => {
        const q = timers.current.get(t.id);
        if (q) clearTimeout(q.t);
        timers.current.delete(t.id);
        setPending((l) => l.filter((x) => x !== t.id));
      },
    });
  };

  const [text, setText] = useState('');
  const pd = parseDue(text, today);
  const addTask = () => {
    const list = data.taskLists[0];
    if (!text.trim() || !pd.title || !list) return;
    props.onAddTask(list.id, pd.title, pd.due || null);
    setText('');
  };

  const off = (t: Task) => (t.due ? dayDiff(today, parseYmd(t.due)) : null);
  const tasks = tasksOn ? data.tasks : [];
  const overdue = tasks.filter((t) => (off(t) ?? 0) < 0);
  const dueToday = tasks.filter((t) => off(t) === 0);
  const thisWeek = tasks.filter((t) => (off(t) ?? 0) > 0 && (off(t) ?? 0) <= 6);
  const anytime = tasks.filter((t) => t.due == null || (off(t) ?? 0) > 6).sort((a, b) => (a.due ?? '9999') < (b.due ?? '9999') ? -1 : 1);

  // ---- events ----
  const focus = cur || next;
  const evToday = calOn ? todays : [];
  const later = evToday.filter((e) => e.s > now && e !== focus);
  const earlier = evToday.filter((e) => e.e <= now);
  const week = calOn ? timed.filter((e) => { const o = dayDiff(today, e.s); return o >= 1 && o <= 6; }) : [];
  const allDay = calOn
    ? data.events.filter((e) => e.allDay && !hidden.has(e.calendarId)).filter((e) => { const o = dayDiff(today, parseYmd(e.start)); return parseYmd(e.end) > today && o <= 6; })
    : [];

  // ---- packages ----
  const pk = show.packages ? data.packages : [];
  const nowPk = pk.filter((p) => p.stage === 2 || p.exception);
  const weekPk = pk.filter((p) => p.stage < 2 && !p.exception);
  const delivered = pk.filter((p) => p.stage === 3);

  // ---- this week, by day ----
  const days = [1, 2, 3, 4, 5, 6].map((o) => {
    const d = addDays(today, o);
    return {
      o,
      d,
      allDay: allDay.filter((e) => dayDiff(today, parseYmd(e.start)) <= o && parseYmd(e.end) > d),
      events: week.filter((e) => dayDiff(today, e.s) === o),
      tasks: thisWeek.filter((t) => off(t) === o),
    };
  }).filter((x) => x.allDay.length || x.events.length || x.tasks.length);

  const w = data.prefs.weatherArea && !data.prefs.hidden.includes('top:weather') ? data.weather.now : null;
  const timer = data.learn.timer && !data.prefs.hidden.includes('view:learn') ? data.learn.timer : null;
  const limit = data.prefs.cigaretteLimit;

  const checkbox = (t: Task) => (
    <button className={'check' + (pending.includes(t.id) ? ' on' : '')} aria-label={`Complete “${t.title}”`} aria-pressed={pending.includes(t.id)} onClick={() => toggle(t)}>
      {pending.includes(t.id) && <i className="ph-bold ph-check" />}
    </button>
  );
  const taskRow = (t: Task, when?: string, warn?: boolean) => (
    <div key={t.id} className={'hz-row' + (pending.includes(t.id) ? ' done' : '')}>
      {checkbox(t)}
      <span className="hz-grow">{t.title}</span>
      {when && <span className={'hz-when' + (warn ? ' warn' : '')}>{when}</span>}
    </div>
  );
  const eventRow = (e: Timed, dim = false) => (
    <a key={e.id} className={'hz-row hz-event' + (dim ? ' dim' : '')} href={e.htmlLink || undefined} target="_blank" rel="noopener">
      <span className="hz-time tnum">{hm(e.s)}</span>
      <span className="dot" style={{ width: 8, height: 8, background: colors.get(e.calendarId) || 'var(--t3)' }} />
      <span className="hz-grow">{e.title}</span>
      {(e.location || e.conferenceType) && <span className="hz-meta">{e.conferenceType || e.location}</span>}
    </a>
  );
  const pkgCard = (p: Package) => {
    const chip = chipOf(p);
    return (
      <div key={p.id} className="hz-card hz-click" role="button" tabIndex={0} onClick={() => props.onOpenPackage(p.id)} onKeyDown={(e) => e.key === 'Enter' && props.onOpenPackage(p.id)}>
        <div className="hz-tagline">
          <span className="hz-tag">Package</span>
          <span className={'chip ' + chip.cls}>{chip.text}</span>
        </div>
        <b>{p.label}</b>
        <div className="segs">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className="pkg-seg" style={{ background: segColor(p, i) }} />
          ))}
        </div>
        <span className="hz-meta" style={p.exception ? { color: 'var(--wn)' } : undefined}>
          {statusText(p, today)} · {p.carrier} <span className="mono">{p.number}</span>
        </span>
        {p.isNew && (
          <div className="pkg-new" onClick={(e) => e.stopPropagation()}>
            <span style={{ flex: 1 }}>New from Gmail. Keep tracking?</span>
            <button className="keep" onClick={() => props.onKeepPackage(p.id)}>Keep</button>
            <button className="dismiss" onClick={() => props.onDismissPackage(p.id)}>Dismiss</button>
          </div>
        )}
      </div>
    );
  };

  // On a phone the ribbon scrolls sideways: open it on now.
  const ribbonWrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ribbonWrap.current;
    const n = el?.querySelector<HTMLElement>('.hz-now');
    if (el && n && el.scrollWidth > el.clientWidth) el.scrollLeft = n.offsetLeft - el.clientWidth / 2;
  }, []);

  const focusLabel = !focus ? '' : cur ? `Now · ends ${hm(cur.e)}` : inMinutes(Math.max(1, Math.round((focus.s.getTime() - now.getTime()) / 60000)));
  const nothingNow = !(calOn && focus) && !overdue.length && !nowPk.length && !timer && !w && limit === 0 && !props.smokesToday;

  return (
    <main className="hz-home">
      <div className="hz-ribbon-wrap" ref={ribbonWrap}>
        <Ribbon data={data} now={now} events={evToday} focusId={focus?.id} colors={colors} timer={timer} />
      </div>
      <div className="hz-cols">
        <section className="hz-col" aria-label="Now">
          <div className="hz-head now">
            <h2>Now</h2>
            <span>{hm(now)}{focus && !cur ? ` – ${hm(focus.e)}` : cur ? ` – ${hm(cur.e)}` : ''}</span>
          </div>
          {show.today && <KeyFigures data={data} now={now} />}
          {calOn && focus && (
            <div className="hz-card hot">
              <div className="hz-tagline">
                <span className="hz-tag accent">{focusLabel}</span>
                <span className="hz-time tnum">{hm(focus.s)}–{hm(focus.e)}</span>
              </div>
              <b className="hz-big">{focus.title}</b>
              {(focus.location || focus.conferenceType) && <span className="hz-meta">{[focus.conferenceType, focus.location].filter(Boolean).join(' · ')}</span>}
              {focus.description && <span className="hz-desc">{focus.description.split('\n')[0]}</span>}
              <div className="hz-actions">
                {focus.conferenceUrl && (
                  <a className="join" href={focus.conferenceUrl} target="_blank" rel="noopener">
                    <i className="ph-duotone ph-video-camera" /> Join
                  </a>
                )}
                {focus.htmlLink && <a className="hz-link" href={focus.htmlLink} target="_blank" rel="noopener">Open in Calendar ↗</a>}
              </div>
            </div>
          )}
          {overdue.length > 0 && (
            <div className="hz-card warn">
              <span className="hz-tag warn">Overdue</span>
              {overdue.map((t) => taskRow(t, fmtDay(parseYmd(t.due!)), true))}
            </div>
          )}
          {nowPk.map(pkgCard)}
          {timer && (
            <button className="hz-card hz-click" onClick={props.onOpenLearn}>
              <span className="hz-tagline">
                <span className="hz-tag">Studying</span>
                <b className="tnum accent-text">{fmtStudy(timerMinutes(timer, now))}</b>
              </span>
              <span>
                {data.learn.courses.find((c) => c.id === timer.courseId)?.name ?? 'General'} · since {hm(new Date(timer.start))}
              </span>
            </button>
          )}
          {w && (
            <div className="hz-card">
              <span className="hz-tagline">
                <span className="hz-tag">Sky · {w.area}</span>
                {w.validUntil && <span className="hz-meta">until {hm(new Date(w.validUntil))}</span>}
              </span>
              <span>
                {w.tempC !== null && <b className="tnum">{Math.round(w.tempC)}° </b>}
                {weatherLabel(w.forecast)}
              </span>
              {(w.air || w.uv) && (
                <span className="hz-meta">
                  {[w.air && `PSI ${w.air.psi}`, w.uv && `UV ${w.uv.value}`, w.rain && `${w.rain.mmLastHour} mm rain last hour`].filter(Boolean).join(' · ')}
                </span>
              )}
            </div>
          )}
          {!data.prefs.hidden.includes('top:cig') && (
            <div className="hz-card">
              <span className="hz-tagline">
                <span className="hz-tag">Cigarettes</span>
                <button className="btn btn-secondary btn-small" onClick={props.onLogSmoke}>+1 (C)</button>
              </span>
              <span>
                <b className="tnum">{props.smokesToday}</b>
                {limit > 0 ? ` of ${limit}` : ''} today
              </span>
            </div>
          )}
          {nothingNow && <p className="hz-empty">Nothing needs you right now.</p>}
          {!connected && (
            <div className="hz-card">
              <span>Connect Google to see your calendar and tasks here.</span>
              <button className="btn btn-primary btn-small" style={{ alignSelf: 'flex-start' }} onClick={props.onConnect}>Connect Google</button>
            </div>
          )}
        </section>

        <section className="hz-col" aria-label="Later today">
          <div className="hz-head today">
            <h2>Later today</h2>
            <span>{focus ? hm(focus.e) : hm(now)} – 24:00</span>
          </div>
          {later.map((e) => eventRow(e))}
          {calOn && !later.length && <p className="hz-empty">Nothing else on the calendar today.</p>}
          {tasksOn && (
            <>
              <div className="hz-sub">Tasks due today</div>
              {dueToday.map((t) => taskRow(t))}
              <div className="hz-add">
                <i className="ph ph-plus" aria-hidden="true" />
                <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} placeholder="Add a task… try “call bank fri”" aria-label="Add a task" />
                {pd.due && text.trim() && <span className="hz-when accent-text">Due {fmtDay(parseYmd(pd.due))}</span>}
              </div>
            </>
          )}
          {earlier.length > 0 && (
            <>
              <div className="hz-sub">Earlier today</div>
              {earlier.map((e) => eventRow(e, true))}
            </>
          )}
        </section>

        <section className="hz-col" aria-label="This week">
          <div className="hz-head week">
            <h2>This week</h2>
            <span>{fmtDay(addDays(today, 1))} – {fmtDay(addDays(today, 6))}</span>
          </div>
          {days.map((d) => (
            <div key={d.o} className="hz-day">
              <div className="hz-sub">{d.o === 1 ? `${DOW[d.d.getDay()]} · tomorrow` : fmtDay(d.d)}</div>
              {d.allDay.map((e) => (
                <div key={e.id} className="hz-row">
                  <span className="hz-time">All day</span>
                  <span className="dot" style={{ width: 8, height: 8, background: colors.get(e.calendarId) || 'var(--t3)' }} />
                  <span className="hz-grow">{e.title}</span>
                </div>
              ))}
              {d.events.map((e) => eventRow(e))}
              {d.tasks.map((t) => taskRow(t))}
            </div>
          ))}
          {!days.length && (calOn || tasksOn) && <p className="hz-empty">A quiet week so far.</p>}
          {weekPk.length > 0 && <div className="hz-sub">On the way</div>}
          {weekPk.map(pkgCard)}
          {show.packages && (
            <button className="btn btn-ghost btn-small" style={{ alignSelf: 'flex-start' }} onClick={props.onAddPackage}>
              <i className="ph-duotone ph-plus" /> Add package
            </button>
          )}
        </section>

        <section className="hz-col" aria-label="Anytime">
          <div className="hz-head any">
            <h2>Anytime</h2>
            <span>no date</span>
          </div>
          {anytime.map((t) => taskRow(t, t.due ? fmtDay(parseYmd(t.due)) : undefined))}
          {props.countdown && (
            <div className="hz-row">
              <span className="hz-tag">Countdown</span>
              <span className="hz-grow">{props.countdown}</span>
            </div>
          )}
          {props.notes}
          {props.photos}
          {props.bookmarks}
          {delivered.length > 0 && (
            <div className="hz-meta">
              Delivered: {delivered.map((p) => p.label).join(', ')}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

/** Today's hours as a strip: the sky, events, the study session, cigarettes, and a line at now. */
function Ribbon({ data, now, events, focusId, colors, timer }: {
  data: AppState;
  now: Date;
  events: Timed[];
  focusId?: string;
  colors: Map<string, string>;
  timer: { courseId: string; start: string } | null;
}) {
  const today = startOfDay(now);
  const { from, to } = ribbonRange(events, today);
  const span = to - from;
  const x = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - today.getTime()) / 3600_000 - from) / span * 100));
  const w = data.weather.now;
  const smokes = data.prefs.hidden.includes('top:cig') ? [] : smokesOn(data.smokes, now);
  // Two lanes, so back-to-back events don't sit on top of each other.
  let laneEnd = [0, 0];
  const placed = events.map((e) => {
    const lane = e.s.getTime() >= laneEnd[0] ? 0 : e.s.getTime() >= laneEnd[1] ? 1 : 0;
    laneEnd = lane === 0 ? [e.e.getTime(), laneEnd[1]] : [laneEnd[0], e.e.getTime()];
    return { e, lane };
  });
  const hours: number[] = [];
  for (let h = from; h <= to; h += 2) hours.push(h);
  return (
    <div className="hz-ribbon" aria-label="Today, hour by hour">
      {w && w.validUntil && Date.parse(w.validUntil) > now.getTime() && (
        <div className="hz-sky" style={{ left: `${x(now)}%`, width: `${Math.max(4, x(new Date(w.validUntil)) - x(now))}%` }}>
          {weatherLabel(w.forecast)}
        </div>
      )}
      {placed.map(({ e, lane }) => (
        <a
          key={e.id}
          href={e.htmlLink || undefined}
          target="_blank"
          rel="noopener"
          className={'hz-block' + (e.id === focusId ? ' focus' : '') + (e.e <= now ? ' past' : '')}
          style={{ left: `${x(e.s)}%`, width: `${Math.max(0.8, x(e.e) - x(e.s))}%`, top: 28 + lane * 34, borderLeftColor: colors.get(e.calendarId) || 'var(--t3)' }}
          title={`${hm(e.s)}–${hm(e.e)} ${e.title}`}
        >
          <b>{e.title}</b>
          <span className="tnum">{hm(e.s)}</span>
        </a>
      ))}
      {timer && (
        <div className="hz-span" style={{ left: `${x(new Date(timer.start))}%`, width: `${Math.max(0.5, x(now) - x(new Date(timer.start)))}%` }} title={`Studying since ${hm(new Date(timer.start))}`}>
          Studying
        </div>
      )}
      {smokes.map((d) => (
        <span key={d.toISOString()} className="hz-tick" style={{ left: `${x(d)}%` }} title={`Cigarette at ${hm(d)}`} />
      ))}
      <div className="hz-now" style={{ left: `${x(now)}%` }}>
        <span>{hm(now)}</span>
      </div>
      {hours.map((h) => (
        <span key={h} className={'hz-axis tnum' + (h === from ? ' start' : h >= to ? ' end' : '')} style={{ left: `${((h - from) / span) * 100}%` }}>
          {String(h % 24 === 0 && h ? 24 : h).padStart(2, '0')}:00
        </span>
      ))}
    </div>
  );
}
