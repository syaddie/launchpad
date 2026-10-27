import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config, googleConfigured } from './config';
import { authUrl, completeTask, createTask, exchangeCode, revoke } from './google';
import { store, updatePackages } from './store';
import { summariesEnabled } from './news';
import { MAX_PHOTOS, MAX_PHOTO_BYTES, readPhoto, removePhotoFile, sniffImage, writePhoto } from './photos';
import { newPackage, refreshNews, refreshPackage, runAllGoogle, runIfStale, runSource, startScheduler } from './sync';
import { CARRIERS, detectCarrier } from '../../shared/carriers';
import type { AppState, BookmarkGroup, NewsTopic, Note, Package, Photo, Prefs, SourceKey } from '../../shared/types';

const app = new Hono();

// ---------- Cloudflare Access (optional) ----------

if (config.access.teamDomain && config.access.aud) {
  const jwks = createRemoteJWKSet(new URL(`https://${config.access.teamDomain}/cdn-cgi/access/certs`));
  app.use('*', async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const token = c.req.header('cf-access-jwt-assertion');
    if (!token) return c.text('Forbidden: open Launchpad through its Cloudflare Access URL.', 403);
    try {
      await jwtVerify(token, jwks, { issuer: `https://${config.access.teamDomain}`, audience: config.access.aud });
    } catch {
      return c.text('Forbidden: invalid Cloudflare Access token.', 403);
    }
    return next();
  });
}

app.get('/healthz', (c) => c.text('ok'));

// ---------- state ----------

function state(): AppState {
  const g = store.google();
  const cal = store.calendar();
  const tasks = store.tasks();
  const prefs = store.prefs();
  const news = store.news();
  return {
    bookmarks: store.bookmarks(),
    notes: store.notes(),
    prefs,
    google: { configured: googleConfigured(), connected: !!g, email: g?.email, name: g?.name },
    calendars: cal.calendars,
    events: cal.events,
    taskLists: tasks.lists,
    tasks: tasks.tasks,
    packages: store.packages().filter((p) => !p.archived),
    sync: store.sync(),
    tracking: { allCarriers: !!config.seventeenTrackKey },
    // In the order of the topics in prefs; ones not fetched yet show as loading.
    news: prefs.newsTopics.map((topic): NewsTopic => {
      const n = news[topic.toLowerCase()];
      return n
        ? { topic, articles: n.articles, stories: n.stories, summarisedAt: n.summarisedAt, fetchedAt: n.fetchedAt, error: n.error }
        : { topic, articles: [], stories: null, summarisedAt: null, fetchedAt: null, error: null };
    }),
    newsSummaries: summariesEnabled(),
    photos: store.photos().map(({ id, focus }): Photo => ({ id, focus })),
  };
}

app.get('/api/state', (c) => c.json(state()));

// ---------- bookmarks, notes, prefs ----------

const isStr = (v: unknown): v is string => typeof v === 'string';

function validBookmarks(v: unknown): v is BookmarkGroup[] {
  return Array.isArray(v) && v.every((g) => g && isStr(g.id) && isStr(g.name) && Array.isArray(g.items)
    && g.items.every((b: any) => b && isStr(b.id) && isStr(b.name) && isStr(b.url)));
}

function validNotes(v: unknown): v is Note[] {
  return Array.isArray(v) && v.length > 0 && v.every((n) => n && isStr(n.id) && isStr(n.name) && isStr(n.text));
}

app.put('/api/bookmarks', async (c) => {
  const body = await c.req.json();
  if (!validBookmarks(body)) return c.json({ error: 'Invalid bookmarks' }, 400);
  store.setBookmarks(body);
  return c.json({ ok: true });
});

app.put('/api/notes', async (c) => {
  const body = await c.req.json();
  if (!validNotes(body)) return c.json({ error: 'Invalid notes' }, 400);
  store.setNotes(body);
  return c.json({ ok: true });
});

/** Trimmed, de-duplicated (ignoring case), at most 8 topics of 60 characters. */
function cleanTopics(v: unknown[]): string[] {
  const seen = new Set<string>();
  return v
    .filter(isStr)
    .map((t) => t.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 8);
}

app.put('/api/prefs', async (c) => {
  const body = (await c.req.json()) as Partial<Prefs>;
  const prev = store.prefs();
  const next: Prefs = {
    name: isStr(body.name) ? body.name.slice(0, 40) : prev.name,
    theme: ['system', 'light', 'dark'].includes(body.theme as string) ? body.theme! : prev.theme,
    accent: ['sage', 'slate', 'terracotta'].includes(body.accent as string) ? body.accent! : prev.accent,
    hiddenCalendars: Array.isArray(body.hiddenCalendars) ? body.hiddenCalendars.filter(isStr) : prev.hiddenCalendars,
    sources: { ...prev.sources, ...body.sources },
    newsTopics: Array.isArray(body.newsTopics) ? cleanTopics(body.newsTopics) : prev.newsTopics,
  };
  store.setPrefs(next);
  // A source switched back on should sync straight away.
  for (const k of ['calendar', 'tasks', 'gmail'] as const) {
    if (next.sources[k] && !prev.sources[k]) runSource(k);
  }
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
  if (!['calendar', 'tasks', 'gmail', 'carriers', 'news'].includes(key)) return c.json({ error: 'Unknown source' }, 400);
  if (key === 'news') {
    await refreshNews();
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
  store.resetSync();
  await runAllGoogle();
  return c.redirect('/');
});

app.post('/api/auth/google/disconnect', async (c) => {
  await revoke();
  store.clearGoogle();
  store.resetSync();
  return c.json(state());
});

app.get('/api/carriers', (c) => c.json(CARRIERS));

// ---------- errors ----------

app.onError((err, c) => {
  console.error(`[api] ${c.req.method} ${c.req.path}:`, err.message);
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

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`Launchpad listening on :${info.port} (data in ${config.dataDir})`);
  if (!googleConfigured()) console.log('Google is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to enable Calendar, Tasks and Gmail.');
});

startScheduler();
