import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { McDiagnosis, McMux, McServer, McStatus } from '../../../shared/types';
import { api, localGet, localSet } from '../api';
import { MC_COMMANDS, fillFor } from '../mcCommands';

const LOG_EVERY = 1500;
const LIST_EVERY = 10_000;
/** Lines kept on screen. */
const MAX_LINES = 3000;
const HISTORY = 50;
const QUICK = ['list', 'save-all', 'time set day', 'weather clear'];
/** After Start: how often to look for the server, how long to wait for it, and how long it must stay up. */
const START_EVERY = 3_000;
const START_WAIT = 60_000;
const STAY_UP = 6_000;
const FINDING_ICON = { error: 'ph-x-circle', warn: 'ph-warning', info: 'ph-info' } as const;

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** A diagnosis as plain text, to paste into a message or an issue. */
export function report(s: Pick<McStatus, 'name' | 'dir' | 'mux' | 'session' | 'start'>, d: McDiagnosis): string {
  const head = [`${s.name} (${d.running ? 'running' : 'stopped'}) at ${new Date(d.at).toISOString()}`, `Folder: ${s.dir}`, `Runs in: ${s.mux} ${s.session}`, `Start: ${s.start || '(none)'}`];
  const found = d.findings.map((f) => `- [${f.level}] ${f.text}${f.detail ? `\n    ${f.detail}` : ''}`);
  return [...head, '', 'Findings:', ...found, '', `--- ${s.mux} session ---`, d.pane || '(nothing)', '', '--- logs/latest.log (end) ---', d.log || '(nothing)'].join('\n');
}

/** A log line's level, for its colour: [12:34:56] [Server thread/WARN]: … */
export function lineLevel(line: string): 'warn' | 'error' | 'chat' | '' {
  const m = /^\[[^\]]*\]\s*\[[^\]/]*\/(\w+)\]/.exec(line);
  const lvl = m?.[1]?.toUpperCase();
  if (lvl === 'WARN') return 'warn';
  if (lvl === 'ERROR' || lvl === 'FATAL') return 'error';
  if (/\]:\s*<[^>]+>\s/.test(line)) return 'chat';
  return '';
}

/** Add `text` (whole lines) to what's shown, keeping the last MAX_LINES. */
export function addLines(have: string[], text: string, reset: boolean): string[] {
  const add = text ? text.replace(/\n$/, '').split('\n') : [];
  const all = reset ? add : add.length ? [...have, ...add] : have;
  return all.length > MAX_LINES ? all.slice(-MAX_LINES) : all;
}

function readHistory(): string[] {
  try {
    const v = JSON.parse(localGet('mcHistory') || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, HISTORY) : [];
  } catch {
    return [];
  }
}

/** The Server view's Minecraft tab: the servers on the machine and a console on the one picked. */
export function MinecraftPanel({ onFailed }: { onFailed: () => void }) {
  const [list, setList] = useState<McStatus[] | null>(null);
  const [error, setError] = useState('');
  const [pick, setPick] = useState<string | null>(() => localGet('mcServer'));
  const [form, setForm] = useState<Partial<McServer> | null>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const load = useCallback((fresh = false) => {
    api
      .minecraft(fresh)
      .then((l) => {
        setList(l);
        setError('');
      })
      .catch((e: Error) => {
        setError(e.message);
        setList((l) => {
          if (!l) onFailedRef.current();
          return l;
        });
      });
  }, []);

  useEffect(() => {
    load(true);
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), LIST_EVERY);
    return () => clearInterval(iv);
  }, [load]);

  const chosen = list?.find((s) => s.id === pick) ?? list?.find((s) => s.running) ?? list?.[0] ?? null;
  const choose = (id: string) => {
    setPick(id);
    localSet('mcServer', id);
  };

  const saved = (l: McStatus[]) => {
    setList(l);
    setForm(null);
    setError('');
  };

  return (
    <section className="panel srv-panel mc-panel" aria-label="Minecraft">
      <div className="mc-body">
        <aside className="mc-list" aria-label="Minecraft servers">
          <div className="mc-list-head">
            <span className="drawer-label">Servers</span>
            <span style={{ display: 'inline-flex', gap: 2 }}>
              <button className="icon-btn" title="Look again" aria-label="Look for servers again" onClick={() => load(true)}>
                <i className="ph-duotone ph-arrow-clockwise" />
              </button>
              <button className="icon-btn" title="Add a server" aria-label="Add a server" onClick={() => setForm({ mux: 'tmux', session: 'minecraft', start: './start.sh' })}>
                <i className="ph-duotone ph-plus" />
              </button>
            </span>
          </div>
          {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
          {list === null ? (
            <p className="meta">{error ? '' : 'Looking for servers…'}</p>
          ) : !list.length ? (
            <div className="mc-empty meta">
              <p>No Minecraft servers running, and none saved.</p>
              <p>Launchpad finds a server by its Java process with a server.properties beside it. Start one in tmux or screen, or add it with + so it can be started from here.</p>
            </div>
          ) : (
            list.map((s) => (
              <button key={s.id} className={'mc-row' + (chosen?.id === s.id ? ' active' : '')} onClick={() => choose(s.id)} aria-current={chosen?.id === s.id || undefined}>
                <span className="dot" style={{ width: 8, height: 8, background: s.running ? 'var(--ac)' : 'var(--ln)' }} />
                <span className="mc-row-text">
                  <span className="mc-row-name">{s.name}</span>
                  <span className="meta mono">{s.session ? `${s.mux} ${s.session}` : 'not in tmux or screen'}</span>
                </span>
                {!s.saved && <span className="chip chip-muted">Found</span>}
              </button>
            ))
          )}
        </aside>
        {form ? (
          <ServerForm
            start={form}
            onCancel={() => setForm(null)}
            onSave={(s) => (s.id ? api.editMcServer(s as McServer) : api.addMcServer(s)).then(saved)}
            onDelete={form.id ? () => api.deleteMcServer(form.id!).then(saved) : undefined}
          />
        ) : chosen ? (
          <Console key={chosen.id} s={chosen} onChanged={() => load(true)} onEdit={() => setForm(chosen.saved ? chosen : { name: chosen.name, dir: chosen.dir, mux: chosen.mux, session: chosen.session.replace(/^\d+\./, ''), start: '' })} />
        ) : (
          <div className="mc-console empty">
            <p>{list ? 'Pick or add a server.' : ''}</p>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- the console ----------

function Console({ s, onChanged, onEdit }: { s: McStatus; onChanged: () => void; onEdit: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [logError, setLogError] = useState('');
  const [cmd, setCmd] = useState('');
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(() => localGet('mcSheet') === '1');
  const [starting, setStarting] = useState(false);
  const [diag, setDiag] = useState<{ busy: boolean; data: McDiagnosis | null; error: string } | null>(null);
  // False once this console is gone, so a Start that's still waiting stops quietly.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const offset = useRef<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const history = useRef<string[]>(readHistory());
  const histAt = useRef(-1);
  const input = useRef<HTMLInputElement>(null);

  const poll = useCallback(() => {
    api
      .mcLog(s.id, offset.current)
      .then((r) => {
        offset.current = r.offset;
        setMissing(r.missing);
        setLogError('');
        setLines((have) => addLines(have ?? [], r.text, r.reset || have === null));
      })
      .catch((e: Error) => setLogError(e.message));
  }, [s.id]);

  useEffect(() => {
    poll();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && poll(), LOG_EVERY);
    return () => clearInterval(iv);
  }, [poll]);

  // Stay at the bottom as lines come in, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const send = (line: string) => {
    const c = line.trim();
    if (!c || busy) return;
    setBusy(true);
    api
      .mcCommand(s.id, c)
      .then(() => {
        setNote(null);
        setCmd('');
        history.current = [c, ...history.current.filter((h) => h !== c)].slice(0, HISTORY);
        localSet('mcHistory', JSON.stringify(history.current));
        histAt.current = -1;
        atBottom.current = true;
        // The answer lands in the log a moment later.
        window.setTimeout(poll, 300);
      })
      .catch((e: Error) => setNote({ text: e.message, failed: true }))
      .finally(() => {
        setBusy(false);
        input.current?.focus();
      });
  };

  /** Check the server over SSH: its folder, start script, Java, EULA and port, and what its terminal and log said last. */
  const diagnose = () => {
    setDiag({ busy: true, data: null, error: '' });
    return api
      .mcDiagnose(s.id)
      .then((data) => alive.current && setDiag({ busy: false, data, error: '' }))
      .catch((e: Error) => alive.current && setDiag({ busy: false, data: null, error: e.message }));
  };

  /** After the start command is typed: wait for the server's process, then make sure it stays up. Any failure runs Diagnose. */
  const watchStart = async () => {
    const began = Date.now();
    let lastError = '';
    while (alive.current && Date.now() - began < START_WAIT) {
      await sleep(START_EVERY);
      if (!alive.current) return;
      try {
        const now = (await api.minecraft(true)).find((x) => x.id === s.id);
        lastError = '';
        if (now?.running) {
          setNote({ text: `${s.name} is up. Making sure it stays up…`, failed: false });
          await sleep(STAY_UP);
          if (!alive.current) return;
          const still = (await api.minecraft(true)).find((x) => x.id === s.id)?.running;
          onChanged();
          if (still) return setNote({ text: `${s.name} is running.`, failed: false });
          setNote({ text: `${s.name} started, then stopped again within ${STAY_UP / 1000} seconds.`, failed: true });
          return void diagnose();
        }
      } catch (e) {
        lastError = (e as Error).message;
      }
      setNote({ text: `Starting ${s.name}… waiting for it to come up (${Math.round((Date.now() - began) / 1000)}s)`, failed: false });
    }
    if (!alive.current) return;
    setNote({ text: `${s.name} didn’t come up within ${START_WAIT / 1000} seconds.${lastError ? ` The last check failed: ${lastError}` : ''}`, failed: true });
    onChanged();
    void diagnose();
  };

  const start = () => {
    setBusy(true);
    setStarting(true);
    setDiag(null);
    api
      .mcStart(s.id)
      .then(() => {
        setNote({ text: `Typed the start command into ${s.mux} session ${s.session}. Waiting for ${s.name} to come up…`, failed: false });
        atBottom.current = true;
        return watchStart();
      })
      .catch((e: Error) => {
        setNote({ text: e.message, failed: true });
        void diagnose();
      })
      .finally(() => {
        if (!alive.current) return;
        setBusy(false);
        setStarting(false);
      });
  };

  const copyReport = () => {
    if (!diag?.data) return;
    navigator.clipboard
      ?.writeText(report(s, diag.data))
      .then(() => setNote({ text: 'Report copied.', failed: false }))
      .catch(() => setNote({ text: 'Couldn’t copy. Select the text in the panel instead.', failed: true }));
  };

  const stop = () => {
    if (!window.confirm(`Stop ${s.name}? Players are disconnected and the world is saved.`)) return;
    send('stop');
    window.setTimeout(onChanged, 8000);
  };

  const toggleSheet = () => {
    setSheet((on) => {
      localSet('mcSheet', on ? '0' : '1');
      return !on;
    });
  };

  /** Put a command in the box to finish and send; it never sends on its own. */
  const fill = (usage: string) => {
    setCmd(fillFor(usage));
    histAt.current = -1;
    input.current?.focus();
  };

  const keys = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const h = history.current;
    if (e.key === 'ArrowUp' && h.length) {
      e.preventDefault();
      histAt.current = Math.min(h.length - 1, histAt.current + 1);
      setCmd(h[histAt.current]);
    } else if (e.key === 'ArrowDown' && histAt.current >= 0) {
      e.preventDefault();
      histAt.current -= 1;
      setCmd(histAt.current < 0 ? '' : h[histAt.current]);
    }
  };

  const canType = s.running && s.attached;
  return (
    <div className="mc-console">
      <div className="mc-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <h2 className="panel-title mc-title">{s.name}</h2>
          <span className={'chip ' + (s.running ? 'chip-accent' : 'chip-neutral')}>{s.running ? 'Running' : 'Stopped'}</span>
        </div>
        <div className="mc-tools">
          {!s.running && s.saved && s.start && (
            <button className="btn btn-primary btn-small" disabled={busy || starting} onClick={start}>
              <i className="ph-duotone ph-play" />
              Start
            </button>
          )}
          {canType && (
            <button className="btn btn-secondary btn-small" disabled={busy} onClick={stop}>
              <i className="ph-duotone ph-stop" />
              Stop
            </button>
          )}
          <button className="btn btn-secondary btn-small" disabled={diag?.busy || starting} onClick={() => void diagnose()} title="Check why it won’t start, or what it last said">
            <i className={'ph-duotone ' + (diag?.busy ? 'ph-circle-notch spin' : 'ph-stethoscope')} />
            Diagnose
          </button>
          <button className="btn btn-secondary btn-small" onClick={toggleSheet} aria-expanded={sheet} aria-controls="mc-sheet">
            <i className="ph-duotone ph-list-magnifying-glass" />
            Commands
          </button>
          <button className="btn btn-secondary btn-small" onClick={onEdit}>
            <i className={'ph-duotone ' + (s.saved ? 'ph-pencil-simple' : 'ph-floppy-disk')} />
            {s.saved ? 'Edit' : 'Save'}
          </button>
        </div>
      </div>
      <span className="meta mono mc-where" title={s.dir}>
        {s.dir || 'Folder unknown'}
        {s.pid ? ` · pid ${s.pid}` : ''}
      </span>
      {note && (
        <div className="status-line" style={{ margin: 0, color: note.failed ? 'var(--wn)' : 'var(--t2)' }} role="status">
          {note.text}
        </div>
      )}
      {diag && (
        <div className="mc-diag" role="region" aria-label="Diagnosis">
          <div className="mc-diag-head">
            <span className="drawer-label">Diagnosis</span>
            <span style={{ display: 'inline-flex', gap: 2 }}>
              {diag.data && (
                <button className="icon-btn" title="Copy report" aria-label="Copy report" onClick={copyReport}>
                  <i className="ph-duotone ph-copy" />
                </button>
              )}
              <button className="icon-btn" title="Check again" aria-label="Check again" disabled={diag.busy} onClick={() => void diagnose()}>
                <i className="ph-duotone ph-arrow-clockwise" />
              </button>
              <button className="icon-btn" title="Close" aria-label="Close diagnosis" onClick={() => setDiag(null)}>
                <i className="ph-duotone ph-x" />
              </button>
            </span>
          </div>
          {diag.busy && <p className="meta">Checking {s.name}…</p>}
          {diag.error && (
            <div className="status-line" style={{ margin: 0, color: 'var(--wn)' }}>
              Couldn’t check: {diag.error}
            </div>
          )}
          {diag.data?.findings.map((f, i) => (
            <div key={i} className={'mc-finding ' + f.level}>
              <i className={'ph-duotone ' + FINDING_ICON[f.level]} aria-hidden />
              <div>
                <span>{f.text}</span>
                {f.detail && <code className="mono meta mc-detail">{f.detail}</code>}
              </div>
            </div>
          ))}
          {diag.data && (
            <>
              <details>
                <summary className="meta">What the {s.mux} session printed</summary>
                <pre className="mono mc-pre">{diag.data.pane || '(nothing)'}</pre>
              </details>
              <details>
                <summary className="meta">End of logs/latest.log</summary>
                <pre className="mono mc-pre">{diag.data.log || '(nothing)'}</pre>
              </details>
            </>
          )}
        </div>
      )}
      <div
        ref={scroller}
        className="logs-body mono mc-log"
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {logError && !lines ? (
          <p className="meta">Couldn’t read the log: {logError}</p>
        ) : lines === null ? (
          <p className="meta">Reading the log…</p>
        ) : missing ? (
          <p className="meta">{s.dir ? `There’s no logs/latest.log in ${s.dir} yet.` : 'Launchpad can’t see this server’s folder, so it can’t show its log. Save it with its folder.'}</p>
        ) : !lines.length ? (
          <p className="meta">The log is empty.</p>
        ) : (
          lines.map((l, i) => (
            <div key={i} className={'mc-line ' + lineLevel(l)}>
              {l}
            </div>
          ))
        )}
      </div>
      {logError && lines && <span className="meta" style={{ color: 'var(--wn)' }}>Couldn’t refresh the log: {logError}</span>}
      {sheet && (
        <div id="mc-sheet" className="mc-sheet" role="region" aria-label="Command cheatsheet">
          <p className="meta mc-sheet-hint">
            {canType ? 'Click a command to put it in the box. Fill in the <parts>, then Send.' : 'Commands can only be sent while the server is running in tmux or screen.'}
          </p>
          {MC_COMMANDS.map((g) => (
            <div key={g.title} className="mc-sheet-group">
              <span className="drawer-label">{g.title}</span>
              {g.commands.map((c) => (
                <button key={c.usage} className="mc-sheet-row" disabled={!canType} onClick={() => fill(c.usage)} title={`Put "${fillFor(c.usage).trim()}" in the command box`}>
                  <span className="mono mc-sheet-cmd">{c.usage}</span>
                  <span className="meta">{c.desc}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="mc-quick">
        {QUICK.map((q) => (
          <button key={q} className="chip chip-neutral mono mc-chip" disabled={!canType || busy} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <form
        className="mc-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(cmd);
        }}
      >
        <span className="mono" aria-hidden>
          ›
        </span>
        <input
          ref={input}
          className="input sm mono"
          value={cmd}
          maxLength={1000}
          disabled={!canType}
          placeholder={canType ? 'A command, e.g. say Back in five' : s.running ? 'This server isn’t in tmux or screen, so commands can’t reach it' : `${s.name} is stopped`}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={keys}
          aria-label="Console command"
          autoComplete="off"
          spellCheck={false}
        />
        <button className="btn btn-primary btn-small" disabled={!canType || busy || !cmd.trim()}>
          <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-paper-plane-right')} />
          Send
        </button>
      </form>
    </div>
  );
}

// ---------- adding and editing ----------

function ServerForm({ start, onSave, onCancel, onDelete }: {
  start: Partial<McServer>;
  onSave: (s: Omit<McServer, 'id'> & { id?: string }) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
}) {
  const [v, setV] = useState({ name: start.name ?? '', dir: start.dir ?? '', mux: (start.mux ?? 'tmux') as McMux, session: start.session ?? '', start: start.start ?? '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value });
  const act = (p: Promise<void>) => {
    setBusy(true);
    p.catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  return (
    <form
      className="mc-console mc-form"
      onSubmit={(e) => {
        e.preventDefault();
        act(onSave({ ...v, id: start.id }));
      }}
      onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), onCancel())}
    >
      <h2 className="panel-title">{start.id ? `Edit ${start.name}` : 'Save a server'}</h2>
      <label className="mc-field">
        <span className="drawer-label">Name</span>
        <input className="input sm" value={v.name} maxLength={60} onChange={set('name')} placeholder="Survival" autoFocus />
      </label>
      <label className="mc-field">
        <span className="drawer-label">Folder</span>
        <input className="input sm mono" value={v.dir} onChange={set('dir')} placeholder="/home/me/minecraft/survival" spellCheck={false} />
        <span className="meta">The one with server.properties in it. The console shows its logs/latest.log.</span>
      </label>
      <div className="mc-field-row">
        <label className="mc-field">
          <span className="drawer-label">Runs in</span>
          <select className="input sm" value={v.mux} onChange={set('mux')}>
            <option value="tmux">tmux</option>
            <option value="screen">screen</option>
          </select>
        </label>
        <label className="mc-field" style={{ flex: 1 }}>
          <span className="drawer-label">Session name</span>
          <input className="input sm mono" value={v.session} maxLength={64} onChange={set('session')} placeholder="survival" spellCheck={false} />
        </label>
      </div>
      <label className="mc-field">
        <span className="drawer-label">Start command (optional)</span>
        <input className="input sm mono" value={v.start} maxLength={1000} onChange={set('start')} placeholder="./start.sh or java -Xmx4G -jar server.jar nogui" spellCheck={false} />
        <span className="meta">Start types this into the session, in the folder, making the session first if it isn’t there.</span>
      </label>
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button className="btn btn-primary btn-small" disabled={busy}>
          Save
        </button>
        <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
          Cancel
        </button>
        {onDelete && (
          <button type="button" className="btn btn-secondary btn-small" style={{ marginLeft: 'auto' }} disabled={busy} onClick={() => window.confirm(`Remove ${start.name} from Launchpad? The server and its files stay as they are.`) && act(onDelete())}>
            <i className="ph-duotone ph-trash" />
            Remove
          </button>
        )}
      </div>
    </form>
  );
}
