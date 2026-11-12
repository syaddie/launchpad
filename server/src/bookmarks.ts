// Bookmarks' housekeeping on the server: the weekly check for links that no longer
// open, and their icons, fetched once and kept in DATA_DIR/favicons so tiles never
// load an icon from another site as they paint, and still have them offline.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { FetchError, fetchChecked, readCapped } from './outbound';
import { asServer, store } from './store';
import type { LinkCheck, LinkProblem } from '../../shared/types';

const DAY = 86_400_000;

// ---------- the link check ----------

/** Sign-in pages, Cloudflare Access's included: a bookmark that lands on one is fine, just behind a login. */
export function isSignIn(url: URL): boolean {
  return (
    /(^|\.)cloudflareaccess\.com$/i.test(url.hostname) ||
    url.pathname.startsWith('/cdn-cgi/access/') ||
    (/^(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|github\.com)$/i.test(url.hostname) && /login|signin|ServiceLogin|oauth|authorize/i.test(url.pathname + url.search)) ||
    /\/(log-?in|sign-?in|auth|sso|oauth2?)(\/|$|\?)/i.test(url.pathname)
  );
}

/** What one answer means for a bookmark: null when it opened (or needs a login), else the problem. */
export function judge(status: number): Omit<LinkProblem, 'at'> | null {
  if (status === 404 || status === 410) return { kind: 'gone', why: `Not found (${status})` };
  if (status >= 500) return { kind: 'failing', why: `Server error (${status})` };
  // 401/403 is a login or a site turning bots away; 429 is a rate limit; other 4xx are usually the same.
  return null;
}

/** Open a bookmark the way a browser would and say whether it's still there. */
export async function checkLink(url: string): Promise<Omit<LinkProblem, 'at'> | null> {
  try {
    const { res } = await fetchChecked(url, { timeoutMs: 15_000, accept: 'text/html,application/xhtml+xml,*/*;q=0.8', stopAt: isSignIn });
    res.body?.cancel().catch(() => {});
    return judge(res.status);
  } catch (e) {
    const err = e instanceof FetchError ? e : new FetchError('other', (e as Error).message);
    // Addresses the server won't fetch (its own, or not the web) aren't checked.
    if (err.code === 'blocked' || err.code === 'invalid') return null;
    if (err.code === 'dns') return { kind: 'gone', why: 'The address doesn’t resolve' };
    if (err.code === 'timeout') return { kind: 'failing', why: 'Didn’t answer in 15 seconds' };
    if (err.code === 'refused') return { kind: 'failing', why: 'Refused the connection' };
    if (err.code === 'tls') return { kind: 'failing', why: 'Its HTTPS certificate isn’t valid' };
    return { kind: 'failing', why: err.message };
  }
}

let checking: Promise<void> | null = null;
export const linkCheckRunning = () => !!checking;

/** Check every bookmark, six at a time. One that fails gets a second try before it's flagged. */
export function checkLinks(): Promise<void> {
  if (checking) return checking;
  checking = asServer(async () => {
    const prev = store.linkCheck();
    store.setLinkCheck({ ...prev, running: true });
    const urls = [...new Set(store.bookmarks().flatMap((g) => g.items.map((b) => b.url)).filter((u) => /^https?:\/\//i.test(u)))];
    const problems: LinkCheck['problems'] = {};
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++];
        let p = await checkLink(url);
        if (p) {
          await new Promise((r) => setTimeout(r, 3000));
          p = await checkLink(url);
        }
        if (p) problems[url] = { ...p, at: new Date().toISOString() };
      }
    };
    try {
      await Promise.all(Array.from({ length: 6 }, worker));
      store.setLinkCheck({ checkedAt: new Date().toISOString(), running: false, problems });
      console.log(`[bookmarks] checked ${urls.length} link(s), ${Object.keys(problems).length} look broken`);
    } catch (e) {
      console.error('[bookmarks] link check failed:', (e as Error).message);
      store.setLinkCheck({ ...store.linkCheck(), running: false });
    }
  }).finally(() => {
    checking = null;
  });
  return checking;
}

/** Weekly, checked hourly so a restart doesn't skip one. A check cut short by a restart is marked as over. */
export function startLinkChecks(): void {
  if (store.linkCheck().running) store.setLinkCheck({ ...store.linkCheck(), running: false });
  const due = () => {
    const last = store.linkCheck().checkedAt;
    if (!last || Date.now() - Date.parse(last) > 7 * DAY) checkLinks();
  };
  setTimeout(due, 5 * 60_000);
  setInterval(due, 60 * 60_000);
}

// ---------- favicons ----------

const iconDir = path.join(config.dataDir, 'favicons');
fs.mkdirSync(iconDir, { recursive: true });

/** Icons are fetched again after a month; a site without one is asked again after a week. */
const ICON_FRESH = 30 * DAY;
const MISS_FRESH = 7 * DAY;
const MAX_ICON = 300 * 1024;

const iconFile = (host: string) => path.join(iconDir, createHash('sha256').update(host.toLowerCase()).digest('hex').slice(0, 32));

/** The icon's type from its first bytes: PNG, JPEG, GIF, WebP, ICO or SVG; null for anything else. */
export function sniffIcon(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0) return 'image/x-icon';
  const head = Buffer.from(b.subarray(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg\b/i.test(head)) return 'image/svg+xml';
  return null;
}

/** The icon links in a page's head, best first: big touch icons, then sized icons by size, then the rest. */
export function iconLinks(html: string, base: string): string[] {
  const found: { href: string; rank: number }[] = [];
  for (const [el] of html.slice(0, 200_000).matchAll(/<link\b[^>]*>/gi)) {
    const rel = el.match(/\brel\s*=\s*["']?([^"'>]+)/i)?.[1].toLowerCase() ?? '';
    if (!/\bicon\b|apple-touch-icon/.test(rel) || /mask-icon/.test(rel)) continue;
    const href = el.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
    const raw = href ? (href[2] ?? href[3] ?? href[4] ?? '').replace(/&amp;/g, '&') : '';
    if (!raw || raw.startsWith('data:')) continue;
    let url: string;
    try {
      url = new URL(raw, base).href;
    } catch {
      continue;
    }
    const size = Number(el.match(/\bsizes\s*=\s*["']?(\d+)x\d+/i)?.[1] ?? 0);
    const rank = rel.includes('apple-touch-icon') ? 180 : size || (/\.svg(\?|$)/i.test(url) ? 64 : 16);
    found.push({ href: url, rank });
  }
  // Big enough for a 30 px tile on a sharp screen, but the smallest of those.
  const score = (r: number) => (r >= 32 ? 1000 - r : r);
  return [...new Set(found.sort((a, b) => score(b.rank) - score(a.rank)).map((f) => f.href))];
}

async function tryIcon(url: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const { res } = await fetchChecked(url, { timeoutMs: 10_000, accept: 'image/*,*/*;q=0.5' });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      return null;
    }
    const bytes = await readCapped(res, MAX_ICON);
    const mime = sniffIcon(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

/** The site's own icon (from its page, or /favicon.ico), else the one Google keeps for it. */
async function findIcon(origin: string, host: string): Promise<{ bytes: Buffer; mime: string } | null> {
  try {
    const { res, url } = await fetchChecked(origin + '/', { timeoutMs: 10_000, accept: 'text/html', stopAt: isSignIn });
    if (res.ok && /html/i.test(res.headers.get('content-type') ?? '')) {
      const html = (await readCapped(res, 512 * 1024)).toString('utf8');
      for (const link of iconLinks(html, url).slice(0, 4)) {
        const got = await tryIcon(link);
        if (got) return got;
      }
    } else res.body?.cancel().catch(() => {});
  } catch {
    // No page: try the usual places.
  }
  return (await tryIcon(origin + '/favicon.ico')) ?? (await tryIcon(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`));
}

const fetching = new Map<string, Promise<boolean>>();

function readIcon(file: string): { bytes: Buffer; mime: string } | null {
  try {
    const bytes = fs.readFileSync(file);
    const mime = sniffIcon(bytes);
    return mime ? { bytes, mime } : null;
  } catch {
    return null;
  }
}

/** The bookmark address with this host, so the icon is fetched over the scheme and port it uses. */
function originFor(host: string): string | null {
  for (const g of store.bookmarks()) {
    for (const b of g.items) {
      try {
        const u = new URL(b.url);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === host) return u.origin;
      } catch {
        // Not a web address.
      }
    }
  }
  return null;
}

/**
 * The icon for a bookmarked host: the kept copy, fetched now when there's none, and fetched
 * again in the background once it's a month old. Only hosts among the bookmarks are fetched.
 */
export async function favicon(rawHost: string): Promise<{ bytes: Buffer; mime: string } | null> {
  const host = rawHost.toLowerCase();
  const origin = originFor(host);
  if (!origin) return null;
  const file = iconFile(host);
  const miss = file + '.none';
  const age = (f: string) => {
    try {
      return Date.now() - fs.statSync(f).mtimeMs;
    } catch {
      return Infinity;
    }
  };
  const refresh = () => {
    let p = fetching.get(host);
    if (!p) {
      p = findIcon(origin, host)
        .then((got) => {
          if (got) {
            fs.writeFileSync(file, got.bytes);
            fs.rmSync(miss, { force: true });
          } else if (!fs.existsSync(file)) fs.writeFileSync(miss, '');
          return !!got;
        })
        .catch(() => false)
        .finally(() => fetching.delete(host));
      fetching.set(host, p);
    }
    return p;
  };
  const kept = readIcon(file);
  if (kept) {
    if (age(file) > ICON_FRESH) refresh();
    return kept;
  }
  if (age(miss) < MISS_FRESH) return null;
  await refresh();
  return readIcon(file);
}

/** Icons of hosts no bookmark uses any more, once they've been kept a month. */
export function sweepFavicons(now = Date.now()): number {
  const used = new Set<string>();
  for (const g of store.bookmarks()) {
    for (const b of g.items) {
      try {
        used.add(path.basename(iconFile(new URL(b.url).host)));
      } catch {
        // Not a web address.
      }
    }
  }
  let removed = 0;
  for (const f of fs.readdirSync(iconDir)) {
    if (used.has(f.replace(/\.none$/, ''))) continue;
    const p = path.join(iconDir, f);
    try {
      if (now - fs.statSync(p).mtimeMs < ICON_FRESH) continue;
      fs.rmSync(p, { force: true });
      removed++;
    } catch {
      // Gone already.
    }
  }
  return removed;
}
