import { useEffect, useRef, useState } from 'react';
import type { Note } from '../../../shared/types';
import { newId } from '../util';

interface Props {
  notes: Note[];
  activeId: string;
  onActive: (id: string) => void;
  onChange: (notes: Note[]) => void;
  saved: boolean;
  onOpenFocus: () => void;
  onEditing: (editing: boolean) => void;
}

/** Light Markdown: "- [ ]" checkboxes, "- "/"* " bullets and **bold**. */
function NoteLines({ text, onToggle }: { text: string; onToggle: (line: number, checked: boolean) => void }) {
  const segs = (s: string) =>
    s
      .split(/(\*\*[^*]+\*\*)/)
      .filter(Boolean)
      .map((x, i) => (/^\*\*.+\*\*$/.test(x) ? <strong key={i} style={{ fontWeight: 600 }}>{x.slice(2, -2)}</strong> : <span key={i}>{x}</span>));
  return (
    <>
      {text.split('\n').map((l, i) => {
        const c = l.match(/^\s*[-*] \[( |x|X)\]\s?(.*)$/);
        const b = !c && l.match(/^\s*[-*] (.*)$/);
        const checked = !!c && c[1].toLowerCase() === 'x';
        return (
          <div key={i} className="note-line" style={{ opacity: checked ? 0.5 : 1, textDecoration: checked ? 'line-through' : 'none' }}>
            {c && (
              <button
                className={'check sm' + (checked ? ' on' : '')}
                aria-label={checked ? 'Uncheck' : 'Check'}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(i, checked);
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
            {n.name || 'Untitled'}
          </button>
        ),
      )}
    </>
  );
}

export function Notes({ notes, activeId, onActive, onChange, saved, onOpenFocus, onEditing }: Props) {
  const [editing, setEditing] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const note = notes.find((n) => n.id === activeId) || notes[0];

  useEffect(() => onEditing(editing), [editing, onEditing]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [menu]);

  const setText = (text: string) => onChange(notes.map((n) => (n.id === note.id ? { ...n, text } : n)));
  const rename = (id: string, name: string) => onChange(notes.map((n) => (n.id === id ? { ...n, name } : n)));

  const add = () => {
    const id = newId('n');
    onChange([...notes, { id, name: 'Untitled', text: '' }]);
    onActive(id);
    setEditing(false);
    setRenaming(id);
  };

  const remove = () => {
    if (notes.length < 2) return;
    if (note.text.trim() && !window.confirm(`Delete “${note.name}”? This can’t be undone.`)) return;
    const rest = notes.filter((n) => n.id !== note.id);
    onChange(rest);
    onActive(rest[0].id);
    setMenu(false);
  };

  return (
    <section className="panel" style={{ gridArea: 'notes', overflow: 'visible', position: 'relative' }} aria-label="Notes">
      <div className="note-head">
        <h2 className="panel-title">Notes</h2>
        <div className="note-tabs">
          <NoteTabs
            notes={notes}
            active={note}
            onActive={(id) => {
              onActive(id);
              setEditing(false);
              setMenu(false);
            }}
            renaming={renaming}
            setRenaming={setRenaming}
            onRename={rename}
            onMenu={() => setMenu(true)}
          />
          <button className="icon-btn" style={{ width: 24, height: 24, color: 'var(--t3)' }} title="New notepad" onClick={add}>
            <i className="ph-duotone ph-plus" />
          </button>
        </div>
        <span className="saved" style={{ opacity: saved ? 1 : 0 }}>
          Saved
        </span>
        <button className="icon-btn" title="Notepad options" onClick={() => setMenu(!menu)}>
          <i className="ph-duotone ph-dots-three" />
        </button>
        <button className="icon-btn" title="Focus view" onClick={onOpenFocus}>
          <i className="ph-duotone ph-arrows-out-simple" />
        </button>
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
            <button onClick={remove} disabled={notes.length < 2} style={{ color: 'var(--wn)' }}>
              <i className="ph-duotone ph-trash" />
              Delete
            </button>
          </div>
        )}
      </div>
      <div className="scroll note-body">
        {editing ? (
          <textarea
            className="note-text"
            value={note.text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
            onBlur={() => setEditing(false)}
            placeholder="Start typing…"
            aria-label={`Notepad ${note.name}`}
          />
        ) : (
          <div onClick={() => setEditing(true)} style={{ minHeight: '100%', cursor: 'text' }}>
            {note.text ? (
              <NoteLines text={note.text} onToggle={(i, c) => setText(toggleLine(note.text, i, c))} />
            ) : (
              <div style={{ color: 'var(--t3)', fontSize: 14 }}>Click to start writing. Use “- [ ]” for a checklist.</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function FocusView({ notes, activeId, onActive, onChange, saved, onClose }: {
  notes: Note[];
  activeId: string;
  onActive: (id: string) => void;
  onChange: (notes: Note[]) => void;
  saved: boolean;
  onClose: () => void;
}) {
  const note = notes.find((n) => n.id === activeId) || notes[0];
  const words = note.text.trim() ? note.text.trim().split(/\s+/).length : 0;
  return (
    <div className="focus-view" role="dialog" aria-label="Notes focus view">
      <div className="focus-col">
        <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
          <div className="tabs" style={{ flex: 1, minWidth: 0, overflowX: 'auto' }}>
            <NoteTabs notes={notes} active={note} onActive={onActive} />
          </div>
          <span className="saved" style={{ opacity: saved ? 1 : 0 }}>
            Saved
          </span>
          <span className="tnum" style={{ fontSize: 12, color: 'var(--t3)' }}>
            {words} words
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
        />
        <div style={{ fontSize: 12, color: 'var(--t3)' }}>“- [ ]” checklist · “- ” bullet · **bold** · Esc to close</div>
      </div>
    </div>
  );
}
