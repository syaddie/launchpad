import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MON } from '../../../shared/dates';
import type { ContainerInfo, LogLine } from '../../../shared/types';
import { api, localGet, localSet } from '../api';

const SELF_NOTE = 'This is Launchpad itself, which can’t restart itself from here. On the server: docker compose restart launchpad';

/** Restart, after a second click to confirm. */
function RestartButton({ c, onDone, label }: { c: ContainerInfo; onDone: (error: string | null) => void; label?: boolean }) {
  const [state, setState] = useState<'idle' | 'confirm' | 'busy'>('idle');
  useEffect(() => {
    if (state !== 'confirm') return;
    const t = window.setTimeout(() => setState('idle'), 4000);
    return () => clearTimeout(t);
  }, [state]);

  if (c.self) {
    return (
      <button className={label ? 'btn btn-secondary btn-small' : 'icon-btn'} disabled title={SELF_NOTE} style={{ opacity: 0.4, cursor: 'default' }}>
        <i className="ph-duotone ph-arrow-clockwise" />
        {label && 'Restart'}
      </button>
    );
  }
  const click = () => {
    if (state === 'idle') return setState('confirm');
    if (state !== 'confirm') return;
    setState('busy');
    api
      .restartContainer(c.id)
      .then(() => onDone(null))
      .catch((e) => onDone(e.message))
      .finally(() => setState('idle'));
  };
  if (state === 'idle' && !label) {
    return (
      <button className="icon-btn" title={`Restart ${c.name}`} aria-label={`Restart ${c.name}`} onClick={click}>
        <i className="ph-duotone ph-arrow-clockwise" />
      </button>
    );
  }
  return (
    <button className={'btn btn-small ' + (state === 'idle' ? 'btn-secondary' : 'btn-primary')} disabled={state === 'busy'} onClick={click} title={state === 'confirm' ? 'Click again to restart it' : undefined}>
      <i className={'ph-duotone ' + (state === 'busy' ? 'ph-circle-notch spin' : 'ph-arrow-clockwise')} />
      {state === 'busy' ? 'Restarting…' : state === 'confirm' ? 'Restart?' : 'Restart'}
    </button>
  );
}

const chipOf = (c: ContainerInfo) => {
  const up = c.state === 'running';
  const unhealthy = /unhealthy/i.test(c.status);
  return {
    dot: up && !unhealthy ? 'var(--ac)' : up ? 'var(--wn)' : 'var(--ln)',
    cls: unhealthy ? 'chip-warn' : up ? 'chip-accent' : 'chip-muted',
    text: unhealthy ? 'Unhealthy' : up ? 'Running' : c.state[0].toUpperCase() + c.state.slice(1),
  };
};

/** One container in the Services panel, with its logs and, when the restart proxy is there, a restart. */
export function ContainerRow({ c, canRestart, onLogs, onRestarted }: { c: ContainerInfo; canRestart: boolean; onLogs: () => void; onRestarted: (error: string | null) => void }) {
  const chip = chipOf(c);
  return (
    <div className="container-row">
      <span className="dot" style={{ width: 8, height: 8, background: chip.dot }} />
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <span className="mono" style={{ fontSize: 13 }}>
          {c.name}
        </span>
        <span className="meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {c.status}
        </span>
      </div>
      <span className={'chip ' + chip.cls}>{chip.text}</span>
      <span className="container-tools">
        {/* A reading cached by an older Launchpad has no ids until the next one arrives. */}
        {c.id && (
          <button className="icon-btn" title={`Logs of ${c.name}`} aria-label={`Logs of ${c.name}`} onClick={onLogs}>
            <i className="ph-duotone ph-scroll" />
          </button>
        )}
        {canRestart && c.id && <RestartButton c={c} onDone={onRestarted} />}
      </span>
    </div>
  );
}

// ---------- logs ----------

const TAILS = [100, 500, 1000, 5000];
const FOLLOW_EVERY = 2500;

/** Lines from a follow-up read that aren't on screen yet: Docker's `since` repeats lines from that very moment. */
export function newLines(have: LogLine[], got: LogLine[]): LogLine[] {
  const last = have.length ? have[have.length - 1].at : null;
  if (!last) return got;
  const atLast = new Set(have.filter((l) => l.at === last).map((l) => l.stream + l.text));
  return got.filter((l) => !l.at || l.at > last || (l.at === last && !atLast.has(l.stream + l.text)));
}

/** A log timestamp in local time: the time today, with the date on other days. */
function when(at: string, today: Date): { short: string; full: string } {
  const d = new Date(at.slice(0, 23) + 'Z');
  const p = (n: number) => String(n).padStart(2, '0');
  const time = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const sameDay = d.toDateString() === today.toDateString();
  return { short: sameDay ? time : `${d.getDate()} ${MON[d.getMonth()]} ${time}`, full: `${d.toLocaleString()} · ${at}` };
}

function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const lower = text.toLowerCase();
  const parts: React.ReactNode[] = [];
  for (let i = 0; ; ) {
    const j = lower.indexOf(q, i);
    if (j < 0) {
      parts.push(text.slice(i));
      break;
    }
    parts.push(text.slice(i, j), <mark key={j}>{text.slice(j, j + q.length)}</mark>);
    i = j + q.length;
  }
  return <>{parts}</>;
}

/** A container's log, last lines first loaded, then followed every few seconds. */
export function LogsDrawer({ c, canRestart, onClose, onRestarted }: { c: ContainerInfo; canRestart: boolean; onClose: () => void; onRestarted: (error: string | null) => void }) {
  const [tail, setTail] = useState(() => TAILS.find((t) => String(t) === localGet('logTail')) ?? 500);
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [follow, setFollow] = useState(true);
  const [streams, setStreams] = useState<'all' | 'out' | 'err'>('all');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const linesRef = useRef<LogLine[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const search = useRef<HTMLInputElement>(null);
  const chip = chipOf(c);

  const show = (next: LogLine[]) => {
    linesRef.current = next;
    setLines(next);
  };

  const reload = useCallback(() => {
    setLoading(true);
    atBottom.current = true;
    api
      .containerLogs(c.id, tail)
      .then((l) => {
        show(l);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [c.id, tail]);

  useEffect(reload, [reload]);

  // Following asks only for lines since the last one on screen.
  useEffect(() => {
    if (!follow) return;
    const iv = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      const have = linesRef.current;
      const since = have[have.length - 1]?.at ?? undefined;
      api
        .containerLogs(c.id, tail, since)
        .then((got) => {
          const add = newLines(linesRef.current, got);
          if (add.length) show([...linesRef.current, ...add].slice(-tail));
          setError('');
        })
        .catch((e) => setError(e.message));
    }, FOLLOW_EVERY);
    return () => clearInterval(iv);
  }, [follow, c.id, tail]);

  // Stay at the bottom while following, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, streams, query]);

  // Esc clears the search, then closes; it never reaches the page, which would go back home.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (search.current?.value) setQuery('');
      else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const pickTail = (n: number) => {
    setTail(n);
    localSet('logTail', String(n));
  };

  const q = query.trim().toLowerCase();
  const all = lines ?? [];
  const shown = all.filter((l) => (streams === 'all' || l.stream === streams) && (!q || l.text.toLowerCase().includes(q)));
  const today = new Date();

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer logs-drawer" role="dialog" aria-label={`Logs of ${c.name}`}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <span className="dot" style={{ width: 8, height: 8, background: chip.dot, flex: 'none' }} />
            <h2 className="drawer-title mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.name}
            </h2>
            <span className={'chip ' + chip.cls}>{chip.text}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {canRestart && (
              <RestartButton
                c={c}
                label
                onDone={(err) => {
                  onRestarted(err);
                  if (!err) atBottom.current = true;
                }}
              />
            )}
            <button className="icon-btn md" title="Close" onClick={onClose}>
              <i className="ph-duotone ph-x" />
            </button>
          </div>
        </div>
        <div className="logs-tools">
          <span className="meta mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }} title={c.image}>
            {c.image} · {c.status}
          </span>
          <label className="logs-search">
            <i className="ph-duotone ph-magnifying-glass" />
            <input ref={search} className="input sm" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the log" />
          </label>
          <select className="input sm" value={streams} onChange={(e) => setStreams(e.target.value as typeof streams)} aria-label="Which output">
            <option value="all">stdout and stderr</option>
            <option value="out">stdout only</option>
            <option value="err">stderr only</option>
          </select>
          <select className="input sm" value={tail} onChange={(e) => pickTail(Number(e.target.value))} aria-label="How many lines">
            {TAILS.map((t) => (
              <option key={t} value={t}>
                Last {t.toLocaleString()} lines
              </option>
            ))}
          </select>
          <button className={'btn btn-small ' + (follow ? 'btn-primary' : 'btn-secondary')} aria-pressed={follow} onClick={() => setFollow((f) => !f)} title="Add new lines as they’re written">
            <i className={'ph-duotone ' + (follow ? 'ph-pause' : 'ph-play')} />
            {follow ? 'Following' : 'Follow'}
          </button>
          <button className="btn btn-secondary btn-small" onClick={reload} disabled={loading}>
            <i className={'ph-duotone ' + (loading ? 'ph-circle-notch spin' : 'ph-arrow-clockwise')} />
            Refresh
          </button>
        </div>
        {error && <div className="status-line" style={{ margin: '0 30px 8px' }}>{error}</div>}
        <div
          ref={scroller}
          className="logs-body mono"
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {lines === null ? (
            <p className="meta">{error ? '' : 'Reading the log…'}</p>
          ) : !shown.length ? (
            <p className="meta">{all.length ? 'No lines match.' : 'Nothing in the log yet.'}</p>
          ) : (
            shown.map((l, i) => {
              const t = l.at ? when(l.at, today) : null;
              return (
                <div key={i} className={'log-line' + (l.stream === 'err' ? ' err' : '')}>
                  <time title={t?.full}>{t?.short ?? ''}</time>
                  <span>
                    <Highlight text={l.text} q={q} />
                  </span>
                </div>
              );
            })
          )}
        </div>
        <div className="logs-foot meta">
          <span>
            {q || streams !== 'all' ? `${shown.length.toLocaleString()} of ${all.length.toLocaleString()} lines` : `${all.length.toLocaleString()} lines`}
            {follow ? ' · new lines every few seconds' : ''}
          </span>
          <span>
            <span className="legend-err" /> stderr
          </span>
        </div>
      </aside>
    </>
  );
}
