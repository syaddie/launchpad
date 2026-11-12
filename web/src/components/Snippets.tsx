import { useEffect, useState } from 'react';
import type { Snippet } from '../../../shared/types';
import { api } from '../api';

/** Adding (no id) or editing a snippet. */
function SnippetForm({ start, onSave, onCancel }: { start: Partial<Snippet>; onSave: (name: string, command: string) => Promise<void>; onCancel: () => void }) {
  const [name, setName] = useState(start.name ?? '');
  const [command, setCommand] = useState(start.command ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = name.trim() && command.trim();
  const save = () => {
    if (!ok || busy) return;
    setBusy(true);
    onSave(name, command)
      .catch((e) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const keys = (e: React.KeyboardEvent) => {
    // Esc cancels here rather than leaving the view; Ctrl or ⌘ Enter saves.
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
  };
  return (
    <div className="snippet-form" onKeyDown={keys}>
      <input className="input sm" placeholder="Name, e.g. Disk usage" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} aria-label="Snippet name" />
      <textarea className="input mono" placeholder="Command, e.g. df -h" value={command} maxLength={4000} rows={3} onChange={(e) => setCommand(e.target.value)} aria-label="Command" spellCheck={false} />
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary btn-small" disabled={!ok || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button className="btn btn-ghost btn-small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Named commands kept on the server, to type into the open tab or run there. */
export function SnippetsPanel({ canUse, onInsert, onRun, onClose }: {
  /** The open tab's shell is connected. */
  canUse: boolean;
  onInsert: (command: string) => void;
  onRun: (command: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    api
      .snippets()
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!deleting) return;
    const t = window.setTimeout(() => setDeleting(null), 4000);
    return () => clearTimeout(t);
  }, [deleting]);

  const saved = (l: Snippet[]) => {
    setList(l);
    setEditing(null);
    setError('');
  };

  const remove = (id: string) => {
    if (deleting !== id) return setDeleting(id);
    setDeleting(null);
    api
      .deleteSnippet(id)
      .then(setList)
      .catch((e) => setError(e.message));
  };

  return (
    <aside className="snippets" aria-label="Snippets">
      <div className="snippets-head">
        <span className="drawer-label">Snippets</span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" title="New snippet" aria-label="New snippet" onClick={() => setEditing('new')} disabled={editing === 'new'}>
            <i className="ph-duotone ph-plus" />
          </button>
          <button className="icon-btn" title="Hide snippets" aria-label="Hide snippets" onClick={onClose}>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
      </div>
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      <div className="snippets-list">
        {editing === 'new' && <SnippetForm start={{}} onCancel={() => setEditing(null)} onSave={(name, command) => api.addSnippet({ name, command }).then(saved)} />}
        {list === null ? (
          !error && <p className="meta">Loading…</p>
        ) : !list.length && editing !== 'new' ? (
          <div className="empty" style={{ padding: 0, gap: 10 }}>
            <p style={{ fontSize: 13 }}>Save commands you type often, then put them into the open tab with a click.</p>
            <button className="btn btn-secondary btn-small" onClick={() => setEditing('new')}>
              <i className="ph-duotone ph-plus" />
              New snippet
            </button>
          </div>
        ) : (
          list.map((s) =>
            editing === s.id ? (
              <SnippetForm key={s.id} start={s} onCancel={() => setEditing(null)} onSave={(name, command) => api.editSnippet({ id: s.id, name, command }).then(saved)} />
            ) : (
              <div key={s.id} className="snippet">
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="snippet-name">{s.name}</span>
                  <span className="snippet-tools">
                    <button className="icon-btn" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing(s.id)}>
                      <i className="ph-duotone ph-pencil-simple" />
                    </button>
                    {deleting === s.id ? (
                      <button className="btn btn-primary btn-small" onClick={() => remove(s.id)}>
                        Delete?
                      </button>
                    ) : (
                      <button className="icon-btn" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => remove(s.id)}>
                        <i className="ph-duotone ph-trash" />
                      </button>
                    )}
                  </span>
                </div>
                <code className="snippet-cmd" title={s.command}>
                  {s.command}
                </code>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-secondary btn-small" disabled={!canUse} onClick={() => onInsert(s.command)} title="Type it at the prompt, to change before running">
                    <i className="ph-duotone ph-cursor-text" />
                    Insert
                  </button>
                  <button className="btn btn-secondary btn-small" disabled={!canUse} onClick={() => onRun(s.command)} title="Type it and press Enter">
                    <i className="ph-duotone ph-play" />
                    Run
                  </button>
                </div>
              </div>
            ),
          )
        )}
      </div>
    </aside>
  );
}
