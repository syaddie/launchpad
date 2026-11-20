// Phone alerts through ntfy (ntfy.sh, or one you host): a POST to a topic's address, which
// the ntfy app on the phone subscribes to. Settings › Alerts is the only place it's set up.
// The watcher (alerts.ts) sends one when a problem starts and one when it clears; other parts
// of Launchpad call notify() for one-off events, like a Minecraft server crashing. Caps keep a
// problem that comes and goes from flooding the phone. Messages say what's wrong in Launchpad's
// own words: no error text, tokens or file contents.
import { blockedIp, checkUrl, fetchFailure, FetchError, USER_AGENT } from './outbound';
import { store } from './store';
import { DEFAULT_PREFS } from '../../shared/defaults';
import { ALERT_KINDS, type AlertKind, type AlertRecord, type AlertsInfo } from '../../shared/types';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** At most this many alerts about one thing in KEY_WINDOW: started, cleared, started, cleared, then one "paused". */
export const KEY_MAX = 4;
export const KEY_WINDOW = 6 * HOUR;
/** At most this many alerts in all in ALL_WINDOW. */
export const ALL_MAX = 15;
export const ALL_WINDOW = HOUR;
/** The same event (key and title) again within this is dropped. */
export const REPEAT_AFTER = 10 * MIN;
/** After a send fails, wait this long before trying again. */
export const RETRY_AFTER = 5 * MIN;
const RECENT = 20;

/** One message for the phone. */
export interface Outgoing {
  key: string;
  kind: AlertKind;
  type: 'problem' | 'fixed' | 'event';
  title: string;
  body?: string;
  /** An https address the phone opens when the alert is tapped. */
  click?: string;
}

/** What the phone has been told, kept in the store so a restart doesn't repeat it. */
export interface AlertMemory {
  /** Problems the phone was told started and hasn't heard cleared, by key, with what to say when they do. */
  open: Record<string, { kind: AlertKind; title: string; clear: string; at: string }>;
  /** Alerts sent lately (ms since 1970), for the caps. */
  sent: { at: number; key: string }[];
  /** When a "paused" note last went out, by key, or '*' for the cap on all of them. */
  paused: Record<string, number>;
  /** Newest first. */
  recent: AlertRecord[];
  lastError: { at: string; message: string } | null;
  /** What the container watch remembers between checks (alerts.ts). */
  containers: { running: string[]; restarts: Record<string, number[]> };
}

export const emptyMemory = (): AlertMemory => ({ open: {}, sent: [], paused: {}, recent: [], lastError: null, containers: { running: [], restarts: {} } });

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isKind = (v: unknown): v is AlertKind => ALERT_KINDS.includes(v as AlertKind);
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** The stored memory, field by field; anything unreadable starts empty. */
export function cleanMemory(v: unknown): AlertMemory {
  const m = emptyMemory();
  if (!isObj(v)) return m;
  if (isObj(v.open)) {
    for (const [k, o] of Object.entries(v.open)) {
      if (isObj(o) && isKind(o.kind) && typeof o.title === 'string' && typeof o.clear === 'string' && isIso(o.at)) m.open[k] = { kind: o.kind, title: o.title, clear: o.clear, at: o.at };
    }
  }
  if (Array.isArray(v.sent)) m.sent = v.sent.filter((s) => isObj(s) && isTime(s.at) && typeof s.key === 'string').map((s) => ({ at: s.at, key: s.key }));
  if (isObj(v.paused)) for (const [k, t] of Object.entries(v.paused)) if (isTime(t)) m.paused[k] = t;
  if (Array.isArray(v.recent)) {
    const types = ['problem', 'fixed', 'paused', 'event', 'test'];
    m.recent = v.recent
      .filter((r) => isObj(r) && isIso(r.at) && (isKind(r.kind) || r.kind === 'test') && types.includes(r.type) && typeof r.title === 'string')
      .map((r) => ({ at: r.at, kind: r.kind, type: r.type, title: r.title }))
      .slice(0, RECENT);
  }
  if (isObj(v.lastError) && isIso(v.lastError.at) && typeof v.lastError.message === 'string') m.lastError = { at: v.lastError.at, message: v.lastError.message };
  if (isObj(v.containers)) {
    if (Array.isArray(v.containers.running)) m.containers.running = v.containers.running.filter((n: unknown): n is string => typeof n === 'string');
    if (isObj(v.containers.restarts)) {
      for (const [k, list] of Object.entries(v.containers.restarts)) if (Array.isArray(list)) m.containers.restarts[k] = list.filter(isTime);
    }
  }
  return m;
}

/** Drop what's too old to count towards a cap. */
export function prune(m: AlertMemory, now: number): void {
  const keep = Math.max(KEY_WINDOW, ALL_WINDOW);
  m.sent = m.sent.filter((s) => now - s.at < keep);
  for (const [k, t] of Object.entries(m.paused)) if (now - t >= keep) delete m.paused[k];
}

const hoursLeft = (ms: number) => Math.max(1, Math.ceil(ms / HOUR));
const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / MIN));

/**
 * Whether this alert may go now. When a cap holds it back, `notice` is the one "paused" note
 * to send instead (null when that note has already gone this time round).
 */
export function gate(m: AlertMemory, o: Outgoing, now: number): { ok: true } | { ok: false; notice: (Outgoing & { pauseKey: string }) | null } {
  const all = m.sent.filter((s) => now - s.at < ALL_WINDOW);
  if (all.length >= ALL_MAX) {
    const resume = all[0].at + ALL_WINDOW - now;
    const told = m.paused['*'] !== undefined && now - m.paused['*'] < ALL_WINDOW;
    return {
      ok: false,
      notice: told ? null : {
        pauseKey: '*',
        key: '*',
        kind: o.kind,
        type: 'event',
        title: 'Too many alerts at once',
        body: `That’s ${ALL_MAX} in the last hour, so the rest wait about ${minutesLeft(resume)} min. Launchpad’s Server view shows what’s wrong now.`,
      },
    };
  }
  const mine = m.sent.filter((s) => s.key === o.key && now - s.at < KEY_WINDOW);
  if (mine.length >= KEY_MAX) {
    const resume = mine[0].at + KEY_WINDOW - now;
    const told = m.paused[o.key] !== undefined && now - m.paused[o.key] < KEY_WINDOW;
    return {
      ok: false,
      notice: told ? null : {
        pauseKey: o.key,
        key: o.key,
        kind: o.kind,
        type: 'event',
        title: `Pausing alerts: ${o.title}`,
        body: `It keeps coming and going: ${KEY_MAX} alerts about it in ${KEY_WINDOW / HOUR} hours. The next one waits about ${hoursLeft(resume)} h. Launchpad shows how it is now.`,
      },
    };
  }
  return { ok: true };
}

/** A long run that's a key, token or id: all hex (ids, hashes), or upper case, lower case and digits mixed. A long container name is neither. */
const secretLike = (run: string) => /^[0-9a-f]+$/i.test(run) || (/[A-Z]/.test(run) && /[a-z]/.test(run) && /\d/.test(run));

/**
 * Text made safe to send: web addresses keep only their host and path, and anything that looks
 * like a key, token or id (a run of 32 or more that secretLike says is one) is cut out. Capped at `max`.
 */
export function scrub(text: string, max: number): string {
  const out = text
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (u) => {
      try {
        const url = new URL(u);
        return `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`;
      } catch {
        return '[address]';
      }
    })
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, (run) => (secretLike(run) ? '…' : run))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .trim();
  return out.length > max ? out.slice(0, max - 1).trimEnd() + '…' : out;
}

/** A header value ntfy reads as UTF-8 whatever's in it (RFC 2047), so titles keep their ’ and ·. */
export const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

const TAGS: Record<AlertRecord['type'], string> = { problem: 'warning', fixed: 'white_check_mark', paused: 'no_bell', event: 'rotating_light', test: 'bell' };

export interface Message {
  title: string;
  body: string;
  type: AlertRecord['type'];
  /** An https address the phone opens when it's tapped (ntfy's Click); anything else is left out. */
  click?: string;
}

/** `click` when it's a plain https address, for ntfy's Click header. */
export const clickUrl = (click: string | undefined) => (click && /^https:\/\/[^\s"'<>]+$/.test(click) && click.length <= 500 ? click : null);

/**
 * Post one message to an ntfy topic. Goes through the same checks as every address Launchpad
 * fetches (outbound.ts): http(s) only, never the server itself, redirects checked too.
 */
export async function publish(topicUrl: string, msg: Message): Promise<void> {
  let url = await checkUrl(topicUrl);
  const signal = AbortSignal.timeout(15_000);
  for (let hop = 0; ; hop++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'text/plain; charset=utf-8',
          Title: encodeHeader(scrub(msg.title, 200)),
          Priority: msg.type === 'problem' || msg.type === 'event' ? '4' : '3',
          Tags: TAGS[msg.type],
          ...(clickUrl(msg.click) ? { Click: clickUrl(msg.click)! } : {}),
        },
        body: scrub(msg.body, 1000) || scrub(msg.title, 200),
      });
    } catch (e) {
      throw fetchFailure(e);
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) {
      res.body?.cancel().catch(() => {});
      if (hop >= 3) throw new FetchError('other', 'Too many redirects.');
      url = await checkUrl(new URL(loc, url).href);
      continue;
    }
    if (res.ok) {
      res.body?.cancel().catch(() => {});
      return;
    }
    let said = '';
    try {
      said = String((JSON.parse((await res.text()).slice(0, 2000)) as { error?: unknown }).error ?? '');
    } catch {
      // Not ntfy's JSON.
    }
    if (res.status === 429) throw new FetchError('status', 'ntfy says too many messages for now. It’ll take more later.', 429);
    if (res.status === 401 || res.status === 403) throw new FetchError('status', 'ntfy refused it: that topic needs a login, or someone else has reserved it.', res.status);
    if (res.status === 404) throw new FetchError('status', 'There’s no ntfy server at that address.', 404);
    throw new FetchError('status', `ntfy answered ${res.status}${said ? `: ${scrub(said, 120)}` : ''}.`, res.status);
  }
}

/**
 * A topic address as it's saved: '' (off), or an http(s) address whose last part is the topic.
 * "ntfy.sh/topic", as the ntfy app shows it, gets https:// in front. Throws with what's wrong.
 */
export function cleanTopicUrl(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('That isn’t a web address.');
  let s = raw.trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = 'https://' + s;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    throw new Error('That isn’t a web address. It looks like https://ntfy.sh/your-topic.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https addresses work.');
  if (url.username || url.password) throw new Error('Addresses with a login in them aren’t supported.');
  if (s.length > 300) throw new Error('That address is too long.');
  // Never works (publish checks again, names included): said now rather than at the first send.
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$/i.test(host) || blockedIp(host)) throw new Error('That’s Launchpad’s own server, which it doesn’t send to. Use the ntfy server’s network address.');
  const topic = url.pathname.split('/').filter(Boolean).pop() ?? '';
  // ntfy's own rule for topic names.
  if (!/^[-_A-Za-z0-9]{1,64}$/.test(topic)) throw new Error('The address needs a topic at the end, like https://ntfy.sh/your-topic. Topics are letters, digits, - and _.');
  url.hash = '';
  return url.href;
}

// ---------- state ----------

let mem: AlertMemory | null = null;
let retryAt = 0;
/** The last event sent about each key, for dropping repeats. */
const lastEvents = new Map<string, { title: string; at: number }>();
let lastTopic = '';
let lastKinds: Record<AlertKind, boolean> = DEFAULT_PREFS.alerts;

/** The memory, read from the store the first time. Kept here too, so alerts still go when the database can't be read. */
export function memory(): AlertMemory {
  if (!mem) {
    try {
      mem = cleanMemory(store.alertMemory());
    } catch {
      mem = emptyMemory();
    }
  }
  return mem;
}

export function saveMemory(): void {
  try {
    store.setAlertMemory(memory());
  } catch (e) {
    console.error('[alerts] couldn’t save what was sent:', (e as Error).message);
  }
}

/** Where alerts go, or '' when they're off. The last one read is kept for when the database can't be read. */
export function topicUrl(): string {
  try {
    lastTopic = store.alertTopic();
  } catch {
    // Use the last one read.
  }
  return lastTopic;
}

/**
 * Save where alerts go. A new topic hasn't heard about anything yet, so problems going on now
 * are sent to it on the next checks, and the last failure (to the old one) is forgotten.
 */
export function setTopicUrl(raw: unknown): string {
  const url = cleanTopicUrl(raw);
  const changed = url !== topicUrl();
  store.setAlertTopic(url);
  lastTopic = url;
  retryAt = 0;
  if (changed) {
    const m = memory();
    m.open = {};
    m.lastError = null;
    saveMemory();
  }
  return url;
}

/** Whether alerts of this kind are switched on in Settings › Alerts. */
export function kindOn(kind: AlertKind): boolean {
  try {
    lastKinds = { ...DEFAULT_PREFS.alerts, ...store.prefs().alerts };
  } catch {
    // Use the last ones read.
  }
  return lastKinds[kind] !== false;
}

function record(m: AlertMemory, r: Omit<AlertRecord, 'at'>, now: number): void {
  m.recent = [{ at: new Date(now).toISOString(), ...r, title: scrub(r.title, 200) }, ...m.recent].slice(0, RECENT);
}

// One send at a time, so two can't both slip under a cap.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
}

export type Delivered = 'sent' | 'capped' | 'failed' | 'waiting' | 'no-topic';

/**
 * Send one alert, within the caps. `onSent` runs once it's gone (and before anything else is
 * sent), to note what the phone now knows. 'waiting' means a recent send failed, so a problem
 * waits a few minutes for the watcher's next try rather than trying again at once. A one-off
 * event has no next try, so it always gets its go.
 */
export function deliver(o: Outgoing, onSent?: (m: AlertMemory) => void): Promise<Delivered> {
  return serial(async () => {
    const url = topicUrl();
    if (!url) return 'no-topic';
    const now = Date.now();
    if (now < retryAt && o.type !== 'event') return 'waiting';
    const m = memory();
    prune(m, now);
    const g = gate(m, o, now);
    if (!g.ok) {
      if (g.notice) {
        try {
          await publish(url, { ...g.notice, body: g.notice.body ?? '', type: 'paused' });
          m.paused[g.notice.pauseKey] = now;
          record(m, { kind: o.kind, type: 'paused', title: g.notice.title }, now);
          saveMemory();
        } catch (e) {
          failed(m, e, now);
          return 'failed';
        }
      }
      return 'capped';
    }
    try {
      await publish(url, { title: o.title, body: o.body ?? '', type: o.type, click: o.click });
    } catch (e) {
      failed(m, e, now);
      return 'failed';
    }
    m.sent.push({ at: now, key: o.key });
    m.lastError = null;
    record(m, { kind: o.kind, type: o.type, title: o.title }, now);
    onSent?.(m);
    saveMemory();
    console.log(`[alerts] sent: ${scrub(o.title, 200)}`);
    return 'sent';
  });
}

function failed(m: AlertMemory, e: unknown, now: number): void {
  const message = e instanceof Error ? e.message : String(e);
  retryAt = now + RETRY_AFTER;
  m.lastError = { at: new Date(now).toISOString(), message };
  saveMemory();
  console.error(`[alerts] couldn’t send: ${message}`);
}

export type NotifyResult = 'sent' | 'off' | 'no-topic' | 'repeat' | 'capped' | 'failed' | 'waiting';

/**
 * Tell the owner's phone about something that happened, like a Minecraft server crashing.
 * `key` names the thing it's about (e.g. "minecraft:<server id>"): the same key and title
 * again within 10 minutes is dropped, and the caps count per key. Nothing is sent while
 * alerts of this kind are off or no topic is set. Never throws.
 */
export async function notify(a: { kind: AlertKind; key: string; title: string; body?: string; click?: string }): Promise<NotifyResult> {
  try {
    if (!kindOn(a.kind)) return 'off';
    if (!topicUrl()) return 'no-topic';
    const now = Date.now();
    const last = lastEvents.get(a.key);
    if (last && last.title === a.title && now - last.at < REPEAT_AFTER) return 'repeat';
    const r = await deliver({ key: a.key, kind: a.kind, type: 'event', title: a.title, body: a.body, click: a.click });
    if (r === 'sent') lastEvents.set(a.key, { title: a.title, at: now });
    return r;
  } catch (e) {
    console.error('[alerts] notify failed:', (e as Error).message);
    return 'failed';
  }
}

/** Settings › Alerts' Send test: straight to the topic, outside the caps. Throws with what went wrong. */
export async function sendTest(): Promise<void> {
  const url = topicUrl();
  if (!url) throw new Error('Add a topic address first.');
  await serial(async () => {
    const now = Date.now();
    const m = memory();
    try {
      await publish(url, { title: 'Test from Launchpad', body: 'Alerts reach this phone. You’ll hear when something on the server breaks, and again when it’s fixed.', type: 'test' });
    } catch (e) {
      failed(m, e, now);
      throw e;
    }
    retryAt = 0;
    m.lastError = null;
    record(m, { kind: 'test', type: 'test', title: 'Test from Launchpad' }, now);
    saveMemory();
  });
}

export function alertsInfo(): AlertsInfo {
  const m = memory();
  return {
    topicUrl: topicUrl(),
    open: Object.values(m.open)
      .map((o) => ({ kind: o.kind, title: o.title, at: o.at }))
      .sort((a, b) => (a.at < b.at ? 1 : -1)),
    recent: m.recent,
    lastError: m.lastError,
  };
}

/** For tests: forget what's held here, so the next call reads the store again. */
export function resetForTests(): void {
  mem = null;
  retryAt = 0;
  lastTopic = '';
  lastKinds = DEFAULT_PREFS.alerts;
  lastEvents.clear();
  queue = Promise.resolve();
}
