import { useState } from 'react';
import type { AppState, InboxEmail, InboxItem, InboxRange } from '../../../shared/types';
import { localGet, localSet } from '../api';
import { ago } from '../util';

interface Props {
  data: AppState;
  now: Date;
  busy: boolean;
  onRefresh: () => void;
  onConnect: () => void;
  onOpenSettings: () => void;
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

export const gmailUrl = (account: string | undefined, threadId: string) => `https://mail.google.com/mail/u/${encodeURIComponent(account || '0')}/#all/${threadId}`;

/** Things to do in the two-day digest whose email is still unread: the rail's badge. */
export function inboxBadge(data: AppState): number {
  const unread = new Set(data.inbox.emails.filter((e) => e.unread).map((e) => e.id));
  return (data.inbox.digests['2d']?.items ?? []).filter((i) => i.kind === 'action' && i.emails.some((id) => unread.has(id))).length;
}

export function Inbox({ data, now, busy, onRefresh, onConnect, onOpenSettings }: Props) {
  const [range, setRange] = useState<InboxRange>(() => (localGet('inboxRange') === '7d' ? '7d' : '2d'));
  const [allOpen, setAllOpen] = useState(false);
  const r = RANGES.find((x) => x.key === range)!;
  const st = data.sync.inbox;
  const { inbox, google } = data;
  const emails = inbox.emails.filter((e) => now.getTime() - Date.parse(e.at) <= r.ms);
  const byId = new Map(inbox.emails.map((e) => [e.id, e]));
  const digest = inbox.digests[range];
  const unread = emails.filter((e) => e.unread).length;
  // Until the digest is written, the list is all there is to read.
  const showAll = allOpen || !digest;
  const ready = google.connected && data.prefs.sources.gmail;

  const pick = (k: InboxRange) => {
    setRange(k);
    localSet('inboxRange', k);
  };

  if (!ready) {
    return (
      <main className="news" aria-label="Inbox">
        <div className="panel">
          <div className="empty">
            <p>{google.connected ? 'Gmail is switched off in Settings, so the inbox digest is too.' : 'Connect Google to get a short digest of your email here, written by Claude.'}</p>
            <button className="btn btn-secondary" onClick={google.connected ? onOpenSettings : onConnect}>
              {google.connected ? 'Open Settings' : 'Connect Google'}
            </button>
          </div>
        </div>
      </main>
    );
  }

  const list = (
    <>
      {emails.map((e) => (
        <EmailRow key={e.id} e={e} now={now} account={google.email} />
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
              const items = digest?.items.filter((i) => i.kind === c.kind) ?? [];
              return (
                <section key={c.kind} className="panel" aria-label={c.title}>
                  <div className="panel-head">
                    <h2 className="panel-title">{c.title}</h2>
                    {items.length > 0 && <span className="meta">{items.length}</span>}
                  </div>
                  <div className="scroll" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {digest && !items.length && c.empty && <div className="news-note">{c.empty}</div>}
                    {items.map((it, i) => (
                      <Item key={i} it={it} byId={byId} account={google.email} />
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

function Item({ it, byId, account }: { it: InboxItem; byId: Map<string, InboxEmail>; account?: string }) {
  const mails = it.emails.flatMap((id) => byId.get(id) ?? []);
  // One link per sender, to their newest email in the item.
  const senders = [...new Map(mails.map((m) => [m.fromEmail, m])).values()];
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
    </article>
  );
}

function EmailRow({ e, now, account }: { e: InboxEmail; now: Date; account?: string }) {
  return (
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
  );
}
