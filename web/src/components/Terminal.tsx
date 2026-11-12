import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { localGet, localSet } from '../api';
import { authorizeLine, Copyable, keyRefused } from './Copyable';
import { SnippetsPanel } from './Snippets';

const TABS_KEY = 'launchpad:terminals';
/** Where the single shell was kept before there were tabs. */
const OLD_KEY = 'launchpad:terminal';
export const MAX_TABS = 8;

export interface ShellTab {
  key: string;
  name: string;
  /** The shell's id on the server, once it has one. */
  session: string | null;
}
interface SavedTabs { tabs: ShellTab[]; active: string }

const newKey = () => Math.random().toString(36).slice(2, 10);

/** "Shell 1", or the lowest number not taken. */
export function nextName(tabs: { name: string }[]): string {
  const used = new Set(tabs.map((t) => t.name));
  for (let n = 1; ; n++) if (!used.has(`Shell ${n}`)) return `Shell ${n}`;
}

/** The tabs saved for this browser tab, or one fresh tab (picking up the shell from before tabs, if there was one). */
export function readTabs(raw: string | null, old: string | null): SavedTabs {
  try {
    const v = JSON.parse(raw ?? '') as Partial<SavedTabs>;
    const tabs = (Array.isArray(v.tabs) ? v.tabs : [])
      .filter((t) => t && typeof t.key === 'string' && typeof t.name === 'string')
      .slice(0, MAX_TABS)
      .map((t) => ({ key: t.key, name: t.name.slice(0, 40), session: typeof t.session === 'string' ? t.session : null }));
    if (tabs.length) return { tabs, active: tabs.some((t) => t.key === v.active) ? v.active! : tabs[0].key };
  } catch {
    // Nothing saved yet.
  }
  const first = { key: newKey(), name: 'Shell 1', session: old };
  return { tabs: [first], active: first.key };
}

// Kept per browser tab, so a reload or a trip to another view picks up the same shells,
// while a second browser tab gets shells of its own.
function loadTabs(): SavedTabs {
  try {
    return readTabs(sessionStorage.getItem(TABS_KEY), sessionStorage.getItem(OLD_KEY));
  } catch {
    return readTabs(null, null);
  }
}

function saveTabs(v: SavedTabs): void {
  try {
    sessionStorage.setItem(TABS_KEY, JSON.stringify(v));
    sessionStorage.removeItem(OLD_KEY);
  } catch {
    // Storage blocked: every visit starts new shells.
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

interface ShellHandle {
  /** Type text at the prompt without running it. */
  paste: (text: string) => void;
  /** Type text and press Enter. */
  run: (text: string) => void;
  cd: (path: string) => void;
  /** End this shell and start a fresh one. */
  restart: () => void;
  /** End this shell for good, as its tab closes. */
  close: () => void;
}

/** One shell on the server, over /api/terminal. It stays mounted while hidden so the screen is kept between tabs and views. */
function Shell({ session, onSession, hidden, publicKey, onStatus, onFailed, ref }: {
  session: string | null;
  onSession: (id: string | null) => void;
  hidden: boolean;
  publicKey: string;
  onStatus: (s: Status) => void;
  /** The connection was refused: the parent checks whether the host key changed. */
  onFailed: () => void;
  ref: Ref<ShellHandle>;
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
  // Read when connecting, so the latest values are used without reconnecting when they change.
  const latest = useRef({ session, onSession, onFailed, onStatus });
  latest.current = { session, onSession, onFailed, onStatus };

  useEffect(() => latest.current.onStatus(status), [status]);

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
    const id = latest.current.session;
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
        latest.current.session = m.id!;
        latest.current.onSession(m.id!);
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
        latest.current.session = null;
        latest.current.onSession(null);
      } else if (m.type === 'taken') {
        ended = 'taken';
      } else if (m.type === 'error') {
        ended = 'error';
        setError(m.message || 'Couldn’t open a shell.');
        latest.current.onFailed();
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

  /** Close the socket, telling the server to end the shell, without reconnecting. */
  const endShell = () => {
    clearTimeout(retryTimer.current);
    const sock = ws.current;
    ws.current = null;
    if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify({ type: 'close' }));
    sock?.close();
    latest.current.session = null;
    latest.current.onSession(null);
  };

  const restart = () => {
    endShell();
    retries.current = 0;
    connect();
  };

  useImperativeHandle(ref, () => ({
    paste: (text) => {
      term.current?.paste(text);
      term.current?.focus();
    },
    run: (text) => {
      term.current?.paste(text);
      type('\r');
      term.current?.focus();
    },
    cd: (path) => {
      if (ws.current?.readyState === WebSocket.OPEN && status === 'open') type(`cd -- ${quote(path)}\r`);
      else pendingCd.current = path;
      term.current?.focus();
    },
    restart,
    close: endShell,
  }));

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

  const overlay =
    status === 'ended'
      ? { text: 'The shell ended.', button: 'Start a new shell', run: restart }
      : status === 'taken'
        ? { text: 'This shell is open in another tab now.', button: 'Use it here', run: connect }
        : status === 'error'
          ? { text: error, button: 'Try again', run: () => ((retries.current = 0), connect()) }
          : null;

  return (
    <div className="term-shell" style={hidden ? { display: 'none' } : undefined}>
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
  );
}

/** A tab's name, renamed in place with a double-click. */
function TabName({ name, onRename }: { name: string; onRename: (n: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  if (!editing) {
    return (
      <span
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </span>
    );
  }
  const done = (keep: boolean) => {
    setEditing(false);
    if (keep && draft.trim()) onRename(draft.trim().slice(0, 40));
  };
  return (
    <input
      className="term-tab-input"
      autoFocus
      value={draft}
      size={Math.max(4, draft.length)}
      aria-label="Tab name"
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => done(true)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(true);
        if (e.key === 'Escape') done(false);
      }}
    />
  );
}

/** The terminal: shells on the server in tabs, each kept running while you're elsewhere, and saved snippets beside them. */
export function TerminalPanel({ target, publicKey, hidden, cd, onFailed }: {
  target: string;
  publicKey: string;
  hidden: boolean;
  /** A folder to `cd` into in the open tab; `n` changes each time, so the same folder can be sent twice. */
  cd: { path: string; n: number } | null;
  /** The connection was refused: the parent checks whether the host key changed. */
  onFailed: () => void;
}) {
  const [saved, setSaved] = useState<SavedTabs>(loadTabs);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [snippetsOpen, setSnippetsOpen] = useState(() => localGet('snippetsOpen') === '1');
  const handles = useRef(new Map<string, ShellHandle>());
  const { tabs, active } = saved;

  const update = (fn: (v: SavedTabs) => SavedTabs) =>
    setSaved((v) => {
      const next = fn(v);
      saveTabs(next);
      return next;
    });

  const setSession = (key: string, session: string | null) => update((v) => ({ ...v, tabs: v.tabs.map((t) => (t.key === key ? { ...t, session } : t)) }));

  const addTab = () => {
    if (tabs.length >= MAX_TABS) return;
    const t: ShellTab = { key: newKey(), name: nextName(tabs), session: null };
    update((v) => ({ tabs: [...v.tabs, t], active: t.key }));
  };

  const closeTab = (key: string) => {
    if (tabs.length <= 1) return;
    handles.current.get(key)?.close();
    update((v) => {
      const i = v.tabs.findIndex((t) => t.key === key);
      const rest = v.tabs.filter((t) => t.key !== key);
      return { tabs: rest, active: v.active === key ? rest[Math.max(0, i - 1)].key : v.active };
    });
  };

  const rename = (key: string, name: string) => update((v) => ({ ...v, tabs: v.tabs.map((t) => (t.key === key ? { ...t, name } : t)) }));

  useEffect(() => {
    if (cd) handles.current.get(saved.active)?.cd(cd.path);
    // Only when a new folder is sent, not when the tab changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cd?.n]);

  const toggleSnippets = () => {
    setSnippetsOpen((o) => {
      localSet('snippetsOpen', o ? '0' : '1');
      return !o;
    });
  };

  const status = statuses[active] ?? 'connecting';

  return (
    <section className="panel srv-panel term-panel" aria-label="Terminal" style={hidden ? { display: 'none' } : undefined}>
      <div className="panel-head term-head">
        <div className="term-tabs" role="tablist" aria-label="Shells">
          {tabs.map((t) => {
            const st = statuses[t.key] ?? 'connecting';
            return (
              <div
                key={t.key}
                role="tab"
                tabIndex={0}
                aria-selected={t.key === active}
                className={'term-tab' + (t.key === active ? ' active' : '')}
                title="Double-click the name to rename it"
                onClick={() => update((v) => ({ ...v, active: t.key }))}
                onKeyDown={(e) => e.key === 'Enter' && update((v) => ({ ...v, active: t.key }))}
                onAuxClick={(e) => e.button === 1 && closeTab(t.key)}
              >
                {st === 'connecting' ? (
                  <i className="ph-duotone ph-circle-notch spin" style={{ fontSize: 11 }} />
                ) : (
                  <span className="dot" style={{ width: 7, height: 7, background: st === 'open' ? 'var(--ac)' : 'var(--ln)' }} />
                )}
                <TabName name={t.name} onRename={(n) => rename(t.key, n)} />
                {tabs.length > 1 && (
                  <button
                    className="term-tab-close"
                    title={`Close ${t.name} and end its shell`}
                    aria-label={`Close ${t.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.key);
                    }}
                  >
                    <i className="ph-duotone ph-x" />
                  </button>
                )}
              </div>
            );
          })}
          <button className="icon-btn" onClick={addTab} disabled={tabs.length >= MAX_TABS} title={tabs.length >= MAX_TABS ? `${MAX_TABS} tabs is the most` : 'New tab with its own shell'} aria-label="New tab">
            <i className="ph-duotone ph-plus" />
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="meta mono">{target}</span>
          <button className={'btn btn-small ' + (snippetsOpen ? 'btn-primary' : 'btn-secondary')} aria-pressed={snippetsOpen} onClick={toggleSnippets} title="Saved commands">
            <i className="ph-duotone ph-brackets-curly" />
            Snippets
          </button>
          <button className="btn btn-secondary btn-small" onClick={() => handles.current.get(active)?.restart()} title="End this tab’s shell and start a new one" disabled={status === 'connecting'}>
            <i className="ph-duotone ph-arrow-counter-clockwise" />
            Restart
          </button>
        </div>
      </div>
      <div className="term-body">
        <div className="term-wrap">
          {tabs.map((t) => (
            <Shell
              key={t.key}
              ref={(h) => {
                if (h) handles.current.set(t.key, h);
                else handles.current.delete(t.key);
              }}
              session={t.session}
              onSession={(id) => setSession(t.key, id)}
              hidden={hidden || t.key !== active}
              publicKey={publicKey}
              onStatus={(s) => setStatuses((m) => (m[t.key] === s ? m : { ...m, [t.key]: s }))}
              onFailed={onFailed}
            />
          ))}
        </div>
        {snippetsOpen && (
          <SnippetsPanel
            canUse={status === 'open'}
            onInsert={(cmd) => handles.current.get(active)?.paste(cmd)}
            onRun={(cmd) => handles.current.get(active)?.run(cmd)}
            onClose={toggleSnippets}
          />
        )}
      </div>
    </section>
  );
}
