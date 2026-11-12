// Add a Google Calendar event in plain words ("lunch w/ Dan fri 1pm"), from the Today panel
// or ⌘K. What was understood shows before it's saved; afterwards the toast links to the event.
import { useEffect, useRef, useState } from 'react';
import { addDays, parseEvent, parseYmd, ymd, type EventDraft } from '../../../shared/dates';
import type { AppState, CalendarInfo } from '../../../shared/types';
import { localGet, localSet } from '../api';
import { fmtDay, hm } from '../util';

/** What the server takes: all day as YYYY-MM-DD with the end the day after, timed as ISO date-times. */
export function eventPayload(d: EventDraft): { allDay: boolean; start: string; end: string } {
  const day = parseYmd(d.date);
  if (d.allDay) return { allDay: true, start: d.date, end: ymd(addDays(day, 1)) };
  const at = (m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m).toISOString();
  return { allDay: false, start: at(d.start), end: at(d.end) };
}

/** "Fri 13 Nov · 13:00–14:00" or "Sat 14 Nov · all day". */
export function describeDraft(d: EventDraft): string {
  const day = parseYmd(d.date);
  if (d.allDay) return `${fmtDay(day)} · all day`;
  const at = (m: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, m);
  return `${fmtDay(day)} · ${hm(at(d.start))}–${hm(at(d.end))}${d.end > 1440 ? ' next day' : ''}`;
}

/** Calendars you can add to, yours first. */
export const writableCalendars = (data: AppState): CalendarInfo[] => data.calendars.filter((c) => c.writable !== false);

/** The calendar new events go to: the last one picked here, else the first (your own). */
export function defaultCalendar(data: AppState): CalendarInfo | undefined {
  const cals = writableCalendars(data);
  return cals.find((c) => c.id === localGet('eventCalendar')) ?? cals[0];
}

export const canAddEvents = (data: AppState) => !data.google.missingScopes?.includes('calendar.events');

interface Props {
  data: AppState;
  now: Date;
  /** Bumped by ⌘K's "Add a calendar event" to put the cursor here. */
  focusSignal: number;
  onAdd: (calendarId: string, d: EventDraft) => Promise<boolean>;
  onConnect: () => void;
}

export function AddEvent({ data, now, focusSignal, onAdd, onConnect }: Props) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [calId, setCalId] = useState(() => defaultCalendar(data)?.id ?? '');
  const input = useRef<HTMLInputElement>(null);
  const cals = writableCalendars(data);
  const cal = cals.find((c) => c.id === calId) ?? cals[0];

  useEffect(() => {
    if (!focusSignal) return;
    // After ⌘K has closed and handed focus back.
    const t = window.setTimeout(() => {
      input.current?.scrollIntoView({ block: 'nearest' });
      input.current?.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [focusSignal]);

  if (!canAddEvents(data)) {
    return (
      <div className="ev-add ev-reconnect">
        <i className="ph-duotone ph-calendar-plus" aria-hidden="true" />
        <span>Reconnect Google to allow adding events.</span>
        <button className="btn-link" onClick={onConnect}>
          Reconnect Google
        </button>
      </div>
    );
  }
  if (!cals.length) return null;

  const draft = text.trim() ? parseEvent(text, now) : null;

  const pick = (id: string) => {
    setCalId(id);
    localSet('eventCalendar', id);
  };

  const submit = async () => {
    if (!draft?.title || !cal || busy) return;
    setBusy(true);
    const ok = await onAdd(cal.id, draft);
    setBusy(false);
    if (ok) setText('');
  };

  return (
    <div className="ev-add-wrap">
      <div className="task-add ev-add">
        <i className="ph-duotone ph-calendar-plus" style={{ fontSize: 16, color: 'var(--t3)', width: 16 }} />
        <input
          ref={input}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setText('');
          }}
          placeholder="Add an event… try “lunch w/ Dan fri 1pm”"
          aria-label="Add a calendar event"
          disabled={busy}
        />
      </div>
      {draft && (
        <div className="ev-draft" aria-live="polite">
          <span className="dot" style={{ width: 8, height: 8, background: cal?.color || 'var(--t3)' }} />
          <span className="ev-draft-what">
            <b>{draft.title || 'Untitled'}</b>
            <span>{describeDraft(draft)}</span>
          </span>
          {cals.length > 1 && (
            <select className="ln-mini-select" value={cal?.id} onChange={(e) => pick(e.target.value)} aria-label="Calendar">
              {cals.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button className="btn btn-secondary btn-small" disabled={!draft.title || busy} onClick={submit}>
            {busy ? 'Adding…' : 'Add'}
          </button>
        </div>
      )}
    </div>
  );
}
