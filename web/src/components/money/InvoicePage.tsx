import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { dayDiff, parseYmd } from '../../../../shared/dates';
import { CURRENCY, docTotal, fmtInvDate, fmtInvMoney, fmtQty, invoiceFileName, lineAmount } from '../../../../shared/invoice';
import type { InvoiceDoc } from '../../../../shared/types';

/** An invoice as printed: the Invoice's own number, event and due date, and the rest from its document. */
export interface InvoiceView {
  num: string;
  event: string;
  due: string;
  doc: InvoiceDoc;
}

const joinLines = (...parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join('\n');

/**
 * One A4 page in the "Minimal" design: your details and the number at the top, who it's billed to
 * beside the dates and the amount due, the rows, then how to pay. Its colours are its own, not the
 * app's theme, so it prints the same in every design and in dark mode. It grows past A4 rather than
 * cutting rows off.
 */
export function InvoicePage({ num, event, due, doc }: InvoiceView) {
  const total = docTotal(doc.lines);
  const days = doc.issued && due ? dayDiff(parseYmd(doc.issued), parseYmd(due)) : -1;
  const { from, client } = doc;
  const contact = [from.phone, from.email].map((s) => s.trim()).filter(Boolean).join(' · ');
  const when = [fmtInvDate(doc.eventDate), doc.venue.trim()].filter(Boolean).join(' · ');
  return (
    <article className="inv-page" aria-label={`Invoice ${num}`}>
      <header className="inv-top">
        <div className="inv-from">
          {from.name.trim() && <div className="inv-name">{from.name}</div>}
          <div className="inv-muted inv-lines">{joinLines(from.address, contact)}</div>
        </div>
        <div className="inv-num">
          <div className="inv-kicker">Invoice</div>
          <div className="inv-num-big">{num}</div>
        </div>
      </header>

      <div className="inv-rule" />

      <section className="inv-meta">
        <div className="inv-cell">
          <div className="inv-label">Billed to</div>
          {client.company.trim() && <div className="inv-strong">{client.company}</div>}
          {client.attn.trim() && <div>Attn: {client.attn}</div>}
          <div className="inv-muted inv-lines">{joinLines(client.address, client.phone)}</div>
        </div>
        <div className="inv-cell inv-dates">
          <div>
            <div className="inv-label">Issued</div>
            <div className="inv-medium">{fmtInvDate(doc.issued)}</div>
          </div>
          <div>
            <div className="inv-label">Due</div>
            <div className="inv-medium">{fmtInvDate(due)}</div>
          </div>
        </div>
        <div className="inv-cell inv-due">
          <div className="inv-label">Amount due</div>
          <div className="inv-due-amt">{fmtInvMoney(total)}</div>
          <div className="inv-muted">{days > 0 ? `${CURRENCY} · within ${days} day${days === 1 ? '' : 's'}` : CURRENCY}</div>
        </div>
      </section>

      {(event.trim() || when) && (
        <section className="inv-event">
          <div className="inv-label">For</div>
          {event.trim() && <div className="inv-event-name">{event}</div>}
          {when && <div className="inv-muted">{when}</div>}
        </section>
      )}

      <table className="inv-table">
        <colgroup>
          <col />
          <col style={{ width: 56 }} />
          <col style={{ width: 104 }} />
          <col style={{ width: 104 }} />
        </colgroup>
        <thead>
          <tr>
            <th>Description</th>
            <th>Qty</th>
            <th>Rate</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.map((l, i) => {
            const amt = lineAmount(l);
            return (
              <tr key={i}>
                <td>
                  <div className="inv-medium">{l.desc}</div>
                  {l.note.trim() && <div className="inv-muted">{l.note}</div>}
                </td>
                <td>{fmtQty(l.qty)}</td>
                <td>{fmtInvMoney(l.rate)}</td>
                <td className={amt < 0 ? 'inv-off' : undefined}>{fmtInvMoney(amt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="inv-total-row">
        <div className="inv-total">
          <span>Total</span>
          <b>{fmtInvMoney(total)}</b>
        </div>
      </div>

      <div className="inv-grow" />

      {doc.pay.length > 0 && (
        <div className="inv-pay" style={{ gridTemplateColumns: `repeat(${doc.pay.length}, minmax(0, 1fr))` }}>
          {doc.pay.map((p, i) => (
            <div key={i}>
              <div className="inv-label">{p.label}</div>
              <div className="inv-pay-value">{p.value}</div>
              {p.note.trim() && <div className="inv-muted">{p.note}</div>}
            </div>
          ))}
        </div>
      )}
      {doc.terms.trim() && <p className="inv-terms">{doc.terms}</p>}

      <footer className="inv-foot">
        <div className="inv-strong">{doc.thanks}</div>
        <div className="inv-muted">Invoice {num}</div>
      </footer>
    </article>
  );
}

let printing: (() => void) | null = null;

/**
 * Opens the browser's print dialog with just this invoice on an A4 page and no margins (styles.css,
 * `inv-printing`), named the way the old PDFs were, so "Save as PDF" gives the file. The page is
 * drawn outside the app (on screen it's hidden) and taken away once the dialog closes.
 */
export function printInvoice(v: InvoiceView): void {
  printing?.();
  const host = document.createElement('div');
  host.className = 'inv-print';
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(<InvoicePage {...v} />));
  const title = document.title;
  const html = document.documentElement;
  const done = () => {
    if (printing !== done) return;
    printing = null;
    window.removeEventListener('afterprint', done);
    window.clearTimeout(safety);
    html.classList.remove('inv-printing');
    document.title = title;
    root.unmount();
    host.remove();
  };
  printing = done;
  window.addEventListener('afterprint', done);
  // Phones may not say when the dialog closes; the hidden copy goes after a while regardless.
  const safety = window.setTimeout(done, 10 * 60_000);
  document.title = invoiceFileName(v.num, v.event, v.doc.issued);
  html.classList.add('inv-printing');
  const go = () => {
    if (printing === done) window.print();
  };
  // Inter is loaded only when something uses it; wait for it so the PDF isn't set in a fallback.
  const font = '500 16px Inter';
  if (!document.fonts || document.fonts.check(font)) go();
  else void document.fonts.load(font).then(go, go);
}
