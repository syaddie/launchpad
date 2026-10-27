import { useEffect, useRef, useState } from 'react';
import { dayDiff, parseDue, parseYmd, startOfDay } from '../../../shared/dates';
import type { AppState, Task } from '../../../shared/types';
import { fmtDay, shortDay } from '../util';

interface Props {
  data: AppState;
  now: Date;
  onConnect: () => void;
  onAdd: (listId: string, title: string, due: string | null) => void;
  /** Called once the 5-second undo window has passed. */
  onComplete: (t: Task, keepalive?: boolean) => void;
}

const UNDO_MS = 5000;

export function Tasks({ data, now, onConnect, onAdd, onComplete }: Props) {
  const [list, setList] = useState('All');
  const [text, setText] = useState('');
  const [undo, setUndo] = useState<Task | null>(null);
  const timer = useRef(0);
  const pending = useRef<Task | null>(null);

  const finalize = (keepalive = false) => {
    clearTimeout(timer.current);
    if (pending.current) onComplete(pending.current, keepalive);
    pending.current = null;
    setUndo(null);
  };

  // Don't lose a completion if the tab closes during the undo window.
  useEffect(() => {
    const h = () => finalize(true);
    window.addEventListener('pagehide', h);
    return () => window.removeEventListener('pagehide', h);
  });

  const complete = (t: Task) => {
    if (undo?.id === t.id) {
      undoNow();
      return;
    }
    finalize(); // completing another task finalises the previous one
    pending.current = t;
    setUndo(t);
    timer.current = window.setTimeout(() => finalize(), UNDO_MS);
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
  const vis = data.tasks.filter((t) => currentList === 'All' || listName(t.listId) === currentList);
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
                {g.items.map((t) => {
                  const done = undo?.id === t.id;
                  const o = off(t);
                  const due = o == null || o === 0 ? '' : o < 0 ? fmtDay(parseYmd(t.due!)) : shortDay(parseYmd(t.due!), today);
                  return (
                    <div key={t.id} className="task" style={{ opacity: done ? 0.45 : 1 }}>
                      <button className={'check' + (done ? ' on' : '')} aria-label={done ? 'Undo' : 'Complete'} onClick={() => complete(t)}>
                        {done && <i className="ph-duotone ph-check" />}
                      </button>
                      <span className="task-title" style={{ textDecoration: done ? 'line-through' : 'none' }}>
                        {t.title}
                      </span>
                      <span className="task-due" style={{ color: o != null && o < 0 ? 'var(--wn)' : 'var(--t3)' }}>
                        {due}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
            {!groups.length && <div style={{ padding: '5px 10px', fontSize: 13, color: 'var(--t3)' }}>Nothing here. Enjoy it.</div>}
          </div>
          {undo && (
            <div className="undo">
              <span style={{ flex: 1, minWidth: 0, color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Completed “{undo.title}”
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
