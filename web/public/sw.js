// Launchpad's service worker. It keeps the page itself (index.html, the hashed
// bundles, icons) so Launchpad still opens when the server or the tunnel is down:
// the page paints from its own copy of the state (IndexedDB) and says the server can't be reached.
// Nothing under /api/ is ever touched, so data always comes from the server.
const CACHE = 'launchpad-v1';
const SHELL = '/';
/** Old bundles pile up across deploys; keep this many of the newest. */
const MAX_ASSETS = 80;

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll([SHELL, '/favicon.svg', '/manifest.webmanifest']))
      // Behind Cloudflare Access a lapsed sign-in turns these into a redirect; the pages fill the cache later.
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Only a plain, successful same-origin answer is worth keeping (not an Access redirect or a proxy's error page). */
const keepable = (res) => res && res.ok && res.type === 'basic';
/** The tunnel or a proxy answering for a server that's down (Cloudflare uses 52x and 530). */
const serverDown = (res) => [502, 503, 504].includes(res.status) || (res.status >= 520 && res.status <= 530);

async function put(key, res) {
  const c = await caches.open(CACHE);
  await c.put(key, res);
  const keys = (await c.keys()).filter((r) => new URL(r.url).pathname.startsWith('/assets/'));
  // Keys come back in the order they were added, oldest first.
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await c.delete(old);
}

/** The page: always the server's copy when it answers, so deploys show up; the kept one when it doesn't. */
async function page(req) {
  try {
    const res = await fetch(req);
    if (keepable(res)) {
      put(SHELL, res.clone());
      return res;
    }
    if (serverDown(res)) return (await caches.match(SHELL)) || res;
    return res;
  } catch {
    return (await caches.match(SHELL)) || Response.error();
  }
}

/** Hashed bundles never change, so the kept copy is always right. */
async function asset(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (keepable(res)) put(req, res.clone());
  return res;
}

/** Icons, the manifest: the kept copy at once, refreshed for next time. */
async function other(req) {
  const hit = await caches.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (keepable(res)) put(req, res.clone());
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || fresh;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') e.respondWith(page(req));
  else if (url.pathname.startsWith('/assets/')) e.respondWith(asset(req));
  else e.respondWith(other(req));
});
