import { useCallback, useEffect, useRef, useState } from 'react';
import { MON } from '../../../shared/dates';
import type { DirListing, FileEntry } from '../../../shared/types';
import { api, downloadUrl, localGet, localSet, uploadFile, UploadError } from '../api';
import { fmtBytes, hm } from '../util';
import { authorizeLine, Copyable, keyRefused } from './Copyable';

const join = (dir: string, name: string) => (dir === '/' ? '' : dir) + '/' + name;
const parentOf = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

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

const EXT_ICONS: [RegExp, string][] = [
  [/\.(png|jpe?g|gif|webp|svg|heic|bmp|ico)$/i, 'ph-file-image'],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar|zst)$/i, 'ph-file-zip'],
  [/\.(mp3|flac|wav|ogg|m4a|aac)$/i, 'ph-file-audio'],
  [/\.(mp4|mkv|mov|avi|webm)$/i, 'ph-file-video'],
  [/\.(js|ts|tsx|jsx|py|sh|go|rs|c|h|cpp|java|rb|php|json|ya?ml|toml|ini|conf|cfg|env|xml|html|css|sql)$/i, 'ph-file-code'],
  [/\.(txt|md|log|csv)$/i, 'ph-file-text'],
];

function iconFor(e: FileEntry): string {
  if (e.kind === 'dir') return 'ph-folder-simple';
  if (e.kind === 'other') return 'ph-file-dashed';
  return EXT_ICONS.find(([re]) => re.test(e.name))?.[1] ?? 'ph-file';
}

interface Upload { name: string; pct: number }

/** A file explorer for the server, over SFTP. Stays mounted while hidden, so an open file keeps its edits. */
export function FilesPanel({ publicKey, hidden, now, onOpenTerminal, onFailed }: {
  publicKey: string;
  hidden: boolean;
  now: Date;
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
  const fileInput = useRef<HTMLInputElement>(null);
  const onFailedRef = useRef(onFailed);
  onFailedRef.current = onFailed;

  const load = useCallback((path?: string) => {
    setLoading(true);
    return api
      .listDir(path)
      .then((l) => {
        setListing(l);
        setError('');
        localSet('filesPath', l.path);
      })
      .catch((e: Error) => {
        setError(e.message);
        throw e;
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    // Back to the last folder, or the root if it's gone.
    const last = localGet('filesPath') || '/';
    load(last).catch(() => (last !== '/' ? load('/') : Promise.reject()).catch(() => onFailedRef.current()));
  }, [load]);

  const dirty = !!file && file.text !== file.saved;
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const go = (path: string) => {
    setRenaming(null);
    setCreating(false);
    load(path).catch(() => {});
  };

  const refresh = () => listing && load(listing.path).catch(() => {});

  const act = (p: Promise<unknown>) => p.then(refresh).catch((e: Error) => setError(e.message));

  const openFile = (path: string) => {
    setError('');
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

  const remove = (e: FileEntry) => {
    const what = e.kind === 'dir' && !e.link ? `the folder “${e.name}” and everything in it` : `“${e.name}”`;
    if (!window.confirm(`Delete ${what}? This can’t be undone.`)) return;
    act(api.deletePath(join(listing!.path, e.name)));
  };

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

  const crumbs = listing.path === '/' ? [] : listing.path.slice(1).split('/');
  const entries = listing.entries.filter((e) => showHidden || !e.name.startsWith('.'));
  const hiddenCount = listing.entries.length - entries.length;

  return (
    <section
      className={'panel srv-panel files-panel' + (dragging ? ' dragging' : '')}
      aria-label="Files"
      style={style}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        upload([...e.dataTransfer.files]);
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
          <button className="icon-btn" title="Refresh" aria-label="Refresh" onClick={refresh}>
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
          <button className="btn btn-secondary btn-small" onClick={() => (setCreating(true), setRenaming(null))}>
            <i className="ph-duotone ph-folder-plus" />
            New folder
          </button>
          <button className="btn btn-primary btn-small" onClick={() => fileInput.current?.click()}>
            <i className="ph-duotone ph-upload-simple" />
            Upload
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              upload([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {error && (
        <div className="status-line" style={{ margin: 0 }}>
          <i className="ph-duotone ph-warning" /> {error}
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

      <div className="files-list scroll" role="list">
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
        {entries.map((e) =>
          renaming === e.name ? (
            <NameRow
              key={e.name}
              icon={iconFor(e)}
              initial={e.name}
              onCancel={() => setRenaming(null)}
              onSubmit={(name) => {
                setRenaming(null);
                if (name !== e.name) act(api.renamePath(join(listing.path, e.name), join(listing.path, name)));
              }}
            />
          ) : (
            <div key={e.name} className="file-row" role="listitem">
              <i className={'ph-duotone ' + iconFor(e) + (e.kind === 'dir' ? ' is-dir' : '')} />
              <button
                className="file-name mono"
                disabled={e.kind === 'other'}
                title={e.link ? `${e.name} (link)` : e.name}
                onClick={() => (e.kind === 'dir' ? go(join(listing.path, e.name)) : openFile(join(listing.path, e.name)))}
              >
                <span>{e.name}</span>
                {e.link && <i className="ph-duotone ph-link-simple" aria-label="link" />}
              </button>
              <span className="meta tnum file-size">{e.kind === 'file' ? fmtBytes(e.size) : ''}</span>
              <span className="meta tnum file-when">{fmtWhen(e.mtime, now)}</span>
              <span className="meta mono file-mode">{permString(e)}</span>
              <span className="file-actions">
                {e.kind === 'file' && (
                  <a className="icon-btn" href={downloadUrl(join(listing.path, e.name))} title="Download" aria-label={`Download ${e.name}`}>
                    <i className="ph-duotone ph-download-simple" />
                  </a>
                )}
                {e.kind === 'dir' && (
                  <button className="icon-btn" title="Open the terminal here" aria-label={`Open the terminal in ${e.name}`} onClick={() => onOpenTerminal(join(listing.path, e.name))}>
                    <i className="ph-duotone ph-terminal-window" />
                  </button>
                )}
                <button className="icon-btn" title="Rename" aria-label={`Rename ${e.name}`} onClick={() => (setRenaming(e.name), setCreating(false))}>
                  <i className="ph-duotone ph-pencil-simple" />
                </button>
                <button className="icon-btn" title="Delete" aria-label={`Delete ${e.name}`} onClick={() => remove(e)}>
                  <i className="ph-duotone ph-trash" />
                </button>
              </span>
            </div>
          ),
        )}
        {!entries.length && !creating && (
          <div className="empty">
            <p>{hiddenCount ? `Only hidden files here (${hiddenCount}).` : 'This folder is empty. Drop files here to upload them.'}</p>
          </div>
        )}
      </div>
      <div className="split meta files-foot">
        <span>
          {entries.filter((e) => e.kind === 'dir').length} folders · {entries.filter((e) => e.kind !== 'dir').length} files
          {hiddenCount && !showHidden ? ` · ${hiddenCount} hidden` : ''}
        </span>
        <span>Drop files anywhere here to upload</span>
      </div>
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
