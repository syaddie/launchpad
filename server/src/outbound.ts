// Fetching addresses the owner typed in (news feeds) or saved (bookmarks, for the link
// check and their icons). Only http(s), never the server itself, with every redirect
// checked the same way, a time limit and a size cap.
import dns from 'node:dns/promises';
import net from 'node:net';

export const USER_AGENT = 'Mozilla/5.0 (compatible; Launchpad/1.0; personal dashboard)';

/** Why an address couldn't be fetched, in words the page can show. */
export class FetchError extends Error {
  constructor(
    readonly code: 'invalid' | 'blocked' | 'dns' | 'refused' | 'timeout' | 'tls' | 'status' | 'too-big' | 'other',
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Loopback, link-local (cloud metadata lives there) and "this host": the server itself, never fetched. */
export function blockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 0 || (a === 169 && b === 254);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::1' || x === '::') return true;
    if (/^fe[89ab]/.test(x)) return true;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? blockedIp(mapped[1]) : false;
  }
  return false;
}

/** The address as a URL when it's one Launchpad may fetch; throws FetchError otherwise. Looks the host up. */
export async function checkUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new FetchError('invalid', 'That isn’t a web address.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new FetchError('invalid', 'Only http and https addresses work.');
  if (url.username || url.password) throw new FetchError('invalid', 'Addresses with a login in them aren’t fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$/i.test(host)) throw new FetchError('blocked', 'Launchpad doesn’t fetch its own server.');
  if (net.isIP(host)) {
    if (blockedIp(host)) throw new FetchError('blocked', 'Launchpad doesn’t fetch its own server.');
    return url;
  }
  let ips: { address: string }[];
  try {
    ips = await dns.lookup(host, { all: true });
  } catch {
    throw new FetchError('dns', `${host} doesn’t resolve.`);
  }
  if (!ips.length) throw new FetchError('dns', `${host} doesn’t resolve.`);
  if (ips.some((i) => blockedIp(i.address))) throw new FetchError('blocked', 'Launchpad doesn’t fetch its own server.');
  return url;
}

function fetchFailure(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  const err = e as Error & { cause?: { code?: string } };
  if (err.name === 'TimeoutError' || err.name === 'AbortError') return new FetchError('timeout', 'Didn’t answer in time.');
  const code = err.cause?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new FetchError('dns', 'The address doesn’t resolve.');
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new FetchError('refused', 'The server refused the connection.');
  if (code.includes('TIMEOUT')) return new FetchError('timeout', 'Didn’t answer in time.');
  if (/CERT|SSL|TLS/i.test(code)) return new FetchError('tls', 'Its HTTPS certificate isn’t valid.');
  return new FetchError('other', err.message || 'Couldn’t fetch it.');
}

export interface Fetched {
  res: Response;
  /** Where it ended up, after redirects. */
  url: string;
  /** Every address it was sent to on the way, the first one included. */
  hops: string[];
}

/**
 * GET (or HEAD) an address, following up to 5 redirects and checking each. `stopAt` can end
 * the chain early (the link check treats a redirect to a sign-in page as fine).
 */
export async function fetchChecked(raw: string, opts: { method?: 'GET' | 'HEAD'; accept?: string; timeoutMs?: number; stopAt?: (url: URL) => boolean } = {}): Promise<Fetched> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const hops: string[] = [];
  let url = await checkUrl(raw);
  for (let i = 0; ; i++) {
    hops.push(url.href);
    let res: Response;
    try {
      res = await fetch(url, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept ?? '*/*', 'Accept-Language': 'en' },
      });
    } catch (e) {
      throw fetchFailure(e);
    }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return { res, url: url.href, hops };
    res.body?.cancel().catch(() => {});
    if (i >= 5) throw new FetchError('other', 'Too many redirects.');
    const next = new URL(loc, url);
    if (opts.stopAt?.(next)) return { res, url: next.href, hops: [...hops, next.href] };
    url = await checkUrl(next.href);
  }
}

/** The body, up to `max` bytes; throws once it's bigger. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > max) {
    res.body?.cancel().catch(() => {});
    throw new FetchError('too-big', 'That’s too big to read.');
  }
  if (!res.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > max) throw new FetchError('too-big', 'That’s too big to read.');
      parts.push(Buffer.from(chunk));
    }
  } catch (e) {
    res.body.cancel().catch(() => {});
    throw fetchFailure(e);
  }
  return Buffer.concat(parts);
}

/** Fetch and read text, failing on an error status. */
export async function fetchText(raw: string, opts: { accept?: string; max?: number; timeoutMs?: number } = {}): Promise<{ text: string; url: string; type: string }> {
  const { res, url } = await fetchChecked(raw, { accept: opts.accept, timeoutMs: opts.timeoutMs });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    throw new FetchError('status', `It answered ${res.status}.`, res.status);
  }
  const body = await readCapped(res, opts.max ?? 3 * 1024 * 1024);
  return { text: body.toString('utf8'), url, type: res.headers.get('content-type') ?? '' };
}
