import { useCallback, useEffect, useRef, useState } from 'react';
import { MON } from '../../../shared/dates';
import type { McBackup, McBackups, McStatus } from '../../../shared/types';
import { api } from '../api';

const EVERY = 30_000;
const WHILE_BUSY = 2_000;

export function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** "18 Nov 14:30", with the year when it isn't this one. */
export function fmtWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "3 min", "1 h 5 min", for how long something has taken. */
export function fmtTook(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The Minecraft console's Backups: back up now, and the backups there are, to restore or delete. */
export function McBackupsView({ s, onChanged }: { s: McStatus; onChanged: () => void }) {
  const [data, setData] = useState<McBackups | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [, tick] = useState(0);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  const wasRunning = useRef(false);

  const load = useCallback(() => {
    api
      .mcBackups(s.id)
      .then((d) => {
        if (!alive.current) return;
        setData(d);
        setError('');
      })
      .catch((e: Error) => alive.current && setError(e.message));
  }, [s.id]);

  const running = !!data?.job && !data.job.endedAt;
  useEffect(() => {
    load();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && load(), running ? WHILE_BUSY : EVERY);
    return () => clearInterval(iv);
  }, [load, running]);

  // The elapsed time counts up while a job runs; the server list catches up once it ends.
  useEffect(() => {
    if (!running) {
      if (wasRunning.current) onChanged();
      wasRunning.current = false;
      return;
    }
    wasRunning.current = true;
    const iv = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [running, onChanged]);

  const call = (key: string, p: Promise<McBackups>) => {
    setBusy(key);
    p.then((d) => alive.current && (setData(d), setError('')))
      .catch((e: Error) => alive.current && setError(e.message))
      .finally(() => alive.current && setBusy(null));
  };

  const backUp = () => call('backup', api.mcBackup(s.id));
  const restore = (b: McBackup) => {
    const msg = `Restore ${s.name}’s world from the backup of ${fmtWhen(b.at)}?\n\nThe world as it is now is backed up first, so this can be undone by restoring that backup.`;
    if (window.confirm(msg)) call(`restore:${b.name}`, api.mcRestore(s.id, b.name));
  };
  const remove = (b: McBackup) => {
    if (window.confirm(`Delete the backup of ${fmtWhen(b.at)} (${fmtSize(b.size)})? It can’t be brought back.`)) call(`delete:${b.name}`, api.mcDeleteBackup(s.id, b.name));
  };

  const job = data?.job ?? null;
  const elsewhere = !!s.job && !running;
  const canBackUp = !running && !elsewhere && !busy && !!s.dir && (!s.running || s.attached);
  const now = new Date();
  return (
    <div className="mc-view" aria-label="Backups">
      <div className="mc-view-head">
        <span className={'meta mc-view-where' + (data ? '' : ' lp-loading')} title={data?.dir}>
          {data ? `Keeps the newest ${data.keep} in ${data.dir}${data.free !== null ? ` · ${fmtSize(data.free)} free` : ''}` : 'Looking for backups…'}
        </span>
        <button className="btn btn-primary btn-small" disabled={!canBackUp} onClick={backUp} title={s.running && !s.attached ? 'It runs outside tmux or screen, so its saving can’t be paused for a clean copy' : undefined}>
          <i className={'ph-duotone ' + (busy === 'backup' ? 'ph-circle-notch spin' : 'ph-archive')} />
          {busy === 'backup' ? 'Measuring…' : 'Back up now'}
        </button>
      </div>
      {s.running && !s.attached && <p className="meta mc-note">{s.name} runs outside tmux or screen, so Launchpad can’t pause its saving. Stop it to back it up.</p>}
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      {job && (
        <div className={'mc-job' + (job.ok === false ? ' failed' : '')} role="status">
          <i className={'ph-duotone ' + (!job.endedAt ? 'ph-circle-notch spin' : job.ok ? 'ph-check-circle' : 'ph-warning')} aria-hidden />
          <div className="mc-job-text">
            {!job.endedAt ? (
              <>
                <span>
                  {job.kind === 'backup' ? 'Backing up' : 'Restoring'}: {job.step}
                </span>
                <span className="meta">
                  {fmtTook(Date.now() - Date.parse(job.startedAt))} so far{job.bytes ? ` · ${fmtSize(job.bytes)} packed` : ''}
                  {job.kind === 'restore' ? ` · ${s.name} can’t be started until it’s done` : ''}
                </span>
              </>
            ) : (
              <>
                <span>{job.message}</span>
                <span className="meta">
                  {job.kind === 'backup' ? 'Backup' : 'Restore'} {job.ok ? 'finished' : 'failed'} {fmtWhen(job.endedAt, now)}, after {fmtTook(Date.parse(job.endedAt) - Date.parse(job.startedAt))}
                </span>
              </>
            )}
          </div>
          {job.endedAt && (
            <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => call('dismiss', api.mcDismissJob(s.id))}>
              <i className="ph-duotone ph-x" />
            </button>
          )}
        </div>
      )}
      {!!data?.leftovers.length && (
        <p className="meta mc-note warn">
          A restore was cut off before it finished. {data.leftovers.join(', ')} in {s.dir} {data.leftovers.length > 1 ? 'are' : 'is'} what it left: a folder starting .launchpad-old holds the world from before it. Check the world, then delete them in Files.
        </p>
      )}
      {data && !data.list.length && <p className="meta">No backups yet. Back up now packs the world into {data.dir}.</p>}
      {!!data?.list.length && (
        <ul className="mc-backups" aria-label="Backups">
          {data.list.map((b) => (
            <li key={b.name} className="mc-backup">
              <i className="ph-duotone ph-archive" aria-hidden />
              <div className="mc-backup-text">
                <span className="mc-backup-when">
                  <span>{fmtWhen(b.at, now)}</span>
                  {b.beforeRestore && <span className="chip chip-neutral">Before a restore</span>}
                </span>
                <span className="meta mono" title={b.name}>
                  {fmtSize(b.size)} · {b.name}
                </span>
              </div>
              <span className="mc-backup-tools">
                <button className="btn btn-secondary btn-small" disabled={running || elsewhere || !!busy || s.running} title={s.running ? `Stop ${s.name} first` : undefined} onClick={() => restore(b)}>
                  <i className={'ph-duotone ' + (busy === `restore:${b.name}` ? 'ph-circle-notch spin' : 'ph-clock-counter-clockwise')} />
                  Restore
                </button>
                <button className="icon-btn" disabled={running || elsewhere || !!busy} title="Delete this backup" aria-label={`Delete the backup of ${fmtWhen(b.at, now)}`} onClick={() => remove(b)}>
                  <i className={'ph-duotone ' + (busy === `delete:${b.name}` ? 'ph-circle-notch spin' : 'ph-trash')} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {data && s.running && !!data.list.length && <p className="meta">Stop {s.name} to restore a backup.</p>}
    </div>
  );
}
