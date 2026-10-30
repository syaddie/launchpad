import { Fragment, useEffect, useRef, useState } from 'react';
import { DOW, startOfDay } from '../../../shared/dates';
import { fmtStudy, timerMinutes } from '../../../shared/learn';
import { engineUrl, parseSearch } from '../../../shared/trackers';
import type { AppState, Bookmark, SearchEngine, SourceKey, Weather } from '../../../shared/types';
import { fmtMinutes, lastTrained, minutes, workoutLabel } from '../../../shared/training';
import { ago, favicon, fmtDay, hm, host, psiBand, uvBand, weatherIcon, weatherLabel } from '../util';

interface Props {
  data: AppState;
  now: Date;
  subline: string;
  search: string;
  onSearch: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  /** Cigarettes logged today, for the quick-log button. */
  smokesToday: number;
  onLogSmoke: () => void;
  onOpenTraining: () => void;
  onOpenLearn: () => void;
}

/** Days without training before the button turns orange. */
const TRAINING_NUDGE_DAYS = 4;
const trainedWhen = (days: number) => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

export function matchBookmark(b: Bookmark, q: string): boolean {
  return !q || b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
}

function Clock({ weather, showAir }: { weather: Weather | null; showAir: boolean }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div className="clock-row">
      <span className="serif clock">{hm(now)}</span>
      <span className="tnum" style={{ fontSize: 13, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
        {fmtDay(now)} · {tzLabel()}
      </span>
      {weather && <WeatherNow w={weather} now={now} showAir={showAir} />}
    </div>
  );
}

/** Hours old before a reading counts as stale and is hidden. */
const STALE_H = 3;
const fresh = (iso: string | undefined, now: Date) => !!iso && now.getTime() - Date.parse(iso) < STALE_H * 3600_000;

function WeatherNow({ w, now, showAir }: { w: Weather; now: Date; showAir: boolean }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pinned) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setPinned(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setPinned(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [pinned]);

  // Hide a reading the sync has stopped refreshing rather than show old weather as current.
  if (!fresh(w.issuedAt, now)) return null;
  const night = /\(night\)/i.test(w.forecast) || now.getHours() >= 19 || now.getHours() < 7;
  const label = weatherLabel(w.forecast);
  const air = showAir && w.air && fresh(w.air.at, now) ? w.air : null;
  // UV readings stop after 19:00, so the day's last one stays until midnight.
  const uv = showAir && w.uv && new Date(w.uv.at).toDateString() === now.toDateString() ? w.uv : null;
  const band = air ? psiBand(air.psi) : null;
  const chip = air && band ? (band.bad ? `PSI ${air.psi} · ${band.name}` : `PSI ${air.psi}${uv && uv.value > 0 ? ` · UV ${uv.value}` : ''}`) : '';
  const open = hover || pinned;

  return (
    <div className="weather-wrap" ref={ref} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button className={'weather tnum' + (open ? ' on' : '')} aria-expanded={open} aria-label={`${label}. Weather details`} onClick={() => setPinned(!pinned)}>
        <i className={'ph-duotone ' + weatherIcon(w.forecast, night)} aria-hidden="true" />
        {w.tempC !== null && <span>{Math.round(w.tempC)}°</span>}
        <span className="weather-text">{label}</span>
        {chip && <span className={'chip ' + (band!.bad ? 'chip-warn' : 'chip-neutral')}>{chip}</span>}
      </button>
      {open && <WeatherDetails w={w} label={label} air={air} uv={uv} now={now} showAir={showAir} />}
    </div>
  );
}

function Scale({ widths, active, color, pos }: { widths: number[]; active: number; color: string; pos: number }) {
  return (
    <div className="scale" aria-hidden="true">
      {widths.map((f, i) => (
        <span key={i} style={{ flex: f, background: i === active ? color : 'var(--ln)' }} />
      ))}
      <span className="scale-mark" style={{ left: `${Math.min(99, Math.max(1, pos * 100))}%` }} />
    </div>
  );
}

function WeatherDetails({ w, label, air, uv, now, showAir }: {
  w: Weather;
  label: string;
  air: Weather['air'];
  uv: Weather['uv'];
  now: Date;
  showAir: boolean;
}) {
  const until = w.validUntil ? ` until ${hm(new Date(w.validUntil))}` : '';
  const band = air ? psiBand(air.psi) : null;
  const ub = uv ? uvBand(uv.value) : null;
  const rain = showAir && w.rain && w.rain.steps.length && fresh(w.rain.steps[w.rain.steps.length - 1].at, now) ? w.rain : null;
  const maxMm = rain ? Math.max(0.4, ...rain.steps.map((s) => s.mm)) : 1;
  const outlook = (w.outlook ?? []).slice(0, 4);
  const peakPast = uv && Date.parse(uv.peakAt) < Date.parse(uv.at);
  return (
    <div className="popover weather-pop" role="dialog" aria-label={`Weather in ${w.area}`}>
      <div className="wp-head">
        <span style={{ fontWeight: 600 }}>
          {label} in {w.area}
          {until}
        </span>
        {w.tempC !== null && w.station && (
          <span className="meta">
            {w.tempC.toFixed(1)} °C at {w.station}
          </span>
        )}
      </div>

      {air && band && (
        <div className="wp-sec">
          <div className="wp-title">
            <span>Air quality</span>
            <span className="meta">24-hour PSI · {air.region[0].toUpperCase() + air.region.slice(1)}</span>
          </div>
          <div className="wp-big">
            <span className="serif tnum">{air.psi}</span>
            <span className={'chip ' + (band.bad ? 'chip-warn' : 'chip-neutral')}>{band.name}</span>
            <span className="meta">PM2.5 {air.pm25} µg/m³</span>
          </div>
          {/* Bands on a 0–400 scale: 50, 50, 100, 100, 100. */}
          <Scale widths={[50, 50, 100, 100, 100]} active={band.index} color={band.bad ? 'var(--wn)' : band.index === 0 ? 'var(--ac)' : 'var(--t3)'} pos={air.psi / 400} />
          <div className="wp-legend">
            <span>Good</span>
            <span>Moderate</span>
            <span>Unhealthy</span>
            <span>Very unhealthy</span>
          </div>
          {band.bad && <span style={{ fontSize: 12, color: 'var(--wn)' }}>Cut down on long or strenuous outdoor activity.</span>}
        </div>
      )}

      {uv && ub && (
        <div className="wp-sec">
          <div className="wp-title">
            <span>UV index</span>
            <span className="meta">As of {hm(new Date(uv.at))}</span>
          </div>
          <div className="wp-big">
            <span className="serif tnum">{uv.value}</span>
            <span className="chip chip-neutral">{ub.name}</span>
            {peakPast && uv.peak > uv.value && (
              <span className="meta">
                Peaked at {uv.peak} at {hm(new Date(uv.peakAt))}
              </span>
            )}
          </div>
          {/* Bands on a 0–12 scale: 0–2, 3–5, 6–7, 8–10, 11+. */}
          <Scale widths={[3, 3, 2, 3, 1]} active={ub.index} color="var(--t3)" pos={(uv.value + 0.5) / 12} />
          <div className="wp-legend">
            <span>Low</span>
            <span>Moderate</span>
            <span>High</span>
            <span>Very high</span>
            <span>Extreme</span>
          </div>
        </div>
      )}

      {rain && (
        <div className="wp-sec">
          <div className="wp-title">
            <span>Rain</span>
            <span className="meta" style={rain.raining ? { color: 'var(--acd)' } : undefined}>
              {rain.raining ? `Raining at ${rain.station} now` : `Dry at ${rain.station}`}
            </span>
          </div>
          <div className="rain-bars" role="img" aria-label={`Rainfall at ${rain.station}: ${rain.mmLastHour} mm in the last hour`}>
            {rain.steps.map((s) => (
              <span key={s.at} title={`${hm(new Date(s.at))} · ${s.mm} mm`} style={{ height: Math.max(2, Math.round((s.mm / maxMm) * 34)), background: s.mm > 0 ? 'var(--ac)' : 'var(--ln)' }} />
            ))}
          </div>
          <div className="wp-legend">
            <span>{hm(new Date(rain.steps[0].at))}</span>
            <span>{rain.mmLastHour} mm in the last hour</span>
            <span>{hm(new Date(rain.steps[rain.steps.length - 1].at))}</span>
          </div>
        </div>
      )}

      {outlook.length > 0 && (
        <div className="wp-outlook">
          {outlook.map((d) => (
            <div key={d.date}>
              <span style={{ fontWeight: 600 }}>{DOW[new Date(d.date + 'T00:00').getDay()]}</span>
              <span style={{ color: 'var(--t2)' }}>{weatherLabel(d.forecast)}</span>
              <span className="tnum" style={{ color: 'var(--t3)' }}>
                {d.low}–{d.high}°
              </span>
            </div>
          ))}
        </div>
      )}
      <span className="meta" style={{ fontSize: 11 }}>
        From data.gov.sg · updated {hm(new Date(w.issuedAt))}
      </span>
    </div>
  );
}

function tzLabel(): string {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (tz === 'Asia/Singapore') return 'SGT';
  return new Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '';
}

function failing(s: { lastSuccess: string | null; lastError: string | null }) {
  return !!s.lastError;
}

type Row = { key: string; url: string; bookmark?: Bookmark; engine?: SearchEngine; term?: string };

/** Search rows: a prefixed search goes straight to its engine; otherwise bookmarks, then every engine. */
export function searchRows(q: string, bookmarks: Bookmark[], engines: SearchEngine[]): Row[] {
  const { engine, term } = parseSearch(q, engines);
  if (!term) return [];
  if (engine) return [{ key: 'e:' + engine.prefix, url: engineUrl(engine, term), engine, term }];
  const lq = term.toLowerCase();
  const hits = bookmarks.filter((b) => matchBookmark(b, lq)).slice(0, 6);
  return [
    ...hits.map((b) => ({ key: 'b:' + b.id, url: b.url, bookmark: b })),
    ...engines.map((e) => ({ key: 'e:' + e.prefix, url: engineUrl(e, term), engine: e, term })),
  ];
}

export function TopBar({ data, now, subline, search, onSearch, searchRef, smokesToday, onLogSmoke, onOpenTraining, onOpenLearn }: Props) {
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const [syncHover, setSyncHover] = useState(false);
  const blurT = useRef<number>(0);

  const hr = now.getHours();
  const greeting = hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';

  const hidden = data.prefs.hidden;
  const trained = lastTrained(data.training.workouts, startOfDay(now));
  const engines = data.prefs.searchEngines;
  const rows = searchRows(search, data.bookmarks.flatMap((g) => g.items), engines);
  const prefixed = rows.length === 1 && !!rows[0].engine && parseSearch(search, engines).engine !== null;
  const firstEngine = rows.findIndex((r) => r.engine);
  const cur = Math.min(sel, Math.max(0, rows.length - 1));

  const open = (url: string) => {
    window.open(url, '_blank', 'noopener');
    onSearch('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(cur + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(cur - 1, 0));
    } else if (e.key === 'Escape') {
      onSearch('');
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && rows[cur]) {
      open(rows[cur].url);
    }
  };

  // Sync dot: quiet when fresh, warning when any source fails, faint when not connected.
  const sources: { key: SourceKey; name: string; ok: string }[] = [
    { key: 'calendar', name: 'Calendar', ok: 'Synced' },
    { key: 'tasks', name: 'Tasks', ok: 'Synced' },
    { key: 'gmail', name: 'Gmail packages', ok: 'Checked' },
    { key: 'carriers', name: 'Carriers', ok: 'Updated' },
    { key: 'news', name: 'News', ok: 'Updated' },
    { key: 'inbox', name: 'Inbox', ok: 'Updated' },
    { key: 'weather', name: 'Weather', ok: 'Updated' },
    { key: 'speedtest', name: 'Speed test', ok: 'Ran' },
  ];
  const needsGoogle = (k: SourceKey) => k === 'calendar' || k === 'tasks' || k === 'gmail' || k === 'inbox';
  const connected = data.google.connected;
  const lines = sources
    .filter((s) => connected || !needsGoogle(s.key))
    .map((s) => {
      const st = data.sync[s.key];
      const off =
        s.key === 'news'
          ? !data.prefs.newsTopics.length
          : s.key === 'inbox'
            ? !data.prefs.sources.gmail || hidden.includes('view:inbox')
            : s.key === 'weather'
              ? !data.prefs.weatherArea
              : s.key === 'speedtest'
                ? !data.prefs.speedTestHours
                : needsGoogle(s.key) && !data.prefs.sources[s.key as 'calendar'];
      if (off) return { name: s.name, text: 'Off', warn: false };
      if (failing(st)) return { name: s.name, text: `Couldn’t sync · last synced ${ago(st.lastSuccess, now)}`, warn: true, why: st.lastError };
      return { name: s.name, text: st.lastSuccess ? `${s.ok} ${ago(st.lastSuccess, now)}` : 'Waiting for first sync', warn: false };
    });
  if (data.google.signedOut) lines.unshift({ name: 'Google', text: 'Signed out · reconnect in Settings', warn: true, why: data.google.signedOut.reason });
  else if (!connected) lines.unshift({ name: 'Google', text: 'Not connected', warn: false });
  const anyFail = lines.some((l) => l.warn);
  const dot = anyFail ? 'var(--wn)' : connected ? 'var(--t3)' : 'var(--ln)';

  return (
    <header className="topbar">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
        <div className="serif greeting">
          {greeting}
          {data.prefs.name ? `, ${data.prefs.name}` : ''}
        </div>
        <div className="subline">{subline}</div>
      </div>
      <div className="top-right" style={{ display: 'flex', alignItems: 'flex-end', gap: '15px 30px', flexWrap: 'wrap' }}>
        <Clock weather={data.prefs.weatherArea && !hidden.includes('top:weather') ? data.weather.now : null} showAir={!hidden.includes('top:air')} />
        <div className="top-tools" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div className="search">
            <i className="ph-duotone ph-magnifying-glass" />
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => {
                onSearch(e.target.value);
                setSel(0);
              }}
              onKeyDown={onKey}
              onFocus={() => {
                clearTimeout(blurT.current);
                setFocused(true);
              }}
              onBlur={() => {
                blurT.current = window.setTimeout(() => setFocused(false), 120);
              }}
              placeholder="Search or jump to…"
              aria-label="Search bookmarks or the web"
            />
            <span className="slash mono">/</span>
            {rows.length > 0 && focused && (
              <div className="popover search-drop" role="listbox" aria-label="Search results">
                {rows.map((r, i) => (
                  <div key={r.key}>
                    {i === firstEngine && !prefixed && (
                      <div className="search-note">{firstEngine === 0 ? 'No bookmarks match. Search with:' : 'Or search with:'}</div>
                    )}
                    {r.bookmark ? (
                      <a
                        href={r.url}
                        target="_blank"
                        rel="noopener"
                        role="option"
                        aria-selected={i === cur}
                        className={'search-row' + (i === cur ? ' sel' : '')}
                        onMouseDown={() => onSearch('')}
                      >
                        <Fav b={r.bookmark} small />
                        <span style={{ color: 'var(--tx)' }}>{r.bookmark.name}</span>
                        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
                          {host(r.url)}
                        </span>
                      </a>
                    ) : (
                      <div
                        role="option"
                        aria-selected={i === cur}
                        className={'search-row' + (i === cur ? ' sel' : '')}
                        style={{ color: 'var(--t2)', cursor: 'pointer' }}
                        onMouseDown={() => open(r.url)}
                      >
                        <span className="fav sm">{r.engine!.name[0]}</span>
                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {prefixed || i === firstEngine ? (
                            <>
                              Search {r.engine!.name} for <b style={{ fontWeight: 600, color: 'var(--tx)' }}>{r.term}</b>
                            </>
                          ) : (
                            r.engine!.name
                          )}
                        </span>
                        <span className="kbd" style={{ marginLeft: 'auto' }}>
                          {i === cur ? '↵' : r.engine!.prefix}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
                {!prefixed && <div className="search-foot">Start with a prefix and a space, like “{engines[1]?.prefix ?? 'g'} …”</div>}
              </div>
            )}
          </div>
          {data.learn.timer && !hidden.includes('view:learn') && (
            <button
              className="cig-btn tnum on"
              title={`Studying ${data.learn.courses.find((c) => c.id === data.learn.timer!.courseId)?.name ?? 'general'} since ${hm(new Date(data.learn.timer.start))}. Open Learn (G then L).`}
              aria-label="Studying. Open Learn."
              onClick={onOpenLearn}
            >
              <i className="ph-duotone ph-timer" aria-hidden="true" />
              <span>{fmtStudy(timerMinutes(data.learn.timer, now))}</span>
            </button>
          )}
          {!hidden.includes('top:cig') && (
            <button className="cig-btn tnum" title="Log a cigarette (C)" aria-label={`Log a cigarette. ${smokesToday} today.`} onClick={onLogSmoke}>
              <i className="ph-duotone ph-cigarette" aria-hidden="true" />
              <span>{smokesToday}</span>
            </button>
          )}
          {trained && !hidden.includes('top:training') && !hidden.includes('view:training') && (
            <button
              className={'cig-btn tnum' + (trained.days >= TRAINING_NUDGE_DAYS ? ' warn' : '')}
              title={`Last trained ${trainedWhen(trained.days)}: ${workoutLabel(trained.workout, data.exerciseMuscles)}, ${fmtMinutes(minutes(trained.workout))}. Open Training (G then T).`}
              aria-label={`Last trained ${trainedWhen(trained.days)}. Open Training.`}
              onClick={onOpenTraining}
            >
              <i className="ph-duotone ph-barbell" aria-hidden="true" />
              <span>{trained.days === 0 ? 'Today' : `${trained.days}d`}</span>
            </button>
          )}
          <div className="sync" onMouseEnter={() => setSyncHover(true)} onMouseLeave={() => setSyncHover(false)}>
            <span className="sync-dot" style={{ background: dot }} />
            {syncHover && (
              <div className="popover sync-tip">
                {lines.map((l) => (
                  <Fragment key={l.name}>
                    <div className="sync-line">
                      <span style={{ color: 'var(--t2)' }}>{l.name}</span>
                      <span style={{ color: l.warn ? 'var(--wn)' : 'var(--t3)', textAlign: 'right' }}>{l.text}</span>
                    </div>
                    {'why' in l && l.why && <div className="sync-err">{l.why}</div>}
                  </Fragment>
                ))}
              </div>
            )}
          </div>

        </div>
      </div>
    </header>
  );
}

export function Fav({ b, small }: { b: Bookmark; small?: boolean }) {
  const src = favicon(b);
  const [ok, setOk] = useState(true);
  return (
    <span className={'fav' + (small ? ' sm' : '')}>
      {(b.name || '?')[0]}
      {src && ok && <img src={src} alt="" onError={() => setOk(false)} />}
    </span>
  );
}
