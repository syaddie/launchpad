import { useEffect, useRef, useState } from 'react';
import type { BookmarkGroup } from '../../../shared/types';
import { newId } from '../util';
import { Fav, matchBookmark } from './TopBar';

interface Props {
  groups: BookmarkGroup[];
  onChange: (groups: BookmarkGroup[]) => void;
  search: string;
  edit: boolean;
  setEdit: (on: boolean) => void;
}

type Drag = { type: 'tile'; g: number; i: number; id: string } | { type: 'group'; g: number; id: string };

const NEW_URL = 'https://';

export function Bookmarks({ groups, onChange, search, edit, setEdit }: Props) {
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
                return (
                  <div key={b.id} className="tile-wrap">
                    <a
                      href={edit ? undefined : b.url}
                      target="_blank"
                      rel="noopener"
                      className={'tile' + (editTile === b.id ? ' editing' : '')}
                      draggable={edit}
                      style={{ opacity: dragId === b.id ? 0.35 : q && !matchBookmark(b, q) ? 0.3 : 1 }}
                      onClick={(e) => {
                        if (!edit) return;
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
    </section>
  );
}
