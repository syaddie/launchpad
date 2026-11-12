import { balanceOn, byCategory, calcMonths, calcTotals, fmtMoney, lowestAhead, type MonthCalc, monthKeys, monthName, toReview } from '../../../../shared/money';
import type { Money } from '../../../../shared/types';
import { AccountsPanel } from './Accounts';
import { BalanceChart, InOutChart } from './charts';
import { Calc, shortDate } from './shared';

export function Overview({ money, today, onOpenMonth, onChange }: { money: Money; today: string; onOpenMonth: (k: string) => void; onChange: (m: Money) => void }) {
  const keys = monthKeys(money, today);
  const months = calcMonths(money, keys);
  const all = calcTotals(money, months);
  const thisMonth = months.find((m) => m.key === today.slice(0, 7)) ?? months[months.length - 1];
  const actual = balanceOn(money, today, true);
  const low = lowestAhead(months, today);
  const review = toReview(money, today);
  const cats = byCategory(money.entries.filter((e) => e.date.slice(0, 7) === thisMonth.key));
  const showCats = cats.some((c) => c.category !== 'Not set');

  return (
    <div className="money-body">
      <div className="m-stats">
        <div className="m-stat hero">
          <span className="meta">Balance today</span>
          <span className="serif tnum" style={actual < 0 ? { color: 'var(--wn)' } : undefined}>
            {fmtMoney(actual)}
          </span>
          <span className="meta">day-to-day accounts, from what’s done</span>
        </div>
        <div className="m-stat">
          <span className="meta">End of {monthName(thisMonth.key, true)}</span>
          <span className="serif tnum" style={thisMonth.closing < 0 ? { color: 'var(--wn)' } : undefined}>
            {fmtMoney(thisMonth.closing)}
          </span>
          <span className="meta">forecast</span>
        </div>
        <div className="m-stat">
          <span className="meta">Lowest ahead</span>
          <span className="serif tnum" style={low && low.balance < 0 ? { color: 'var(--wn)' } : undefined}>
            {low ? fmtMoney(low.balance) : '—'}
          </span>
          <span className="meta">{low ? (low.date === today ? 'today' : `on ${shortDate(low.date)}`) : 'nothing ahead'}</span>
        </div>
        <button className={'m-stat' + (review.length ? ' warn' : '')} disabled={!review.length} onClick={() => onOpenMonth(review[0].date.slice(0, 7))}>
          <span className="meta">To check</span>
          <span className="serif tnum">{review.length}</span>
          <span className="meta">{review.length ? 'planned entries that have passed ›' : 'all caught up'}</span>
        </button>
      </div>

      <AccountsPanel money={money} today={today} onChange={onChange} />

      <section className="panel you-panel" aria-label="Month by month">
        <div className="panel-head">
          <h2 className="panel-title">Month by month</h2>
          <span className="meta">Planned and done together · open a month to edit it</span>
        </div>
        <div className="sum-scroll">
          <table className="sheet sum">
            <thead>
              <tr>
                <th>Month</th>
                <th className="r">Opening</th>
                <th className="r">In</th>
                <th className="r">Out</th>
                <th className="r">Net</th>
                <th className="r">Closing</th>
                <th className="r">Lowest balance</th>
                <th className="r">Days below $0</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <SumRow
                  key={m.key}
                  c={m}
                  name={
                    <button className="month-link" onClick={() => onOpenMonth(m.key)}>
                      {monthName(m.key)}
                      {m.key === today.slice(0, 7) ? <span className="chip chip-accent">Now</span> : m.key > today ? <span className="chip chip-muted">Plan</span> : null}
                    </button>
                  }
                />
              ))}
            </tbody>
            <tfoot>
              <SumRow name="All months" c={all} />
            </tfoot>
          </table>
        </div>
      </section>

      <div className="you-row">
        <BalanceChart months={months} today={today} />
        <InOutChart months={months} />
        {showCats && <CategoryPanel cats={cats} month={thisMonth.key} />}
      </div>
    </div>
  );
}

function SumRow({ name, c }: { name: React.ReactNode; c: Omit<MonthCalc, 'key' | 'balances'> }) {
  return (
    <tr>
      <th>{name}</th>
      <td className="r">
        <Calc v={c.opening} title="Opening balance" />
      </td>
      <td className="r">
        <Calc v={c.totalIn} title={c.plannedIn ? `${fmtMoney(c.plannedIn)} of it still planned` : 'Money in'} />
      </td>
      <td className="r">
        <Calc v={c.totalOut} title={c.plannedOut ? `${fmtMoney(c.plannedOut)} of it still planned` : 'Money out'} />
      </td>
      <td className="r">
        <Calc v={c.net} sign title="Money in − money out" />
      </td>
      <td className="r">
        <Calc v={c.closing} title="Closing balance" strong />
      </td>
      <td className="r">
        <Calc v={c.lowest} title="The lowest end-of-day balance" />
      </td>
      <td className={'r tnum' + (c.daysBelow ? ' neg' : '')}>{c.daysBelow}</td>
    </tr>
  );
}

function CategoryPanel({ cats, month }: { cats: { category: string; amount: number }[]; month: string }) {
  const max = Math.max(...cats.map((c) => c.amount), 1);
  return (
    <section className="panel you-panel m-chart cats" aria-label={`Spending by category, ${monthName(month)}`}>
      <div className="panel-head">
        <h2 className="panel-title">Spending</h2>
        <span className="meta">{monthName(month)}</span>
      </div>
      <div className="cat-list">
        {cats.map((c) => (
          <div key={c.category} className="cat-row">
            <span className={c.category === 'Not set' ? 'meta' : undefined}>{c.category}</span>
            <span className="cat-track">
              <span style={{ width: `${(c.amount / max) * 100}%`, opacity: c.category === 'Not set' ? 0.45 : 1 }} />
            </span>
            <span className="tnum">{fmtMoney(c.amount)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
