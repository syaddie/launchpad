import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanIgLimit, IG_DEFAULT_LIMIT, IG_MAX_LIMIT, parseInstagram } from '../../../shared/instagram';
import { cleanVideoFormat, VIDEO_FORMATS, videoLink, videoNoun, type VideoSite } from '../../../shared/video';
import type { DownloadJob, DownloadsInfo, InstagramInfo, UnpackRecord, Torrent, TorrentFile, TorrentOptions, TorrentsInfo, TorrentSpeed, TorrentStatus, VideoFormat, VideoInfo } from '../../../shared/types';
import { api, localGet, localSet, type TorrentAdd } from '../api';
import { fmtBytes, hm } from '../util';
import { menuProps } from './ContextMenu';
import { Copyable } from './Copyable';
import { Glide } from './Motion';

const POLL = 2000;

/**
 * Where a pasted link goes: qBittorrent for magnets and .torrent files, Instagram's posts and profiles through
 * instaloader, YouTube, X, TikTok, Reddit and SoundCloud through yt-dlp, otherwise straight to a folder.
 */
export function linkKind(text: string): 'torrent' | 'http' | 'instagram' | 'video' | null {
  const ig = parseInstagram(text);
  if (ig) return 'error' in ig ? null : 'instagram';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  if (lines.every((l) => /^magnet:\?/i.test(l) || /^https?:\/\/\S+\.torrent(\?\S*)?$/i.test(l))) return 'torrent';
  if (lines.length === 1 && videoLink(lines[0])) return 'video';
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
export function DownloadsPanel({ shellReady, onOpenFolder, autoUnpack, onAutoUnpack }: {
  /** The SSH login works, so links can be written to the server's folders; null while that's being checked. */
  shellReady: boolean | null;
  onOpenFolder: (path: string) => void;
  /** Unpack archives when they finish (prefs). */
  autoUnpack: boolean;
  onAutoUnpack: (on: boolean) => void;
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
        video={dl?.video ?? null}
        onInstagram={(instagram) => setDl((d) => d && { ...d, instagram })}
        onAdded={loadDl}
        onTorrents={setTor}
      />
      <div className="server-row dl-row">
        <DownloadList info={dl} error={dlError} shellReady={shellReady} onChanged={loadDl} onOpenFolder={onOpenFolder} />
        <Torrents info={tor} error={torError} onInfo={setTor} onOpenFolder={shellReady ? onOpenFolder : undefined} />
      </div>
      <Unpacking on={autoUnpack} onToggle={() => onAutoUnpack(!autoUnpack)} records={dl?.unpacks ?? []} onOpenFolder={shellReady ? onOpenFolder : undefined} />
    </div>
  );
}

// ---------- unpacking ----------

const UNPACK_ICON: Record<UnpackRecord['state'], string> = { waiting: 'ph-hourglass', unpacking: 'ph-circle-notch spin', done: 'ph-check-circle', failed: 'ph-warning' };

const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;
const dirName = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

/** What happened to one archive, in a line. */
export function unpackLine(r: UnpackRecord): string {
  if (r.state === 'waiting') return 'Waiting to unpack';
  if (r.state === 'unpacking') return 'Unpacking…';
  if (r.state === 'done') return `Unpacked into ${baseName(r.folder ?? '')}`;
  return r.message || 'Couldn’t unpack it.';
}

/** The switch for unpacking finished archives, and what it's done since Launchpad started. */
function Unpacking({ on, onToggle, records, onOpenFolder }: { on: boolean; onToggle: () => void; records: UnpackRecord[]; onOpenFolder?: (path: string) => void }) {
  return (
    <section className="panel srv-panel dl-unpack" aria-label="Unpacking">
      <div className="mc-auto">
        <div className="mc-auto-text">
          <span id="dl-unpack-label">Unpack archives when they finish</span>
          <span className="meta">A .zip, .tar.gz, .7z or .rar link, or the archives in a torrent, unpack into a new folder beside them. The archive stays, so torrents keep seeding.</span>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-labelledby="dl-unpack-label" className={'switch' + (on ? ' on' : '')} onClick={onToggle}>
          <span />
        </button>
      </div>
      {!!records.length && (
        <ul className="dl-unpacks">
          {records.map((r) => (
            <li key={r.id} className={'dl-unpack-row ' + r.state}>
              <i className={'ph-duotone ' + UNPACK_ICON[r.state]} aria-hidden />
              <span className="dl-unpack-name" title={r.file}>{baseName(r.file)}</span>
              <span className="meta dl-unpack-what">{unpackLine(r)}</span>
              {onOpenFolder && (r.state === 'done' || r.state === 'failed') && (
                <button className="icon-btn" title="Show in Files" aria-label={`Show ${baseName(r.folder ?? r.file)} in Files`} onClick={() => onOpenFolder(r.state === 'done' && r.folder ? r.folder : dirName(r.file))}>
                  <i className="ph-duotone ph-folder-open" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- adding ----------

/** The category picker's choice for making a new one. */
const NEW_CATEGORY = '\u0000new';

function AddBox({ shellReady, defaultDir, torrentsOn, instagram, video, onInstagram, onAdded, onTorrents }: {
  shellReady: boolean;
  defaultDir: string | null;
  torrentsOn: boolean;
  /** Null until the list has loaded. */
  instagram: InstagramInfo | null;
  video: VideoInfo | null;
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
  const [format, setFormat] = useState<VideoFormat>(() => cleanVideoFormat(localGet('videoFormat')));
  /** What yt-dlp said about the last other site's link: the site it knows it as, or null. */
  const [site, setSite] = useState<{ url: string; site: string | null } | null>(null);
  const [useVideo, setUseVideo] = useState(true);
  /** A .torrent file picked or dropped, added when Download is pressed. */
  const [torFile, setTorFile] = useState<File | null>(null);
  const [torOpts, setTorOpts] = useState<TorrentOptions | null>(null);
  const [torOptsError, setTorOptsError] = useState('');
  const [category, setCategory] = useState('');
  const [newCategory, setNewCategory] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [ratio, setRatio] = useState(() => localGet('torRatio') ?? '');
  const file = useRef<HTMLInputElement>(null);

  const kind0 = torFile ? 'torrent' : linkKind(text);
  const ig = torFile ? null : parseInstagram(text);
  const igTarget = ig && !('error' in ig) ? ig : null;
  const vlink = kind0 === 'video' ? videoLink(text.trim()) : null;
  const httpUrl = kind0 === 'http' ? text.trim() : '';
  const videoReady = !!video?.available;
  // Links to other sites: ask yt-dlp whether it knows the site, once typing stops.
  useEffect(() => {
    if (!httpUrl || !videoReady || site?.url === httpUrl) return;
    const t = window.setTimeout(() => {
      api
        .videoSite(httpUrl)
        .then((r) => setSite({ url: httpUrl, site: r.site }))
        .catch(() => setSite({ url: httpUrl, site: null }));
    }, 450);
    return () => clearTimeout(t);
  }, [httpUrl, videoReady, site?.url]);
  const otherSite = httpUrl && site?.url === httpUrl ? site.site : null;
  const asking = !!httpUrl && videoReady && site?.url !== httpUrl;
  const kind = kind0 === 'http' && otherSite && useVideo ? 'video' : kind0;
  const audioOnly = !!vlink?.audio;
  const fmt: VideoFormat = audioOnly && format === '1080p' ? 'best' : format;
  const folder = dir.trim() || defaultDir || '';
  const igReady = !!instagram?.available;

  // Categories and tags, once there's a torrent to add.
  const wantOpts = kind === 'torrent' && torrentsOn;
  useEffect(() => {
    if (!wantOpts || torOpts) return;
    api
      .torrentOptions()
      .then((o) => {
        setTorOpts(o);
        setTorOptsError('');
      })
      .catch((e: Error) => setTorOptsError(e.message));
  }, [wantOpts, torOpts]);

  const done = (msg: string) => {
    setText('');
    setTorFile(null);
    setNote({ text: msg, failed: false });
  };
  const failed = (e: Error) => setNote({ text: e.message, failed: true });

  const torAdd = (): TorrentAdd | null => {
    const r = ratio.trim();
    if (r && !(Number(r) > 0 && Number(r) <= 100)) {
      setNote({ text: 'A ratio to seed to is a number more than 0, like 1 or 2.5.', failed: true });
      return null;
    }
    const cat = category === NEW_CATEGORY ? newCategory.trim() : category;
    if (category === NEW_CATEGORY && !cat) {
      setNote({ text: 'Give the new category a name, or pick another.', failed: true });
      return null;
    }
    const draft = tagDraft.trim().replace(/,+$/, '');
    return { category: cat || undefined, tags: [...new Set([...tags, ...(draft ? [draft] : [])])], ratio: r ? Number(r) : null };
  };

  const add = () => {
    if (!kind || busy) return;
    let p: Promise<unknown>;
    if (kind === 'torrent') {
      const o = torAdd();
      if (!o) return;
      const f = torFile;
      p = (f ? api.addTorrentFile(f, o) : api.addTorrents(text, o)).then((t) => {
        onTorrents(t);
        localSet('torRatio', ratio.trim());
        setTags([]);
        setTagDraft('');
        setCategory('');
        setNewCategory('');
        // A category or tag made just now is in the lists next time.
        setTorOpts(null);
        const seed = o.ratio ? ` Once it has seeded to ratio ${o.ratio}, it leaves qBittorrent and its files stay.` : '';
        done(f ? `Added ${f.name} to qBittorrent.${seed}` : text.trim().includes('\n') ? `Added to qBittorrent.${seed}` : `Added to qBittorrent. It shows below once it has the torrent’s details.${seed}`);
      });
    } else if (kind === 'video') {
      const url = vlink?.href ?? text.trim();
      p = api.startDownload(url, folder, { via: 'video', format: fmt }).then((j) => {
        if (dir.trim()) localSet('dlDir', dir.trim());
        localSet('videoFormat', format);
        onAdded();
        done(`Saving ${j.name} into ${j.dir}.`);
      });
    } else {
      p = api.startDownload(text.trim(), folder, kind === 'instagram' ? { limit: cleanIgLimit(igLimit), metadata: igMeta } : undefined).then((j) => {
        if (dir.trim()) localSet('dlDir', dir.trim());
        onAdded();
        if (!j.ig) done(`Downloading ${j.name} into ${j.dir}.`);
        else {
          localSet('igLimit', String(cleanIgLimit(igLimit)));
          localSet('igMeta', igMeta ? '1' : '0');
          done(j.ig.queued ? `${j.name} starts when the Instagram download before it is done.` : `Saving ${j.name} into ${j.dir}.`);
        }
      });
    }
    setBusy(true);
    p.catch(failed).finally(() => setBusy(false));
  };

  const pickFile = (f: File | undefined) => {
    if (file.current) file.current.value = '';
    if (!f) return;
    setTorFile(f);
    setNote(null);
  };

  const into = folder || 'your home folder';
  const one = audioOnly ? 'track' : 'video';
  const videoWhat =
    fmt === 'mp3'
      ? audioOnly
        ? `Saves the track as an MP3 into ${into}.`
        : `Saves the video’s sound as an MP3 into ${into}.`
      : fmt === '1080p'
        ? `Saves the video as an MP4, 1080p at most, into ${into}.`
        : `Saves the ${one} at its best into ${into}.`;
  const what = !vlink
    ? `${videoWhat} One video, even from a playlist.`
    : vlink.playlist === 'only'
      ? `That’s a ${vlink.site} ${vlink.site === 'YouTube' ? 'playlist or channel' : vlink.site === 'SoundCloud' ? 'playlist or artist' : 'playlist'}: only its first ${one} downloads. ${videoWhat}`
      : `A ${videoNoun(vlink.site)}. ${videoWhat}${vlink.playlist === 'also' ? ` Just this ${one}, not the rest of the playlist.` : ''}`;
  const ratioNote = ratio.trim() && Number(ratio) > 0 ? ` Once it has seeded to ratio ${Number(ratio)}, Launchpad takes it out of qBittorrent and leaves its files where they are.` : '';
  const hint =
    ig && 'error' in ig
      ? ig.error
      : kind === 'torrent'
        ? torrentsOn
          ? torFile
            ? `Adds ${torFile.name} to qBittorrent when you press Download.${ratioNote}`
            : `Goes to qBittorrent.${ratioNote}`
          : 'That’s a torrent: set up qBittorrent below to download it.'
        : !shellReady && (kind === 'http' || kind === 'instagram' || kind === 'video')
          ? 'Set up the terminal’s SSH login first: downloads are written over it.'
          : kind === 'video'
            ? !video
              ? 'Checking video downloads are set up…'
              : !videoReady
                ? video.error || 'Video downloads aren’t set up on this server.'
                : what
            : kind === 'http'
              ? otherSite && !useVideo
                ? `Saves the link itself into ${into}, not the video on the page.`
                : asking
                  ? `Saves into ${into}. Checking whether it’s a video yt-dlp can get…`
                  : `Saves into ${into}.`
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
                  : 'An https:// link downloads straight to the server, a YouTube, X, TikTok, Reddit or SoundCloud link saves the video or its sound, an Instagram post or profile its photos and videos, and a magnet link goes to qBittorrent.';
  const blocked = !kind || (kind === 'torrent' ? !torrentsOn : !shellReady || (kind === 'instagram' && !igReady) || (kind === 'video' && !videoReady));
  const icon = busy ? 'ph-circle-notch spin' : kind === 'torrent' ? 'ph-magnet' : kind === 'instagram' ? 'ph-instagram-logo' : kind === 'video' ? siteIcon(vlink?.site ?? null, fmt) : 'ph-download-simple';

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
                <input ref={file} type="file" accept=".torrent,application/x-bittorrent" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
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
        {torFile ? (
          <div className="input dl-link dl-picked" role="group" aria-label="Torrent file to add">
            <i className="ph-duotone ph-file-arrow-up" />
            <span className="mono">{torFile.name}</span>
            <span className="meta tnum">{fmtBytes(torFile.size)}</span>
            <button type="button" className="icon-btn" title="Don’t add it" aria-label={`Don’t add ${torFile.name}`} onClick={() => setTorFile(null)}>
              <i className="ph-duotone ph-x" />
            </button>
          </div>
        ) : (
          <textarea
            className="input mono dl-link"
            rows={text.includes('\n') ? 4 : 1}
            value={text}
            placeholder="https://…, a YouTube or Instagram link, or magnet:?xt=…"
            onChange={(e) => {
              setText(e.target.value);
              setUseVideo(true);
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
                pickFile(f);
              }
            }}
            aria-label="Link to download"
            spellCheck={false}
          />
        )}
        {kind !== 'torrent' && (
          <label className="dl-dir">
            <i className="ph-duotone ph-folder-simple" />
            <input className="input sm mono" value={dir} placeholder={defaultDir ?? 'Folder on the server'} onChange={(e) => setDir(e.target.value)} aria-label="Folder to save into" spellCheck={false} disabled={!shellReady} />
          </label>
        )}
        <button className="btn btn-primary" disabled={blocked || busy}>
          <i className={'ph-duotone ' + icon} />
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
      {((kind === 'video' && videoReady) || (kind0 === 'http' && otherSite)) && (
        <div className="dl-ig-opts dl-video-opts">
          {otherSite && (
            <span className="dl-ig-toggle">
              <button type="button" role="switch" aria-checked={useVideo} aria-labelledby="dl-use-video" className={'switch' + (useVideo ? ' on' : '')} onClick={() => setUseVideo(!useVideo)}>
                <span />
              </button>
              <span id="dl-use-video" onClick={() => setUseVideo(!useVideo)}>
                The video on {hostOf(httpUrl)}, with yt-dlp
              </span>
            </span>
          )}
          {kind === 'video' && (
            <div className="segmented" role="radiogroup" aria-label="Format">
              <Glide on={fmt} />
              {VIDEO_FORMATS.filter((f) => !audioOnly || f.audio).map((f) => (
                <button key={f.key} type="button" role="radio" aria-checked={fmt === f.key} className={fmt === f.key ? 'on' : ''} onClick={() => setFormat(f.key)}>
                  {f.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {kind === 'torrent' && torrentsOn && (
        <TorrentAddOptions
          opts={torOpts}
          error={torOptsError}
          category={category}
          onCategory={setCategory}
          newCategory={newCategory}
          onNewCategory={setNewCategory}
          tags={tags}
          onTags={setTags}
          tagDraft={tagDraft}
          onTagDraft={setTagDraft}
          ratio={ratio}
          onRatio={setRatio}
        />
      )}
      <span className="meta" role="status" style={note?.failed || (!note && ig && 'error' in ig) ? { color: 'var(--wn)' } : undefined}>
        {note?.text ?? hint}
      </span>
      {igOpen && instagram && igReady && <IgSession info={instagram} onInfo={onInstagram} onClose={() => setIgOpen(false)} />}
    </section>
  );
}

/** A link's site, as the page names it: example.com. */
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'the page';
  }
};

/** A torrent's category, tags and ratio to seed to, as it's added. */
function TorrentAddOptions(p: {
  opts: TorrentOptions | null;
  error: string;
  category: string;
  onCategory: (c: string) => void;
  newCategory: string;
  onNewCategory: (c: string) => void;
  tags: string[];
  onTags: (t: string[]) => void;
  tagDraft: string;
  onTagDraft: (t: string) => void;
  ratio: string;
  onRatio: (r: string) => void;
}) {
  const known = p.opts?.tags ?? [];
  const all = [...known, ...p.tags.filter((t) => !known.includes(t))];
  const addDraft = () => {
    const t = p.tagDraft.trim().replace(/,+$/, '').trim();
    if (t && !p.tags.includes(t)) p.onTags([...p.tags, t]);
    p.onTagDraft('');
  };
  const cat = p.opts?.categories.find((c) => c.name === p.category);
  return (
    <div className="dl-tor-opts">
      <label className="dl-opt">
        <span>Category</span>
        <select className="input sm" value={p.category} onChange={(e) => p.onCategory(e.target.value)} disabled={!p.opts} aria-label="Category">
          <option value="">None</option>
          {p.opts?.categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
          <option value={NEW_CATEGORY}>New category…</option>
        </select>
        {p.category === NEW_CATEGORY && (
          <input className="input sm" value={p.newCategory} onChange={(e) => p.onNewCategory(e.target.value)} placeholder="Its name, and its folder’s" aria-label="New category’s name" maxLength={60} autoFocus />
        )}
      </label>
      <div className="dl-opt dl-tags" role="group" aria-label="Tags">
        <span>Tags</span>
        {all.map((t) => {
          const on = p.tags.includes(t);
          return (
            <button key={t} type="button" className={'chip ' + (on ? 'chip-accent' : 'chip-muted')} aria-pressed={on} onClick={() => p.onTags(on ? p.tags.filter((x) => x !== t) : [...p.tags, t])}>
              {on && <i className="ph-duotone ph-check" />}
              {t}
            </button>
          );
        })}
        <input
          className="input sm dl-tag-new"
          value={p.tagDraft}
          onChange={(e) => (e.target.value.endsWith(',') ? (p.onTagDraft(e.target.value), setTimeout(addDraft)) : p.onTagDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && p.tagDraft.trim()) {
              e.preventDefault();
              addDraft();
            }
          }}
          onBlur={() => p.tagDraft.trim() && addDraft()}
          placeholder="New tag"
          aria-label="New tag"
          maxLength={50}
        />
      </div>
      <label className="dl-opt">
        <span>Seed to ratio</span>
        <input className="input sm tnum dl-ratio" type="number" min={0.1} max={100} step={0.1} value={p.ratio} onChange={(e) => p.onRatio(e.target.value)} placeholder="Keep seeding" aria-label="Ratio to seed to before it leaves qBittorrent" />
      </label>
      {(p.error || cat?.savePath) && (
        <span className="meta" style={p.error ? { color: 'var(--wn)' } : undefined}>
          {p.error || `Saved in ${cat!.hostDir ?? cat!.savePath}.`}
        </span>
      )}
    </div>
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
              onRetry={() =>
                act(api.startDownload(j.url, j.dir, j.video ? { via: 'video', format: j.video.format } : j.ig ? { limit: j.ig.limit ?? undefined, metadata: j.ig.metadata } : undefined))
              }
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

const STEPS: Record<NonNullable<NonNullable<DownloadJob['video']>['step']>, string> = {
  join: 'Joining the picture and sound…',
  mp3: 'Making the MP3…',
  mp4: 'Making it an MP4…',
  fix: 'Tidying up the file…',
  tags: 'Adding its title and artist…',
};

/** A video job's line under its name: where it's got to, or where it went. */
export function videoDetail(j: DownloadJob): string {
  const v = j.video!;
  const bytes = j.total ? `${fmtBytes(j.received)} of ${fmtBytes(j.total)}` : j.received ? fmtBytes(j.received) : '';
  if (j.state === 'starting' || j.state === 'downloading') {
    if (v.phase === 'finding') return v.site === 'SoundCloud' || v.site === 'Soundcloud' ? 'Finding the track…' : 'Finding the video…';
    if (v.phase === 'processing') return v.step ? STEPS[v.step] : 'Working on the file…';
    if (v.phase === 'saving') return [`Saving into ${j.dir}`, bytes].filter(Boolean).join(' · ');
    const left = j.total && j.bps ? (j.total - j.received) / j.bps : null;
    return [bytes, fmtRate(j.bps), left !== null ? `${fmtEta(left)} left` : ''].filter(Boolean).join(' · ') || 'Downloading…';
  }
  if (j.state === 'failed') return j.error || 'Failed';
  if (j.state === 'cancelled') return 'Cancelled';
  return [fmtBytes(j.received), `in ${j.dir}`, v.playlist ? 'the first of the playlist' : ''].filter(Boolean).join(' · ');
}

/** How far through a video job is, downloading and then copying; null while it's finding it or ffmpeg is at work. */
export function videoPercent(j: DownloadJob): number | null {
  const v = j.video!;
  if ((v.phase !== 'downloading' && v.phase !== 'saving') || !j.total) return null;
  return Math.min(100, (j.received / j.total) * 100);
}

/** A video's icon: its site's, or a note for an MP3. */
export function siteIcon(site: VideoSite | string | null, format: VideoFormat): string {
  if (format === 'mp3') return 'ph-music-note';
  const s = (site ?? '').toLowerCase();
  if (s === 'youtube') return 'ph-youtube-logo';
  if (s === 'x' || s === 'twitter') return 'ph-x-logo';
  if (s === 'tiktok') return 'ph-tiktok-logo';
  if (s === 'reddit') return 'ph-reddit-logo';
  if (s === 'soundcloud') return 'ph-soundcloud-logo';
  return 'ph-film-strip';
}

function JobRow({ j, onCancel, onRetry, onOpenFolder }: { j: DownloadJob; onCancel: () => void; onRetry: () => void; onOpenFolder: () => void }) {
  const going = j.state === 'starting' || j.state === 'downloading';
  const pct = j.video ? videoPercent(j) : j.ig ? igPercent(j.ig) : j.total ? (j.received / j.total) * 100 : null;
  const left = j.total && j.bps ? (j.total - j.received) / j.bps : null;
  const detail = j.video
    ? videoDetail(j)
    : j.ig
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
  const kindIcon = j.video ? siteIcon(j.video.site, j.video.format) : j.ig ? 'ph-instagram-logo' : 'ph-download-simple';
  const canRetry = j.state === 'failed' || j.state === 'cancelled';
  const canOpen = j.state === 'done' || (j.state === 'cancelled' && !!j.ig?.files);
  // Cancel isn't asked about: Try again starts it over.
  const menu = menuProps(
    () => [
      canOpen && { label: 'Open the folder in Files', icon: 'ph-folder-open', onSelect: onOpenFolder },
      canRetry && { label: 'Try again', icon: 'ph-arrow-clockwise', onSelect: onRetry },
      going && 'sep',
      going && { label: 'Cancel', icon: 'ph-x', danger: true, onSelect: onCancel },
    ],
    j.name,
  );
  return (
    <div className="dl-item" {...menu}>
      <i
        className={'ph-duotone ' + (j.state === 'done' ? (partly ? 'ph-warning-circle' : 'ph-check-circle') : j.state === 'failed' ? 'ph-warning-circle' : j.state === 'cancelled' ? 'ph-x-circle' : kindIcon)}
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

/** What the speed caps are now, in a line: turtle mode's when it's on, the usual ones otherwise; null when nothing's capped. */
export function speedLine(s: TorrentSpeed): string | null {
  const caps = (dl: number, up: number) =>
    [dl ? `downloads up to ${fmtRate(dl)}` : 'downloads at full speed', up ? `uploads up to ${fmtRate(up)}` : 'uploads at full speed'].join(', ');
  if (s.turtle) return `Turtle mode: ${caps(s.turtleDl, s.turtleUp)}.`;
  if (!s.dl && !s.up) return null;
  return `Capped: ${caps(s.dl, s.up)}.`;
}

/** A cap (bytes a second, 0 for none) as the MB/s the box shows; '' for none. */
export const capText = (bps: number) => (bps > 0 ? String(Math.round((bps / 1e6) * 1000) / 1000) : '');

/** MB/s typed in a cap's box, in bytes a second: 0 when it's blank, null when it isn't a speed. */
export function capValue(text: string): number | null {
  const t = text.trim().replace(',', '.');
  if (!t || Number(t) === 0) return 0;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0.001 || n > 2000) return null;
  return Math.round(n * 1e6);
}

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
  const [open, setOpen] = useState<string | null>(null);
  const [capsOpen, setCapsOpen] = useState(false);
  const [turtleBusy, setTurtleBusy] = useState(false);

  const list = info?.torrents ?? [];
  const sp = info?.configured && !info.error ? info.speed : null;
  const line = sp ? speedLine(sp) : null;
  const recent = (info?.retired ?? []).filter((r) => Date.now() - Date.parse(r.at) < 24 * 3_600_000).slice(0, 3);
  return (
    <section className="panel srv-panel torrents" aria-label="Torrents">
      <div className="panel-head">
        <h2 className="panel-title">Torrents</h2>
        {info?.configured && !info.error && (
          <span className="tor-head-tools">
            <span className="meta tnum tor-speeds">
              <span title="Download speed">↓ {fmtRate(info.dlBps) || '0 B/s'}</span>
              <span title="Upload speed">↑ {fmtRate(info.upBps) || '0 B/s'}</span>
            </span>
            {sp && (
              <>
                <button
                  className={'btn btn-secondary btn-small tor-turtle' + (sp.turtle ? ' on' : '')}
                  aria-pressed={sp.turtle}
                  disabled={turtleBusy}
                  title={sp.turtle ? 'Turtle mode is on: qBittorrent’s slower, alternative speed limits. Press for full speed.' : 'Turtle mode: switch qBittorrent to its slower, alternative speed limits.'}
                  onClick={() => {
                    setTurtleBusy(true);
                    act(api.setTurtle(!sp.turtle)).finally(() => setTurtleBusy(false));
                  }}
                >
                  <i className={'ph-duotone ' + (turtleBusy ? 'ph-circle-notch spin' : 'ph-gauge')} />
                  Turtle
                </button>
                <button className="icon-btn" title="Speed caps" aria-label="Speed caps" aria-expanded={capsOpen} onClick={() => setCapsOpen(!capsOpen)}>
                  <i className="ph-duotone ph-sliders-horizontal" />
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {line && !capsOpen && <span className="meta tor-limits">{line}</span>}
      {capsOpen && sp && <SpeedCaps speed={sp} onInfo={onInfo} onClose={() => setCapsOpen(false)} />}
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
              going ? `${t.seeds} seeds · ${t.peers} peers` : t.ratioLimit !== null ? `ratio ${t.ratio} of ${t.ratioLimit}` : `ratio ${t.ratio}`,
            ]
              .filter(Boolean)
              .join(' · ');
            const expanded = open === t.hash;
            return (
              <div
                key={t.hash}
                className={'dl-item torrent' + (expanded ? ' open' : '')}
                {...menuProps(
                  () => [
                    { label: canResume(t) ? 'Resume' : 'Pause', icon: canResume(t) ? 'ph-play' : 'ph-pause', onSelect: () => act(api.torrentAction([t.hash], canResume(t) ? 'start' : 'stop')) },
                    { label: expanded ? 'Hide its files' : 'Its files', icon: expanded ? 'ph-caret-up' : 'ph-caret-down', onSelect: () => setOpen(expanded ? null : t.hash) },
                    onOpenFolder && t.hostDir && { label: 'Open the folder in Files', icon: 'ph-folder-open', onSelect: () => onOpenFolder(t.hostDir!) },
                    'sep',
                    { label: 'Remove, keep the files', icon: 'ph-minus-circle', danger: true, confirm: `Remove “${t.name}” from qBittorrent? Its files stay where they are.`, onSelect: () => act(api.torrentAction([t.hash], 'delete')) },
                    { label: 'Remove and delete the files', icon: 'ph-trash', danger: true, confirm: `Remove “${t.name}” and delete its files? This can’t be undone.`, onSelect: () => act(api.torrentAction([t.hash], 'deleteFiles')) },
                  ],
                  t.name,
                )}
              >
                <span className={'chip ' + st.cls}>{st.text}</span>
                <div className="dl-item-main">
                  <button type="button" className="dl-name tor-name" title={t.name} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.hash)}>
                    {t.name}
                  </button>
                  {going && (
                    <div className="dl-bar">
                      <span style={{ width: `${t.progress * 100}%`, background: t.status === 'paused' || t.status === 'stalled' ? 'var(--t3)' : undefined }} />
                    </div>
                  )}
                  <span className="meta tnum">
                    {going ? `${Math.floor(t.progress * 1000) / 10}% · ` : ''}
                    {detail}
                  </span>
                  {(t.category || t.tags.length > 0) && (
                    <span className="tor-labels">
                      {t.category && (
                        <span className="meta" title="Category">
                          <i className="ph-duotone ph-folder-simple" />
                          {t.category}
                        </span>
                      )}
                      {t.tags.map((g) => (
                        <span key={g} className="chip chip-muted">
                          {g}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
                <span className="dl-tools">
                  <button className="icon-btn" title={expanded ? 'Hide its files' : 'Its files'} aria-label={`${expanded ? 'Hide' : 'Show'} the files of ${t.name}`} aria-expanded={expanded} onClick={() => setOpen(expanded ? null : t.hash)}>
                    <i className={'ph-duotone ' + (expanded ? 'ph-caret-up' : 'ph-caret-down')} />
                  </button>
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
                {expanded && <TorrentDetail t={t} onInfo={onInfo} onOpenFolder={onOpenFolder} />}
              </div>
            );
          })}
        </div>
      )}
      {recent.map((r) => (
        <span key={r.at + r.name} className="meta tor-retired">
          <i className="ph-duotone ph-check-circle" style={{ color: 'var(--ac)' }} /> {r.name} seeded to ratio {r.ratio} and left qBittorrent at {hm(new Date(r.at))}. Its files are still {r.hostDir ? <>in <span className="mono">{r.hostDir}</span></> : 'where they were'}.
        </span>
      ))}
      {info?.configured && info.hostDir && <span className="meta">Saved in <span className="mono">{info.hostDir}</span> on the server.</span>}
    </section>
  );
}

/** Setting qBittorrent's speed caps, the usual ones and turtle mode's, in MB/s. */
function SpeedCaps({ speed, onInfo, onClose }: { speed: TorrentSpeed; onInfo: (t: TorrentsInfo) => void; onClose: () => void }) {
  const [v, setV] = useState(() => ({ dl: capText(speed.dl), up: capText(speed.up), turtleDl: capText(speed.turtleDl), turtleUp: capText(speed.turtleUp) }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bad = (Object.keys(v) as (keyof typeof v)[]).filter((k) => capValue(v[k]) === null);
  const save = () => {
    if (bad.length || busy) return;
    setBusy(true);
    setError('');
    api
      .setSpeedCaps({ dl: capValue(v.dl)!, up: capValue(v.up)!, turtleDl: capValue(v.turtleDl)!, turtleUp: capValue(v.turtleUp)! })
      .then((t) => {
        onInfo(t);
        onClose();
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const box = (k: keyof typeof v, label: string) => (
    <input
      className={'input sm tnum' + (bad.includes(k) ? ' bad' : '')}
      inputMode="decimal"
      value={v[k]}
      onChange={(e) => setV({ ...v, [k]: e.target.value })}
      placeholder="No cap"
      aria-label={label}
      onKeyDown={(e) => e.key === 'Enter' && save()}
    />
  );
  return (
    <div className="tor-caps" role="group" aria-label="Speed caps">
      <div className="tor-caps-grid">
        <span />
        <span className="meta">Download, MB/s</span>
        <span className="meta">Upload, MB/s</span>
        <span>Usually</span>
        {box('dl', 'Usual download cap in MB/s')}
        {box('up', 'Usual upload cap in MB/s')}
        <span>Turtle mode</span>
        {box('turtleDl', 'Turtle mode’s download cap in MB/s')}
        {box('turtleUp', 'Turtle mode’s upload cap in MB/s')}
      </div>
      <span className="meta" style={error || bad.length ? { color: 'var(--wn)' } : undefined}>
        {error || (bad.length ? 'A cap is a number of MB/s, like 2 or 0.5 (500 KB/s), or blank for none.' : 'Blank is no cap. These are qBittorrent’s own settings, the same as in its options.')}
      </span>
      <div className="dl-ig-actions">
        <button className="btn btn-primary btn-small" disabled={busy || bad.length > 0} onClick={save}>
          <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-check')} />
          Save
        </button>
        <button className="btn btn-secondary btn-small" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

/** The folder every one of a torrent's files is in (its own folder, usually), so it needn't be on every line; '' when there isn't one. */
export function sharedFolder(names: string[]): string {
  const first = names[0]?.split('/')[0] ?? '';
  return first && names.every((n) => n.startsWith(first + '/')) ? first : '';
}

const PRIORITIES: { key: TorrentFile['priority']; label: string }[] = [
  { key: 'skip', label: 'Skip' },
  { key: 'normal', label: 'Normal' },
  { key: 'high', label: 'High' },
];
/** Files shown before "Show all". */
const FIRST_FILES = 200;

/** An open torrent: its files, each with its progress and priority, and the ratio it seeds to. */
function TorrentDetail({ t, onInfo, onOpenFolder }: { t: Torrent; onInfo: (t: TorrentsInfo) => void; onOpenFolder?: (path: string) => void }) {
  const [files, setFiles] = useState<TorrentFile[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  const [ratio, setRatio] = useState(t.ratioLimit === null ? '' : String(t.ratioLimit));
  const [ratioNote, setRatioNote] = useState<{ text: string; failed: boolean } | null>(null);
  const load = useCallback(() => {
    api
      .torrentFiles(t.hash)
      .then((f) => {
        setFiles(f);
        setError('');
      })
      .catch((e: Error) => setError(e.message));
  }, [t.hash]);
  usePoll(load, POLL * 2);

  const prio = (ids: number[], priority: TorrentFile['priority']) => {
    setBusy(true);
    api
      .setFilePriority(t.hash, ids, priority)
      .then((f) => {
        setFiles(f);
        setError('');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const saveRatio = () => {
    const r = ratio.trim();
    if (r && !(Number(r) > 0 && Number(r) <= 100)) return setRatioNote({ text: 'A ratio is a number more than 0, like 1 or 2.5.', failed: true });
    const n = r ? Math.round(Number(r) * 100) / 100 : null;
    api
      .setTorrentRatio(t.hash, n)
      .then((info) => {
        onInfo(info);
        setRatioNote({
          text: n === null ? 'It seeds on until you stop it.' : t.progress >= 1 && t.ratio >= n ? `It has seeded to ${t.ratio} already, so it leaves qBittorrent now. Its files stay.` : `Once it has seeded to ${n}, it leaves qBittorrent. Its files stay.`,
          failed: false,
        });
      })
      .catch((e: Error) => setRatioNote({ text: e.message, failed: true }));
  };

  const shown = files ? (all ? files : files.slice(0, FIRST_FILES)) : [];
  const same = files?.length ? files.every((f) => f.priority === files[0].priority) : false;
  const root = files ? sharedFolder(files.map((f) => f.name)) : '';
  return (
    <div className="tor-detail" role="group" aria-label={`${t.name}: files and seeding`}>
      <form
        className="tor-ratio"
        onSubmit={(e) => {
          e.preventDefault();
          saveRatio();
        }}
      >
        <label>
          Seed to ratio
          <input className="input sm tnum dl-ratio" type="number" min={0.1} max={100} step={0.1} value={ratio} onChange={(e) => (setRatio(e.target.value), setRatioNote(null))} placeholder="Keep seeding" aria-label={`Ratio for ${t.name} to seed to`} />
        </label>
        {ratio.trim() !== (t.ratioLimit === null ? '' : String(t.ratioLimit)) && (
          <button className="btn btn-secondary btn-small">
            <i className="ph-duotone ph-check" />
            Save
          </button>
        )}
        <span className="meta" style={ratioNote?.failed ? { color: 'var(--wn)' } : undefined}>
          {ratioNote?.text ?? (t.ratioLimit !== null ? `Leaves qBittorrent at ratio ${t.ratioLimit}, keeping its files.` : 'Then it leaves qBittorrent, keeping its files.')}
        </span>
      </form>
      {error && <span className="meta" style={{ color: 'var(--wn)' }}>{error}</span>}
      {!files ? (
        !error && <span className="meta">Loading its files…</span>
      ) : !files.length ? (
        <span className="meta">qBittorrent doesn’t know its files yet. They show once it has the torrent’s details.</span>
      ) : (
        <>
          <div className="tor-files-head">
            <span className="meta tor-files-count" title={root || undefined}>
              {count(files.length, 'file')}
              {root ? ` in ${root}` : ''}
            </span>
            {files.length > 1 && (
              <label className="meta">
                All:
                <select className="input sm" value={same ? files[0].priority : ''} disabled={busy} onChange={(e) => e.target.value && prio(files.map((f) => f.index), e.target.value as TorrentFile['priority'])} aria-label="Priority of all its files">
                  {!same && <option value="">Mixed</option>}
                  {PRIORITIES.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="tor-files">
            {shown.map((f) => {
              const rel = root ? f.name.slice(root.length + 1) : f.name;
              const slash = rel.lastIndexOf('/');
              return (
                <div key={f.index} className={'tor-file' + (f.priority === 'skip' ? ' skipped' : '')}>
                  <span className="tor-file-name" title={f.name}>
                    {slash > 0 && <span className="tor-file-dir">{rel.slice(0, slash + 1)}</span>}
                    {rel.slice(slash + 1)}
                  </span>
                  <span className="meta tnum tor-file-size">{fmtBytes(f.size)}</span>
                  <span className="meta tnum tor-file-pct">{f.priority === 'skip' && f.progress < 1 ? 'skipped' : `${Math.floor(f.progress * 1000) / 10}%`}</span>
                  <select className="input sm" value={f.priority} disabled={busy} onChange={(e) => prio([f.index], e.target.value as TorrentFile['priority'])} aria-label={`Priority of ${f.name}`}>
                    {PRIORITIES.map((p) => (
                      <option key={p.key} value={p.key}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                  {onOpenFolder && f.hostDir && (f.progress > 0 || t.progress >= 1) ? (
                    <button className="icon-btn" title="Open its folder in Files" aria-label={`Open the folder of ${f.name} in Files`} onClick={() => onOpenFolder(f.hostDir!)}>
                      <i className="ph-duotone ph-folder-open" />
                    </button>
                  ) : (
                    <span className="tor-file-nofolder" />
                  )}
                </div>
              );
            })}
          </div>
          {files.length > shown.length && (
            <button className="btn btn-secondary btn-small" style={{ alignSelf: 'flex-start' }} onClick={() => setAll(true)}>
              Show all {files.length} files
            </button>
          )}
        </>
      )}
    </div>
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
