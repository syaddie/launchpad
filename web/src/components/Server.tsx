import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { DOW, MON } from '../../../shared/dates';
import { fmtDuration } from '../../../shared/trackers';
import type { AppState, ServerStats, ShellInfo, SourceKey, SpeedTest } from '../../../shared/types';
import { api, cachedServer, cacheServer, localGet, localSet } from '../api';
import { ago, fmtBytes, hm } from '../util';
import { authorizeLine, Copyable } from './Copyable';
import { FilesPanel } from './Files';

const POLL = 5_000;

// xterm is most of the terminal's weight, so it loads the first time the tab opens.
const TerminalPanel = lazy(() => import('./Terminal').then((m) => ({ default: m.TerminalPanel })));

export type ServerTab = 'overview' | 'terminal' | 'files';
type Tab = ServerTab;
const TABS: { key: Tab; name: string; icon: string }[] = [
  { key: 'overview', name: 'Overview', icon: 'ph-gauge' },
  { key: 'terminal', name: 'Terminal', icon: 'ph-terminal-window' },
  { key: 'files', name: 'Files', icon: 'ph-folder-simple' },
];

/** The Server view: the machine's health at a glance, a shell on it, and its files. */
export function Server({ data, now, openTab, onOpenSettings }: {
  data: AppState;
  now: Date;
  /** A tab to switch to from ⌘K; `n` changes each time. */
  openTab: { tab: Tab; n: number } | null;
  onOpenSettings: () => void;
}) {
  const [tab, setTabState] = useState<Tab>(() => TABS.find((t) => t.key === localGet('serverTab'))?.key ?? 'overview');
  // The terminal and files stay mounted once opened, so the screen and unsaved edits survive a switch of tab.
  const [opened, setOpened] = useState<Set<Tab>>(() => new Set([tab]));
  const [cd, setCd] = useState<{ path: string; n: number } | null>(null);
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [infoError, setInfoError] = useState('');

  const setTab = (t: Tab) => {
    setTabState(t);
    setOpened((o) => (o.has(t) ? o : new Set(o).add(t)));
    localSet('serverTab', t);
  };

  const loadInfo = useCallback(() => {
    api
      .shell()
      .then((i) => {
        setInfo(i);
        setInfoError('');
      })
      .catch((e) => setInfoError(e.message));
  }, []);

  // Only a new ask from ⌘K; one from before this view mounted is already in the saved tab.
  const askedAt = useRef(openTab?.n);
  useEffect(() => {
    if (!openTab || openTab.n === askedAt.current) return;
    askedAt.current = openTab.n;
    setTab(openTab.tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTab?.n]);

  const needsShell = tab !== 'overview';
  useEffect(() => {
    if (needsShell && !info) loadInfo();
  }, [needsShell, info, loadInfo]);

  const ready = !!info?.configured && !info.newHostKey;

  return (
    <main className="server">
      <div className="server-head">
        <div className="tabs server-tabs" role="tablist" aria-label="Server">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              <i className={'ph-duotone ' + t.icon} />
              {t.name}
            </button>
          ))}
        </div>
        {needsShell && info && !info.guarded && info.configured && (
          <span className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Turn on Cloudflare Access (docs/setup.md, step 4) so only your login can reach it.">
            <i className="ph-duotone ph-shield-warning" style={{ color: 'var(--wn)', fontSize: 15 }} />
            Not behind Cloudflare Access: anyone who can open Launchpad can use this
          </span>
        )}
      </div>
      {tab === 'overview' && <Overview data={data} now={now} onOpenSettings={onOpenSettings} />}
      {needsShell && !ready && <ShellSetup info={info} error={infoError} onRetry={loadInfo} onTrusted={setInfo} />}
      {ready && opened.has('terminal') && (
        <Suspense
          fallback={
            tab === 'terminal' && (
              <section className="panel srv-panel term-panel">
                <div className="empty">
                  <p>Opening the terminal…</p>
                </div>
              </section>
            )
          }
        >
          <TerminalPanel target={info.target!} publicKey={info.publicKey} hidden={tab !== 'terminal'} cd={cd} onFailed={loadInfo} />
        </Suspense>
      )}
      {ready && opened.has('files') && (
        <FilesPanel
          publicKey={info.publicKey}
          hidden={tab !== 'files'}
          now={now}
          onFailed={loadInfo}
          onOpenTerminal={(path) => {
            setCd((c) => ({ path, n: (c?.n ?? 0) + 1 }));
            setTab('terminal');
          }}
        />
      )}
    </main>
  );
}

// ---------- terminal and files setup ----------

/** What's needed before the terminal and files work: SSH settings, Launchpad's key on the server, or trusting a changed host key. */
function ShellSetup({ info, error, onRetry, onTrusted }: { info: ShellInfo | null; error: string; onRetry: () => void; onTrusted: (i: ShellInfo) => void }) {
  const [trustError, setTrustError] = useState('');
  if (!info) {
    return (
      <section className="panel srv-panel">
        <div className="empty">
          <p>{error ? `Couldn’t reach the server: ${error}` : 'Checking the SSH setup…'}</p>
          {error && (
            <button className="btn btn-secondary btn-small" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }
  if (info.newHostKey) {
    return (
      <section className="panel srv-panel shell-setup" aria-label="Host key changed">
        <div className="panel-head">
          <h2 className="panel-title">The server’s host key changed</h2>
        </div>
        <p>
          Launchpad stopped connecting to <span className="mono">{info.target}</span> because it now presents a different key from the one it had the first time. That’s expected after reinstalling the
          server or its SSH keys; otherwise something else may be answering in its place.
        </p>
        <p>It now presents:</p>
        <Copyable text={info.newHostKey} />
        <p className="meta">
          Check it on the server with <span className="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> before trusting it.
        </p>
        {trustError && <div className="status-line" style={{ margin: 0 }}>{trustError}</div>}
        <div>
          <button className="btn btn-primary btn-small" onClick={() => api.trustHostKey().then(onTrusted).catch((e) => setTrustError(e.message))}>
            Trust the new key
          </button>
        </div>
      </section>
    );
  }
  return (
    <section className="panel srv-panel shell-setup" aria-label="Set up the terminal">
      <div className="panel-head">
        <h2 className="panel-title">Connect to the server’s shell</h2>
      </div>
      <p>The terminal and files sign in to the server over SSH, as your own user. Two steps on the server, once:</p>
      <ol>
        <li>
          In <span className="mono">~/launchpad/.env</span>, set <span className="mono">SSH_USER</span> to your login on the server, then restart Launchpad:
          <Copyable text="docker compose up -d" />
        </li>
        <li>
          Let Launchpad’s key in, as that user:
          <Copyable text={authorizeLine(info.publicKey)} />
        </li>
      </ol>
      <p className="meta">See docs/setup.md, step 9, for details.</p>
    </section>
  );
}

// ---------- overview ----------

function Overview({ data, now, onOpenSettings }: { data: AppState; now: Date; onOpenSettings: () => void }) {
  // Open on the last reading while a fresh one loads; `stale` stays true until it arrives.
  const [stats, setStats] = useState<ServerStats | null>(cachedServer);
  const [stale, setStale] = useState(true);
  const [error, setError] = useState('');
  const [iface, setIface] = useState<string | undefined>(() => stats?.net?.iface || undefined);
  const ifaceRef = useRef(iface);
  ifaceRef.current = iface;

  const load = useCallback(() => {
    api
      .server(ifaceRef.current)
      .then((s) => {
        setStats(s);
        setStale(false);
        setError('');
        cacheServer(s);
      })
      .catch((e) => {
        setStale(false);
        setError(e.message);
      });
  }, []);

  useEffect(() => {
    load();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), POLL);
    return () => clearInterval(iv);
  }, [load]);

  const pickIface = (v: string) => {
    setIface(v);
    ifaceRef.current = v;
    setStale(true);
    load();
  };

  const testNow = () => {
    api
      .speedTest()
      .then((speed) => setStats((s) => (s ? { ...s, speed } : s)))
      .catch((e) => setError(e.message));
  };

  if (!stats) {
    return (
      <div className="panel">
        <div className="empty">
          <p>{error ? `Couldn’t reach the server: ${error}` : 'Reading the server’s health…'}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {error && (
        <div className="status-line" style={{ margin: 0 }}>
          <i className="ph-duotone ph-cloud-slash" /> Couldn’t refresh: {error}
        </div>
      )}
      <div className="server-row">
        <SystemPanel s={stats} updating={stale} />
        <StoragePanel s={stats} />
        <NetworkPanel s={stats} onIface={pickIface} />
      </div>
      <div className="server-row grow">
        <SpeedPanel speed={stats.speed} plan={data.prefs.speedPlanMbps} every={data.prefs.speedTestHours} now={now} lastError={data.sync.speedtest.lastError} onTest={testNow} onOpenSettings={onOpenSettings} />
        <ServicesPanel s={stats} data={data} now={now} />
      </div>
    </>
  );
}

// ---------- system ----------

const ARC = 0.75;

function Gauge({ name, pct, detail }: { name: string; pct: number; detail: string }) {
  const r = 48;
  const c = 2 * Math.PI * r;
  const len = c * ARC;
  const v = Math.min(100, Math.max(0, pct));
  return (
    <div className="gauge">
      <div className="gauge-dial">
        <svg width="124" height="124" viewBox="0 0 124 124" role="img" aria-label={`${name} ${Math.round(v)}%`}>
          <circle cx="62" cy="62" r={r} fill="none" stroke="var(--ln)" strokeWidth="10" strokeLinecap="round" strokeDasharray={`${len} ${c}`} transform="rotate(135 62 62)" />
          <circle
            cx="62"
            cy="62"
            r={r}
            fill="none"
            stroke={v >= 85 ? 'var(--wn)' : 'var(--ac)'}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${Math.max(0.01, (v / 100) * len)} ${c}`}
            transform="rotate(135 62 62)"
            style={{ transition: 'stroke-dasharray 0.6s ease-out' }}
          />
        </svg>
        <div className="gauge-text">
          <span className="serif tnum">
            {Math.round(v)}
            <small>%</small>
          </span>
          <span>{name}</span>
        </div>
      </div>
      <span className="meta tnum">{detail}</span>
    </div>
  );
}

function SystemPanel({ s, updating }: { s: ServerStats; updating: boolean }) {
  const memPct = s.mem.totalBytes ? (s.mem.usedBytes / s.mem.totalBytes) * 100 : 0;
  return (
    <section className="panel srv-panel" aria-label="System">
      <div className="panel-head">
        <h2 className="panel-title">System</h2>
        <span className="meta tnum" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {updating && (
            <span role="status" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i className="ph-duotone ph-circle-notch spin" />
              Updating ·
            </span>
          )}
          Up {fmtDuration(s.uptimeSec * 1000)} · load {s.load[0].toFixed(2)}
        </span>
      </div>
      <div className="gauges">
        <Gauge name="CPU" pct={s.cpu.pct} detail={[s.cpu.tempC !== null ? `${s.cpu.tempC} °C` : '', `${s.cpu.cores} cores`].filter(Boolean).join(' · ')} />
        <Gauge name="RAM" pct={memPct} detail={`${fmtBytes(s.mem.usedBytes)} of ${fmtBytes(s.mem.totalBytes)}`} />
      </div>
    </section>
  );
}

// ---------- storage ----------

function StoragePanel({ s }: { s: ServerStats }) {
  const d = s.disk;
  const pct = d && d.totalBytes ? (d.usedBytes / d.totalBytes) * 100 : 0;
  const full = pct >= 90;
  const label = full ? 'Almost full' : pct >= 75 ? 'Filling up' : 'Plenty of room';
  return (
    <section className="panel srv-panel" aria-label="Storage">
      <div className="panel-head">
        <h2 className="panel-title">Storage</h2>
        {d && <span className={'chip ' + (full ? 'chip-warn' : pct >= 75 ? 'chip-neutral' : 'chip-accent')}>{label}</span>}
      </div>
      {d ? (
        <div className="srv-body">
          <div className="big-line">
            <span className="serif tnum">{fmtBytes(d.usedBytes)}</span>
            <span>used of {fmtBytes(d.totalBytes)}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div className="disk-bar">
              <span style={{ width: `${pct}%`, background: full ? 'var(--wn)' : 'var(--t3)' }} />
            </div>
            <div className="split meta tnum">
              <span>{Math.round(pct)}% full</span>
              <span>{fmtBytes(d.totalBytes - d.usedBytes)} free</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="empty">
          <p>Couldn’t read the disk size here.</p>
        </div>
      )}
      <div className="srv-foot">
        <div className="split">
          <span style={{ color: 'var(--t2)' }}>Launchpad data</span>
          <span className="tnum">{fmtBytes(s.data.photosBytes + s.data.dbBytes)}</span>
        </div>
        <div className="split meta">
          <span>
            Photos {fmtBytes(s.data.photosBytes)} · database {fmtBytes(s.data.dbBytes)}
          </span>
        </div>
      </div>
    </section>
  );
}

// ---------- network ----------

/** A round number at or above v for a chart's top: 1, 2, 5 × 10ⁿ. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((m) => m * p >= v) ?? 10) * p;
}

function rate(bps: number): { v: number; unit: string } {
  if (bps >= 1e6) return { v: bps / 1e6, unit: 'MB/s' };
  return { v: bps / 1e3, unit: 'KB/s' };
}

const fmtRate = (bps: number) => {
  const r = rate(bps);
  return `${r.v >= 100 ? Math.round(r.v) : r.v.toFixed(1)} ${r.unit}`;
};

function NetworkPanel({ s, onIface }: { s: ServerStats; onIface: (v: string) => void }) {
  const n = s.net;
  const pts = n?.samples ?? [];
  const peak = Math.max(1, ...pts.flatMap((p) => [p.rxBps, p.txBps]));
  const unit = peak >= 1e6 ? 1e6 : 1e3;
  const top = niceMax(peak / unit);
  const line = (k: 'rxBps' | 'txBps') => pts.map((p, i) => `${pts.length > 1 ? (i / (pts.length - 1)) * 300 : 0},${100 - (p[k] / unit / top) * 100}`).join(' ');
  const last = pts[pts.length - 1];
  return (
    <section className="panel srv-panel" aria-label="Network">
      <div className="panel-head">
        <h2 className="panel-title">Network</h2>
        {n && n.ifaces.length > 1 && (
          <label className="meta" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Interface
            <select className="input sm mono" style={{ height: 26, fontSize: 12, padding: '0 6px' }} value={n.iface} onChange={(e) => onIface(e.target.value)}>
              {n.ifaces.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
        )}
        {n && n.ifaces.length === 1 && <span className="meta mono">{n.iface}</span>}
      </div>
      {n && pts.length > 1 ? (
        <>
          <div className="mini-chart">
            <div className="mini-grid">
              <span />
              <span />
              <span />
            </div>
            <div className="mini-y tnum">
              <span>{top}</span>
              <span>{top / 2}</span>
              <span>0</span>
            </div>
            <svg viewBox="0 0 300 100" preserveAspectRatio="none" role="img" aria-label="Network traffic, last 5 minutes">
              <polyline points={line('txBps')} fill="none" stroke="var(--t3)" strokeWidth="1.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <polyline points={line('rxBps')} fill="none" stroke="var(--ac)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="split meta" style={{ paddingLeft: 34 }}>
            <span>5 min ago</span>
            <span>{unit === 1e6 ? 'MB/s' : 'KB/s'}</span>
            <span>now</span>
          </div>
          <div className="net-now tnum">
            <span>
              <span className="legend-line" />
              Down <b>{fmtRate(last.rxBps)}</b>
            </span>
            <span>
              <span className="legend-dash" />
              Up <b>{fmtRate(last.txBps)}</b>
            </span>
          </div>
          {!n.host && <span className="meta">Only this container’s own traffic. See docs/setup.md to show the whole machine.</span>}
        </>
      ) : (
        <div className="empty">
          <p>{n ? 'Measuring… the chart fills in over the next minute.' : 'No network counters visible here.'}</p>
        </div>
      )}
    </section>
  );
}

// ---------- internet speed ----------

type Range = '24h' | '7d' | '30d';
const RANGES: { key: Range; name: string; ms: number }[] = [
  { key: '24h', name: '24 h', ms: 86_400_000 },
  { key: '7d', name: '7 days', ms: 7 * 86_400_000 },
  { key: '30d', name: '30 days', ms: 30 * 86_400_000 },
];

/** Tests whose download fell below half the median of the range. */
export function slowTests(tests: SpeedTest[]): SpeedTest[] {
  if (tests.length < 4) return [];
  const sorted = tests.map((t) => t.downMbps).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return tests.filter((t) => t.downMbps < median / 2);
}

function SpeedPanel({ speed, plan, every, now, lastError, onTest, onOpenSettings }: {
  speed: ServerStats['speed'];
  plan: number;
  every: number;
  now: Date;
  lastError: string | null;
  onTest: () => void;
  onOpenSettings: () => void;
}) {
  const [range, setRange] = useState<Range>('7d');
  const r = RANGES.find((x) => x.key === range)!;
  const end = now.getTime();
  const start = end - r.ms;
  const tests = speed.tests.filter((t) => Date.parse(t.at) >= start);
  const latest = speed.tests[speed.tests.length - 1];
  const top = niceMax(Math.max(plan, ...tests.map((t) => Math.max(t.downMbps, t.upMbps)), 10) * 1.05);
  const x = (t: SpeedTest) => ((Date.parse(t.at) - start) / r.ms) * 560;
  const y = (v: number) => 100 - (v / top) * 100;
  const line = (k: 'downMbps' | 'upMbps') => tests.map((t) => `${x(t).toFixed(1)},${y(t[k]).toFixed(1)}`).join(' ');
  const slow = slowTests(tests);
  const lastSlow = slow[slow.length - 1];

  // Seven day names, four 6-hour marks, or five dates across the range.
  const ticks =
    range === '7d'
      ? Array.from({ length: 7 }, (_, i) => DOW[new Date(start + (i + 0.5) * 86_400_000).getDay()])
      : range === '24h'
        ? Array.from({ length: 4 }, (_, i) => hm(new Date(start + i * 6 * 3_600_000)))
        : Array.from({ length: 5 }, (_, i) => {
            const d = new Date(start + i * 7.5 * 86_400_000);
            return `${d.getDate()} ${MON[d.getMonth()]}`;
          });

  return (
    <section className="panel srv-panel speed" aria-label="Internet speed">
      <div className="panel-head" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <h2 className="panel-title">Internet speed</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="tabs">
            {RANGES.map((x) => (
              <button key={x.key} className={'tab' + (x.key === range ? ' active' : '')} aria-pressed={x.key === range} onClick={() => setRange(x.key)}>
                {x.name}
              </button>
            ))}
          </div>
          <button className="btn btn-secondary btn-small" style={{ padding: '5px 10px' }} disabled={speed.running} onClick={onTest}>
            <i className={'ph-duotone ' + (speed.running ? 'ph-circle-notch spin' : 'ph-play')} />
            {speed.running ? 'Testing…' : 'Test now'}
          </button>
        </div>
      </div>

      <div className="speed-stats">
        {(
          [
            ['Download', latest?.downMbps, 'Mbps', 'line'],
            ['Upload', latest?.upMbps, 'Mbps', 'dash'],
            ['Ping', latest?.pingMs, 'ms', ''],
            ['Jitter', latest?.jitterMs, 'ms', ''],
          ] as const
        ).map(([name, v, unit, key]) => (
          <div key={name} className="speed-stat">
            <span className="meta">
              {key === 'line' && <span className="legend-line" />}
              {key === 'dash' && <span className="legend-dash" />}
              {name}
            </span>
            <span className="serif tnum">
              {v === undefined ? '—' : v >= 100 ? Math.round(v) : v}
              <small> {unit}</small>
            </span>
          </div>
        ))}
        <span className="meta" style={{ marginLeft: 'auto', alignSelf: 'flex-end' }}>
          {latest ? `Last test ${ago(latest.at, now)}` : 'No tests yet'}
          {every ? ` · every ${every} h` : ' · automatic tests off'}
        </span>
      </div>
      {lastError && <div className="status-line" style={{ margin: 0 }}>Last test failed: {lastError}</div>}

      {tests.length ? (
        <div className="speed-chart">
          <div className="sc-grid">
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} />
            ))}
          </div>
          <div className="sc-y tnum">
            {[4, 3, 2, 1, 0].map((i) => (
              <span key={i}>{Math.round((top * i) / 4)}</span>
            ))}
          </div>
          <div className="sc-plot">
            {plan > 0 && (
              <span className="sc-plan" style={{ top: `${y(plan)}%` }}>
                <span>Plan · {plan >= 1000 ? `${plan / 1000} Gbps` : `${plan} Mbps`}</span>
              </span>
            )}
            <svg viewBox="0 0 560 100" preserveAspectRatio="none" role="img" aria-label={`Download and upload speed, last ${r.name}`}>
              <polyline points={line('upMbps')} fill="none" stroke="var(--t2)" strokeWidth="1.5" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
              <polyline points={line('downMbps')} fill="none" stroke="var(--ac)" strokeWidth="2.25" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
            {slow.map((t) => (
              <span key={t.at} className="sc-slow" title={`${hm(new Date(t.at))} · ${t.downMbps} Mbps`} style={{ left: `${(x(t) / 560) * 100}%`, top: `${y(t.downMbps)}%` }} />
            ))}
          </div>
          <div className="sc-x" style={{ gridTemplateColumns: `repeat(${ticks.length}, minmax(0, 1fr))` }}>
            {ticks.map((t, i) => (
              <span key={i}>{t}</span>
            ))}
          </div>
        </div>
      ) : (
        <div className="empty">
          <p>
            {every
              ? `No tests in the last ${r.name} yet. They run every ${every} hours, or press Test now.`
              : 'Automatic tests are off. Press Test now, or turn them on in Settings › Trackers.'}
          </p>
          {!every && (
            <button className="btn btn-secondary btn-small" onClick={onOpenSettings}>
              Open Settings
            </button>
          )}
        </div>
      )}
      {lastSlow && (
        <span className="meta">
          <b style={{ color: 'var(--wn)', fontWeight: 600 }}>Slow</b> on {DOW[new Date(lastSlow.at).getDay()]} {new Date(lastSlow.at).getDate()} {MON[new Date(lastSlow.at).getMonth()]} at {hm(new Date(lastSlow.at))} ·{' '}
          {lastSlow.downMbps} Mbps down
          {slow.length > 1 ? ` · ${slow.length} slow tests in this range` : ''}
        </span>
      )}
    </section>
  );
}

// ---------- services ----------

const SYNCS: { key: SourceKey; name: string }[] = [
  { key: 'calendar', name: 'Calendar' },
  { key: 'tasks', name: 'Tasks' },
  { key: 'gmail', name: 'Gmail packages' },
  { key: 'carriers', name: 'Carriers' },
  { key: 'news', name: 'News' },
  { key: 'inbox', name: 'Inbox' },
  { key: 'weather', name: 'Weather and air' },
  { key: 'speedtest', name: 'Speed test' },
];

function ServicesPanel({ s, data, now }: { s: ServerStats; data: AppState; now: Date }) {
  return (
    <section className="panel srv-panel services" aria-label="Services">
      <div className="panel-head">
        <h2 className="panel-title">Services</h2>
        <span className="meta">{s.hostname}</span>
      </div>
      <div className="scroll">
        {s.containers ? (
          s.containers.map((c) => {
            const up = c.state === 'running';
            const unhealthy = /unhealthy/i.test(c.status);
            return (
              <div key={c.name} className="container-row">
                <span className="dot" style={{ width: 8, height: 8, background: up && !unhealthy ? 'var(--ac)' : up ? 'var(--wn)' : 'var(--ln)' }} />
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                  <span className="mono" style={{ fontSize: 13 }}>
                    {c.name}
                  </span>
                  <span className="meta" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {c.status}
                  </span>
                </div>
                <span className={'chip ' + (unhealthy ? 'chip-warn' : up ? 'chip-accent' : 'chip-muted')}>{unhealthy ? 'Unhealthy' : up ? 'Running' : c.state[0].toUpperCase() + c.state.slice(1)}</span>
              </div>
            );
          })
        ) : (
          <div className="empty" style={{ gap: 6 }}>
            <p style={{ fontSize: 13 }}>
              {s.containersError
                ? `Couldn’t list containers: ${s.containersError}`
                : 'Connect Docker to list your containers here: run the docker-proxy service from docker-compose.yml (see docs/setup.md).'}
            </p>
          </div>
        )}
        <div className="task-group-label" style={{ paddingTop: 14 }}>
          Syncs
        </div>
        {SYNCS.map((x) => {
          const st = data.sync[x.key];
          return (
            <div key={x.key} className="split sync-row">
              <span style={{ color: 'var(--t2)' }}>{x.name}</span>
              <span className="meta" style={st.lastError ? { color: 'var(--wn)' } : undefined} title={st.lastError || undefined}>
                {st.lastError ? `Failing · ${ago(st.lastSuccess, now)}` : st.lastSuccess ? ago(st.lastSuccess, now) : 'Not yet'}
              </span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
