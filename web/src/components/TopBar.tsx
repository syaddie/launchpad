import { useEffect, useRef, useState } from 'react';
import type { AppState, Bookmark, SourceKey, Weather } from '../../../shared/types';
import { ago, favicon, fmtDay, hm, host, weatherIcon, weatherLabel } from '../util';

interface Props {
  data: AppState;
  now: Date;
  subline: string;
  search: string;
  onSearch: (q: string) => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onOpenSettings: () => void;
  newsOpen: boolean;
  onToggleNews: () => void;
}

export function matchBookmark(b: Bookmark, q: string): boolean {
  return !q || b.name.toLowerCase().includes(q) || b.url.toLowerCase().includes(q);
}

function Clock({ weather }: { weather: Weather | null }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const iv = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(iv);
  }, []);
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <span className="serif clock">{hm(now)}</span>
      <span className="tnum" style={{ fontSize: 13, color: 'var(--t2)', whiteSpace: 'nowrap' }}>
        {fmtDay(now)} · {tzLabel()}
      </span>
      {weather && <WeatherNow w={weather} now={now} />}
    </div>
  );
}

function WeatherNow({ w, now }: { w: Weather; now: Date }) {
  // Hide a reading the sync has stopped refreshing rather than show old weather as current.
  if (now.getTime() - Date.parse(w.issuedAt) > 3 * 3600_000) return null;
  const night = /\(night\)/i.test(w.forecast) || now.getHours() >= 19 || now.getHours() < 7;
  const label = weatherLabel(w.forecast);
  const until = w.validUntil ? ` until ${hm(new Date(w.validUntil))}` : '';
  const title = [`${label} in ${w.area}${until}`, w.tempC !== null && w.station ? `${w.tempC.toFixed(1)}°C at ${w.station}` : '']
    .filter(Boolean)
    .join('\n');
  return (
    <span className="weather tnum" title={title}>
      <i className={'ph-duotone ' + weatherIcon(w.forecast, night)} aria-hidden="true" />
      {w.tempC !== null && <span>{Math.round(w.tempC)}°</span>}
      <span className="weather-text">{label}</span>
    </span>
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

export function TopBar({ data, now, subline, search, onSearch, searchRef, onOpenSettings, newsOpen, onToggleNews }: Props) {
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState(0);
  const [syncHover, setSyncHover] = useState(false);
  const blurT = useRef<number>(0);

  const hr = now.getHours();
  const greeting = hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';

  const q = search.trim().toLowerCase();
  const results = q ? data.bookmarks.flatMap((g) => g.items).filter((b) => matchBookmark(b, q)).slice(0, 6) : [];
  const cur = Math.min(sel, results.length);

  const open = (url: string) => {
    window.open(url, '_blank', 'noopener');
    onSearch('');
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel(Math.min(cur + 1, results.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(cur - 1, 0));
    } else if (e.key === 'Escape') {
      onSearch('');
      e.currentTarget.blur();
    } else if (e.key === 'Enter' && search.trim()) {
      const r = results[cur];
      open(r ? r.url : 'https://www.google.com/search?q=' + encodeURIComponent(search.trim()));
    }
  };

  // Sync dot: quiet when fresh, warning when any source fails, faint when not connected.
  const sources: { key: SourceKey; name: string; ok: string }[] = [
    { key: 'calendar', name: 'Calendar', ok: 'Synced' },
    { key: 'tasks', name: 'Tasks', ok: 'Synced' },
    { key: 'gmail', name: 'Gmail packages', ok: 'Checked' },
    { key: 'carriers', name: 'Carriers', ok: 'Updated' },
    { key: 'news', name: 'News', ok: 'Updated' },
    { key: 'weather', name: 'Weather', ok: 'Updated' },
  ];
  const needsGoogle = (k: SourceKey) => k === 'calendar' || k === 'tasks' || k === 'gmail';
  const connected = data.google.connected;
  const lines = sources
    .filter((s) => connected || !needsGoogle(s.key))
    .map((s) => {
      const st = data.sync[s.key];
      const off =
        s.key === 'news' ? !data.prefs.newsTopics.length : s.key === 'weather' ? !data.prefs.weatherArea : needsGoogle(s.key) && !data.prefs.sources[s.key as 'calendar'];
      if (off) return { name: s.name, text: 'Off', warn: false };
      if (failing(st)) return { name: s.name, text: `Couldn’t sync · last synced ${ago(st.lastSuccess, now)}`, warn: true };
      return { name: s.name, text: st.lastSuccess ? `${s.ok} ${ago(st.lastSuccess, now)}` : 'Waiting for first sync', warn: false };
    });
  if (!connected) lines.unshift({ name: 'Google', text: 'Not connected', warn: false });
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
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '15px 30px', flexWrap: 'wrap' }}>
        <Clock weather={data.prefs.weatherArea ? data.weather.now : null} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
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
            {q && focused && (
              <div className="popover search-drop">
                {results.map((b, i) => (
                  <a
                    key={b.id}
                    href={b.url}
                    target="_blank"
                    rel="noopener"
                    className={'search-row' + (i === cur ? ' sel' : '')}
                    onMouseDown={() => onSearch('')}
                  >
                    <Fav b={b} small />
                    <span style={{ color: 'var(--tx)' }}>{b.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 120 }}>
                      {host(b.url)}
                    </span>
                  </a>
                ))}
                <div
                  className={'search-row' + (cur === results.length ? ' sel' : '')}
                  style={{ color: 'var(--t2)', cursor: 'pointer' }}
                  onMouseDown={() => open('https://www.google.com/search?q=' + encodeURIComponent(search.trim()))}
                >
                  <i className="ph-duotone ph-globe-simple" style={{ fontSize: 16 }} />
                  <span>Search the web for “{search.trim()}”</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--t3)' }}>↵</span>
                </div>
              </div>
            )}
          </div>
          <div className="sync" onMouseEnter={() => setSyncHover(true)} onMouseLeave={() => setSyncHover(false)}>
            <span className="sync-dot" style={{ background: dot }} />
            {syncHover && (
              <div className="popover sync-tip">
                {lines.map((l) => (
                  <div key={l.name} className="sync-line">
                    <span style={{ color: 'var(--t2)' }}>{l.name}</span>
                    <span style={{ color: l.warn ? 'var(--wn)' : 'var(--t3)', textAlign: 'right' }}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button className={'icon-btn lg' + (newsOpen ? ' on' : '')} title={newsOpen ? 'Back to dashboard (N)' : 'News (N)'} aria-pressed={newsOpen} onClick={onToggleNews}>
            <i className="ph-duotone ph-newspaper" />
          </button>
          <button className="icon-btn lg" title="Settings" onClick={onOpenSettings}>
            <i className="ph-duotone ph-gear-six" />
          </button>
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
