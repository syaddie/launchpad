// News tab: headlines per topic from Google News RSS, and a short digest of
// them written by Claude when ANTHROPIC_API_KEY is set.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
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
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .trim();
}

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : '';
};

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
  const seen = new Set<string>();
  return all
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .filter((a) => !seen.has(a.title.toLowerCase()) && !!seen.add(a.title.toLowerCase()));
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

// ---------- summaries ----------

export const summariesEnabled = claudeEnabled;

const SYSTEM = `You write the news digest on a personal dashboard. You get one topic and a numbered list of recent headlines about it.

Group headlines that report the same story, and write 3 to 6 stories, most significant first. For each story give:
- headline: a short, plain headline of your own (no clickbait, no emoji)
- summary: one or two sentences saying what happened and why it matters to a fan of the topic
- articles: the numbers of the headlines the story is based on

Only use what the headlines say; don't add facts, dates or numbers they don't contain. Leave out headlines that aren't really about the topic, ads, listicles and quizzes.`;

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

export async function summariseHeadlines(topic: string, articles: NewsArticle[]): Promise<NewsStory[]> {
  const list = articles.map((a, i) => `[${i}] ${a.title} (${a.source}, ${a.publishedAt.slice(0, 16).replace('T', ' ')} UTC)`).join('\n');
  const parsed = await askJson<{ stories: { headline: string; summary: string; articles: number[] }[] }>({
    model: config.newsModel,
    system: SYSTEM,
    user: `Topic: ${topic}\n\nHeadlines, newest first:\n${list}`,
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
