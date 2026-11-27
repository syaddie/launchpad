// Saves going up (docs/mission-layout.md, idea 21): every save the server takes is noted here by the API layer
// (api.ts, `req`), with the source light it belongs to, so Mission's strip can blink that light once, like a packet
// going up. A save to a synced source (an event added to the calendar, an email archived, a lesson starred) is that
// source's; everything kept in Launchpad's own store (notes, money, Learn, the trackers, settings…) is Launchpad's.
// Reads, refreshes, syncs, Claude's answers and actions on the server (a restart, a download, a file) aren't saves.

import type { SourceKey } from '../../shared/types';

/** The light a save blinks: a synced source's, or Launchpad's own (its store). */
export type UplinkKey = Extract<SourceKey, 'calendar' | 'inbox' | 'digest'> | 'launchpad';

/** Which save requests go to which light: [method, path] patterns, first match wins. */
const ROUTES: [RegExp, RegExp, UplinkKey][] = [
  [/^POST$/, /^\/api\/calendar\/events$/, 'calendar'],
  [/^POST$/, /^\/api\/inbox\/modify$/, 'inbox'],
  [/^DELETE$/, /^\/api\/bills\/[^/]+$/, 'inbox'],
  [/^PATCH$/, /^\/api\/digest\/cards\/[^/]+$/, 'digest'],
  [/^POST$/, /^\/api\/digest\/recall$/, 'digest'],
  [/^(POST|PATCH|DELETE)$/, /^\/api\/news\/saved(\/[^/]+)?$/, 'digest'],
  [/^PUT$/, /^\/api\/(notes|money|learn|bookmarks|prefs|countdowns|training)$/, 'launchpad'],
  [/^(POST|DELETE)$/, /^\/api\/smokes$/, 'launchpad'],
  [/^PUT$/, /^\/api\/(weights|moods)\/[^/]+$/, 'launchpad'],
  [/^(PUT|DELETE)$/, /^\/api\/cravings\/[^/]+$/, 'launchpad'],
  [/^(POST|PUT)$/, /^\/api\/photos$/, 'launchpad'],
  [/^DELETE$/, /^\/api\/photos\/[^/]+$/, 'launchpad'],
  [/^POST$/, /^\/api\/note-images$/, 'launchpad'],
  [/^POST$/, /^\/api\/notes\/[^/]+\/history$/, 'launchpad'],
  [/^(POST|PUT|DELETE)$/, /^\/api\/shell\/snippets(\/[^/]+)?$/, 'launchpad'],
  [/^(POST|PUT|DELETE)$/, /^\/api\/minecraft\/servers(\/[^/]+)?$/, 'launchpad'],
  [/^(POST|PUT)$/, /^\/api\/nac\/places$/, 'launchpad'],
  [/^(POST|DELETE)$/, /^\/api\/nac\/watches(\/[^/]+)?$/, 'launchpad'],
  [/^PUT$/, /^\/api\/alerts$/, 'launchpad'],
];

/** The light a request blinks once the server has taken it, or null when it isn't a save. */
export function uplinkOf(method: string, url: string): UplinkKey | null {
  const path = url.split(/[?#]/)[0];
  const m = method.toUpperCase();
  for (const [mm, pp, key] of ROUTES) if (mm.test(m) && pp.test(path)) return key;
  return null;
}

type Listener = (key: UplinkKey) => void;
const listeners = new Set<Listener>();
let lastAt: number | null = null;

/** The server took a request: if it was a save, tell whoever is listening which light it was for. */
export function noteSent(method: string, url: string): void {
  const key = uplinkOf(method, url);
  if (!key) return;
  lastAt = Date.now();
  for (const f of listeners) f(key);
}

/** When the server last took a save from this page (ms), or null when it hasn't yet. */
export const lastSaved = () => lastAt;

export function onUplink(f: Listener): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}
