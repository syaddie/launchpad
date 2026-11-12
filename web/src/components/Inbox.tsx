import { useState } from 'react';
import type { AppState, BillSuggestion, InboxEmail, InboxItem, InboxRange } from '../../../shared/types';
import { localGet, localSet } from '../api';
import type { InboxAction } from '../hooks/useGoogleActions';
import { billLine, gmailUrl, liveEmails } from '../inboxActions';
import { ago } from '../util';

export { gmailUrl };

/** What can be done from the view: archive and mark read (with Undo), make a task, keep or dismiss a bill. */
export interface InboxActions {
  onAction: (emails: InboxEmail[], action: InboxAction) => void;
  onTask: (source: { item: InboxItem; emails: InboxEmail[] } | { email: InboxEmail }) => void;
  onKeepBill: (b: BillSuggestion) => void;
  onDismissBill: (b: BillSuggestion) => void;
}

interface Props {
  data: AppState;
  now: Date;
  busy: boolean;
  onRefresh: () => void;
  onConnect: () => void;
  onOpenSettings: () => void;
  actions?: InboxActions;
}

const RANGES: { key: InboxRange; name: string; words: string; ms: number }[] = [
  { key: '2d', name: '2 days', words: 'the last two days', ms: 2 * 86_400_000 },
  { key: '7d', name: '7 days', words: 'the last week', ms: 7 * 86_400_000 },
];

const COLUMNS: { kind: InboxItem['kind']; title: string; empty: string }[] = [
  { kind: 'action', title: 'Needs you', empty: 'Nothing needs you.' },
  { kind: 'update', title: 'Worth knowing', empty: 'No updates worth a look.' },
  { kind: 'fyi', title: 'In passing', empty: '' },
];

export function Inbox({ data, now, busy, onRefresh, onConnect, onOpenSettings, actions }: Props) {
  const [range, setRange] = useState<InboxRange>(() => (localGet('inboxRange') === '7d' ? '7d' : '2d'));
  const [allOpen, setAllOpen] = useState(false);
  const r = RANGES.find((x) => x.key === range)!;
  const st = data.sync.inbox;
  const { inbox, google } = data;
  // Archived from here: out of the list and the digest.
  const emails = inbox.emails.filter((e) => !e.archived && now.getTime() - Date.parse(e.at) <= r.ms);
  const byId = new Map(inbox.emails.map((e) => [e.id, e]));
  const digest = inbox.digests[range];
  const unread = emails.filter((e) => e.unread).length;
  // Until the digest is written, the list is all there is to read.
  const showAll = allOpen || !digest;
  const ready = google.connected && data.prefs.sources.gmail;
  const canModify = !google.missingScopes?.includes('gmail.modify');
  const acts = actions && { ...actions, canModify };
  const bills = data.bills ?? [];

  const pick = (k: InboxRange) => {
    setRange(k);
    localSet('inboxRange', k);
  };

  if (!ready) {
    return (
      <main className="news" aria-label="Inbox">
        <div className="panel">
          <div className="empty">
            <p>
              {google.connected
                ? 'Gmail is switched off in Settings, so the inbox digest is too.'
                : google.signedOut?.reason ?? 'Connect Google to get a short digest of your email here, written by Claude.'}
            </p>
            <button className="btn btn-secondary" onClick={google.connected ? onOpenSettings : onConnect}>
              {google.connected ? 'Open Settings' : google.signedOut ? 'Reconnect Google' : 'Connect Google'}
            </button>
          </div>
        </div>
      </main>
    );
  }

  const list = (
    <>
      {emails.map((e) => (
        <EmailRow key={e.id} e={e} now={now} account={google.email} acts={acts} />
      ))}
    </>
  );

  return (
    <main className="news" aria-label="Inbox">
      <div className="news-head">
        <div className="segmented" role="tablist" aria-label="How far back">
          {RANGES.map((x) => (
            <button key={x.key} role="tab" aria-selected={x.key === range} className={x.key === range ? 'on' : ''} onClick={() => pick(x.key)}>
              {x.name}
            </button>
          ))}
        </div>
        <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {!data.newsSummaries && <span>Emails only · set ANTHROPIC_API_KEY on the server for summaries</span>}
          {inbox.fetchedAt && (
            <span>
              {emails.length} email{emails.length === 1 ? '' : 's'}
              {unread ? ` · ${unread} unread` : ''}
            </span>
          )}
          {st.lastError && <span style={{ color: 'var(--wn)' }} title={st.lastError}>Couldn’t update</span>}
          <span>{busy ? 'Updating…' : st.lastSuccess ? `Updated ${ago(st.lastSuccess, now)}` : ''}</span>
          <button className="icon-btn md" title="Check for new mail and summarise it now" disabled={busy} onClick={onRefresh}>
            <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
          </button>
        </div>
      </div>

      {actions && !canModify && (
        <div className="inbox-reconnect">
          <span>Reconnect Google to allow archiving and marking emails read from here.</span>
          <button className="btn-link" onClick={onConnect}>
            Reconnect Google
          </button>
        </div>
      )}

      {actions && bills.length > 0 && (
        <section className="panel inbox-bills" aria-label="Bills and receipts">
          <div className="panel-head">
            <h2 className="panel-title">Bills and receipts</h2>
            <span className="meta">From your email · nothing goes into Money until you keep it</span>
          </div>
          <div className="scroll" style={{ maxHeight: 220 }}>
            {bills.map((b) => (
              <div key={b.id} className="bill-row">
                <div className="bill-what">
                  {billLine(b)}
                  <a href={gmailUrl(google.email, b.threadId)} target="_blank" rel="noopener" title={b.source === 'claude' ? 'Read by Claude' : undefined}>
                    {b.subject}
                  </a>
                </div>
                <div className="pkg-new">
                  <button className="keep" onClick={() => actions.onKeepBill(b)}>
                    Keep
                  </button>
                  <button className="dismiss" onClick={() => actions.onDismissBill(b)}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!inbox.fetchedAt ? (
        <div className="panel">
          <div className="news-note">{st.lastError ? `Couldn’t read Gmail: ${st.lastError}` : 'Reading your inbox…'}</div>
        </div>
      ) : !emails.length ? (
        <div className="panel">
          <div className="news-note">No email in {r.words}.</div>
        </div>
      ) : !data.newsSummaries ? (
        <div className="news-grid">
          <section className="panel" aria-label="Emails">
            <div className="panel-head">
              <h2 className="panel-title">Emails</h2>
            </div>
            <div className="scroll">{list}</div>
          </section>
        </div>
      ) : (
        <>
          <section className="panel inbox-brief" aria-label="Summary">
            <div className="panel-head">
              <h2 className="panel-title">{range === '2d' ? 'Your last two days' : 'Your week'}</h2>
              {digest && <span className="meta">Summary from {ago(digest.summarisedAt, now)}</span>}
            </div>
            {inbox.error && <div className="news-note" style={{ color: 'var(--wn)' }}>{inbox.error}</div>}
            {digest ? (
              <>
                <p className="inbox-overview">{digest.overview}</p>
                {digest.skimmed && <p className="inbox-skimmed">{digest.skimmed}</p>}
              </>
            ) : (
              !inbox.error && <div className="news-note">Claude is reading {emails.length} emails…</div>
            )}
          </section>
          <div className="news-grid inbox-grid">
            {COLUMNS.map((c) => {
              // An item whose emails were all archived here is done with.
              const items = digest?.items.filter((i) => i.kind === c.kind && liveEmails(i, byId).length > 0) ?? [];
              return (
                <section key={c.kind} className="panel" aria-label={c.title}>
                  <div className="panel-head">
                    <h2 className="panel-title">{c.title}</h2>
                    {items.length > 0 && <span className="meta">{items.length}</span>}
                  </div>
                  <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {digest && !items.length && c.empty && <div className="news-note">{c.empty}</div>}
                    {items.map((it) => (
                      <Item key={it.emails.join(',') || it.headline} it={it} byId={byId} account={google.email} acts={acts} />
                    ))}
                    {c.kind === 'fyi' && (
                      <>
                        <button className="section-toggle" style={{ cursor: 'pointer' }} onClick={() => setAllOpen(!showAll)}>
                          <span className="label">All emails</span>
                          <span>{emails.length}</span>
                          <i className={'ph-duotone ' + (showAll ? 'ph-caret-up' : 'ph-caret-down')} style={{ fontSize: 12 }} />
                        </button>
                        {showAll && list}
                      </>
                    )}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

type Acts = InboxActions & { canModify: boolean };

function Item({ it, byId, account, acts }: { it: InboxItem; byId: Map<string, InboxEmail>; account?: string; acts?: Acts }) {
  const mails = liveEmails(it, byId);
  // One link per sender, to their newest email in the item.
  const senders = [...new Map(mails.map((m) => [m.fromEmail, m])).values()];
  const anyUnread = mails.some((m) => m.unread);
  const n = mails.length > 1 ? ` all ${mails.length}` : '';
  return (
    <article className="story">
      <div className="story-headline">
        {it.headline}
        {it.due && <span className="chip chip-warn inbox-due">{it.due}</span>}
      </div>
      <p className="story-summary">{it.summary}</p>
      {senders.length > 0 && (
        <div className="story-links">
          {senders.map((m) => (
            <a key={m.id} href={gmailUrl(account, m.threadId)} target="_blank" rel="noopener" title={m.subject}>
              {mails.some((x) => x.fromEmail === m.fromEmail && x.unread) && <span className="unread-dot" aria-label="Unread" />}
              {m.from}
            </a>
          ))}
        </div>
      )}
      {acts && mails.length > 0 && (
        <div className="inbox-acts">
          {acts.canModify && (
            <button onClick={() => acts.onAction(mails, 'archive')} title={`Archive${n} in Gmail`}>
              <i className="ph-duotone ph-archive" aria-hidden="true" />
              Archive
            </button>
          )}
          {acts.canModify && anyUnread && (
            <button onClick={() => acts.onAction(mails, 'read')} title={`Mark${n} read in Gmail`}>
              <i className="ph-duotone ph-envelope-open" aria-hidden="true" />
              Mark read
            </button>
          )}
          <button onClick={() => acts.onTask({ item: it, emails: mails })} title={it.due ? `A task due ${it.due}, linking to the email` : 'A task linking to the email'}>
            <i className="ph-duotone ph-check-square" aria-hidden="true" />
            Make a task
          </button>
        </div>
      )}
    </article>
  );
}

function EmailRow({ e, now, account, acts }: { e: InboxEmail; now: Date; account?: string; acts?: Acts }) {
  return (
    <div className="email-wrap">
      <a className={'headline email-row' + (e.unread ? ' unread' : '')} href={gmailUrl(account, e.threadId)} target="_blank" rel="noopener">
        <span className="split">
          <span className="email-from">
            {e.unread && <span className="unread-dot" aria-label="Unread" />}
            {e.from}
          </span>
          <span className="headline-meta" style={{ flex: 'none' }}>
            {ago(e.at, now)}
          </span>
        </span>
        <span className="headline-title">{e.subject}</span>
        {e.snippet && <span className="headline-meta email-snippet">{e.snippet}</span>}
      </a>
      {acts && (
        <div className="inbox-acts">
          {acts.canModify && (
            <button className="icon-only" onClick={() => acts.onAction([e], 'archive')} title="Archive" aria-label="Archive">
              <i className="ph-duotone ph-archive" />
            </button>
          )}
          {acts.canModify && e.unread && (
            <button className="icon-only" onClick={() => acts.onAction([e], 'read')} title="Mark read" aria-label="Mark read">
              <i className="ph-duotone ph-envelope-open" />
            </button>
          )}
          <button className="icon-only" onClick={() => acts.onTask({ email: e })} title="Make a task" aria-label="Make a task">
            <i className="ph-duotone ph-check-square" />
          </button>
        </div>
      )}
    </div>
  );
}
