// Who reaches what (server/src/access.ts): your own Access sign-in reaches everything, a music-only
// one only the Music page and its two API routes; and what that page is sent (nac.ts guestNacStatus):
// the slots without your bookings or watches. Tokens are signed here with a made-up key.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessGate, guestRoute, makeAccess } from '../server/src/access';
import { guestNacStatus } from '../server/src/nac';
import type { NacStatus } from '../shared/types';

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'launchpad-aud';
const MUSIC = 'music-aud';

let sign: (aud: string | string[], o?: { issuer?: string; exp?: string; key?: 'other' }) => Promise<string>;
let keys: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const ours = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(ours.publicKey)), kid: 'k1', alg: 'RS256' };
  keys = createLocalJWKSet({ keys: [jwk] });
  sign = (aud, o = {}) =>
    new SignJWT({ email: 'someone@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(o.issuer ?? `https://${TEAM}`)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '1h')
      .sign(o.key === 'other' ? other.privateKey : ours.privateKey);
});

describe('makeAccess', () => {
  it('lets everything through as your own when Access is off', async () => {
    const a = makeAccess({ teamDomain: '', aud: '', musicAud: MUSIC });
    expect(a.on).toBe(false);
    expect(await a.scope(undefined)).toBe('full');
  });

  it('tells your sign-in from a music-only one by the application that signed it', async () => {
    const a = makeAccess({ teamDomain: TEAM, aud: AUD, musicAud: MUSIC }, keys);
    expect(await a.scope(await sign(AUD))).toBe('full');
    expect(await a.scope(await sign(MUSIC))).toBe('music');
    // Both at once is the narrower one.
    expect(await a.scope(await sign([AUD, MUSIC]))).toBe('music');
  });

  it('refuses no token, another application, another team, a forged or an expired one', async () => {
    const a = makeAccess({ teamDomain: TEAM, aud: AUD, musicAud: MUSIC }, keys);
    for (const t of [undefined, '', 'not-a-jwt', await sign('someone-else'), await sign(AUD, { issuer: 'https://evil.cloudflareaccess.com' }), await sign(AUD, { key: 'other' }), await sign(MUSIC, { exp: '-1m' })]) {
      expect(await a.scope(t)).toHaveProperty('denied');
    }
  });

  it('refuses a music token when no music application is set up', async () => {
    const a = makeAccess({ teamDomain: TEAM, aud: AUD, musicAud: '' }, keys);
    expect(await a.scope(await sign(MUSIC))).toHaveProperty('denied');
    expect(await a.scope(await sign(AUD))).toBe('full');
  });

  it('never makes your own sign-in a music one when both are set to the same tag', async () => {
    const a = makeAccess({ teamDomain: TEAM, aud: AUD, musicAud: AUD }, keys);
    expect(await a.scope(await sign(AUD))).toBe('full');
  });
});

describe('guestRoute', () => {
  it('passes only the two guest API routes', () => {
    expect(guestRoute('GET', '/api/guest/nac')).toBe('pass');
    expect(guestRoute('POST', '/api/guest/nac/check')).toBe('pass');
    for (const [m, p] of [
      ['GET', '/api/state'],
      ['GET', '/api/nac'],
      ['POST', '/api/nac/check'],
      ['POST', '/api/nac/watches'],
      ['PUT', '/api/nac/places'],
      ['DELETE', '/api/guest/nac'],
      ['GET', '/api/guest/nac/check'],
      ['GET', '/api/guest/nac/'],
      ['GET', '/api/files/list'],
      ['GET', '/api/terminal'],
      ['GET', '/api/events'],
      ['GET', '/api'],
    ]) {
      expect(guestRoute(m, p), `${m} ${p}`).toBe('refuse');
    }
  });

  it('gives the Music page for any page address, and the files it loads', () => {
    for (const p of ['/', '/index.html', '/guest', '/guest.html', '/music', '/anything/else']) expect(guestRoute('GET', p), p).toBe('page');
    for (const p of ['/assets/guest-1a2b.js', '/assets/index-9f.css', '/favicon.svg', '/icons/apple-touch-icon.png']) expect(guestRoute('GET', p), p).toBe('pass');
  });

  it('keeps the full app’s service worker and any write off the page side', () => {
    expect(guestRoute('GET', '/sw.js')).toBe('refuse');
    expect(guestRoute('POST', '/')).toBe('refuse');
    expect(guestRoute('PUT', '/assets/x.js')).toBe('refuse');
  });
});

describe('guestNacStatus', () => {
  const s: NacStatus = {
    checked_at: '2026-11-23T10:05:00+08:00',
    ok: true,
    error: null,
    last_good_at: '2026-11-23T10:05:00+08:00',
    next_check: '2026-11-23T10:15:00+08:00',
    failures: 0,
    unknown_statuses: [],
    mine_on: true,
    locations: [
      {
        key: 'tampines',
        name: 'Tampines Interchange',
        short: 'Tampines',
        nac_name: 'MRT STATION - DTL TAMPINES',
        url: 'https://eservices.nac.gov.sg/Busking/x',
        open: '10:00',
        close: '22:00',
        horizon_end: '2026-11-24',
        bookings: 3,
        days: [
          {
            date: '2026-11-23',
            free: [{ start: '10:00', end: '12:00', new: true }],
            mine: [{ start: '14:00', end: '16:00', status: 'Confirmed' }],
            taken: [
              { start: '12:00', end: '14:00', status: 'Confirmed' },
              { start: '18:00', end: '22:00', status: 'Published' },
            ],
          },
          { date: '2026-11-24', free: [], mine: [{ start: '10:00', end: '22:00', status: 'Published' }], taken: [] },
        ],
      },
    ],
    watching: [{ key: 'tampines', name: 'Tampines Interchange', short: 'Tampines', nac: 'MRT STATION - DTL TAMPINES', url: 'https://eservices.nac.gov.sg/Busking/x' }],
    max_places: 8,
    watches: [{ id: 'w1', place: 'tampines', date: '2026-11-23', start: '18:00', end: '20:00', added_at: '2026-11-23T09:00:00+08:00', freed: null } as unknown as NacStatus['watches'][number]],
    watch_alerts: 'ok',
    fixtures: false,
    running: false,
    queued_at: null,
    can_check: null,
  };

  it('shows your bookings as taken, joined with the ones next to them', () => {
    const g = guestNacStatus(s);
    const [d1, d2] = g.locations[0].days;
    expect(d1.mine).toEqual([]);
    expect(d1.taken).toEqual([
      { start: '12:00', end: '16:00', status: 'Confirmed' },
      { start: '18:00', end: '22:00', status: 'Published' },
    ]);
    expect(d2.taken).toEqual([{ start: '10:00', end: '22:00', status: 'Published' }]);
    // Free windows are untouched.
    expect(d1.free).toEqual(s.locations[0].days[0].free);
  });

  it('sends nothing about your watches, alerts or busker ID', () => {
    const g = guestNacStatus(s);
    expect(g.watches).toEqual([]);
    expect(g.watch_alerts).toBe('off');
    expect(g.mine_on).toBe(false);
    expect(JSON.stringify(g)).not.toContain('w1');
  });

  it('leaves the original alone', () => {
    guestNacStatus(s);
    expect(s.locations[0].days[0].mine).toHaveLength(1);
    expect(s.watches).toHaveLength(1);
  });
});

describe('accessGate', () => {
  /** A small app with routes like Launchpad's behind the gate. */
  const appWith = (page: string | null = '<p>guest page</p>') => {
    const app = new Hono();
    app.use('*', accessGate(makeAccess({ teamDomain: TEAM, aud: AUD, musicAud: MUSIC }, keys), () => page));
    app.get('/healthz', (c) => c.text('ok'));
    app.get('/api/state', (c) => c.json({ secret: true }));
    app.get('/api/nac', (c) => c.json({ mine: true }));
    app.get('/api/guest/nac', (c) => c.json({ guest: true }));
    app.post('/api/guest/nac/check', (c) => c.json({ at: 'soon' }));
    app.get('/assets/app.js', (c) => c.text('js'));
    app.get('*', (c) => c.text('full app page'));
    return app;
  };
  const as = async (aud: string | null) => (aud ? { 'cf-access-jwt-assertion': await sign(aud) } : {});

  it('lets your sign-in reach everything', async () => {
    const app = appWith();
    const h = await as(AUD);
    expect(await (await app.request('/api/state', { headers: h })).json()).toEqual({ secret: true });
    expect(await (await app.request('/', { headers: h })).text()).toBe('full app page');
    expect((await app.request('/api/guest/nac', { headers: h })).status).toBe(200);
  });

  it('gives a music sign-in the page, its files and its two routes, and nothing else', async () => {
    const app = appWith();
    const h = await as(MUSIC);
    for (const p of ['/', '/guest', '/index.html', '/somewhere']) {
      const r = await app.request(p, { headers: h });
      expect(await r.text(), p).toBe('<p>guest page</p>');
      expect(r.headers.get('cache-control')).toBe('no-cache');
    }
    expect(await (await app.request('/assets/app.js', { headers: h })).text()).toBe('js');
    expect(await (await app.request('/api/guest/nac', { headers: h })).json()).toEqual({ guest: true });
    expect((await app.request('/api/guest/nac/check', { method: 'POST', headers: h })).status).toBe(200);
    for (const p of ['/api/state', '/api/nac', '/api/%73tate', '/api/guest/nac/../../state', '/api/guest/nac/..%2f..%2fstate', '//api/state', '/API/state']) {
      const r = await app.request(p, { headers: h });
      const body = await r.text();
      expect(body, p).not.toContain('secret');
      expect(body, p).not.toContain('mine');
    }
  });

  it('refuses a request without a valid token, but not Docker’s health check', async () => {
    const app = appWith();
    expect((await app.request('/api/guest/nac')).status).toBe(403);
    expect((await app.request('/', { headers: await as('someone-else') })).status).toBe(403);
    expect(await (await app.request('/healthz')).text()).toBe('ok');
  });

  it('says so when the page isn’t built', async () => {
    const r = await appWith(null).request('/', { headers: await as(MUSIC) });
    expect(r.status).toBe(404);
  });
});
