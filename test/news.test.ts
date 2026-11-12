import { describe, expect, it } from 'vitest';
import { cleanNewsLists, newsSourceFromInput, normUrl, parseNewsSource, visibleArticles, visibleStories } from '../shared/news';
import type { NewsArticle, NewsLists } from '../shared/types';
import { cleanTopics } from '../server/src/clean';
import { parseFeed } from '../server/src/news';
import { blockedIp, checkUrl } from '../server/src/outbound';

describe('what the News view follows', () => {
  it('reads what was typed as a topic or a feed', () => {
    expect(newsSourceFromInput('Formula 1')).toBe('Formula 1');
    expect(newsSourceFromInput('https://example.com/feed.xml')).toBe('rss:https://example.com/feed.xml');
    expect(newsSourceFromInput('blog.example.com/rss')).toBe('rss:https://blog.example.com/rss');
    expect(newsSourceFromInput('r/singapore')).toBe('r/singapore');
    expect(newsSourceFromInput('https://www.reddit.com/r/programming/')).toBe('r/programming');
    expect(newsSourceFromInput('hn')).toBe('hn:front');
    expect(newsSourceFromInput('Hacker News best')).toBe('hn:best');
    expect(newsSourceFromInput('https://news.ycombinator.com/')).toBe('hn:front');
  });

  it('names each kind', () => {
    expect(parseNewsSource('rss:https://www.example.com/feed')).toMatchObject({ kind: 'rss', label: 'example.com' });
    expect(parseNewsSource('hn:best')).toMatchObject({ kind: 'hn', value: 'best' });
    expect(parseNewsSource('r/sg')).toMatchObject({ kind: 'reddit', value: 'sg', label: 'r/sg' });
    // Not a valid subreddit name: just words to search for.
    expect(parseNewsSource('r/a b').kind).toBe('topic');
    expect(parseNewsSource('K-pop')).toMatchObject({ kind: 'topic', value: 'K-pop' });
  });

  it('keeps topics and feeds that make sense, at most 12', () => {
    expect(cleanTopics(['K-pop', 'k-pop', ' Video  games ', 'rss:https://example.com/feed', 'rss:javascript:alert(1)', 'rss:https://nodots/feed', 'hn:nope', 'hn:best', 'r/sg'])).toEqual([
      'K-pop', 'Video games', 'rss:https://example.com/feed', 'hn:best', 'r/sg',
    ]);
    expect(cleanTopics(['rss:http://192.168.1.5:8080/feed'])).toEqual(['rss:http://192.168.1.5:8080/feed']);
    expect(cleanTopics(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(12);
    expect(cleanTopics(['x'.repeat(80)])[0]).toHaveLength(60);
  });
});

describe('reading feeds', () => {
  it('reads RSS with its title, guids as links and escaped HTML in titles', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Example Blog</title>
      <item><title>First &amp;lt;b&amp;gt;post&amp;lt;/b&amp;gt;</title><link>https://example.com/1</link><pubDate>Tue, 27 Oct 2026 01:00:00 GMT</pubDate></item>
      <item><title><![CDATA[Second post]]></title><guid isPermaLink="true">https://example.com/2</guid><pubDate>Wed, 28 Oct 2026 01:00:00 GMT</pubDate></item>
      <item><title>No link</title><guid isPermaLink="false">abc</guid></item>
    </channel></rss>`;
    const f = parseFeed(xml);
    expect(f.title).toBe('Example Blog');
    expect(f.articles.map((a) => a.title)).toEqual(['Second post', 'First post']);
    expect(f.articles[0]).toMatchObject({ url: 'https://example.com/2', source: 'Example Blog', publishedAt: '2026-10-28T01:00:00.000Z' });
  });

  it('reads Atom, picking the page link over others', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Dev Notes</title><link href="https://dev.example/"/>
      <entry><title>Release 2.0</title><link rel="self" href="https://dev.example/feed/2"/><link rel="alternate" href="https://dev.example/2"/><updated>2026-11-01T10:00:00Z</updated></entry>
      <entry><title>Release 1.0</title><link href='https://dev.example/1'/><published>2026-10-01T10:00:00Z</published></entry>
    </feed>`;
    const f = parseFeed(xml, 'r/dev');
    expect(f.title).toBe('Dev Notes');
    expect(f.articles).toEqual([
      { title: 'Release 2.0', url: 'https://dev.example/2', source: 'r/dev', publishedAt: '2026-11-01T10:00:00.000Z' },
      { title: 'Release 1.0', url: 'https://dev.example/1', source: 'r/dev', publishedAt: '2026-10-01T10:00:00.000Z' },
    ]);
  });

  it('gives nothing for something that isn’t a feed', () => {
    expect(parseFeed('<html><head><title>Hi</title></head><body>no</body></html>').articles).toEqual([]);
  });
});

describe('hiding, muting and saving', () => {
  const art = (url: string, source = 'CNA'): NewsArticle => ({ title: url, url, source, publishedAt: '2026-11-01T00:00:00.000Z' });
  const now = Date.parse('2026-11-12T00:00:00Z');
  const lists: NewsLists = { saved: [], hidden: { 'k-pop': [{ url: 'https://a.example/1?utm_source=x', at: '2026-11-11T00:00:00Z' }] }, muted: ['the onion'] };

  it('leaves out hidden headlines, in their topic only, and muted sources everywhere', () => {
    const list = [art('https://www.a.example/1/'), art('https://a.example/2'), art('https://a.example/3', 'The Onion')];
    expect(visibleArticles('K-pop', list, lists).map((a) => a.url)).toEqual(['https://a.example/2']);
    expect(visibleArticles('Games', list, lists).map((a) => a.url)).toEqual(['https://www.a.example/1/', 'https://a.example/2']);
  });

  it('hides a story once every headline it came from is hidden', () => {
    const stories = [
      { headline: 'A', summary: '', links: [{ source: 'CNA', url: 'https://a.example/1' }] },
      { headline: 'B', summary: '', links: [{ source: 'CNA', url: 'https://a.example/1' }, { source: 'ST', url: 'https://b.example/1' }] },
    ];
    expect(visibleStories('k-pop', stories, lists).map((s) => s.headline)).toEqual(['B']);
  });

  it('treats tracking tags, the fragment and a trailing slash as the same address', () => {
    expect(normUrl('https://www.x.example/a/?utm_medium=y#top')).toBe(normUrl('https://x.example/a'));
  });

  it('keeps read stories a week and hidden headlines a month', () => {
    const v = cleanNewsLists({
      saved: [
        { id: 'a', title: 'Keep', url: 'https://x.example/1', savedAt: '2026-11-01T00:00:00Z', readAt: null },
        { id: 'b', title: 'Read lately', url: 'https://x.example/2', savedAt: '2026-11-01T00:00:00Z', readAt: '2026-11-10T00:00:00Z' },
        { id: 'c', title: 'Read long ago', url: 'https://x.example/3', savedAt: '2026-10-01T00:00:00Z', readAt: '2026-10-02T00:00:00Z' },
        { id: 'd', title: 'Not a web page', url: 'javascript:alert(1)', savedAt: '2026-11-01T00:00:00Z' },
        { id: 'a', title: 'Same id twice', url: 'https://x.example/4' },
      ],
      hidden: { t: [{ url: 'https://x.example/old', at: '2026-09-01T00:00:00Z' }, { url: 'https://x.example/new', at: '2026-11-10T00:00:00Z' }], empty: [] },
      muted: ['CNA', 'cna', '', 3],
    }, now);
    expect(v.saved.map((s) => s.id)).toEqual(['a', 'b']);
    expect(v.saved[0]).toMatchObject({ source: '', topic: '', summary: '', readAt: null });
    expect(v.hidden).toEqual({ t: [{ url: 'https://x.example/new', at: '2026-11-10T00:00:00Z' }] });
    expect(v.muted).toEqual(['CNA']);
    expect(cleanNewsLists(null)).toEqual({ saved: [], hidden: {}, muted: [] });
  });
});

describe('what the server fetches', () => {
  it('never fetches itself', async () => {
    for (const ip of ['127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', 'fe80::1', '::ffff:127.0.0.1']) expect(blockedIp(ip), ip).toBe(true);
    for (const ip of ['192.168.1.10', '8.8.8.8', '2606:4700::1111']) expect(blockedIp(ip), ip).toBe(false);
    await expect(checkUrl('http://localhost:8787/api/state')).rejects.toThrow(/own server/);
    await expect(checkUrl('http://127.0.0.1/')).rejects.toThrow(/own server/);
    await expect(checkUrl('http://[::1]:8080/')).rejects.toThrow(/own server/);
    await expect(checkUrl('file:///etc/passwd')).rejects.toThrow(/http/);
    await expect(checkUrl('https://user:pw@example.com/')).rejects.toThrow(/login/);
    expect((await checkUrl('http://192.168.1.10:8080/feed')).port).toBe('8080');
  });
});
