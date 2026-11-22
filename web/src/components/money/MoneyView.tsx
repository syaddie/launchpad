import { useRef, useState } from 'react';
import { ymd } from '../../../../shared/dates';
import { fmtMoney, invoiceRows, moneyFromWorkbook, monthName, sortEntries, syncInvoices } from '../../../../shared/money';
import type { BillSuggestion, Money, MoneyEntry } from '../../../../shared/types';
import { parseStatement, type Applied, type Statement } from '../../../../shared/statement';
import { unmarked } from '../../../../shared/subscriptions';
import { readXlsx } from '../../../../shared/xlsx';
import { localGet, localSet } from '../../api';
import { useActiveTabInView } from '../../hooks/useActiveTabInView';
import { newId } from '../../util';
import { MonthTab } from './MonthTab';
import { Overview } from './Overview';
import { Goals } from './Goals';
import { Owed } from './Owed';
import { Subscriptions } from './Subscriptions';
import { Wishlist } from './Wishlist';
import { lastAccount, type Notify } from './shared';
import { StatementDrawer } from './StatementDrawer';
import { Glide } from '../Motion';

type Tab = 'overview' | 'month' | 'wishlist' | 'subs' | 'owed';
const TABS: { key: Tab; name: string }[] = [
  { key: 'overview', name: 'Overview' },
  { key: 'month', name: 'Month' },
  { key: 'wishlist', name: 'Goals & wishlist' },
  { key: 'subs', name: 'Subscriptions' },
  { key: 'owed', name: 'Owed' },
];

interface Props {
  money: Money;
  now: Date;
  saved: boolean;
  onChange: (m: Money) => void;
  /** A workbook was read; the page swaps it in and offers an undo. */
  onImport: (m: Money, summary: string) => void;
  notify: Notify;
  /** Month shows its calendar and list side by side instead of one at a time. */
  together?: boolean;
  /** Bill and receipt emails waiting in Inbox, matched against a bank statement. */
  bills?: BillSuggestion[];
  /** A statement had the money for one of them: it's taken out of Inbox. */
  onDropBill?: (b: BillSuggestion) => void;
}

/**
 * The Money view. Entries are planned (the forecast) or done (it happened): plan the
 * month ahead, then tick, change or delete entries as the days go by. Balances, the
 * monthly summary and the charts are worked out from the entries (shared/money.ts).
 * Invoices in Owed each have their money as an entry, kept in step on every change.
 */
export function MoneyView({ money: given, now, saved, onChange: save, onImport, notify, together, bills = [], onDropBill }: Props) {
  // A copy kept by the page before subscriptions and goals (or an edit queued then) has neither.
  const money: Money = given.subs && given.goals ? given : { ...given, subs: given.subs ?? [], goals: given.goals ?? [] };
  const today = ymd(now);
  const onChange = (m: Money) => save(syncInvoices(m));
  const lateInvoices = invoiceRows(money, today).filter((r) => !r.paidOn && r.daysLeft < 0).length;
  const likelySubs = unmarked(money, today).likely.length;
  const [tab, setTabState] = useState<Tab>(() => (TABS.some((t) => t.key === localGet('moneyTab')) ? (localGet('moneyTab') as Tab) : 'month'));
  const [month, setMonth] = useState(today.slice(0, 7));
  const [importing, setImporting] = useState(false);
  const [importMonth, setImportMonth] = useState(today.slice(0, 7));
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const csvRef = useRef<HTMLInputElement>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  // For toast actions that run after more edits.
  const latest = useRef(money);
  latest.current = money;

  const tabsRef = useActiveTabInView(tab);
  const setTab = (t: Tab) => {
    setTabState(t);
    localSet('moneyTab', t);
  };
  const openMonth = (key: string) => {
    setMonth(key);
    setTab('month');
  };

  const importFile = async (f: File) => {
    setImportError('');
    try {
      const read = moneyFromWorkbook(await readXlsx(await f.arrayBuffer()), importMonth, today, money.accounts);
      if (!read.entries.length && !read.wishlist.length) throw new Error('no Tracker or Wishlist sheet found');
      const planned = read.entries.filter((e) => e.planned).length;
      // The workbook has no invoices or goals: keep the ones here, with the invoices' money.
      const m = { ...read, invoices: money.invoices, goals: money.goals, ...(money.invoiceSetup ? { invoiceSetup: money.invoiceSetup } : {}), entries: sortEntries([...read.entries, ...money.entries.filter((e) => e.invoice)]) };
      onImport(m, `Imported ${read.entries.length} entries from ${monthName(importMonth)} on (${planned} still planned) and ${m.wishlist.length} wishlist item${m.wishlist.length === 1 ? '' : 's'}`);
      setImporting(false);
      setMonth(importMonth);
    } catch (e) {
      setImportError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };

  const readStatement = async (f: File) => {
    setImportError('');
    try {
      setStatement(parseStatement(await f.text()));
    } catch (e) {
      setImportError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };
  const applyStatement = (a: Applied, summary: string) => {
    onImport(a.money, summary);
    for (const id of a.dropBills) {
      const b = bills.find((x) => x.id === id);
      if (b) onDropBill?.(b);
    }
    setStatement(null);
  };

  return (
    <main className="money" aria-label="Money">
      <div className="money-head">
        <div ref={tabsRef} className="tabs money-tabs" role="tablist">
          <Glide on={tab} />
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              {t.name}
              {t.key === 'owed' && lateInvoices > 0 && <span className="chip chip-warn tab-chip">{lateInvoices} late</span>}
              {t.key === 'subs' && likelySubs > 0 && (
                <span className="chip chip-muted tab-chip" title="Repeating money out that looks like a subscription but isn’t marked">
                  {likelySubs} to check
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="money-actions">
          <span className={'meta saved' + (saved ? ' on' : '')} aria-live="polite">
            {saved ? 'Saved' : ''}
          </span>
          {importError && <span className="meta" style={{ color: 'var(--wn)' }}>{importError}</span>}
          {importing ? (
            <>
              <label className="meta" htmlFor="money-import-month">
                Month 1 of the workbook is
              </label>
              <input id="money-import-month" className="input sm" type="month" value={importMonth} onChange={(e) => e.target.value && setImportMonth(e.target.value)} />
              <button className="btn btn-primary btn-small" onClick={() => fileRef.current?.click()}>
                Choose file…
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => (setImporting(false), setImportError(''))}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-ghost btn-small" title="Add what’s new on a POSB or DBS transaction history (CSV), checked against what’s here first" onClick={() => csvRef.current?.click()}>
                <i className="ph-duotone ph-bank" />
                Bank statement
              </button>
              <button className="btn btn-ghost btn-small" title="Read the Tracker and Wishlist sheets of the Money tracker workbook, replacing what’s here" onClick={() => setImporting(true)}>
                <i className="ph-duotone ph-upload-simple" />
                Import .xlsx
              </button>
            </>
          )}
          <input
            ref={csvRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) readStatement(f);
            }}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) importFile(f);
            }}
          />
        </div>
      </div>
      {statement && <StatementDrawer statement={statement} money={money} bills={bills} notify={notify} onApply={applyStatement} onClose={() => setStatement(null)} />}
      {tab === 'overview' && <Overview money={money} today={today} onOpenMonth={openMonth} onChange={onChange} />}
      {tab === 'month' && <MonthTab money={money} today={today} month={month} onMonth={setMonth} onChange={onChange} onOpenOwed={() => setTab('owed')} together={together} />}
      {tab === 'subs' && <Subscriptions money={money} today={today} onChange={onChange} onOpenMonth={openMonth} notify={notify} />}
      {tab === 'owed' && <Owed money={money} today={today} onChange={onChange} onOpenMonth={openMonth} notify={notify} />}
      {tab === 'wishlist' && (
        <Wishlist
          top={<Goals money={money} today={today} onChange={onChange} />}
          money={money}
          today={today}
          onChange={(wishlist) => onChange({ ...money, wishlist })}
          onPurchased={(w) => {
            if (!w.price) return;
            notify(`Marked ${w.name || 'it'} as purchased.`, {
              label: `Add ${fmtMoney(w.price)} as money out today`,
              run: () => {
                const m = latest.current;
                const entry: MoneyEntry = { id: newId('e'), date: today, kind: 'out', amount: w.price!, note: w.name, category: 'Shopping', planned: false, account: lastAccount(m), to: '' };
                onChange({ ...m, entries: sortEntries([...m.entries, entry]) });
              },
            });
          }}
        />
      )}
    </main>
  );
}
