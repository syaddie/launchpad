import { useEffect, useRef, useState } from 'react';
import { newsSourceFromInput, normUrl, parseNewsSource, sourceKey, visibleArticles, visibleStories } from '../../../shared/news';
import type { AppState, NewsArticle, NewsLists, NewsStory, NewsTopic, SavedStory } from '../../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useToast';
import { ago } from '../util';

interface Props {
  data: AppState;
  now: Date;
  busy: boolean;
  onRefresh: () => void;
  onTopics: (topics: string[]) => void;
  /** The reading list, hidden headlines or muted sources changed on the server. */
  onLists: (lists: NewsLists) => void;
  notify: Notify;
  /** Goes up when ⌘K asks for the reading list. */
  readingSignal: number;
}

/** Most topics and feeds followed; the server keeps to the same. */
const MAX_TOPICS = 12;

const ICONS: Record<string, string> = { topic: '', rss: 'ph-rss', hn: 'ph-newspaper', reddit: 'ph-reddit-logo' };

/** What a followed item is called: a feed's own title once fetched, else what it is. */
export function topicLabel(topic: string, news: NewsTopic[]): string {
  return news.find((n) => n.topic === topic)?.title || parseNewsSource(topic).label;
}

export function News({ data, now, busy, onRefresh, onTopics, onLists, notify, readingSignal }: Props) {
  const topics = data.prefs.newsTopics;
  const st = data.sync.news;
  const lists = data.newsLists;
  const [tab, setTab] = useState<'news' | 'reading'>('news');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const [checking, setChecking] = useState(false);
  const [addError, setAddError] = useState('');
  const [mutedOpen, setMutedOpen] = useState(false);
  const cancelled = useRef(false);
  const unread = lists.saved.filter((s) => !s.readAt).length;

  useEffect(() => {
    if (readingSignal) setTab('reading');
  }, [readingSignal]);

  const done = () => {
    setDraft('');
    setAddError('');
    setAdding(false);
  };

  const add = () => {
    const typed = cancelled.current ? '' : draft.trim();
    cancelled.current = false;
    if (!typed) return done();
    const source = newsSourceFromInput(typed);
    if (topics.some((x) => x.toLowerCase() === source.toLowerCase())) return done();
    if (parseNewsSource(source).kind === 'topic') {
      onTopics([...topics, source]);
      return done();
    }
    // A feed is tried first, so one that doesn't work says why instead of sitting there broken.
    setChecking(true);
    api
      .checkNewsSource(source)
      .then((r) => {
        onTopics([...topics, r.source]);
        notify(`Following ${r.title}${r.count ? ` (${r.count} headline${r.count === 1 ? '' : 's'} now)` : ''}.`);
        done();
      })
      .catch((e) => setAddError(e.message))
      .finally(() => setChecking(false));
  };

  const act = (p: Promise<NewsLists>, msg?: string, undo?: () => Promise<NewsLists>) =>
    p
      .then((l) => {
        onLists(l);
        if (msg) notify(msg, undo ? { label: 'Undo', run: () => undo().then(onLists).catch((e) => notify(`Couldn’t undo: ${e.message}`)) } : undefined);
      })
      .catch((e) => notify(`Couldn’t save that: ${e.message}`));

  const savedUrls = new Set(lists.saved.filter((s) => !s.readAt).map((s) => normUrl(s.url)));
  const handlers: PanelHandlers = {
    save: (s) => {
      const had = lists.saved.find((x) => normUrl(x.url) === normUrl(s.url) && !x.readAt);
      if (had) act(api.removeStory(had.id), 'Taken off the reading list.');
      else act(api.saveStory(s), 'Saved to the reading list.');
    },
    hide: (topic, urls, what) => act(api.hideNews(topic, urls, true), `Hid ${what}.`, () => api.hideNews(topic, urls, false)),
    unhide: (topic, urls) => act(api.hideNews(topic, urls, false)),
    mute: (source) => act(api.muteSource(source, true), `Muted ${source} everywhere.`, () => api.muteSource(source, false)),
  };

  return (
    <main className="news" aria-label="News">
      <div className="news-head">
        <div className="news-topics">
          <div className="tabs news-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'news'} className={'tab' + (tab === 'news' ? ' active' : '')} onClick={() => setTab('news')}>
              Following
            </button>
            <button role="tab" aria-selected={tab === 'reading'} className={'tab' + (tab === 'reading' ? ' active' : '')} onClick={() => setTab('reading')}>
              Reading list{unread ? <span className="tab-count tnum">{unread}</span> : null}
            </button>
          </div>
          {tab === 'news' && (
            <>
              {topics.map((t) => {
                const kind = parseNewsSource(t).kind;
                const label = topicLabel(t, data.news);
                return (
                  <span key={t} className="topic-chip" title={kind === 'rss' ? t.slice(4) : undefined}>
                    {ICONS[kind] && <i className={'ph-duotone ' + ICONS[kind]} style={{ marginRight: 4, color: 'var(--t3)' }} />}
                    {label}
                    <button title={`Stop following ${label}`} aria-label={`Remove ${label}`} onClick={() => onTopics(topics.filter((x) => x !== t))}>
                      <i className="ph-duotone ph-x" />
                    </button>
                  </span>
                );
              })}
              {adding ? (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <input
                    className={'input sm' + (addError ? ' bad' : '')}
                    style={{ width: 260 }}
                    autoFocus
                    value={draft}
                    disabled={checking}
                    placeholder="Topic, feed address, r/subreddit or hn"
                    maxLength={500}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setAddError('');
                    }}
                    onBlur={() => !addError && !checking && add()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') add();
                      if (e.key === 'Escape') {
                        e.stopPropagation();
                        cancelled.current = true;
                        if (addError) done();
                        else e.currentTarget.blur();
                      }
                    }}
                  />
                  {checking && <span className="meta">Trying the feed…</span>}
                  {addError && <span className="meta" style={{ color: 'var(--wn)', maxWidth: 360 }}>{addError}</span>}
                </span>
              ) : (
                topics.length < MAX_TOPICS && (
                  <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)} title="A topic to search Google News for, an RSS or Atom feed's address, a subreddit (r/name) or Hacker News (hn, or hn best)">
                    <i className="ph-duotone ph-plus" />
                    Add
                  </button>
                )
              )}
            </>
          )}
        </div>
        <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 10, position: 'relative' }}>
          {!data.newsSummaries && <span>Headlines only · set ANTHROPIC_API_KEY on the server for summaries</span>}
          {lists.muted.length > 0 && (
            <button className="btn-link" style={{ textDecoration: 'none' }} onClick={() => setMutedOpen(!mutedOpen)} aria-expanded={mutedOpen}>
              {lists.muted.length} muted
            </button>
          )}
          {mutedOpen && lists.muted.length > 0 && (
            <div className="popover menu news-muted" onMouseLeave={() => setMutedOpen(false)}>
              {lists.muted.map((m) => (
                <button key={m} onClick={() => act(api.muteSource(m, false), `${m} isn’t muted any more.`)} title={`Show ${m} again`}>
                  <i className="ph-duotone ph-speaker-high" />
                  {m}
                </button>
              ))}
            </div>
          )}
          {st.lastError && <span style={{ color: 'var(--wn)' }} title={st.lastError}>Couldn’t update</span>}
          <span>{busy ? 'Updating…' : st.lastSuccess ? `Updated ${ago(st.lastSuccess, now)}` : ''}</span>
          <button className="icon-btn md" title="Refresh news" disabled={busy || !topics.length} onClick={onRefresh}>
            <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
          </button>
        </div>
      </div>

      {tab === 'reading' ? (
        <ReadingList lists={lists} now={now} news={data.news} act={act} />
      ) : topics.length ? (
        <div className="news-grid">
          {data.news.map((n) => (
            <TopicPanel key={n.topic} n={n} now={now} lists={lists} savedUrls={savedUrls} on={handlers} />
          ))}
        </div>
      ) : (
        <div className="panel">
          <div className="empty">
            <p>Follow a topic or a feed to get a short digest of its news here: words to search Google News for, an RSS or Atom feed’s address, a subreddit like r/singapore, or Hacker News.</p>
            <button className="btn btn-secondary" onClick={() => setAdding(true)}>
              Add
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

interface PanelHandlers {
  save: (s: { title: string; url: string; source: string; topic: string; summary: string }) => void;
  hide: (topic: string, urls: string[], what: string) => void;
  unhide: (topic: string, urls: string[]) => void;
  mute: (source: string) => void;
}

function TopicPanel({ n, now, lists, savedUrls, on }: { n: NewsTopic; now: Date; lists: NewsLists; savedUrls: Set<string>; on: PanelHandlers }) {
  const [allOpen, setAllOpen] = useState(false);
  const loading = !n.fetchedAt && !n.error;
  const label = n.title || parseNewsSource(n.topic).label;
  const articles = visibleArticles(n.topic, n.articles, lists);
  const stories = n.stories ? visibleStories(n.topic, n.stories, lists) : null;
  const hiddenHere = new Set((lists.hidden[sourceKey(n.topic)] ?? []).map((h) => normUrl(h.url)));
  const hiddenNow = n.articles.filter((a) => hiddenHere.has(normUrl(a.url)));

  return (
    <section className="panel" aria-label={label}>
      <div className="panel-head">
        <h2 className="panel-title">{label}</h2>
        {n.summarisedAt && <span className="meta">Summary from {ago(n.summarisedAt, now)}</span>}
      </div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {n.error && (
          <div className="news-note" style={{ color: 'var(--wn)' }}>
            {n.fetchedAt && n.articles.length ? `${n.error.replace(/\.$/, '')}. Showing the headlines from ${ago(n.fetchedAt, now)}.` : n.error}
          </div>
        )}
        {loading && <div className="news-note">Fetching headlines…</div>}
        {!loading && !n.error && !n.articles.length && <div className="news-note">{parseNewsSource(n.topic).kind === 'topic' ? 'No news in the last two days.' : 'Nothing in this feed right now.'}</div>}

        {stories?.map((s, i) => <Story key={i} s={s} topic={n.topic} saved={savedUrls.has(normUrl(s.links[0]?.url ?? ''))} on={on} />)}

        {stories && articles.length > 0 ? (
          <>
            <button className="section-toggle" style={{ cursor: 'pointer' }} onClick={() => setAllOpen(!allOpen)}>
              <span className="label">All headlines</span>
              <span>{articles.length}</span>
              <i className={'ph-duotone ' + (allOpen ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
            </button>
            {allOpen && articles.map((a) => <Headline key={a.url} a={a} now={now} topic={n.topic} saved={savedUrls.has(normUrl(a.url))} on={on} />)}
          </>
        ) : (
          articles.map((a) => <Headline key={a.url} a={a} now={now} topic={n.topic} saved={savedUrls.has(normUrl(a.url))} on={on} />)
        )}
        {hiddenNow.length > 0 && (
          <button className="btn-link news-unhide" onClick={() => on.unhide(n.topic, hiddenNow.map((a) => a.url))}>
            {hiddenNow.length} hidden · show again
          </button>
        )}
      </div>
    </section>
  );
}

function Story({ s, topic, saved, on }: { s: NewsStory; topic: string; saved: boolean; on: PanelHandlers }) {
  const first = s.links[0];
  return (
    <article className="story">
      <div className="story-top">
        <div className="story-headline">{s.headline}</div>
        <span className="news-actions">
          {first && (
            <button
              className={'icon-btn' + (saved ? ' on' : '')}
              title={saved ? 'Saved · take it off the reading list' : 'Save for later'}
              aria-label={saved ? 'Take off the reading list' : 'Save for later'}
              onClick={() => on.save({ title: s.headline, url: first.url, source: s.links.map((l) => l.source).filter(Boolean).join(', '), topic, summary: s.summary })}
            >
              <i className={(saved ? 'ph-fill' : 'ph-duotone') + ' ph-bookmark-simple'} />
            </button>
          )}
          {s.links.length > 0 && (
            <button className="icon-btn" title="Hide this story" aria-label="Hide this story" onClick={() => on.hide(topic, s.links.map((l) => l.url), 'the story')}>
              <i className="ph-duotone ph-eye-slash" />
            </button>
          )}
        </span>
      </div>
      <p className="story-summary">{s.summary}</p>
      {s.links.length > 0 && (
        <div className="story-links">
          {s.links.map((l, j) => (
            <a key={j} href={l.url} target="_blank" rel="noopener">
              {l.source || 'Source'}
            </a>
          ))}
        </div>
      )}
    </article>
  );
}

function Headline({ a, now, topic, saved, on }: { a: NewsArticle; now: Date; topic: string; saved: boolean; on: PanelHandlers }) {
  return (
    <div className="headline-row">
      <a className="headline" href={a.url} target="_blank" rel="noopener">
        <span className="headline-title">{a.title}</span>
        <span className="headline-meta">
          {a.source} · {ago(a.publishedAt, now)}
        </span>
      </a>
      <span className="news-actions">
        <button
          className={'icon-btn' + (saved ? ' on' : '')}
          title={saved ? 'Saved · take it off the reading list' : 'Save for later'}
          aria-label={saved ? 'Take off the reading list' : 'Save for later'}
          onClick={() => on.save({ title: a.title, url: a.url, source: a.source, topic, summary: '' })}
        >
          <i className={(saved ? 'ph-fill' : 'ph-duotone') + ' ph-bookmark-simple'} />
        </button>
        <button className="icon-btn" title="Hide this headline" aria-label="Hide this headline" onClick={() => on.hide(topic, [a.url], 'the headline')}>
          <i className="ph-duotone ph-eye-slash" />
        </button>
        {a.source && (
          <button className="icon-btn" title={`Mute ${a.source} everywhere`} aria-label={`Mute ${a.source}`} onClick={() => on.mute(a.source)}>
            <i className="ph-duotone ph-speaker-slash" />
          </button>
        )}
      </span>
    </div>
  );
}

function ReadingList({ lists, now, news, act }: {
  lists: NewsLists;
  now: Date;
  news: NewsTopic[];
  act: (p: Promise<NewsLists>, msg?: string, undo?: () => Promise<NewsLists>) => void;
}) {
  const [readOpen, setReadOpen] = useState(false);
  const toRead = lists.saved.filter((s) => !s.readAt);
  const read = lists.saved.filter((s) => s.readAt).sort((a, b) => b.readAt!.localeCompare(a.readAt!));
  const item = (s: SavedStory) => (
    <div key={s.id} className={'reading-item' + (s.readAt ? ' read' : '')}>
      <button
        className={'check' + (s.readAt ? ' on' : '')}
        aria-label={s.readAt ? 'Mark not read' : 'Mark read'}
        title={s.readAt ? 'Mark not read' : 'Mark read'}
        onClick={() => act(api.markStoryRead(s.id, !s.readAt), s.readAt ? undefined : 'Marked read.', s.readAt ? undefined : () => api.markStoryRead(s.id, false))}
      >
        {s.readAt && <i className="ph-duotone ph-check" />}
      </button>
      <div className="reading-body">
        <a href={s.url} target="_blank" rel="noopener" className="story-headline">
          {s.title}
        </a>
        {s.summary && <p className="story-summary">{s.summary}</p>}
        <span className="headline-meta">
          {[s.source, s.topic && topicLabel(s.topic, news), `saved ${ago(s.savedAt, now)}`].filter(Boolean).join(' · ')}
        </span>
      </div>
      <button
        className="icon-btn"
        title="Remove"
        aria-label="Remove"
        onClick={() => act(api.removeStory(s.id), 'Removed from the reading list.', () => api.saveStory(s))}
      >
        <i className="ph-duotone ph-x" />
      </button>
    </div>
  );
  return (
    <section className="panel reading-list" aria-label="Reading list">
      <div className="panel-head">
        <h2 className="panel-title">Reading list</h2>
        <span className="meta">{toRead.length ? `${toRead.length} to read` : ''}</span>
      </div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column' }}>
        {toRead.length ? toRead.map(item) : (
          <div className="news-note">Nothing saved. Press the bookmark beside a story or headline to keep it here until you’ve read it.</div>
        )}
        {read.length > 0 && (
          <>
            <button className="section-toggle" style={{ cursor: 'pointer' }} onClick={() => setReadOpen(!readOpen)}>
              <span className="label">Read this week</span>
              <span>{read.length}</span>
              <i className={'ph-duotone ' + (readOpen ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
            </button>
            {readOpen && read.map(item)}
          </>
        )}
      </div>
    </section>
  );
}
