import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { WebSocketServer } from 'ws';
import { config, googleConfigured } from './config';
import { authUrl, completeTask, createTask, exchangeCode, GoogleError, missingScopes, revoke } from './google';
import { asTab, checkDb, docVersion, store, updatePackages } from './store';
import { copyDailyToDrive, copyToDriveNow, driveOn, driveStatus } from './drive';
import { currentWarnings, health } from './health';
import { dbSnapshot, describeRestored, exportBackup, readBackupUpload, restoreBackup, RestoreError, zipBackup } from './backup';
import { listSnapshots, removeSnapshot, snapshotBackup, snapshotFile, startSnapshots, takeSnapshot } from './snapshots';
import { cleanCountdowns, cleanMood, cleanPrefs, isStr, isYmd, validBookmarks, validNotes } from './clean';
import { eventStream, tabOf } from './events';
import { recentSmokes, state, stateFor } from './state';
import { MAX_PHOTOS, MAX_PHOTO_BYTES, readPhoto, removePhotoFile, sniffImage, writePhoto } from './photos';
import { isRunning, newPackage, refreshPackage, refreshSummaries, refreshWeather, runAllGoogle, runIfStale, runSource, signOutGoogle, startScheduler } from './sync';
import { attachTerminal, FileError, listDir, makeDir, MAX_TEXT, readFileStream, readText, remove, rename, shellInfo, trustHostKey, abandonUpload, uploadPiece, UPLOAD_CHUNK, writeText } from './shell';
import { serverStats, startSampler } from './system';
import { startCleanup } from './cleanup';
import { CARRIERS, detectCarrier } from '../../shared/carriers';
import { cleanLearn } from '../../shared/learn';
import { cleanMoney } from '../../shared/money';
import { MAX_KG, MIN_KG, cleanKg, cleanTraining } from '../../shared/training';
import { refreshLearnNote } from './learn';
import { refreshTraining } from './training';
import type { Mood, Package, Photo, Prefs, SavedDoc, SourceKey } from '../../shared/types';

const app = new Hono();

// ---------- Cloudflare Access (optional) ----------

const accessOn = !!(config.access.teamDomain && config.access.aud);
const jwks = accessOn ? createRemoteJWKSet(new URL(`https://${config.access.teamDomain}/cdn-cgi/access/certs`)) : null;

/** Why a request without a valid Access token is refused, or null when it may pass. */
async function accessDenied(token: string | undefined): Promise<string | null> {
  if (!jwks) return null;
  if (!token) return 'Forbidden: open Launchpad through its Cloudflare Access URL.';
  try {
    await jwtVerify(token, jwks, { issuer: `https://${config.access.teamDomain}`, audience: config.access.aud });
    return null;
  } catch {
    return 'Forbidden: invalid Cloudflare Access token.';
  }
}

if (accessOn) {
  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const denied = await accessDenied(c.req.header('cf-access-jwt-assertion'));
    return denied ? c.text(denied, 403) : next();
  });
}

// Docker's HEALTHCHECK restarts the container when this fails, so it only checks what a restart could fix: the database.
// It skips Cloudflare Access, so it says nothing about what went wrong; /api/health does.
app.get('/healthz', (c) => (checkDb() ? c.text('database unavailable', 503) : c.text('ok')));

// Writes are credited to the tab that sent them, so /api/events doesn't send that tab its own change back.
app.use('/api/*', (c, next) => asTab(tabOf(c.req.header('x-launchpad-tab')), next));

/** Changes as they happen; see events.ts. */
app.get('/api/events', (c) => eventStream(c));

// ---------- state ----------

/** Everything, or with `keys` (store keys the change stream named) just the parts they feed. */
app.get('/api/state', (c) => {
  const keys = c.req.query('keys');
  return c.json(keys ? stateFor(keys.split(',').filter(Boolean)) : state());
});

// ---------- bookmarks, notes, prefs ----------

/**
 * A whole-document save says, in X-Base-Version, which version the page's copy started from.
 * When another tab or device has saved since, it's refused with the current copy, which the
 * page merges its edits into (shared/merge.ts) and saves again. A save without the header
 * (a tab closing mid-save, or a page from before this) simply wins, as before.
 */
function staleSave(c: Context, key: SavedDoc, current: () => unknown): Response | null {
  const base = c.req.header('x-base-version');
  if (base === undefined || base === docVersion(key)) return null;
  return c.json({ error: 'Changed on another device', conflict: true, version: docVersion(key), value: current() }, 409);
}
const saved = (c: Context, key: SavedDoc) => c.json({ ok: true, version: docVersion(key) });

app.put('/api/bookmarks', async (c) => {
  const body = await c.req.json();
  if (!validBookmarks(body)) return c.json({ error: 'Invalid bookmarks' }, 400);
  const stale = staleSave(c, 'bookmarks', store.bookmarks);
  if (stale) return stale;
  store.setBookmarks(body);
  return saved(c, 'bookmarks');
});

app.put('/api/notes', async (c) => {
  const body = await c.req.json();
  if (!validNotes(body)) return c.json({ error: 'Invalid notes' }, 400);
  const stale = staleSave(c, 'notes', store.notes);
  if (stale) return stale;
  store.setNotes(body);
  return saved(c, 'notes');
});

app.put('/api/prefs', async (c) => {
  const body = (await c.req.json()) as Partial<Prefs>;
  const prev = store.prefs();
  const next = cleanPrefs(body, prev);
  store.setPrefs(next);
  // A source switched back on should sync straight away.
  for (const k of ['calendar', 'tasks', 'gmail'] as const) {
    if (next.sources[k] && !prev.sources[k]) runSource(k);
  }
  const inboxOn = (p: Prefs) => p.sources.gmail && !p.hidden.includes('view:inbox');
  if (inboxOn(next) && !inboxOn(prev)) runSource('inbox');
  if (next.driveBackup && !prev.driveBackup) copyDailyToDrive();
  // A new area should show straight away; the page refreshes after saving.
  if (next.weatherArea && next.weatherArea !== prev.weatherArea) await refreshWeather();
  return c.json(next);
});

// ---------- tasks ----------

app.post('/api/tasks', async (c) => {
  const { listId, title, due } = await c.req.json();
  if (!isStr(listId) || !isStr(title) || !title.trim()) return c.json({ error: 'listId and title are required' }, 400);
  const task = await createTask(listId, title.trim(), isStr(due) ? due : null);
  const cache = store.tasks();
  store.setTasks({ ...cache, tasks: [task, ...cache.tasks] });
  return c.json(task);
});

app.post('/api/tasks/:listId/:taskId/complete', async (c) => {
  const { listId, taskId } = c.req.param();
  await completeTask(listId, taskId);
  const cache = store.tasks();
  store.setTasks({ ...cache, tasks: cache.tasks.filter((t) => t.id !== taskId) });
  return c.json({ ok: true });
});

// ---------- packages ----------

app.post('/api/packages', async (c) => {
  const body = await c.req.json();
  const number = isStr(body.number) ? body.number.replace(/\s+/g, '').toUpperCase() : '';
  const carrier = isStr(body.carrier) && body.carrier ? body.carrier : detectCarrier(number);
  if (!number || !carrier) return c.json({ error: 'A tracking number and carrier are required' }, 400);
  const existing = store.packages().find((p) => p.number === number);
  // Two items can ship under one number, so say so rather than quietly relabelling the one that's there.
  if (existing && !existing.archived && !existing.isNew) {
    return c.json({ error: `Already added as “${existing.label}”. Items shipped together share a tracking number.` }, 409);
  }
  let id: string;
  if (existing) {
    id = existing.id;
    updatePackages((pkgs) => pkgs.map((p) => (p.id === id ? { ...p, archived: false, isNew: false, label: body.label?.trim() || p.label } : p)));
  } else {
    const pkg = newPackage({ number, carrier, label: (isStr(body.label) && body.label.trim()) || `${carrier} parcel`, source: 'manual' });
    id = pkg.id;
    updatePackages((pkgs) => [pkg, ...pkgs]);
  }
  await refreshPackage(id).catch(() => {});
  return c.json(store.packages().find((p) => p.id === id));
});

app.patch('/api/packages/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const patch: Partial<Package> = {};
  if (isStr(body.label)) patch.label = body.label;
  if (typeof body.isNew === 'boolean') patch.isNew = body.isNew;
  if (typeof body.archived === 'boolean') patch.archived = body.archived;
  const pkgs = updatePackages((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const pkg = pkgs.find((p) => p.id === id);
  return pkg ? c.json(pkg) : c.json({ error: 'Not found' }, 404);
});

app.post('/api/packages/:id/refresh', async (c) => {
  await refreshPackage(c.req.param('id')).catch(() => {});
  return c.json(store.packages().find((p) => p.id === c.req.param('id')) || null);
});

// ---------- countdowns, cigarettes, mood ----------

app.put('/api/countdowns', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body)) return c.json({ error: 'Expected a list of countdowns' }, 400);
  const list = cleanCountdowns(body);
  store.setCountdowns(list);
  return c.json(list);
});

/** Log a cigarette now (or at `at`, for one logged late). Returns the recent log. */
app.post('/api/smokes', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const at = isStr(body.at) && !Number.isNaN(Date.parse(body.at)) ? new Date(body.at) : new Date();
  if (at.getTime() > Date.now() + 60_000) return c.json({ error: 'That time is in the future' }, 400);
  store.setSmokes([...store.smokes(), at.toISOString()].sort());
  return c.json(recentSmokes());
});

/** Undo: remove one logged cigarette, by its time, or the latest one. */
app.delete('/api/smokes', async (c) => {
  const at = c.req.query('at');
  const list = store.smokes();
  // The page undoes with the time it logged locally, which can be a moment off the server's.
  const near = (s: string) => Math.abs(Date.parse(s) - Date.parse(at!));
  let i = at ? list.lastIndexOf(at) : list.length - 1;
  if (at && i < 0) {
    const best = list.reduce((b, s, j) => (near(s) < 120_000 && (b < 0 || near(s) < near(list[b])) ? j : b), -1);
    i = best;
  }
  if (i >= 0) store.setSmokes([...list.slice(0, i), ...list.slice(i + 1)]);
  return c.json(recentSmokes());
});

/** Set a day's mood; level 0 clears it. */
app.put('/api/moods/:date', async (c) => {
  const date = c.req.param('date');
  if (!isYmd(date)) return c.json({ error: 'Expected a YYYY-MM-DD date' }, 400);
  const body = (await c.req.json()) as Partial<Mood>;
  const moods = { ...store.moods() };
  const mood = cleanMood(body, moods[date]?.note ?? '');
  if (!mood) delete moods[date];
  else moods[date] = mood;
  store.setMoods(moods);
  return c.json(moods);
});

/** Log body weight for a day; `kg` of 0 or null removes it. Returns every entry. */
app.put('/api/weights/:date', async (c) => {
  const date = c.req.param('date');
  if (!isYmd(date)) return c.json({ error: 'Expected a YYYY-MM-DD date' }, 400);
  const body = (await c.req.json().catch(() => ({}))) as { kg?: unknown };
  const weights = { ...store.weights() };
  if (body.kg === 0 || body.kg === null) delete weights[date];
  else {
    const kg = cleanKg(body.kg);
    if (kg === null) return c.json({ error: `Expected a weight between ${MIN_KG} and ${MAX_KG} kg` }, 400);
    weights[date] = kg;
  }
  store.setWeights(weights);
  return c.json(weights);
});

// ---------- money ----------

/** The whole tracker (starting balance, entries) and wishlist; the page works out the balances. */
app.put('/api/money', bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: 'That’s too much to save at once.' }, 413) }), async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || !Array.isArray(body.entries)) return c.json({ error: 'Invalid money tracker' }, 400);
  const stale = staleSave(c, 'money', store.money);
  if (stale) return stale;
  store.setMoney(cleanMoney(body));
  return saved(c, 'money');
});

// ---------- training ----------

/** Every workout, read from Hevy's export in the page. An import replaces what's here. */
app.put('/api/training', bodyLimit({ maxSize: 8 * 1024 * 1024, onError: (c) => c.json({ error: 'That’s too many workouts to save at once.' }, 413) }), async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || !Array.isArray(body.workouts)) return c.json({ error: 'Invalid workouts' }, 400);
  const training = cleanTraining(body);
  store.setTraining(training);
  // Claude labels new exercises and writes a note in the background; the page asks for them with the route below.
  refreshTraining();
  return c.json(training);
});

/** Wait for new exercises to be labelled and the note to be written (again, with ?force=1), then send the whole state. */
app.post('/api/training/refresh', async (c) => {
  await refreshTraining(c.req.query('force') === '1');
  return c.json(state());
});

// ---------- learn ----------

/** Courses, their graded work, study sessions, learning on the side and the timer, all at once. */
app.put('/api/learn', bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'That’s too much to save at once.' }, 413) }), async (c) => {
  const body = await c.req.json();
  if (!body || typeof body !== 'object' || !Array.isArray(body.courses)) return c.json({ error: 'Invalid learn data' }, 400);
  const stale = staleSave(c, 'learn', store.learn);
  if (stale) return stale;
  store.setLearn(cleanLearn(body));
  return saved(c, 'learn');
});

/** Write the note on the week ahead when today's isn't written yet (or again, with ?force=1), then send the whole state. */
app.post('/api/learn/refresh', async (c) => {
  await refreshLearnNote(c.req.query('force') === '1');
  return c.json(state());
});

// ---------- server health ----------

/** The database, the daily copies, Drive and every sync, with what's wrong. */
app.get('/api/health', (c) => c.json(health()));

const speedInfo = () => ({ tests: store.speedTests(), running: isRunning('speedtest') });

app.get('/api/server', async (c) => c.json(await serverStats(c.req.query('iface'), speedInfo())));

/** Start a speed test now; it takes 10–30 s, so this returns at once and the page polls. */
app.post('/api/speedtest', (c) => {
  runSource('speedtest', true);
  return c.json(speedInfo());
});

// ---------- terminal and files ----------

/** Browsers send Origin with WebSockets and writes. One from another site is refused, so a page elsewhere can't drive the shell or change files. */
function foreignOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

for (const p of ['/api/shell/*', '/api/files/*', '/api/backup', '/api/backup/*']) {
  app.use(p, async (c, next) => (foreignOrigin(c.req.header('origin'), c.req.header('host')) ? c.json({ error: 'Cross-site request refused' }, 403) : next()));
}

app.get('/api/shell', (c) => c.json(shellInfo(accessOn)));

app.post('/api/shell/trust', (c) => {
  trustHostKey();
  return c.json(shellInfo(accessOn));
});

app.get('/api/files/list', async (c) => c.json(await listDir(c.req.query('path'))));

app.get('/api/files/download', async (c) => {
  const f = await readFileStream(c.req.query('path'));
  return c.body(f.body, 200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(f.size),
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'X-Content-Type-Options': 'nosniff',
  });
});

app.get('/api/files/text', async (c) => c.json(await readText(c.req.query('path'))));

app.put('/api/files/text', bodyLimit({ maxSize: MAX_TEXT * 2, onError: (c) => c.json({ error: 'That’s over 1 MB.' }, 413) }), async (c) => {
  const body = await c.req.json();
  await writeText(body?.path, body?.text);
  return c.json({ ok: true });
});

/** One piece of a file, its bytes as the body; see UPLOAD_CHUNK. */
app.post(
  '/api/files/upload',
  bodyLimit({ maxSize: UPLOAD_CHUNK, onError: (c) => c.json({ error: 'That piece of the upload is too big.' }, 413) }),
  async (c) => {
    const q = c.req.query();
    const r = await uploadPiece({ dir: q.dir, name: q.name, id: q.id, offset: q.offset, total: q.total, overwrite: q.overwrite === '1', body: c.req.raw.body });
    return c.json({ ok: true, ...r });
  },
);

app.post('/api/files/upload/abandon', async (c) => {
  const body = await c.req.json();
  await abandonUpload(body?.dir, body?.id);
  return c.json({ ok: true });
});

app.post('/api/files/mkdir', async (c) => {
  const body = await c.req.json();
  await makeDir(body?.path);
  return c.json({ ok: true });
});

app.post('/api/files/rename', async (c) => {
  const body = await c.req.json();
  await rename(body?.from, body?.to);
  return c.json({ ok: true });
});

app.post('/api/files/delete', async (c) => {
  const body = await c.req.json();
  await remove(body?.path);
  return c.json({ ok: true });
});

// ---------- backup ----------

app.get('/api/backup', (c) => {
  const day = new Date().toISOString().slice(0, 10);
  return c.body(JSON.stringify(exportBackup(), null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="launchpad-backup-${day}.json"`,
    'Cache-Control': 'no-store',
  });
});

/**
 * Restore a backup and say what came back. A copy of the database is taken first, and its id
 * returned as `undo`, so the page can offer to put everything back as it was.
 */
function restoreWithUndo(c: Context, body: () => unknown) {
  const before = takeSnapshot('before-restore');
  try {
    const parts = restoreBackup(body());
    return c.json({ restored: describeRestored(parts), undo: before.id, state: state() });
  } catch (e) {
    removeSnapshot(before.id);
    if (e instanceof RestoreError) return c.json({ error: e.message }, 400);
    throw e;
  }
}

/** Restore from a backup file: the JSON, or a .zip with photos (sent as the raw file). Parts it has replace what's here; parts it doesn't are kept. */
app.post('/api/backup', bodyLimit({ maxSize: 100 * 1024 * 1024, onError: (c) => c.json({ error: 'That backup is over 100 MB, more than Cloudflare lets through.' }, 413) }), async (c) => {
  const bytes = Buffer.from(await c.req.arrayBuffer());
  return restoreWithUndo(c, () => readBackupUpload(bytes));
});

/** Everything you've entered and the photo files, as one .zip that Restore takes back. */
app.get('/api/backup/zip', (c) => {
  const day = new Date().toISOString().slice(0, 10);
  return c.body(zipBackup(), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="launchpad-backup-${day}.zip"`,
    'Cache-Control': 'no-store',
  });
});

// The copies Launchpad takes by itself (see snapshots.ts).
app.get('/api/backup/snapshots', (c) => c.json(listSnapshots()));

app.post('/api/backup/snapshots', (c) => {
  takeSnapshot('manual');
  return c.json(listSnapshots());
});

app.get('/api/backup/snapshots/:id', (c) => {
  const id = c.req.param('id');
  const file = snapshotFile(id);
  if (!file) return c.json({ error: 'That copy is gone.' }, 404);
  return c.body(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, 200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Length': String(fs.statSync(file).size),
    'Content-Disposition': `attachment; filename="launchpad-${id}.db"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});

/** Put back what you'd entered when this copy was taken. Undoable like any restore. */
app.post('/api/backup/snapshots/:id/restore', (c) => {
  const id = c.req.param('id');
  if (!snapshotFile(id)) return c.json({ error: 'That copy is gone.' }, 404);
  return restoreWithUndo(c, () => snapshotBackup(id));
});

/** "Copy to Drive now": a copy of how things are now, kept here too, uploaded to Google Drive. Waits for the upload. */
app.post('/api/backup/drive', async (c) => {
  if (!driveOn()) return c.json({ error: 'Switch on copying to Drive first. It needs Google connected with the Drive permission.' }, 400);
  await copyToDriveNow();
  return c.json(state());
});

/** The whole SQLite database, Google sign-in and caches included. Photos are files beside it, so aren't in it. */
app.get('/api/backup/db', (c) => {
  const snap = dbSnapshot();
  const day = new Date().toISOString().slice(0, 10);
  const file = fs.createReadStream(snap.path);
  file.on('close', snap.cleanup);
  return c.body(Readable.toWeb(file) as ReadableStream, 200, {
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Length': String(snap.size),
    'Content-Disposition': `attachment; filename="launchpad-${day}.db"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
});

// ---------- photos ----------

app.post(
  '/api/photos',
  bodyLimit({ maxSize: MAX_PHOTO_BYTES, onError: (c) => c.json({ error: 'That photo is over 15 MB.' }, 413) }),
  async (c) => {
    if (store.photos().length >= MAX_PHOTOS) return c.json({ error: `Launchpad keeps up to ${MAX_PHOTOS} photos. Remove some first.` }, 400);
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const mime = sniffImage(bytes);
    if (!mime) return c.json({ error: 'Use a JPEG, PNG, WebP or GIF image.' }, 415);
    const photo = writePhoto(bytes, mime);
    store.setPhotos([...store.photos(), photo]);
    return c.json({ id: photo.id, focus: photo.focus } satisfies Photo);
  },
);

app.get('/api/photos/:id', (c) => {
  const meta = store.photos().find((p) => p.id === c.req.param('id'));
  const file = meta && readPhoto(meta.id);
  if (!meta || !file) return c.json({ error: 'Not found' }, 404);
  // Ids are never reused, so the browser can keep a photo for good.
  return c.body(new Uint8Array(file), 200, {
    'Content-Type': meta.mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
});

/** Saves the order and focus points. Photos missing from the body stay, at the end. */
app.put('/api/photos', async (c) => {
  const body = await c.req.json();
  if (!Array.isArray(body)) return c.json({ error: 'Expected a list of photos' }, 400);
  const prev = store.photos();
  const clamp = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : d);
  const ids = new Set<string>();
  const next = body.flatMap((b: Partial<Photo>) => {
    const p = b && !ids.has(b.id!) && prev.find((x) => x.id === b.id);
    if (!p) return [];
    ids.add(p.id);
    return [{ ...p, focus: { x: clamp(b.focus?.x, p.focus.x), y: clamp(b.focus?.y, p.focus.y) } }];
  });
  store.setPhotos([...next, ...prev.filter((p) => !ids.has(p.id))]);
  return c.json({ ok: true });
});

app.delete('/api/photos/:id', (c) => {
  const id = c.req.param('id');
  store.setPhotos(store.photos().filter((p) => p.id !== id));
  removePhotoFile(id);
  return c.json({ ok: true });
});

// ---------- sync ----------

app.post('/api/sync/:source', async (c) => {
  const key = c.req.param('source') as SourceKey;
  if (!['calendar', 'tasks', 'gmail', 'carriers', 'news', 'inbox', 'weather', 'speedtest'].includes(key)) return c.json({ error: 'Unknown source' }, 400);
  if (key === 'news' || key === 'inbox') {
    await refreshSummaries(key);
    return c.json(state());
  }
  // ?ifOlderThan=30 lets the page ask for a refresh on focus without hammering Google.
  const minAge = Number(c.req.query('ifOlderThan') || 0) * 1000;
  await (minAge ? runIfStale(key, minAge) : runSource(key));
  return c.json(state());
});

// ---------- Google OAuth ----------

const oauthStates = new Map<string, number>();

app.get('/api/auth/google', (c) => {
  if (!googleConfigured()) {
    return c.html(`<p style="font-family:system-ui;padding:40px">Set <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> and <code>PUBLIC_URL</code> in <code>.env</code>, restart the container, then try again. See <code>docs/setup.md</code>.</p>`, 503);
  }
  const s = randomBytes(16).toString('hex');
  oauthStates.set(s, Date.now());
  return c.redirect(authUrl(s));
});

app.get('/api/auth/google/callback', async (c) => {
  const { code, state: s, error } = c.req.query();
  const issued = s ? oauthStates.get(s) : undefined;
  if (s) oauthStates.delete(s);
  if (error) return c.redirect('/?google=' + encodeURIComponent(error));
  if (!code || !issued || Date.now() - issued > 10 * 60_000) return c.text('Sign-in link expired. Go back and press Connect Google again.', 400);
  try {
    await exchangeCode(code);
  } catch (e) {
    return c.text(`Couldn't connect Google: ${(e as Error).message}`, 500);
  }
  store.setGoogleSignedOut(null);
  store.resetSync();
  await runAllGoogle();
  // A reconnect that added the Drive permission copies today's copy straight away.
  copyDailyToDrive();
  return c.redirect('/');
});

app.post('/api/auth/google/disconnect', async (c) => {
  await revoke();
  store.clearGoogle();
  store.setGoogleSignedOut(null);
  store.resetSync();
  return c.json(state());
});

app.get('/api/carriers', (c) => c.json(CARRIERS));

// ---------- errors ----------

app.onError((err, c) => {
  if (err instanceof FileError) return c.json({ error: err.message }, err.status);
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err.message);
  if (err instanceof GoogleError && err.authExpired) signOutGoogle(err.message);
  return c.json({ error: err.message }, 500);
});

// ---------- web app ----------

if (fs.existsSync(config.webDir)) {
  const root = path.relative(process.cwd(), config.webDir) || '.';
  app.use('*', async (c, next) => {
    await next();
    if (c.req.path.startsWith('/api/')) return;
    // Hashed bundles never change; index.html must always be revalidated so deploys show up.
    c.header('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('*', serveStatic({ root }));
  const index = fs.readFileSync(path.join(config.webDir, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(index));
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Launchpad listening on :${info.port} (data in ${config.dataDir})`);
  if (!googleConfigured()) console.log('Google is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Calendar, Tasks and Gmail.');
}) as http.Server;

// The terminal's WebSocket. Upgrades skip Hono, so the Access and origin checks happen here too.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
server.on('upgrade', async (req, socket, head) => {
  const url = new URL(req.url || '/', 'http://launchpad');
  const refuse = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  if (url.pathname !== '/api/terminal') return refuse('404 Not Found');
  const token = req.headers['cf-access-jwt-assertion'];
  if (foreignOrigin(req.headers.origin, req.headers.host) || (await accessDenied(Array.isArray(token) ? token[0] : token))) return refuse('403 Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => {
    attachTerminal(ws, url.searchParams.get('session'), Number(url.searchParams.get('cols')), Number(url.searchParams.get('rows'))).catch((e) => {
      console.error('[terminal]', e.message);
      ws.close(1011);
    });
  });
});

startScheduler();
startSampler();
startCleanup();
startSnapshots(copyDailyToDrive);
