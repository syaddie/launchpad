// Tells open tabs when something they show has changed, so a second tab, a phone, or
// a sync that just finished shows up straight away rather than at the next poll.
// The message only names what changed; tabs fetch /api/state themselves.
import type { Context } from 'hono';
import { streamSSE, type SSEStreamingApi } from 'hono/streaming';
import { changes } from './store';

/** Store keys that aren't in the page's state, or change without anything on screen changing. */
const QUIET = new Set(['gmailSeen', 'registered17', 'speedTests', 'uploadDirs', 'google']);

/** Writes are gathered for this long, so a sync's data and its status arrive as one message. */
const GATHER = 300;
/** Cloudflare drops a response that's silent for 100 s. */
const HEARTBEAT = 25_000;

interface Client { tab: string; stream: SSEStreamingApi }

const clients = new Set<Client>();
/** Changed keys, each with the tabs that wrote it ('' for the server itself). */
const pending = new Map<string, Set<string>>();
let timer: NodeJS.Timeout | undefined;

changes.on('change', (key, tab) => {
  if (QUIET.has(key) || !clients.size) return;
  const by = pending.get(key) ?? new Set<string>();
  by.add(tab ?? '');
  pending.set(key, by);
  timer ??= setTimeout(flush, GATHER);
});

/** The keys a tab should hear about: those written by anyone but itself. */
export function keysFor(tab: string, changed: Map<string, Set<string>>): string[] {
  return [...changed].filter(([, by]) => [...by].some((t) => !t || t !== tab)).map(([k]) => k);
}

function flush() {
  timer = undefined;
  const changed = new Map(pending);
  pending.clear();
  for (const c of clients) {
    const keys = keysFor(c.tab, changed);
    if (keys.length) c.stream.writeSSE({ event: 'change', data: JSON.stringify({ keys }) }).catch(() => {});
  }
}

const cleanTab = (v: string | undefined) => (v && /^[A-Za-z0-9-]{4,64}$/.test(v) ? v : '');

export function eventStream(c: Context) {
  c.header('X-Accel-Buffering', 'no');
  return streamSSE(c, async (stream) => {
    const client: Client = { tab: cleanTab(c.req.query('tab')), stream };
    clients.add(client);
    // A short retry, so a restart or deploy reconnects quickly.
    await stream.writeSSE({ event: 'hello', data: '{}', retry: 3000 });
    const beat = setInterval(() => stream.write(': ping\n\n').catch(() => {}), HEARTBEAT);
    await new Promise<void>((resolve) => stream.onAbort(resolve));
    clearInterval(beat);
    clients.delete(client);
  });
}

/** The tab id a page sends with its writes. */
export const tabOf = (header: string | undefined) => cleanTab(header) || undefined;
