// Instagram links in Server › Downloads: which posts or profile a pasted link means, and
// what the saved files are called. Used by the page (to say what will happen) and the
// server (to do it), so the two never disagree.

/** A profile's newest posts: how many unless another number is picked, and the most. */
export const IG_DEFAULT_LIMIT = 12;
export const IG_MAX_LIMIT = 500;
/** Post links pasted at once. */
export const IG_MAX_POSTS = 50;

export type IgTarget = { posts: string[]; profile: null } | { posts: []; profile: string };
export type IgParse = IgTarget | { error: string };

const SHORTCODE = /^[A-Za-z0-9_-]{5,64}$/;
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
const HOSTS = /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)$/i;
/** Paths on instagram.com that are pages of the site, not someone's profile. */
const NOT_PROFILES = new Set(['about', 'accounts', 'api', 'challenge', 'developer', 'direct', 'explore', 'graphql', 'legal', 'p', 'reel', 'reels', 'stories', 'tv', 'web', 'privacy', 'share', 'session', 'emails', 'help', 'press', 'directory', 'oauth']);

type One = { post: string } | { profile: string } | { error: string } | null;

/** One line: a post, a profile, an Instagram link Launchpad can't use (and why), or not Instagram at all. */
function parseLine(line: string): One {
  const at = /^@([A-Za-z0-9._]{1,30})$/.exec(line);
  if (at) return { profile: at[1].toLowerCase() };
  if (!/^https?:\/\//i.test(line) && /^(?:www\.|m\.)?(?:instagram\.com|instagr\.am)\//i.test(line)) line = 'https://' + line;
  let u: URL;
  try {
    u = new URL(line);
  } catch {
    return null;
  }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !HOSTS.test(u.hostname)) return null;
  const seg = u.pathname.split('/').filter(Boolean);
  // /p/<code>, /reel/<code>, /tv/<code>, and the same after a username (/natgeo/p/<code>).
  const i = seg.findIndex((s) => /^(p|reel|reels|tv)$/i.test(s));
  if (i >= 0 && i <= 1 && seg[i + 1]) return SHORTCODE.test(seg[i + 1]) ? { post: seg[i + 1] } : { error: 'That Instagram link doesn’t say which post.' };
  if (i === 0) return { error: 'That Instagram link doesn’t say which post.' };
  const first = seg[0]?.toLowerCase();
  if (first === 'stories' || first === 's') return { error: 'Stories and highlights don’t download here, only posts, reels and profiles.' };
  if (first === 'share') return { error: 'Open that share link first, then paste the address it lands on.' };
  if (seg.length === 1 && USERNAME.test(seg[0]) && !NOT_PROFILES.has(first!)) return { profile: first! };
  if (seg.length === 2 && USERNAME.test(seg[0]) && /^(reels|tagged|saved)$/i.test(seg[1]) && !NOT_PROFILES.has(first!)) return { profile: first! };
  return { error: 'That Instagram page isn’t a post, reel or profile.' };
}

/**
 * What a pasted box of text asks for: post links (one a line), or one profile (a link to it or
 * @name). Null when it isn't Instagram at all, so it's left to the other kinds of download.
 */
export function parseInstagram(text: string): IgParse | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const parsed = lines.map(parseLine);
  if (parsed.every((p) => p === null)) return null;
  if (parsed.some((p) => p === null)) return { error: 'Paste Instagram links on their own, one a line.' };
  const bad = parsed.find((p) => p && 'error' in p) as { error: string } | undefined;
  if (bad) return bad;
  const posts = [...new Set(parsed.flatMap((p) => (p && 'post' in p ? [p.post] : [])))];
  const profiles = [...new Set(parsed.flatMap((p) => (p && 'profile' in p ? [p.profile] : [])))];
  if (profiles.length && posts.length) return { error: 'Paste post links, or one profile, but not both at once.' };
  if (profiles.length > 1) return { error: 'One profile at a time.' };
  if (profiles.length) return { posts: [], profile: profiles[0] };
  if (posts.length > IG_MAX_POSTS) return { error: `That’s more than ${IG_MAX_POSTS} posts. Paste them in a few goes.` };
  return { posts, profile: null };
}

/** A profile's "newest N": a whole number from 1 to IG_MAX_LIMIT, else the default. */
export function cleanIgLimit(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(IG_MAX_LIMIT, Math.max(1, Math.round(n))) : IG_DEFAULT_LIMIT;
}

/**
 * What a post's photo or video is saved as, the way instaloader names its own downloads
 * ("2026-11-16_07-00-32_UTC.jpg", and _1, _2… for each slide of a carousel), so running
 * the command-line tool on the same folder skips what Launchpad already fetched.
 */
export function igFileName(stem: string, index: number, count: number, ext: string): string {
  const e = /^[a-z0-9]{1,8}$/i.test(ext) ? ext.toLowerCase() : 'jpg';
  return `${stem}${count > 1 ? `_${index + 1}` : ''}.${e}`;
}

/** The list's name for a job before Instagram has said whose posts they are. */
export function igLabel(t: IgTarget, limit: number): string {
  if (t.profile) return `@${t.profile} · newest ${limit}`;
  return t.posts.length === 1 ? `Instagram post ${t.posts[0]}` : `${t.posts.length} Instagram posts`;
}
