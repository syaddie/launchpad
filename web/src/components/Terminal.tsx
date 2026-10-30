import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { authorizeLine, Copyable, keyRefused } from './Copyable';

const SESSION_KEY = 'launchpad:terminal';

// Kept per tab, so a reload or a trip to another view picks up the same shell,
// while a second tab gets a shell of its own.
function savedSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY);
  } catch {
    return null;
  }
}

function saveSession(id: string | null): void {
  try {
    if (id) sessionStorage.setItem(SESSION_KEY, id);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: every visit starts a new shell.
  }
}

// ANSI colours picked to read on the panel in each theme.
const LIGHT: ITheme = {
  black: '#22201e', red: '#ad432c', green: '#4b7340', yellow: '#8f6500', blue: '#3c5f8f', magenta: '#8a4a86', cyan: '#2f7676', white: '#77716a',
  brightBlack: '#5c5853', brightRed: '#c4502f', brightGreen: '#5a8a45', brightYellow: '#a87800', brightBlue: '#4e6a8d', brightMagenta: '#9c5698', brightCyan: '#3a8888', brightWhite: '#a39d95',
};
const DARK: ITheme = {
  black: '#3a3835', red: '#e5957c', green: '#9cb99a', yellow: '#e0c07a', blue: '#a0b5d2', magenta: '#c9a3c8', cyan: '#8fc4c0', white: '#ebe7e1',
  brightBlack: '#8d877f', brightRed: '#f0ad97', brightGreen: '#b6cfb3', brightYellow: '#ecd29a', brightBlue: '#bdcce2', brightMagenta: '#dbbcda', brightCyan: '#a9d6d2', brightWhite: '#ffffff',
};

function theme(): ITheme {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    ...(root.dataset.mode === 'dark' ? DARK : LIGHT),
    background: v('--rz'),
    foreground: v('--tx'),
    cursor: v('--ac'),
    cursorAccent: v('--rz'),
    selectionBackground: v('--act'),
  };
}

/** Quoted for the shell, for `cd` into a folder picked in Files. */
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

type Status = 'connecting' | 'open' | 'ended' | 'taken' | 'error';

/** A shell on the server, over /api/terminal. It stays mounted while hidden so the screen is kept between tabs. */
export function TerminalPanel({ target, publicKey, hidden, cd, onFailed }: {
  target: string;
  publicKey: string;
  hidden: boolean;
  /** A folder to `cd` into; `n` changes each time, so the same folder can be sent twice. */
  cd: { path: string; n: number } | null;
  /** The connection was refused: the parent checks whether the host key changed. */
  onFailed: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const retries = useRef(0);
  const retryTimer = useRef(0);
  const pendingCd = useRef<string | null>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const send = (data: string | Uint8Array<ArrayBuffer>) => {
    const sock = ws.current;
    if (sock?.readyState === WebSocket.OPEN) sock.send(data);
  };
  const type = (text: string) => send(new TextEncoder().encode(text));

  const connect = useCallback(() => {
    const t = term.current;
    if (!t) return;
    clearTimeout(retryTimer.current);
    setStatus('connecting');
    setError('');
    const id = savedSession();
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const sock = new WebSocket(`${proto}://${location.host}/api/terminal?cols=${t.cols}&rows=${t.rows}${id ? `&session=${encodeURIComponent(id)}` : ''}`);
    sock.binaryType = 'arraybuffer';
    ws.current = sock;
    let ended: Status | null = null;
    sock.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        t.write(new Uint8Array(e.data as ArrayBuffer));
        return;
      }
      const m = JSON.parse(e.data) as { type: string; id?: string; message?: string };
      if (m.type === 'session') {
        saveSession(m.id!);
        // A resumed shell replays its recent output next, so start from a clean screen either way.
        t.reset();
        retries.current = 0;
        setStatus('open');
        if (pendingCd.current) {
          sock.send(new TextEncoder().encode(`cd -- ${quote(pendingCd.current)}\r`));
          pendingCd.current = null;
        }
      } else if (m.type === 'exit') {
        ended = 'ended';
        saveSession(null);
      } else if (m.type === 'taken') {
        ended = 'taken';
      } else if (m.type === 'error') {
        ended = 'error';
        setError(m.message || 'Couldn’t open a shell.');
        onFailedRef.current();
      }
    };
    sock.onclose = () => {
      if (ws.current !== sock) return;
      ws.current = null;
      if (ended) {
        setStatus(ended);
        return;
      }
      // Dropped by a deploy or the network: the shell is still on the server, so try again for a while.
      if (retries.current < 5) {
        setStatus('connecting');
        retryTimer.current = window.setTimeout(connect, 1000 * 2 ** retries.current++);
      } else {
        setStatus('error');
        setError('Lost the connection to Launchpad.');
      }
    };
  }, []);

  useEffect(() => {
    const t = new XTerm({
      fontFamily: "'Geist Mono', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    term.current = t;
    fit.current = f;
    // Ctrl Shift C and V copy and paste, as in desktop terminals; plain Ctrl C stays an interrupt.
    t.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC' && t.hasSelection()) {
        navigator.clipboard?.writeText(t.getSelection()).catch(() => {});
        return false;
      }
      // Leave it to the browser, which fires a paste the terminal picks up.
      return e.code !== 'KeyV';
    });
    const input = t.onData((d) => type(d));
    const resize = t.onResize(({ cols, rows }) => send(JSON.stringify({ type: 'resize', cols, rows })));
    const refit = () => box.current?.offsetParent && f.fit();
    const ro = new ResizeObserver(refit);
    ro.observe(box.current!);
    const mo = new MutationObserver(() => (t.options.theme = theme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-accent'] });
    // Open once the font is in, so the cells are measured with it rather than the fallback.
    const font = document.fonts ? document.fonts.load("13px 'Geist Mono'").catch(() => {}) : Promise.resolve();
    font.then(() => {
      if (term.current !== t) return;
      t.open(box.current!);
      refit();
      connect();
    });
    return () => {
      clearTimeout(retryTimer.current);
      ro.disconnect();
      mo.disconnect();
      input.dispose();
      resize.dispose();
      const sock = ws.current;
      ws.current = null;
      sock?.close();
      term.current = null;
      t.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connect]);

  useEffect(() => {
    if (hidden) return;
    fit.current?.fit();
    term.current?.focus();
  }, [hidden]);

  useEffect(() => {
    if (!cd) return;
    if (status === 'open') type(`cd -- ${quote(cd.path)}\r`);
    else pendingCd.current = cd.path;
    term.current?.focus();
    // Only when a new folder is sent, not when the status changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cd?.n]);

  /** End this shell and start a fresh one. */
  const restart = () => {
    const sock = ws.current;
    ws.current = null;
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'close' }));
    sock?.close();
    saveSession(null);
    retries.current = 0;
    connect();
  };

  const overlay =
    status === 'ended'
      ? { text: 'The shell ended.', button: 'Start a new shell', run: restart }
      : status === 'taken'
        ? { text: 'This shell is open in another tab now.', button: 'Use it here', run: connect }
        : status === 'error'
          ? { text: error, button: 'Try again', run: () => ((retries.current = 0), connect()) }
          : null;

  return (
    <section className="panel srv-panel term-panel" aria-label="Terminal" style={hidden ? { display: 'none' } : undefined}>
      <div className="panel-head">
        <h2 className="panel-title">Terminal</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="meta mono" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {status === 'connecting' ? (
              <i className="ph-duotone ph-circle-notch spin" />
            ) : (
              <span className="dot" style={{ width: 8, height: 8, background: status === 'open' ? 'var(--ac)' : 'var(--ln)' }} />
            )}
            {target}
          </span>
          <button className="btn btn-secondary btn-small" onClick={restart} title="End this shell and start a new one">
            <i className="ph-duotone ph-arrow-counter-clockwise" />
            Restart
          </button>
        </div>
      </div>
      <div className="term-wrap">
        <div ref={box} className="term-box" />
        {overlay && (
          <div className="term-overlay" role="status">
            <p>{overlay.text}</p>
            {status === 'error' && keyRefused(error) && <Copyable text={authorizeLine(publicKey)} />}
            <button className="btn btn-primary btn-small" onClick={overlay.run}>
              {overlay.button}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
