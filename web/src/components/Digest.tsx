import { useEffect, useRef, useState } from 'react';
import { DOW, MON, parseYmd, ymd } from '../../../shared/dates';
import { DEFAULT_SUBJECTS, MAX_ASK_LEN, MAX_SUBJECTS, MAX_SUBJECT_LEN, deeperUrl, daysSince, sameSubject, type ArchiveCard } from '../../../shared/digest';
import { parseNewsSource } from '../../../shared/news';
import type { AppState, DigestCard, DigestFeedback, NewsLists, RecallQuestion, SavedStory } from '../../../shared/types';
import { api } from '../api';
import type { Notify } from '../hooks/useToast';
import { ago } from '../util';
import { Formula, Tex } from './Tex';
import { Glide } from './Motion';

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
            <Glide on={tab} />
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
            <button className="icon-btn md" title="Write any of today’s lessons that are missing" aria-label="Write any missing lessons" aria-busy={busy} disabled={busy || !data.prefs.digestSubjects.length} onClick={onRefresh}>
              <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
            </button>
          </div>
        )}
      </div>

      {tab === 'reading' ? (
        <ReadingList lists={lists} now={now} onLists={onLists} notify={notify} />
      ) : tab === 'archive' ? (
        <Archive data={data} now={now} act={act} onMerge={onMerge} />
      ) : (
        <Today data={data} now={now} busy={busy} error={writeError} act={act} onMerge={onMerge} onSubjects={onSubjects} onArchive={() => setTab('archive')} />
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

function Today({ data, now, busy, error, act, onMerge, onSubjects, onArchive }: {
  data: AppState;
  now: Date;
  busy: boolean;
  error: string | null;
  act: Act;
  onMerge: (s: Partial<AppState>) => void;
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
          <p>Pick what you’d like to learn a little of every day, and Claude writes a bite-sized lesson on each one each morning: the idea in a sentence or two and a quick question, with more when you want it. A few days later it asks about it again, to help it stick.</p>
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
          <LessonCard key={c.id} card={c} act={act} onMerge={onMerge} canAsk={data.newsSummaries} onSwap={() => swap(c)} swapping={swapping.includes(c.id)} />
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
              <LessonCard key={c.id} card={c} act={act} onMerge={onMerge} canAsk={data.newsSummaries} />
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
        <p className="dg-q">
          <Tex text={q.question} />
        </p>
        <div className="dg-options" role="group" aria-label="Answers">
          {q.options.map((o, i) => {
            const cls = a ? (i === a.answer ? ' right' : i === a.choice ? ' wrong' : ' faded') : picked === i ? ' picked' : '';
            return (
              <button key={i} className={'dg-option' + cls} disabled={!!a || picked !== null} aria-pressed={a ? i === a.choice : undefined} onClick={() => choose(i)}>
                <span className="dg-letter">{'ABCDE'[i]}</span>
                <span>
                  <Tex text={o} />
                </span>
                {a && i === a.answer && <i className="ph-duotone ph-check-circle" aria-label="Right answer" />}
                {a && i === a.choice && i !== a.answer && <i className="ph-duotone ph-x-circle" aria-label="Your answer" />}
              </button>
            );
          })}
        </div>
        {a && (
          <div className={'dg-result' + (a.right ? ' right' : ' wrong')}>
            <p>
              <b>{a.right ? 'Right.' : a.choice >= 0 ? `Not quite: it’s ${'ABCDE'[a.answer]}.` : `It’s ${'ABCDE'[a.answer]}.`}</b> <Tex text={a.why} />
            </p>
            <p className="meta">
              {q.title}
              {a.takeaway ? ': ' : ''}
              {a.takeaway && <Tex text={a.takeaway} />} {a.right ? 'It comes back in a while to check it stuck.' : 'It comes back in a couple of days.'}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

type Section = 'read' | 'how' | 'example' | 'ask';

/** Ready-made follow-up questions, one tap each. */
const ASK_IDEAS = ['Explain it more simply', 'Another example, please', 'Why does it work?'];

/** Typing straight into the question box makes sense only with a keyboard; on a phone it would bring the keyboard up over the ideas. */
const hasKeyboard = () => typeof window !== 'undefined' && !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;

function LessonCard({ card: c, act, onMerge, canAsk, onMark, onSwap, swapping, date, now }: {
  card: DigestCard;
  act: Act;
  onMerge: (s: Partial<AppState>) => void;
  /** Follow-up questions can be asked (there's an API key). */
  canAsk: boolean;
  /** A star, a rating, an answer or a follow-up, as it's saved: for lists that keep their own copy of the lesson (the archive). */
  onMark?: (patch: Partial<DigestCard>) => void;
  /** "Another one": only today's lessons. */
  onSwap?: () => void;
  swapping?: boolean;
  /** Shown in the archive: when it was written. */
  date?: string;
  now?: Date;
}) {
  const [open, setOpen] = useState<Section | null>(null);
  // Kept here, not in the Ask section, so closing it while Claude answers doesn't lose the question.
  const [asking, setAsking] = useState<string | null>(null);
  const [askError, setAskError] = useState('');
  const mark = (patch: { starred?: boolean; feedback?: DigestFeedback; checked?: number }, msg?: string) => {
    onMark?.(patch);
    act(api.markLesson(c.id, patch), msg);
  };
  const rate = (f: DigestFeedback) => {
    const next = c.feedback === f ? '' : f;
    mark({ feedback: next }, next ? `Noted: ${c.subject} lessons will be pitched ${next === 'basic' ? 'deeper' : 'more gently'}.` : undefined);
  };
  const ask = (q: string): Promise<boolean> => {
    const t = q.trim().replace(/\s+/g, ' ');
    if (!t || asking) return Promise.resolve(false);
    setAsking(t);
    setAskError('');
    return api
      .askLesson(c.id, t)
      .then(({ lesson, ...s }) => {
        onMerge(s);
        onMark?.({ asks: lesson.asks });
        return true;
      })
      .catch((e: Error) => {
        setAskError(e.message);
        return false;
      })
      .finally(() => setAsking(null));
  };
  // Lessons from before the digest went short have paragraphs instead of a gist and points.
  const legacy = !c.gist;
  const sections: { key: Section; label: string; icon: string; count?: number }[] = [];
  if (legacy && c.body.length) sections.push({ key: 'read', label: 'Read it all', icon: 'ph-article' });
  if (c.points.length) sections.push({ key: 'how', label: 'How it works', icon: 'ph-gear-six' });
  if (c.example) sections.push({ key: 'example', label: 'Example', icon: c.exampleCode ? 'ph-code' : 'ph-calculator' });
  if (canAsk || c.asks.length) sections.push({ key: 'ask', label: 'Ask', icon: 'ph-chat-circle-dots', count: c.asks.length });
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
        <div className="dg-lead">
          <h3 className="dg-title">{c.title}</h3>
          {c.hook && (
            <p className="dg-hook">
              <Tex text={c.hook} />
            </p>
          )}
        </div>
        {c.gist && (
          <p className="dg-gist">
            <Tex text={c.gist} />
          </p>
        )}
        {c.formula && (
          <div className="dg-formula">
            <Formula tex={c.formula} />
            {c.where && (
              <p className="dg-where">
                <Tex text={c.where} />
              </p>
            )}
          </div>
        )}
        {legacy && c.takeaway && (
          <p className="dg-takeaway">
            <i className="ph-duotone ph-lightbulb" aria-hidden="true" />
            <span>
              <Tex text={c.takeaway} />
            </span>
          </p>
        )}
        {c.check && <Check card={c} onAnswer={(i) => mark({ checked: i })} />}
        {sections.length > 0 && (
          <div className="dg-pills" role="group" aria-label="More on this">
            {sections.map((sec) => (
              <button key={sec.key} className={'dg-pill' + (open === sec.key ? ' on' : '')} aria-expanded={open === sec.key} onClick={() => setOpen(open === sec.key ? null : sec.key)}>
                <i className={'ph-duotone ' + (sec.key === 'ask' && asking ? 'ph-arrow-clockwise spin' : sec.icon)} aria-hidden="true" />
                {sec.label}
                {sec.count ? <span className="tab-count tnum">{sec.count}</span> : null}
              </button>
            ))}
          </div>
        )}
        {open === 'read' && (
          <div className="dg-section">
            {c.body.map((p, i) => (
              <p key={i}>
                <Tex text={p} />
              </p>
            ))}
          </div>
        )}
        {open === 'how' && (
          <ul className="dg-section dg-points">
            {c.points.map((p, i) => (
              <li key={i}>
                <Tex text={p} />
              </li>
            ))}
          </ul>
        )}
        {open === 'example' && (
          <div className="dg-section dg-example">
            {c.exampleCode ? (
              <pre className="dg-code">{c.example}</pre>
            ) : (
              <p>
                <Tex text={c.example} />
              </p>
            )}
          </div>
        )}
        {open === 'ask' && <Ask card={c} canAsk={canAsk} asking={asking} error={askError} onAsk={ask} onClose={() => setOpen(null)} />}
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

/** The quick question under the gist: answered there and then, and the first answer is kept. */
function Check({ card: c, onAnswer }: { card: DigestCard; onAnswer: (i: number) => void }) {
  const q = c.check!;
  const [picked, setPicked] = useState(-1);
  const chosen = c.checked >= 0 ? c.checked : picked;
  const done = chosen >= 0;
  const right = chosen === q.answer;
  return (
    <div className={'dg-check' + (done ? (right ? ' right' : ' wrong') : '')} role="group" aria-label="Quick check">
      <p className="dg-check-q">
        <span className="dg-check-label">Quick check</span>
        <Tex text={q.question} />
      </p>
      <div className="dg-check-options">
        {q.options.map((o, i) => {
          const cls = done ? (i === q.answer ? ' right' : i === chosen ? ' wrong' : ' faded') : '';
          return (
            <button
              key={i}
              className={'dg-option sm' + cls}
              disabled={done}
              aria-pressed={done ? i === chosen : undefined}
              onClick={() => {
                setPicked(i);
                onAnswer(i);
              }}
            >
              <span className="dg-letter">{'ABCDE'[i]}</span>
              <span>
                <Tex text={o} />
              </span>
              {done && i === q.answer && <i className="ph-duotone ph-check-circle" aria-label="Right answer" />}
              {done && i === chosen && i !== q.answer && <i className="ph-duotone ph-x-circle" aria-label="Your answer" />}
            </button>
          );
        })}
      </div>
      {done && (
        <p className="dg-check-why" role="status">
          <b>{right ? 'Right.' : `Not quite: it’s ${'ABCDE'[q.answer]}.`}</b> <Tex text={q.why} />
        </p>
      )}
    </div>
  );
}

/** Follow-up questions on a lesson and Claude's short answers, with a few ready-made ones. */
function Ask({ card: c, canAsk, asking, error, onAsk, onClose }: {
  card: DigestCard;
  canAsk: boolean;
  asking: string | null;
  error: string;
  onAsk: (q: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const ideas = ASK_IDEAS.filter((q) => !c.asks.some((a) => a.q === q));
  const send = (q: string) => {
    setDraft('');
    // A question that didn't get an answer goes back in the box, to send again.
    onAsk(q).then((ok) => !ok && setDraft((d) => d || q));
  };
  return (
    <div className="dg-section dg-ask">
      {c.asks.map((a, i) => (
        <div key={i} className="dg-qa">
          <p className="dg-qa-q">{a.q}</p>
          <p className="dg-qa-a">
            <Tex text={a.a} />
          </p>
        </div>
      ))}
      {asking && (
        <div className="dg-qa" aria-busy="true">
          <p className="dg-qa-q">{asking}</p>
          <p className="dg-qa-a dg-thinking">
            <i className="ph-duotone ph-arrow-clockwise spin" aria-hidden="true" />
            Thinking…
          </p>
        </div>
      )}
      {error && !asking && (
        <p className="dg-ask-error" role="alert">
          <i className="ph-duotone ph-warning-circle" aria-hidden="true" />
          <span>Couldn’t get an answer: {error}</span>
        </p>
      )}
      {canAsk ? (
        <>
          {!asking && ideas.length > 0 && (
            <div className="dg-ask-ideas">
              {ideas.map((q) => (
                <button key={q} className="btn btn-secondary btn-small" onClick={() => send(q)}>
                  {q}
                </button>
              ))}
            </div>
          )}
          <form
            className="dg-ask-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft.trim() && !asking) send(draft);
            }}
          >
            <input
              className="input sm"
              value={draft}
              autoFocus={hasKeyboard()}
              placeholder={c.asks.length ? 'Ask something else' : 'Ask anything about it'}
              maxLength={MAX_ASK_LEN}
              aria-label={`Ask about ${c.title}`}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  onClose();
                }
              }}
            />
            <button className="btn btn-primary btn-small" type="submit" disabled={!draft.trim() || !!asking}>
              Ask
            </button>
          </form>
        </>
      ) : (
        <p className="news-note">New questions need ANTHROPIC_API_KEY on the server.</p>
      )}
    </div>
  );
}

// ---------- archive ----------

function Archive({ data, now, act, onMerge }: { data: AppState; now: Date; act: Act; onMerge: (s: Partial<AppState>) => void }) {
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
              <LessonCard card={c} act={act} onMerge={onMerge} canAsk={data.newsSummaries} onMark={markLocal(c.id)} date={c.date} now={now} />
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
                  <span className="chip chip-neutral">{c.subject}</span> <Tex text={c.hook || c.gist} />
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
