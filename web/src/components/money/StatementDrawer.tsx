import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { fmtMoney, monthName } from '../../../../shared/money';
import { applyReview, asMove, canBeYou, merchantsToAsk, patchAlike, patchProposal, reviewStatement, splitTip, type Action, type Applied, type Correction, type Proposal, type Review, type Statement } from '../../../../shared/statement';
import type { BillSuggestion, Money, MoneyCategory, StatementContext, StatementEmail } from '../../../../shared/types';
import { CATEGORIES } from '../../../../shared/money';
import { api } from '../../api';
import { newId } from '../../util';
import { copyText, menuProps, type MenuItem } from '../ContextMenu';
import { Drawer } from '../Drawers';
import { AccountSelect, CategoryCell, namesOf, shortDate, type Notify } from './shared';

type Filter = 'all' | 'check' | 'busking' | 'matched';
const FILTERS: { key: Filter; name: string }[] = [
  { key: 'all', name: 'All' },
  { key: 'check', name: 'To check' },
  { key: 'busking', name: 'Busking' },
  { key: 'matched', name: 'Already in Money' },
];

const EMPTY: StatementContext = { sessions: [], emails: [], names: {}, notes: [] };

/** Pending Inbox suggestions in SGD, to match against the statement. */
const pendingOf = (bills: BillSuggestion[]): StatementEmail[] =>
  bills.filter((b) => b.currency === 'SGD').map((b) => ({ id: b.id, payee: b.payee, subject: b.subject, amount: b.amount, date: b.date, status: b.status, category: b.category }));

/** Wants a second look: matched to something, a guessed session, or no category. */
const toCheck = (p: Proposal) => !!p.match || !!p.email || p.session?.from === 'guess' || (p.entry.kind !== 'move' && !p.entry.category);

/** Lines from before Money starts are only listed once they're asked for. */
const listed = (p: Proposal) => !(p.early && p.action === 'skip');

/** What merging does, in a few words for the row's picker. */
function mergeLabel(p: Proposal): string {
  const m = p.match!;
  if (p.session) return m.imported ? 'Add to your entry' : 'Replace your amount';
  return m.planned ? 'Tick your planned one' : 'Already in Money';
}

/** What merging does, in full, for the row's note and menu. */
function mergeText(p: Proposal): string {
  const m = p.match!;
  const yours = `“${m.note || 'No note'}”, ${shortDate(m.date)}`;
  if (p.session) return m.imported ? `Adds ${fmtMoney(p.entry.amount)} to ${yours}` : `You typed ${fmtMoney(m.amount)} as ${yours}: it becomes the bank’s ${fmtMoney(p.entry.amount)}`;
  return m.planned ? `Ticks your planned ${yours} done${m.date !== p.entry.date ? `, on ${shortDate(p.entry.date)}` : ''}` : `You have ${yours}: it’s kept and linked to this line`;
}

const FROM_NAME: Record<Proposal['from'], string> = { learned: 'Remembered', rule: '', claude: 'Named by Claude', email: 'From an email', bank: '' };

/**
 * Reviews a bank statement before it goes into Money: each new line as an entry (a busking
 * session's tips as one), with what's already in Money matched, names and categories filled
 * in, and the account's balance checked against the bank's. Nothing changes until Add.
 */
export function StatementDrawer({ statement, money, bills, notify, onApply, onClose }: {
  statement: Statement;
  money: Money;
  bills: BillSuggestion[];
  notify: Notify;
  onApply: (a: Applied, summary: string) => void;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<StatementContext | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [account, setAccount] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [correct, setCorrect] = useState<Correction>(false);
  const [open, setOpen] = useState<string | null>(null);
  const first = statement.lines[0]?.posted ?? statement.asOf;
  const last = statement.lines[statement.lines.length - 1]?.posted ?? statement.asOf;

  // What the server can add: busking sessions, bill emails and shops' names. Without it, the bank's own text.
  useEffect(() => {
    let live = true;
    const merchants = merchantsToAsk(statement, money);
    const fresh = statement.lines.some((l) => !money.entries.some((e) => e.refs?.includes(l.key)));
    if (!fresh) return void setCtx(EMPTY);
    api
      .statementContext({ from: first, to: last, merchants })
      .then((c) => live && setCtx(c))
      .catch((e: Error) => live && setCtx({ ...EMPTY, notes: [`Couldn’t ask Launchpad’s server about your calendar, emails and shops: ${e.message}`] }));
    return () => void (live = false);
    // Once per statement: edits to Money while it's open don't ask again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statement]);

  useEffect(() => {
    if (ctx) setReview(reviewStatement(statement, money, ctx, { account: account || undefined, pendingBills: pendingOf(bills) }));
    // A new account starts the review over; Money changing elsewhere doesn't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, account, statement]);

  const preview = useMemo(() => (review ? applyReview(money, review, () => 'preview') : null), [money, review]);
  const patch = useCallback((id: string, f: (p: Proposal) => Proposal) => setReview((r) => (r ? patchProposal(r, id, f) : r)), []);
  const split = useCallback((sessionId: string, key: string) => setReview((r) => (r ? splitTip(r, sessionId, key, money) : r)), [money]);
  const makeMove = useCallback((id: string, other: string) => setReview((r) => (r ? patchAlike(r, id, 'move', (p) => asMove(p, r, other, money)) : r)), [money]);
  const setAlike = useCallback((id: string, what: 'note' | 'category', f: (p: Proposal) => Proposal) => setReview((r) => (r ? patchAlike(r, id, what, f) : r)), []);
  const toggleOpen = useCallback((id: string) => setOpen((o) => (o === id ? null : id)), []);

  const title = 'Import a bank statement';
  if (!review || !preview) {
    return (
      <Drawer title={title} onClose={onClose} wide>
        <p className="stm-wait">
          <i className="ph-duotone ph-circle-notch spin" aria-hidden="true" />
          Reading {statement.lines.length} lines and checking your calendar, emails and shops…
        </p>
      </Drawer>
    );
  }

  const ps = review.proposals.filter(listed);
  const names = namesOf(money);
  const counts: Record<Filter, number> = { all: ps.length, check: ps.filter(toCheck).length, busking: ps.filter((p) => p.session).length, matched: ps.filter((p) => p.match).length };
  const shown = ps.filter((p) => (filter === 'all' ? true : filter === 'check' ? toCheck(p) : filter === 'busking' ? !!p.session : !!p.match));
  const months = [...new Set(shown.map((p) => p.entry.date.slice(0, 7)))];
  const early = review.proposals.filter((p) => p.early);
  const earlyOn = early.length > 0 && early.every((p) => p.action !== 'skip');
  const adding = ps.filter((p) => p.action === 'add' || (p.action === 'merge' && !p.match)).length;
  const merging = ps.filter((p) => p.action === 'merge' && p.match).length;
  const tips = ps.filter((p) => p.session);
  const tipLines = tips.reduce((s, p) => s + p.lines.length, 0);
  const acctName = names.get(review.account) ?? 'the account';
  const bank = statement.ledger;
  const off = bank === null ? 0 : Math.round((bank - preview.balance) * 100) / 100;
  const opening = preview.money.accounts.find((a) => a.id === review.account)?.opening ?? 0;
  const held = bank !== null && statement.available !== null ? Math.round((bank - statement.available) * 100) / 100 : 0;

  const apply = () => {
    const a = applyReview(money, review, () => newId('e'), { correct: Math.abs(off) >= 0.005 && correct });
    const fixed = a.corrected && (correct === 'opening' ? `${acctName}’s starting balance changed by ${fmtMoney(a.corrected, true)}` : `${acctName} corrected by ${fmtMoney(a.corrected, true)}`);
    const bits = [a.added && `${a.added} added`, a.merged && `${a.merged} matched to entries you had`, fixed].filter(Boolean);
    onApply(a, bits.length ? `Statement imported: ${bits.join(', ')}` : 'Nothing new to import');
  };

  const foot = (
    <>
      <button className="btn btn-primary" disabled={!adding && !merging && !(correct && off)} onClick={apply}>
        {adding || merging ? [adding && `Add ${adding}`, merging && `match ${merging}`].filter(Boolean).join(', ').replace(/^m/, 'M') : correct && off ? 'Correct the balance' : 'Nothing to add'}
      </button>
      <button className="btn btn-ghost" onClick={onClose}>
        Cancel
      </button>
      <span className="meta stm-foot-note">Nothing changes until you press it, and it can be undone.</span>
    </>
  );

  return (
    <Drawer title={title} onClose={onClose} wide foot={foot}>
      <section className="stm-sum">
        <p className="stm-sum-head">
          <b>{statement.account || 'Bank statement'}</b>
          <span className="meta">
            {shortDate(first)} – {shortDate(last)} · {statement.lines.length} line{statement.lines.length === 1 ? '' : 's'}
          </span>
        </p>
        <label className="stm-acct">
          <span className="meta">Goes into</span>
          <AccountSelect money={money} value={review.account} label="Money account the statement is for" className="inline" onChange={setAccount} />
        </label>
        <ul className="stm-facts">
          <li>
            <b>{ps.length}</b> new {ps.length === 1 ? 'entry' : 'entries'}
            {tips.length > 0 && (
              <>
                , with {tipLines} tips as <b>{tips.length}</b> busking session{tips.length === 1 ? '' : 's'}
              </>
            )}
          </li>
          {review.imported > 0 && <li>{review.imported} line{review.imported === 1 ? ' was' : 's were'} imported before and {review.imported === 1 ? 'is' : 'are'} left out</li>}
          {statement.unsettled > 0 && <li>{statement.unsettled} not settled yet, left for the next statement</li>}
          {early.length > 0 && (
            <li>
              {early.length} {early.length === 1 ? 'is' : 'are'} from before Money starts ({shortDate(money.start)}).{' '}
              <button className="btn-link" onClick={() => setReview({ ...review, proposals: review.proposals.map((p) => (p.early ? { ...p, action: earlyOn ? 'skip' : p.match ? 'merge' : 'add' } : p)) })}>
                {earlyOn ? 'Leave them out' : 'Add them too'}
              </button>
              {earlyOn && <span className="meta"> Money will start earlier, with its starting balances worked back so today’s stay the same.</span>}
            </li>
          )}
        </ul>
        {ctx!.notes.map((n) => (
          <p key={n} className="stm-note-line">
            <i className="ph-duotone ph-info" aria-hidden="true" />
            {n}
          </p>
        ))}
      </section>

      {bank !== null && (
        <section className={'stm-bal' + (Math.abs(off) >= 0.005 ? ' off' : '')} aria-label="Balance check">
          <p>
            On {shortDate(statement.asOf)} the bank says {acctName} had <b className="tnum">{fmtMoney(bank)}</b>.{' '}
            {Math.abs(off) < 0.005 ? (
              <>
                With this import Money says the same. <i className="ph-duotone ph-check-circle" aria-label="They match" />
              </>
            ) : (
              <>
                With this import Money would say <b className="tnum">{fmtMoney(preview.balance)}</b>, {fmtMoney(Math.abs(off))} {off > 0 ? 'less' : 'more'}.
              </>
            )}
          </p>
          {Math.abs(off) >= 0.005 && (
            <>
              <p className="meta">Something’s missing or doubled: a line you skipped, an entry dated after the statement, or a starting balance that was off. Look through “To check” first.</p>
              <div className="stm-fixes" role="radiogroup" aria-label="Make it match">
                {([
                  [false, 'Leave it as it is'],
                  ['entry', `Add a ${fmtMoney(off, true)} balance correction on ${shortDate(statement.asOf)}`],
                  ['opening', `Change ${acctName}’s starting balance on ${shortDate(preview.money.start)} from ${fmtMoney(opening)} to ${fmtMoney(opening + off)}, if that was what was off`],
                ] as [Correction, string][]).map(([k, text]) => (
                  <label key={String(k)} className="stm-fix">
                    <input type="radio" name="stm-fix" checked={correct === k} onChange={() => setCorrect(k)} />
                    <span>{text}</span>
                  </label>
                ))}
              </div>
            </>
          )}
          {held > 0.004 && <p className="meta">{fmtMoney(held)} more is held for card payments still going through; they’ll be on your next statement.</p>}
        </section>
      )}

      <section className="stm-list" aria-label="Entries to add">
        <div className="stm-tools">
          <div className="seg" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} className={filter === f.key ? 'on' : ''} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
                {f.name} <span className="stm-count">{counts[f.key]}</span>
              </button>
            ))}
          </div>
        </div>
        {!ps.length && <p className="month-empty">Everything on this statement is already in Money.</p>}
        {ps.length > 0 && !shown.length && <p className="month-empty">Nothing here.</p>}
        {months.map((key) => {
          const rows = shown.filter((p) => p.entry.date.startsWith(key));
          const sum = (k: 'in' | 'out') => rows.filter((p) => p.action !== 'skip' && p.entry.kind === k).reduce((s, p) => s + p.entry.amount, 0);
          return (
            <div key={key} className="stm-month">
              <h3 className="stm-month-head">
                <span>{monthName(key)}</span>
                <span className="meta tnum">
                  in {fmtMoney(sum('in'))} · out {fmtMoney(sum('out'))}
                </span>
              </h3>
              {rows.map((p) => (
                <Row key={p.id} p={p} money={money} account={review.account} open={open === p.id} onOpen={toggleOpen} onPatch={patch} onAlike={setAlike} onSplit={split} onMove={makeMove} notify={notify} />
              ))}
            </div>
          );
        })}
      </section>
    </Drawer>
  );
}

const Row = memo(function Row({ p, money, account, open, onOpen, onPatch, onAlike, onSplit, onMove, notify }: {
  p: Proposal;
  money: Money;
  account: string;
  open: boolean;
  onOpen: (id: string) => void;
  onPatch: (id: string, f: (p: Proposal) => Proposal) => void;
  /** The same change to every row from this shop or person. */
  onAlike: (id: string, what: 'note' | 'category', f: (p: Proposal) => Proposal) => void;
  onSplit: (sessionId: string, key: string) => void;
  onMove: (id: string, other: string) => void;
  notify: Notify;
}) {
  const e = p.entry;
  const names = namesOf(money);
  const setAction = (action: Action) => onPatch(p.id, (x) => ({ ...x, action }));
  const setCategory = (category: MoneyCategory | '') => onAlike(p.id, 'category', (x) => ({ ...x, entry: { ...x.entry, category } }));
  const skipped = p.action === 'skip';
  const line = p.lines[0];
  // PayNow and bank transfers come from bank accounts, so only those can be you.
  const others = money.accounts.filter((a) => a.id !== account && !a.archived && a.kind === 'bank');
  const [renaming, setRenaming] = useState(false);
  const isMove = e.kind === 'move';
  const otherId = isMove ? (e.account === account ? e.to : e.account) : '';
  const label = e.note || 'Entry';

  const items = (): MenuItem[] => {
    const out: MenuItem[] = [];
    if (p.match) {
      if (p.action !== 'merge') out.push({ label: mergeLabel(p), icon: 'ph-link-simple', onSelect: () => setAction('merge') });
      if (p.action !== 'add') out.push({ label: 'Add as a new entry', icon: 'ph-plus', onSelect: () => setAction('add') });
    } else if (skipped) out.push({ label: 'Add it', icon: 'ph-plus', onSelect: () => setAction('add') });
    if (!skipped) out.push({ label: 'Leave it out', icon: 'ph-minus-circle', onSelect: () => setAction('skip') });
    out.push({ label: 'Rename', icon: 'ph-pencil-simple', onSelect: () => setRenaming(true) });
    if (p.session) out.push({ label: open ? 'Hide the tips' : `Show the ${p.lines.length} tips`, icon: 'ph-list', onSelect: () => onOpen(p.id) });
    out.push('sep');
    if (!isMove) for (const c of CATEGORIES) out.push({ label: e.category === c ? `${c} ✓` : c, icon: 'ph-tag', onSelect: () => setCategory(c), disabled: e.category === c });
    out.push('sep');
    if (canBeYou(p)) {
      if (isMove) out.push({ label: `Not me: money ${line.dir}`, icon: 'ph-user', onSelect: () => onMove(p.id, '') });
      else for (const a of others) out.push({ label: `It’s me, ${line.dir === 'in' ? 'from' : 'to'} ${a.name}`, icon: 'ph-arrows-left-right', onSelect: () => onMove(p.id, a.id) });
    }
    out.push('sep', { label: 'Copy the bank’s text', icon: 'ph-copy', onSelect: () => copyText(p.lines.map((l) => `${l.posted} ${l.text} ${l.dir === 'in' ? '+' : '-'}${l.amount.toFixed(2)}`).join('\n'), notify) });
    return out;
  };

  return (
    <div className={'stm-row' + (skipped ? ' off' : '') + (open ? ' open' : '')}>
      <div className="stm-row-main" {...menuProps(items, `Actions for ${label}`)}>
        {p.match ? (
          <select className="cell pick stm-act" aria-label={`What to do with ${label}`} value={p.action} onChange={(x) => setAction(x.target.value as Action)}>
            <option value="merge">{mergeLabel(p)}</option>
            <option value="add">Add as new</option>
            <option value="skip">Leave out</option>
          </select>
        ) : (
          <button className="stm-pick" role="checkbox" aria-checked={!skipped} aria-label={`Add ${label}`} onClick={() => setAction(skipped ? 'add' : 'skip')}>
            <span className={'check' + (skipped ? '' : ' on')}>{!skipped && <i className="ph-duotone ph-check" />}</span>
          </button>
        )}
        <div className="stm-body">
          {renaming ? (
            <input
              className="cell stm-name"
              autoFocus
              autoComplete="off"
              aria-label="Note"
              maxLength={120}
              value={e.note}
              onChange={(x) => {
                const note = x.target.value;
                onAlike(p.id, 'note', (q) => ({ ...q, entry: { ...q.entry, note } }));
              }}
              onBlur={() => setRenaming(false)}
              onKeyDown={(k) => (k.key === 'Enter' || k.key === 'Escape') && setRenaming(false)}
            />
          ) : (
            // Text until it's clicked, so a right-click on the name opens the row's menu, not the field's.
            <button className="stm-name-btn" title="Rename" onClick={() => setRenaming(true)}>
              {e.note || <span className="ent-none">No note</span>}
            </button>
          )}
          <div className="stm-meta">
            <span className="tnum" title={line.posted !== e.date ? `Booked by the bank on ${shortDate(line.posted)}` : undefined}>
              {shortDate(e.date)}
            </span>
            {isMove ? (
              <span className="ent-acct">
                <i className="ph-duotone ph-arrows-left-right" aria-hidden="true" /> {e.account === account ? 'to' : 'from'} {names.get(otherId) ?? '?'}
              </span>
            ) : (
              <CategoryCell value={e.category} label={`Category for ${label}`} className="stm-cat" empty="No category" onChange={setCategory} />
            )}
            {p.session && (
              <button className="btn-link stm-tips" aria-expanded={open} onClick={() => onOpen(p.id)}>
                {open ? 'Hide tips' : `${p.lines.length} tips`}
              </button>
            )}
            {p.session?.from === 'guess' && <span className="chip chip-warn" title="Lots of small PayNows on a day with no busking on your calendar">No session on the calendar</span>}
            {p.session?.from === 'nac' && <span className="chip chip-muted">NAC booking</span>}
            {p.session?.from === 'calendar' && <span className="chip chip-muted">On your calendar</span>}
            {p.early && <span className="chip chip-muted">Before Money starts</span>}
            {p.email && (
              <span className="chip chip-accent" title={p.email.subject}>
                <i className="ph-duotone ph-envelope-simple" aria-hidden="true" /> {p.email.pending ? 'In Inbox’s bills: it’ll be cleared there' : 'Email'}: {p.email.payee}
              </span>
            )}
            {FROM_NAME[p.from] && !p.email && <span className="stm-from">{FROM_NAME[p.from]}</span>}
          </div>
          {p.match && <p className={'stm-match' + (p.action === 'merge' ? ' on' : '')}>{mergeText(p)}</p>}
        </div>
        <span className={'ent-amt tnum' + (e.kind === 'in' ? ' in' : '')}>{isMove ? fmtMoney(e.amount) : fmtMoney(e.kind === 'in' ? e.amount : -e.amount, true)}</span>
      </div>
      {open && p.session && (
        <ul className="stm-tiplist" aria-label="Tips in this session">
          {p.lines.map((l) => {
            const who = l.ref2.replace(/^From:\s*/i, '');
            const memo = l.ref3.replace(/^OTHR\s*/i, '');
            return (
              <li
                key={l.key}
                {...menuProps((): MenuItem[] => [
                  { label: 'Not a tip: add it on its own', icon: 'ph-arrow-square-out', onSelect: () => onSplit(p.id, l.key) },
                  'sep',
                  { label: 'Copy the bank’s text', icon: 'ph-copy', onSelect: () => copyText(`${l.posted} ${l.text} +${l.amount.toFixed(2)}`, notify) },
                ], `Actions for the ${fmtMoney(l.amount)} tip`)}
              >
                <span className="tnum stm-tip-amt">{fmtMoney(l.amount)}</span>
                <span className="stm-tip-who">
                  {who}
                  {memo && !/^(paynow transfer|othr)$/i.test(memo) && <span className="meta"> · {memo}</span>}
                </span>
                <span className="meta tnum">{shortDate(l.posted)}</span>
                <button className="btn-link" onClick={() => onSplit(p.id, l.key)}>
                  Not a tip
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
});
