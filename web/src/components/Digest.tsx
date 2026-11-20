import { useEffect, useRef, useState } from 'react';
import { DOW, MON, parseYmd, ymd } from '../../../shared/dates';
import { DEFAULT_SUBJECTS, MAX_SUBJECTS, MAX_SUBJECT_LEN, deeperUrl, daysSince, sameSubject, type ArchiveCard } from '../../../shared/digest';
import { parseNewsSource } from '../../../shared/news';
import type { AppState, DigestCard, DigestFeedback, NewsLists, RecallQuestion, SavedStory } from '../../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useToast';
import { ago } from '../util';

interface Props {
  data: AppState;
  now: Date;
  /** Today's lessons are being written on request. */
  busy: boolean;
  onRefresh: () => void;
  onSubjects: (subjects: string[]) => void;
  /** Fresh digest state from the server, after a star, a rating, a swap or an answer. */
  onMerge: (s: Partial<AppState>) => void;
  /** The reading list changed on the server. */
  onLists: (lists: NewsLists) => void;
  notify: Notify;
  /** ⌘K asking for the archive or the reading list; `n` goes up each time. */
  tabSignal: { tab: 'archive' | 'reading'; n: number } | null;
}

type Tab = 'today' | 'archive' | 'reading';

/** "today", "yesterday", "Tuesday", or "Tue 3 Nov" further back. */
function whenWritten(date: string, now: Date): string {
  const n = daysSince(date, now);
  const d = parseYmd(date);
  if (n === 0) return 'today';
  if (n === 1) return 'yesterday';
  if (n < 7) return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()];
  return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

export function Digest({ data, now, busy, onRefresh, onSubjects, onMerge, onLists, notify, tabSignal }: Props) {
  const [tab, setTab] = useState<Tab>('today');
  const lists = data.newsLists;
  const unread = lists.saved.filter((s) => !s.readAt).length;
  const st = data.sync.digest;
  const digest = data.digest;

  useEffect(() => {
    if (tabSignal) setTab(tabSignal.tab);
  }, [tabSignal]);

  /** A star, a rating, a swap or an answer: the server's answer goes on screen, a failure says why. */
  const act = (p: Promise<Partial<AppState>>, msg?: string, undo?: () => Promise<Partial<AppState>>) =>
    p
      .then((s) => {
        onMerge(s);
        if (msg) notify(msg, undo ? { label: 'Undo', run: () => undo().then(onMerge).catch((e) => notify(`Couldn’t undo: ${e.message}`)) } : undefined);
      })
      .catch((e) => notify(`Couldn’t save that: ${e.message}`));

  const writeError = digest.error || st.lastError;
  return (
    <main className="news digest" aria-label="Daily digest">
      <div className="news-head">
        <div className="news-topics">
          <div className="tabs news-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'today'} className={'tab' + (tab === 'today' ? ' active' : '')} onClick={() => setTab('today')}>
              Today
            </button>
            <button role="tab" aria-selected={tab === 'archive'} className={'tab' + (tab === 'archive' ? ' active' : '')} onClick={() => setTab('archive')}>
              Archive{digest.total ? <span className="tab-count tnum">{digest.total}</span> : null}
            </button>
            {(lists.saved.length > 0 || tab === 'reading') && (
              <button role="tab" aria-selected={tab === 'reading'} className={'tab' + (tab === 'reading' ? ' active' : '')} onClick={() => setTab('reading')}>
                Reading list{unread ? <span className="tab-count tnum">{unread}</span> : null}
              </button>
            )}
          </div>
          {tab === 'today' && data.newsSummaries && <Subjects subjects={data.prefs.digestSubjects} onSubjects={onSubjects} notify={notify} />}
        </div>
        {tab === 'today' && data.newsSummaries && (
          <div className="meta dg-status">
            {busy ? <span>Writing…</span> : writeError ? <span style={{ color: 'var(--wn)' }} title={writeError}>Couldn’t write today’s lessons</span> : null}
            <button className="icon-btn md" title="Write any of today’s lessons that are missing" aria-label="Write any missing lessons" disabled={busy || !data.prefs.digestSubjects.length} onClick={onRefresh}>
              <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
            </button>
          </div>
        )}
      </div>

      {tab === 'reading' ? (
        <ReadingList lists={lists} now={now} onLists={onLists} notify={notify} />
      ) : tab === 'archive' ? (
        <Archive data={data} now={now} act={act} />
      ) : (
        <Today data={data} now={now} busy={busy} error={writeError} act={act} onSubjects={onSubjects} onArchive={() => setTab('archive')} />
      )}
    </main>
  );
}

type Act = (p: Promise<Partial<AppState>>, msg?: string, undo?: () => Promise<Partial<AppState>>) => Promise<void>;

// ---------- subjects ----------

function Subjects({ subjects, onSubjects, notify }: { subjects: string[]; onSubjects: (s: string[]) => void; notify: Notify }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  const cancelled = useRef(false);
  const add = () => {
    const t = cancelled.current ? '' : draft.trim().replace(/\s+/g, ' ');
    cancelled.current = false;
    setDraft('');
    setAdding(false);
    if (t && !subjects.some((s) => sameSubject(s, t))) onSubjects([...subjects, t]);
  };
  const remove = (s: string) => {
    onSubjects(subjects.filter((x) => x !== s));
    notify(`Stopped ${s}. Its lessons stay in the archive.`, { label: 'Undo', run: () => onSubjects(subjects) });
  };
  return (
    <>
      {subjects.map((s) => (
        <span key={s} className="topic-chip">
          {s}
          <button title={`Stop learning about ${s}`} aria-label={`Remove ${s}`} onClick={() => remove(s)}>
            <i className="ph-duotone ph-x" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="input sm dg-add"
          autoFocus
          value={draft}
          placeholder="A subject, e.g. Personal finance"
          maxLength={MAX_SUBJECT_LEN}
          aria-label="New subject"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={add}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              e.stopPropagation();
              cancelled.current = true;
              e.currentTarget.blur();
            }
          }}
        />
      ) : (
        subjects.length < MAX_SUBJECTS && (
          <button className="btn btn-ghost btn-small" onClick={() => setAdding(true)} title="Something else to learn a little of every day">
            <i className="ph-duotone ph-plus" />
            Subject
          </button>
        )
      )}
    </>
  );
}

// ---------- today ----------

function Today({ data, now, busy, error, act, onSubjects, onArchive }: {
  data: AppState;
  now: Date;
  busy: boolean;
  error: string | null;
  act: Act;
  onSubjects: (s: string[]) => void;
  onArchive: () => void;
}) {
  const subjects = data.prefs.digestSubjects;
  const days = data.digest.days;
  const today = ymd(now);
  const todayDay = days.find((d) => d.date === today);
  const [swapping, setSwapping] = useState<string[]>([]);

  if (!data.newsSummaries) {
    return (
      <div className="panel">
        <div className="empty">
          <p>Claude writes the daily digest: a short lesson every day on each thing you want to learn about. Set ANTHROPIC_API_KEY in the server’s .env and restart Launchpad to start it.</p>
          {data.digest.total > 0 && (
            <button className="btn btn-secondary" onClick={onArchive}>
              Read past lessons
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!subjects.length) {
    const ideas = DEFAULT_SUBJECTS;
    return (
      <div className="panel">
        <div className="empty">
          <p>Pick what you’d like to learn a little of every day, and Claude writes a two-minute lesson on each one each morning, with a quick question a few days later to help it stick.</p>
          <div className="dg-ideas">
            {ideas.map((s) => (
              <button key={s} className="btn btn-secondary btn-small" onClick={() => onSubjects([...subjects, s])}>
                <i className="ph-duotone ph-plus" />
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const followed = (c: DigestCard) => subjects.some((s) => sameSubject(s, c.subject));
  const cards = todayDay?.cards.filter(followed) ?? [];
  const missing = subjects.filter((s) => !todayDay?.cards.some((c) => sameSubject(c.subject, s)));
  // While today's are on their way, the last day's lessons keep the page from being empty.
  const earlier = !cards.length ? days.find((d) => d.date !== today) : undefined;

  const swap = (c: DigestCard) => {
    setSwapping((s) => [...s, c.id]);
    act(api.swapLesson(c.id), `A different lesson on ${c.subject}.`).finally(() => setSwapping((s) => s.filter((x) => x !== c.id)));
  };

  return (
    <>
      {data.digest.recall && <Recall q={data.digest.recall} now={now} act={act} />}
      {missing.length > 0 && !busy && error && (
        <div className="dg-note" role="status">
          <i className="ph-duotone ph-warning-circle" style={{ color: 'var(--wn)' }} />
          <span>{error}</span>
        </div>
      )}
      <div className="dg-grid">
        {cards.map((c) => (
          <LessonCard key={c.id} card={c} act={act} onSwap={() => swap(c)} swapping={swapping.includes(c.id)} />
        ))}
        {missing.map((s) =>
          busy || !error ? (
            <section key={s} className="panel dg-card dg-pending" aria-label={s} aria-busy="true">
              <div className="panel-head">
                <h2 className="panel-title">{s}</h2>
              </div>
              <div className="dg-body">
                <p className="news-note">Writing today’s lesson…</p>
                <span className="dg-bar" />
                <span className="dg-bar short" />
                <span className="dg-bar" />
              </div>
            </section>
          ) : (
            <section key={s} className="panel dg-card dg-missing" aria-label={s}>
              <div className="panel-head">
                <h2 className="panel-title">{s}</h2>
              </div>
              <div className="dg-body">
                <p className="news-note">Not written yet. It’s tried again within the hour, or press refresh at the top.</p>
              </div>
            </section>
          ),
        )}
      </div>
      {earlier && (
        <>
          <h2 className="dg-day-head">From {whenWritten(earlier.date, now)}</h2>
          <div className="dg-grid">
            {earlier.cards.map((c) => (
              <LessonCard key={c.id} card={c} act={act} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function Recall({ q, now, act }: { q: RecallQuestion; now: Date; act: Act }) {
  const [picked, setPicked] = useState<number | null>(null);
  const a = q.answered;
  const choose = (i: number) => {
    if (a || picked !== null) return;
    setPicked(i);
    act(api.answerRecall(q.cardId, i)).finally(() => setPicked(null));
  };
  return (
    <section className="panel dg-recall" aria-label="Quick recall">
      <div className="panel-head">
        <h2 className="panel-title">Quick recall</h2>
        <span className="meta">
          {q.subject} · from {whenWritten(q.date, now)}
        </span>
      </div>
      <div className="dg-recall-body">
        <p className="dg-q">{q.question}</p>
        <div className="dg-options" role="group" aria-label="Answers">
          {q.options.map((o, i) => {
            const cls = a ? (i === a.answer ? ' right' : i === a.choice ? ' wrong' : ' faded') : picked === i ? ' picked' : '';
            return (
              <button key={i} className={'dg-option' + cls} disabled={!!a || picked !== null} aria-pressed={a ? i === a.choice : undefined} onClick={() => choose(i)}>
                <span className="dg-letter">{'ABCDE'[i]}</span>
                <span>{o}</span>
                {a && i === a.answer && <i className="ph-duotone ph-check-circle" aria-label="Right answer" />}
                {a && i === a.choice && i !== a.answer && <i className="ph-duotone ph-x-circle" aria-label="Your answer" />}
              </button>
            );
          })}
        </div>
        {a && (
          <div className={'dg-result' + (a.right ? ' right' : ' wrong')}>
            <p>
              <b>{a.right ? 'Right.' : a.choice >= 0 ? `Not quite: it’s ${'ABCDE'[a.answer]}.` : `It’s ${'ABCDE'[a.answer]}.`}</b> {a.why}
            </p>
            <p className="meta">
              {q.title}
              {a.takeaway ? `: ${a.takeaway}` : ''} {a.right ? 'It comes back in a while to check it stuck.' : 'It comes back in a couple of days.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

/** Lines that look like code (indentation, brackets, operators): the example is shown in the mono font. */
const looksLikeCode = (s: string) => s.split('\n').filter((l) => /^\s{2,}\S|[{};]\s*$|=>|==|\w+\(.*\)\s*$/.test(l)).length >= 2;

function LessonCard({ card: c, act, onMark, onSwap, swapping, date, now }: {
  card: DigestCard;
  act: Act;
  /** A star or a rating, as it's sent: for lists that keep their own copy of the lesson (the archive). */
  onMark?: (patch: Partial<DigestCard>) => void;
  /** "Another one": only today's lessons. */
  onSwap?: () => void;
  swapping?: boolean;
  /** Shown in the archive: when it was written. */
  date?: string;
  now?: Date;
}) {
  const mark = (patch: { starred?: boolean; feedback?: DigestFeedback }, msg?: string) => {
    onMark?.(patch);
    act(api.markLesson(c.id, patch), msg);
  };
  const rate = (f: DigestFeedback) => {
    const next = c.feedback === f ? '' : f;
    mark({ feedback: next }, next ? `Noted: ${c.subject} lessons will be pitched ${next === 'basic' ? 'deeper' : 'more gently'}.` : undefined);
  };
  return (
    <article className={'panel dg-card' + (swapping ? ' dg-swapping' : '')} aria-label={c.title} aria-busy={swapping || undefined}>
      <div className="panel-head">
        <h2 className="panel-title">{c.subject}</h2>
        <span className="dg-head-end">
          {date && now && <span className="meta">{whenWritten(date, now)}</span>}
          <button
            className={'icon-btn' + (c.starred ? ' on' : '')}
            title={c.starred ? 'Starred · unstar' : 'Star it, to find it again in the archive'}
            aria-label={c.starred ? 'Unstar' : 'Star'}
            aria-pressed={c.starred}
            onClick={() => mark({ starred: !c.starred })}
          >
            <i className={'ph-duotone ph-star' + (c.starred ? ' dg-starred' : '')} />
          </button>
        </span>
      </div>
      <div className="dg-body">
        <h3 className="dg-title">{c.title}</h3>
        {c.hook && <p className="dg-hook">{c.hook}</p>}
        {c.body.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
        {c.example && (
          <div className="dg-example">
            <div className="label">Example</div>
            <p className={looksLikeCode(c.example) ? 'dg-code' : undefined}>{c.example}</p>
          </div>
        )}
        {c.takeaway && (
          <p className="dg-takeaway">
            <i className="ph-duotone ph-lightbulb" aria-hidden="true" />
            <span>{c.takeaway}</span>
          </p>
        )}
      </div>
      <div className="dg-foot">
        <a className="btn btn-ghost btn-small" href={deeperUrl(c)} target="_blank" rel="noopener" title={`Look up ${c.search} on Wikipedia`}>
          <i className="ph-duotone ph-arrow-square-out" />
          Go deeper
        </a>
        <span className="dg-rate">
          <button className={'btn btn-ghost btn-small' + (c.feedback === 'basic' ? ' on' : '')} aria-pressed={c.feedback === 'basic'} title="Knew this already: pitch this subject further in" onClick={() => rate('basic')}>
            Too basic
          </button>
          <button className={'btn btn-ghost btn-small' + (c.feedback === 'deep' ? ' on' : '')} aria-pressed={c.feedback === 'deep'} title="Lost me: start this subject nearer the basics" onClick={() => rate('deep')}>
            Too deep
          </button>
          {onSwap && (
            <button className="btn btn-ghost btn-small" disabled={swapping} title={`Swap it for a lesson on another ${c.subject} concept`} onClick={onSwap}>
              <i className={'ph-duotone ' + (swapping ? 'ph-arrow-clockwise spin' : 'ph-shuffle')} />
              {swapping ? 'Writing…' : 'Another one'}
            </button>
          )}
        </span>
      </div>
    </article>
  );
}

// ---------- archive ----------

function Archive({ data, now, act }: { data: AppState; now: Date; act: Act }) {
  const [q, setQ] = useState('');
  const [subject, setSubject] = useState('');
  const [starred, setStarred] = useState(false);
  const [res, setRes] = useState<{ cards: ArchiveCard[]; total: number } | null>(null);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const seq = useRef(0);
  const shown = useRef(0);
  shown.current = res?.cards.length ?? 0;
  // Fetched again when lessons change elsewhere (today's arriving, a star in Today or on another device), as many as are shown.
  const version = data.digest.total + ':' + data.digest.days.map((d) => d.cards.map((c) => c.id + (c.starred ? '*' : '') + c.feedback).join()).join();
  const filters = `${q}
${subject}
${starred}`;
  const lastFilters = useRef(filters);

  useEffect(() => {
    const n = ++seq.current;
    const same = lastFilters.current === filters;
    lastFilters.current = filters;
    const t = window.setTimeout(
      () =>
        api
          .lessonArchive({ q, subject, starred, offset: 0, limit: same ? Math.min(100, Math.max(40, shown.current)) : 40 })
          .then((r) => {
            if (n !== seq.current) return;
            setError('');
            setRes(r);
          })
          .catch((e) => n === seq.current && setError(e.message)),
      q && !same ? 250 : 0,
    );
    return () => clearTimeout(t);
  }, [q, subject, starred, version]);

  const more = () => {
    if (!res) return;
    setLoadingMore(true);
    api
      .lessonArchive({ q, subject, starred, offset: res.cards.length })
      .then((r) => setRes((prev) => prev && { total: r.total, cards: [...prev.cards, ...r.cards.filter((c) => !prev.cards.some((p) => p.id === c.id))] }))
      .catch((e) => setError(e.message))
      .finally(() => setLoadingMore(false));
  };

  const filtered = !!(q || subject || starred);
  // A star or rating in the open lesson shows at once: older lessons aren't in the page's state to come back changed.
  const markLocal = (id: string) => (patch: Partial<DigestCard>) => setRes((r) => r && { ...r, cards: r.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) });

  return (
    <section className="panel dg-archive" aria-label="Archive">
      <div className="dg-archive-bar">
        <span className="dg-search">
          <i className="ph-duotone ph-magnifying-glass" aria-hidden="true" />
          <input className="input sm" type="search" value={q} placeholder="Search past lessons" aria-label="Search past lessons" onChange={(e) => setQ(e.target.value)} maxLength={200} />
        </span>
        {data.digest.subjects.length > 1 && (
          <select className="input sm dg-subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
            <option value="">Every subject</option>
            {data.digest.subjects.map((s) => (
              <option key={s.subject} value={s.subject}>
                {s.subject} ({s.count})
              </option>
            ))}
          </select>
        )}
        <button className={'btn btn-secondary btn-small' + (starred ? ' on' : '')} aria-pressed={starred} onClick={() => setStarred(!starred)}>
          <i className={'ph-duotone ph-star' + (starred ? ' dg-starred' : '')} />
          Starred
        </button>
        {res && <span className="meta tnum">{filtered ? `${res.total} of ${data.digest.total}` : `${res.total} lesson${res.total === 1 ? '' : 's'}`}</span>}
      </div>
      <div className="scroll dg-archive-list">
        {error && <div className="news-note" style={{ color: 'var(--wn)' }}>Couldn’t load the archive: {error}</div>}
        {!res && !error && <div className="news-note">Loading…</div>}
        {res && !res.cards.length && (
          <div className="news-note">
            {filtered ? 'No lessons match that.' : 'No lessons yet. Each day’s go here, to search and look back on.'}
          </div>
        )}
        {res?.cards.map((c) =>
          open === c.id ? (
            <div key={c.id} className="dg-archive-open">
              <button className="btn btn-ghost btn-small dg-close" onClick={() => setOpen(null)}>
                <i className="ph-duotone ph-caret-up" />
                Close
              </button>
              <LessonCard card={c} act={act} onMark={markLocal(c.id)} date={c.date} now={now} />
            </div>
          ) : (
            <button key={c.id} className="dg-row" onClick={() => setOpen(c.id)} aria-expanded={false}>
              <span className="dg-row-when meta">{whenWritten(c.date, now)}</span>
              <span className="dg-row-main">
                <span className="dg-row-title">
                  {c.title}
                  {c.starred && <i className="ph-duotone ph-star dg-starred" aria-label="Starred" />}
                </span>
                <span className="dg-row-sub">
                  <span className="chip chip-neutral">{c.subject}</span> {c.hook}
                </span>
              </span>
            </button>
          ),
        )}
        {res && res.cards.length < res.total && (
          <button className="btn btn-secondary btn-small dg-more" disabled={loadingMore} onClick={more}>
            {loadingMore ? 'Loading…' : `Show more (${res.total - res.cards.length})`}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- the reading list kept from the old News view ----------

function ReadingList({ lists, now, onLists, notify }: { lists: NewsLists; now: Date; onLists: (l: NewsLists) => void; notify: Notify }) {
  const [readOpen, setReadOpen] = useState(false);
  const act = (p: Promise<NewsLists>, msg?: string, undo?: () => Promise<NewsLists>) =>
    p
      .then((l) => {
        onLists(l);
        if (msg) notify(msg, undo ? { label: 'Undo', run: () => undo().then(onLists).catch((e) => notify(`Couldn’t undo: ${e.message}`)) } : undefined);
      })
      .catch((e) => notify(`Couldn’t save that: ${e.message}`));
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
        <span className="headline-meta">{[s.source, s.topic && parseNewsSource(s.topic).label, `saved ${ago(s.savedAt, now)}`].filter(Boolean).join(' · ')}</span>
      </div>
      <button className="icon-btn" title="Remove" aria-label="Remove" onClick={() => act(api.removeStory(s.id), 'Removed from the reading list.', () => api.saveStory(s))}>
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
        {toRead.length ? toRead.map(item) : <div className="news-note">Nothing left to read. Stories saved from the old News page stayed here until you’d read them.</div>}
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
