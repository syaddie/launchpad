import { type CSSProperties, useEffect, useRef, type KeyboardEvent } from 'react';
import { accountBalance, balanceOn, effectOn, fmtMoney, type MonthCalc, monthName } from '../../../../shared/money';
import type { Money, MoneyAccount, MoneyEntry } from '../../../../shared/types';
import { parseYmd } from '../../util';
import { copyText, menuProps } from '../ContextMenu';
import { dayName, stepDay } from './monthList';
import { entryTitle, namesOf, type Notify, shortDate, signed } from './shared';

/** How a day was picked: a click (or Enter), an arrow key, or the day's menu. */
export type PickHow = 'click' | 'key' | 'menu';

const HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** An amount in a day: to the cent, and in whole dollars for a day too narrow for cents (styles.css). */
function Amount({ v, sign }: { v: number; sign?: boolean }) {
  const exact = fmtMoney(v, sign);
  const whole = fmtMoney(Math.round(v), sign);
  return exact === whole ? (
    <>{exact}</>
  ) : (
    <>
      <span className="cal-x">{exact}</span>
      <span className="cal-r">{whole}</span>
    </>
  );
}
const MOVES = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

/**
 * The month as a calendar: each day's money in, money out and end-of-day balance, for the
 * day-to-day accounts (a move to or from set-aside money counts as out or in). Picking a day
 * (a click, or the arrow keys once one has focus) shows it in the list and makes it the add
 * row's day; `picked` is that day, ringed.
 */
export function MonthCalendar({ month, money, entries, calc, today, picked, onPick, onAdd, onDone, notify }: {
  month: string;
  money: Money;
  entries: MoneyEntry[];
  calc: MonthCalc;
  today: string;
  picked: string | null;
  onPick: (date: string, how: PickHow) => void;
  /** Add something on that day: the add row takes the day and its note takes focus. */
  onAdd: (date: string) => void;
  /** Mark that day's planned entries as done. */
  onDone: (date: string) => void;
  notify: Notify;
}) {
  const lead = (parseYmd(`${month}-01`).getDay() + 6) % 7;
  const byDay = new Map<string, MoneyEntry[]>();
  for (const e of entries) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
  const lowest = calc.balances.indexOf(calc.lowest);
  const names = namesOf(money);
  const spendable = money.accounts.filter((a) => a.spendable).map((a) => a.id);
  const effect = (e: MoneyEntry) => spendable.reduce((a, id) => a + effectOn(e, id), 0);
  const dates = calc.balances.map((_, i) => `${month}-${String(i + 1).padStart(2, '0')}`);
  // The one day the Tab key reaches (the rest by the arrow keys): the picked one, today, or the 1st.
  const focusable = picked && dates.includes(picked) ? picked : dates.includes(today) ? today : dates[0];
  const grid = useRef<HTMLDivElement>(null);
  const keyed = useRef(false);

  useEffect(() => {
    if (!keyed.current) return;
    keyed.current = false;
    grid.current?.querySelector<HTMLElement>(`[data-date="${picked}"]`)?.focus();
  }, [picked]);

  const onKey = (e: KeyboardEvent) => {
    const from = (e.target as HTMLElement).closest<HTMLElement>('[data-date]')?.dataset.date;
    if (!from || e.altKey || e.ctrlKey || e.metaKey || !MOVES.includes(e.key)) return;
    // Past either end of the month the key does nothing, rather than scrolling the page.
    e.preventDefault();
    const to = stepDay(from, e.key, month);
    if (!to) return;
    keyed.current = true;
    onPick(to, 'key');
  };

  // The weeks, Monday first: blanks before the 1st, then the days, then blanks to the end of the last week.
  const cells: (string | null)[] = [...Array.from({ length: lead }, () => null), ...dates];
  while (cells.length % 7) cells.push(null);
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));

  return (
    <section className="panel you-panel cal" aria-label={`${monthName(month)} as a calendar`}>
      {/* A new grid for each month, so it comes in as a whole (monthMotion.ts and styles.css, "Changing month"). */}
      <div key={month} className="cal-grid" role="grid" aria-label={`${monthName(month)}, a day at a time`} ref={grid} onKeyDown={onKey}>
        <div className="cal-row" role="row">
          {HEAD.map((d) => (
            <span key={d} className="cal-dow" role="columnheader">
              {d}
            </span>
          ))}
        </div>
        {weeks.map((w, wi) => (
          <div key={wi} className="cal-row" role="row">
            {w.map((date, di) => {
              if (!date) return <span key={'b' + di} className="cal-blank" role="gridcell" />;
              const i = Number(date.slice(8)) - 1;
              const bal = calc.balances[i];
              const list = byDay.get(date) ?? [];
              const inn = list.reduce((a, e) => a + Math.max(0, effect(e)), 0);
              const out = list.reduce((a, e) => a - Math.min(0, effect(e)), 0);
              const planned = list.filter((e) => e.planned);
              const late = date < today && planned.length > 0;
              const isLow = i === lowest && calc.lowest < calc.opening;
              const lines = list.map((e) => `${e.kind === 'move' ? `${fmtMoney(e.amount)} ${entryTitle(e, names)}` : `${fmtMoney(signed(e), true)}${e.note ? ` ${e.note}` : ''}`}${e.planned ? ' (planned)' : ''}`);
              const summary = [`${shortDate(date)} · balance ${fmtMoney(bal)}${date > today ? ' (forecast)' : ''}`, ...lines].join('\n');
              const label = [
                dayName(date, today),
                inn > 0 && `in ${fmtMoney(inn)}`,
                out > 0 && `out ${fmtMoney(out)}`,
                !list.length && 'nothing in or out',
                `ends at ${fmtMoney(bal)}`,
                late && 'has planned entries that have passed',
                isLow && 'the lowest this month',
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <span key={date} className="cal-cell" role="gridcell" aria-selected={picked === date} style={{ '--c': di } as CSSProperties}>
                  <button
                    type="button"
                    data-date={date}
                    tabIndex={date === focusable ? 0 : -1}
                    aria-label={label}
                    aria-current={date === today ? 'date' : undefined}
                    className={'cal-day' + (inn > 0 && out > 0 ? ' both' : '') + (date === today ? ' today' : '') + (date < today ? ' past' : '') + (list.length && planned.length === list.length ? ' planned' : '') + (list.length ? ' has' : '') + (picked === date ? ' on' : '')}
                    title={`${summary}\nClick to see it in the list`}
                    onClick={() => onPick(date, 'click')}
                    {...menuProps(
                      () => [
                        { label: 'Show in the list', icon: 'ph-list-bullets', onSelect: () => onPick(date, 'menu') },
                        { label: 'Add to this day', icon: 'ph-plus', onSelect: () => onAdd(date) },
                        planned.length > 0 && { label: planned.length === 1 ? 'Mark its planned entry as done' : `Mark its ${planned.length} planned entries as done`, icon: 'ph-check-circle', onSelect: () => onDone(date) },
                        'sep',
                        { label: 'Copy', icon: 'ph-copy', onSelect: () => copyText(summary, notify) },
                      ],
                      shortDate(date),
                    )}
                  >
                    <span className="cal-num tnum">
                      <span className="cal-n">{i + 1}</span>
                      {late && <span className="cal-late" aria-hidden="true" />}
                      {isLow && (
                        <span className="cal-low" aria-hidden="true">
                          <i className="ph-duotone ph-trend-down" />
                          <span className="cal-low-t">lowest</span>
                        </span>
                      )}
                    </span>
                    <span className="cal-amts tnum">
                      {inn > 0 && (
                        <span className="cal-in">
                          +<Amount v={inn} />
                        </span>
                      )}
                      {out > 0 && (
                        <span className="cal-out">
                          −<Amount v={out} />
                        </span>
                      )}
                      {/* A short day shows this instead of the two (styles.css). */}
                      {inn > 0 && out > 0 && (
                        <span className={'cal-net ' + (inn >= out ? 'cal-in' : 'cal-out')}>
                          <Amount v={inn - out} sign />
                        </span>
                      )}
                    </span>
                    <span className={'cal-bal tnum' + (bal < 0 ? ' neg' : '')}>
                      <Amount v={bal} />
                    </span>
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="cal-foot meta">
        <span>
          <b className="cal-in">+In</b> · <b className="cal-out">−Out</b> · the balance at the end of the day, planned included
        </span>
        <span>Italics: only planned · pick a day to see it in the list</span>
      </div>
    </section>
  );
}

/** Where the list has got to today: what's in the bank from what's done. `now`: it comes right under today's own heading. */
export function TodayLine({ money, today, account, now }: { money: Money; today: string; account?: MoneyAccount; now?: boolean }) {
  const actual = account ? accountBalance(money, account.id, today, true) : balanceOn(money, today, true);
  const forecast = account ? accountBalance(money, account.id, today) : balanceOn(money, today);
  return (
    <div className="today-line" data-today="">
      <b>{now ? 'Now' : `Today · ${shortDate(today)}`}</b>
      <span>
        <b className={'tnum' + (actual < 0 ? ' neg' : '')}>{fmtMoney(actual)}</b> {account ? `in ${account.name}` : 'in the bank'} from what’s done
        {forecast !== actual && <span className="meta"> · the plan had {fmtMoney(forecast)} by today</span>}
      </span>
    </div>
  );
}
