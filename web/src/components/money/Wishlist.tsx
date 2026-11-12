import { Fragment, useState } from 'react';
import { affordableFrom, calcMonths, fmtMoney, isDone, MAX_WISHES, monthKeys, monthName, PRIORITIES, STATUSES, wishStats } from '../../../../shared/money';
import type { Money, WishItem } from '../../../../shared/types';
import { newId } from '../../util';
import { AccountSelect, cellKeys, lastAccount, NumCell, shortDate, TextCell } from './shared';
import { WhatIf } from './WhatIf';

const blankWish = (id: string): WishItem => ({ id, name: '', category: '', priority: '', status: '', price: null, target: '', notes: '' });

/** `top` goes above it, in the same scrolling body: the savings goals. */
export function Wishlist({ money, today, onChange, onPurchased, top }: { money: Money; today: string; onChange: (l: WishItem[]) => void; onPurchased: (w: WishItem) => void; top?: React.ReactNode }) {
  const list = money.wishlist;
  // The empty row at the end becomes a real item as soon as something is typed in it.
  // Its id is made up front, so the row keeps its key (and focus) when that happens.
  const [ghostId, setGhostId] = useState(() => newId('w'));
  const stats = wishStats(list);
  const rows = list.length < MAX_WISHES ? [...list, blankWish(ghostId)] : list;
  const months = calcMonths(money, monthKeys(money, today));
  const lastKey = months[months.length - 1].key;
  /** The item whose purchase is being tried out against the forecast: on which day, from which account. */
  const [trying, setTrying] = useState<{ id: string; date: string; account: string } | null>(null);

  const set = (item: WishItem, patch: Partial<WishItem>) => {
    const next = { ...item, ...patch };
    if (item.id === ghostId) {
      onChange([...list, next]);
      setGhostId(newId('w'));
    } else onChange(list.map((w) => (w.id === item.id ? next : w)));
    if (patch.status === 'Purchased' && item.status !== 'Purchased') onPurchased(next);
  };

  return (
    <div className="money-body">
      {top}
      <div className="m-stats">
        <div className="m-stat">
          <span className="meta">Items</span>
          <span className="serif tnum">{stats.items}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Total price</span>
          <span className="serif tnum">{fmtMoney(stats.total)}</span>
        </div>
        <div className="m-stat">
          <span className="meta">Purchased</span>
          <span className="serif tnum">{fmtMoney(stats.purchased)}</span>
        </div>
        <div className="m-stat hero">
          <span className="meta">Still to buy</span>
          <span className="serif tnum">{fmtMoney(stats.stillToBuy)}</span>
        </div>
      </div>
      <section className="panel you-panel" aria-label="Wishlist" data-grid>
        <div className="panel-head">
          <h2 className="panel-title">Wishlist</h2>
          <span className="meta">Type in the last row to add one · “Fits from” is the first day your forecast stays above the price</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet wish">
            <colgroup>
              <col style={{ width: '22%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: 96 }} />
              <col style={{ width: 112 }} />
              <col style={{ width: 104 }} />
              <col style={{ width: 150 }} />
              <col style={{ width: 96 }} />
              <col />
              <col style={{ width: 64 }} />
            </colgroup>
            <thead>
              <tr>
                <th>Name</th>
                <th>Category</th>
                <th>Priority</th>
                <th>Status</th>
                <th className="r">Price</th>
                <th>Want it by</th>
                <th>Fits from</th>
                <th>Notes</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {rows.map((w, r) => {
                const ghost = w.id === ghostId;
                const fits = !ghost && !isDone(w) && w.price ? affordableFrom(w.price, months, today) : undefined;
                const late = !!fits && !!w.target && fits.slice(0, 7) > w.target;
                const open = trying?.id === w.id && !!w.price;
                return (
                  <Fragment key={w.id}>
                  <tr className={(isDone(w) ? 'done' : '') + (ghost ? ' ghost' : '')}>
                    <td>
                      <TextCell value={w.name} label="Name" r={r} c={0} max={80} placeholder={ghost ? 'Add an item…' : undefined} className="wish-name" onChange={(v) => set(w, { name: v })} />
                    </td>
                    <td>
                      <TextCell value={w.category} label="Category" r={r} c={1} max={40} onChange={(v) => set(w, { category: v })} />
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.priority)} aria-label="Priority" value={w.priority} onChange={(e) => set(w, { priority: e.target.value as WishItem['priority'] })} onKeyDown={cellKeys}>
                        <option value="">–</option>
                        {PRIORITIES.map((p) => (
                          <option key={p}>{p}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select className={'cell pick ' + pickTone(w.status)} aria-label="Status" value={w.status} onChange={(e) => set(w, { status: e.target.value as WishItem['status'] })} onKeyDown={cellKeys}>
                        <option value="">–</option>
                        {STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <NumCell value={w.price} label="Price" r={r} c={4} onChange={(v) => set(w, { price: v })} />
                    </td>
                    <td>
                      <input className={'cell tnum' + (w.target ? '' : ' unset')} type="month" aria-label="Want it by" value={w.target} onChange={(e) => set(w, { target: e.target.value })} onKeyDown={cellKeys} />
                    </td>
                    <td className="fits">
                      {fits !== undefined && (
                        <span
                          className={fits === null || late ? 'neg' : fits === today ? 'ok' : undefined}
                          title={fits === null ? `The forecast doesn’t stay above ${fmtMoney(w.price!)} through ${monthName(lastKey)}` : late ? `That’s after ${monthName(w.target)}` : `From then on, the forecast stays above ${fmtMoney(w.price!)}`}
                        >
                          {fits === null ? `Not by ${monthName(lastKey, true)}` : fits === today ? 'Now' : shortDate(fits).replace(/^\w+ /, '')}
                        </span>
                      )}
                    </td>
                    <td>
                      <TextCell value={w.notes} label="Notes" r={r} c={7} max={200} onChange={(v) => set(w, { notes: v })} />
                    </td>
                    <td className="c">
                      {!ghost && !isDone(w) && !!w.price && (
                        <button
                          className={'icon-btn row-x' + (open ? ' on' : '')}
                          title="What if you bought it? See the forecast before and after"
                          aria-label={`What if you bought ${w.name || 'this item'}`}
                          aria-expanded={open}
                          onClick={() => setTrying(open ? null : { id: w.id, date: fits && fits > today ? fits : today, account: lastAccount(money) })}
                        >
                          <i className="ph-duotone ph-question" />
                        </button>
                      )}
                      {!ghost && (
                        <button className="icon-btn row-x" title={`Remove ${w.name || 'this item'}`} aria-label={`Remove ${w.name || 'this item'}`} onClick={() => onChange(list.filter((x) => x.id !== w.id))}>
                          <i className="ph-duotone ph-x" />
                        </button>
                      )}
                    </td>
                  </tr>
                  {open && trying && (
                    <tr className="wish-whatif">
                      <td colSpan={9}>
                        <div className="wish-whatif-body">
                          <span className="meta">Buy it on</span>
                          <input className="cell tnum" type="date" aria-label="Buy it on" min={today} value={trying.date} onChange={(e) => e.target.value && setTrying({ ...trying, date: e.target.value })} />
                          <span className="meta">from</span>
                          <AccountSelect money={money} value={trying.account} label="Pay from" onChange={(account) => setTrying({ ...trying, account })} />
                          <WhatIf
                            money={money}
                            today={today}
                            label={`If you buy it for ${fmtMoney(w.price!)}`}
                            add={[{ id: 'what-if', date: trying.date, kind: 'out', amount: w.price!, note: w.name, category: 'Shopping', planned: true, account: trying.account, to: '' }]}
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

/** Colour only where it means something: high priority and bought things in the accent, the rest neutral or muted. */
function pickTone(v: string): string {
  if (v === 'High' || v === 'Purchased') return 'tone-accent';
  if (v === 'Low' || v === 'Dropped') return 'tone-muted';
  return v ? 'tone-neutral' : '';
}
