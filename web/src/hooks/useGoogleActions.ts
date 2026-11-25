// Writing to Google from the page: adding calendar events, archiving and marking emails
// read, and keeping bills found in Gmail. Each changes the page's copy at once and puts it back if Google refuses.
import { useRef } from 'react';
import type { EventDraft } from '../../../shared/dates';
import type { AppState, BillSuggestion, CalEvent, InboxEmail, Money } from '../../../shared/types';
import { api } from '../api';
import { eventPayload } from '../components/AddEvent';
import { withBill } from '../inboxActions';
import { newId } from '../util';
import type { Notify } from './useToast';

export type InboxAction = 'archive' | 'read';

const byStart = (a: CalEvent, b: CalEvent) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0);

export function useGoogleActions({ data, update, refresh, notify, setMoney }: {
  data: AppState;
  update: (fn: (d: AppState) => AppState) => void;
  refresh: () => void;
  notify: Notify;
  setMoney: (m: Money) => void;
}) {
  /** For an undo that runs after more edits. */
  const latest = useRef(data);
  latest.current = data;
  const failed = (what: string) => (e: Error) => {
    notify(`Couldn’t ${what}: ${e.message}`);
    refresh();
  };

  const addEvent = async (calendarId: string, d: EventDraft): Promise<boolean> => {
    try {
      const ev = await api.addEvent({ calendarId, title: d.title, ...eventPayload(d) });
      update((s) => ({ ...s, events: [...s.events.filter((x) => x.id !== ev.id), ev].sort(byStart) }));
      const cal = data.calendars.find((c) => c.id === calendarId)?.name || 'your calendar';
      notify(`Added “${ev.title}” to ${cal}`, ev.htmlLink ? { label: 'Edit in Google Calendar', run: () => window.open(ev.htmlLink, '_blank', 'noopener') } : undefined);
      return true;
    } catch (e) {
      notify(`Couldn’t add the event: ${(e as Error).message}`);
      return false;
    }
  };

  /** Archive or mark read now, with Undo in the toast. */
  const inboxAction = (emails: InboxEmail[], action: InboxAction) => {
    const ids = emails.filter((e) => (action === 'read' ? e.unread : !e.archived)).map((e) => e.id);
    if (!ids.length) return;
    const set = new Set(ids);
    const mark = (back: boolean) =>
      update((d) => ({
        ...d,
        inbox: { ...d.inbox, emails: d.inbox.emails.map((e) => (!set.has(e.id) ? e : action === 'read' ? { ...e, unread: back } : { ...e, archived: back ? undefined : true })) },
      }));
    const undoAction = action === 'read' ? 'unread' : 'unarchive';
    mark(false);
    const n = ids.length === 1 ? 'the email' : `${ids.length} emails`;
    api
      .modifyInbox(ids, action)
      .then(() =>
        notify(action === 'read' ? `Marked ${n} read` : `Archived ${n}`, {
          label: 'Undo',
          run: () => {
            mark(true);
            api.modifyInbox(ids, undoAction).catch(failed('undo that'));
          },
        }),
      )
      .catch((e: Error) => {
        mark(true);
        notify(`Couldn’t ${action === 'read' ? 'mark it read' : 'archive it'}: ${e.message}`);
      });
  };

  const dropBill = (b: BillSuggestion) => {
    update((d) => ({ ...d, bills: (d.bills ?? []).filter((x) => x.id !== b.id) }));
    api.dropBill(b.id).catch(failed('save that'));
  };

  /** Keep: into Money through the usual save, then off the list. */
  const keepBill = (b: BillSuggestion) => {
    const id = newId('e');
    setMoney(withBill(data.money, b, id));
    dropBill(b);
    notify(`Added ${b.payee} to Money`, {
      label: 'Undo',
      run: () => {
        const m = latest.current.money;
        setMoney({ ...m, entries: m.entries.filter((e) => e.id !== id) });
      },
    });
  };

  return { addEvent, inboxAction, keepBill, dismissBill: dropBill };
}
