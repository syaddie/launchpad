import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExplainResult, ExplainStatus } from '../../../shared/types';
import { api } from '../api';

// Explain this log: a button that sends the end of a log to Claude (on the server, with
// secrets taken out) and a box with what it made of it. Used by the Minecraft tab and the
// containers' logs. Without an API key the button isn't shown; over the budget it says why.

let statusCache: { at: number; p: Promise<ExplainStatus> } | null = null;

/** Whether Explain can run, asked at most once a minute across the page. */
export function useExplainStatus(): ExplainStatus | null {
  const [status, setStatus] = useState<ExplainStatus | null>(null);
  useEffect(() => {
    if (!statusCache || Date.now() - statusCache.at > 60_000) {
      const p = api.explainStatus();
      statusCache = { at: Date.now(), p };
      p.catch(() => statusCache?.p === p && (statusCache = null));
    }
    let on = true;
    statusCache.p.then((s) => on && setStatus(s)).catch(() => {});
    return () => {
      on = false;
    };
  }, []);
  return status;
}

export type ExplainState = { busy: true } | { busy: false; result: ExplainResult } | { busy: false; error: string };

/** The state of one explanation, and the function that starts one. A newer start wins over an older one still on its way. */
export function useExplain(status: ExplainStatus | null) {
  const [state, setState] = useState<ExplainState | null>(null);
  const n = useRef(0);
  useEffect(
    () => () => {
      n.current++;
    },
    [],
  );
  const start = useCallback(
    (run: () => Promise<ExplainResult>) => {
      if (status && !status.ready) return setState({ busy: false, error: status.reason ?? 'Explaining isn’t available.' });
      const mine = ++n.current;
      setState({ busy: true });
      run()
        .then((result) => mine === n.current && setState({ busy: false, result }))
        .catch((e: Error) => mine === n.current && setState({ busy: false, error: e.message }));
    },
    [status],
  );
  const close = useCallback(() => {
    n.current++;
    setState(null);
  }, []);
  return { state, start, close };
}

/** The button; nothing at all when there's no API key. */
export function ExplainButton({ status, busy, onClick, label = 'Explain', small = true, title }: { status: ExplainStatus | null; busy: boolean; onClick: () => void; label?: string; small?: boolean; title?: string }) {
  if (!status?.configured) return null;
  return (
    <button className={'btn btn-secondary' + (small ? ' btn-small' : '')} disabled={busy} onClick={onClick} title={title ?? 'Ask Claude what the last error means and how to fix it'}>
      <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-sparkle')} />
      {busy ? 'Explaining…' : label}
    </button>
  );
}

/** The answer, the error, or that it's on its way. */
export function ExplainBox({ state, onClose, onRetry }: { state: ExplainState; onClose: () => void; onRetry?: () => void }) {
  const [copied, setCopied] = useState(false);
  const r = 'result' in state ? state.result : null;
  const copy = () => {
    if (!r) return;
    const text = [r.summary, '', `Likely cause: ${r.cause}`, ...(r.fix.length ? ['', 'How to fix it:', ...r.fix.map((f, i) => `${i + 1}. ${f}`)] : [])].join('\n');
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  return (
    <div className="explain" role="region" aria-label="What Claude made of the log" aria-busy={state.busy}>
      <div className="explain-head">
        <span className="drawer-label">
          <i className="ph-duotone ph-sparkle" aria-hidden /> {state.busy ? 'Asking Claude…' : 'error' in state ? 'Couldn’t explain it' : 'Explained by Claude'}
        </span>
        <span style={{ display: 'inline-flex', gap: 2 }}>
          {r && (
            <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} aria-label="Copy the explanation" onClick={copy}>
              <i className={'ph-duotone ' + (copied ? 'ph-check' : 'ph-copy')} />
            </button>
          )}
          {onRetry && !state.busy && (
            <button className="icon-btn" title="Ask again" aria-label="Explain again" onClick={onRetry}>
              <i className="ph-duotone ph-arrow-clockwise" />
            </button>
          )}
          <button className="icon-btn" title="Close" aria-label="Close the explanation" onClick={onClose}>
            <i className="ph-duotone ph-x" />
          </button>
        </span>
      </div>
      {state.busy && <p className="meta" style={{ margin: 0 }}>Sending it to Claude, secrets taken out…</p>}
      {'error' in state && (
        <div className="status-line" style={{ margin: 0 }}>
          {state.error}
        </div>
      )}
      {r && (
        <>
          <p className="explain-summary">{r.summary}</p>
          {!r.foundError && <p className="meta" style={{ margin: 0 }}>There was no clear error in the log, so Claude read its last lines.</p>}
          <div>
            <span className="drawer-label">Likely cause</span>
            <p className="explain-text">{r.cause}</p>
          </div>
          {r.fix.length > 0 && (
            <div>
              <span className="drawer-label">How to fix it</span>
              <ol className="explain-fix">
                {r.fix.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ol>
            </div>
          )}
          <details>
            <summary className="meta">What was sent to Claude (secrets taken out)</summary>
            <pre className="mono explain-pre">{r.excerpt}</pre>
          </details>
          <span className="meta">Claude can be wrong: check before you change things.</span>
        </>
      )}
    </div>
  );
}
