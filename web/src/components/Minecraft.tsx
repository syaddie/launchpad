import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { MC_KEEP_BACKUPS } from '../../../shared/types';
import type { McDiagnosis, McMeters, McMux, McServer, McStatus } from '../../../shared/types';
import { api, localGet, localSet } from '../api';
import { fillFor } from '../mcCommands';
import { ExplainBox, ExplainButton, useExplain, useExplainStatus } from './Explain';
import { McBackupsView, fmtSize, fmtWhen } from './McBackups';
import { McCommandSheet } from './McCommandSheet';
import { McCrashesView, savedOf } from './McCrashes';
import { McPlayersView } from './McPlayers';
import { Glide } from './Motion';
import { EmptyArt } from './mission/EmptyArt';

const LOG_EVERY = 1500;
const LIST_EVERY = 10_000;
const METERS_EVERY = 5_000;
/** Lines kept on screen. */
const MAX_LINES = 3000;
const HISTORY = 50;
const QUICK = ['list', 'save-all', 'time set day', 'weather clear'];
/** After Start: how often to look for the server, how long to wait for it, and how long it must stay up. */
const START_EVERY = 3_000;
const START_WAIT = 60_000;
const STAY_UP = 6_000;
const FINDING_ICON = { error: 'ph-x-circle', warn: 'ph-warning', info: 'ph-info' } as const;

type View = 'console' | 'players' | 'backups' | 'crashes';
const VIEWS: { key: View; name: string; icon: string }[] = [
  { key: 'console', name: 'Console', icon: 'ph-terminal-window' },
  { key: 'players', name: 'Players', icon: 'ph-users-three' },
  { key: 'backups', name: 'Backups', icon: 'ph-archive' },
  { key: 'crashes', name: 'Crashes', icon: 'ph-heartbeat' },
];

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** A diagnosis as plain text, to paste into a message or an issue. */
export function report(s: Pick<McStatus, 'name' | 'dir' | 'mux' | 'session' | 'start'>, d: McDiagnosis): string {
  const head = [`${s.name} (${d.running ? 'running' : 'stopped'}) at ${new Date(d.at).toISOString()}`, `Folder: ${s.dir}`, `Runs in: ${s.mux} ${s.session}`, `Start: ${s.start || '(none)'}`];
  const found = d.findings.map((f) => `- [${f.level}] ${f.text}${f.detail ? `\n    ${f.detail}` : ''}`);
  const crash = d.crash ? ['', `--- newest crash report: ${d.crash.name} (${d.crash.at}) ---`, `Description: ${d.crash.description ?? '(none)'}`, ...d.crash.lines] : [];
  return [...head, '', 'Findings:', ...found, ...crash, '', `--- ${s.mux} session ---`, d.pane || '(nothing)', '', '--- logs/latest.log (end) ---', d.log || '(nothing)'].join('\n');
}

/** What Launchpad's own TPS questions get back: shown quieter, so they don't crowd the console. */
const PROBE = /^(?:\[⚡\]|TPS from last|Server tick times|◴|The game is running normally|Target tick rate|Average time per tick|Percentiles: P50)/;

/** A log line's level, for its colour: [12:34:56] [Server thread/WARN]: … */
export function lineLevel(line: string): 'warn' | 'error' | 'chat' | 'quiet' | '' {
  const m = /^\[[^\]]*\]\s*\[[^\]/]*\/(\w+)\]/.exec(line);
  const lvl = m?.[1]?.toUpperCase();
  if (lvl === 'WARN') return 'warn';
  if (lvl === 'ERROR' || lvl === 'FATAL') return 'error';
  if (/\]:\s*<[^>]+>\s/.test(line)) return 'chat';
  if (PROBE.test(line.replace(/^(?:\[[^\]]*\]\s*){1,3}:\s?/, ''))) return 'quiet';
  return '';
}

/** Add `text` (whole lines) to what's shown, keeping the last MAX_LINES. */
export function addLines(have: string[], text: string, reset: boolean): string[] {
  const add = text ? text.replace(/\n$/, '').split('\n') : [];
  const all = reset ? add : add.length ? [...have, ...add] : have;
  return all.length > MAX_LINES ? all.slice(-MAX_LINES) : all;
}

/** "3 h 12 min", "2 d 4 h": how long the process has been up. */
export function fmtUptime(secs: number): string {
  const m = Math.floor(secs / 60);
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

/** The meters as short pieces for the line under the server's name. Unknown ones are left out, never shown as 0. */
export function meterParts(m: McMeters | null): { text: string; title: string; warn?: boolean }[] {
  if (!m?.running) return [];
  const out: { text: string; title: string; warn?: boolean }[] = [];
  if (m.rss !== null) out.push({ text: fmtSize(m.rss), title: 'Memory the Java process is using' });
  if (m.cpu !== null) out.push({ text: `CPU ${m.cpu < 10 ? m.cpu.toFixed(1) : Math.round(m.cpu)}%`, title: `Of the whole machine${m.cores ? `, ${m.cores} cores` : ''}`, warn: m.cpu > 90 });
  if (m.online !== null) out.push({ text: `${m.online}/${m.max ?? '?'} online`, title: 'Players online, from a server list ping' });
  if (m.tps !== null) out.push({ text: `${m.tps.toFixed(1)} TPS`, title: `Ticks a second (20 is full speed), from ${m.tpsFrom === 'spark' ? 'Spark' : m.tpsFrom === 'paper' ? 'the tps command' : 'tick query'}${m.tpsAt ? `, ${fmtWhen(new Date(m.tpsAt).toISOString())}` : ''}`, warn: m.tps < 18 });
  if (m.mspt !== null) out.push({ text: `${m.mspt < 10 ? m.mspt.toFixed(1) : Math.round(m.mspt)} ms/tick`, title: 'Milliseconds a tick takes (under 50 keeps up)', warn: m.mspt > 50 });
  if (m.uptime !== null) out.push({ text: `up ${fmtUptime(m.uptime)}`, title: 'How long the server has been running' });
  return out;
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

  const reload = useCallback(() => load(true), [load]);

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
              <EmptyArt kind="clear" />
              <p>No Minecraft servers running, and none saved.</p>
              <p>Launchpad finds a server by its Java process with a server.properties beside it. Start one in tmux or screen, or add it with + so it can be started from here.</p>
            </div>
          ) : (
            list.map((s) => (
              <button key={s.id} className={'mc-row' + (chosen?.id === s.id ? ' active' : '')} onClick={() => choose(s.id)} aria-current={chosen?.id === s.id || undefined}>
                <span className="dot" style={{ width: 8, height: 8, background: s.running ? 'var(--ac)' : 'var(--ln)' }} />
                <span className="mc-row-text">
                  <span className="mc-row-name">{s.name}</span>
                  <span className="meta mono">{s.job ? (s.job === 'backup' ? 'Backing up…' : 'Restoring…') : s.session ? `${s.mux} ${s.session}` : 'not in tmux or screen'}</span>
                </span>
                {s.gaveUp ? <span className="chip chip-warn">Gave up</span> : !s.saved && <span className="chip chip-muted">Found</span>}
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
          <Console
            key={chosen.id}
            s={chosen}
            onChanged={reload}
            onSaved={setList}
            onEdit={() => setForm(chosen.saved ? savedOf(chosen) : { name: chosen.name, dir: chosen.dir, mux: chosen.mux, session: chosen.session.replace(/^\d+\./, ''), start: '' })}
          />
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

function Console({ s, onChanged, onSaved, onEdit }: { s: McStatus; onChanged: () => void; onSaved: (l: McStatus[]) => void; onEdit: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [missing, setMissing] = useState(false);
  const [logError, setLogError] = useState('');
  const [cmd, setCmd] = useState('');
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [sheet, setSheet] = useState(() => localGet('mcSheet') === '1');
  const [starting, setStarting] = useState(false);
  const [diag, setDiag] = useState<{ busy: boolean; data: McDiagnosis | null; error: string } | null>(null);
  const [view, setViewState] = useState<View>(() => VIEWS.find((v) => v.key === localGet('mcView'))?.key ?? 'console');
  const [meters, setMeters] = useState<McMeters | null>(null);
  const [crashOpen, setCrashOpen] = useState<string | null>(null);
  const explainStatus = useExplainStatus();
  const ex = useExplain(explainStatus);
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

  const setView = (v: View) => {
    setViewState(v);
    localSet('mcView', v);
    if (v === 'console') atBottom.current = true;
  };

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

  // "It's running" stops being true when it stops (a crash, a stop elsewhere): only a failure stays.
  const startingRef = useRef(false);
  startingRef.current = starting;
  const wasRunning = useRef(s.running);
  useEffect(() => {
    if (wasRunning.current !== s.running && !startingRef.current) setNote((n) => (n?.failed ? n : null));
    wasRunning.current = s.running;
  }, [s.running]);

  // Memory, CPU and players online while it runs; TPS only where the server can say.
  useEffect(() => {
    if (!s.running) return setMeters(null);
    let on = true;
    const read = () =>
      document.visibilityState === 'visible' &&
      api
        .mcMeters(s.id, true)
        .then((m) => on && setMeters(m))
        .catch(() => on && setMeters(null));
    read();
    const iv = window.setInterval(read, METERS_EVERY);
    return () => {
      on = false;
      clearInterval(iv);
    };
  }, [s.id, s.running, s.pid]);

  // Stay at the bottom as lines come in, unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines, view]);

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
    setView('console');
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
    setView('console');
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

  const explainLog = () => ex.start(() => api.mcExplain(s.id));
  const explainCrash = (name: string) => ex.start(() => api.mcExplain(s.id, name));
  const readCrash = (name: string) => {
    setCrashOpen(name);
    setView('crashes');
  };

  const canType = s.running && s.attached;
  const parts = meterParts(meters);
  return (
    <div className="mc-console">
      <div className="mc-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <h2 className="panel-title mc-title">{s.name}</h2>
          <span className={'chip ' + (s.running ? 'chip-accent' : 'chip-neutral')}>{s.running ? 'Running' : 'Stopped'}</span>
        </div>
        <div className="mc-tools">
          {!s.running && s.saved && s.start && (
            <button className="btn btn-primary btn-small" disabled={busy || starting || !!s.job} title={s.job ? `Wait for the ${s.job} to finish` : undefined} onClick={start}>
              <i className="ph-duotone ph-play" />
              Start
            </button>
          )}
          {canType && (
            <button className="btn btn-secondary btn-small" disabled={busy || s.job === 'backup'} title={s.job === 'backup' ? 'Wait for the backup to finish' : undefined} onClick={stop}>
              <i className="ph-duotone ph-stop" />
              Stop
            </button>
          )}
          <button className="btn btn-secondary btn-small" disabled={diag?.busy || starting} onClick={() => void diagnose()} title="Check why it won’t start, or what it last said">
            <i className={'ph-duotone ' + (diag?.busy ? 'ph-circle-notch spin' : 'ph-stethoscope')} />
            Diagnose
          </button>
          {view === 'console' && (
            <button className="btn btn-secondary btn-small" onClick={toggleSheet} aria-expanded={sheet} aria-controls="mc-sheet">
              <i className="ph-duotone ph-list-magnifying-glass" />
              Commands
            </button>
          )}
          <button className="btn btn-secondary btn-small" onClick={onEdit}>
            <i className={'ph-duotone ' + (s.saved ? 'ph-pencil-simple' : 'ph-floppy-disk')} />
            {s.saved ? 'Edit' : 'Save'}
          </button>
        </div>
      </div>
      <div className="mc-where">
        <span className="meta mono mc-where-dir" title={s.dir}>
          {s.dir || 'Folder unknown'}
          {s.pid ? ` · pid ${s.pid}` : ''}
        </span>
        {parts.length > 0 && (
          <span className="mc-meters" aria-label="Meters">
            {parts.map((p) => (
              <span key={p.text} className={'mc-meter mono' + (p.warn ? ' warn' : '')} title={p.title}>
                {p.text}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="tabs mc-views" role="tablist" aria-label={`${s.name} views`}>
        <Glide on={view} />
        {VIEWS.map((v) => (
          <button key={v.key} role="tab" aria-selected={view === v.key} className={'tab' + (view === v.key ? ' active' : '')} onClick={() => setView(v.key)}>
            <i className={'ph-duotone ' + v.icon} />
            {v.name}
            {v.key === 'crashes' && s.gaveUp && <span className="tab-count" style={{ background: 'var(--wnt)', color: 'var(--wn)' }}>!</span>}
          </button>
        ))}
      </div>
      {s.gaveUp && view !== 'crashes' && (
        <div className="status-line" style={{ margin: 0 }} role="status">
          Launchpad gave up restarting {s.name} after it crashed too many times.{' '}
          <button className="btn-link" onClick={() => setView('crashes')}>
            See Crashes
          </button>
        </div>
      )}
      {s.job && view !== 'backups' && (
        <div className="status-line" style={{ margin: 0, color: 'var(--t2)' }} role="status">
          {s.job === 'backup' ? 'A backup' : 'A restore'} of the world is under way.{' '}
          <button className="btn-link" onClick={() => setView('backups')}>
            See Backups
          </button>
        </div>
      )}
      {note && (
        <div className="status-line" style={{ margin: 0, color: note.failed ? 'var(--wn)' : 'var(--t2)' }} role="status">
          {note.text}
        </div>
      )}
      {view === 'console' && diag && (
        <div className="mc-diag" role="region" aria-label="Diagnosis">
          <div className="mc-diag-head">
            <span className="drawer-label">Diagnosis</span>
            <span style={{ display: 'inline-flex', gap: 2, alignItems: 'center' }}>
              {diag.data && <ExplainButton status={explainStatus} busy={!!ex.state?.busy} onClick={explainLog} label="Explain the log" />}
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
          {diag.data?.crash && (
            <div className="mc-diag-crash">
              <span className="drawer-label">Newest crash report · {fmtWhen(diag.data.crash.at)}</span>
              <span>{diag.data.crash.description ?? 'It has no description line.'}</span>
              {diag.data.crash.lines.length > 0 && <pre className="mono mc-pre">{diag.data.crash.lines.join('\n')}</pre>}
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-secondary btn-small" onClick={() => readCrash(diag.data!.crash!.name)}>
                  <i className="ph-duotone ph-file-text" />
                  Read it all
                </button>
                <ExplainButton status={explainStatus} busy={!!ex.state?.busy} onClick={() => explainCrash(diag.data!.crash!.name)} label="Explain this crash" />
              </span>
            </div>
          )}
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
      {view === 'console' && ex.state && <ExplainBox state={ex.state} onClose={ex.close} onRetry={explainLog} />}
      <div
        ref={scroller}
        className="logs-body mono mc-log"
        hidden={view !== 'console'}
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
      {view === 'console' && (
        <>
          {logError && lines && <span className="meta" style={{ color: 'var(--wn)' }}>Couldn’t refresh the log: {logError}</span>}
          {sheet && <McCommandSheet canType={canType} onFill={fill} />}
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
        </>
      )}
      {view === 'players' && <McPlayersView s={s} onNote={(text, failed) => setNote({ text, failed })} />}
      {view === 'backups' && <McBackupsView s={s} onChanged={onChanged} />}
      {view === 'crashes' && <McCrashesView s={s} explain={explainStatus} open={crashOpen} onOpen={setCrashOpen} onSaved={onSaved} />}
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
  const [v, setV] = useState({
    name: start.name ?? '',
    dir: start.dir ?? '',
    mux: (start.mux ?? 'tmux') as McMux,
    session: start.session ?? '',
    start: start.start ?? '',
    autoRestart: !!start.autoRestart,
    keepBackups: String(start.keepBackups ?? MC_KEEP_BACKUPS),
    backupDir: start.backupDir ?? '',
  });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: 'name' | 'dir' | 'mux' | 'session' | 'start' | 'keepBackups' | 'backupDir') => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const val = e.target.value;
    setV((p) => ({ ...p, [k]: val }));
  };
  const act = (p: Promise<void>) => {
    setBusy(true);
    p.catch((e: Error) => setError(e.message)).finally(() => setBusy(false));
  };
  const keep = Number(v.keepBackups);
  return (
    <form
      className="mc-console mc-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!Number.isInteger(keep) || keep < 1 || keep > 100) return setError('Keep between 1 and 100 backups.');
        act(onSave({ ...v, autoRestart: v.autoRestart && !!v.start.trim(), keepBackups: keep, backupDir: v.backupDir.trim() || undefined, id: start.id }));
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
        <label className="mc-field" style={{ flex: 1, minWidth: 0 }}>
          <span className="drawer-label">Session name</span>
          <input className="input sm mono" value={v.session} maxLength={64} onChange={set('session')} placeholder="survival" spellCheck={false} />
        </label>
      </div>
      <label className="mc-field">
        <span className="drawer-label">Start command (optional)</span>
        <input className="input sm mono" value={v.start} maxLength={1000} onChange={set('start')} placeholder="./start.sh or java -Xmx4G -jar server.jar nogui" spellCheck={false} />
        <span className="meta">Start types this into the session, in the folder, making the session first if it isn’t there.</span>
      </label>
      <div className="mc-auto">
        <div className="mc-auto-text">
          <span id="mc-form-auto">Restart it if it crashes</span>
          <span className="meta">{v.start.trim() ? 'Up to 3 times in 15 minutes, then it gives up and says so.' : 'Needs a start command.'}</span>
        </div>
        <button type="button" role="switch" aria-checked={v.autoRestart && !!v.start.trim()} aria-labelledby="mc-form-auto" className={'switch' + (v.autoRestart && v.start.trim() ? ' on' : '')} disabled={!v.start.trim()} onClick={() => setV((p) => ({ ...p, autoRestart: !p.autoRestart }))} style={!v.start.trim() ? { opacity: 0.5, cursor: 'default' } : undefined}>
          <span />
        </button>
      </div>
      <div className="mc-field-row">
        <label className="mc-field">
          <span className="drawer-label">Keep backups</span>
          <input className="input sm" type="number" min={1} max={100} value={v.keepBackups} onChange={set('keepBackups')} style={{ width: 80 }} />
        </label>
        <label className="mc-field" style={{ flex: 1, minWidth: 0 }}>
          <span className="drawer-label">Backups folder (optional)</span>
          <input className="input sm mono" value={v.backupDir} onChange={set('backupDir')} placeholder={`${v.dir.trim().replace(/\/+$/, '') || '/home/me/minecraft/survival'}/backups`} spellCheck={false} />
        </label>
      </div>
      <span className="meta" style={{ marginTop: -8 }}>Only Launchpad’s own backups are counted and cleared out, after a new one is made.</span>
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
