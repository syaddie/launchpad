import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../../../../shared/money';
import { EVERY_NAMES, type Series } from '../../../../shared/subscriptions';
import type { Money, MoneyEntry } from '../../../../shared/types';
import { buzz } from '../../buzz';
import { copyText, menuProps } from '../ContextMenu';
import { AccountSelect, CategoryCell, DateCell, entryTitle, type Kind, KindSwitch, namesOf, type Notify, NumCell, otherAccount, shortDate, signed, TextCell } from './shared';

/**
 * One entry: a tick, what it was, its account and the amount. Click it to change it; right-click
 * (or long-press) for the same and more. An invoice's money is tagged with the invoice; its amount,
 * and its date while it's planned, follow the invoice, so those are changed in Owed.
 */
export function EntryRow({ e, series, isSub, onSub, money, today, open, onOpen, onClose, onPatch, onDelete, onOpenOwed, notify }: {
  e: MoneyEntry;
  /** The repeat it's part of, if any: one that's money out can be marked as a subscription. */
  series?: Series;
  isSub: boolean;
  onSub: (on: boolean) => void;
  money: Money;
  today: string;
  open: boolean;
  /** `keyboard`: opened from the keyboard, so its first field takes focus. */
  onOpen: (keyboard: boolean) => void;
  onClose: () => void;
  onPatch: (p: Partial<MoneyEntry>) => void;
  onDelete: () => void;
  onOpenOwed: () => void;
  notify: Notify;
}) {
  const late = e.planned && e.date < today;
  const names = namesOf(money);
  const title = entryTitle(e, names);
  const inv = e.invoice ? money.invoices.find((i) => i.id === e.invoice) : undefined;
  const amount = e.kind === 'move' ? fmtMoney(e.amount) : fmtMoney(signed(e), true);

  // From the keyboard, opening puts focus in the form and closing puts it back on the entry, so it
  // isn't lost with the part that was there; a click leaves it where it lands.
  const row = useRef<HTMLDivElement>(null);
  const focusForm = useRef(false);
  const refocus = useRef(false);
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open === wasOpen.current) return;
    wasOpen.current = open;
    const el = row.current;
    if (!el) return;
    if (open) {
      const first = focusForm.current ? el.querySelector<HTMLElement>('.ent-form :is(input, select, button)') : null;
      const lost = !document.activeElement || document.activeElement === document.body;
      if (first) first.focus({ preventScroll: true });
      else if (lost) el.focus({ preventScroll: true });
    } else if (refocus.current) el.querySelector<HTMLElement>('.ent-main')?.focus({ preventScroll: true });
    focusForm.current = false;
    refocus.current = false;
  }, [open]);
  const openIt = (keyboard: boolean) => {
    focusForm.current = keyboard;
    onOpen(keyboard);
  };
  const close = (keyboard: boolean) => {
    refocus.current = keyboard;
    onClose();
  };
  /** Ticked here (not just shown done), so a design can make the tick land with some light (Mission's flare). */
  const [ticked, setTicked] = useState(false);
  const toggle = () => {
    setTicked(e.planned);
    if (e.planned) buzz('tick');
    onPatch({ planned: !e.planned });
  };

  const menu = menuProps(
    () => [
      { label: e.planned ? 'Mark as done' : 'Mark as planned', icon: e.planned ? 'ph-check-circle' : 'ph-circle-dashed', onSelect: toggle },
      open ? { label: 'Done changing', icon: 'ph-check', onSelect: () => close(true) } : { label: 'Change', icon: 'ph-pencil-simple', onSelect: () => openIt(false) },
      !!series?.every && e.kind === 'out' && { label: isSub ? 'Not a subscription' : 'Mark as a subscription', icon: 'ph-repeat', onSelect: () => onSub(!isSub) },
      !!inv && { label: 'Change it in Owed', icon: 'ph-link-simple', onSelect: onOpenOwed },
      'sep',
      { label: 'Copy', icon: 'ph-copy', onSelect: () => copyText(`${shortDate(e.date)} · ${title} · ${amount}${e.planned ? ' (planned)' : ''}`, notify) },
      'sep',
      { label: inv ? 'Delete, along with its invoice' : 'Delete', icon: 'ph-trash', danger: true, onSelect: onDelete },
    ],
    title,
  );
  const tick = (
    <button
      className={'ent-check' + (ticked ? ' ticked' : '')}
      title={e.planned ? 'Planned. Tick it once it’s happened' : 'Done. Untick to make it planned again'}
      aria-label={e.planned ? `Mark ${title} as done` : `Mark ${title} as planned`}
      aria-pressed={!e.planned}
      onClick={toggle}
    >
      <span className={'ent-tick' + (e.planned ? '' : ' on') + (late ? ' late' : '')}>{!e.planned && <i className="ph-duotone ph-check" />}</span>
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
        ref={row}
        className="ent editing"
        data-entry={e.id}
        tabIndex={-1}
        {...menu}
        // Esc anywhere in it (a field too) closes it, and goes no further: not to the field, nor to the app's Esc for Home.
        onKeyDownCapture={(k) => {
          if (k.key !== 'Escape') return;
          k.preventDefault();
          k.stopPropagation();
          close(true);
        }}
        onKeyDown={(k) => {
          if (k.key === 'Enter' && (k.target as HTMLElement).tagName !== 'BUTTON') {
            k.preventDefault();
            close(true);
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
          <button className="btn btn-primary btn-small" onClick={(ev) => close(ev.detail === 0)}>
            Done
          </button>
          {del}
          {series?.every && e.kind === 'out' && (
            <span className="ent-linked">
              <i className="ph-duotone ph-repeat" aria-hidden="true" />
              {isSub ? 'A subscription' : `Repeats ${EVERY_NAMES[series.every].toLowerCase()}`}, {series.entries.length} in all.
              <button className="btn-link" onClick={() => onSub(!isSub)}>
                {isSub ? 'Not a subscription' : 'Mark as a subscription'}
              </button>
            </span>
          )}
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
    <div ref={row} className={'ent' + (e.planned ? ' planned' : '') + (late ? ' late' : '') + (e.kind === 'move' ? ' move' : '')} data-entry={e.id} {...menu}>
      {tick}
      <button className="ent-main" title="Change this entry" onClick={(ev) => openIt(ev.detail === 0)}>
        <span className="ent-note">
          {e.kind === 'move' && <i className="ph-duotone ph-arrows-left-right ent-move" aria-hidden="true" />}
          {e.kind !== 'move' && !e.note ? <span className="ent-none">No note</span> : title}
        </span>
        <span className="ent-meta">
          {e.kind === 'move' ? e.note || 'Moved between accounts' : e.category || 'No category'}
          {e.kind !== 'move' && money.accounts.length > 1 && <span className="ent-acct">{names.get(e.account)}</span>}
          {isSub && (
            <span className="ent-inv" title="Listed in Subscriptions">
              <i className="ph-duotone ph-repeat" aria-hidden="true" />
              Subscription
            </span>
          )}
          {inv && (
            <span className="ent-inv" title="From an invoice in Owed">
              <i className="ph-duotone ph-link-simple" aria-hidden="true" />
              {inv.num || 'Invoice'}
            </span>
          )}
          {late && <span className="chip chip-warn">Overdue</span>}
        </span>
      </button>
      <span className="ent-acts">
        <button className="icon-btn ent-x" title="Change" aria-label={`Change ${title}`} onClick={(ev) => openIt(ev.detail === 0)}>
          <i className="ph-duotone ph-pencil-simple" />
        </button>
        {del}
      </span>
      <span className={'ent-amt tnum' + (e.kind === 'in' ? ' in' : '')}>{amount}</span>
    </div>
  );
}
