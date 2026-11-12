// Google OAuth plus the Calendar, Tasks, Gmail and Drive calls, using plain REST.
import { config } from './config';
import { store } from './store';
import { addDays, startOfDay } from '../../shared/dates';
import { BILL_SENDERS, type BillMail } from './bills';
import { extractTrackingNumbers, htmlToText, labelFor, parseInboxMessage, type Candidate, type StoredEmail } from './gmail-parse';
import type { CalEvent, CalendarInfo, Task, TaskList } from '../../shared/types';

const AUTH = 'https://www.googleapis.com/auth/';

/**
 * What Launchpad asks for. calendar.readonly stays beside calendar.events because listing
 * your calendars needs it; gmail.modify covers reading mail too. drive.file only lets
 * Launchpad see files it created itself.
 */
const SCOPES = ['openid', 'email', 'profile', ...['calendar.readonly', 'calendar.events', 'tasks', 'gmail.modify', 'drive.file'].map((s) => AUTH + s)];

/** Added after the first version; a sign-in from before them is asked to reconnect, and keeps working meanwhile. */
export const NEW_SCOPES = ['drive.file', 'calendar.events', 'gmail.modify'] as const;
export type ScopeName = (typeof NEW_SCOPES)[number] | 'calendar.readonly' | 'tasks' | 'gmail.readonly';

/** Whether `granted` (the space-separated or listed scopes Google returned) includes `name`. */
export function grantHas(granted: string[] | string | undefined, name: ScopeName): boolean {
  const list = typeof granted === 'string' ? granted.split(/\s+/) : granted || [];
  return list.includes(AUTH + name);
}

/** Whether the saved Google sign-in allows `name`, e.g. hasScope('gmail.modify'). False when Google isn't connected or the grant isn't known yet. */
export function hasScope(name: ScopeName): boolean {
  return grantHas(store.google()?.scopes, name);
}

/**
 * The new scopes the saved sign-in lacks. Empty when it has them all, or when it isn't
 * known yet: a sign-in from before scopes were saved learns them on its next token
 * refresh, within the hour.
 */
/** For a call that needs a newer scope: stop with a plain message, before Google refuses it, when the sign-in is known to lack it. */
export function needScope(name: ScopeName): void {
  if (store.google()?.scopes && !hasScope(name)) throw new GoogleError('Reconnect Google in Settings to allow this.', 403);
}

export function missingScopes(): string[] {
  const g = store.google();
  if (!g?.scopes) return [];
  return NEW_SCOPES.filter((s) => !grantHas(g.scopes, s));
}

const redirectUri = () => `${config.publicUrl}/api/auth/google/callback`;

export class GoogleError extends Error {
  constructor(message: string, readonly status = 0, readonly authExpired = false) {
    super(message);
  }
}

export function authUrl(state: string): string {
  const p = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p;
}

/** fetch, with a network failure or timeout turned into a message that says where to look. */
async function googleFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(20000), ...init });
  } catch (e) {
    const timeout = (e as Error).name === 'TimeoutError';
    throw new GoogleError(
      timeout ? 'Google took too long to answer. It tries again on the next sync.' : 'Couldn’t reach Google. Check the server’s internet connection; it tries again on the next sync.',
    );
  }
}

/** Shown when Google stops accepting the saved sign-in. */
export const SIGNED_OUT =
  'Google signed Launchpad out: access was removed in your Google account, your password changed, or the OAuth app is still in Testing (which ends sign-ins after 7 days). Reconnect Google in Settings. If it happens every week, publish the OAuth app (docs/setup.md step 3).';

async function tokenRequest(body: Record<string, string>) {
  const res = await googleFetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      ...body,
    }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    if (json.error === 'invalid_grant') throw new GoogleError(SIGNED_OUT, res.status, true);
    if (json.error === 'invalid_client' || json.error === 'unauthorized_client') {
      throw new GoogleError(
        'Google rejected the OAuth client. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env against Google Cloud console → Credentials (the secret may have been reset or deleted), then restart Launchpad.',
        res.status,
      );
    }
    throw new GoogleError(`Google token error: ${json.error_description || json.error || res.status}`, res.status);
  }
  return json as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
}

export async function exchangeCode(code: string): Promise<void> {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri() }).catch((e) => {
    // Here invalid_grant means this sign-in code was already used or has expired, not a lost sign-in.
    throw e instanceof GoogleError && e.authExpired ? new GoogleError('That sign-in link was already used or has expired. Go back and press Connect Google again.') : e;
  });
  const prev = store.google();
  const refreshToken = t.refresh_token || prev?.refreshToken;
  if (!refreshToken) throw new GoogleError('Google did not return a refresh token. Remove Launchpad from your Google account permissions and connect again.');
  const profile = (await googleFetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${t.access_token}` },
  }).then((r) => r.json()).catch(() => ({}))) as { email?: string; name?: string };
  store.setGoogle({
    refreshToken,
    accessToken: t.access_token,
    expiresAt: Date.now() + (t.expires_in - 60) * 1000,
    email: profile.email,
    name: profile.name,
    scopes: t.scope ? t.scope.split(/\s+/) : prev?.scopes,
  });
}

async function accessToken(fresh = false): Promise<string> {
  const g = store.google();
  if (!g) throw new GoogleError('Google is not connected.');
  if (!fresh && g.accessToken && g.expiresAt && g.expiresAt > Date.now()) return g.accessToken;
  const t = await tokenRequest({ refresh_token: g.refreshToken, grant_type: 'refresh_token' });
  store.setGoogle({ ...g, accessToken: t.access_token, expiresAt: Date.now() + (t.expires_in - 60) * 1000, scopes: t.scope ? t.scope.split(/\s+/) : g.scopes });
  return t.access_token;
}

/** A failed Google API response → what went wrong and what to do about it. */
export function googleApiError(status: number, error: { message?: string; status?: string; details?: { reason?: string }[]; errors?: { reason?: string }[] } = {}): GoogleError {
  const msg = error.message || `status ${status}`;
  const reasons = [...(error.details || []), ...(error.errors || [])].map((d) => d.reason || '');
  if (status === 401) return new GoogleError(SIGNED_OUT, status, true);
  if (status === 403 && (reasons.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT') || /insufficient (authentication )?scopes/i.test(msg))) {
    return new GoogleError('Launchpad is missing a Google permission. Disconnect and reconnect Google in Settings, and leave every box ticked on Google’s permission screen.', status);
  }
  if (status === 403 && (reasons.includes('SERVICE_DISABLED') || reasons.includes('accessNotConfigured'))) {
    return new GoogleError(`An API isn’t enabled in your Google Cloud project: ${msg}`, status);
  }
  if (status === 429 || reasons.includes('rateLimitExceeded') || reasons.includes('userRateLimitExceeded')) {
    return new GoogleError('Hit Google’s rate limit. It tries again on the next sync.', status);
  }
  if (status >= 500) return new GoogleError(`Google is having trouble (${status} ${msg}). It tries again on the next sync.`, status);
  return new GoogleError(`${status} ${msg}`, status);
}

/** A signed request, its response as it came. */
async function authed(url: string, init: RequestInit = {}, timeout = 20000): Promise<Response> {
  const call = async (token: string) =>
    googleFetch(url, { signal: AbortSignal.timeout(timeout), ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...init.headers } });
  let res = await call(await accessToken());
  // A saved token Google has stopped accepting (revoked, or the clock drifted): get a new one once.
  if (res.status === 401) {
    await res.body?.cancel();
    res = await call(await accessToken(true));
  }
  return res;
}

async function gapi<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await authed(url, init);
  if (res.status === 204) return undefined as T;
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw googleApiError(res.status, json?.error);
  return json as T;
}

export async function revoke(): Promise<void> {
  const g = store.google();
  if (g?.refreshToken) {
    await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(g.refreshToken), { method: 'POST' }).catch(() => {});
  }
}

// ---------- Calendar ----------

// Muted dots that sit well on the calm palette. Assigned in calendar-list order.
const CAL_COLORS = ['#5f8fa3', '#b08844', '#a06a8c', '#6f8f6a', '#8a7fb0', '#a87660', '#5d8a87', '#9a8a5a'];

const VIDEO_RE = /https:\/\/(?:[\w-]+\.)?(?:zoom\.us\/[jw]\/[^\s"<>)]+|meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>)]+)/i;

function conference(ev: any): { url?: string; type?: string } {
  const entry = ev.conferenceData?.entryPoints?.find((e: any) => e.entryPointType === 'video');
  const url: string | undefined = entry?.uri || ev.hangoutLink || (`${ev.location || ''} ${ev.description || ''}`.match(VIDEO_RE) || [])[0];
  if (!url) return {};
  const type = /zoom\.us/.test(url) ? 'Zoom' : /meet\.google/.test(url) ? 'Google Meet' : /teams\.microsoft/.test(url) ? 'Teams' : ev.conferenceData?.conferenceSolution?.name || 'Video call';
  return { url, type };
}

function toCalEvent(calendarId: string, ev: any): CalEvent {
  const allDay = !!ev.start?.date;
  const conf = conference(ev);
  return {
    id: `${calendarId}:${ev.id}`,
    calendarId,
    title: ev.summary || '(No title)',
    start: allDay ? ev.start.date : ev.start.dateTime,
    end: allDay ? ev.end.date : ev.end.dateTime,
    allDay,
    location: ev.location || undefined,
    conferenceUrl: conf.url,
    conferenceType: conf.type,
    description: ev.description ? htmlToText(ev.description).trim().slice(0, 600) : undefined,
    htmlLink: ev.htmlLink,
  };
}

/** A new event. All-day ones take YYYY-MM-DD dates (the end is the day after); timed ones ISO date-times. */
export async function createEvent(calendarId: string, e: { title: string; allDay: boolean; start: string; end: string }): Promise<CalEvent> {
  needScope('calendar.events');
  const when = (v: string) => (e.allDay ? { date: v } : { dateTime: v });
  const ev = await gapi<any>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    body: JSON.stringify({ summary: e.title, start: when(e.start), end: when(e.end) }),
  });
  return toCalEvent(calendarId, ev);
}

export async function fetchCalendar(): Promise<{ calendars: CalendarInfo[]; events: CalEvent[] }> {
  const list = await gapi<{ items: any[] }>('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&maxResults=250');
  const items = (list.items || []).filter((c) => !c.hidden && !c.deleted);
  items.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
  const calendars: CalendarInfo[] = items.map((c, i) => {
    let name: string = c.summaryOverride || c.summary || 'Calendar';
    if (c.primary && name.includes('@')) name = 'Personal';
    return { id: c.id, name, color: CAL_COLORS[i % CAL_COLORS.length], writable: c.accessRole === 'owner' || c.accessRole === 'writer' };
  });

  const today = startOfDay(new Date());
  const timeMin = addDays(today, -1).toISOString();
  const timeMax = addDays(today, 8).toISOString();
  const events: CalEvent[] = [];
  await Promise.all(
    items.filter((c) => c.selected !== false).map(async (c) => {
      const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' });
      const res = await gapi<{ items: any[] }>(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(c.id)}/events?${q}`);
      for (const ev of res.items || []) {
        if (ev.status === 'cancelled') continue;
        if (ev.attendees?.some((a: any) => a.self && a.responseStatus === 'declined')) continue;
        events.push(toCalEvent(c.id, ev));
      }
    }),
  );
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { calendars, events };
}

// ---------- Tasks ----------

const TASKS = 'https://tasks.googleapis.com/tasks/v1';

export async function fetchTasks(): Promise<{ lists: TaskList[]; tasks: Task[] }> {
  const res = await gapi<{ items: any[] }>(`${TASKS}/users/@me/lists?maxResults=100`);
  const lists: TaskList[] = (res.items || []).map((l) => ({ id: l.id, title: l.title }));
  const tasks: Task[] = [];
  await Promise.all(
    lists.map(async (l) => {
      let pageToken = '';
      do {
        const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100' });
        if (pageToken) q.set('pageToken', pageToken);
        const page = await gapi<{ items?: any[]; nextPageToken?: string }>(`${TASKS}/lists/${encodeURIComponent(l.id)}/tasks?${q}`);
        for (const t of page.items || []) {
          if (t.status === 'completed' || t.deleted || !t.title?.trim()) continue;
          tasks.push(toTask(l.id, t));
        }
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    }),
  );
  return { lists, tasks };
}

function toTask(listId: string, t: any): Task {
  const task: Task = { id: t.id, listId, title: (t.title || '').trim(), due: t.due ? t.due.slice(0, 10) : null };
  if (t.parent) task.parent = t.parent;
  if (t.notes) task.notes = t.notes;
  if (t.position) task.position = t.position;
  return task;
}

const taskUrl = (listId: string, taskId: string) => `${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;
/** Google Tasks keeps only the day of a due date, written as midnight UTC. */
const dueField = (due: string | null) => (due ? `${due}T00:00:00.000Z` : null);

/** A new task, or with `parent` a subtask of that task. */
export async function createTask(listId: string, title: string, due: string | null, opts: { notes?: string; parent?: string } = {}): Promise<Task> {
  const body: Record<string, string> = { title };
  if (due) body.due = dueField(due)!;
  if (opts.notes) body.notes = opts.notes;
  const q = opts.parent ? `?parent=${encodeURIComponent(opts.parent)}` : '';
  const t = await gapi<any>(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks${q}`, { method: 'POST', body: JSON.stringify(body) });
  return toTask(listId, t);
}

/** Change a task's title or due date (null clears it). */
export async function updateTask(listId: string, taskId: string, patch: { title?: string; due?: string | null }): Promise<Task> {
  const body: Record<string, string | null> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.due !== undefined) body.due = dueField(patch.due);
  const t = await gapi<any>(taskUrl(listId, taskId), { method: 'PATCH', body: JSON.stringify(body) });
  return toTask(listId, t);
}

/** Move a task to another list. Google takes its subtasks along. */
export async function moveTask(listId: string, taskId: string, toList: string): Promise<Task> {
  const t = await gapi<any>(`${taskUrl(listId, taskId)}/move?destinationTasklist=${encodeURIComponent(toList)}`, { method: 'POST' });
  return toTask(toList, t);
}

export async function deleteTask(listId: string, taskId: string): Promise<void> {
  await gapi(taskUrl(listId, taskId), { method: 'DELETE' });
}

export async function completeTask(listId: string, taskId: string): Promise<void> {
  await gapi(`${TASKS}/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed' }),
  });
}

// ---------- Gmail ----------

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SHIPPING_QUERY = [
  'newer_than:21d -in:chats -in:spam -in:trash',
  '(from:(singpost OR speedpost OR ninjavan OR jtexpress OR qxpress OR shopee OR lazada OR amazon OR dhl OR fedex OR ups OR aliexpress OR taobao OR qoo10)',
  'OR subject:(shipped OR shipping OR "out for delivery" OR "tracking number" OR dispatched OR "on its way" OR "on the way"))',
].join(' ');

const b64 = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

/** Plain and HTML parts together, or with `either` the plain part alone when there is one. */
function bodyText(payload: any, either = false): string {
  const plain: string[] = [];
  const html: string[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.body?.data) {
      if (p.mimeType === 'text/plain') plain.push(b64(p.body.data));
      else if (p.mimeType === 'text/html') html.push(b64(p.body.data));
    }
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  // Use both: some senders only put the tracking number in the HTML part.
  if (either && plain.some((p) => p.trim())) return plain.join('\n');
  return [...plain, ...html.map(htmlToText)].join('\n');
}

export interface GmailFind extends Candidate {
  label: string;
}

/** Scan recent shipping emails not seen before. Returns new tracking numbers with a label. */
export async function scanGmail(): Promise<GmailFind[]> {
  const seen = new Set(store.gmailSeen());
  const list = await gapi<{ messages?: { id: string }[] }>(`${GMAIL}/messages?maxResults=30&q=${encodeURIComponent(SHIPPING_QUERY)}`);
  const fresh = (list.messages || []).filter((m) => !seen.has(m.id));
  const finds: GmailFind[] = [];
  for (const m of fresh) {
    const msg = await gapi<any>(`${GMAIL}/messages/${m.id}?format=full`);
    const headers: { name: string; value: string }[] = msg.payload?.headers || [];
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value || '';
    const from = h('from');
    const subject = h('subject');
    for (const c of extractTrackingNumbers(`${subject}\n${bodyText(msg.payload)}`, from)) {
      if (!finds.some((f) => f.number === c.number)) finds.push({ ...c, label: labelFor(from, subject) });
    }
    seen.add(m.id);
  }
  store.setGmailSeen([...seen]);
  return finds;
}


/** Archive or un-archive, mark read or unread: label changes on up to 1000 emails at once. */
export async function modifyEmails(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void> {
  needScope('gmail.modify');
  if (!ids.length) return;
  await gapi(`${GMAIL}/messages/batchModify`, {
    method: 'POST',
    body: JSON.stringify({ ids, addLabelIds: change.add || [], removeLabelIds: change.remove || [] }),
  });
}

// Bills, due notices and receipts: subjects that say so, and senders that send them.
const BILL_QUERY = [
  'newer_than:7d -in:chats -in:spam -in:trash -in:sent -in:drafts -category:promotions',
  '(subject:(bill OR statement OR receipt OR invoice OR payment OR paid OR "amount due" OR order OR renewal OR premium OR subscription OR trip OR ride OR booking)',
  `OR from:(${BILL_SENDERS.join(' OR ')}))`,
].join(' ');

/** Recent bill-like emails not in `seen`, with their text, for bills.ts to read. */
export async function fetchBillMail(seen: Set<string>): Promise<BillMail[]> {
  const ids = (await listMessageIds(BILL_QUERY, 40)).filter((id) => !seen.has(id));
  const out: BillMail[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(
      ids.slice(i, i + 8).map(async (id) => {
        const msg = await gapi<any>(`${GMAIL}/messages/${id}?format=full`);
        const e = parseInboxMessage(msg, '');
        out.push({ id, threadId: e.threadId, from: e.from, fromEmail: e.fromEmail, subject: e.subject, at: e.at, text: bodyText(msg.payload).slice(0, 20000) });
      }),
    );
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- Inbox ----------

const INBOX_QUERY = 'newer_than:7d -in:chats -in:spam -in:trash -in:sent -in:drafts';
const INBOX_MAX = 150;

async function listMessageIds(q: string, max: number): Promise<string[]> {
  const ids: string[] = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ q, maxResults: String(Math.min(100, max - ids.length)) });
    if (pageToken) p.set('pageToken', pageToken);
    const page = await gapi<{ messages?: { id: string }[]; nextPageToken?: string }>(`${GMAIL}/messages?${p}`);
    ids.push(...(page.messages || []).map((m) => m.id));
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < max);
  return ids;
}

/**
 * The last 7 days of mail, newest first. Only messages not in `cached` are
 * downloaded; read/unread comes from one extra list call, so a 15-minute
 * refresh costs two or three requests when nothing new has arrived.
 */
export async function fetchInbox(cached: StoredEmail[]): Promise<StoredEmail[]> {
  const ids = await listMessageIds(INBOX_QUERY, INBOX_MAX);
  const unread = new Set(await listMessageIds(`${INBOX_QUERY} is:unread`, INBOX_MAX));
  const known = new Map(cached.map((e) => [e.id, e]));
  const missing = ids.filter((id) => !known.has(id));
  // A few at a time keeps well inside Gmail's per-user rate limit.
  for (let i = 0; i < missing.length; i += 8) {
    await Promise.all(
      missing.slice(i, i + 8).map(async (id) => {
        const msg = await gapi<any>(`${GMAIL}/messages/${id}?format=full`);
        known.set(id, parseInboxMessage(msg, bodyText(msg.payload, true)));
      }),
    );
  }
  return ids
    .map((id) => known.get(id)!)
    .map((e) => ({ ...e, unread: unread.has(e.id) }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

// ---------- Drive ----------
// With drive.file, Google only shows Launchpad the files and folders it created itself.

const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  createdTime?: string;
  appProperties?: Record<string, string>;
}

/** A Drive query string literal. */
export const driveLiteral = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const lit = driveLiteral;

/** The id of the folder named `name` that Launchpad made with `tag` in its private properties, made now if there isn't one. */
export async function driveFolder(name: string, tag: Record<string, string>): Promise<string> {
  const [k, v] = Object.entries(tag)[0];
  const q = `mimeType = ${lit(FOLDER_MIME)} and trashed = false and appProperties has { key=${lit(k)} and value=${lit(v)} }`;
  const found = await gapi<{ files?: DriveFile[] }>(`${DRIVE}?${new URLSearchParams({ q, fields: 'files(id,name)', pageSize: '10', spaces: 'drive' })}`);
  if (found.files?.[0]) return found.files[0].id;
  const made = await gapi<DriveFile>(`${DRIVE}?fields=id`, { method: 'POST', body: JSON.stringify({ name, mimeType: FOLDER_MIME, appProperties: tag }) });
  return made.id;
}

/** Files in `folderId` that Launchpad made with `tag` in their private properties, not in the bin. */
export async function driveFiles(folderId: string, tag: Record<string, string>): Promise<DriveFile[]> {
  const [k, v] = Object.entries(tag)[0];
  const q = `${lit(folderId)} in parents and trashed = false and appProperties has { key=${lit(k)} and value=${lit(v)} }`;
  const out: DriveFile[] = [];
  let pageToken = '';
  do {
    const p = new URLSearchParams({ q, fields: 'nextPageToken,files(id,name,createdTime,appProperties)', pageSize: '100', spaces: 'drive' });
    if (pageToken) p.set('pageToken', pageToken);
    const page = await gapi<{ files?: DriveFile[]; nextPageToken?: string }>(`${DRIVE}?${p}`);
    out.push(...(page.files || []));
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** Upload `bytes` as a new file in `folderId`. Resumable, so a large database goes up in one request without the multipart size limit. */
export async function driveUpload(folderId: string, name: string, bytes: Buffer, appProperties: Record<string, string>): Promise<DriveFile> {
  const start = await authed('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
    method: 'POST',
    headers: { 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(bytes.length) },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/octet-stream', appProperties }),
  });
  const session = start.headers.get('location');
  if (!start.ok || !session) {
    const json = (await start.json().catch(() => ({}))) as any;
    throw googleApiError(start.status, json?.error);
  }
  await start.body?.cancel();
  // The session address is the permission for this one upload, so it needs no sign-in of its own.
  const res = await googleFetch(session, {
    method: 'PUT',
    signal: AbortSignal.timeout(10 * 60_000),
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(bytes),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw googleApiError(res.status, json?.error);
  return json as DriveFile;
}

/** Move a file Launchpad made to the bin, where Google keeps it 30 days before deleting it. */
export async function driveTrash(fileId: string): Promise<void> {
  await gapi(`${DRIVE}/${encodeURIComponent(fileId)}?fields=id`, { method: 'PATCH', body: JSON.stringify({ trashed: true }) });
}
