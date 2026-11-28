import { useEffect, useMemo, useState } from 'react';
import type { AppState, BillSuggestion, InboxEmail, InboxItem, InboxRange } from '../../../shared/types';
import { localGet, localSet } from '../api';
import type { InboxAction } from '../hooks/useGoogleActions';
import { billLine, gmailUrl, liveEmails } from '../inboxActions';
import { ago } from '../util';
import { FoldRow, Glide, Readout, focusPastRow, useArrived, useWithGone } from './Motion';
import { copyText, menuProps, type MenuItem } from './ContextMenu';
import { EmptyArt } from './mission/EmptyArt';

export { gmailUrl };

/** What can be done from the view: archive and mark read (with Undo), keep or dismiss a bill. */
export interface InboxActions {
  onAction: (emails: InboxEmail[], action: InboxAction) => void;
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
  notify?: (msg: string) => void;
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

export function Inbox({ data, now, busy, onRefresh, onConnect, onOpenSettings, actions, notify }: Props) {
  const [range, setRange] = useState<InboxRange>(() => (localGet('inboxRange') === '7d' ? '7d' : '2d'));
  const [allOpen, setAllOpen] = useState(false);
  const r = RANGES.find((x) => x.key === range)!;
  const st = data.sync.inbox;
  const { inbox, google } = data;
  // The range's emails; those archived from here are out of the list and the digest (they fold away as they go).
  const inRange = inbox.emails.filter((e) => now.getTime() - Date.parse(e.at) <= r.ms);
  const emails = inRange.filter((e) => !e.archived);
  const byId = new Map(inbox.emails.map((e) => [e.id, e]));
  const digest = inbox.digests[range];
  const unread = emails.filter((e) => e.unread).length;
  // Until the digest is written, the list is all there is to read.
  const showAll = allOpen || !digest;
  const ready = google.connected && data.prefs.sources.gmail;
  const canModify = !google.missingScopes?.includes('gmail.modify');
  // New mail that comes in while the view shows (a check, the hourly one), and an email Undo brings back, slide in.
  const arrived = useArrived(useMemo(() => inbox.emails.filter((e) => !e.archived).map((e) => e.id), [inbox.emails]));
  const bills = useWithGone(data.bills ?? NO_BILLS, billKey);
  const acts: Acts | undefined = actions && {
    ...actions,
    canModify,
    // The keyboard's place moves on from a row that's about to go, to the next.
    onAction: (mails, action) => {
      if (action === 'archive') {
        const ids = new Set(mails.map((m) => m.id));
        focusPastRow((row) => rowMails(row).every((id) => ids.has(id)));
      }
      actions.onAction(mails, action);
    },
    onKeepBill: (b) => {
      focusPastRow((row) => row.querySelector<HTMLElement>('[data-bill]')?.dataset.bill === b.id);
      actions.onKeepBill(b);
    },
    onDismissBill: (b) => {
      focusPastRow((row) => row.querySelector<HTMLElement>('[data-bill]')?.dataset.bill === b.id);
      actions.onDismissBill(b);
    },
  };

  const pick = (k: InboxRange) => {
    setRange(k);
    localSet('inboxRange', k);
  };

  if (!ready) {
    return (
      <main className="news inbox" aria-label="Inbox">
        <div className="panel">
          <div className="empty">
            <EmptyArt kind="away" />
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

  // Several arriving at once come in the oldest first (the list is newest first).
  const coming = inRange.filter((e) => arrived.has(e.id)).map((e) => e.id);
  const list = (
    <>
      {inRange.map((e) => (
        <FoldRow key={e.id} show={!e.archived} arriving={arrived.has(e.id)} i={coming.length - 1 - coming.indexOf(e.id)}>
          <EmailRow e={e} now={now} account={google.email} acts={acts} notify={notify} />
        </FoldRow>
      ))}
    </>
  );

  return (
    <main className="news inbox" aria-label="Inbox">
      <div className="news-head">
        <div className="segmented" role="tablist" aria-label="How far back">
          <Glide on={range} />
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
              <Readout text={String(emails.length)} id="inbox-emails" /> email{emails.length === 1 ? '' : 's'}
              {unread ? (
                <>
                  {' · '}
                  <Readout text={String(unread)} id="inbox-unread" /> unread
                </>
              ) : (
                ''
              )}
            </span>
          )}
          {st.lastError && <span style={{ color: 'var(--wn)' }} title={st.lastError}>Couldn’t update</span>}
          <span>{busy ? 'Checking for new mail…' : st.lastSuccess ? `Updated ${ago(st.lastSuccess, now)}` : ''}</span>
          {/* Checking sends a ping out from the button, again and again until the answer's in (idea 31). */}
          <span className="inbox-ping" data-busy={busy || undefined}>
            <button className="icon-btn md" title="Check for new mail and summarise it now" aria-label="Check for new mail" aria-busy={busy} disabled={busy} onClick={onRefresh}>
              <i className={'ph-duotone ph-arrow-clockwise' + (busy ? ' spin' : '')} />
            </button>
          </span>
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

      {acts && (
        // The panel goes the way its last bill does, and the page closes up after it.
        <FoldRow show={bills.some((x) => !x.gone)}>
          <section className="panel inbox-bills" aria-label="Bills and receipts">
            <div className="panel-head">
              <h2 className="panel-title">Bills and receipts</h2>
              <span className="meta">From your email · nothing goes into Money until you keep it</span>
            </div>
            <div className="scroll">
              {bills.map(({ item: b, gone }) => (
                <FoldRow key={b.id} show={!gone}>
                  <div
                    className="bill-row"
                    data-bill={b.id}
                    {...menuProps(
                      () => [
                        { label: 'Add to Money', icon: 'ph-wallet', onSelect: () => acts.onKeepBill(b) },
                        { label: 'Open the email', icon: 'ph-arrow-square-out', href: gmailUrl(google.email, b.threadId), newTab: true },
                        'sep',
                        { label: 'Dismiss', icon: 'ph-x', danger: true, confirm: `Dismiss “${b.subject}”? It won’t be suggested again.`, onSelect: () => acts.onDismissBill(b) },
                      ],
                      b.subject,
                    )}
                  >
                    <div className="bill-what">
                      {billLine(b)}
                      <a href={gmailUrl(google.email, b.threadId)} target="_blank" rel="noopener" title={b.source === 'claude' ? 'Read by Claude' : undefined}>
                        {b.subject}
                      </a>
                    </div>
                    <div className="pkg-new">
                      <button className="keep" onClick={() => acts.onKeepBill(b)}>
                        Keep
                      </button>
                      <button className="dismiss" onClick={() => acts.onDismissBill(b)}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                </FoldRow>
              ))}
            </div>
          </section>
        </FoldRow>
      )}

      {!inbox.fetchedAt ? (
        <div className="panel">
          <div className={'news-note' + (st.lastError ? '' : ' lp-loading')}>{st.lastError ? `Couldn’t read Gmail: ${st.lastError}` : 'Reading your inbox…'}</div>
        </div>
      ) : !emails.length ? (
        <div className="panel">
          <div className="news-note">No email in {r.words}.</div>
        </div>
      ) : !data.newsSummaries ? (
        <div className="news-grid inbox-grid">
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
                <p className="inbox-overview" data-copy="summary">{digest.overview}</p>
                {digest.skimmed && <p className="inbox-skimmed">{digest.skimmed}</p>}
              </>
            ) : (
              !inbox.error && <div className="news-note">Claude is reading {emails.length} emails…</div>
            )}
          </section>
          <div className="news-grid inbox-grid">
            {COLUMNS.map((c) => {
              const all = digest?.items.filter((i) => i.kind === c.kind) ?? [];
              // An item whose emails were all archived here is done with (it folds away as it goes).
              const live = (i: InboxItem) => liveEmails(i, byId).length > 0;
              const items = all.filter(live);
              const fresh = items.filter((i) => i.emails.some((id) => arrived.has(id)));
              return (
                <section key={c.kind} className="panel" aria-label={c.title}>
                  <div className="panel-head">
                    <h2 className="panel-title">{c.title}</h2>
                    {items.length > 0 && (
                      <span className="meta">
                        <Readout text={String(items.length)} id={`inbox-${c.kind}`} />
                      </span>
                    )}
                  </div>
                  <div className="scroll inbox-col">
                    {digest && !items.length && c.empty && <div className="news-note">{c.empty}</div>}
                    {all.map((it) => (
                      <FoldRow key={it.emails.join(',') || it.headline} show={live(it)} arriving={fresh.includes(it)} i={fresh.length - 1 - fresh.indexOf(it)}>
                        <Item it={it} byId={byId} account={google.email} acts={acts} notify={notify} />
                      </FoldRow>
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

const billKey = (b: BillSuggestion) => b.id;
const NO_BILLS: BillSuggestion[] = [];

/** The emails a row in the view shows (its data-mail), to tell which rows go when emails are archived. */
const rowMails = (row: Element) => row.querySelector<HTMLElement>('[data-mail]')?.dataset.mail?.split(' ').filter(Boolean) ?? [];

/** How long the unread dot takes to go out once an email's read: past the end of the longest way a design does it. */
const DOT_OUT_MS = 700;

/** An unread email's dot. When it's read the dot goes out like a light rather than vanishing (styles.css, Inbox). */
function UnreadDot({ on }: { on: boolean }) {
  const [was, setWas] = useState(on);
  const [out, setOut] = useState(false);
  if (was !== on) {
    setWas(on);
    setOut(!on);
  }
  useEffect(() => {
    if (!out) return;
    const t = window.setTimeout(() => setOut(false), DOT_OUT_MS);
    return () => window.clearTimeout(t);
  }, [out]);
  if (!on && !out) return null;
  return on ? <span className="unread-dot" aria-label="Unread" /> : <span className="unread-dot" data-out="" aria-hidden="true" />;
}

/** Right-click on an email or a digest item: what its buttons do, plus opening it in Gmail. */
/** `copy`: what the item says, to copy whole (on a phone its text can't be selected). */
function mailMenu(mails: InboxEmail[], account: string | undefined, acts: Acts | undefined, copy: { label: string; text: string; notify?: (msg: string) => void }): MenuItem[] {
  const n = mails.length > 1 ? ` all ${mails.length}` : '';
  const newest = mails.reduce<InboxEmail | undefined>((a, m) => (!a || m.at > a.at ? m : a), undefined);
  return [
    newest && { label: 'Open in Gmail', icon: 'ph-arrow-square-out', href: gmailUrl(account, newest.threadId), newTab: true },
    'sep',
    acts?.canModify && mails.length > 0 && { label: `Archive${n}`, icon: 'ph-archive', onSelect: () => acts.onAction(mails, 'archive') },
    acts?.canModify && mails.some((m) => m.unread) && { label: `Mark${n} read`, icon: 'ph-envelope-open', onSelect: () => acts.onAction(mails, 'read') },
    'sep',
    copy.text && { label: copy.label, icon: 'ph-copy', onSelect: () => copyText(copy.text, copy.notify) },
  ];
}

function Item({ it, byId, account, acts, notify }: { it: InboxItem; byId: Map<string, InboxEmail>; account?: string; acts?: Acts; notify?: (msg: string) => void }) {
  const mails = liveEmails(it, byId);
  // One link per sender, to their newest email in the item.
  const senders = [...new Map(mails.map((m) => [m.fromEmail, m])).values()];
  const anyUnread = mails.some((m) => m.unread);
  const n = mails.length > 1 ? ` all ${mails.length}` : '';
  return (
    <article className="story" data-mail={mails.map((m) => m.id).join(' ')} {...menuProps(() => mailMenu(mails, account, acts, { label: 'Copy summary', text: [it.headline, it.summary].filter(Boolean).join('\n'), notify }), it.headline)}>
      <div className="story-headline">
        {it.headline}
        {it.due && <span className="chip chip-warn inbox-due">{it.due}</span>}
      </div>
      <p className="story-summary">{it.summary}</p>
      {senders.length > 0 && (
        <div className="story-links">
          {senders.map((m) => (
            <a key={m.id} href={gmailUrl(account, m.threadId)} target="_blank" rel="noopener" title={m.subject}>
              <UnreadDot on={mails.some((x) => x.fromEmail === m.fromEmail && x.unread)} />
              {m.from}
            </a>
          ))}
        </div>
      )}
      {acts?.canModify && mails.length > 0 && (
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
        </div>
      )}
    </article>
  );
}

function EmailRow({ e, now, account, acts, notify }: { e: InboxEmail; now: Date; account?: string; acts?: Acts; notify?: (msg: string) => void }) {
  return (
    <div className="email-wrap" data-mail={e.id} {...menuProps(() => mailMenu([e], account, acts, { label: 'Copy subject and preview', text: [e.subject, e.snippet].filter(Boolean).join('\n'), notify }), e.subject)}>
      <a className={'headline email-row' + (e.unread ? ' unread' : '')} href={gmailUrl(account, e.threadId)} target="_blank" rel="noopener">
        <span className="split">
          <span className="email-from">
            <UnreadDot on={e.unread} />
            {e.from}
          </span>
          <span className="headline-meta" style={{ flex: 'none' }}>
            {ago(e.at, now)}
          </span>
        </span>
        <span className="headline-title">{e.subject}</span>
        {e.snippet && <span className="headline-meta email-snippet">{e.snippet}</span>}
      </a>
      {acts?.canModify && (
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
        </div>
      )}
    </div>
  );
}
