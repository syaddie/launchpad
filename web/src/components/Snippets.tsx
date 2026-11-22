import { useEffect, useRef, useState } from 'react';
import type { Snippet } from '../../../shared/types';
import { cleanCommand, MAX_SHELL_ASK, type ShellAnswer, type ShellAskStatus } from '../../../shared/shellAsk';
import { api } from '../api';
import { closeMenu, menuProps, openMenu, type MenuItem } from './ContextMenu';

type Asked = { q: string; status: 'busy' } | { q: string; status: 'done'; answer: ShellAnswer } | { q: string; status: 'failed'; error: string };

/** Ask for a command: what's typed and Claude's answer, which only goes in at the prompt when Insert is pressed. */
function useCommandAsk(cwd: string | null) {
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<Asked | null>(null);
  const [status, setStatus] = useState<ShellAskStatus | null>(null);
  const seq = useRef(0);
  // Checked again on focus and after each answer, so a budget raised in Settings is picked up.
  const check = () => {
    api
      .shellAskStatus()
      .then(setStatus)
      .catch(() => {});
  };
  useEffect(check, []);
  const ask = () => {
    const t = q.trim();
    if (!t || (asked?.status === 'busy' && asked.q === t)) return;
    const n = ++seq.current;
    setAsked({ q: t, status: 'busy' });
    api
      .shellAsk(t, cwd)
      .then((r) => seq.current === n && setAsked('error' in r ? { q: t, status: 'failed', error: r.error } : { q: t, status: 'done', answer: r }))
      .catch((e) => seq.current === n && setAsked({ q: t, status: 'failed', error: (e as Error).message }))
      .finally(() => seq.current === n && check());
  };
  const clear = () => {
    seq.current++;
    setAsked(null);
  };
  return { q, setQ, asked, status, check, ask, clear };
}

type CommandAsk = ReturnType<typeof useCommandAsk>;

/** The box at the top of the snippets bar. */
function AskBox({ a, cwd }: { a: CommandAsk; cwd: string | null }) {
  if (a.status && !a.status.enabled) {
    return <p className="meta cmd-ask-off">Add ANTHROPIC_API_KEY on the server to ask Claude for commands.</p>;
  }
  const busy = a.asked?.status === 'busy';
  return (
    <div className="cmd-ask">
      <form
        className="cmd-ask-row"
        onSubmit={(e) => {
          e.preventDefault();
          a.ask();
        }}
      >
        <i className="ph-duotone ph-sparkle" aria-hidden />
        <input
          className="input sm"
          placeholder="Ask Claude for a command"
          aria-label="Ask Claude for a command, in plain English"
          title={`Say what you want in plain English. Claude knows the server’s OS${cwd ? ` and that this tab is in ${cwd}` : ''}.`}
          value={a.q}
          maxLength={MAX_SHELL_ASK}
          enterKeyHint="go"
          autoComplete="off"
          onChange={(e) => a.setQ(e.target.value)}
          onFocus={a.check}
          onKeyDown={(e) => {
            // Esc clears the box here rather than leaving the view.
            if (e.key === 'Escape' && (a.q || a.asked)) {
              e.stopPropagation();
              a.setQ('');
              a.clear();
            }
          }}
        />
        <button className="icon-btn" type="submit" disabled={!a.q.trim() || busy} title="Ask" aria-label="Ask">
          <i className={'ph-duotone ' + (busy ? 'ph-circle-notch spin' : 'ph-arrow-right')} />
        </button>
      </form>
      {a.status?.blocked && <p className="cmd-ask-note">{a.status.blocked}</p>}
    </div>
  );
}

/** Claude's command, what it does and any warning, with Insert to type it at the prompt. */
function AskAnswer({ a, canUse, onInsert, onSave }: { a: CommandAsk; canUse: boolean; onInsert: (command: string) => void; onSave: (name: string, command: string) => void }) {
  const asked = a.asked;
  if (!asked) return null;
  const close = (
    <button className="icon-btn" title="Dismiss" aria-label="Dismiss" onClick={a.clear}>
      <i className="ph-duotone ph-x" />
    </button>
  );
  if (asked.status === 'busy') {
    return (
      <div className="cmd-answer" role="status">
        <div className="cmd-answer-top">
          <p className="meta" style={{ flex: 1, margin: 0 }}>Working it out…</p>
          {close}
        </div>
      </div>
    );
  }
  if (asked.status === 'failed') {
    // Over the budget: the note under the box says so already.
    if (asked.error === a.status?.blocked) return null;
    return (
      <div className="cmd-answer failed" role="status">
        <div className="cmd-answer-top">
          <p className="cmd-answer-error">{asked.error}</p>
          {close}
        </div>
      </div>
    );
  }
  const { command, explanation, warning, risks } = asked.answer;
  // Cleaned on the server already; checked again so only one line of text can reach the prompt.
  const safe = cleanCommand(command);
  return (
    <div className={'cmd-answer' + (risks.length ? ' risky' : '')} role="status">
      <div className="cmd-answer-top">
        <code className="cmd-answer-cmd">{command}</code>
        {close}
      </div>
      {explanation && <p className="cmd-answer-what">{explanation}</p>}
      {warning && (
        <p className="cmd-answer-warn">
          <i className="ph-duotone ph-warning" aria-hidden />
          <span>{warning}</span>
        </p>
      )}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary btn-small"
          disabled={!canUse || !safe.ok}
          onClick={() => safe.ok && onInsert(safe.command)}
          title={canUse ? 'Type it at the prompt. Nothing runs until you press Enter.' : 'Waiting for the shell to connect'}
        >
          <i className="ph-duotone ph-cursor-text" />
          Insert
        </button>
        <button className="btn btn-secondary btn-small" disabled={!safe.ok} onClick={() => safe.ok && onSave(asked.q, safe.command)} title="Keep it as a snippet">
          <i className="ph-duotone ph-floppy-disk" />
          Save
        </button>
      </div>
    </div>
  );
}

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

/** Named commands kept on the server, to type into the open tab or run there, and Ask for a command above them. */
export function SnippetsPanel({ canUse, cwd, onInsert, onRun, onClose }: {
  /** The open tab's shell is connected. */
  canUse: boolean;
  /** The open tab's folder, when its shell reports it. */
  cwd: string | null;
  onInsert: (command: string) => void;
  onRun: (command: string) => void;
  onClose: () => void;
}) {
  const [list, setList] = useState<Snippet[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  /** What a new snippet starts with: empty, or a command Claude wrote. */
  const [draft, setDraft] = useState<Partial<Snippet>>({});
  /** The snippet whose ⋯ menu is open, to light its button. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const asking = useCommandAsk(cwd);

  const newSnippet = (start: Partial<Snippet> = {}) => {
    setDraft(start);
    setEditing('new');
  };

  useEffect(() => {
    api
      .snippets()
      .then(setList)
      .catch((e) => setError(e.message));
  }, []);

  const saved = (l: Snippet[]) => {
    setList(l);
    setEditing(null);
    setError('');
  };

  const deleteNow = (id: string) => {
    api
      .deleteSnippet(id)
      .then(setList)
      .catch((e) => setError(e.message));
  };

  const snippetMenu = (s: Snippet): MenuItem[] => [
    { label: 'Insert', icon: 'ph-cursor-text', disabled: !canUse, onSelect: () => onInsert(s.command) },
    { label: 'Run', icon: 'ph-play', disabled: !canUse, onSelect: () => onRun(s.command) },
    'sep',
    { label: 'Edit', icon: 'ph-pencil-simple', onSelect: () => setEditing(s.id) },
    { label: 'Delete', icon: 'ph-trash', danger: true, confirm: `Delete the “${s.name}” snippet?`, onSelect: () => deleteNow(s.id) },
  ];

  return (
    <aside className="snippets" aria-label="Snippets">
      <div className="snippets-head">
        <span className="drawer-label">Snippets</span>
        <div style={{ display: 'flex', gap: 2 }}>
          <button className="icon-btn" title="New snippet" aria-label="New snippet" onClick={() => newSnippet()} disabled={editing === 'new'}>
            <i className="ph-duotone ph-plus" />
          </button>
          <button className="icon-btn" title="Hide snippets" aria-label="Hide snippets" onClick={onClose}>
            <i className="ph-duotone ph-x" />
          </button>
        </div>
      </div>
      <AskBox a={asking} cwd={cwd} />
      {error && <div className="status-line" style={{ margin: 0 }}>{error}</div>}
      <div className="snippets-list">
        <AskAnswer a={asking} canUse={canUse} onInsert={onInsert} onSave={(q, command) => newSnippet({ name: (q[0].toUpperCase() + q.slice(1)).slice(0, 80), command })} />
        {editing === 'new' && <SnippetForm key={draft.command ?? ''} start={draft} onCancel={() => setEditing(null)} onSave={(name, command) => api.addSnippet({ name, command }).then(saved)} />}
        {list === null ? (
          !error && <p className="meta">Loading…</p>
        ) : !list.length && editing !== 'new' ? (
          <div className="empty" style={{ padding: 0, gap: 10 }}>
            <p style={{ fontSize: 13 }}>Save commands you type often, then put them into the open tab with a click.</p>
            <button className="btn btn-secondary btn-small" onClick={() => newSnippet()}>
              <i className="ph-duotone ph-plus" />
              New snippet
            </button>
          </div>
        ) : (
          list.map((s) =>
            editing === s.id ? (
              <SnippetForm key={s.id} start={s} onCancel={() => setEditing(null)} onSave={(name, command) => api.editSnippet({ id: s.id, name, command }).then(saved)} />
            ) : (
              <div key={s.id} className="snippet" {...menuProps(() => snippetMenu(s), s.name)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span className="snippet-name">{s.name}</span>
                  <span className="snippet-tools">
                    {/* Edit and Delete (and Insert, Run) are in here, as on a right-click or long press. */}
                    <button
                      className={'icon-btn' + (menuFor === s.id ? ' on' : '')}
                      title="More"
                      aria-label={`More for ${s.name}`}
                      aria-haspopup="menu"
                      onClick={(e) => {
                        if (menuFor === s.id) return closeMenu();
                        if (openMenu({ items: snippetMenu(s), label: s.name, anchor: e.currentTarget.getBoundingClientRect(), keyboard: e.detail === 0, onClose: () => setMenuFor(null) })) setMenuFor(s.id);
                      }}
                    >
                      <i className="ph-duotone ph-dots-three" />
                    </button>
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
