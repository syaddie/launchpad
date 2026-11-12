import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { importFolders, newInFolder, parseBookmarkHtml, type ImportFolder } from '../../../shared/bookmarks';
import type { BookmarkGroup, LinkCheck } from '../../../shared/types';
import { bookmarkOpened } from '../api';
import type { Notify } from '../hooks/useToast';
import { ago, newId } from '../util';
import { Drawer } from './Drawers';
import { Fav, matchBookmark } from './TopBar';

interface Props {
  groups: BookmarkGroup[];
  onChange: (groups: BookmarkGroup[]) => void;
  search: string;
  edit: boolean;
  setEdit: (on: boolean) => void;
  /** The last check for links that no longer open; shown in edit mode. */
  linkCheck?: LinkCheck;
  onCheckLinks?: () => void;
  notify?: Notify;
}

type Drag = { type: 'tile'; g: number; i: number; id: string } | { type: 'group'; g: number; id: string };

const NEW_URL = 'https://';

export function Bookmarks({ groups, onChange, search, edit, setEdit, linkCheck, onCheckLinks, notify }: Props) {
  const [importing, setImporting] = useState<{ folders: ImportFolder[]; file: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const problems = linkCheck?.problems ?? {};
  const broken = groups.reduce((n, g) => n + g.items.filter((b) => problems[b.url]).length, 0);
  const [editTile, setEditTile] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', url: '' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropG, setDropG] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const q = search.trim().toLowerCase();

  useEffect(() => {
    if (!edit) setEditTile(null);
  }, [edit]);

  const mapItems = (fn: (g: BookmarkGroup) => BookmarkGroup) => onChange(groups.map(fn));

  const removeTile = (id: string) => {
    mapItems((g) => ({ ...g, items: g.items.filter((b) => b.id !== id) }));
    setEditTile(null);
  };

  const saveTile = () => {
    if (!editTile) return;
    let url = draft.url.trim();
    if (url && url !== NEW_URL && !/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    if (!url || url === NEW_URL) {
      cancelTile();
      return;
    }
    mapItems((g) => ({ ...g, items: g.items.map((b) => (b.id === editTile ? { ...b, name: draft.name.trim() || b.name, url } : b)) }));
    setEditTile(null);
  };

  // A brand-new tile that never got a URL is dropped on cancel.
  const cancelTile = () => {
    const tile = groups.flatMap((g) => g.items).find((b) => b.id === editTile);
    if (tile && tile.url === NEW_URL) removeTile(tile.id);
    setEditTile(null);
  };

  const onDraftKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') saveTile();
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancelTile();
    }
  };

  const drop = (gi: number, ii: number | null) => {
    const d = drag.current;
    drag.current = null;
    setDragId(null);
    setDropG(null);
    if (!d) return;
    const next = groups.map((g) => ({ ...g, items: g.items.slice() }));
    if (d.type === 'tile') {
      const [it] = next[d.g].items.splice(d.i, 1);
      const idx = ii == null ? next[gi].items.length : ii;
      next[gi].items.splice(idx, 0, it);
    } else {
      const [g] = next.splice(d.g, 1);
      next.splice(gi, 0, g);
    }
    onChange(next);
  };

  const endDrag = () => {
    drag.current = null;
    setDragId(null);
    setDropG(null);
  };

  const removeGroup = (g: BookmarkGroup) => {
    if (g.items.length && !window.confirm(`Delete the “${g.name}” group and its ${g.items.length} bookmark${g.items.length === 1 ? '' : 's'}?`)) return;
    onChange(groups.filter((x) => x.id !== g.id));
  };

  return (
    <section className={'panel bm-panel' + (edit ? ' edit-mode' : '')} style={{ gridArea: 'bm', zIndex: edit ? 5 : 1 }} aria-label="Bookmarks">
      <div className="panel-head" style={{ paddingBottom: 0 }}>
        <h2 className="panel-title">Bookmarks</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {edit && linkCheck && (
            <span className="meta" title={linkCheck.checkedAt ? `Every bookmark is opened once a week; last checked ${new Date(linkCheck.checkedAt).toLocaleString()}` : 'Every bookmark is opened once a week'}>
              {linkCheck.running
                ? 'Checking links…'
                : broken
                  ? <span style={{ color: 'var(--wn)' }}>{broken} link{broken === 1 ? '' : 's'} look{broken === 1 ? 's' : ''} broken</span>
                  : linkCheck.checkedAt ? `Links checked ${ago(linkCheck.checkedAt, new Date())}` : ''}
            </span>
          )}
          {edit && onCheckLinks && (
            <button className="btn btn-ghost btn-small" disabled={linkCheck?.running} onClick={onCheckLinks} title="Open every bookmark now and flag the ones that don’t">
              <i className={'ph-duotone ph-link' + (linkCheck?.running ? ' spin' : '')} />
              Check links
            </button>
          )}
          {edit && (
            <button className="btn btn-ghost btn-small" onClick={() => fileRef.current?.click()} title="Add bookmarks from a browser’s export (Bookmarks › Export, an .html file)">
              <i className="ph-duotone ph-download-simple" />
              Import
            </button>
          )}
          {edit && (
            <input
              ref={fileRef}
              type="file"
              accept=".html,.htm,text/html"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                const folders = parseBookmarkHtml(await f.text());
                if (!folders.some((x) => x.items.length)) notify?.('No bookmarks in that file. Export them from your browser’s bookmark manager as HTML.');
                else setImporting({ folders, file: f.name });
              }}
            />
          )}
          {edit && (
            <button className="btn btn-ghost btn-small" onClick={() => onChange([...groups, { id: newId('g'), name: 'New group', items: [] }])}>
              <i className="ph-duotone ph-plus" />
              Group
            </button>
          )}
          <button className={'edit-toggle' + (edit ? ' on' : '')} onClick={() => setEdit(!edit)}>
            <i className={'ph-duotone ' + (edit ? 'ph-check' : 'ph-pencil-simple')} />
            {edit ? 'Done' : 'Edit'}
          </button>
        </div>
      </div>
      <div className="bm-groups">
        {groups.map((g, gi) => (
          <div
            key={g.id}
            className="bm-group"
            style={{ opacity: dragId === g.id ? 0.4 : 1, outline: edit && dropG === g.id ? '1px dashed var(--t3)' : 'none' }}
            onDragOver={(e) => {
              if (!edit || !drag.current) return;
              e.preventDefault();
              if (dropG !== g.id) setDropG(g.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(gi, null);
            }}
          >
            <div className="bm-group-head">
              {edit ? (
                <>
                  <span
                    draggable
                    onDragStart={(e) => {
                      drag.current = { type: 'group', g: gi, id: g.id };
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(g.id);
                      setEditTile(null);
                    }}
                    onDragEnd={endDrag}
                    title="Drag to reorder"
                    style={{ cursor: 'grab', color: 'var(--t3)', display: 'grid', placeItems: 'center' }}
                  >
                    <i className="ph-duotone ph-dots-six-vertical" />
                  </span>
                  <input
                    className="bm-group-input"
                    value={g.name}
                    onChange={(e) => mapItems((x) => (x.id === g.id ? { ...x, name: e.target.value } : x))}
                    aria-label="Group name"
                  />
                  <button
                    title="Delete group"
                    onClick={() => removeGroup(g)}
                    style={{ border: 'none', background: 'none', color: 'var(--t3)', cursor: 'pointer', padding: 0, display: 'grid', placeItems: 'center' }}
                  >
                    <i className="ph-duotone ph-trash" />
                  </button>
                </>
              ) : (
                <span className="bm-group-name">{g.name}</span>
              )}
            </div>
            <div className="bm-tiles">
              {g.items.map((b, ii) => {
                const isDaily = g.name === 'Daily' && ii < 9;
                const problem = edit ? problems[b.url] : undefined;
                return (
                  <div key={b.id} className="tile-wrap">
                    <a
                      href={edit ? undefined : b.url}
                      target="_blank"
                      rel="noopener"
                      className={'tile' + (editTile === b.id ? ' editing' : '') + (problem ? ' broken' : '')}
                      title={problem ? `${problem.kind === 'gone' ? 'Looks gone' : 'Didn’t open'}: ${problem.why} (checked ${ago(problem.at, new Date())})` : undefined}
                      draggable={edit}
                      style={{ opacity: dragId === b.id ? 0.35 : q && !matchBookmark(b, q) ? 0.3 : 1 }}
                      onAuxClick={(e) => !edit && e.button === 1 && bookmarkOpened(b.id)}
                      onClick={(e) => {
                        if (!edit) return bookmarkOpened(b.id);
                        e.preventDefault();
                        setEditTile(b.id);
                        setDraft({ name: b.name, url: b.url });
                      }}
                      onDragStart={(e) => {
                        if (!edit) return;
                        e.stopPropagation();
                        drag.current = { type: 'tile', g: gi, i: ii, id: b.id };
                        e.dataTransfer.effectAllowed = 'move';
                        setDragId(b.id);
                        setEditTile(null);
                      }}
                      onDragEnd={endDrag}
                      onDragOver={(e) => edit && drag.current && e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        drop(gi, drag.current?.type === 'tile' ? ii : null);
                      }}
                    >
                      <Fav b={b} />
                      <span className="tile-name">{b.name}</span>
                      {problem && <i className="ph-fill ph-warning-circle tile-broken" aria-label={`Link problem: ${problem.why}`} />}
                    </a>
                    {isDaily && <span className="tile-num mono">{ii + 1}</span>}
                    {edit && (
                      <button className="tile-x" title="Remove" onClick={() => removeTile(b.id)}>
                        <i className="ph-duotone ph-x" />
                      </button>
                    )}
                    {edit && editTile === b.id && (
                      <div className="popover tile-editor" onClick={(e) => e.stopPropagation()}>
                        <label className="field">
                          Name
                          <input className="input sm" value={draft.name} autoFocus onChange={(e) => setDraft({ ...draft, name: e.target.value })} onKeyDown={onDraftKey} />
                        </label>
                        <label className="field">
                          URL
                          <input
                            className="input sm mono"
                            style={{ fontSize: 12 }}
                            value={draft.url}
                            onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                            onKeyDown={onDraftKey}
                          />
                        </label>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <button className="btn-link" style={{ textDecoration: 'none', fontSize: 13, color: 'var(--wn)' }} onClick={() => removeTile(b.id)}>
                            Remove
                          </button>
                          <button className="btn btn-ghost" style={{ marginLeft: 'auto', padding: '5px 10px' }} onClick={cancelTile}>
                            Cancel
                          </button>
                          <button className="btn btn-primary" style={{ padding: '5px 12px' }} onClick={saveTile}>
                            Save
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
              {edit && (
                <button
                  className="tile tile-add"
                  style={{ outline: 'none' }}
                  title="Add bookmark"
                  onClick={() => {
                    const id = newId('b');
                    mapItems((x) => (x.id === g.id ? { ...x, items: [...x.items, { id, name: 'New bookmark', url: NEW_URL }] } : x));
                    setEditTile(id);
                    setDraft({ name: 'New bookmark', url: NEW_URL });
                  }}
                >
                  <span className="fav">
                    <i className="ph-duotone ph-plus" />
                  </span>
                  <span className="tile-name" style={{ color: 'var(--t3)' }}>
                    Add
                  </span>
                </button>
              )}
            </div>
          </div>
        ))}
        {!groups.length && !edit && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No bookmarks yet. Press Edit to add some.</div>}
      </div>
      {importing && (
        <ImportDrawer
          file={importing.file}
          folders={importing.folders}
          groups={groups}
          onClose={() => setImporting(null)}
          onImport={(chosen) => {
            const before = groups;
            const r = importFolders(groups, importing.folders, chosen, newId);
            setImporting(null);
            if (!r.added) return notify?.(`Nothing new: ${r.skipped === 1 ? 'that bookmark is' : `all ${r.skipped} are`} already here.`);
            onChange(r.groups);
            notify?.(
              `Added ${r.added} bookmark${r.added === 1 ? '' : 's'}${r.skipped ? `; skipped ${r.skipped} already here` : ''}.`,
              { label: 'Undo', run: () => onChange(before) },
            );
          }}
        />
      )}
    </section>
  );
}

/** Pick which folders of a browser's bookmark export become groups. */
function ImportDrawer({ file, folders, groups, onClose, onImport }: {
  file: string;
  folders: ImportFolder[];
  groups: BookmarkGroup[];
  onClose: () => void;
  onImport: (chosen: number[]) => void;
}) {
  const fresh = folders.map((f) => newInFolder(groups, f));
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(folders.flatMap((f, i) => (f.items.length && fresh[i] ? [i] : []))));
  const toggle = (i: number) => setChosen((s) => {
    const n = new Set(s);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });
  const total = [...chosen].reduce((n, i) => n + fresh[i], 0);
  const names = new Set(groups.map((g) => g.name.trim().toLowerCase()));
  // On the page itself, so it sits above every panel.
  return createPortal(
    <Drawer title="Import bookmarks" onClose={onClose}>
      <div className="drawer-section">
        <p className="meta" style={{ margin: 0, fontSize: 13, color: 'var(--t2)' }}>
          From <b style={{ fontWeight: 600 }}>{file}</b>. Each folder you tick becomes a group with its own links (not its subfolders’, which are listed separately). A folder named like one of your groups adds to it. Links you already have are skipped.
        </p>
        <div className="import-list">
          {folders.map((f, i) =>
            f.items.length ? (
              <label key={i} className="import-row" style={{ paddingLeft: 8 + Math.max(0, f.path.length - 1) * 16 }}>
                <input type="checkbox" checked={chosen.has(i)} disabled={!fresh[i]} onChange={() => toggle(i)} />
                <span className="import-name">
                  {f.path.length ? f.path[f.path.length - 1] : 'Not in a folder (becomes “Imported”)'}
                  {f.path.length > 1 && <span className="meta"> in {f.path.slice(0, -1).join(' › ')}</span>}
                </span>
                <span className="meta tnum" style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
                  {fresh[i] === f.items.length ? f.items.length : `${fresh[i]} new of ${f.items.length}`}
                  {fresh[i] > 0 && names.has((f.path[f.path.length - 1] ?? 'Imported').trim().toLowerCase()) ? ' · adds to your group' : ''}
                </span>
              </label>
            ) : null,
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="btn btn-ghost btn-small" onClick={() => setChosen(new Set(folders.flatMap((_, i) => (fresh[i] ? [i] : []))))}>All</button>
          <button className="btn btn-ghost btn-small" onClick={() => setChosen(new Set())}>None</button>
          <button className="btn btn-primary" style={{ marginLeft: 'auto' }} disabled={!total} onClick={() => onImport([...chosen].sort((a, b) => a - b))}>
            {total ? `Add ${total} bookmark${total === 1 ? '' : 's'}` : 'Nothing to add'}
          </button>
        </div>
      </div>
    </Drawer>,
    document.body,
  );
}
