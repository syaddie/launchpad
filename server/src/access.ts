// Who a request is from, by its Cloudflare Access token (the `Cf-Access-Jwt-Assertion` header
// Cloudflare adds once someone has signed in).
//
// Two Access applications can sign people in. CF_ACCESS_AUD is Launchpad's own: those sign-ins
// reach everything. CF_ACCESS_MUSIC_AUD, when set, is a second one on its own hostname for someone
// who should only see Music's busking slots (a "music" sign-in): it gets the Music-only page
// (web/guest.html) and the two /api/guest routes, and every other API answers 403. The token says
// which application signed it (its `aud` claim), and the signature can't be forged, so the
// hostname a request names plays no part: a music sign-in sent to Launchpad's own address, or
// straight to the LAN port, is still only a music sign-in.
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type Scope = 'full' | 'music';

export interface AccessConfig {
  teamDomain: string;
  aud: string;
  musicAud: string;
}

export interface Access {
  /** Access is set up, so every request needs a token. */
  on: boolean;
  /** Whose request this is, or why it's refused. Always 'full' when Access is off (development, the LAN without Access). */
  scope(token: string | undefined): Promise<Scope | { denied: string }>;
}

/** `keys` is for tests; the real ones come from the team's certs address. */
export function makeAccess(cfg: AccessConfig, keys?: JWTVerifyGetKey): Access {
  const on = !!(cfg.teamDomain && cfg.aud);
  if (!on) return { on, scope: async () => 'full' };
  const jwks = keys ?? createRemoteJWKSet(new URL(`https://${cfg.teamDomain}/cdn-cgi/access/certs`));
  const audiences = cfg.musicAud && cfg.musicAud !== cfg.aud ? [cfg.aud, cfg.musicAud] : [cfg.aud];
  return {
    on,
    async scope(token) {
      if (!token) return { denied: 'Forbidden: open Launchpad through its Cloudflare Access URL.' };
      try {
        const { payload } = await jwtVerify(token, jwks, { issuer: `https://${cfg.teamDomain}`, audience: audiences });
        const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
        // A token for both applications (Cloudflare doesn't issue those) counts as the narrower one.
        return audiences.length > 1 && aud.includes(cfg.musicAud) ? 'music' : 'full';
      } catch {
        return { denied: 'Forbidden: invalid Cloudflare Access token.' };
      }
    },
  };
}

/** The only API routes a music sign-in can use: the slots, and Check now. */
const GUEST_API: [method: string, path: string][] = [
  ['GET', '/api/guest/nac'],
  ['POST', '/api/guest/nac/check'],
];

/**
 * What a music sign-in gets for a request: 'page' for the Music-only page (any page address,
 * since it's the only page there is for them), 'pass' for the page's files and its two API
 * routes, or 'refuse'. The page's files hold no data, only code; the data comes from the API.
 */
export function guestRoute(method: string, path: string): 'page' | 'pass' | 'refuse' {
  if (path === '/api' || path.startsWith('/api/')) return GUEST_API.some(([m, p]) => m === method && p === path) ? 'pass' : 'refuse';
  if (method !== 'GET' && method !== 'HEAD') return 'refuse';
  // The service worker only belongs to the full app; without it, nothing of the full app is kept on their device.
  if (path === '/sw.js') return 'refuse';
  // A file has an extension in its last part (/assets/guest-1a2b.js, /favicon.svg); a page address doesn't.
  const last = path.slice(path.lastIndexOf('/') + 1);
  return !last.includes('.') || /\.html?$/i.test(last) ? 'page' : 'pass';
}

/**
 * Every request's check, before anything else: refused without a valid token; your own sign-in
 * goes on to everything; a music-only one gets the Music page (`page()`, the built guest.html),
 * the page's files and its two API routes, and nothing else. /healthz is Docker's, from inside.
 */
export function accessGate(access: Access, page: () => string | null): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === '/healthz') return next();
    const scope = await access.scope(c.req.header('cf-access-jwt-assertion'));
    if (typeof scope !== 'string') return c.text(scope.denied, 403);
    if (scope === 'full') return next();
    const route = guestRoute(c.req.method, c.req.path);
    if (route === 'refuse') return c.req.path === '/api' || c.req.path.startsWith('/api/') ? c.json({ error: 'This sign-in only reaches the busking slots.' }, 403) : c.text('Not found', 404);
    if (route === 'pass') return next();
    const html = page();
    c.header('Cache-Control', 'no-cache');
    return html ? c.html(html) : c.text('The busking slots page isn’t built.', 404);
  };
}
