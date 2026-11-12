import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { allTags, backlinks, findNote, imageMarkdown, linksIn, parseTags, pinnedFirst, renameLinks, searchNotes } from '../../../shared/notes';
import type { Note, NoteVersion } from '../../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useToast';
import { ago, newId } from '../util';
import { Drawer } from './Drawers';
import { shrinkImage } from './Photos';

interface Props {
  notes: Note[];
  activeId: string;
  onActive: (id: string) => void;
  onChange: (notes: Note[]) => void;
  saved: boolean;
  onOpenFocus: () => void;
  onEditing: (editing: boolean) => void;
  notify?: Notify;
}

const IMAGE_LINE = /^\s*!\[([^\]\n]*)\]\(\/api\/note-images\/([A-Za-z0-9_-]{16})\)\s*$/;

/** Light Markdown: "- [ ]" checkboxes, "- "/"* " bullets, **bold**, [[links]] to other notepads and images on a line of their own. */
export function NoteLines({ text, onToggle, notes, onLink }: {
  text: string;
  onToggle?: (line: number, checked: boolean) => void;
  notes?: Note[];
  onLink?: (name: string) => void;
}) {
  const segs = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*|\[\[[^[\]\n]{1,60}\]\])/)
      .filter(Boolean)
      .map((x, i) => {
        if (/^\*\*.+\*\*$/.test(x)) return <strong key={i} style={{ fontWeight: 600 }}>{x.slice(2, -2)}</strong>;
        const link = x.match(/^\[\[(.+)\]\]$/);
        if (link && onLink) {
          const there = !!notes && !!findNote(notes, link[1]);
          return (
            <button
              key={i}
              className={'note-link' + (there ? '' : ' missing')}
              title={there ? `Open “${link[1].trim()}”` : `No notepad called “${link[1].trim()}” yet. Click to make it.`}
              onClick={(e) => {
                e.stopPropagation();
                onLink(link[1].trim());
              }}
            >
              {link[1]}
            </button>
          );
        }
        return <span key={i}>{x}</span>;
      });
  return (
    <>
      {text.split('\n').map((l, i) => {
        const img = l.match(IMAGE_LINE);
        if (img) {
          return (
            <div key={i} className="note-line note-img-line">
              <img className="note-img" src={`/api/note-images/${img[2]}`} alt={img[1] || 'Image in the note'} loading="lazy" />
            </div>
          );
        }
        const c = l.match(/^\s*[-*] \[( |x|X)\]\s?(.*)$/);
        const b = !c && l.match(/^\s*[-*] (.*)$/);
        const checked = !!c && c[1].toLowerCase() === 'x';
        return (
          <div key={i} className="note-line" style={{ opacity: checked ? 0.5 : 1, textDecoration: checked ? 'line-through' : 'none' }}>
            {c && (
              <button
                className={'check sm' + (checked ? ' on' : '')}
                aria-label={checked ? 'Uncheck' : 'Check'}
                disabled={!onToggle}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle?.(i, checked);
                }}
              >
                {checked && <i className="ph-duotone ph-check" />}
              </button>
            )}
            {b && <span className="bullet" />}
            <span className="txt">{segs(c ? c[2] : b ? b[1] : l)}</span>
          </div>
        );
      })}
    </>
  );
}

export function toggleLine(text: string, line: number, checked: boolean): string {
  const ls = text.split('\n');
  ls[line] = ls[line].replace(/\[( |x|X)\]/, checked ? '[ ]' : '[x]');
  return ls.join('\n');
}

/**
 * Paste or drop images into a note: each is shrunk like a photo, uploaded, and put on a
 * line of its own where the cursor was. Returns the handlers and whether one is uploading.
 */
function useImageDrop(insert: (pos: number, snippet: string) => void, notify?: Notify) {
  const [uploading, setUploading] = useState(0);
  const upload = async (files: File[], el: HTMLTextAreaElement) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (!images.length) return false;
    const pos = el.selectionStart ?? el.value.length;
    setUploading((n) => n + images.length);
    const ids: string[] = [];
    for (const f of images) {
      try {
        ids.push((await api.uploadNoteImage(await shrinkImage(f))).id);
      } catch (e) {
        notify?.(`Couldn’t add the image: ${(e as Error).message}`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (ids.length) insert(pos, ids.map(imageMarkdown).join('\n'));
    return true;
  };
  const handlers = {
    onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = [...e.clipboardData.files];
      if (files.some((f) => f.type.startsWith('image/'))) {
        e.preventDefault();
        upload(files, e.currentTarget);
      }
    },
    onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => {
      if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault();
    },
    onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => {
      const files = [...e.dataTransfer.files];
      if (!files.some((f) => f.type.startsWith('image/'))) return;
      e.preventDefault();
      upload(files, e.currentTarget);
    },
  };
  return { handlers, uploading };
}

/** Put `snippet` on lines of its own at `pos` in `text`. */
export function insertLines(text: string, pos: number, snippet: string): string {
  const at = Math.max(0, Math.min(pos, text.length));
  const before = text.slice(0, at);
  const after = text.slice(at);
  return `${before}${before && !before.endsWith('\n') ? '\n' : ''}${snippet}${after.startsWith('\n') || !after ? '' : '\n'}${after}`;
}

export function NoteTabs({
  notes,
  active,
  onActive,
  renaming,
  setRenaming,
  onRename,
  onMenu,
}: {
  notes: Note[];
  active: Note;
  onActive: (id: string) => void;
  renaming?: string | null;
  setRenaming?: (id: string | null) => void;
  onRename?: (id: string, name: string) => void;
  onMenu?: (id: string) => void;
}) {
  return (
    <>
      {notes.map((n) =>
        renaming === n.id ? (
          <input
            key={n.id}
            className="note-rename"
            value={n.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onChange={(e) => onRename?.(n.id, e.target.value)}
            onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && setRenaming?.(null)}
            onBlur={() => {
              if (!n.name.trim()) onRename?.(n.id, 'Untitled');
              setRenaming?.(null);
            }}
          />
        ) : (
          <button
            key={n.id}
            className={'tab' + (n.id === active.id ? ' active' : '')}
            onClick={() => onActive(n.id)}
            onDoubleClick={() => {
              onActive(n.id);
              setRenaming?.(n.id);
            }}
            onContextMenu={(e) => {
              if (!onMenu) return;
              e.preventDefault();
              onActive(n.id);
              onMenu(n.id);
            }}
          >
            {n.pinned && <i className="ph-fill ph-push-pin note-pin" aria-label="Pinned" />}
            {n.name || 'Untitled'}
          </button>
        ),
      )}
    </>
  );
}

/** Highlight the words searched for. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return <>{text.split(re).map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</>;
}

export function Notes({ notes, activeId, onActive, onChange, saved, onOpenFocus, onEditing, notify }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenamingState] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const [tagMenu, setTagMenu] = useState(false);
  const [tagsDraft, setTagsDraft] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const renameFrom = useRef<{ id: string; name: string } | null>(null);
  const tags = allTags(notes);
  const filter = tag && tags.some((t) => t.tag === tag) ? tag : '';
  const shown = pinnedFirst(filter ? notes.filter((n) => n.tags?.includes(filter)) : notes);
  const note = notes.find((n) => n.id === activeId) || shown[0] || notes[0];
  // Uploads finish after more typing, so they go into the latest copy.
  const latest = useRef({ notes, note });
  latest.current = { notes, note };

  useEffect(() => onEditing(editing), [editing, onEditing]);

  useEffect(() => {
    if (!menu && !tagMenu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      const inside = (r: React.RefObject<HTMLDivElement | null>) => r.current?.contains(e.target as Node);
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !inside(menuRef) && !inside(tagMenuRef)) {
        setMenu(false);
        setTagMenu(false);
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu, tagMenu]);

  const patch = (id: string, p: Partial<Note>) => onChange(latest.current.notes.map((n) => (n.id === id ? { ...n, ...p } : n)));
  const setText = (text: string) => patch(note.id, { text });
  const rename = (id: string, name: string) => patch(id, { name });

  const { handlers: dropHandlers, uploading } = useImageDrop((pos, snippet) => {
    const cur = latest.current.notes.find((n) => n.id === note.id);
    if (cur) patch(cur.id, { text: insertLines(cur.text, pos, snippet) });
  }, notify);

  /** Renaming ends: [[links]] to the old name follow it. */
  const setRenaming = (id: string | null) => {
    if (id) renameFrom.current = { id, name: notes.find((n) => n.id === id)?.name ?? '' };
    else if (renameFrom.current) {
      const { id: was, name: from } = renameFrom.current;
      renameFrom.current = null;
      const to = latest.current.notes.find((n) => n.id === was)?.name.trim() || 'Untitled';
      if (from && from !== to && latest.current.notes.some((n) => n.id !== was && linksIn(n.text).some((l) => l.toLowerCase() === from.trim().toLowerCase()))) {
        onChange(renameLinks(latest.current.notes.map((n) => (n.id === was ? { ...n, name: to } : n)), from, to));
      }
    }
    setRenamingState(id);
  };

  const add = (name = 'Untitled') => {
    const id = newId('n');
    onChange([...latest.current.notes, { id, name, text: '' }]);
    onActive(id);
    setEditing(false);
    if (name === 'Untitled') setRenaming(id);
    return id;
  };

  const openLink = (name: string) => {
    const there = findNote(latest.current.notes, name);
    if (there) {
      if (filter && !there.tags?.includes(filter)) setTag('');
      onActive(there.id);
    } else {
      setTag('');
      add(name);
    }
  };

  const remove = () => {
    if (notes.length < 2) return;
    if (note.text.trim() && !window.confirm(`Delete “${note.name}”? This can’t be undone.`)) return;
    const rest = notes.filter((n) => n.id !== note.id);
    onChange(rest);
    onActive(rest[0].id);
    setMenu(false);
  };

  const restore = (v: NoteVersion) => {
    const before = latest.current.notes.find((n) => n.id === note.id);
    if (!before) return;
    // The text as it is now becomes a version too, so the restore can be undone from History as well.
    api
      .keepNoteVersion(note.id)
      .catch(() => {})
      .finally(() => {
        patch(before.id, { name: v.name, text: v.text });
        setHistory(false);
        notify?.(`Put back “${v.name}” as it was ${ago(v.at, new Date())}.`, { label: 'Undo', run: () => patch(before.id, { name: before.name, text: before.text }) });
      });
  };

  const linkedFrom = backlinks(notes, note);
  const hits = searching ? searchNotes(notes, query) : [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  return (
    <section className="panel" style={{ gridArea: 'notes', overflow: 'visible', position: 'relative' }} aria-label="Notes">
      <div className="note-head">
        <h2 className="panel-title">Notes</h2>
        <div className="note-tabs">
          {filter && (
            <span className="note-filter" title="Only notepads with this tag">
              #{filter}
              <button aria-label="Show every notepad" onClick={() => setTag('')}>
                <i className="ph-duotone ph-x" />
              </button>
            </span>
          )}
          <NoteTabs
            notes={shown}
            active={note}
            onActive={(id) => {
              onActive(id);
              setEditing(false);
              setMenu(false);
              setSearching(false);
            }}
            renaming={renaming}
            setRenaming={setRenaming}
            onRename={rename}
            onMenu={() => setMenu(true)}
          />
          <button className="icon-btn" style={{ width: 24, height: 24, color: 'var(--t3)', flex: 'none' }} title="New notepad" onClick={() => add()}>
            <i className="ph-duotone ph-plus" />
          </button>
        </div>
        <span className="saved" style={{ opacity: saved || uploading ? 1 : 0 }}>
          {uploading ? 'Adding image…' : 'Saved'}
        </span>
        <span className="note-tools">
          <button className={'icon-btn' + (searching ? ' on' : '')} title="Search every notepad" onClick={() => setSearching(!searching)}>
            <i className="ph-duotone ph-magnifying-glass" />
          </button>
          <button className="icon-btn" title="Notepad options" onClick={() => setMenu(!menu)}>
            <i className="ph-duotone ph-dots-three" />
          </button>
          <button className="icon-btn" title="Focus view" onClick={onOpenFocus}>
            <i className="ph-duotone ph-arrows-out-simple" />
          </button>
        </span>
        {tagMenu && (
          <div ref={tagMenuRef} className="popover menu note-menu note-tag-menu">
            <button onClick={() => (setTag(''), setTagMenu(false))} className={filter ? '' : 'on'}>
              <i className="ph-duotone ph-notebook" />
              Every notepad
            </button>
            {tags.map((t) => (
              <button
                key={t.tag}
                className={t.tag === filter ? 'on' : ''}
                onClick={() => {
                  setTag(t.tag);
                  setTagMenu(false);
                  const first = pinnedFirst(notes.filter((n) => n.tags?.includes(t.tag)))[0];
                  if (first && !note.tags?.includes(t.tag)) onActive(first.id);
                }}
              >
                <i className="ph-duotone ph-hash" />
                {t.tag}
                <span className="meta tnum" style={{ marginLeft: 'auto' }}>{t.count}</span>
              </button>
            ))}
          </div>
        )}
        {menu && (
          <div ref={menuRef} className="popover menu note-menu">
            <button
              onClick={() => {
                setRenaming(note.id);
                setMenu(false);
              }}
            >
              <i className="ph-duotone ph-pencil-simple" />
              Rename
            </button>
            <button
              onClick={() => {
                patch(note.id, { pinned: note.pinned ? undefined : true });
                setMenu(false);
              }}
            >
              <i className="ph-duotone ph-push-pin" />
              {note.pinned ? 'Unpin' : 'Pin to the front'}
            </button>
            <button
              onClick={() => {
                setTagsDraft((note.tags ?? []).join(', '));
                setMenu(false);
              }}
            >
              <i className="ph-duotone ph-tag" />
              Tags…
            </button>
            <button
              onClick={() => {
                setHistory(true);
                setMenu(false);
              }}
            >
              <i className="ph-duotone ph-clock-counter-clockwise" />
              History…
            </button>
            {tags.length > 0 && (
              <button
                onClick={() => {
                  setTagMenu(true);
                  setMenu(false);
                }}
              >
                <i className="ph-duotone ph-funnel" />
                Show a tag…
              </button>
            )}
            <button onClick={remove} disabled={notes.length < 2} style={{ color: 'var(--wn)' }}>
              <i className="ph-duotone ph-trash" />
              Delete
            </button>
          </div>
        )}
      </div>
      {tagsDraft !== null && (
        <div className="note-bar">
          <i className="ph-duotone ph-tag" style={{ color: 'var(--t3)' }} />
          <input
            className="input sm"
            autoFocus
            value={tagsDraft}
            placeholder="work, ideas"
            aria-label={`Tags for ${note.name}`}
            onChange={(e) => setTagsDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setTagsDraft(null);
              }
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            onBlur={() => {
              const next = parseTags(tagsDraft);
              patch(note.id, { tags: next.length ? next : undefined });
              setTagsDraft(null);
            }}
          />
          <span className="meta">Commas between them · Enter to keep</span>
        </div>
      )}
      {searching && (
        <div className="note-bar">
          <i className="ph-duotone ph-magnifying-glass" style={{ color: 'var(--t3)' }} />
          <input
            className="input sm"
            autoFocus
            value={query}
            placeholder="Search every notepad"
            aria-label="Search every notepad"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                setSearching(false);
              }
              if (e.key === 'Enter' && hits[0]) {
                setTag('');
                onActive(hits[0].note.id);
                setSearching(false);
              }
            }}
          />
          <span className="meta tnum">{query.trim() ? `${hits.length} notepad${hits.length === 1 ? '' : 's'}` : ''}</span>
        </div>
      )}
      <div className="scroll note-body">
        {searching && query.trim() ? (
          hits.length ? (
            <div className="note-hits">
              {hits.map((h) => (
                <button
                  key={h.note.id}
                  className="note-hit"
                  onClick={() => {
                    setTag('');
                    onActive(h.note.id);
                    setSearching(false);
                  }}
                >
                  <span className="note-hit-name">
                    <Marked text={h.note.name || 'Untitled'} words={words} />
                    {(h.note.tags ?? []).map((t) => (
                      <span key={t} className="note-tag">#<Marked text={t} words={words} /></span>
                    ))}
                  </span>
                  {h.lines.map((l, i) => (
                    <span key={i} className="note-hit-line">
                      <Marked text={l} words={words} />
                    </span>
                  ))}
                </button>
              ))}
            </div>
          ) : (
            <div style={{ color: 'var(--t3)', fontSize: 14 }}>No notepad has “{query.trim()}”.</div>
          )
        ) : editing ? (
          <textarea
            className="note-text"
            value={note.text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setEditing(false)}
            placeholder="Start typing…"
            aria-label={`Notepad ${note.name}`}
            {...dropHandlers}
          />
        ) : (
          <div onClick={() => setEditing(true)} style={{ minHeight: '100%', cursor: 'text' }}>
            {note.text ? (
              <NoteLines text={note.text} onToggle={(i, c) => setText(toggleLine(note.text, i, c))} notes={notes} onLink={openLink} />
            ) : (
              <div style={{ color: 'var(--t3)', fontSize: 14 }}>Click to start writing. Use “- [ ]” for a checklist, [[Another notepad]] to link one, and paste or drop images in.</div>
            )}
            {(linkedFrom.length > 0 || (note.tags?.length ?? 0) > 0) && (
              <div className="note-foot" onClick={(e) => e.stopPropagation()}>
                {(note.tags ?? []).map((t) => (
                  <button key={t} className="note-tag" title={`Only notepads tagged ${t}`} onClick={() => setTag(t)}>
                    #{t}
                  </button>
                ))}
                {linkedFrom.length > 0 && (
                  <span className="meta">
                    Linked from{' '}
                    {linkedFrom.map((n, i) => (
                      <span key={n.id}>
                        {i > 0 && ', '}
                        <button className="note-link" onClick={() => openLink(n.name)}>
                          {n.name || 'Untitled'}
                        </button>
                      </span>
                    ))}
                  </span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {history && createPortal(<HistoryDrawer note={note} onClose={() => setHistory(false)} onRestore={restore} />, document.body)}
    </section>
  );
}

const words = (t: string) => (t.trim() ? t.trim().split(/\s+/).length : 0);

function when(at: string, now: Date): string {
  const d = new Date(at);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return `Today ${time}`;
  if (d.toDateString() === new Date(now.getTime() - 86_400_000).toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

/** A notepad's earlier versions: hourly for the last day, daily for a month. */
function HistoryDrawer({ note, onClose, onRestore }: { note: Note; onClose: () => void; onRestore: (v: NoteVersion) => void }) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null);
  const [error, setError] = useState('');
  const [sel, setSel] = useState(0);
  useEffect(() => {
    api.noteHistory(note.id).then(setVersions).catch((e) => setError(e.message));
  }, [note.id]);
  const now = new Date();
  const v = versions?.[sel];
  return (
    <Drawer title={`History of ${note.name || 'Untitled'}`} onClose={onClose}>
      <div className="drawer-section">
        <p className="meta" style={{ margin: 0, fontSize: 13, color: 'var(--t2)' }}>
          Earlier versions are kept as you write: one an hour for the last day, then one a day for a month. Putting one back keeps what’s there now as a version too.
        </p>
        {error && <p style={{ margin: 0, color: 'var(--wn)', fontSize: 13 }}>Couldn’t load the history: {error}</p>}
        {versions && !versions.length && <p className="meta" style={{ margin: 0, fontSize: 13 }}>No earlier versions yet. They start once you change this notepad.</p>}
        {versions && versions.length > 0 && (
          <div className="note-versions" role="listbox" aria-label="Versions">
            {versions.map((x, i) => (
              <button key={x.at} role="option" aria-selected={i === sel} className={'note-version' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)}>
                <span>{when(x.at, now)}</span>
                <span className="meta tnum">
                  {x.name !== note.name ? `“${x.name}” · ` : ''}
                  {words(x.text)} words
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {v && (
        <div className="drawer-section">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="drawer-label">As it was until {when(v.at, now).toLowerCase()}</span>
            <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={v.text === note.text && v.name === note.name} onClick={() => onRestore(v)}>
              Put this back
            </button>
          </div>
          <div className="note-preview">{v.text ? <NoteLines text={v.text} /> : <span className="meta">Empty</span>}</div>
        </div>
      )}
    </Drawer>
  );
}

export function FocusView({ notes, activeId, onActive, onChange, saved, onClose, notify }: {
  notes: Note[];
  activeId: string;
  onActive: (id: string) => void;
  onChange: (notes: Note[]) => void;
  saved: boolean;
  onClose: () => void;
  notify?: Notify;
}) {
  const note = notes.find((n) => n.id === activeId) || notes[0];
  const latest = useRef({ notes, note });
  latest.current = { notes, note };
  const { handlers, uploading } = useImageDrop((pos, snippet) => {
    const { notes: ns, note: cur } = latest.current;
    onChange(ns.map((n) => (n.id === cur.id ? { ...n, text: insertLines(n.text, pos, snippet) } : n)));
  }, notify);
  const count = words(note.text);
  return (
    <div className="focus-view" role="dialog" aria-label="Notes focus view">
      <div className="focus-col">
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <div className="tabs" style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
            <NoteTabs notes={pinnedFirst(notes)} active={note} onActive={onActive} />
          </div>
          <span className="saved" style={{ opacity: saved || uploading ? 1 : 0 }}>
            {uploading ? 'Adding image…' : 'Saved'}
          </span>
          <span className="tnum" style={{ fontSize: 12, color: 'var(--t3)' }}>
            {count} words
          </span>
          <button className="icon-btn md" title="Close focus view (Esc)" onClick={onClose}>
            <i className="ph-duotone ph-arrows-in-simple" />
          </button>
        </div>
        <div className="serif focus-title">{note.name}</div>
        <textarea
          key={note.id}
          className="focus-text"
          value={note.text}
          autoFocus
          onChange={(e) => onChange(notes.map((n) => (n.id === note.id ? { ...n, text: e.target.value } : n)))}
          placeholder="Start typing…"
          {...handlers}
        />
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>“- [ ]” checklist · “- ” bullet · **bold** · [[Notepad]] link · paste or drop images · Esc to close</div>
      </div>
    </div>
  );
}
