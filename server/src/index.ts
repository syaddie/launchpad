import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config, googleConfigured } from './config';
import { authUrl, completeTask, createTask, exchangeCode, revoke } from './google';
import { store, updatePackages } from './store';
import { newPackage, refreshPackage, runAllGoogle, runIfStale, runSource, startScheduler } from './sync';
import { CARRIERS, detectCarrier } from '../../shared/carriers';
import type { AppState, BookmarkGroup, Note, Package, Prefs, SourceKey } from '../../shared/types';

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
  return {
    bookmarks: store.bookmarks(),
    notes: store.notes(),
    prefs: store.prefs(),
    google: { configured: googleConfigured(), connected: !!g, email: g?.email, name: g?.name },
    calendars: cal.calendars,
    events: cal.events,
    taskLists: tasks.lists,
    tasks: tasks.tasks,
    packages: store.packages().filter((p) => !p.archived),
    sync: store.sync(),
    tracking: { allCarriers: !!config.seventeenTrackKey },
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

app.put('/api/prefs', async (c) => {
  const body = (await c.req.json()) as Partial<Prefs>;
  const prev = store.prefs();
  const next: Prefs = {
    name: isStr(body.name) ? body.name.slice(0, 40) : prev.name,
    theme: ['system', 'light', 'dark'].includes(body.theme as string) ? body.theme! : prev.theme,
    accent: ['sage', 'slate', 'terracotta'].includes(body.accent as string) ? body.accent! : prev.accent,
    hiddenCalendars: Array.isArray(body.hiddenCalendars) ? body.hiddenCalendars.filter(isStr) : prev.hiddenCalendars,
    sources: { ...prev.sources, ...body.sources },
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

// ---------- sync ----------

app.post('/api/sync/:source', async (c) => {
  const key = c.req.param('source') as SourceKey;
  if (!['calendar', 'tasks', 'gmail', 'carriers'].includes(key)) return c.json({ error: 'Unknown source' }, 400);
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
