import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanIgLimit, IG_DEFAULT_LIMIT, IG_MAX_LIMIT, parseInstagram } from '../../../shared/instagram';
import type { DownloadJob, DownloadsInfo, InstagramInfo, Torrent, TorrentsInfo, TorrentStatus } from '../../../shared/types';
import { api, localGet, localSet } from '../api';
import { fmtBytes, hm } from '../util';
import { Copyable } from './Copyable';

const POLL = 2000;

/** Where a pasted link goes: qBittorrent for magnets and .torrent files, Instagram's posts and profiles through instaloader, otherwise straight to a folder. */
export function linkKind(text: string): 'torrent' | 'http' | 'instagram' | null {
  const ig = parseInstagram(text);
  if (ig) return 'error' in ig ? null : 'instagram';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.every((l) => /^magnet:\?/i.test(l) || /^https?:\/\/\S+\.torrent(\?\S*)?$/i.test(l))) return 'torrent';
  if (lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0])) return 'http';
  return null;
}

export const fmtRate = (bps: number) => (bps > 0 ? `${fmtBytes(bps)}/s` : '');

/** 45 s, 12 min, 3 h 20 min, 2 days. */
export function fmtEta(sec: number | null): string {
  if (sec === null || !Number.isFinite(sec) || sec < 0) return '';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  if (sec < 3600) return `${Math.round(sec / 60)} min`;
  if (sec < 86_400) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m ? `${h} h ${m} min` : `${h} h`;
  }
  const d = Math.round(sec / 86_400);
  return `${d} day${d === 1 ? '' : 's'}`;
}

/** Poll while the page is in view. */
function usePoll(fn: () => void, every: number) {
  useEffect(() => {
    fn();
    const iv = window.setInterval(() => document.visibilityState === 'visible' && fn(), every);
    return () => clearInterval(iv);
  }, [fn, every]);
}

/** The Server view's Downloads tab: links fetched straight to the server, and qBittorrent's torrents. */
export function DownloadsPanel({ shellReady, onOpenFolder }: {
  /** The SSH login works, so links can be written to the server's folders; null while that's being checked. */
  shellReady: boolean | null;
  onOpenFolder: (path: string) => void;
}) {
  const [dl, setDl] = useState<DownloadsInfo | null>(null);
  const [dlError, setDlError] = useState('');
  const [tor, setTor] = useState<TorrentsInfo | null>(null);
  const [torError, setTorError] = useState('');

  const loadDl = useCallback(() => {
    if (!shellReady) return;
    api
      .downloads()
      .then((d) => {
        setDl(d);
        setDlError('');
      })
      .catch((e: Error) => setDlError(e.message));
  }, [shellReady]);
  const loadTor = useCallback(() => {
    api
      .torrents()
      .then((t) => {
        setTor(t);
        setTorError('');
      })
      .catch((e: Error) => setTorError(e.message));
  }, []);
  usePoll(loadDl, POLL);
  usePoll(loadTor, POLL);

  return (
    <div className="dl-view">
      <AddBox
        shellReady={shellReady !== false}
        defaultDir={dl?.defaultDir ?? null}
        torrentsOn={!!tor?.configured}
        instagram={dl?.instagram ?? null}
        onInstagram={(instagram) => setDl((d) => d && { ...d, instagram })}
        onAdded={loadDl}
        onTorrents={setTor}
      />
      <div className="server-row dl-row">
        <DownloadList info={dl} error={dlError} shellReady={shellReady} onChanged={loadDl} onOpenFolder={onOpenFolder} />
        <Torrents info={tor} error={torError} onInfo={setTor} onOpenFolder={shellReady ? onOpenFolder : undefined} />
      </div>
    </div>
  );
}

// ---------- adding ----------

function AddBox({ shellReady, defaultDir, torrentsOn, instagram, onInstagram, onAdded, onTorrents }: {
  shellReady: boolean;
  defaultDir: string | null;
  torrentsOn: boolean;
  /** Null until the list has loaded. */
  instagram: InstagramInfo | null;
  onInstagram: (i: InstagramInfo) => void;
  onAdded: () => void;
  onTorrents: (t: TorrentsInfo) => void;
}) {
  const [text, setText] = useState('');
  const [dir, setDir] = useState(() => localGet('dlDir') ?? '');
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [igOpen, setIgOpen] = useState(false);
  const [igLimit, setIgLimit] = useState(() => localGet('igLimit') ?? String(IG_DEFAULT_LIMIT));
  const [igMeta, setIgMeta] = useState(() => localGet('igMeta') === '1');
  const file = useRef<HTMLInputElement>(null);
  const kind = linkKind(text);
  const ig = parseInstagram(text);
  const igTarget = ig && !('error' in ig) ? ig : null;
  const folder = dir.trim() || defaultDir || '';
  const igReady = !!instagram?.available;

  const done = (msg: string) => {
    setText('');
    setNote({ text: msg, failed: false });
  };
  const failed = (e: Error) => setNote({ text: e.message, failed: true });

  const add = () => {
    if (!kind || busy) return;
    setBusy(true);
    const p =
      kind === 'torrent'
        ? api.addTorrents(text).then((t) => {
            onTorrents(t);
            done(text.trim().includes('\n') ? 'Added to qBittorrent.' : 'Added to qBittorrent. It shows below once it has the torrent’s details.');
          })
        : api.startDownload(text.trim(), folder, kind === 'instagram' ? { limit: cleanIgLimit(igLimit), metadata: igMeta } : undefined).then((j) => {
            if (dir.trim()) localSet('dlDir', dir.trim());
            onAdded();
            if (!j.ig) done(`Downloading ${j.name} into ${j.dir}.`);
            else {
              localSet('igLimit', String(cleanIgLimit(igLimit)));
              localSet('igMeta', igMeta ? '1' : '0');
              done(j.ig.queued ? `${j.name} starts when the Instagram download before it is done.` : `Saving ${j.name} into ${j.dir}.`);
            }
          });
    p.catch(failed).finally(() => setBusy(false));
  };

  const addFile = (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    api
      .addTorrentFile(f)
      .then((t) => {
        onTorrents(t);
        done(`Added ${f.name} to qBittorrent.`);
      })
      .catch(failed)
      .finally(() => {
        setBusy(false);
        if (file.current) file.current.value = '';
      });
  };

  const into = folder || 'your home folder';
  const hint =
    ig && 'error' in ig
      ? ig.error
      : kind === 'torrent'
        ? torrentsOn
          ? 'Goes to qBittorrent.'
          : 'That’s a torrent: set up qBittorrent below to download it.'
        : !shellReady && (kind === 'http' || kind === 'instagram')
          ? 'Set up the terminal’s SSH login first: downloads are written over it.'
          : kind === 'http'
            ? `Saves into ${into}.`
            : igTarget
              ? !instagram
                ? 'Checking Instagram downloads are set up…'
                : !igReady
                  ? instagram.error || 'Instagram downloads aren’t set up on this server.'
                  : igTarget.profile
                    ? `Saves the newest posts of @${igTarget.profile} into ${into}/${igTarget.profile}.${instagram.account ? '' : ' Public profiles only until you sign in.'}`
                    : `Saves ${igTarget.posts.length === 1 ? 'the post’s' : `the ${igTarget.posts.length} posts’`} photos and videos into ${into}, in a folder for each account.`
              : text.trim()
                ? 'Paste an https:// link, Instagram links one a line, or magnet links one a line.'
                : 'An https:// link downloads straight to the server, an Instagram post or profile saves its photos and videos, and a magnet link goes to qBittorrent.';
  const blocked = !kind || (kind === 'torrent' ? !torrentsOn : !shellReady || (kind === 'instagram' && !igReady));

  return (
    <section className="panel srv-panel dl-add" aria-label="Download to the server">
      <div className="panel-head">
        <h2 className="panel-title">Download to the server</h2>
        {(torrentsOn || igReady) && (
          <span className="dl-head-tools">
            {igReady && (
              <button
                className="btn btn-secondary btn-small"
                aria-expanded={igOpen}
                title={instagram!.account ? (instagram!.stale ? 'Instagram turned this session away last time' : 'Signed in to Instagram') : 'Sign in to Instagram, for private posts'}
                onClick={() => setIgOpen(!igOpen)}
              >
                <i className={'ph-duotone ' + (instagram!.stale ? 'ph-warning-circle' : 'ph-instagram-logo')} style={instagram!.stale ? { color: 'var(--wn)' } : undefined} />
                {instagram!.account ? `@${instagram!.account}` : 'Instagram'}
              </button>
            )}
            {torrentsOn && (
              <>
                <input ref={file} type="file" accept=".torrent,application/x-bittorrent" hidden onChange={(e) => addFile(e.target.files?.[0])} />
                <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => file.current?.click()}>
                  <i className="ph-duotone ph-file-arrow-up" />
                  Add a .torrent file
                </button>
              </>
            )}
          </span>
        )}
      </div>
      <form
        className="dl-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <textarea
          className="input mono dl-link"
          rows={text.includes('\n') ? 4 : 1}
          value={text}
          placeholder="https://…, an Instagram link, or magnet:?xt=…"
          onChange={(e) => {
            setText(e.target.value);
            // What the last one said gives way to what this one will do.
            if (e.target.value.trim()) setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              add();
            }
          }}
          onDrop={(e) => {
            const f = e.dataTransfer.files?.[0];
            if (f && /\.torrent$/i.test(f.name)) {
              e.preventDefault();
              addFile(f);
            }
          }}
          aria-label="Link to download"
          spellCheck={false}
        />
        {kind !== 'torrent' && (
          <label className="dl-dir">
            <i className="ph-duotone ph-folder-simple" />
            <input className="input sm mono" value={dir} placeholder={defaultDir ?? 'Folder on the server'} onChange={(e) => setDir(e.target.value)} aria-label="Folder to save into" spellCheck={false} disabled={!shellReady} />
          </label>
        )}
        <button className="btn btn-primary" disabled={blocked || busy}>
          <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : kind === 'torrent' ? 'ph-magnet' : kind === 'instagram' ? 'ph-instagram-logo' : 'ph-download-simple')} />
          Download
        </button>
      </form>
      {kind === 'instagram' && igReady && (
        <div className="dl-ig-opts">
          {igTarget?.profile && (
            <label className="dl-ig-limit">
              Newest
              <input
                className="input sm tnum"
                type="number"
                min={1}
                max={IG_MAX_LIMIT}
                value={igLimit}
                onChange={(e) => setIgLimit(e.target.value)}
                onBlur={() => setIgLimit(String(cleanIgLimit(igLimit)))}
                aria-label="How many of the newest posts"
              />
              posts
            </label>
          )}
          <span className="dl-ig-toggle">
            <button type="button" role="switch" aria-checked={igMeta} aria-labelledby="dl-ig-meta" className={'switch' + (igMeta ? ' on' : '')} onClick={() => setIgMeta(!igMeta)}>
              <span />
            </button>
            <span id="dl-ig-meta" onClick={() => setIgMeta(!igMeta)}>
              Caption and details too
            </span>
          </span>
        </div>
      )}
      <span className="meta" role="status" style={note?.failed || (!note && ig && 'error' in ig) ? { color: 'var(--wn)' } : undefined}>
        {note?.text ?? hint}
      </span>
      {igOpen && instagram && igReady && <IgSession info={instagram} onInfo={onInstagram} onClose={() => setIgOpen(false)} />}
    </section>
  );
}

// ---------- links ----------

function DownloadList({ info, error, shellReady, onChanged, onOpenFolder }: {
  info: DownloadsInfo | null;
  error: string;
  shellReady: boolean | null;
  onChanged: () => void;
  onOpenFolder: (path: string) => void;
}) {
  const [actError, setActError] = useState('');
  const act = (p: Promise<unknown>) =>
    p
      .then(() => {
        setActError('');
        onChanged();
      })
      .catch((e: Error) => setActError(e.message));
  const jobs = info?.jobs ?? [];
  const finished = jobs.some((j) => j.state !== 'starting' && j.state !== 'downloading');
  return (
    <section className="panel srv-panel dl-list" aria-label="Downloads">
      <div className="panel-head">
        <h2 className="panel-title">Links</h2>
        {finished && (
          <button className="btn btn-secondary btn-small" onClick={() => act(api.clearDownloads())}>
            Clear finished
          </button>
        )}
      </div>
      {(error || actError) && <div className="status-line" style={{ margin: 0 }}>{actError || error}</div>}
      {shellReady === false ? (
        <div className="empty">
          <p>Links download over the terminal’s SSH login. Open the Terminal tab to set it up.</p>
        </div>
      ) : !jobs.length ? (
        <div className="empty">
          <p>{info ? 'Nothing downloaded since Launchpad last started.' : error ? '' : 'Loading…'}</p>
        </div>
      ) : (
        <div className="dl-items">
          {jobs.map((j) => (
            <JobRow
              key={j.id}
              j={j}
              onCancel={() => act(api.cancelDownload(j.id))}
              onRetry={() => act(api.startDownload(j.url, j.dir, j.ig ? { limit: j.ig.limit ?? undefined, metadata: j.ig.metadata } : undefined))}
              onOpenFolder={() => onOpenFolder(j.ig?.folder ?? j.dir)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

const count = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** An Instagram job's line under its name: where it's got to, or what it saved. */
export function igDetail(j: DownloadJob): string {
  const ig = j.ig!;
  if (j.state === 'starting' || j.state === 'downloading') {
    if (ig.queued) return 'Starts when the Instagram download before it is done';
    if (ig.waitUntil) return `Instagram asked to slow down · carrying on at ${hm(new Date(ig.waitUntil))}`;
    if (!ig.postsDone && !ig.current) return ig.want === 1 && ig.limit === null ? 'Finding the post…' : 'Finding the posts…';
    return [
      ig.want > 1 ? `post ${Math.min(ig.postsDone + 1, ig.want)} of ${ig.want}` : '',
      ig.current && ig.current.of > 1 ? `file ${Math.min(ig.current.done + 1, ig.current.of)} of ${ig.current.of}` : '',
      j.received ? fmtBytes(j.received) : '',
      ig.skipped ? `${ig.skipped} already there` : '',
      // A speed of a few bytes a second is one that's still settling (or files being skipped).
      j.bps >= 1000 ? fmtRate(j.bps) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  if (j.state === 'failed') return j.error || 'Failed';
  const saved = ig.files ? `${count(ig.files, 'file')} · ${fmtBytes(j.received)}` : '';
  if (j.state === 'cancelled') return saved ? `Cancelled · ${saved} saved` : 'Cancelled';
  if (!ig.postsDone) return 'No posts to save';
  return [saved || (ig.skipped ? '' : 'Nothing new'), ig.skipped ? `${ig.skipped} already there` : '', ig.failed ? `${count(ig.failed, 'post')} couldn’t be read` : '', `in ${ig.folder ?? j.dir}`].filter(Boolean).join(' · ');
}

/** How far through an Instagram job is, by posts and the files of the one being saved; null while it's still finding them. */
export function igPercent(ig: NonNullable<DownloadJob['ig']>): number | null {
  if (ig.queued || ig.waitUntil || (!ig.postsDone && !ig.current) || !ig.want) return null;
  const part = ig.current && ig.current.of ? ig.current.done / ig.current.of : 0;
  return Math.min(100, ((ig.postsDone + part) / ig.want) * 100);
}

function JobRow({ j, onCancel, onRetry, onOpenFolder }: { j: DownloadJob; onCancel: () => void; onRetry: () => void; onOpenFolder: () => void }) {
  const going = j.state === 'starting' || j.state === 'downloading';
  const pct = j.ig ? igPercent(j.ig) : j.total ? (j.received / j.total) * 100 : null;
  const left = j.total && j.bps ? (j.total - j.received) / j.bps : null;
  const detail = j.ig
    ? igDetail(j)
    : going
      ? [j.total ? `${fmtBytes(j.received)} of ${fmtBytes(j.total)}` : fmtBytes(j.received), fmtRate(j.bps), left !== null ? `${fmtEta(left)} left` : ''].filter(Boolean).join(' · ')
      : j.state === 'done'
        ? `${fmtBytes(j.received)} · in ${j.dir}`
        : j.state === 'cancelled'
          ? 'Cancelled'
          : j.error || 'Failed';
  // Some of an Instagram job's posts couldn't be read: done, but worth a look.
  const partly = j.state === 'done' && !!j.ig?.failed;
  const folder = j.ig?.folder ?? j.dir;
  return (
    <div className="dl-item">
      <i
        className={'ph-duotone ' + (j.state === 'done' ? (partly ? 'ph-warning-circle' : 'ph-check-circle') : j.state === 'failed' ? 'ph-warning-circle' : j.state === 'cancelled' ? 'ph-x-circle' : j.ig ? 'ph-instagram-logo' : 'ph-download-simple')}
        style={{ color: j.state === 'failed' || partly ? 'var(--wn)' : j.state === 'done' ? 'var(--ac)' : 'var(--t3)' }}
      />
      <div className="dl-item-main">
        <span className="dl-name" title={j.url}>
          {j.name}
        </span>
        {going && (
          <div className={'dl-bar' + (pct === null ? ' unknown' : '')}>
            <span style={{ width: `${pct ?? 30}%` }} />
          </div>
        )}
        <span className="meta tnum" style={j.state === 'failed' ? { color: 'var(--wn)' } : undefined} title={partly ? (j.ig!.lastError ?? undefined) : detail}>
          {detail}
        </span>
      </div>
      <span className="dl-tools">
        {going && (
          <button className="icon-btn" title="Cancel" aria-label={`Cancel ${j.name}`} onClick={onCancel}>
            <i className="ph-duotone ph-x" />
          </button>
        )}
        {(j.state === 'failed' || j.state === 'cancelled') && (
          <button className="icon-btn" title="Try again" aria-label={`Try ${j.name} again`} onClick={onRetry}>
            <i className="ph-duotone ph-arrow-clockwise" />
          </button>
        )}
        {(j.state === 'done' || (j.state === 'cancelled' && !!j.ig?.files)) && (
          <button className="icon-btn" title="Open the folder in Files" aria-label={`Open ${folder} in Files`} onClick={onOpenFolder}>
            <i className="ph-duotone ph-folder-open" />
          </button>
        )}
      </span>
    </div>
  );
}

// ---------- Instagram sign-in ----------

/** Signing Instagram downloads in with a browser's session, or out again. */
function IgSession({ info, onInfo, onClose }: { info: InstagramInfo; onInfo: (i: InstagramInfo) => void; onClose: () => void }) {
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [replacing, setReplacing] = useState(false);
  const run = (p: Promise<InstagramInfo>, after?: () => void) => {
    setBusy(true);
    setError('');
    p.then((i) => {
      onInfo(i);
      setCookie('');
      setReplacing(false);
      after?.();
    })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const asking = !info.account || info.stale || replacing;
  return (
    <div className="shell-setup dl-ig-session" role="group" aria-label="Instagram sign-in">
      {info.account && (
        <p>
          {info.stale ? (
            <>
              <i className="ph-duotone ph-warning-circle" style={{ color: 'var(--wn)' }} /> Instagram turned away the session for <b>@{info.account}</b> last time. Paste a fresh one below, or sign out to download public posts only.
            </>
          ) : (
            <>
              Signed in to Instagram as <b>@{info.account}</b>, so private posts you can see download too.
            </>
          )}
        </p>
      )}
      {asking && (
        <>
          {!info.account && <p>Public posts and profiles download without signing in. For private ones you follow, or when Instagram limits the server, give Launchpad the session of a browser that’s signed in:</p>}
          <ol>
            <li>Sign in at instagram.com, ideally in a private window.</li>
            <li>
              Open the developer tools (F12) › Application (Storage in Firefox) › Cookies › https://www.instagram.com, and copy the value of <span className="mono">sessionid</span>.
            </li>
            <li>Paste it here. Close that window without signing out, as signing out ends the session.</li>
          </ol>
          <form
            className="dl-ig-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (cookie.trim() && !busy) run(api.instagramSignIn(cookie.trim()));
            }}
          >
            <input
              className="input sm mono"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={cookie}
              onChange={(e) => setCookie(e.target.value)}
              placeholder="sessionid, or the whole Cookie header"
              aria-label="Instagram session cookie"
            />
            <button className="btn btn-primary btn-small" disabled={!cookie.trim() || busy}>
              <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-sign-in')} />
              {busy ? 'Checking with Instagram…' : 'Sign in'}
            </button>
          </form>
        </>
      )}
      {error && (
        <span className="meta" role="alert" style={{ color: 'var(--wn)' }}>
          {error}
        </span>
      )}
      <div className="dl-ig-actions">
        {info.account && !info.stale && !replacing && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => setReplacing(true)}>
            Use another session
          </button>
        )}
        {info.account && (
          <button className="btn btn-secondary btn-small" disabled={busy} onClick={() => run(api.instagramSignOut())}>
            Sign out
          </button>
        )}
        <button className="btn btn-secondary btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      <span className="meta">The session stays on the server, readable by Launchpad alone: not in this browser or in backups. It’s used for these downloads and nothing else.</span>
    </div>
  );
}

// ---------- torrents ----------

const STATUS: Record<TorrentStatus, { text: string; cls: string }> = {
  downloading: { text: 'Downloading', cls: 'chip-accent' },
  seeding: { text: 'Seeding', cls: 'chip-accent' },
  done: { text: 'Done', cls: 'chip-neutral' },
  paused: { text: 'Paused', cls: 'chip-neutral' },
  queued: { text: 'Queued', cls: 'chip-muted' },
  checking: { text: 'Checking', cls: 'chip-muted' },
  stalled: { text: 'Stalled', cls: 'chip-warn' },
  metadata: { text: 'Getting details', cls: 'chip-muted' },
  moving: { text: 'Moving', cls: 'chip-muted' },
  error: { text: 'Error', cls: 'chip-warn' },
};

/** A torrent that's running can be paused; a paused or finished one started again. */
export const canResume = (t: Pick<Torrent, 'state'>) => /^(paused|stopped)/.test(t.state);

function Torrents({ info, error, onInfo, onOpenFolder }: { info: TorrentsInfo | null; error: string; onInfo: (t: TorrentsInfo) => void; onOpenFolder?: (path: string) => void }) {
  const [actError, setActError] = useState('');
  const act = (p: Promise<TorrentsInfo>) =>
    p
      .then((t) => {
        onInfo(t);
        setActError('');
      })
      .catch((e: Error) => setActError(e.message));
  const [deleting, setDeleting] = useState<string | null>(null);

  const list = info?.torrents ?? [];
  return (
    <section className="panel srv-panel torrents" aria-label="Torrents">
      <div className="panel-head">
        <h2 className="panel-title">Torrents</h2>
        {info?.configured && !info.error && (
          <span className="meta tnum" style={{ display: 'inline-flex', gap: 10 }}>
            <span title="Download speed">↓ {fmtRate(info.dlBps) || '0 B/s'}</span>
            <span title="Upload speed">↑ {fmtRate(info.upBps) || '0 B/s'}</span>
          </span>
        )}
      </div>
      {(error || actError || info?.error) && <div className="status-line" style={{ margin: 0 }}>{actError || error || info?.error}</div>}
      {info && !info.configured ? (
        <TorrentSetup />
      ) : !list.length ? (
        <div className="empty">
          <p>{info ? (info.error ? '' : 'No torrents. Paste a magnet link above.') : error ? '' : 'Loading…'}</p>
        </div>
      ) : (
        <div className="dl-items">
          {list.map((t) => {
            const st = STATUS[t.status];
            const going = t.progress < 1;
            const detail = [
              going ? `${fmtBytes(t.done)} of ${fmtBytes(t.size)}` : fmtBytes(t.size),
              t.dlBps ? `↓ ${fmtRate(t.dlBps)}` : '',
              t.upBps ? `↑ ${fmtRate(t.upBps)}` : '',
              t.etaSec !== null ? `${fmtEta(t.etaSec)} left` : '',
              going ? `${t.seeds} seeds · ${t.peers} peers` : `ratio ${t.ratio}`,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <div key={t.hash} className="dl-item torrent">
                <span className={'chip ' + st.cls}>{st.text}</span>
                <div className="dl-item-main">
                  <span className="dl-name" title={t.name}>
                    {t.name}
                  </span>
                  {going && (
                    <div className="dl-bar">
                      <span style={{ width: `${t.progress * 100}%`, background: t.status === 'paused' || t.status === 'stalled' ? 'var(--t3)' : undefined }} />
                    </div>
                  )}
                  <span className="meta tnum">
                    {going ? `${Math.floor(t.progress * 1000) / 10}% · ` : ''}
                    {detail}
                  </span>
                </div>
                <span className="dl-tools">
                  <button
                    className="icon-btn"
                    title={canResume(t) ? 'Resume' : 'Pause'}
                    aria-label={`${canResume(t) ? 'Resume' : 'Pause'} ${t.name}`}
                    onClick={() => act(api.torrentAction([t.hash], canResume(t) ? 'start' : 'stop'))}
                  >
                    <i className={'ph-duotone ' + (canResume(t) ? 'ph-play' : 'ph-pause')} />
                  </button>
                  {onOpenFolder && t.hostDir && (
                    <button className="icon-btn" title="Open the folder in Files" aria-label={`Open ${t.hostDir} in Files`} onClick={() => onOpenFolder(t.hostDir!)}>
                      <i className="ph-duotone ph-folder-open" />
                    </button>
                  )}
                  <button className="icon-btn" title="Delete" aria-label={`Delete ${t.name}`} aria-expanded={deleting === t.hash} onClick={() => setDeleting(deleting === t.hash ? null : t.hash)}>
                    <i className="ph-duotone ph-trash" />
                  </button>
                </span>
                {deleting === t.hash && (
                  <div className="dl-confirm" role="group" aria-label={`Delete ${t.name}`}>
                    <span className="meta">Delete from qBittorrent:</span>
                    <button className="btn btn-secondary btn-small" onClick={() => (setDeleting(null), act(api.torrentAction([t.hash], 'delete')))}>
                      Keep the files
                    </button>
                    <button className="btn btn-secondary btn-small" style={{ color: 'var(--wn)' }} onClick={() => (setDeleting(null), act(api.torrentAction([t.hash], 'deleteFiles')))}>
                      Delete the files too
                    </button>
                    <button className="btn btn-secondary btn-small" onClick={() => setDeleting(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {info?.configured && info.hostDir && <span className="meta">Saved in <span className="mono">{info.hostDir}</span> on the server.</span>}
    </section>
  );
}

function TorrentSetup() {
  return (
    <div className="shell-setup dl-setup">
      <p>Torrents come from qBittorrent, running next to Launchpad. Once, on the server:</p>
      <ol>
        <li>
          Get the new docker-compose.yml and make a folder for torrents:
          <Copyable text="cd ~/launchpad && git pull && mkdir -p ~/torrents && echo $HOME/torrents" />
          Then set <span className="mono">TORRENTS_DIR</span> in <span className="mono">~/launchpad/.env</span> to the path it printed.
        </li>
        <li>
          Start it, then read the password qBittorrent made for <span className="mono">admin</span>:
          <Copyable text="docker compose up -d && sleep 5 && docker logs qbittorrent 2>&1 | grep -i password" />
        </li>
        <li>
          Sign in at <span className="mono">http://&lt;server&gt;:8091</span> on your network, set a password of your own (Tools › Options › Web UI), then add it to <span className="mono">.env</span> as{' '}
          <span className="mono">QBIT_USER</span> and <span className="mono">QBIT_PASS</span> and run <span className="mono">docker compose up -d</span> again.
        </li>
      </ol>
      <p className="meta">See docs/setup.md, step 11.</p>
    </div>
  );
}
