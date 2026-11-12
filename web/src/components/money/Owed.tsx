import { useState } from 'react';
import { addDays, ymd } from '../../../../shared/dates';
import { fmtMoney, invoiceEntry, type InvoiceRow, invoiceRows, mainAccount, MAX_ENTRIES, MAX_INVOICES, monthName, nextInvoiceNum, sortEntries } from '../../../../shared/money';
import type { Invoice, Money, MoneyEntry } from '../../../../shared/types';
import { localGet, localSet } from '../../api';
import { dayDiff, newId, parseYmd } from '../../util';
import { AccountSelect, DateCell, namesOf, type Notify, NumCell, shortDate, TextCell } from './shared';

/** `num` null means the suggested next number. */
type InvoiceDraft = { num: string | null; event: string; amount: number | null; due: string; account: string };

/** Quick due dates, in days from today. */
const DUE_IN = [7, 14, 30];

/** The account gig pay went into last time, if it's still in use. */
function invoiceAccount(money: Money): string {
  const id = localGet('moneyInvoiceAccount');
  return money.accounts.some((a) => a.id === id && !a.archived) ? id! : mainAccount(money.accounts);
}

const byDue = (a: InvoiceRow, b: InvoiceRow) => (a.inv.due < b.inv.due ? -1 : a.inv.due > b.inv.due ? 1 : 0);
const byPaid = (a: InvoiceRow, b: InvoiceRow) => (a.paidOn > b.paidOn ? -1 : a.paidOn < b.paidOn ? 1 : 0);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sumOf = (rows: InvoiceRow[]) => rows.reduce((a, r) => a + r.inv.amount, 0);

/**
 * What people owe you, mostly for gigs. Each invoice is also planned money in on its due
 * date in Month; ticking it here (or there) makes that money done, on the day it came in.
 */
export function Owed({ money, today, onChange, onOpenMonth, notify }: { money: Money; today: string; onChange: (m: Money) => void; onOpenMonth: (k: string) => void; notify: Notify }) {
  const inDays = (n: number) => ymd(addDays(parseYmd(today), n));
  const [draft, setDraft] = useState<InvoiceDraft>(() => ({ num: null, event: '', amount: null, due: inDays(14), account: invoiceAccount(money) }));
  const [showPaid, setShowPaidState] = useState(() => localGet('owedPaid') !== 'hide');
  const setShowPaid = (v: boolean) => {
    setShowPaidState(v);
    localSet('owedPaid', v ? 'show' : 'hide');
  };
  const names = namesOf(money);
  const rows = invoiceRows(money, today);
  const open = rows.filter((r) => !r.paidOn).sort(byDue);
  const paid = rows.filter((r) => r.paidOn).sort(byPaid);
  const late = open.filter((r) => r.daysLeft < 0);
  const week = open.filter((r) => r.daysLeft >= 0 && r.daysLeft <= 7);
  const recent = paid.filter((r) => dayDiff(parseYmd(r.paidOn), parseYmd(today)) <= 30);

  const num = (draft.num ?? nextInvoiceNum(money.invoices)).trim();
  const canAdd = !!num && !!draft.due && !!draft.amount && money.invoices.length < MAX_INVOICES && money.entries.length < MAX_ENTRIES;
  const add = () => {
    if (!canAdd) return;
    const inv: Invoice = { id: newId('i'), num, event: draft.event.trim(), amount: Math.abs(draft.amount!), due: draft.due };
    onChange({ ...money, invoices: [...money.invoices, inv], entries: sortEntries([...money.entries, invoiceEntry(inv, draft.account, newId('e'))]) });
    localSet('moneyInvoiceAccount', draft.account);
    setDraft({ num: null, event: '', amount: null, due: inDays(14), account: draft.account });
    notify(`Added ${inv.num}: ${fmtMoney(inv.amount, true)} is planned money in to ${names.get(draft.account)} on ${shortDate(inv.due)}.`, {
      label: 'Open in Month',
      run: () => onOpenMonth(inv.due.slice(0, 7)),
    });
  };
  const patchInv = (id: string, p: Partial<Invoice>) => onChange({ ...money, invoices: money.invoices.map((i) => (i.id === id ? { ...i, ...p } : i)) });
  const patchEntry = (id: string, p: Partial<MoneyEntry>) => onChange({ ...money, entries: sortEntries(money.entries.map((e) => (e.id === id ? { ...e, ...p } : e))) });
  /** Paid: its money is done, on today. Not paid: planned again, back on the due date. */
  const setPaid = (r: InvoiceRow, on: boolean) => {
    patchEntry(r.entry.id, on ? { planned: false, date: today } : { planned: true });
    notify(on ? `${r.inv.num || 'Invoice'} paid: its ${fmtMoney(r.inv.amount)} in Month is now done, dated today.` : `${r.inv.num || 'Invoice'} is owed again: back to planned money in on ${shortDate(r.inv.due)}.`);
  };
  const remove = (r: InvoiceRow) => onChange({ ...money, invoices: money.invoices.filter((i) => i.id !== r.inv.id), entries: money.entries.filter((e) => e.id !== r.entry.id) });

  const due = draft.due ? dayDiff(parseYmd(today), parseYmd(draft.due)) : null;

  return (
    <div className="money-body owed">
      <div className="m-stats">
        <div className="m-stat hero">
          <span className="meta">Still owed to you</span>
          <span className="serif tnum">{fmtMoney(sumOf(open))}</span>
          <span className="meta">{open.length ? `${plural(open.length, 'invoice')} waiting` : 'all paid up'}</span>
        </div>
        <div className={'m-stat' + (late.length ? ' late' : '')}>
          <span className="meta">Overdue</span>
          <span className="serif tnum">{fmtMoney(sumOf(late))}</span>
          <span className="meta">{late.length ? `${plural(late.length, 'invoice')} past the due date` : 'nothing late'}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Due in the next 7 days</span>
          <span className="serif tnum">{fmtMoney(sumOf(week))}</span>
          <span className="meta">{week.length ? week.map((r) => r.inv.num || 'Invoice').join(', ') : 'nothing due this week'}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Paid, last 30 days</span>
          <span className="serif tnum">{fmtMoney(sumOf(recent))}</span>
          <span className="meta">{recent.length ? `${plural(recent.length, 'invoice')} paid` : 'nothing yet'}</span>
        </div>
      </div>

      <div
        className="composer"
        role="group"
        aria-label="Add an invoice"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
            e.preventDefault();
            add();
          }
        }}
      >
        <div className="composer-main">
          <input
            className="cell owed-num tnum"
            aria-label="Invoice number"
            title="Invoice number"
            autoComplete="off"
            maxLength={24}
            value={draft.num ?? nextInvoiceNum(money.invoices)}
            onChange={(e) => setDraft({ ...draft, num: e.target.value })}
          />
          <input className="composer-note" aria-label="Event" placeholder="What’s it for? The gig, like a wedding or a jazz night" maxLength={120} value={draft.event} onChange={(e) => setDraft({ ...draft, event: e.target.value })} />
          <NumCell value={draft.amount} label="Amount owed" className="composer-amt" onChange={(v) => setDraft({ ...draft, amount: v === null ? null : Math.abs(v) })} />
          <button className="btn btn-primary composer-add" disabled={!canAdd} onClick={add}>
            Add
          </button>
        </div>
        <div className="composer-acct">
          <span className="meta">Paid into</span>
          <div className="acct-chips" role="radiogroup" aria-label="Paid into">
            {money.accounts
              .filter((a) => !a.archived || a.id === draft.account)
              .map((a) => (
                <button key={a.id} type="button" role="radio" aria-checked={draft.account === a.id} className={'acct-chip' + (draft.account === a.id ? ' on' : '')} onClick={() => setDraft({ ...draft, account: a.id })}>
                  {a.name}
                </button>
              ))}
          </div>
        </div>
        <div className="composer-opts">
          <span className="meta">Due</span>
          <input type="date" className="cell composer-field tnum" aria-label="Payment due" value={draft.due} onChange={(e) => setDraft({ ...draft, due: e.target.value })} />
          {DUE_IN.map((n) => (
            <button key={n} type="button" className={'acct-chip' + (due === n ? ' on' : '')} aria-pressed={due === n} onClick={() => setDraft({ ...draft, due: inDays(n) })}>
              In {n} days
            </button>
          ))}
          {draft.due && (
            <span className="meta composer-hint owed-hint">
              <i className="ph-duotone ph-link-simple" aria-hidden="true" />
              Goes into {monthName(draft.due.slice(0, 7))} as planned money in on {shortDate(draft.due)}
            </span>
          )}
        </div>
      </div>

      <section className="panel you-panel" aria-label="Owed to you" data-grid>
        <div className="panel-head">
          <h2 className="panel-title">Owed to you</h2>
          <span className="meta">Each one is also planned money in on its due date, in Month · tick it once you’re paid</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet owed-sheet">
            <colgroup>
              <col style={{ width: 44 }} />
              <col style={{ width: 108 }} />
              <col />
              <col style={{ width: 104 }} />
              <col style={{ width: 136 }} />
              <col style={{ width: 140 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 70 }} />
            </colgroup>
            <thead>
              <tr>
                <th aria-label="Paid" />
                <th>Invoice</th>
                <th>Event</th>
                <th className="r">Amount</th>
                <th>Due</th>
                <th>Days left</th>
                <th>Paid into</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {open.map((row, r) => (
                <tr key={row.inv.id} className={row.daysLeft < 0 ? 'late' : undefined}>
                  <td className="c">
                    <button className="ent-check" title="Tick once you’re paid: its money in Month turns to done" aria-label={`Mark ${row.inv.num || 'invoice'} as paid`} aria-pressed={false} onClick={() => setPaid(row, true)}>
                      <span className={'ent-tick' + (row.daysLeft < 0 ? ' late' : '')} />
                    </button>
                  </td>
                  <td>
                    <TextCell value={row.inv.num} label="Invoice number" r={r} c={0} max={24} className="tnum owed-num-cell" onChange={(v) => patchInv(row.inv.id, { num: v })} />
                  </td>
                  <td>
                    <TextCell value={row.inv.event} label="Event" r={r} c={1} max={120} placeholder="What’s it for?" onChange={(v) => patchInv(row.inv.id, { event: v })} />
                  </td>
                  <td className="amt">
                    <NumCell value={row.inv.amount} label="Amount owed" r={r} c={2} onChange={(v) => patchInv(row.inv.id, { amount: Math.abs(v ?? 0) })} />
                  </td>
                  <td>
                    <DateCell value={row.inv.due} label="Payment due" r={r} c={3} onChange={(v) => patchInv(row.inv.id, { due: v })} />
                  </td>
                  <td className="days">
                    <DaysLeft d={row.daysLeft} />
                  </td>
                  <td>
                    <AccountSelect money={money} value={row.entry.account} label="Paid into" onChange={(account) => patchEntry(row.entry.id, { account })} />
                  </td>
                  <td>
                    <span className="owed-acts">
                      <button className="icon-btn row-x" title={`Open ${monthName(row.inv.due.slice(0, 7))}, where it’s planned money in`} aria-label={`Open ${row.inv.num || 'invoice'} in Month`} onClick={() => onOpenMonth(row.inv.due.slice(0, 7))}>
                        <i className="ph-duotone ph-calendar-blank" />
                      </button>
                      <button className="icon-btn row-x" title="Delete, along with its money in Month" aria-label={`Delete ${row.inv.num || 'invoice'}`} onClick={() => remove(row)}>
                        <i className="ph-duotone ph-x" />
                      </button>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
            {paid.length > 0 && (
              <tbody className="owed-paid">
                <tr className="owed-split">
                  <td colSpan={8}>
                    <button className="owed-toggle" aria-expanded={showPaid} onClick={() => setShowPaid(!showPaid)}>
                      <i className={'ph-bold ' + (showPaid ? 'ph-caret-down' : 'ph-caret-right')} aria-hidden="true" />
                      Paid · {paid.length}
                    </button>
                  </td>
                </tr>
                {showPaid &&
                  paid.map((row) => {
                    const lateBy = dayDiff(parseYmd(row.inv.due), parseYmd(row.paidOn));
                    return (
                      <tr key={row.inv.id}>
                        <td className="c">
                          <button className="ent-check" title="Untick if it hasn’t come in after all" aria-label={`Mark ${row.inv.num || 'invoice'} as not paid`} aria-pressed onClick={() => setPaid(row, false)}>
                            <span className="ent-tick on">
                              <i className="ph-bold ph-check" />
                            </span>
                          </button>
                        </td>
                        <td className="txt tnum">{row.inv.num}</td>
                        <td className="txt">{row.inv.event || '—'}</td>
                        <td className="txt r tnum">{fmtMoney(row.inv.amount)}</td>
                        <td className="txt tnum">{shortDate(row.inv.due)}</td>
                        <td className="txt">
                          Paid {shortDate(row.paidOn)}
                          {lateBy > 0 && <span className="meta"> · {plural(lateBy, 'day')} late</span>}
                        </td>
                        <td className="txt">{names.get(row.entry.account)}</td>
                        <td>
                          <span className="owed-acts">
                            <button className="icon-btn row-x" title="Delete, along with its money in Month" aria-label={`Delete ${row.inv.num || 'invoice'}`} onClick={() => remove(row)}>
                              <i className="ph-duotone ph-x" />
                            </button>
                          </span>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            )}
          </table>
          {!rows.length && <p className="month-empty">Nobody owes you anything yet. Add an invoice above when you send one: it goes into Month as planned money in on its due date.</p>}
          {rows.length > 0 && !open.length && <p className="month-empty">All paid up.</p>}
        </div>
      </section>
    </div>
  );
}

/** How long until an invoice is due: late and due today in the warning colour, this week in the accent. */
function DaysLeft({ d }: { d: number }) {
  if (d === 0) return <span className="days-left late">Due today</span>;
  if (d < 0)
    return (
      <span className="days-left late">
        <b>{-d}</b> {d === -1 ? 'day' : 'days'} late
      </span>
    );
  return (
    <span className={'days-left' + (d <= 7 ? ' soon' : d > 30 ? ' far' : '')}>
      <b>{d}</b> {d === 1 ? 'day' : 'days'} left
    </span>
  );
}
