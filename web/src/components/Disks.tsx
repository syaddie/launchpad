import { useCallback, useEffect, useState } from 'react';
import type { DiskHealth, DisksReport } from '../../../shared/types';
import { api } from '../api';
import { ago, fmtBytes } from '../util';
import { Copyable } from './Copyable';

/** Checked against visudo before it goes in, since a broken file in sudoers.d stops sudo working at all. */
export const SUDOERS_LINE =
  'echo "$USER ALL=(root) NOPASSWD: /usr/sbin/smartctl --scan -j, /usr/sbin/smartctl -j -a -d *" | sudo tee /tmp/launchpad-smartctl >/dev/null && sudo chmod 440 /tmp/launchpad-smartctl && sudo visudo -cf /tmp/launchpad-smartctl && sudo mv /tmp/launchpad-smartctl /etc/sudoers.d/launchpad-smartctl';

const LEVEL: Record<DiskHealth['level'], { chip: string; text: string; dot: string }> = {
  good: { chip: 'chip-accent', text: 'Healthy', dot: 'var(--ac)' },
  warn: { chip: 'chip-warn', text: 'Worth a look', dot: 'var(--wn)' },
  bad: { chip: 'chip-warn', text: 'Failing', dot: 'var(--wn)' },
  unknown: { chip: 'chip-muted', text: 'Unknown', dot: 'var(--ln)' },
};

const KIND: Record<DiskHealth['kind'], string> = { nvme: 'NVMe', ssd: 'SSD', hdd: 'Hard disk', unknown: '' };

/** 10,512 h → "1.2 years". */
export function powerOnText(h: number): string {
  if (h < 48) return `${h} h`;
  if (h < 24 * 60) return `${Math.round(h / 24)} days`;
  const y = h / (24 * 365);
  return y < 1 ? `${Math.round(h / (24 * 30.4))} months` : `${y.toFixed(1)} years`;
}

function facts(d: DiskHealth): string[] {
  const out: string[] = [];
  if (d.tempC !== null) out.push(`${d.tempC} °C`);
  if (d.powerOnHours !== null) out.push(`on for ${powerOnText(d.powerOnHours)}`);
  if (d.kind === 'nvme') {
    if (d.percentUsed !== null) out.push(`${d.percentUsed}% worn`);
    if (d.mediaErrors !== null) out.push(`${d.mediaErrors.toLocaleString()} media errors`);
    if (d.availableSpare !== null) out.push(`${d.availableSpare}% spare`);
  } else {
    if (d.reallocated !== null) out.push(`${d.reallocated.toLocaleString()} reallocated`);
    if (d.pending !== null) out.push(`${d.pending.toLocaleString()} pending`);
  }
  return out;
}

function Disk({ d }: { d: DiskHealth }) {
  const l = LEVEL[d.level];
  const about = [d.model, d.capacityBytes ? fmtBytes(d.capacityBytes) : '', KIND[d.kind]].filter(Boolean).join(' · ');
  return (
    <div className="disk-row">
      <span className="dot" style={{ width: 8, height: 8, background: l.dot, marginTop: 6 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span>
          <span className="mono" style={{ fontSize: 13 }}>
            {d.name}
          </span>
          {about && <span className="meta"> · {about}</span>}
        </span>
        {d.error ? <span className="meta">{d.error}</span> : <span className="meta tnum">{facts(d).join(' · ') || 'SMART gave no figures for this disk.'}</span>}
        {d.problems.map((p) => (
          <span key={p} style={{ fontSize: 13, color: 'var(--wn)' }}>
            {p}
          </span>
        ))}
      </div>
      <span className={'chip ' + l.chip} title={d.serial ? `Serial ${d.serial}` : undefined}>
        {l.text}
      </span>
    </div>
  );
}

/** What to do on the server before SMART can be read. */
function Setup({ r }: { r: DisksReport }) {
  if (r.status === 'no-ssh') {
    return (
      <div className="empty" style={{ gap: 8 }}>
        <p style={{ fontSize: 13 }}>Disk health is read over SSH, like the terminal, which isn’t set up yet. See docs/setup.md, steps 9 and 10.</p>
      </div>
    );
  }
  if (r.status === 'error') {
    return (
      <div className="empty" style={{ gap: 8 }}>
        <p style={{ fontSize: 13 }}>Couldn’t read the disks: {r.message}</p>
      </div>
    );
  }
  return (
    <div className="disk-setup">
      <p>{r.message} Two steps on the server, once, as your SSH user:</p>
      <ol>
        {r.status === 'no-smartctl' ? (
          <li>
            Install smartmontools:
            <Copyable text="sudo apt install smartmontools" />
          </li>
        ) : (
          <li>
            Install smartmontools if it isn’t there: <span className="mono">sudo apt install smartmontools</span>
          </li>
        )}
        <li>
          Let your user run smartctl, and nothing else, without a password:
          <Copyable text={SUDOERS_LINE} />
        </li>
      </ol>
      <p className="meta">Then press refresh. See docs/setup.md, step 10.</p>
    </div>
  );
}

const CHECK_EVERY = 5 * 60_000;

/** SMART health and temperature for each disk. The server reads it at most every 30 minutes. */
export function DisksPanel({ now }: { now: Date }) {
  const [r, setR] = useState<DisksReport | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback((refresh: boolean) => {
    setBusy(true);
    api
      .disks(refresh)
      .then((x) => {
        setR(x);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    load(false);
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(false), CHECK_EVERY);
    return () => clearInterval(iv);
  }, [load]);

  const disks = r?.status === 'ok' ? r.disks : [];
  const bad = disks.filter((d) => d.level === 'bad').length;
  const warn = disks.filter((d) => d.level === 'warn').length;
  const summary = !disks.length ? null : bad ? { chip: 'chip-warn', text: `${bad} failing` } : warn ? { chip: 'chip-warn', text: `${warn} worth a look` } : { chip: 'chip-accent', text: 'All healthy' };

  return (
    <section className="panel srv-panel disks" aria-label="Disks">
      <div className="panel-head">
        <h2 className="panel-title">Disks</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {summary && <span className={'chip ' + summary.chip}>{summary.text}</span>}
          {r?.at && <span className="meta">Read {ago(r.at, now)}</span>}
          <button className="icon-btn" title="Read SMART again now" aria-label="Read the disks again" onClick={() => load(true)} disabled={busy}>
            <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-arrow-clockwise')} />
          </button>
        </div>
      </div>
      {error && <div className="status-line" style={{ margin: 0 }}>Couldn’t check the disks: {error}</div>}
      {!r ? (
        !error && (
          <div className="empty">
            <p style={{ fontSize: 13 }}>Reading SMART…</p>
          </div>
        )
      ) : r.status === 'ok' ? (
        <div className="disk-list">
          {disks.map((d) => (
            <Disk key={d.name} d={d} />
          ))}
        </div>
      ) : (
        <Setup r={r} />
      )}
    </section>
  );
}
