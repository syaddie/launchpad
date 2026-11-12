// Edits made while the server can't be reached (or isn't answering) wait here, in IndexedDB,
// and are sent in order once it answers again: on the next successful refresh, when the
// change stream reconnects, or when the browser comes back online. Whole documents carry the
// version they started from, so a replay is version-checked and merged like any other save.
// File uploads, the terminal and speed tests aren't queued.
import type { SavedDoc, Task } from '../../shared/types';
import { api, ConflictError, ServerError, TAB_ID } from './api';
import { kvGet, kvUpdate } from './idb';
import { addPending, mergeDoc, type Pending, type PendingCall, type PendingDoc } from './pending';

/** The server can't be reached or isn't answering: keep the edit and try again later. */
export const isOffline = (e: unknown) => e instanceof ServerError && (e.kind === 'unreachable' || e.kind === 'down');

const KEY = 'outbox';
/** The queue as this tab last read or wrote it. */
let items: Pending[] = [];
/** The item being sent right now: out of the stored queue, so another tab doesn't send it too. */
let inFlight: Pending | null = null;
/** IndexedDB isn't available: the queue lives in this tab only. */
let memoryOnly = false;
let flushing = false;

const listeners = new Set<() => void>();
const show = (list: Pending[]) => {
  items = list;
  for (const f of listeners) f();
};

export interface OutboxHandlers {
  /** Something was queued because the server couldn't be reached. */
  queued: () => void;
  /** Queued edits reached the server; the page should fetch the state. */
  sent: () => void;
  /** A queued edit was refused (not for being offline) and has been dropped. */
  dropped: (p: Pending, e: Error) => void;
  /** This tab's own document was saved from the queue: where its next save starts. */
  docSaved: (key: SavedDoc, value: unknown, version: string) => void;
  /** This tab's own document changed on another device before the queue sent it: save the page's copy, merged as usual. */
  docConflict: (key: SavedDoc) => void;
}
let handlers: OutboxHandlers = { queued: () => {}, sent: () => {}, dropped: () => {}, docSaved: () => {}, docConflict: () => {} };
export const setOutboxHandlers = (h: OutboxHandlers) => {
  handlers = h;
};

/** Change the stored queue in one transaction, so tabs queueing at once don't overwrite each other. */
async function change(fn: (list: Pending[]) => Pending[]): Promise<void> {
  if (!memoryOnly) {
    try {
      return show(await kvUpdate<Pending[]>(KEY, (v) => fn(v ?? [])));
    } catch {
      memoryOnly = true;
    }
  }
  show(fn(items));
}

/**
 * Read the queue before the first paint. Documents left by a page that has since closed are
 * taken over by this one: their edits are on screen here, so this page saves them.
 */
export async function loadOutbox(): Promise<void> {
  const read = (async () => {
    try {
      if ((await kvGet<Pending[]>(KEY))?.length) await change((l) => l.map((p) => (p.kind === 'doc' ? { ...p, tab: TAB_ID } : p)));
    } catch {
      memoryOnly = true;
    }
  })();
  await Promise.race([read, new Promise((r) => setTimeout(r, 1000))]);
}

/** Everything waiting, including what's being sent right now. */
export const pendingItems = (): Pending[] => (inFlight ? [inFlight, ...items] : items);
export const pendingCount = () => items.length + (inFlight ? 1 : 0);
export function subscribeOutbox(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

function queue(p: Pending): Promise<void> {
  return change((l) => addPending(l, p));
}

/** A whole-document save that couldn't reach the server: keep it to send later. */
export function queueDoc(key: SavedDoc, value: unknown, base: PendingDoc['base']): void {
  queue({ kind: 'doc', key, value, base, tab: TAB_ID }).then(() => handlers.queued());
}

/** This tab saved the document itself, so the copy it queued earlier is out of date. */
export function dropOwnDoc(key: SavedDoc): void {
  const own = (p: Pending) => p.kind === 'doc' && p.key === key && p.tab === TAB_ID;
  if (items.some(own)) change((l) => l.filter((p) => !own(p)));
}

/** Send one small save. `replay`: it's from the queue, so it carries the time it was made. */
function run(p: PendingCall, replay: boolean, keepalive = false): Promise<unknown> {
  switch (p.kind) {
    case 'addSmoke':
      return api.addSmoke(replay ? p.at : undefined);
    case 'removeSmoke':
      return api.removeSmoke(p.at);
    case 'mood':
      return api.putMood(p.date, p.mood ?? { level: 0 });
    case 'craving':
      return api.putCraving(p.value);
    case 'removeCraving':
      return api.deleteCraving(p.id);
    case 'weight':
      return api.putWeight(p.date, p.kg);
    case 'completeTask':
      return api.completeTask({ listId: p.listId, id: p.id } as Task, keepalive);
    case 'countdowns':
      return api.putCountdowns(p.value);
    case 'prefs':
      return api.putPrefs(p.value);
  }
}

/**
 * Send a small save, or queue it when the server can't be reached. Resolves to the server's
 * answer, or undefined when it was queued; rejects when the server refused it. While anything
 * is waiting, new saves join the end of the queue, so they reach the server in order.
 */
export async function send<T>(p: PendingCall, keepalive = false): Promise<T | undefined> {
  if (pendingCount()) {
    await queue(p);
    void flush();
    return undefined;
  }
  try {
    return (await run(p, false, keepalive)) as T;
  } catch (e) {
    if (!isOffline(e)) throw e;
    await queue(p);
    handlers.queued();
    return undefined;
  }
}

/** Save a queued document, merging into the server's copy if it changed meanwhile. */
async function sendDoc(p: PendingDoc): Promise<void> {
  let value = p.value;
  let base = p.base;
  for (let tries = 0; tries < 3; tries++) {
    try {
      const { version } = await api.putDoc(p.key, value as never, base.version ?? '');
      if (p.tab === TAB_ID) handlers.docSaved(p.key, value, version);
      return;
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
      // This page's copy has these edits and maybe more: let its own saver merge and save that.
      if (p.tab === TAB_ID) return handlers.docConflict(p.key);
      value = mergeDoc(p.key, base.value, value, e.value);
      base = { value: e.value, version: e.version };
    }
  }
  throw new Error('it kept changing on another device');
}

/** Take the first item off the stored queue, so no other tab sends it too. */
async function claim(): Promise<Pending | null> {
  let first: Pending | null = null;
  await change(([head, ...rest]) => {
    first = head ?? null;
    return rest;
  });
  return first;
}

/** Send everything waiting, in order; stops at the first edit the server still can't take. */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  let sent = 0;
  try {
    for (;;) {
      const p = await claim();
      if (!p) break;
      inFlight = p;
      show(items);
      try {
        if (p.kind === 'doc') await sendDoc(p);
        else await run(p, true);
        sent++;
      } catch (e) {
        // Unreachable, down or signed out of Access: put it back at the front and try again later.
        if (e instanceof ServerError) {
          await change((l) => l.reduce(addPending, [p]));
          break;
        }
        handlers.dropped(p, e as Error);
      } finally {
        inFlight = null;
        show(items);
      }
    }
  } finally {
    flushing = false;
  }
  if (sent) handlers.sent();
}
