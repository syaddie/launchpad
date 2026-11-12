// News tab: headlines per topic from Google News RSS, or from a feed (RSS or Atom,
// Hacker News, a subreddit), and a short digest of them written by Claude when
// ANTHROPIC_API_KEY is set.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { FetchError, fetchText, USER_AGENT } from './outbound';
import { parseNewsSource, SUBREDDIT } from '../../shared/news';
import type { NewsArticle, NewsStory } from '../../shared/types';

// Google News edition. Search results still come from everywhere; this mostly
// sets the language and which local outlets rank first.
const EDITION = 'hl=en-SG&gl=SG&ceid=SG:en';
const MAX_ARTICLES = 20;

// ---------- headlines ----------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

const attr = (el: string, name: string) => {
  const m = el.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decode(m[2] ?? m[3] ?? '') : '';
};

/** Without tags left in a title (some feeds escape their HTML), and the spaces they leave. */
const plain = (s: string) => decode(s.replace(/<[^>]+>/g, ' ')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const iso = (s: string) => {
  const at = Date.parse(s);
  return new Date(Number.isNaN(at) ? Date.now() : at).toISOString();
};

/** Newest first, repeated titles dropped. */
function tidy(all: NewsArticle[]): NewsArticle[] {
  const seen = new Set<string>();
  return all
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((a) => !seen.has(a.title.toLowerCase()) && !!seen.add(a.title.toLowerCase()));
}

/** Parse a Google News RSS feed into articles, newest first, repeated titles dropped. */
export function parseNewsRss(xml: string): NewsArticle[] {
  const all: NewsArticle[] = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const rawSource = tag(item, 'source');
    let title = tag(item, 'title');
    // Google appends " - Outlet" to every title.
    if (rawSource && title.endsWith(` - ${rawSource}`)) title = title.slice(0, -(rawSource.length + 3));
    // A few outlets have their URL as their name.
    const source = /^https?:\/\//.test(rawSource) ? rawSource.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : rawSource;
    const url = tag(item, 'link');
    const at = Date.parse(tag(item, 'pubDate'));
    if (title && url) all.push({ title, url, source, publishedAt: new Date(Number.isNaN(at) ? Date.now() : at).toISOString() });
  }
  return tidy(all);
}

/**
 * Any RSS or Atom feed: its title and its items, newest first. Each item's source is `source`
 * when given (a subreddit), else the outlet an item names, else the feed's title or the link's site.
 */
export function parseFeed(xml: string, source = ''): { title: string; articles: NewsArticle[] } {
  const head = xml.replace(/<(item|entry)\b[\s\S]*$/, '');
  const title = plain(tag(head, 'title'));
  const all: NewsArticle[] = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const t = plain(tag(item, 'title'));
    const guid = item.match(/<guid\b([^>]*)>([\s\S]*?)<\/guid>/);
    const link = tag(item, 'link') || (guid && !/isPermaLink\s*=\s*["']false/i.test(guid[1]) ? decode(guid[2]) : '');
    if (!t || !/^https?:\/\//.test(link)) continue;
    all.push({ title: t.slice(0, 300), url: link, source: source || plain(tag(item, 'source')) || title || hostOf(link), publishedAt: iso(tag(item, 'pubDate') || tag(item, 'dc:date')) });
  }
  for (const [, entry] of xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)) {
    const t = plain(tag(entry, 'title'));
    const links = [...entry.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
    const el = links.find((l) => /\brel\s*=\s*["']alternate/i.test(l)) ?? links.find((l) => !/\brel\s*=/i.test(l)) ?? links[0];
    const link = el ? attr(el, 'href') : '';
    if (!t || !/^https?:\/\//.test(link)) continue;
    all.push({ title: t.slice(0, 300), url: link, source: source || title || hostOf(link), publishedAt: iso(tag(entry, 'published') || tag(entry, 'updated')) });
  }
  return { title: title.slice(0, 100), articles: tidy(all) };
}

export async function fetchHeadlines(topic: string): Promise<NewsArticle[]> {
  // Multi-word topics search as a phrase ("video games", not video + games), unless
  // they already use search syntax. `when:2d` keeps it to the last two days.
  const q = /\s/.test(topic) && !/["()]|\bOR\b/.test(topic) ? `"${topic}"` : topic;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:2d`)}&${EDITION}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Launchpad/1.0 (personal dashboard)' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Google News returned ${res.status}`);
  return parseNewsRss(await res.text()).slice(0, MAX_ARTICLES);
}

/** A feed's title and newest items; throws when the address doesn't answer or isn't a feed. */
export async function fetchFeed(url: string, source = ''): Promise<{ title: string; articles: NewsArticle[] }> {
  const { text, type } = await fetchText(url, { accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' });
  if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 4000))) {
    throw new FetchError('other', /html/i.test(type) ? 'That’s a web page, not a feed. Look for its RSS or Atom link.' : 'That isn’t an RSS or Atom feed.');
  }
  const feed = parseFeed(text, source);
  return { title: feed.title, articles: feed.articles.slice(0, MAX_ARTICLES) };
}

interface HnItem { id: number; title?: string; url?: string; time?: number; dead?: boolean; deleted?: boolean }

/** The top of Hacker News's front page, or its best stories, from its official API. */
export async function fetchHackerNews(which: 'front' | 'best'): Promise<NewsArticle[]> {
  const get = async <T>(url: string): Promise<T> => {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`Hacker News returned ${res.status}`);
    return (await res.json()) as T;
  };
  const ids = (await get<number[]>(`https://hacker-news.firebaseio.com/v0/${which === 'best' ? 'beststories' : 'topstories'}.json`)).slice(0, MAX_ARTICLES);
  const items = await Promise.all(ids.map((id) => get<HnItem | null>(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).catch(() => null)));
  return items
    .filter((i): i is HnItem => !!i && !!i.title && !i.dead && !i.deleted)
    .map((i) => {
      const own = !i.url || !/^https?:\/\//.test(i.url);
      return {
        title: i.title!,
        url: own ? `https://news.ycombinator.com/item?id=${i.id}` : i.url!,
        source: own ? 'Hacker News' : hostOf(i.url!) || 'Hacker News',
        publishedAt: new Date((i.time ?? Date.now() / 1000) * 1000).toISOString(),
      };
    });
}

/** A subreddit's hot posts, from its public feed. */
export async function fetchSubreddit(sub: string): Promise<NewsArticle[]> {
  if (!SUBREDDIT.test(sub)) throw new FetchError('invalid', 'That isn’t a subreddit name.');
  try {
    return (await fetchFeed(`https://www.reddit.com/r/${sub}/.rss`, `r/${sub}`)).articles;
  } catch (e) {
    if (e instanceof FetchError && e.status === 404) throw new FetchError('status', `There’s no r/${sub}.`, 404);
    if (e instanceof FetchError && (e.status === 403 || e.status === 429)) throw new FetchError('status', `Reddit turned the request away (${e.status}); it tries again next hour.`, e.status);
    throw e;
  }
}

/** Headlines for one followed item (see shared/news.ts), and a feed's own title when it has one. */
export async function fetchSource(source: string): Promise<{ title?: string; articles: NewsArticle[] }> {
  const s = parseNewsSource(source);
  if (s.kind === 'rss') return fetchFeed(s.value);
  if (s.kind === 'hn') return { articles: await fetchHackerNews(s.value === 'best' ? 'best' : 'front') };
  if (s.kind === 'reddit') return { articles: await fetchSubreddit(s.value) };
  return { articles: await fetchHeadlines(s.value) };
}

/** Try a feed before it's followed: it must answer and read as one. Returns its title, to show. */
export async function checkSource(source: string): Promise<{ title: string; count: number }> {
  const s = parseNewsSource(source);
  if (s.kind === 'topic') return { title: s.label, count: 0 };
  const r = await fetchSource(source);
  if (!r.articles.length && s.kind === 'rss') throw new FetchError('other', 'That feed has nothing in it.');
  return { title: r.title || s.label, count: r.articles.length };
}

// ---------- summaries ----------

export const summariesEnabled = claudeEnabled;

const SYSTEM = `You write the news digest on a personal dashboard. You get one topic, or one feed (a site's RSS, Hacker News, a subreddit), and a numbered list of recent headlines from it.

Group headlines that report the same story, and write 3 to 6 stories, most significant first. For each story give:
- headline: a short, plain headline of your own (no clickbait, no emoji)
- summary: one or two sentences saying what happened and why it matters to a fan of the topic
- articles: the numbers of the headlines the story is based on

Only use what the headlines say; don't add facts, dates or numbers they don't contain. Leave out ads, listicles and quizzes, and, for a topic, headlines that aren't really about it. In a feed every headline belongs; pick the ones most worth knowing.`;

const SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          headline: { type: 'string' },
          summary: { type: 'string' },
          articles: { type: 'array', items: { type: 'integer' } },
        },
        required: ['headline', 'summary', 'articles'],
        additionalProperties: false,
      },
    },
  },
  required: ['stories'],
  additionalProperties: false,
};

/** `topic` is what's followed, as in prefs.newsTopics; `title` a feed's own name. */
export async function summariseHeadlines(topic: string, articles: NewsArticle[], title?: string): Promise<NewsStory[]> {
  const list = articles.map((a, i) => `[${i}] ${a.title} (${a.source}, ${a.publishedAt.slice(0, 16).replace('T', ' ')} UTC)`).join('\n');
  const s = parseNewsSource(topic);
  const what = s.kind === 'topic' ? `Topic: ${s.value}` : `Feed: ${title || s.label}`;
  const parsed = await askJson<{ stories: { headline: string; summary: string; articles: number[] }[] }>({
    model: config.newsModel,
    system: SYSTEM,
    user: `${what}\n\nHeadlines, newest first:\n${list}`,
    schema: SCHEMA,
    effort: 'low',
    task: 'summarise these headlines',
  });
  return parsed.stories.map((s) => ({
    headline: s.headline,
    summary: s.summary,
    // One link per outlet is enough.
    links: [...new Map(s.articles.filter((i) => articles[i]).map((i) => [articles[i].source, { source: articles[i].source, url: articles[i].url }])).values()],
  }));
}
