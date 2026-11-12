import { fmtMoney } from '../../../../shared/money';
import type { Money, MoneyEntry } from '../../../../shared/types';
import { AccountSelect, CategoryCell, DateCell, entryTitle, type Kind, KindSwitch, namesOf, NumCell, otherAccount, shortDate, signed, TextCell } from './shared';

/**
 * One entry: a tick, what it was, its account and the amount. Click it to change it.
 * An invoice's money is tagged with the invoice; its amount, and its date while it's
 * planned, follow the invoice, so those are changed in Owed.
 */
export function EntryRow({ e, money, today, open, onOpen, onClose, onPatch, onDelete, onOpenOwed }: {
  e: MoneyEntry;
  money: Money;
  today: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPatch: (p: Partial<MoneyEntry>) => void;
  onDelete: () => void;
  onOpenOwed: () => void;
}) {
  const late = e.planned && e.date < today;
  const names = namesOf(money);
  const title = entryTitle(e, names);
  const inv = e.invoice ? money.invoices.find((i) => i.id === e.invoice) : undefined;
  const tick = (
    <button
      className="ent-check"
      title={e.planned ? 'Planned. Tick it once it’s happened' : 'Done. Untick to make it planned again'}
      aria-label={e.planned ? `Mark ${title} as done` : `Mark ${title} as planned`}
      aria-pressed={!e.planned}
      onClick={() => onPatch({ planned: !e.planned })}
    >
      <span className={'ent-tick' + (e.planned ? '' : ' on') + (late ? ' late' : '')}>{!e.planned && <i className="ph-bold ph-check" />}</span>
    </button>
  );
  const del = (
    <button className="icon-btn ent-x" title={inv ? 'Delete, along with its invoice' : 'Delete'} aria-label={`Delete ${title}`} onClick={onDelete}>
      <i className="ph-duotone ph-x" />
    </button>
  );

  if (open) {
    const setKind = (kind: Kind) => onPatch(kind === 'move' ? { kind, category: '', to: e.to && e.to !== e.account ? e.to : otherAccount(money, e.account) } : { kind, to: '' });
    return (
      <div
        className="ent editing"
        onKeyDown={(k) => {
          if (k.key === 'Escape' || (k.key === 'Enter' && (k.target as HTMLElement).tagName !== 'BUTTON')) {
            k.preventDefault();
            onClose();
          }
        }}
      >
        {tick}
        <div className="ent-form">
          {inv ? (
            <>
              <span className="ent-lock ent-field-note" title="The invoice’s event: change it in Owed">
                {title}
              </span>
              {e.planned ? (
                <span className="ent-lock tnum" title="The invoice’s due date: change it in Owed">
                  <i className="ph-duotone ph-lock-simple" aria-hidden="true" />
                  {shortDate(e.date)}
                </span>
              ) : (
                <DateCell value={e.date} label="Day it came in" onChange={(date) => onPatch({ date })} />
              )}
              <span className="ent-lock in tnum" title="The invoice’s amount: change it in Owed">
                <i className="ph-duotone ph-lock-simple" aria-hidden="true" />
                In {fmtMoney(e.amount, true)}
              </span>
            </>
          ) : (
            <>
              <TextCell value={e.note} label="Note" max={120} placeholder="Note" className="ent-field ent-field-note" onChange={(note) => onPatch({ note })} />
              <DateCell value={e.date} label="Date" onChange={(date) => onPatch({ date })} />
              <KindSwitch kind={e.kind} label="Entry is" onChange={setKind} />
              <NumCell value={e.amount} label="Amount" className="ent-field ent-field-amt" onChange={(v) => onPatch({ amount: Math.abs(v ?? 0) })} />
            </>
          )}
          <AccountSelect
            money={money}
            value={e.account}
            label={e.kind === 'move' ? 'From' : e.kind === 'in' ? 'Into' : 'From'}
            onChange={(account) => onPatch(account === e.to ? { account, to: e.account } : { account })}
          />
          {e.kind === 'move' ? (
            <>
              <span className="meta">to</span>
              <AccountSelect money={money} value={e.to} label="To" onChange={(to) => onPatch(to === e.account ? { to, account: e.to } : { to })} />
            </>
          ) : (
            <CategoryCell value={e.category} label="Category" className="ent-field" empty="Category" onChange={(category) => onPatch({ category })} />
          )}
          <button className="btn btn-primary btn-small" onClick={onClose}>
            Done
          </button>
          {del}
          {inv && (
            <span className="ent-linked">
              <i className="ph-duotone ph-link-simple" aria-hidden="true" />
              From {inv.num || 'an invoice'}: its event, amount{e.planned ? ' and date' : ''} follow the invoice.
              <button className="btn-link" onClick={onOpenOwed}>
                Change them in Owed
              </button>
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={'ent' + (e.planned ? ' planned' : '') + (late ? ' late' : '') + (e.kind === 'move' ? ' move' : '')}>
      {tick}
      <button className="ent-main" title="Change this entry" onClick={onOpen}>
        <span className="ent-note">
          {e.kind === 'move' && <i className="ph-bold ph-arrows-left-right ent-move" aria-hidden="true" />}
          {e.kind !== 'move' && !e.note ? <span className="ent-none">No note</span> : title}
        </span>
        <span className="ent-meta">
          {e.kind === 'move' ? e.note || 'Moved between accounts' : e.category || 'No category'}
          {e.kind !== 'move' && money.accounts.length > 1 && <span className="ent-acct">{names.get(e.account)}</span>}
          {inv && (
            <span className="ent-inv" title="From an invoice in Owed">
              <i className="ph-bold ph-link-simple" aria-hidden="true" />
              {inv.num || 'Invoice'}
            </span>
          )}
          {late && <span className="chip chip-warn">Overdue</span>}
        </span>
      </button>
      <span className="ent-acts">
        <button className="icon-btn ent-x" title="Change" aria-label={`Change ${title}`} onClick={onOpen}>
          <i className="ph-duotone ph-pencil-simple" />
        </button>
        {del}
      </span>
      <span className={'ent-amt tnum' + (e.kind === 'in' ? ' in' : '')}>{e.kind === 'move' ? fmtMoney(e.amount) : fmtMoney(signed(e), true)}</span>
    </div>
  );
}
