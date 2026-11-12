import { fmtMoney, monthName } from '../../../../shared/money';
import { cancelSub, EVERY_NAMES, extendSub, markSub, patchSub, perMonth, perYear, type Series, subRows, subTotals, unmarked, unmarkSub } from '../../../../shared/subscriptions';
import type { Money } from '../../../../shared/types';
import { newId } from '../../util';
import { namesOf, type Notify, shortDate } from './shared';

/**
 * Repeating money out marked as subscriptions: what each costs a month and a year, the
 * next charge and the account it comes from, with a flag for ones to reconsider. Below,
 * repeats that look like subscriptions but aren't marked yet, and the other repeats.
 */
export function Subscriptions({ money, today, onChange, onOpenMonth, notify }: { money: Money; today: string; onChange: (m: Money) => void; onOpenMonth: (k: string) => void; notify: Notify }) {
  const rows = subRows(money, today);
  const totals = subTotals(rows);
  const { likely, other } = unmarked(money, today);
  const names = namesOf(money);

  const cancel = (id: string, name: string) => {
    const before = money;
    const next = cancelSub(money, id, today);
    const gone = money.entries.length - next.entries.length;
    onChange(next);
    notify(`Cancelled ${name}${gone ? `: ${gone} planned charge${gone === 1 ? '' : 's'} taken out` : ''}.`, { label: 'Undo', run: () => onChange(before) });
  };

  return (
    <div className="money-body">
      <div className="m-stats">
        <div className="m-stat">
          <span className="meta">Subscriptions</span>
          <span className="serif tnum">{totals.count}</span>
          <span className="meta">marked</span>
        </div>
        <div className="m-stat">
          <span className="meta">A month</span>
          <span className="serif tnum">{fmtMoney(totals.perMonth)}</span>
          <span className="meta">on average, all together</span>
        </div>
        <div className="m-stat hero">
          <span className="meta">A year</span>
          <span className="serif tnum">{fmtMoney(totals.perYear)}</span>
          <span className="meta">at today’s prices</span>
        </div>
        <div className={'m-stat' + (totals.review.count ? ' late' : '')}>
          <span className="meta">To reconsider</span>
          <span className="serif tnum">{fmtMoney(totals.review.perYear)}</span>
          <span className="meta">{totals.review.count ? `a year, ${totals.review.count} marked to review` : 'none marked to review'}</span>
        </div>
      </div>

      <section className="panel you-panel" aria-label="Subscriptions">
        <div className="panel-head">
          <h2 className="panel-title">Subscriptions</h2>
          <span className="meta">Each is a repeating entry in Month · change the amount or day there</span>
        </div>
        <div className="sum-scroll">
          {rows.length > 0 && (
            <table className="sheet subs-sheet">
              <colgroup>
                <col />
                <col style={{ width: 88 }} />
                <col style={{ width: 118 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 140 }} />
                <col style={{ width: 76 }} />
                <col style={{ width: 70 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="r">Amount</th>
                  <th>How often</th>
                  <th className="r">A month</th>
                  <th className="r">A year</th>
                  <th>Next charge</th>
                  <th>Paid from</th>
                  <th>Since</th>
                  <th>Review</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.sub.id} className={r.sub.review ? 'review' : undefined}>
                    <td className="txt sub-name">{r.name}</td>
                    <td className="txt r tnum">{fmtMoney(r.amount)}</td>
                    <td className="txt">{EVERY_NAMES[r.sub.every]}</td>
                    <td className="txt r tnum">{fmtMoney(r.perMonth)}</td>
                    <td className="txt r tnum">{fmtMoney(r.perYear)}</td>
                    <td className="txt">
                      {r.next ? (
                        <button className="month-link tnum" title={`Open ${monthName(r.next.slice(0, 7))}`} onClick={() => onOpenMonth(r.next.slice(0, 7))}>
                          {shortDate(r.next)}
                        </button>
                      ) : (
                        <span className="sub-out">
                          <span className="meta">None planned after {shortDate(r.last)}</span>
                          <button className="btn-link meta" title="Plan the next 12 months of charges, like the last one" onClick={() => onChange(extendSub(money, r.sub.id, 12, () => newId('e')))}>
                            Plan 12 more months
                          </button>
                        </span>
                      )}
                    </td>
                    <td className="txt">{names.get(r.account)}</td>
                    <td>
                      <input
                        className="cell tnum"
                        type="month"
                        aria-label={`${r.name} since`}
                        title="When it started; leave it for the first charge here"
                        value={r.since}
                        onChange={(e) => onChange(patchSub(money, r.sub.id, { since: e.target.value }))}
                      />
                    </td>
                    <td className="c">
                      <button
                        className={'chip sub-flag' + (r.sub.review ? ' chip-warn' : ' chip-muted')}
                        aria-pressed={r.sub.review}
                        title={r.sub.review ? 'Marked to reconsider: click to keep it' : 'Mark to reconsider'}
                        onClick={() => onChange(patchSub(money, r.sub.id, { review: !r.sub.review }))}
                      >
                        {r.sub.review ? 'Review' : 'Keep'}
                      </button>
                    </td>
                    <td>
                      <span className="owed-acts">
                        <button className="icon-btn row-x" title="Cancelled: take out the planned charges after today" aria-label={`Cancel ${r.name}`} onClick={() => cancel(r.sub.id, r.name)}>
                          <i className="ph-duotone ph-prohibit" />
                        </button>
                        <button className="icon-btn row-x" title="Not a subscription: its entries stay as they are" aria-label={`Unmark ${r.name}`} onClick={() => onChange(unmarkSub(money, r.sub.id))}>
                          <i className="ph-duotone ph-x" />
                        </button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!rows.length && (
            <p className="month-empty">
              No subscriptions yet. Add the charge in Month as money out that repeats every week, 2 weeks or month and tick “Subscription”, or mark a repeat below.
            </p>
          )}
        </div>
      </section>

      {likely.length > 0 && <Unmarked title="These look like subscriptions" note="Repeating money out with a name like one" list={likely} money={money} onChange={onChange} tone="accent" />}
      {other.length > 0 && <Unmarked title="Other repeating money out" note="Mark any that’s a subscription" list={other} money={money} onChange={onChange} />}
    </div>
  );
}

function Unmarked({ title, note, list, money, onChange, tone }: { title: string; note: string; list: Series[]; money: Money; onChange: (m: Money) => void; tone?: 'accent' }) {
  const names = namesOf(money);
  return (
    <section className={'panel you-panel sub-suggest' + (tone ? ' ' + tone : '')} aria-label={title}>
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
        <span className="meta">{note}</span>
      </div>
      <div className="sub-list">
        {list.map((s) => {
          const last = s.entries[s.entries.length - 1];
          return (
            <div key={s.id} className="sub-item">
              <span className="sub-what">
                <b>{last.note}</b>
                <span className="meta">
                  {fmtMoney(last.amount)} · {EVERY_NAMES[s.every!].toLowerCase()} · {names.get(last.account)} · {s.entries.length} charges, {shortDate(s.entries[0].date)} to {shortDate(last.date)}
                </span>
              </span>
              <span className="meta tnum">{fmtMoney(perYear(last.amount, s.every!))} a year ({fmtMoney(perMonth(last.amount, s.every!))} a month)</span>
              <button className="btn btn-secondary btn-small" onClick={() => onChange(markSub(money, s, newId('s')))}>
                Mark as subscription
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
