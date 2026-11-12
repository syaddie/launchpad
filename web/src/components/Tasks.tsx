import { useEffect, useRef, useState } from 'react';
import { dayDiff, parseDue, parseDueWord, parseYmd, startOfDay } from '../../../shared/dates';
import type { AppState, Task } from '../../../shared/types';
import { fmtDay, shortDay } from '../util';

interface Props {
  data: AppState;
  now: Date;
  onConnect: () => void;
  onAdd: (listId: string, title: string, due: string | null, opts?: { parent?: string }) => void;
  /** Called once the 5-second undo window has passed. */
  onComplete: (t: Task, keepalive?: boolean) => void;
  onUpdate?: (t: Task, patch: { title?: string; due?: string | null }) => void;
  onMove?: (t: Task, listId: string) => void;
  /** Called once the 5-second undo window has passed; subtasks go with it. */
  onDelete?: (t: Task, keepalive?: boolean) => void;
}

const UNDO_MS = 5000;

/** Google's order among siblings. */
const byPosition = (a: Task, b: Task) => ((a.position ?? '') < (b.position ?? '') ? -1 : (a.position ?? '') > (b.position ?? '') ? 1 : 0);

export function Tasks({ data, now, onConnect, onAdd, onComplete, onUpdate, onMove, onDelete }: Props) {
  const [list, setList] = useState('All');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ task: Task; kind: 'complete' | 'delete' } | null>(null);
  const timer = useRef(0);
  const pending = useRef<{ task: Task; kind: 'complete' | 'delete' } | null>(null);

  const finalize = (keepalive = false) => {
    clearTimeout(timer.current);
    const p = pending.current;
    if (p?.kind === 'complete') onComplete(p.task, keepalive);
    if (p?.kind === 'delete') onDelete?.(p.task, keepalive);
    pending.current = null;
    setUndo(null);
  };

  // Don't lose a completion or a delete if the tab closes during the undo window.
  useEffect(() => {
    const h = () => finalize(true);
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  });

  const later = (task: Task, kind: 'complete' | 'delete') => {
    if (undo?.task.id === task.id && undo.kind === kind) {
      undoNow();
      return;
    }
    finalize(); // another one finalises the previous one
    pending.current = { task, kind };
    setUndo({ task, kind });
    timer.current = window.setTimeout(() => finalize(), UNDO_MS);
    if (kind === 'delete') setOpen(null);
  };

  const undoNow = () => {
    clearTimeout(timer.current);
    pending.current = null;
    setUndo(null);
  };

  const connected = data.google.connected;
  const on = data.prefs.sources.tasks;
  const today = startOfDay(now);
  const listName = (id: string) => data.taskLists.find((l) => l.id === id)?.title || '';
  const lists = data.taskLists.length > 1 ? ['All', ...data.taskLists.map((l) => l.title)] : [];
  const currentList = lists.includes(list) ? list : 'All';
  const deleting = undo?.kind === 'delete' ? undo.task.id : null;
  const ids = new Set(data.tasks.map((t) => t.id));
  // A subtask shows under its task; one whose task isn't here (completed elsewhere) shows on its own.
  const isSub = (t: Task) => !!t.parent && ids.has(t.parent);
  const live = data.tasks.filter((t) => t.id !== deleting && t.parent !== deleting);
  const subsOf = (id: string) => live.filter((t) => t.parent === id).sort(byPosition);
  const vis = live.filter((t) => !isSub(t) && (currentList === 'All' || listName(t.listId) === currentList));
  const off = (t: Task) => (t.due ? dayDiff(today, parseYmd(t.due)) : null);
  const groups: { label: string; color: string; items: Task[] }[] = [
    { label: 'Overdue', color: 'var(--wn)', items: vis.filter((t) => (off(t) ?? 0) < 0) },
    { label: 'Today', color: 'var(--t2)', items: vis.filter((t) => off(t) === 0) },
    { label: 'Upcoming', color: 'var(--t2)', items: vis.filter((t) => (off(t) ?? 0) > 0).sort((a, b) => (a.due! < b.due! ? -1 : 1)) },
    { label: 'No date', color: 'var(--t2)', items: vis.filter((t) => t.due == null) },
  ].filter((g) => g.items.length);

  const pd = parseDue(text, today);

  const submit = () => {
    if (!text.trim() || !pd.title) return;
    const target = data.taskLists.find((l) => l.title === currentList) || data.taskLists[0];
    if (!target) return;
    onAdd(target.id, pd.title, pd.due || null);
    setText('');
  };

  const row = (t: Task, sub = false) => {
    const done = undo?.kind === 'complete' && undo.task.id === t.id;
    const o = off(t);
    const due = o == null || o === 0 ? '' : o < 0 ? fmtDay(parseYmd(t.due!)) : shortDay(parseYmd(t.due!), today);
    const subs = sub ? [] : subsOf(t.id);
    const editable = !!(onUpdate || onDelete);
    return (
      <div key={t.id} className={sub ? 'task-sub' : undefined}>
        <div className={'task' + (open === t.id ? ' open' : '')} style={{ opacity: done ? 0.45 : 1 }}>
          <button className={'check' + (done ? ' on' : '')} aria-label={done ? 'Undo' : 'Complete'} onClick={() => later(t, 'complete')}>
            {done && <i className="ph-duotone ph-check" />}
          </button>
          <span
            className={'task-title' + (editable ? ' editable' : '')}
            style={{ textDecoration: done ? 'line-through' : 'none' }}
            onClick={() => editable && setOpen(open === t.id ? null : t.id)}
            title={editable ? 'Edit' : undefined}
          >
            {t.title}
            {subs.length > 3 && open !== t.id && <span className="task-subcount">{subs.length} subtask{subs.length === 1 ? '' : 's'}</span>}
          </span>
          <span className="task-due" style={{ color: o != null && o < 0 ? 'var(--wn)' : 'var(--t3)' }}>
            {due}
          </span>
        </div>
        {open === t.id && (
          <TaskEditor
            key={t.id}
            task={t}
            data={data}
            today={today}
            sub={sub}
            onUpdate={onUpdate}
            onMove={onMove && ((l) => (onMove(t, l), setOpen(null)))}
            onDelete={onDelete && (() => later(t, 'delete'))}
            onAddSub={(title, d) => onAdd(t.listId, title, d, { parent: t.id })}
            onClose={() => setOpen(null)}
          />
        )}
        {subs.length > 0 && (open === t.id || subs.length <= 3) && <div className="task-subs">{subs.map((s) => row(s, true))}</div>}
      </div>
    );
  };

  return (
    <section className="panel" style={{ gridArea: 'tasks' }} aria-label="Tasks">
      <div className="panel-head" style={{ flexWrap: 'wrap' }}>
        <h2 className="panel-title">Tasks</h2>
        {connected && on && lists.length > 0 && (
          <div className="tabs">
            {lists.map((l) => (
              <button key={l} className={'tab' + (l === currentList ? ' active' : '')} onClick={() => setList(l)}>
                {l}
              </button>
            ))}
          </div>
        )}
      </div>
      {connected && on ? (
        <>
          {/* Bento leads each tile with one number; the other designs hide this. */}
          <div className="big-count" aria-hidden="true">
            <b>{vis.length}</b>
            <span>
              open
              {groups[0]?.label === 'Overdue' && <em>{groups[0].items.length} overdue</em>}
            </span>
          </div>
          <div className="task-add">
            <i className="ph-duotone ph-plus" style={{ fontSize: 16, color: 'var(--t3)', width: 16 }} />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="Add a task… try “call bank fri”"
              aria-label="Add a task"
            />
            {pd.due && (
              <span style={{ fontSize: 12, color: 'var(--acd)', whiteSpace: 'nowrap', animation: 'lpFade .15s' }}>Due {fmtDay(parseYmd(pd.due))}</span>
            )}
          </div>
          <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {groups.map((g) => (
              <div key={g.label} style={{ display: 'flex', flexDirection: 'column' }}>
                <div className="task-group-label" style={{ color: g.color }}>
                  {g.label}
                </div>
                {g.items.map((t) => row(t))}
              </div>
            ))}
            {!groups.length && <div style={{ padding: '5px 10px', fontSize: 13, color: 'var(--t3)' }}>Nothing here. Enjoy it.</div>}
          </div>
          {undo && (
            <div className="undo">
              <span style={{ flex: 1, minWidth: 0, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {undo.kind === 'complete' ? 'Completed' : 'Deleted'} “{undo.task.title}”
              </span>
              <button className="btn-link" style={{ textDecoration: 'none', fontWeight: 600, color: 'var(--acd)' }} onClick={undoNow}>
                Undo
              </button>
            </div>
          )}
        </>
      ) : connected ? (
        <div className="empty">
          <p>Tasks sync is off. Turn it on in Settings.</p>
        </div>
      ) : (
        <div className="empty">
          <p>Your Google Tasks will show up here once you connect.</p>
          <button className="btn btn-secondary" onClick={onConnect}>
            Connect Google
          </button>
        </div>
      )}
    </section>
  );
}

/** Under a task: its title, due date, list and subtasks, and Delete. */
function TaskEditor({ task, data, today, sub, onUpdate, onMove, onDelete, onAddSub, onClose }: {
  task: Task;
  data: AppState;
  today: Date;
  sub: boolean;
  onUpdate?: (t: Task, patch: { title?: string; due?: string | null }) => void;
  onMove?: (listId: string) => void;
  onDelete?: () => void;
  onAddSub: (title: string, due: string | null) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [due, setDue] = useState('');
  const [subText, setSubText] = useState('');
  const dueValue = due.trim() ? parseDueWord(due, today) : undefined;
  const subDue = parseDue(subText, today);

  const saveTitle = () => {
    const t = title.trim();
    if (t && t !== task.title) onUpdate?.(task, { title: t });
    else setTitle(task.title);
  };
  const saveDue = (v: string | undefined) => {
    if (v === undefined) return;
    const next = v || null;
    if (next !== task.due) onUpdate?.(task, { due: next });
    setDue('');
  };
  const addSub = () => {
    if (!subDue.title) return;
    onAddSub(subDue.title, subDue.due || null);
    setSubText('');
  };

  return (
    <div className="task-edit" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      {onUpdate && (
        <input
          className="input sm"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={saveTitle}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
          aria-label="Title"
          autoFocus
        />
      )}
      {onUpdate && (
        <div className="task-edit-row">
          <i className="ph-duotone ph-calendar-blank" aria-hidden="true" />
          <input
            className="input sm"
            value={due}
            onChange={(e) => setDue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && saveDue(dueValue)}
            placeholder={task.due ? `Due ${fmtDay(parseYmd(task.due))} · type fri, 14 nov or none` : 'Due date: fri, 14 nov, in 3 days'}
            aria-label="Due date"
          />
          {due.trim() ? (
            dueValue === undefined ? (
              <span className="task-edit-hint">Not a date</span>
            ) : (
              <button className="btn btn-secondary btn-small" onClick={() => saveDue(dueValue)}>
                {dueValue ? `Due ${fmtDay(parseYmd(dueValue))}` : 'No date'}
              </button>
            )
          ) : (
            task.due && (
              <button className="btn btn-ghost btn-small" onClick={() => saveDue('')}>
                Clear date
              </button>
            )
          )}
        </div>
      )}
      {onMove && !sub && data.taskLists.length > 1 && (
        <div className="task-edit-row">
          <i className="ph-duotone ph-list-bullets" aria-hidden="true" />
          <select className="ln-mini-select" value={task.listId} onChange={(e) => onMove(e.target.value)} aria-label="List">
            {data.taskLists.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}
              </option>
            ))}
          </select>
        </div>
      )}
      {!sub && (
        <div className="task-edit-row">
          <i className="ph-duotone ph-plus" aria-hidden="true" />
          <input
            className="input sm"
            value={subText}
            onChange={(e) => setSubText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSub()}
            placeholder="Add a subtask…"
            aria-label="Add a subtask"
          />
          {subDue.due && <span className="task-edit-hint">Due {fmtDay(parseYmd(subDue.due))}</span>}
        </div>
      )}
      <div className="task-edit-row" style={{ justifyContent: 'space-between' }}>
        {onDelete ? (
          <button className="btn-link task-delete" onClick={onDelete}>
            <i className="ph-duotone ph-trash" aria-hidden="true" />
            Delete{!sub && data.tasks.some((t) => t.parent === task.id) ? ' with its subtasks' : ''}
          </button>
        ) : (
          <span />
        )}
        <button className="btn-link" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
