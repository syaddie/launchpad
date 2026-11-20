import { describe, expect, it } from 'vitest';
import { cleanNewsLists, normUrl, parseNewsSource } from '../shared/news';
import { cleanTopics } from '../server/src/clean';
import { blockedIp, checkUrl } from '../server/src/outbound';

// The News view became the daily digest; what it followed is still kept in prefs.newsTopics, and its reading list stays.
describe('what the old News view followed', () => {
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

describe('the reading list', () => {
  const now = Date.parse('2026-11-12T00:00:00Z');

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
