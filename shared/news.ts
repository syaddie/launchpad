// What the News view follows, and the reading list. A followed item is one string in
// prefs.newsTopics: plain words search Google News; "rss:<address>", "hn:front",
// "hn:best" and "r/<subreddit>" are feeds that work the same way.
import type { NewsArticle, NewsLists, NewsStory, SavedStory } from './types';

export type NewsSourceKind = 'topic' | 'rss' | 'hn' | 'reddit';

export interface NewsSourceRef {
  kind: NewsSourceKind;
  /** The search words, the feed's address, "front" or "best", or the subreddit. */
  value: string;
  /** What it's called when there's no feed title yet. */
  label: string;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

export const SUBREDDIT = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;

export function parseNewsSource(s: string): NewsSourceRef {
  if (s.startsWith('rss:')) return { kind: 'rss', value: s.slice(4), label: hostOf(s.slice(4)) };
  if (s === 'hn:front') return { kind: 'hn', value: 'front', label: 'Hacker News' };
  if (s === 'hn:best') return { kind: 'hn', value: 'best', label: 'Hacker News best' };
  const r = s.match(/^r\/(.+)$/);
  if (r && SUBREDDIT.test(r[1])) return { kind: 'reddit', value: r[1], label: `r/${r[1]}` };
  return { kind: 'topic', value: s, label: s };
}

/**
 * What someone typed in "Add" as a followed item: a web address is a feed, "r/name" or a
 * Reddit address a subreddit, "hn" or "hn best" Hacker News, and anything else a topic.
 */
export function newsSourceFromInput(input: string): string {
  const t = input.trim().replace(/\s+/g, ' ');
  if (/^(hn|hacker ?news)( front( ?page)?)?$/i.test(t) || /^https?:\/\/news\.ycombinator\.com\/?(news)?$/i.test(t)) return 'hn:front';
  if (/^(hn|hacker ?news) best$/i.test(t) || /^https?:\/\/news\.ycombinator\.com\/best\/?$/i.test(t)) return 'hn:best';
  const sub = t.match(/^\/?r\/([A-Za-z0-9_]+)\/?$/i) ?? t.match(/^(?:https?:\/\/)?(?:www\.|old\.)?reddit\.com\/r\/([A-Za-z0-9_]+)\/?(?:\.rss)?$/i);
  if (sub && SUBREDDIT.test(sub[1])) return `r/${sub[1]}`;
  if (/^https?:\/\/\S+$/i.test(t)) return `rss:${t}`;
  if (/^[\w-]+(\.[\w-]+)+\/\S*(rss|atom|feed|xml)\S*$/i.test(t)) return `rss:https://${t}`;
  return t;
}

/** Key for a followed item in the news cache and the hidden lists. */
export const sourceKey = (s: string) => s.toLowerCase();

/** Same address, give or take the trailing slash, the fragment and tracking tags. */
export function sameUrl(a: string, b: string): boolean {
  return normUrl(a) === normUrl(b);
}

export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (/^utm_|^fbclid$|^gclid$/.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.replace(/^www\./, '').toLowerCase();
    return x.href.replace(/\/$/, '');
  } catch {
    return u.trim();
  }
}

const mutedSet = (l: NewsLists) => new Set(l.muted.map((m) => m.toLowerCase()));

/** Headlines without the ones hidden in this topic or from a muted source. */
export function visibleArticles(topic: string, articles: NewsArticle[], lists: NewsLists): NewsArticle[] {
  const hidden = new Set((lists.hidden[sourceKey(topic)] ?? []).map((h) => normUrl(h.url)));
  const muted = mutedSet(lists);
  return articles.filter((a) => !hidden.has(normUrl(a.url)) && !muted.has(a.source.toLowerCase()));
}

/** A story is hidden once every headline it came from is hidden or muted. */
export function visibleStories(topic: string, stories: NewsStory[], lists: NewsLists): NewsStory[] {
  const hidden = new Set((lists.hidden[sourceKey(topic)] ?? []).map((h) => normUrl(h.url)));
  const muted = mutedSet(lists);
  return stories.filter((s) => !s.links.length || s.links.some((l) => !hidden.has(normUrl(l.url)) && !muted.has(l.source.toLowerCase())));
}

export const EMPTY_NEWS_LISTS: NewsLists = { saved: [], hidden: {}, muted: [] };

const READ_KEPT = 7 * 86_400_000;
const HIDDEN_KEPT = 30 * 86_400_000;
const isStr = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const httpUrl = (v: unknown): v is string => isStr(v) && /^https?:\/\//i.test(v) && v.length <= 2000;

/**
 * The reading list, hidden headlines and muted sources as the store keeps them. Stories marked
 * read stay a week (so one can be found again), hidden headlines a month (they've left their topic by then).
 */
export function cleanNewsLists(v: unknown, now = Date.now()): NewsLists {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<NewsLists>;
  const ids = new Set<string>();
  const saved = (Array.isArray(o.saved) ? o.saved : [])
    .filter((s): s is SavedStory => !!s && isStr(s.id) && isStr(s.title) && httpUrl(s.url) && !ids.has(s.id) && !!ids.add(s.id))
    .map((s): SavedStory => ({
      id: s.id.slice(0, 40),
      title: s.title.trim().slice(0, 300) || s.url,
      url: s.url,
      source: isStr(s.source) ? s.source.slice(0, 100) : '',
      topic: isStr(s.topic) ? s.topic.slice(0, 600) : '',
      summary: isStr(s.summary) ? s.summary.slice(0, 1000) : '',
      savedAt: isTime(s.savedAt) ? s.savedAt : new Date(now).toISOString(),
      readAt: isTime(s.readAt) ? s.readAt : null,
    }))
    .filter((s) => !s.readAt || now - Date.parse(s.readAt) < READ_KEPT)
    .slice(0, 500);
  const hidden: NewsLists['hidden'] = {};
  if (o.hidden && typeof o.hidden === 'object' && !Array.isArray(o.hidden)) {
    for (const [k, list] of Object.entries(o.hidden).slice(0, 50)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter((h) => h && httpUrl(h.url) && isTime(h.at) && now - Date.parse(h.at) < HIDDEN_KEPT).map((h) => ({ url: h.url, at: h.at })).slice(-500);
      if (kept.length) hidden[k.slice(0, 600)] = kept;
    }
  }
  const seen = new Set<string>();
  const muted = (Array.isArray(o.muted) ? o.muted : [])
    .filter(isStr)
    .map((m) => m.trim().slice(0, 100))
    .filter((m) => m && !seen.has(m.toLowerCase()) && !!seen.add(m.toLowerCase()))
    .slice(0, 200);
  return { saved, hidden, muted };
}
