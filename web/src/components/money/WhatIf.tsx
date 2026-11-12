import { fmtMoney, monthName, previewAdd } from '../../../../shared/money';
import type { Money, MoneyEntry } from '../../../../shared/types';
import { shortDate } from './shared';

/** What adding some entries would do to the forecast, shown before they're saved. */
export function WhatIf({ money, add, today, label = 'If you add this' }: { money: Money; add: MoneyEntry[]; today: string; label?: string }) {
  const p = previewAdd(money, add, today);
  if (!p.changes)
    return (
      <p className="whatif meta" role="status">
        {label}: your day-to-day forecast stays the same.
      </p>
    );
  const low = p.low.after;
  const was = (n: number) => <span className="meta"> (now {fmtMoney(n)})</span>;
  return (
    <p className="whatif" role="status">
      <span className="meta whatif-label">{label}</span>
      {low && (
        <span>
          Lowest ahead <b className={'tnum' + (low.balance < 0 ? ' neg' : '')}>{fmtMoney(low.balance)}</b> on {shortDate(low.date)}
          {p.low.before && p.low.before.balance !== low.balance && was(p.low.before.balance)}
        </span>
      )}
      <span>
        End of {monthName(p.month, true)} <b className={'tnum' + (p.monthEnd.after < 0 ? ' neg' : '')}>{fmtMoney(p.monthEnd.after)}</b>
        {p.monthEnd.before !== p.monthEnd.after && was(p.monthEnd.before)}
      </span>
      {p.below.after > 0 ? (
        <span className="neg">
          <i className="ph-duotone ph-warning" aria-hidden="true" />
          {p.below.first ? `Below $0 from ${shortDate(p.below.first)}` : 'Below $0'}: {p.below.after} day{p.below.after === 1 ? '' : 's'} ahead
          {p.below.before > 0 && p.below.before !== p.below.after && `, up from ${p.below.before}`}
        </span>
      ) : (
        <span className="ok">Stays above $0</span>
      )}
    </p>
  );
}
