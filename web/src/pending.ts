// Edits made while the server couldn't be reached, waiting to be sent (see outbox.ts).
// These helpers are pure: how a new edit joins the queue, and how the queued edits are
// laid over a fresh copy of the state so the page keeps showing them until they're saved.
import { merge3, mergeNotes } from '../../shared/merge';
import type { AppState, Countdown, Mood, Note, Prefs, SavedDoc } from '../../shared/types';

/** A small save, replayed as the same request. */
export type PendingCall =
  | { kind: 'addSmoke'; at: string }
  | { kind: 'removeSmoke'; at: string }
  | { kind: 'mood'; date: string; mood: Mood | null }
  | { kind: 'weight'; date: string; kg: number | null }
  | { kind: 'completeTask'; listId: string; id: string }
  | { kind: 'countdowns'; value: Countdown[] }
  | { kind: 'prefs'; value: Prefs };

/**
 * A whole document (bookmarks, notes, money, Learn), with the server's copy its edits started
 * from, so it's saved with the usual version check and merged if the server's has moved on.
 */
export type PendingDoc = { kind: 'doc'; key: SavedDoc; value: unknown; base: { value: unknown; version?: string }; tab: string };

export type Pending = PendingCall | PendingDoc;

/** Merge `mine` into `theirs`, both edits of `base`, the way a save that crossed another device's is merged. */
export function mergeDoc(key: SavedDoc, base: unknown, mine: unknown, theirs: unknown): unknown {
  return key === 'notes' ? mergeNotes(base as Note[], mine as Note[], theirs as Note[]).value : merge3(base, mine, theirs).value;
}

/**
 * The queue with `item` added. Saves that set the same thing replace the one already waiting
 * (a day's mood, the countdowns, a document); a document edited in another tab is merged
 * with it. Cigarettes and ticked-off tasks are each their own entry, in order.
 */
export function addPending(list: Pending[], item: Pending): Pending[] {
  const same = (p: Pending): boolean => {
    switch (item.kind) {
      case 'doc':
        return p.kind === 'doc' && p.key === item.key;
      case 'mood':
      case 'weight':
        return p.kind === item.kind && p.date === item.date;
      case 'countdowns':
      case 'prefs':
        return p.kind === item.kind;
      case 'completeTask':
        return p.kind === 'completeTask' && p.id === item.id && p.listId === item.listId;
      default:
        return false;
    }
  };
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const old = list[i];
  let next = item;
  if (item.kind === 'doc' && old.kind === 'doc') {
    // The first edit's starting point is still the one the server's copy is compared with.
    next = { ...item, base: old.base, value: old.tab === item.tab ? item.value : mergeDoc(item.key, old.base.value, item.value, old.value) };
  }
  return list.map((p, j) => (j === i ? next : p));
}

/** Within two minutes, like the server's undo, since the server logged its own time for it. */
const SMOKE_SLACK = 120_000;

/**
 * `s` (the whole state, or the parts of it just fetched) with the queued saves done to it, as
 * they will be once they reach the server. Only the parts in `s` are touched, so a part already
 * showing them doesn't get them twice.
 */
export function applyPending<S extends Partial<AppState>>(s: S, list: Pending[]): S {
  let out: Partial<AppState> = s;
  for (const p of list) {
    switch (p.kind) {
      case 'addSmoke':
        if (out.smokes && !out.smokes.includes(p.at)) out = { ...out, smokes: [...out.smokes, p.at].sort() };
        break;
      case 'removeSmoke': {
        const smokes = out.smokes;
        if (!smokes) break;
        let i = smokes.lastIndexOf(p.at);
        if (i < 0) {
          const near = (x: string) => Math.abs(Date.parse(x) - Date.parse(p.at));
          i = smokes.reduce((b, x, j) => (near(x) < SMOKE_SLACK && (b < 0 || near(x) < near(smokes[b])) ? j : b), -1);
        }
        if (i >= 0) out = { ...out, smokes: [...smokes.slice(0, i), ...smokes.slice(i + 1)] };
        break;
      }
      case 'mood': {
        if (!out.moods) break;
        const moods = { ...out.moods };
        if (p.mood) moods[p.date] = p.mood;
        else delete moods[p.date];
        out = { ...out, moods };
        break;
      }
      case 'weight': {
        if (!out.weights) break;
        const weights = { ...out.weights };
        if (p.kg === null) delete weights[p.date];
        else weights[p.date] = p.kg;
        out = { ...out, weights };
        break;
      }
      case 'completeTask':
        if (out.tasks) out = { ...out, tasks: out.tasks.filter((t) => t.id !== p.id) };
        break;
      case 'countdowns':
        if (out.countdowns) out = { ...out, countdowns: p.value };
        break;
      case 'prefs':
        if (out.prefs) out = { ...out, prefs: p.value };
        break;
      case 'doc':
        if (out[p.key]) out = { ...out, [p.key]: p.value };
        break;
    }
  }
  return out as S;
}

/** Documents waiting to be saved, by key. */
export const pendingDocs = (list: Pending[]) => new Map(list.filter((p): p is PendingDoc => p.kind === 'doc').map((p) => [p.key, p]));
