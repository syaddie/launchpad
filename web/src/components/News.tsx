import { useRef, useState } from 'react';
import type { AppState, NewsArticle, NewsTopic } from '../../../shared/types';
import { ago } from '../util';

interface Props {
  data: AppState;
  now: Date;
  busy: boolean;
  onRefresh: () => void;
  onTopics: (topics: string[]) => void;
}

export function News({ data, now, busy, onRefresh, onTopics }: Props) {
  const topics = data.prefs.newsTopics;
  const st = data.sync.news;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);

  const add = () => {
    const t = cancelled.current ? '' : draft.trim();
    cancelled.current = false;
    if (t && !topics.some((x) => x.toLowerCase() === t.toLowerCase())) onTopics([...topics, t]);
    setDraft('');
    setAdding(false);
  };

  return (
    <main className="news" aria-label="News">
      <div className="news-head">
        <div className="news-topics">
          {topics.map((t) => (
            <span key={t} className="topic-chip">
              {t}
              <button title={`Stop following ${t}`} aria-label={`Remove ${t}`} onClick={() => onTopics(topics.filter((x) => x !== t))}>
                <i className="ph-duotone ph-x" />
              </button>
            </span>
          ))}
          {adding ? (
            <input
              className="input sm"
              style={{ width: 170 }}
              autoFocus
              value={draft}
              placeholder="e.g. Formula 1"
              maxLength={60}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={add}
              onKeyDown={(e) => {
                if (e.key === 'Enter') add();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  cancelled.current = true;
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            topics.length < 8 && (
              <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)}>
                <i className="ph-duotone ph-plus" />
                Add topic
              </button>
            )
          )}
        </div>
        <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!data.newsSummaries && <span>Headlines only · set ANTHROPIC_API_KEY on the server for summaries</span>}
          {st.lastError && <span style={{ color: 'var(--wn)' }} title={st.lastError}>Couldn’t update</span>}
          <span>{busy ? 'Updating…' : st.lastSuccess ? `Updated ${ago(st.lastSuccess, now)}` : ''}</span>
          <button className="icon-btn md" title="Refresh news" disabled={busy || !topics.length} onClick={onRefresh}>
            <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
          </button>
        </div>
      </div>

      {topics.length ? (
        <div className="news-grid">
          {data.news.map((n) => (
            <TopicPanel key={n.topic} n={n} now={now} />
          ))}
        </div>
      ) : (
        <div className="panel">
          <div className="empty">
            <p>Follow a topic to get a short digest of its news here.</p>
            <button className="btn btn-secondary" onClick={() => setAdding(true)}>
              Add topic
            </button>
          </div>
        </div>
      )}
    </main>
  );
}

function TopicPanel({ n, now }: { n: NewsTopic; now: Date }) {
  const [allOpen, setAllOpen] = useState(false);
  const loading = !n.fetchedAt && !n.error;

  return (
    <section className="panel" aria-label={n.topic}>
      <div className="panel-head">
        <h2 className="panel-title">{n.topic}</h2>
        {n.summarisedAt && <span className="meta">Summary from {ago(n.summarisedAt, now)}</span>}
      </div>
      <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {n.error && <div className="news-note" style={{ color: 'var(--wn)' }}>{n.error}</div>}
        {loading && <div className="news-note">Fetching headlines…</div>}
        {!loading && !n.error && !n.articles.length && <div className="news-note">No news in the last two days.</div>}

        {n.stories?.map((s, i) => (
          <article key={i} className="story">
            <div className="story-headline">{s.headline}</div>
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
        ))}

        {n.stories && n.articles.length > 0 ? (
          <>
            <button className="section-toggle" style={{ cursor: 'pointer' }} onClick={() => setAllOpen(!allOpen)}>
              <span className="label">All headlines</span>
              <span>{n.articles.length}</span>
              <i className={'ph-duotone ' + (allOpen ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
            </button>
            {allOpen && n.articles.map((a) => <Headline key={a.url} a={a} now={now} />)}
          </>
        ) : (
          n.articles.map((a) => <Headline key={a.url} a={a} now={now} />)
        )}
      </div>
    </section>
  );
}

function Headline({ a, now }: { a: NewsArticle; now: Date }) {
  return (
    <a className="headline" href={a.url} target="_blank" rel="noopener">
      <span className="headline-title">{a.title}</span>
      <span className="headline-meta">
        {a.source} · {ago(a.publishedAt, now)}
      </span>
    </a>
  );
}
