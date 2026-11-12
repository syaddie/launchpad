import { accountBalance, balanceOn, effectOn, fmtMoney, type MonthCalc, monthName } from '../../../../shared/money';
import type { Money, MoneyAccount, MoneyEntry } from '../../../../shared/types';
import { parseYmd } from '../../util';
import { entryTitle, namesOf, shortDate, signed } from './shared';

/**
 * The month as a calendar: each day's money in, money out and end-of-day balance, for the
 * day-to-day accounts (a move to or from set-aside money counts as out or in). Click a day to add to it.
 */
export function MonthCalendar({ month, money, entries, calc, today, onPick }: { month: string; money: Money; entries: MoneyEntry[]; calc: MonthCalc; today: string; onPick: (date: string) => void }) {
  const lead = (parseYmd(`${month}-01`).getDay() + 6) % 7;
  const byDay = new Map<string, MoneyEntry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const lowest = calc.balances.indexOf(calc.lowest);
  const names = namesOf(money);
  const spendable = money.accounts.filter((a) => a.spendable).map((a) => a.id);
  const effect = (e: MoneyEntry) => spendable.reduce((a, id) => a + effectOn(e, id), 0);

  return (
    <section className="panel you-panel cal" aria-label={`${monthName(month)} as a calendar`}>
      <div className="cal-grid">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d} className="cal-dow">
            {d}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={'l' + i} />
        ))}
        {calc.balances.map((bal, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const list = byDay.get(date) ?? [];
          const inn = list.reduce((a, e) => a + Math.max(0, effect(e)), 0);
          const out = list.reduce((a, e) => a - Math.min(0, effect(e)), 0);
          const late = list.some((e) => e.planned && e.date < today);
          const title = [
            `${shortDate(date)} · balance ${fmtMoney(bal)}${date > today ? ' (forecast)' : ''}`,
            ...list.map((e) => `${e.kind === 'move' ? `${fmtMoney(e.amount)} ${entryTitle(e, names)}` : `${fmtMoney(signed(e), true)}${e.note ? ` ${e.note}` : ''}`}${e.planned ? ' (planned)' : ''}`),
            'Click to add to this day',
          ].join('\n');
          return (
            <button
              key={date}
              className={'cal-day' + (date === today ? ' today' : '') + (date < today ? ' past' : '') + (list.length && list.every((e) => e.planned) ? ' planned' : '') + (list.length ? ' has' : '')}
              title={title}
              onClick={() => onPick(date)}
            >
              <span className="cal-num tnum">
                {i + 1}
                {late && <span className="cal-late" aria-label="Has planned entries that have passed" />}
                {i === lowest && calc.lowest < calc.opening && <span className="cal-low">lowest</span>}
              </span>
              <span className="cal-amts tnum">
                {inn > 0 && <span className="cal-in">+{fmtMoney(inn)}</span>}
                {out > 0 && <span className="cal-out">−{fmtMoney(out)}</span>}
              </span>
              <span className={'cal-bal tnum' + (bal < 0 ? ' neg' : '')}>{fmtMoney(bal)}</span>
            </button>
          );
        })}
      </div>
      <div className="cal-foot meta">
        <span>
          <b className="cal-in">+In</b> · <b className="cal-out">−Out</b> · your day-to-day balance at the end of the day, counting what’s planned
        </span>
        <span>Days in italics are only planned so far · click a day to add to it</span>
      </div>
    </section>
  );
}

export function TodayLine({ money, today, account }: { money: Money; today: string; account?: MoneyAccount }) {
  const actual = account ? accountBalance(money, account.id, today, true) : balanceOn(money, today, true);
  const forecast = account ? accountBalance(money, account.id, today) : balanceOn(money, today);
  return (
    <div className="today-line">
      <b>Today · {shortDate(today)}</b>
      <span>
        <b className={'tnum' + (actual < 0 ? ' neg' : '')}>{fmtMoney(actual)}</b> {account ? `in ${account.name}` : 'in the bank'} from what’s done
        {forecast !== actual && <span className="meta"> · the plan had {fmtMoney(forecast)} by today</span>}
      </span>
    </div>
  );
}
