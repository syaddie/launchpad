import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { addDays, dayDiff, parseYmd, ymd } from '../../../../shared/dates';
import { MAX_ITEMS, MAX_LINES, MAX_PAY, docFor, docTotal, emptyClient, fmtInvMoney, invoiceFileName, lineAmount, rememberClient, starterSetup } from '../../../../shared/invoice';
import { fmtMoney, invoiceEntry, mainAccount, MAX_ENTRIES, MAX_INVOICES, monthName, parseMoney, sortEntries, suggestInvoiceNum } from '../../../../shared/money';
import type { Invoice, InvoiceClient, InvoiceDoc, InvoiceFrom, InvoiceItem, InvoiceLine, InvoicePay, InvoiceSetup, Money } from '../../../../shared/types';
import { localGet, localSet } from '../../api';
import { newId } from '../../util';
import { menuProps, type MenuItem } from '../ContextMenu';
import { Drawer } from '../Drawers';
import { InvoicePage, printInvoice } from './InvoicePage';
import { type Notify, shortDate } from './shared';

interface DraftLine {
  key: string;
  desc: string;
  note: string;
  /** Null while the cell is empty: counts as 1. */
  qty: number | null;
  /** Null while the cell is empty: counts as $0. */
  rate: number | null;
}

interface Draft {
  num: string;
  issued: string;
  due: string;
  event: string;
  eventDate: string;
  venue: string;
  client: InvoiceClient;
  lines: DraftLine[];
  from: InvoiceFrom;
  pay: InvoicePay[];
  terms: string;
  thanks: string;
  /** A new invoice only: add it to Owed too, with its money in this account. */
  owed: boolean;
  account: string;
}

const DRAFT_KEY = 'invoiceDraft';
const DUE_IN = [7, 14, 30];

const blankLine = (p: Partial<DraftLine> = {}): DraftLine => ({ key: newId('l'), desc: '', note: '', qty: 1, rate: null, ...p });
const toLine = (l: DraftLine): InvoiceLine => ({ desc: l.desc.trim(), note: l.note.trim(), qty: l.qty ?? 1, rate: l.rate ?? 0 });
/** Rows with nothing in them aren't printed. */
const filled = (lines: DraftLine[]) => lines.filter((l) => l.desc.trim() || l.rate).map(toLine);
const plusDays = (d: string, n: number) => ymd(addDays(parseYmd(d), n));
const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

function liveAccount(money: Money, id: string | null): string {
  return money.accounts.some((a) => a.id === id && !a.archived) ? id! : mainAccount(money.accounts);
}

function freshDraft(money: Money, setup: InvoiceSetup, today: string): Draft {
  return {
    num: suggestInvoiceNum(money),
    issued: today,
    due: plusDays(today, setup.dueDays),
    event: '',
    eventDate: '',
    venue: '',
    client: emptyClient(),
    lines: [blankLine()],
    from: { ...setup.from },
    pay: setup.pay.map((p) => ({ ...p })),
    terms: setup.terms,
    thanks: setup.thanks,
    owed: true,
    account: liveAccount(money, localGet('moneyInvoiceAccount')),
  };
}

/** A new invoice left unfinished, kept in this browser; anything odd in it falls back to the fresh one. */
function savedDraft(fresh: Draft, money: Money): Draft | null {
  try {
    const raw = localGet(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Partial<Draft>) : null;
    if (!d || typeof d !== 'object' || !Array.isArray(d.lines)) return null;
    const lines = d.lines
      .filter((l): l is DraftLine => !!l && typeof l.desc === 'string' && typeof l.note === 'string')
      .slice(0, MAX_LINES)
      .map((l) => blankLine({ desc: l.desc, note: l.note, qty: typeof l.qty === 'number' ? l.qty : null, rate: typeof l.rate === 'number' ? l.rate : null }));
    const text = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
    const date = (v: unknown, fallback: string) => (typeof v === 'string' && (v === '' || isYmd(v)) ? v : fallback);
    return {
      ...fresh,
      num: text(d.num, fresh.num),
      issued: date(d.issued, fresh.issued) || fresh.issued,
      due: date(d.due, fresh.due) || fresh.due,
      event: text(d.event, ''),
      eventDate: date(d.eventDate, ''),
      venue: text(d.venue, ''),
      client: { ...fresh.client, ...(d.client && typeof d.client === 'object' ? d.client : {}) },
      lines: lines.length ? lines : fresh.lines,
      from: { ...fresh.from, ...(d.from && typeof d.from === 'object' ? d.from : {}) },
      pay: Array.isArray(d.pay) ? d.pay.slice(0, MAX_PAY).map((p) => ({ label: text(p?.label, ''), value: text(p?.value, ''), note: text(p?.note, '') })) : fresh.pay,
      terms: text(d.terms, fresh.terms),
      thanks: text(d.thanks, fresh.thanks),
      owed: d.owed !== false,
      account: liveAccount(money, typeof d.account === 'string' ? d.account : null),
    };
  } catch {
    return null;
  }
}

function draftFor(inv: Invoice, setup: InvoiceSetup, today: string): Draft {
  const doc = inv.doc ?? docFor(inv, setup, today);
  return {
    num: inv.num,
    issued: doc.issued,
    due: inv.due,
    event: inv.event,
    eventDate: doc.eventDate,
    venue: doc.venue,
    client: { ...doc.client },
    lines: doc.lines.map((l) => blankLine({ ...l })),
    from: { ...doc.from },
    pay: doc.pay.map((p) => ({ ...p })),
    terms: doc.terms,
    thanks: doc.thanks,
    owed: true,
    account: '',
  };
}

/** An amount that can go negative (a discount): shows "−$100.00", edits as "-100". */
function RateInput({ value, label, onChange, className = '' }: { value: number | null; label: string; onChange: (v: number | null) => void; className?: string }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseMoney(text) === undefined;
  return (
    <input
      className={'input tnum inv-num-in ' + className + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      placeholder="Rate"
      aria-label={label}
      aria-invalid={bad || undefined}
      title={bad ? 'Type an amount, like 250 or -100 for a discount' : undefined}
      value={text ?? (value === null ? '' : fmtInvMoney(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** A count: whole or part ("1.5" hours). Empty counts as 1. */
function QtyInput({ value, label, onChange }: { value: number | null; label: string; onChange: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const parse = (t: string) => {
    const s = t.trim();
    if (!s) return null;
    const n = Number(s);
    return /^\d*\.?\d+$|^\d+\.$/.test(s) && Number.isFinite(n) && n < 1e6 ? n : undefined;
  };
  const bad = text !== null && parse(text) === undefined;
  return (
    <input
      className={'input tnum inv-num-in inv-qty' + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      placeholder="1"
      aria-label={label}
      aria-invalid={bad || undefined}
      value={text ?? (value === null ? '' : String(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parse(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** The printed page shrunk to the drawer's width (CSS zoom keeps its height in step). */
function Preview({ draft }: { draft: Draft }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / 794));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const doc = docOf(draft);
  return (
    <div className="inv-preview" ref={box}>
      <div style={{ zoom: scale }}>
        <InvoicePage num={draft.num.trim()} event={draft.event.trim()} due={draft.due} doc={doc} />
      </div>
    </div>
  );
}

function docOf(d: Draft): InvoiceDoc {
  const trimAll = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v])) as T;
  return {
    issued: d.issued,
    client: trimAll(d.client),
    eventDate: d.eventDate,
    venue: d.venue.trim(),
    lines: filled(d.lines),
    from: trimAll(d.from),
    pay: d.pay.map(trimAll).filter((p) => p.label || p.value),
    terms: d.terms.trim(),
    thanks: d.thanks.trim(),
  };
}

/**
 * Making an invoice, from Owed: who it's for, the gig, its rows (any number, a negative rate for a
 * discount, a tap to add the ones you use often), then a PDF in the "Minimal" design. A new one can
 * go into Owed at the same time, as the quick add above the table would add it. Opened on an
 * invoice already in Owed, it changes that one. Your details are typed in once: each invoice made
 * keeps them for the next. An unfinished new invoice waits in this browser for next time.
 */
export function InvoiceDrawer({ money, today, editing, onChange, onClose, onOpenMonth, notify }: {
  money: Money;
  today: string;
  /** An invoice in Owed to change, rather than a new one. */
  editing?: Invoice;
  onChange: (m: Money) => void;
  onClose: () => void;
  onOpenMonth: (k: string) => void;
  notify: Notify;
}) {
  const setup = money.invoiceSetup ?? starterSetup();
  const [start] = useState(() => {
    if (editing) return { draft: draftFor(editing, setup, today), restored: false };
    const fresh = freshDraft(money, setup, today);
    const saved = savedDraft(fresh, money);
    return { draft: saved ?? fresh, restored: !!saved };
  });
  const [restored, setRestored] = useState(start.restored);
  const [draft, setDraftState] = useState<Draft>(start.draft);
  const [tab, setTab] = useState<'details' | 'preview'>('details');
  const [focusRate, setFocusRate] = useState<string | null>(null);
  const [youOpen, setYouOpen] = useState(() => !(editing?.doc?.from.name ?? setup.from.name).trim());
  const dirty = useRef(false);

  const setDraft = (d: Draft) => {
    dirty.current = true;
    setDraftState(d);
  };
  const patch = (p: Partial<Draft>) => setDraft({ ...draft, ...p });

  // Only a new invoice someone has typed into is kept for later.
  useEffect(() => {
    if (!editing && dirty.current) localSet(DRAFT_KEY, JSON.stringify(draft));
  }, [draft, editing]);

  // A row added for its rate puts the cursor there.
  useEffect(() => {
    if (!focusRate) return;
    document.querySelector<HTMLInputElement>(`[data-line="${focusRate}"] .inv-rate`)?.focus();
    setFocusRate(null);
  }, [focusRate]);

  const saveSetup = (s: Partial<InvoiceSetup>) => onChange({ ...money, invoiceSetup: { ...setup, ...s } });

  // ---------- rows ----------
  const setLine = (key: string, p: Partial<DraftLine>) => patch({ lines: draft.lines.map((l) => (l.key === key ? { ...l, ...p } : l)) });
  const full = draft.lines.length >= MAX_LINES;
  const addLine = (p: Partial<DraftLine> = {}) => {
    if (full) return;
    const line = blankLine(p);
    patch({ lines: [...draft.lines, line] });
    if (line.rate === null) setFocusRate(line.key);
  };
  const removeLine = (key: string) => patch({ lines: draft.lines.filter((l) => l.key !== key) });
  const moveLine = (key: string, by: number) => {
    const i = draft.lines.findIndex((l) => l.key === key);
    const j = i + by;
    if (i < 0 || j < 0 || j >= draft.lines.length) return;
    const lines = [...draft.lines];
    [lines[i], lines[j]] = [lines[j], lines[i]];
    patch({ lines });
  };
  const sameItem = (l: DraftLine) => setup.items.find((it) => it.desc.trim().toLowerCase() === l.desc.trim().toLowerCase());
  const saveItem = (l: DraftLine) => {
    const old = sameItem(l);
    const item: InvoiceItem = { id: old?.id ?? newId('q'), desc: l.desc.trim(), note: l.note.trim(), rate: l.rate };
    saveSetup({ items: old ? setup.items.map((it) => (it.id === old.id ? item : it)) : [...setup.items, item] });
    notify(old ? `Updated “${item.desc}” in quick add.` : `“${item.desc}” is in quick add now: one tap adds it to an invoice.`);
  };
  const lineMenu = (l: DraftLine, i: number): MenuItem[] => [
    { label: 'Duplicate row', icon: 'ph-copy', disabled: full, onSelect: () => patch({ lines: [...draft.lines.slice(0, i + 1), { ...l, key: newId('l') }, ...draft.lines.slice(i + 1)] }) },
    { label: 'Move up', icon: 'ph-arrow-up', disabled: i === 0, onSelect: () => moveLine(l.key, -1) },
    { label: 'Move down', icon: 'ph-arrow-down', disabled: i === draft.lines.length - 1, onSelect: () => moveLine(l.key, 1) },
    'sep',
    { label: sameItem(l) ? 'Update its quick-add item' : 'Save as a quick-add item', icon: 'ph-lightning', disabled: !l.desc.trim() || (!sameItem(l) && setup.items.length >= MAX_ITEMS), onSelect: () => saveItem(l) },
    'sep',
    { label: 'Remove row', icon: 'ph-trash', danger: true, onSelect: () => removeLine(l.key) },
  ];
  const itemMenu = (it: InvoiceItem): MenuItem[] => [
    { label: 'Add to this invoice', icon: 'ph-plus', disabled: full, onSelect: () => addLine({ desc: it.desc, note: it.note, rate: it.rate }) },
    'sep',
    { label: 'Remove from quick add', icon: 'ph-trash', danger: true, confirm: `Remove “${it.desc}” from quick add?`, onSelect: () => saveSetup({ items: setup.items.filter((x) => x.id !== it.id) }) },
  ];

  // ---------- who it's for ----------
  const setClient = (p: Partial<InvoiceClient>) => patch({ client: { ...draft.client, ...p } });
  const isClient = (c: InvoiceClient) => !!draft.client.company.trim() && c.company.trim().toLowerCase() === draft.client.company.trim().toLowerCase();
  const clientMenu = (c: InvoiceClient): MenuItem[] => [
    { label: 'Use their details', icon: 'ph-user', onSelect: () => patch({ client: { ...c } }) },
    'sep',
    { label: `Forget ${c.company}`, icon: 'ph-trash', danger: true, confirm: `Forget ${c.company}’s details? Invoices already made keep them.`, onSelect: () => saveSetup({ clients: setup.clients.filter((x) => x !== c) }) },
  ];

  // ---------- your details ----------
  const setFrom = (p: Partial<InvoiceFrom>) => patch({ from: { ...draft.from, ...p } });
  const setPay = (i: number, p: Partial<InvoicePay>) => patch({ pay: draft.pay.map((x, j) => (j === i ? { ...x, ...p } : x)) });

  // ---------- making it ----------
  const lines = filled(draft.lines);
  const total = docTotal(lines);
  const num = draft.num.trim();
  const roomInOwed = money.invoices.length < MAX_INVOICES && money.entries.length < MAX_ENTRIES;
  const owedWhy = total <= 0 ? 'Only an invoice that adds up to more than $0 can go into Owed.' : !roomInOwed ? 'Owed is full: delete some old invoices first.' : '';
  const intoOwed = !editing && draft.owed && !owedWhy;
  const problem = !num
    ? 'Give it a number.'
    : !draft.issued
      ? 'Give it a date.'
      : !draft.due
        ? 'Give it a due date.'
        : !lines.length
          ? 'Add a row: what you’re charging for.'
          : editing && total <= 0
            ? 'It’s in Owed, so its rows need to add up to more than $0.'
            : '';
  const dueIn = draft.issued && draft.due ? dayDiff(parseYmd(draft.issued), parseYmd(draft.due)) : null;

  const make = (pdf: boolean) => {
    if (problem) return;
    const doc = docOf(draft);
    const event = draft.event.trim();
    const nextSetup: InvoiceSetup = {
      ...setup,
      from: doc.from,
      pay: doc.pay,
      terms: doc.terms,
      thanks: doc.thanks,
      // A new invoice's due date sets the next one's; an old one opened again leaves it be.
      dueDays: !editing && dueIn !== null && dueIn >= 0 && dueIn <= 365 ? dueIn : setup.dueDays,
      clients: rememberClient(setup.clients, doc.client),
      lastNum: editing ? setup.lastNum : num,
    };
    if (editing) {
      onChange({ ...money, invoiceSetup: nextSetup, invoices: money.invoices.map((i) => (i.id === editing.id ? { ...i, num, event, due: draft.due, amount: total, doc } : i)) });
      notify(`Saved ${num}${total !== editing.amount ? `: it’s ${fmtMoney(total)} now, in Owed and in Month` : ''}.`);
    } else if (intoOwed) {
      const inv: Invoice = { id: newId('i'), num, event, amount: total, due: draft.due, doc };
      onChange({ ...money, invoiceSetup: nextSetup, invoices: [...money.invoices, inv], entries: sortEntries([...money.entries, invoiceEntry(inv, draft.account, newId('e'))]) });
      localSet('moneyInvoiceAccount', draft.account);
      notify(`Added ${num} to Owed: ${fmtMoney(total, true)} is planned money in on ${shortDate(draft.due)}.`, { label: 'Open in Month', run: () => onOpenMonth(draft.due.slice(0, 7)) });
    } else {
      onChange({ ...money, invoiceSetup: nextSetup });
      notify(`Made ${num}. It isn’t in Owed.`);
    }
    if (!editing) localSet(DRAFT_KEY, '');
    onClose();
    if (pdf) printInvoice({ num, event, due: draft.due, doc });
  };

  const startOver = () => {
    localSet(DRAFT_KEY, '');
    dirty.current = false;
    setDraftState(freshDraft(money, setup, today));
    setRestored(false);
  };

  const accounts = money.accounts.filter((a) => !a.archived || a.id === draft.account);
  const title = editing ? `Invoice ${editing.num || ''}`.trim() : 'New invoice';

  return (
    <Drawer
      title={title}
      onClose={onClose}
      wide
      foot={
        <>
          <span className="inv-foot-total">
            <span className="meta">Total</span> <b className="tnum">{fmtInvMoney(total)}</b>
          </span>
          {problem && <span className="meta inv-foot-why">{problem}</span>}
          <span className="inv-foot-btns">
            {editing && (
              <button className="btn btn-secondary" disabled={!!problem} onClick={() => make(false)}>
                Save
              </button>
            )}
            <button className="btn btn-primary" disabled={!!problem} onClick={() => make(true)}>
              <i className="ph-duotone ph-file-arrow-down" aria-hidden="true" />
              {editing ? 'Save and make PDF' : intoOwed ? 'Add to Owed and make PDF' : 'Make PDF'}
            </button>
          </span>
        </>
      }
    >
      <div className="inv-form">
        <div className="inv-form-top">
          <div className="segmented" role="tablist" aria-label="Show">
            <button role="tab" aria-selected={tab === 'details'} className={tab === 'details' ? 'on' : ''} onClick={() => setTab('details')}>
              Details
            </button>
            <button role="tab" aria-selected={tab === 'preview'} className={tab === 'preview' ? 'on' : ''} onClick={() => setTab('preview')}>
              Preview
            </button>
          </div>
          {restored && (
            <span className="meta inv-restored">
              Picking up where you left off ·{' '}
              <button className="btn-link" onClick={startOver}>
                Start over
              </button>
            </span>
          )}
        </div>

        {tab === 'preview' ? (
          <>
            <Preview draft={draft} />
            <p className="meta inv-print-tip">
              Make PDF opens the print dialog: pick “Save as PDF”. It’s named like your old ones: <span className="tnum">{invoiceFileName(num, draft.event, draft.issued)}.pdf</span>
            </p>
          </>
        ) : (
          <>
            <section className="drawer-section">
              <h3 className="drawer-label">Invoice</h3>
              <div className="inv-fields">
                <label className="field">
                  Number
                  <input className="input tnum" autoComplete="off" maxLength={24} value={draft.num} onChange={(e) => patch({ num: e.target.value })} />
                </label>
                <label className="field">
                  Date
                  <input type="date" className="input tnum" value={draft.issued} onChange={(e) => patch({ issued: e.target.value })} />
                </label>
                <label className="field">
                  Due
                  <input type="date" className="input tnum" value={draft.due} onChange={(e) => patch({ due: e.target.value })} />
                </label>
              </div>
              <div className="acct-chips">
                {DUE_IN.map((n) => (
                  <button key={n} type="button" className={'acct-chip' + (dueIn === n ? ' on' : '')} aria-pressed={dueIn === n} disabled={!draft.issued} onClick={() => patch({ due: plusDays(draft.issued, n) })}>
                    In {n} days
                  </button>
                ))}
              </div>
            </section>

            <section className="drawer-section">
              <h3 className="drawer-label">Bill to</h3>
              {setup.clients.length > 0 && (
                <div className="acct-chips" aria-label="Saved clients">
                  {setup.clients.map((c) => (
                    <button key={c.company} type="button" className={'acct-chip' + (isClient(c) ? ' on' : '')} aria-pressed={isClient(c)} onClick={() => patch({ client: { ...c } })} {...menuProps(() => clientMenu(c), c.company)}>
                      {c.company}
                    </button>
                  ))}
                  <button type="button" className="acct-chip" onClick={() => patch({ client: emptyClient() })}>
                    <i className="ph-duotone ph-plus" aria-hidden="true" /> New client
                  </button>
                </div>
              )}
              <div className="inv-fields">
                <label className="field wide">
                  Company or name
                  <input className="input" autoComplete="off" maxLength={120} value={draft.client.company} onChange={(e) => setClient({ company: e.target.value })} />
                </label>
                <label className="field">
                  Attention (optional)
                  <input className="input" autoComplete="off" maxLength={80} placeholder="Who it’s for" value={draft.client.attn} onChange={(e) => setClient({ attn: e.target.value })} />
                </label>
              </div>
              <div className="inv-fields">
                <label className="field wide">
                  Address
                  <textarea className="input" rows={2} maxLength={240} value={draft.client.address} onChange={(e) => setClient({ address: e.target.value })} />
                </label>
                <label className="field">
                  Phone (optional)
                  <input className="input tnum" autoComplete="off" inputMode="tel" maxLength={40} value={draft.client.phone} onChange={(e) => setClient({ phone: e.target.value })} />
                </label>
              </div>
            </section>

            <section className="drawer-section">
              <h3 className="drawer-label">Event</h3>
              <div className="inv-fields">
                <label className="field wide">
                  Name
                  <input className="input" autoComplete="off" maxLength={120} placeholder="The gig, like NP RED Camp 2026" value={draft.event} onChange={(e) => patch({ event: e.target.value })} />
                </label>
                <label className="field">
                  Date (optional)
                  <input type="date" className="input tnum" value={draft.eventDate} onChange={(e) => patch({ eventDate: e.target.value })} />
                </label>
                <label className="field wide">
                  Venue (optional)
                  <input className="input" autoComplete="off" maxLength={120} value={draft.venue} onChange={(e) => patch({ venue: e.target.value })} />
                </label>
              </div>
            </section>

            <section className="drawer-section">
              <div className="inv-sec-head">
                <h3 className="drawer-label">What you’re charging</h3>
                <span className="meta">A negative rate is a discount</span>
              </div>
              <div className="inv-rows">
                <div className="inv-row inv-row-head meta" aria-hidden="true">
                  <span className="inv-c-desc">Description</span>
                  <span className="inv-c-qty">Qty</span>
                  <span className="inv-c-rate">Rate</span>
                  <span className="inv-c-amt">Amount</span>
                </div>
                {draft.lines.map((l, i) => {
                  const amt = lineAmount(toLine(l));
                  const name = l.desc.trim() || `row ${i + 1}`;
                  return (
                    <div key={l.key} className="inv-row" data-line={l.key} {...menuProps(() => lineMenu(l, i), `Actions for ${name}`)}>
                      <div className="inv-c-desc">
                        <input className="input" autoComplete="off" maxLength={160} aria-label={`Row ${i + 1} description`} placeholder="A set, a fee, a discount" value={l.desc} onChange={(e) => setLine(l.key, { desc: e.target.value })} />
                        <input className="input sm inv-note" autoComplete="off" maxLength={160} aria-label={`Row ${i + 1} note`} placeholder="Note, optional: guitar & vocals, 2 × 45 min" value={l.note} onChange={(e) => setLine(l.key, { note: e.target.value })} />
                      </div>
                      <div className="inv-c-qty">
                        <QtyInput value={l.qty} label={`Row ${i + 1} quantity`} onChange={(v) => setLine(l.key, { qty: v })} />
                      </div>
                      <div className="inv-c-rate">
                        <RateInput value={l.rate} label={`Row ${i + 1} rate`} className="inv-rate" onChange={(v) => setLine(l.key, { rate: v })} />
                      </div>
                      <div className={'inv-c-amt tnum' + (amt < 0 ? ' inv-off-app' : '')} aria-label={`Row ${i + 1} amount`}>
                        {fmtInvMoney(amt)}
                      </div>
                      <button type="button" className="icon-btn md inv-c-x" title="Remove row" aria-label={`Remove ${name}`} onClick={() => removeLine(l.key)}>
                        <i className="ph-duotone ph-x" />
                      </button>
                    </div>
                  );
                })}
                {!draft.lines.length && <p className="meta inv-empty">No rows yet. Add what you’re charging for: the set, any fees, a discount.</p>}
              </div>
              <div className="acct-chips inv-quick">
                <button type="button" className="btn btn-secondary btn-small" disabled={full} onClick={() => addLine()}>
                  <i className="ph-duotone ph-plus" aria-hidden="true" /> Add row
                </button>
                {setup.items.map((it) => (
                  <button key={it.id} type="button" className="acct-chip" disabled={full} title={it.note || undefined} onClick={() => addLine({ desc: it.desc, note: it.note, rate: it.rate })} {...menuProps(() => itemMenu(it), it.desc)}>
                    + {it.desc}
                    {it.rate !== null && <span className="tnum inv-chip-rate"> {fmtInvMoney(it.rate)}</span>}
                  </button>
                ))}
              </div>
              <p className="meta inv-hint">{full ? `That’s the most rows an invoice can have (${MAX_LINES}).` : 'Quick add is yours: right-click (or long-press) a row to save it there, or one of these to remove it.'}</p>
            </section>

            {!editing && (
              <section className="drawer-section inv-owed">
                <label className="inv-check">
                  <input type="checkbox" checked={intoOwed} disabled={!!owedWhy} onChange={(e) => patch({ owed: e.target.checked })} />
                  <span>
                    <span className="inv-check-title">Also add to Owed</span>
                    <span className="meta">
                      {owedWhy ||
                        (intoOwed
                          ? `${num || 'It'} goes into Owed as ${fmtInvMoney(total)}, and into ${draft.due ? monthName(draft.due.slice(0, 7)) : 'Month'} as planned money in on ${draft.due ? shortDate(draft.due) : 'its due date'}.`
                          : 'Only the PDF is made: nothing goes into Owed or Month.')}
                    </span>
                  </span>
                </label>
                {intoOwed && accounts.length > 1 && (
                  <div className="acct-chips inv-owed-acct" role="radiogroup" aria-label="Paid into">
                    <span className="meta">Paid into</span>
                    {accounts.map((a) => (
                      <button key={a.id} type="button" role="radio" aria-checked={draft.account === a.id} className={'acct-chip' + (draft.account === a.id ? ' on' : '')} onClick={() => patch({ account: a.id })}>
                        {a.name}
                      </button>
                    ))}
                  </div>
                )}
              </section>
            )}

            <details className="inv-you" open={youOpen} onToggle={(e) => setYouOpen(e.currentTarget.open)}>
              <summary className="drawer-label">
                Your details, how to pay and terms
                {!draft.from.name.trim() && <span className="chip chip-warn">Add once</span>}
              </summary>
              <div className="drawer-section inv-you-body">
              <p className="meta">Printed on every invoice. Each one you make remembers them for the next{editing ? '; this invoice keeps what it was sent with unless you change it here' : ''}.</p>
              <div className="inv-fields">
                <label className="field wide">
                  Your name
                  <input className="input" autoComplete="name" maxLength={80} value={draft.from.name} onChange={(e) => setFrom({ name: e.target.value })} />
                </label>
                <label className="field">
                  Phone
                  <input className="input tnum" autoComplete="tel" inputMode="tel" maxLength={40} value={draft.from.phone} onChange={(e) => setFrom({ phone: e.target.value })} />
                </label>
              </div>
              <div className="inv-fields">
                <label className="field wide">
                  Address
                  <textarea className="input" rows={2} maxLength={240} value={draft.from.address} onChange={(e) => setFrom({ address: e.target.value })} />
                </label>
                <label className="field">
                  Email
                  <input className="input" type="email" autoComplete="email" maxLength={120} value={draft.from.email} onChange={(e) => setFrom({ email: e.target.value })} />
                </label>
              </div>

              <div className="inv-sec-head">
                <span className="field">Ways to pay you, one box each</span>
                {draft.pay.length < MAX_PAY && (
                  <button type="button" className="btn btn-ghost btn-small" onClick={() => patch({ pay: [...draft.pay, { label: '', value: '', note: '' }] })}>
                    <i className="ph-duotone ph-plus" aria-hidden="true" /> Add
                  </button>
                )}
              </div>
              {draft.pay.map((p, i) => (
                <div key={i} className="inv-pay-row" {...menuProps(() => [{ label: 'Remove this way to pay', icon: 'ph-trash', danger: true, onSelect: () => patch({ pay: draft.pay.filter((_, j) => j !== i) }) }], `Way to pay ${i + 1}`)}>
                  <input className="input" autoComplete="off" maxLength={40} aria-label={`Way to pay ${i + 1}: name`} placeholder="PayNow" value={p.label} onChange={(e) => setPay(i, { label: e.target.value })} />
                  <input className="input tnum" autoComplete="off" maxLength={60} aria-label={`Way to pay ${i + 1}: number`} placeholder="Number" value={p.value} onChange={(e) => setPay(i, { value: e.target.value })} />
                  <input className="input" autoComplete="off" maxLength={60} aria-label={`Way to pay ${i + 1}: under it`} placeholder="Under it: NRIC, POSB Savings" value={p.note} onChange={(e) => setPay(i, { note: e.target.value })} />
                  <button type="button" className="icon-btn md" title="Remove" aria-label={`Remove way to pay ${i + 1}`} onClick={() => patch({ pay: draft.pay.filter((_, j) => j !== i) })}>
                    <i className="ph-duotone ph-x" />
                  </button>
                </div>
              ))}
              {!draft.pay.length && <p className="meta">None yet: add PayNow or a bank account, and it’s printed as a box at the bottom.</p>}

              <label className="field">
                Terms
                <textarea className="input" rows={3} maxLength={1000} value={draft.terms} onChange={(e) => patch({ terms: e.target.value })} />
              </label>
              <label className="field">
                Closing line
                <input className="input" autoComplete="off" maxLength={120} value={draft.thanks} onChange={(e) => patch({ thanks: e.target.value })} />
              </label>
              </div>
            </details>
          </>
        )}
      </div>
    </Drawer>
  );
}
