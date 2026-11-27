import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MON } from '../../../shared/dates';
import { archiveOf, previewOf, SEARCH_LIMIT, SEARCH_MAX_FILE_MB, SEARCH_SECONDS, type FileJob, type FolderSize, type SearchEnd, type SearchHit, type TrashOutcome } from '../../../shared/files';
import type { DirListing, FileEntry } from '../../../shared/types';
import { api, downloadUrl, localGet, localSet, uploadFile, UploadError } from '../api';
import { downloadZip, filesApi, searchFiles } from '../filesApi';
import { fmtBytes, hm } from '../util';
import { closeMenu, menuProps, openMenu, useDismiss, type MenuItem } from './ContextMenu';
import { authorizeLine, Copyable, keyRefused } from './Copyable';
import { FilesTrash } from './FilesTrash';
import { FileViewer } from './FileViewer';
import { Glide } from './Motion';
import { EmptyArt } from './mission/EmptyArt';

const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;
const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';
const nameOf = (p: string) => p.split('/').pop() || p;
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
/** “a.txt”, or “3 things”. */
const what = (names: string[]) => (names.length === 1 ? `“${nameOf(names[0])}”` : plural(names.length, 'thing'));

/** drwxr-xr-x, as ls prints it, for what a link points at; l for a broken link. */
export function permString(e: Pick<FileEntry, 'kind' | 'link' | 'mode'>): string {
  const bits = 'rwxrwxrwx'.split('').map((c, i) => (e.mode & (0o400 >> i) ? c : '-')).join('');
  return (e.kind === 'dir' ? 'd' : e.kind === 'file' ? '-' : e.link ? 'l' : '?') + bits;
}

function fmtWhen(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = `${d.getDate()} ${MON[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? `${day}, ${hm(d)}` : `${day} ${d.getFullYear()}`;
}

/** A folder's size as the size column shows it: at least that much when some of it couldn't be read. */
export const fmtFolderSize = (s: FolderSize) => (s.partial ? '≥ ' : '') + fmtBytes(s.bytes);

/** Names from `from` to `to` in the listing's order, for a shift-click. */
export function rangeOf(names: string[], from: string, to: string): string[] {
  const a = names.indexOf(from);
  const b = names.indexOf(to);
  if (a < 0 || b < 0) return [to];
  return names.slice(Math.min(a, b), Math.max(a, b) + 1);
}

const EXT_ICONS: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg|heic|bmp|ico|avif)$/i, 'ph-file-image'],
  [/\.(zip|tar|gz|tgz|bz2|xz|txz|7z|rar|zst)$/i, 'ph-file-zip'],
  [/\.(mp3|flac|wav|ogg|oga|opus|m4a|aac)$/i, 'ph-file-audio'],
  [/\.(mp4|m4v|mkv|mov|avi|webm|ogv)$/i, 'ph-file-video'],
  [/\.pdf$/i, 'ph-file-pdf'],
  [/\.(js|ts|tsx|jsx|py|sh|go|rs|c|h|cpp|java|rb|php|json|ya?ml|toml|ini|conf|cfg|env|xml|html|css|sql)$/i, 'ph-file-code'],
  [/\.(txt|md|log|csv)$/i, 'ph-file-text'],
];

function iconFor(e: Pick<FileEntry, 'kind' | 'name'>): string {
  if (e.kind === 'dir') return 'ph-folder-simple';
  if (e.kind === 'other') return 'ph-file-dashed';
  return EXT_ICONS.find(([re]) => re.test(e.name))?.[1] ?? 'ph-file';
}

interface Upload { name: string; pct: number }

type Notice =
  | { kind: 'trashed'; outcome: TrashOutcome }
  | { kind: 'archive'; path: string }
  | { kind: 'info'; text: string };

type Clip = { mode: 'copy' | 'move'; dir: string; names: string[] };

interface Search {
  dir: string;
  query: string;
  mode: 'name' | 'content';
  hits: SearchHit[];
  end: SearchEnd | null;
  error: string;
}

/** A menu fixed to where its button is, flipped above it when there's no room below. */
function FloatingMenu({ at, onClose, children, label }: { at: DOMRect; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useDismiss(true, [ref], onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(at.right - w, document.documentElement.clientWidth - w - 8));
    const below = at.bottom + 4;
    const top = below + h > document.documentElement.clientHeight - 8 ? Math.max(8, at.top - h - 4) : below;
    setPos({ left, top });
  }, [at]);
  // On the page itself: a design whose panels blur what's behind them (Vista) would otherwise pin it to the panel, not the window.
  return createPortal(
    <div ref={ref} className="popover menu files-menu" role="menu" aria-label={label} style={{ position: 'fixed', left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}>
      {children}
    </div>,
    document.body,
  );
}

/** A file explorer for the server, over SFTP. Stays mounted while hidden, so an open file keeps its edits. */
export function FilesPanel({ publicKey, hidden, now, open, pins, onPins, onOpenTerminal, onFailed }: {
  publicKey: string;
  hidden: boolean;
  now: Date;
  /** A folder to go to, from another tab; `n` changes each time. */
  open?: { path: string; n: number } | null;
  /** Starred folders, from prefs, so they follow you across devices. */
  pins: string[];
  onPins: (pins: string[]) => void;
  /** Open the terminal in this folder. */
  onOpenTerminal: (path: string) => void;
  /** Nothing could be listed at all: the parent checks whether the host key changed. */
  onFailed: () => void;
}) {
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showHidden, setShowHidden] = useState(() => localGet('filesHidden') === '1');
  const [pathInput, setPathInput] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<{ path: string; text: string; saved: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewer, setViewer] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'trash' | 'search'>('list');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const [clip, setClip] = useState<Clip | null>(null);
  const [sizes, setSizes] = useState<Record<string, FolderSize | 'busy' | { error: string }>>({});
  const [jobs, setJobs] = useState<FileJob[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  /** The row whose ⋯ menu is open, to light its button. */
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const [toolMenu, setToolMenu] = useState<{ kind: 'pins' | 'pack'; at: DOMRect } | null>(null);
  const [search, setSearch] = useState<Search | null>(null);
  const [searchText, setSearchText] = useState('');
  const [searchMode, setSearchMode] = useState<'name' | 'content'>('name');
  const searchAbort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const load = useCallback((path?: string) => {
    setLoading(true);
    return api
      .listDir(path)
      .then((l) => {
        setListing((prev) => {
          // A different folder starts with nothing chosen; the same one keeps what's still there.
          if (prev?.path !== l.path) setSelected(new Set());
          else setSelected((s) => new Set([...s].filter((n) => l.entries.some((e) => e.name === n))));
          return l;
        });
        setError('');
        localSet('filesPath', l.path);
      })
      .catch((e: Error) => {
        setError(e.message);
        throw e;
      })
      .finally(() => setLoading(false));
  }, []);

  // A folder asked for before this mounted is where it opens.
  const openedAt = useRef(open?.n);
  useEffect(() => {
    // Back to the last folder, or the root if it's gone.
    const last = (openedAt.current !== undefined && open?.path) || localGet('filesPath') || '/';
    load(last).catch(() => (last !== '/' ? load('/') : Promise.reject()).catch(() => onFailedRef.current()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const dirty = !!file && file.text !== file.saved;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const go = (path: string, mark?: string) => {
    setRenaming(null);
    setCreating(false);
    setView('list');
    setRowMenu(null);
    setHighlight(mark ?? null);
    setNotice(null);
    // A search still going stops; its results stay for when the search is opened again.
    searchAbort.current?.abort();
    load(path).catch(() => {});
  };

  useEffect(() => {
    if (!open || open.n === openedAt.current) return;
    openedAt.current = open.n;
    setViewer(null);
    go(open.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.n]);

  const refresh = () => listing && load(listing.path).catch(() => {});
  const listingRef = useRef(listing);
  listingRef.current = listing;

  // Something found by a search, or made by a job, is scrolled to and lit up for a moment.
  useEffect(() => {
    if (!highlight || !listing) return;
    const el = listRef.current?.querySelector(`[data-name="${CSS.escape(highlight)}"]`);
    el?.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setHighlight(null), 4000);
    return () => clearTimeout(t);
  }, [highlight, listing]);

  // ---------- jobs ----------

  const pollJobs = useCallback(() => filesApi.jobs().then(setJobs).catch(() => {}), []);
  const anyRunning = jobs.some((j) => j.state === 'running');
  // Back in view: what happened meanwhile shows at once.
  useEffect(() => {
    if (!hidden) pollJobs();
  }, [hidden, pollJobs]);
  useEffect(() => {
    if (hidden) return;
    const t = setInterval(pollJobs, anyRunning ? 1000 : 20_000);
    return () => clearInterval(t);
  }, [hidden, anyRunning, pollJobs]);

  const addJob = (j: FileJob) => {
    setJobs((js) => [...js.filter((x) => x.id !== j.id), j]);
    setTimeout(pollJobs, 400);
  };

  const dismiss = useCallback((id: string) => {
    setJobs((js) => js.filter((j) => j.id !== id));
    filesApi.dismissJob(id).catch(() => {});
  }, []);

  // A job that ends here refreshes the folder; one that went well clears itself after a while.
  const states = useRef(new Map<string, FileJob['state']>());
  useEffect(() => {
    for (const j of jobs) {
      const was = states.current.get(j.id);
      states.current.set(j.id, j.state);
      if (j.state === 'running' || was === j.state) continue;
      // Seen running and now over: what it changed may be on screen.
      const here = listingRef.current?.path;
      if (was === 'running' && here && (j.dir === here || (j.result && parentOf(j.result) === here))) load(here).catch(() => {});
      if (j.state === 'done') setTimeout(() => dismiss(j.id), 15_000);
    }
  }, [jobs, load, dismiss]);

  // ---------- actions ----------

  const act = (p: Promise<unknown>) => p.then(refresh).catch((e: Error) => setError(e.message));

  const openFile = (path: string) => {
    setError('');
    const name = nameOf(path);
    if (previewOf(name)) {
      setViewer(path);
      return;
    }
    if (archiveOf(name)) {
      setNotice({ kind: 'archive', path });
      return;
    }
    api
      .readText(path)
      .then((f) => setFile({ path: f.path, text: f.text, saved: f.text }))
      .catch((e: Error) => setError(e.message));
  };

  const save = () => {
    if (!file || saving) return;
    const { path, text } = file;
    setSaving(true);
    api
      .writeText(path, text)
      .then(() => setFile((f) => (f && f.path === path ? { ...f, saved: text } : f)))
      .catch((e: Error) => setError(`Couldn’t save: ${e.message}`))
      .finally(() => setSaving(false));
  };

  const closeFile = () => {
    if (dirty && !window.confirm('Close without saving your changes?')) return;
    setFile(null);
    setError('');
  };

  /** To the trash, with an undo. */
  const trash = (paths: string[]) => {
    if (!paths.length) return;
    setError('');
    setNotice({ kind: 'info', text: `Moving ${what(paths)} to the trash…` });
    filesApi
      .trash(paths)
      .then((outcome) => {
        setNotice({ kind: 'trashed', outcome });
        setSelected((s) => new Set([...s].filter((n) => !outcome.trashed.some((t) => nameOf(t.path) === n))));
        refresh();
      })
      .catch((e: Error) => (setNotice(null), setError(e.message)));
  };

  const undoTrash = (outcome: TrashOutcome) => {
    setNotice({ kind: 'info', text: outcome.trashed.length === 1 ? 'Putting it back…' : 'Putting them back…' });
    filesApi
      .restore(outcome.trashed.map(({ trash, id }) => ({ trash, id })))
      .then((r) => {
        setNotice({ kind: 'info', text: r.failed.length ? `Couldn’t put back ${r.failed.length === 1 ? r.failed[0].id : plural(r.failed.length, 'thing')}: ${r.failed[0].error}` : `Put back ${what(r.restored.map((x) => x.as))}.` });
        refresh();
      })
      .catch((e: Error) => (setNotice(null), setError(`Couldn’t undo: ${e.message}`)));
  };

  const deleteForGood = (paths: string[]) => {
    if (!window.confirm(`Delete ${what(paths)} for good? This can’t be undone.`)) return;
    setNotice(null);
    filesApi
      .deleteForGood(paths)
      .then((r) => addJob(r.job))
      .catch((e: Error) => setError(e.message));
  };

  const measure = (paths: string[]) => {
    if (!paths.length) return;
    setSizes((s) => ({ ...s, ...Object.fromEntries(paths.map((p) => [p, 'busy' as const])) }));
    filesApi
      .sizes(paths)
      .then((r) => setSizes((s) => ({ ...s, ...Object.fromEntries(paths.map((p) => [p, r[p] ?? { error: 'du didn’t say' }])) })))
      .catch((e: Error) => setSizes((s) => ({ ...s, ...Object.fromEntries(paths.map((p) => [p, { error: e.message }])) })));
  };

  const pack = (paths: string[], format: 'zip' | 'tar.gz') => {
    setToolMenu(null);
    setRowMenu(null);
    filesApi
      .compress(paths, format)
      .then((r) => addJob(r.job))
      .catch((e: Error) => setError(e.message));
  };

  const unpack = (path: string) => {
    setNotice(null);
    setRowMenu(null);
    filesApi
      .extract(path)
      .then((r) => addJob(r.job))
      .catch((e: Error) => setError(e.message));
  };

  const zip = (paths: string[]) => {
    setRowMenu(null);
    downloadZip(paths).catch((e: Error) => setError(`Couldn’t make the zip: ${e.message}`));
  };

  const paste = () => {
    if (!clip || !listing) return;
    const to = listing.path;
    const c = clip;
    setError('');
    filesApi
      .transfer(c.mode, c.names.map((n) => join(c.dir, n)), to)
      .then((r) => {
        setClip(null);
        if (r.job) addJob(r.job);
        else setNotice({ kind: 'info', text: r.moved ? `Moved ${what(c.names)} here.` : 'Nothing to move: that’s already here.' });
        refresh();
      })
      .catch((e: Error) => setError(e.message));
  };

  const togglePin = (path: string) => {
    setToolMenu(null);
    setRowMenu(null);
    onPins(pins.includes(path) ? pins.filter((p) => p !== path) : [...pins, path]);
  };

  // ---------- search ----------

  const stopSearch = () => searchAbort.current?.abort();

  const runSearch = () => {
    if (!listing) return;
    const query = searchText.trim();
    if (!query) return;
    stopSearch();
    const ctl = new AbortController();
    searchAbort.current = ctl;
    const s: Search = { dir: listing.path, query, mode: searchMode, hits: [], end: null, error: '' };
    setSearch(s);
    let hits: SearchHit[] = [];
    let flush = 0;
    const show = () => {
      flush = 0;
      setSearch((cur) => (cur && searchAbort.current === ctl ? { ...cur, hits } : cur));
    };
    searchFiles(listing.path, query, searchMode, (h) => {
      hits = [...hits, h];
      if (!flush) flush = window.setTimeout(show, 120);
    }, ctl.signal)
      .then((end) => {
        clearTimeout(flush);
        setSearch((cur) => (cur && searchAbort.current === ctl ? { ...cur, hits, end, error: end.error ?? '' } : cur));
      })
      .catch((e: Error) => {
        clearTimeout(flush);
        const stopped = ctl.signal.aborted;
        setSearch((cur) =>
          cur && searchAbort.current === ctl ? { ...cur, hits, end: { done: true, count: hits.length, more: false, timedOut: false, tool: 'find' }, error: stopped ? 'Stopped.' : e.message } : cur,
        );
      });
  };

  const closeSearch = () => {
    stopSearch();
    setView('list');
  };

  useEffect(() => () => searchAbort.current?.abort(), []);

  const openHit = (h: SearchHit) => {
    if (h.kind === 'dir') go(h.path);
    else go(parentOf(h.path), nameOf(h.path));
  };

  // ---------- uploads ----------

  const upload = async (files: File[]) => {
    if (!listing || !files.length) return;
    const dir = listing.path;
    setError('');
    for (const f of files) {
      setUploads((u) => [...u, { name: f.name, pct: 0 }]);
      const progress = (p: number) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct: p } : x)));
      try {
        await uploadFile(dir, f, false, progress).catch((e) => {
          if (e instanceof UploadError && e.status === 409 && window.confirm(`Replace “${f.name}”, which is already there?`)) return uploadFile(dir, f, true, progress);
          if (e instanceof UploadError && e.status === 409) return;
          throw e;
        });
      } catch (e) {
        setError(`Couldn’t upload ${f.name}: ${(e as Error).message}`);
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name));
      }
    }
    load(dir).catch(() => {});
  };

  const style = hidden ? { display: 'none' } : undefined;

  // ---------- the editor and the viewer ----------

  if (file) {
    return (
      <section className="panel srv-panel files-panel" aria-label="Edit file" style={style}>
        <div className="panel-head files-head">
          <h2 className="panel-title mono files-title" title={file.path}>
            {file.path.split('/').pop()}
            {dirty && <span style={{ color: 'var(--t3)' }}> ·</span>}
          </h2>
          <div className="files-tools">
            <span className="meta mono files-path">{parentOf(file.path)}</span>
            <a className="icon-btn" href={downloadUrl(file.path)} title="Download" aria-label="Download">
              <i className="ph-duotone ph-download-simple" />
            </a>
            <button className="btn btn-primary btn-small" disabled={!dirty || saving} onClick={save} title="Save (Ctrl S)">
              <i className={'ph-duotone ' + (saving ? 'ph-circle-notch spin' : 'ph-floppy-disk')} />
              {saving ? 'Saving…' : dirty ? 'Save' : 'Saved'}
            </button>
            <button className="btn btn-secondary btn-small" onClick={closeFile}>
              Close
            </button>
          </div>
        </div>
        {error && (
          <div className="status-line" style={{ margin: 0 }}>
            <i className="ph-duotone ph-warning" /> {error}
          </div>
        )}
        <textarea
          className="files-editor mono"
          value={file.text}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label={`Contents of ${file.path}`}
          onChange={(e) => setFile({ ...file, text: e.target.value })}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
              e.preventDefault();
              save();
            }
            // Esc would leave the view; here it does nothing, so a stray press can't lose edits.
            if (e.key === 'Escape') e.stopPropagation();
            if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
              e.preventDefault();
              const t = e.currentTarget;
              const { selectionStart: a, selectionEnd: b } = t;
              const text = t.value.slice(0, a) + '\t' + t.value.slice(b);
              setFile({ ...file, text });
              requestAnimationFrame(() => t.setSelectionRange(a + 1, a + 1));
            }
          }}
        />
      </section>
    );
  }

  if (!listing) {
    return (
      <section className="panel srv-panel files-panel" aria-label="Files" style={style}>
        <div className="empty">
          <EmptyArt kind={!!error && (keyRefused(error) ? 'away' : 'scrubbed')} />
          <p>{error ? `Couldn’t open the server’s files: ${error}` : 'Opening the server’s files…'}</p>
          {keyRefused(error) && <Copyable text={authorizeLine(publicKey)} />}
          {error && (
            <button className="btn btn-secondary btn-small" onClick={() => load('/').catch(() => onFailedRef.current())}>
              Try again
            </button>
          )}
        </div>
      </section>
    );
  }

  const entries = listing.entries.filter((e) => showHidden || !e.name.startsWith('.'));

  if (viewer) {
    const siblings = entries.filter((e) => e.kind === 'file' && previewOf(e.name)).map((e) => join(listing.path, e.name));
    return <FileViewer path={viewer} siblings={parentOf(viewer) === listing.path ? siblings : [viewer]} hidden={hidden} onStep={setViewer} onClose={() => setViewer(null)} />;
  }

  // ---------- the list ----------

  const crumbs = listing.path === '/' ? [] : listing.path.slice(1).split('/');
  const hiddenCount = listing.entries.length - entries.length;
  const names = entries.map((e) => e.name);
  const chosen = entries.filter((e) => selected.has(e.name));
  const chosenPaths = chosen.map((e) => join(listing.path, e.name));
  const allChosen = entries.length > 0 && chosen.length === entries.length;
  const pinned = pins.includes(listing.path);
  /** A row's menu, from its ⋯ button or a right-click. Trash isn't asked about: Trash brings it back. */
  const rowItems = (e: FileEntry): MenuItem[] => {
    const path = join(listing.path, e.name);
    const dir = e.kind === 'dir';
    const preview = e.kind === 'file' && previewOf(e.name);
    return [
      e.kind !== 'other' && { label: dir ? 'Open' : preview ? 'Preview' : 'Open', icon: dir ? 'ph-folder-open' : preview ? 'ph-eye' : 'ph-file-text', onSelect: () => (dir ? go(path) : openFile(path)) },
      e.kind === 'file' && !!archiveOf(e.name) && { label: 'Unpack here', icon: 'ph-package', onSelect: () => unpack(path) },
      dir && { label: 'Open the terminal here', icon: 'ph-terminal-window', onSelect: () => onOpenTerminal(path) },
      dir && { label: 'Calculate size', icon: 'ph-ruler', onSelect: () => measure([path]) },
      dir && { label: pins.includes(path) ? 'Unpin' : 'Pin', icon: 'ph-star', onSelect: () => togglePin(path) },
      'sep',
      { label: 'Copy to…', icon: 'ph-copy', onSelect: () => setClip({ mode: 'copy', dir: listing.path, names: [e.name] }) },
      { label: 'Move to…', icon: 'ph-arrows-out-cardinal', onSelect: () => setClip({ mode: 'move', dir: listing.path, names: [e.name] }) },
      { label: 'Rename', icon: 'ph-pencil-simple', onSelect: () => (setRenaming(e.name), setCreating(false)) },
      'sep',
      dir ? { label: 'Download as .zip', icon: 'ph-download-simple', onSelect: () => zip([path]) } : e.kind === 'file' && { label: 'Download', icon: 'ph-download-simple', href: downloadUrl(path) },
      { label: 'Pack as .zip', icon: 'ph-file-zip', onSelect: () => pack([path], 'zip') },
      { label: 'Pack as .tar.gz', icon: 'ph-file-zip', onSelect: () => pack([path], 'tar.gz') },
      'sep',
      { label: 'Move to the trash', icon: 'ph-trash', danger: true, onSelect: () => trash([path]) },
    ];
  };

  const pick = (name: string, shift: boolean) => {
    setSelected((s) => {
      const n = new Set(s);
      const range = shift && lastPicked ? rangeOf(names, lastPicked, name) : [name];
      const on = !s.has(name);
      for (const x of range) (on ? n.add(x) : n.delete(x));
      return n;
    });
    setLastPicked(name);
  };

  const clipLabel = clip && `${clip.mode === 'copy' ? 'Copying' : 'Moving'} ${what(clip.names)} from ${nameOf(clip.dir) || '/'}`;
  const canPaste = !!clip && !(clip.mode === 'move' && clip.dir === listing.path);

  const jobIcon = (j: FileJob) => (j.state === 'running' ? 'ph-circle-notch spin' : j.state === 'done' ? 'ph-check-circle' : j.state === 'cancelled' ? 'ph-prohibit' : 'ph-warning');

  const sizeCell = (e: FileEntry) => {
    if (e.kind === 'file') return fmtBytes(e.size);
    if (e.kind !== 'dir') return '';
    const s = sizes[join(listing.path, e.name)];
    if (s === 'busy') return <i className="ph-duotone ph-circle-notch spin" aria-label="Measuring" />;
    if (s && 'error' in s)
      return (
        <span title={s.error} style={{ color: 'var(--wn)' }}>
          <i className="ph-duotone ph-warning" />
        </span>
      );
    if (s) return <span title={s.partial ? 'Some of it couldn’t be read, so it’s at least this.' : undefined}>{fmtFolderSize(s)}</span>;
    return (
      <button className="file-measure" title="Calculate the size" aria-label={`Calculate the size of ${e.name}`} onClick={() => measure([join(listing.path, e.name)])}>
        Size
      </button>
    );
  };

  return (
    <section
      className={'panel srv-panel files-panel' + (dragging ? ' dragging' : '')}
      aria-label="Files"
      style={style}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files') || view !== 'list') return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (view === 'list') upload([...e.dataTransfer.files]);
      }}
    >
      <div className="panel-head files-head">
        {pathInput !== null ? (
          <form
            className="files-crumbs"
            onSubmit={(e) => {
              e.preventDefault();
              const p = pathInput.trim();
              setPathInput(null);
              if (p) go(p.startsWith('/') ? p : join(listing.path, p));
            }}
          >
            <input
              className="input sm mono"
              style={{ flex: 1, minWidth: 0 }}
              autoFocus
              value={pathInput}
              aria-label="Go to folder"
              onChange={(e) => setPathInput(e.target.value)}
              onBlur={() => setPathInput(null)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setPathInput(null);
                }
              }}
            />
          </form>
        ) : (
          <nav className="files-crumbs mono" aria-label="Folder">
            <button className="crumb" onClick={() => go('/')}>
              /
            </button>
            {crumbs.map((c, i) => (
              <span key={i} style={{ display: 'contents' }}>
                {i > 0 && <span className="crumb-sep">/</span>}
                <button className="crumb" aria-current={i === crumbs.length - 1 ? 'location' : undefined} onClick={() => go('/' + crumbs.slice(0, i + 1).join('/'))}>
                  {c}
                </button>
              </span>
            ))}
            <button className="icon-btn" title="Type a path" aria-label="Type a path" onClick={() => setPathInput(listing.path)}>
              <i className="ph-duotone ph-pencil-simple" />
            </button>
          </nav>
        )}
        <div className="files-tools">
          <button className="icon-btn" title="Up a folder" aria-label="Up a folder" disabled={listing.path === '/'} onClick={() => go(parentOf(listing.path))}>
            <i className="ph-duotone ph-arrow-up" />
          </button>
          <button className="icon-btn" title="Home folder" aria-label="Home folder" onClick={() => go('')}>
            <i className="ph-duotone ph-house" />
          </button>
          <button
            className={'icon-btn' + (pinned ? ' on' : '')}
            title="Pinned folders"
            aria-label="Pinned folders"
            aria-haspopup="menu"
            aria-expanded={toolMenu?.kind === 'pins'}
            onClick={(e) => setToolMenu(toolMenu?.kind === 'pins' ? null : { kind: 'pins', at: e.currentTarget.getBoundingClientRect() })}
          >
            <i className={'ph-duotone ph-star' + (pinned ? ' file-pinned' : '')} />
          </button>
          <button
            className={'icon-btn' + (view === 'search' ? ' on' : '')}
            title="Search in this folder"
            aria-label="Search in this folder"
            aria-pressed={view === 'search'}
            onClick={() => (view === 'search' ? closeSearch() : (setView('search'), setRowMenu(null), setNotice(null)))}
          >
            <i className="ph-duotone ph-magnifying-glass" />
          </button>
          <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => (setSizes({}), refresh())}>
            <i className={'ph-duotone ph-arrows-clockwise' + (loading ? ' spin' : '')} />
          </button>
          <button
            className={'icon-btn' + (showHidden ? ' on' : '')}
            title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            aria-label="Show hidden files"
            aria-pressed={showHidden}
            onClick={() => {
              setShowHidden(!showHidden);
              localSet('filesHidden', showHidden ? '0' : '1');
            }}
          >
            <i className={'ph-duotone ' + (showHidden ? 'ph-eye' : 'ph-eye-slash')} />
          </button>
          <button className="icon-btn" title="Open the terminal here" aria-label="Open the terminal here" onClick={() => onOpenTerminal(listing.path)}>
            <i className="ph-duotone ph-terminal-window" />
          </button>
          <button
            className={'icon-btn' + (view === 'trash' ? ' on' : '')}
            title="Trash"
            aria-label="Trash"
            aria-pressed={view === 'trash'}
            onClick={() => (stopSearch(), setView(view === 'trash' ? 'list' : 'trash'), setRowMenu(null), setNotice(null))}
          >
            <i className="ph-duotone ph-trash" />
          </button>
          <button className="btn btn-secondary btn-small" onClick={() => (setView('list'), setCreating(true), setRenaming(null))}>
            <i className="ph-duotone ph-folder-plus" />
            <span className="files-label">New folder</span>
          </button>
          <button className="btn btn-primary btn-small" onClick={() => fileInput.current?.click()}>
            <i className="ph-duotone ph-upload-simple" />
            <span className="files-label">Upload</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              setView('list');
              upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {toolMenu?.kind === 'pins' && (
        <FloatingMenu at={toolMenu.at} onClose={() => setToolMenu(null)} label="Pinned folders">
          <button role="menuitem" onClick={() => togglePin(listing.path)}>
            <i className={'ph-duotone ph-star' + (pinned ? ' file-pinned' : '')} />
            {pinned ? 'Unpin this folder' : 'Pin this folder'}
          </button>
          {pins.length > 0 && <div className="files-menu-sep" />}
          {pins.map((p) => (
            <div key={p} className="files-pin">
              <button
                role="menuitem"
                className={p === listing.path ? 'on' : ''}
                title={p}
                onClick={() => {
                  setToolMenu(null);
                  go(p);
                }}
              >
                <i className="ph-duotone ph-folder-simple" />
                <span className="files-pin-name">
                  <span>{nameOf(p) || '/'}</span>
                  <span className="meta mono">{parentOf(p)}</span>
                </span>
              </button>
              <button className="icon-btn" title="Unpin" aria-label={`Unpin ${p}`} onClick={() => togglePin(p)}>
                <i className="ph-duotone ph-x" />
              </button>
            </div>
          ))}
          {!pins.length && <p className="meta files-menu-note">Pin folders you go back to, and they’ll be here on every device.</p>}
        </FloatingMenu>
      )}

      {view === 'search' && (
        <form
          className="files-search"
          onSubmit={(e) => {
            e.preventDefault();
            runSearch();
          }}
        >
          <input
            className="input sm"
            autoFocus
            value={searchText}
            placeholder={`Search in ${nameOf(listing.path) || '/'}`}
            aria-label={`Search in ${listing.path}`}
            maxLength={200}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                closeSearch();
              }
            }}
          />
          <span className="tabs files-search-mode" role="radiogroup" aria-label="Search">
            <Glide on={searchMode} />
            {(['name', 'content'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={searchMode === m} className={'tab' + (searchMode === m ? ' active' : '')} onClick={() => setSearchMode(m)}>
                {m === 'name' ? 'Names' : 'Contents'}
              </button>
            ))}
          </span>
          {search && !search.end ? (
            <button type="button" className="btn btn-secondary btn-small" onClick={stopSearch}>
              <i className="ph-duotone ph-stop" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary btn-small" disabled={!searchText.trim()}>
              <i className="ph-duotone ph-magnifying-glass" /> Search
            </button>
          )}
          <button type="button" className="icon-btn" title="Close the search" aria-label="Close the search" onClick={closeSearch}>
            <i className="ph-duotone ph-x" />
          </button>
        </form>
      )}

      {error && (
        <div className="status-line" style={{ margin: 0 }}>
          <i className="ph-duotone ph-warning" /> {error}
          <button className="icon-btn files-dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => setError('')}>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
      )}
      {notice && (
        <div className="files-notice meta" role="status">
          <span className="files-notice-body">
          {notice.kind === 'trashed' && (
            <>
              <span>
                {notice.outcome.trashed.length > 0 && `Moved ${what(notice.outcome.trashed.map((t) => t.path))} to the trash. `}
                {notice.outcome.failed.length > 0 &&
                  `Couldn’t move ${what(notice.outcome.failed.map((f) => f.path))} to the trash: ${notice.outcome.failed[0].error}${notice.outcome.failed.length > 1 ? ' (and more)' : ''}`}
              </span>
              {notice.outcome.trashed.length > 0 && (
                <button className="btn-link" onClick={() => undoTrash(notice.outcome)}>
                  Undo
                </button>
              )}
              {notice.outcome.failed.some((f) => f.permanentOk) && (
                <button className="btn-link" onClick={() => deleteForGood(notice.outcome.failed.filter((f) => f.permanentOk).map((f) => f.path))}>
                  Delete for good instead
                </button>
              )}
            </>
          )}
          {notice.kind === 'archive' && (
            <>
              <span>{nameOf(notice.path)} is an archive.</span>
              <button className="btn-link" onClick={() => unpack(notice.path)}>
                Unpack it here
              </button>
              <a className="btn-link" href={downloadUrl(notice.path)}>
                Download it
              </a>
            </>
          )}
          {notice.kind === 'info' && <span>{notice.text}</span>}
          </span>
          <button className="icon-btn files-dismiss" title="Dismiss" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
      )}
      {uploads.map((u) => (
        <div key={u.name} className="files-upload meta">
          <i className="ph-duotone ph-circle-notch spin" />
          <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {u.name}
          </span>
          <div className="disk-bar" style={{ flex: 1 }}>
            <span style={{ width: `${Math.round(u.pct * 100)}%`, background: 'var(--ac)' }} />
          </div>
          <span className="tnum">{Math.round(u.pct * 100)}%</span>
        </div>
      ))}
      {jobs.map((j) => (
        <div key={j.id} className={'files-job meta' + (j.state === 'failed' ? ' failed' : '')} role="status">
          <i className={'ph-duotone ' + jobIcon(j)} />
          <span className="files-job-text">
            <span className="files-job-label">{j.label}</span>
            <span className="files-job-msg">{j.message}</span>
          </span>
          {j.state === 'running' ? (
            <button className="btn btn-secondary btn-small" onClick={() => filesApi.cancelJob(j.id).then(setJobs).catch(() => {})}>
              Cancel
            </button>
          ) : (
            <>
              {j.result && j.state === 'done' && (
                <button className="btn-link" onClick={() => go(parentOf(j.result!), nameOf(j.result!))}>
                  Show
                </button>
              )}
              <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={() => dismiss(j.id)}>
                <i className="ph-duotone ph-x" />
              </button>
            </>
          )}
        </div>
      ))}
      {clip && view === 'list' && (
        <div className="files-bar">
          <span>
            <i className={'ph-duotone ' + (clip.mode === 'copy' ? 'ph-copy' : 'ph-arrows-out-cardinal')} /> {clipLabel}.{' '}
            <span className="meta">
              {canPaste
                ? `Go to where ${clip.names.length === 1 ? 'it goes' : 'they go'}, then press ${clip.mode === 'copy' ? 'Copy' : 'Move'} here.`
                : `Go to another folder to put ${clip.names.length === 1 ? 'it' : 'them'} there.`}
            </span>
          </span>
          <span className="files-bar-tools">
            <button className="btn btn-primary btn-small" disabled={!canPaste} onClick={paste}>
              <i className="ph-duotone ph-clipboard-text" /> {clip.mode === 'copy' ? 'Copy here' : 'Move here'}
            </button>
            <button className="btn btn-secondary btn-small" onClick={() => setClip(null)}>
              Cancel
            </button>
          </span>
        </div>
      )}
      {chosen.length > 0 && view === 'list' && (
        <div className="files-bar files-select-bar" role="toolbar" aria-label="With what’s chosen">
          <span className="tnum">
            <strong>{chosen.length}</strong> chosen
          </span>
          <span className="files-bar-tools">
            <button className="btn btn-secondary btn-small" title="Download as one .zip" onClick={() => (chosen.length === 1 && chosen[0].kind === 'file' ? (window.location.href = downloadUrl(chosenPaths[0])) : zip(chosenPaths))}>
              <i className="ph-duotone ph-download-simple" />
              <span className="files-label">Download</span>
            </button>
            <button className="btn btn-secondary btn-small" title="Copy to another folder" onClick={() => (setClip({ mode: 'copy', dir: listing.path, names: chosen.map((e) => e.name) }), setSelected(new Set()))}>
              <i className="ph-duotone ph-copy" />
              <span className="files-label">Copy</span>
            </button>
            <button className="btn btn-secondary btn-small" title="Move to another folder" onClick={() => (setClip({ mode: 'move', dir: listing.path, names: chosen.map((e) => e.name) }), setSelected(new Set()))}>
              <i className="ph-duotone ph-arrows-out-cardinal" />
              <span className="files-label">Move</span>
            </button>
            <button
              className="btn btn-secondary btn-small"
              title="Pack into an archive here"
              aria-haspopup="menu"
              onClick={(e) => setToolMenu(toolMenu?.kind === 'pack' ? null : { kind: 'pack', at: e.currentTarget.getBoundingClientRect() })}
            >
              <i className="ph-duotone ph-file-zip" />
              <span className="files-label">Pack</span>
            </button>
            {chosen.some((e) => e.kind === 'dir') && (
              <button className="btn btn-secondary btn-small" title="Calculate the folders’ sizes" onClick={() => measure(chosen.filter((e) => e.kind === 'dir').map((e) => join(listing.path, e.name)))}>
                <i className="ph-duotone ph-ruler" />
                <span className="files-label">Size</span>
              </button>
            )}
            <button className="btn btn-secondary btn-small" title="Move to the trash" onClick={() => trash(chosenPaths)}>
              <i className="ph-duotone ph-trash" />
              <span className="files-label">Delete</span>
            </button>
            <button className="icon-btn" title="Choose none" aria-label="Choose none" onClick={() => setSelected(new Set())}>
              <i className="ph-duotone ph-x" />
            </button>
          </span>
        </div>
      )}
      {toolMenu?.kind === 'pack' && (
        <FloatingMenu at={toolMenu.at} onClose={() => setToolMenu(null)} label="Pack">
          <button role="menuitem" onClick={() => pack(chosenPaths, 'zip')}>
            <i className="ph-duotone ph-file-zip" /> Pack as .zip
          </button>
          <button role="menuitem" onClick={() => pack(chosenPaths, 'tar.gz')}>
            <i className="ph-duotone ph-file-zip" /> Pack as .tar.gz
          </button>
        </FloatingMenu>
      )}

      {view === 'trash' ? (
        <FilesTrash now={now} jobs={jobs} onJob={addJob} onClose={() => setView('list')} />
      ) : view === 'search' && search ? (
        <>
          <div className="files-list scroll" role="list" aria-label="Search results">
            {search.hits.map((h) => (
              <div key={h.path} className="file-row search-row" role="listitem">
                <i className={'ph-duotone ' + iconFor({ kind: h.kind, name: nameOf(h.path) }) + (h.kind === 'dir' ? ' is-dir' : '')} />
                <button className="file-name search-hit" title={h.kind === 'dir' ? `Open ${h.path}` : `Show ${nameOf(h.path)} in its folder`} onClick={() => openHit(h)}>
                  <span className="mono">{nameOf(h.path)}</span>
                  <span className="meta mono search-where">{parentOf(h.path)}</span>
                  {h.text !== undefined && (
                    <span className="mono search-text">
                      <span className="meta tnum">{h.line}:</span> {h.text}
                    </span>
                  )}
                </button>
                <span className="meta tnum file-size">{h.size !== undefined && h.kind === 'file' ? fmtBytes(h.size) : ''}</span>
                <span className="file-actions">
                  {h.kind === 'file' && (
                    <button className="icon-btn" title="Open" aria-label={`Open ${nameOf(h.path)}`} onClick={() => openFile(h.path)}>
                      <i className="ph-duotone ph-arrow-square-out" />
                    </button>
                  )}
                </span>
              </div>
            ))}
            {search.end && !search.hits.length && !search.error && (
              <div className="empty">
                <EmptyArt kind="clear" />
                <p>
                  Nothing {search.mode === 'name' ? 'with a name like' : 'containing'} “{search.query}” in {search.dir}.
                </p>
              </div>
            )}
          </div>
          <div className="split meta files-foot" role="status">
            <span>
              {!search.end ? (
                <>
                  <i className="ph-duotone ph-circle-notch spin" /> Searching {search.mode === 'name' ? 'names' : 'contents'} in {search.dir}… {search.hits.length ? `${search.hits.length} so far` : ''}
                </>
              ) : search.error ? (
                <span style={{ color: 'var(--wn)' }}>
                  {search.error === 'Stopped.' ? `Stopped. ${plural(search.hits.length, 'result')}.` : search.error}
                </span>
              ) : (
                <>
                  {plural(search.hits.length, 'result')}
                  {search.end.more && ` · the first ${SEARCH_LIMIT}; there may be more`}
                  {search.end.timedOut && ` · stopped after ${SEARCH_SECONDS} seconds, so there may be more`}
                </>
              )}
            </span>
            <span>{search.mode === 'content' ? `Files over ${SEARCH_MAX_FILE_MB} MB are skipped` : 'Click one to see it in its folder'}</span>
          </div>
        </>
      ) : view === 'search' ? (
        <div className="files-list scroll">
          <div className="empty">
            <p>
              Search the names of everything under {listing.path}, or what’s in its text files. The first {SEARCH_LIMIT} are shown, for up to {SEARCH_SECONDS} seconds.
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="files-list scroll" role="list" ref={listRef}>
            {entries.length > 0 && (
              <div className="file-row file-head meta" aria-hidden={false}>
                <input
                  type="checkbox"
                  className="file-check"
                  checked={allChosen}
                  ref={(el) => {
                    if (el) el.indeterminate = chosen.length > 0 && !allChosen;
                  }}
                  aria-label={allChosen ? 'Choose none' : 'Choose everything here'}
                  onChange={() => setSelected(allChosen ? new Set() : new Set(names))}
                />
                <span />
                <span>Name</span>
                <span className="file-size">Size</span>
                <span className="file-when">Modified</span>
                <span className="file-mode">Permissions</span>
                <span className="file-actions" />
              </div>
            )}
            {creating && (
              <NameRow
                icon="ph-folder-simple"
                initial=""
                placeholder="New folder name"
                onCancel={() => setCreating(false)}
                onSubmit={(name) => {
                  setCreating(false);
                  act(api.makeDir(join(listing.path, name)));
                }}
              />
            )}
            {entries.map((e) => {
              const full = join(listing.path, e.name);
              return renaming === e.name ? (
                <NameRow
                  key={e.name}
                  icon={iconFor(e)}
                  initial={e.name}
                  onCancel={() => setRenaming(null)}
                  onSubmit={(name) => {
                    setRenaming(null);
                    if (name !== e.name) act(api.renamePath(full, join(listing.path, name)));
                  }}
                />
              ) : (
                <div
                  key={e.name}
                  data-name={e.name}
                  className={'file-row' + (selected.has(e.name) ? ' chosen' : '') + (highlight === e.name ? ' highlight' : '') + (clip?.dir === listing.path && clip.names.includes(e.name) ? ' clipped' : '')}
                  role="listitem"
                  {...menuProps(() => rowItems(e), e.name)}
                >
                  <input
                    type="checkbox"
                    className="file-check"
                    checked={selected.has(e.name)}
                    aria-label={`Choose ${e.name}`}
                    onClick={(ev) => {
                      ev.preventDefault();
                      pick(e.name, ev.shiftKey);
                    }}
                    onChange={() => {}}
                  />
                  <i className={'ph-duotone ' + iconFor(e) + (e.kind === 'dir' ? ' is-dir' : '')} />
                  <button
                    className="file-name mono"
                    disabled={e.kind === 'other'}
                    title={e.link ? `${e.name} (link)` : e.name}
                    onClick={() => (e.kind === 'dir' ? go(full) : openFile(full))}
                  >
                    <span>{e.name}</span>
                    {e.link && <i className="ph-duotone ph-link-simple" aria-label="link" />}
                    {e.kind === 'dir' && pins.includes(full) && <i className="ph-duotone ph-star file-pinned" aria-label="pinned" />}
                  </button>
                  <span className="meta tnum file-size">{sizeCell(e)}</span>
                  <span className="meta tnum file-when">{fmtWhen(e.mtime, now)}</span>
                  <span className="meta mono file-mode">{permString(e)}</span>
                  <span className="file-actions">
                    {e.kind === 'file' && (
                      <a className="icon-btn" href={downloadUrl(full)} title="Download" aria-label={`Download ${e.name}`}>
                        <i className="ph-duotone ph-download-simple" />
                      </a>
                    )}
                    {e.kind === 'dir' && (
                      <button className="icon-btn" title="Download as a .zip" aria-label={`Download ${e.name} as a zip`} onClick={() => zip([full])}>
                        <i className="ph-duotone ph-download-simple" />
                      </button>
                    )}
                    <button className="icon-btn" title="Rename" aria-label={`Rename ${e.name}`} onClick={() => (setRenaming(e.name), setCreating(false))}>
                      <i className="ph-duotone ph-pencil-simple" />
                    </button>
                    <button className="icon-btn" title="Move to the trash" aria-label={`Delete ${e.name}`} onClick={() => trash([full])}>
                      <i className="ph-duotone ph-trash" />
                    </button>
                    <button
                      className={'icon-btn' + (rowMenu === e.name ? ' on' : '')}
                      title="More"
                      aria-label={`More for ${e.name}`}
                      aria-haspopup="menu"
                      aria-expanded={rowMenu === e.name}
                      onClick={(ev) => {
                        if (rowMenu === e.name) return closeMenu();
                        const opened = openMenu({ items: rowItems(e), label: `More for ${e.name}`, anchor: ev.currentTarget.getBoundingClientRect(), keyboard: ev.detail === 0, onClose: () => setRowMenu(null) });
                        if (opened) setRowMenu(e.name);
                      }}
                    >
                      <i className="ph-duotone ph-dots-three" />
                    </button>
                  </span>
                </div>
              );
            })}
            {!entries.length && !creating && (
              <div className="empty">
                <EmptyArt kind="clear" />
                <p>{hiddenCount ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty. Drop files here to upload them.'}</p>
              </div>
            )}
          </div>
          <div className="split meta files-foot">
            <span>
              {chosen.length ? `${chosen.length} of ${entries.length} chosen · ` : ''}
              {plural(entries.filter((e) => e.kind === 'dir').length, 'folder')} · {plural(entries.filter((e) => e.kind !== 'dir').length, 'file')}
              {hiddenCount && !showHidden ? ` · ${hiddenCount} hidden` : ''}
            </span>
            <span className="files-foot-hint">Drop files anywhere here to upload</span>
          </div>
        </>
      )}

    </section>
  );
}

/** A name being typed, for a new folder or a rename. Enter saves, Esc cancels. */
function NameRow({ icon, initial, placeholder, onSubmit, onCancel }: { icon: string; initial: string; placeholder?: string; onSubmit: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current!;
    el.focus();
    // Select the name without its extension, as file managers do.
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  const submit = () => {
    const n = name.trim();
    if (n && !n.includes('/')) onSubmit(n);
    else onCancel();
  };
  return (
    <form
      className="file-row editing"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <span />
      <i className={'ph-duotone ' + icon} />
      <input
        ref={ref}
        className="input sm mono"
        value={name}
        placeholder={placeholder}
        aria-label={placeholder || 'New name'}
        onChange={(e) => setName(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
    </form>
  );
}
