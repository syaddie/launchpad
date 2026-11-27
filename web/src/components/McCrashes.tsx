import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainStatus, McCrashes, McRestart, McServer, McStatus } from '../../../shared/types';
import { api } from '../api';
import { ExplainBox, ExplainButton, useExplain } from './Explain';
import { fmtSize, fmtWhen } from './McBackups';

const EVERY = 20_000;
const KIND_ICON: Record<McRestart['kind'], string> = { crash: 'ph-warning', restart: 'ph-arrow-clockwise', 'gave-up': 'ph-hand' };

/** The saved server behind a status, as the form would save it. screen's pid.name goes back to the name. */
export function savedOf(s: McStatus): McServer {
  const { id, name, dir, mux, start, autoRestart, keepBackups, backupDir } = s;
  return { id, name, dir, mux, session: mux === 'screen' ? s.session.replace(/^\d+\./, '') : s.session, start, autoRestart, keepBackups, backupDir };
}

/** The Minecraft console's Crashes: Restart if it crashes, what it has done, and the crash reports. */
export function McCrashesView({ s, explain, open, onOpen, onSaved }: { s: McStatus; explain: ExplainStatus | null; open: string | null; onOpen: (name: string | null) => void; onSaved: (l: McStatus[]) => void }) {
  const [data, setData] = useState<McCrashes | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const load = useCallback(() => {
    api
      .mcCrashes(s.id)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError('');
      })
      .catch((e: Error) => alive.current && setError(e.message));
  }, [s.id]);

  useEffect(() => {
    load();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), EVERY);
    return () => clearInterval(iv);
  }, [load, s.running, s.gaveUp]);

  const toggle = () => {
    setSaving(true);
    api
      .editMcServer({ ...savedOf(s), autoRestart: !s.autoRestart })
      .then((l) => {
        onSaved(l);
        load();
      })
      .catch((e: Error) => alive.current && setError(e.message))
      .finally(() => alive.current && setSaving(false));
  };

  if (open) return <CrashReader s={s} name={open} explain={explain} onBack={() => onOpen(null)} />;

  const now = new Date();
  return (
    <div className="mc-view" aria-label="Crashes">
      {s.saved ? (
        <div className="mc-auto">
          <div className="mc-auto-text">
            <span id={`mc-auto-${s.id}`}>Restart if it crashes</span>
            <span className="meta">{s.start ? 'Starts it again when it stops on its own, up to 3 times in 15 minutes. A stop from here or a clean stop doesn’t count.' : 'Add a start command under Edit first: that’s what a restart types.'}</span>
          </div>
          <button type="button" role="switch" aria-checked={!!s.autoRestart} aria-labelledby={`mc-auto-${s.id}`} className={'switch' + (s.autoRestart ? ' on' : '')} disabled={saving || !s.start} onClick={toggle} style={!s.start ? { opacity: 0.5, cursor: 'default' } : undefined}>
            <span />
          </button>
        </div>
      ) : (
        <p className="meta mc-note">Save this server to have Launchpad restart it if it crashes.</p>
      )}
      {(data?.gaveUp ?? s.gaveUp) && (
        <div className="mc-job failed" role="status">
          <i className="ph-duotone ph-hand" aria-hidden />
          <div className="mc-job-text">
            <span>Launchpad gave up restarting {s.name}: it crashed too many times in a row.</span>
            <span className="meta">Fix the cause (Diagnose and the newest crash report below can help), then start it yourself. Restarts pick up again once it’s running.</span>
          </div>
        </div>
      )}
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      {!!data?.restarts.length && (
        <section className="mc-section" aria-label="Recent restarts">
          <span className="drawer-label">Recently</span>
          <ul className="mc-restarts">
            {data.restarts.map((r, i) => (
              <li key={i} className={'mc-restart ' + r.kind}>
                <i className={'ph-duotone ' + KIND_ICON[r.kind]} aria-hidden />
                <time className="meta mono">{fmtWhen(r.at, now)}</time>
                <span>{r.reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="mc-section" aria-label="Crash reports">
        <span className="drawer-label">Crash reports{data ? ` · ${data.reports.length}${data.reports.length >= 50 ? '+' : ''}` : ''}</span>
        {!data && !error && <p className="meta lp-loading">Looking in crash-reports…</p>}
        {data && !data.reports.length && <p className="meta">No crash reports in {s.dir ? `${s.dir}/crash-reports` : 'crash-reports'}. That’s good.</p>}
        {!!data?.reports.length && (
          <ul className="mc-crashes">
            {data.reports.map((c) => (
              <li key={c.name}>
                <button className="mc-crash-row" onClick={() => onOpen(c.name)}>
                  <i className="ph-duotone ph-file-text" aria-hidden />
                  <span className="mc-crash-text">
                    <span>{fmtWhen(c.at, now)}</span>
                    <span className="meta mono">{c.name}</span>
                  </span>
                  <span className="meta">{fmtSize(c.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** One whole crash report, to read and to explain. */
function CrashReader({ s, name, explain, onBack }: { s: McStatus; name: string; explain: ExplainStatus | null; onBack: () => void }) {
  const [data, setData] = useState<{ text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const ex = useExplain(explain);
  useEffect(() => {
    let on = true;
    setData(null);
    api
      .mcCrash(s.id, name)
      .then((d) => on && (setData(d), setError('')))
      .catch((e: Error) => on && setError(e.message));
    return () => {
      on = false;
    };
  }, [s.id, name]);
  const run = () => ex.start(() => api.mcExplain(s.id, name));
  return (
    <div className="mc-view mc-reader" aria-label={`Crash report ${name}`}>
      <div className="mc-view-head">
        <button className="btn btn-secondary btn-small" onClick={onBack}>
          <i className="ph-duotone ph-arrow-left" />
          Crash reports
        </button>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0 }}>
          <ExplainButton status={explain} busy={!!ex.state?.busy} onClick={run} label="Explain this crash" />
          <button className="icon-btn" title="Copy the report" aria-label="Copy the report" disabled={!data} onClick={() => data && navigator.clipboard?.writeText(data.text).catch(() => {})}>
            <i className="ph-duotone ph-copy" />
          </button>
        </span>
      </div>
      <span className="meta mono mc-view-where" title={name}>
        {name}
      </span>
      {ex.state && <ExplainBox state={ex.state} onClose={ex.close} onRetry={run} />}
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      {!data && !error && <p className="meta lp-loading">Reading the report…</p>}
      {data && (
        <>
          <pre className="mono mc-report">{data.text}</pre>
          {data.truncated && <span className="meta">That’s the first 1 MB; the rest is in Files.</span>}
        </>
      )}
    </div>
  );
}
