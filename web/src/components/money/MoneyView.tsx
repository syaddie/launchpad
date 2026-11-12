import { useRef, useState } from 'react';
import { ymd } from '../../../../shared/dates';
import { fmtMoney, invoiceRows, moneyFromWorkbook, monthName, sortEntries, syncInvoices } from '../../../../shared/money';
import type { Money, MoneyEntry } from '../../../../shared/types';
import { readXlsx } from '../../../../shared/xlsx';
import { localGet, localSet } from '../../api';
import { newId } from '../../util';
import { MonthTab } from './MonthTab';
import { Overview } from './Overview';
import { Owed } from './Owed';
import { Wishlist } from './Wishlist';
import { lastAccount, type Notify } from './shared';

type Tab = 'overview' | 'month' | 'wishlist' | 'owed';
const TABS: { key: Tab; name: string }[] = [
  { key: 'overview', name: 'Overview' },
  { key: 'month', name: 'Month' },
  { key: 'wishlist', name: 'Wishlist' },
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
}

/**
 * The Money view. Entries are planned (the forecast) or done (it happened): plan the
 * month ahead, then tick, change or delete entries as the days go by. Balances, the
 * monthly summary and the charts are worked out from the entries (shared/money.ts).
 * Invoices in Owed each have their money as an entry, kept in step on every change.
 */
export function MoneyView({ money, now, saved, onChange: save, onImport, notify, together }: Props) {
  const today = ymd(now);
  const onChange = (m: Money) => save(syncInvoices(m));
  const lateInvoices = invoiceRows(money, today).filter((r) => !r.paidOn && r.daysLeft < 0).length;
  const [tab, setTabState] = useState<Tab>(() => (TABS.some((t) => t.key === localGet('moneyTab')) ? (localGet('moneyTab') as Tab) : 'month'));
  const [month, setMonth] = useState(today.slice(0, 7));
  const [importing, setImporting] = useState(false);
  const [importMonth, setImportMonth] = useState(today.slice(0, 7));
  const [importError, setImportError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  // For toast actions that run after more edits.
  const latest = useRef(money);
  latest.current = money;

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
      // The workbook has no invoices: keep the ones here, with their money.
      const m = { ...read, invoices: money.invoices, entries: sortEntries([...read.entries, ...money.entries.filter((e) => e.invoice)]) };
      onImport(m, `Imported ${read.entries.length} entries from ${monthName(importMonth)} on (${planned} still planned) and ${m.wishlist.length} wishlist item${m.wishlist.length === 1 ? '' : 's'}`);
      setImporting(false);
      setMonth(importMonth);
    } catch (e) {
      setImportError(`Couldn’t read ${f.name}: ${(e as Error).message}`);
    }
  };

  return (
    <main className="money" aria-label="Money">
      <div className="money-head">
        <div className="tabs money-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={'tab' + (tab === t.key ? ' active' : '')} onClick={() => setTab(t.key)}>
              {t.name}
              {t.key === 'owed' && lateInvoices > 0 && <span className="chip chip-warn tab-chip">{lateInvoices} late</span>}
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
            <button className="btn btn-ghost btn-small" title="Read the Tracker and Wishlist sheets of the Money tracker workbook, replacing what’s here" onClick={() => setImporting(true)}>
              <i className="ph-duotone ph-upload-simple" />
              Import .xlsx
            </button>
          )}
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
      {tab === 'overview' && <Overview money={money} today={today} onOpenMonth={openMonth} onChange={onChange} />}
      {tab === 'month' && <MonthTab money={money} today={today} month={month} onMonth={setMonth} onChange={onChange} onOpenOwed={() => setTab('owed')} together={together} />}
      {tab === 'owed' && <Owed money={money} today={today} onChange={onChange} onOpenMonth={openMonth} notify={notify} />}
      {tab === 'wishlist' && (
        <Wishlist
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
