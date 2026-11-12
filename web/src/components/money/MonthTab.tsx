import { Fragment, useState } from 'react';
import { accountBalance, addMonths, balanceOn, calcMonths, fmtMoney, MAX_ENTRIES, monthKeys, monthName, type Repeat, repeatDates, sortEntries, toReview } from '../../../../shared/money';
import type { Money, MoneyCategory, MoneyEntry } from '../../../../shared/types';
import { localGet, localSet } from '../../api';
import { newId } from '../../util';
import { EntryRow } from './EntryRow';
import { MonthCalendar, TodayLine } from './MonthCalendar';
import { AccountSelect, Calc, CategoryCell, entryTitle, type Kind, KindSwitch, lastAccount, namesOf, NumCell, otherAccount, shortDate, signed } from './shared';

export const REPEATS: { key: Repeat; name: string }[] = [
  { key: 'once', name: 'Once' },
  { key: 'week', name: 'Every week' },
  { key: 'fortnight', name: 'Every 2 weeks' },
  { key: 'month', name: 'Every month' },
];

type Draft = { date: string; note: string; category: MoneyCategory | ''; kind: Kind; amount: number | null; account: string; to: string; repeat: Repeat; until: string };

export function MonthTab({ money, today, month, onMonth, onChange, onOpenOwed, together }: {
  money: Money;
  /** Show the calendar and the list side by side (Console, Bento and Horizon on a wide enough screen). */
  together?: boolean;
  today: string;
  month: string;
  onMonth: (k: string) => void;
  onChange: (m: Money) => void;
  onOpenOwed: () => void;
}) {
  // Include the month on screen, even one before the first or past the last.
  const keys = monthKeys({ ...money, start: `${month}-01` < money.start ? `${month}-01` : money.start }, month > today.slice(0, 7) ? `${month}-01` : today);
  const months = calcMonths(money, keys);
  const calc = months[keys.indexOf(month)] ?? months[0];
  const names = namesOf(money);
  const isNow = today.slice(0, 7) === month;
  const blank = (): Draft => {
    const account = lastAccount(money);
    return { date: isNow ? today : `${month}-01`, note: '', category: '', kind: 'out', amount: null, account, to: otherAccount(money, account), repeat: 'once', until: month };
  };
  const [draft, setDraft] = useState<Draft>(blank);
  const [draftMonth, setDraftMonth] = useState(month);
  if (draftMonth !== month) {
    setDraftMonth(month);
    setDraft(blank());
  }
  /** The entry open for changing, if any. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Only the entries of one account, or all of them. */
  const [only, setOnlyState] = useState(() => localGet('moneyOnly') ?? '');
  const setOnly = (id: string) => {
    setOnlyState(id);
    localSet('moneyOnly', id);
  };
  const shown = money.accounts.find((a) => a.id === only);
  const [layout, setLayoutState] = useState<'list' | 'calendar'>(() => (localGet('moneyLayout') === 'calendar' ? 'calendar' : 'list'));
  const setLayout = (l: 'list' | 'calendar') => {
    setLayoutState(l);
    localSet('moneyLayout', l);
  };
  /** From the calendar: go to the list with the add row set to that day. */
  const addOn = (date: string) => {
    setDraft({ ...blank(), date });
    setLayout('list');
    requestAnimationFrame(() => document.querySelector<HTMLInputElement>('[aria-label="New entry note"]')?.focus());
  };

  const inMonth = money.entries.filter((e) => e.date.slice(0, 7) === month);
  const entries = shown ? inMonth.filter((e) => e.account === shown.id || e.to === shown.id) : inMonth;
  const review = toReview(money, today).filter((e) => e.date.slice(0, 7) === month);
  // Accounts to filter by: those in use, and any old one this month's entries still mention.
  const filters = money.accounts.filter((a) => !a.archived || a.id === only || inMonth.some((e) => e.account === a.id || e.to === a.id));

  const setEntries = (list: MoneyEntry[]) => onChange({ ...money, entries: sortEntries(list) });
  const patch = (id: string, p: Partial<MoneyEntry>) => setEntries(money.entries.map((e) => (e.id === id ? { ...e, ...p } : e)));
  /** Deleting an invoice's money deletes the invoice too. */
  const remove = (e: MoneyEntry) =>
    onChange({ ...money, entries: money.entries.filter((x) => x.id !== e.id), invoices: e.invoice ? money.invoices.filter((i) => i.id !== e.invoice) : money.invoices });

  const repeats = repeatDates(draft.date || today, draft.repeat, draft.until);
  const move = draft.kind === 'move';
  const canAdd = !!draft.date && draft.amount !== null && money.entries.length < MAX_ENTRIES && (!move || (!!draft.to && draft.to !== draft.account));
  const add = () => {
    if (!canAdd) return;
    setEntries([
      ...money.entries,
      ...repeats.slice(0, MAX_ENTRIES - money.entries.length).map((date): MoneyEntry => ({
        id: newId('e'),
        date,
        kind: draft.kind,
        amount: Math.abs(draft.amount!),
        note: draft.note.trim(),
        category: move ? '' : draft.category,
        planned: date > today,
        account: draft.account,
        to: move ? draft.to : '',
      })),
    ]);
    localSet('moneyAccount', draft.account);
    setDraft({ ...blank(), date: draft.date, kind: draft.kind, account: draft.account, to: draft.to });
  };

  // The entries a day at a time, each day ending on its balance.
  const days: { date: string; list: MoneyEntry[] }[] = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last?.date === e.date) last.list.push(e);
    else days.push({ date: e.date, list: [e] });
  }
  const todayAt = isNow ? days.findIndex((d) => d.date > today) : -2;
  const lowIndex = calc.balances.indexOf(calc.lowest);
  const lowDate = `${month}-${String(lowIndex + 1).padStart(2, '0')}`;
  const balanceAt = (date: string) => (shown ? accountBalance(money, shown.id, date) : calc.balances[Number(date.slice(8)) - 1]);
  const pickAccount = (account: string) => setDraft({ ...draft, account, to: draft.to === account ? otherAccount(money, account) : draft.to });

  const listPart = (
    <>
          <div
            className="composer"
            role="group"
            aria-label="Add an entry"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') {
                e.preventDefault();
                add();
              }
            }}
          >
            <div className="composer-main">
              <KindSwitch kind={draft.kind} label="New entry is" onChange={(kind) => setDraft({ ...draft, kind })} />
              <input
                className="composer-note"
                aria-label="New entry note"
                placeholder={move ? 'What’s it for? (optional)' : 'What’s it for?'}
                maxLength={120}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
              <NumCell value={draft.amount} label="New entry amount" className="composer-amt" onChange={(v) => setDraft({ ...draft, amount: v === null ? null : Math.abs(v) })} />
              <button className="btn btn-primary composer-add" disabled={!canAdd} onClick={add}>
                {repeats.length > 1 ? `Add ${repeats.length}` : 'Add'}
              </button>
            </div>
            <div className="composer-acct">
              {move ? (
                <>
                  <span className="meta">From</span>
                  <AccountSelect money={money} value={draft.account} label="Move from" className="composer-field" onChange={pickAccount} />
                  <span className="meta">to</span>
                  <AccountSelect money={money} value={draft.to} label="Move to" className="composer-field" onChange={(to) => setDraft({ ...draft, to })} />
                </>
              ) : (
                <>
                  <span className="meta">{draft.kind === 'in' ? 'Paid into' : 'Paid from'}</span>
                  <div className="acct-chips" role="radiogroup" aria-label={draft.kind === 'in' ? 'Paid into' : 'Paid from'}>
                    {money.accounts
                      .filter((a) => !a.archived || a.id === draft.account)
                      .map((a) => (
                        <button key={a.id} type="button" role="radio" aria-checked={draft.account === a.id} className={'acct-chip' + (draft.account === a.id ? ' on' : '')} onClick={() => pickAccount(a.id)}>
                          {a.name}
                        </button>
                      ))}
                  </div>
                </>
              )}
            </div>
            <div className="composer-opts">
              <input type="date" className="cell composer-field tnum" aria-label="New entry date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} />
              {!move && <CategoryCell value={draft.category} label="New entry category" className="composer-field" empty="Category" onChange={(category) => setDraft({ ...draft, category })} />}
              <select className="cell pick composer-field" aria-label="Repeat" value={draft.repeat} onChange={(e) => setDraft({ ...draft, repeat: e.target.value as Repeat })}>
                {REPEATS.map((r) => (
                  <option key={r.key} value={r.key}>
                    {r.name}
                  </option>
                ))}
              </select>
              {draft.repeat !== 'once' && (
                <>
                  <span className="meta">until the end of</span>
                  <input className="cell composer-field tnum" type="month" aria-label="Repeat until" min={draft.date.slice(0, 7)} value={draft.until} onChange={(e) => e.target.value && setDraft({ ...draft, until: e.target.value })} />
                </>
              )}
              {draft.kind === 'in' && (
                <button className="btn-link meta" onClick={onOpenOwed}>
                  Gig pay? Add it as an invoice in Owed
                </button>
              )}
              <span className="meta composer-hint">{draft.date > today ? 'Goes in as planned: tick it once it’s happened' : 'Goes in as done'}</span>
            </div>
          </div>

          {money.accounts.length > 1 && (
            <div className="acct-filter" role="group" aria-label="Show entries for">
              <span className="meta">Show</span>
              <button className={'acct-chip' + (!shown ? ' on' : '')} aria-pressed={!shown} onClick={() => setOnly('')}>
                All accounts
              </button>
              {filters.map((a) => (
                <button key={a.id} className={'acct-chip' + (shown?.id === a.id ? ' on' : '')} aria-pressed={shown?.id === a.id} onClick={() => setOnly(a.id)}>
                  {a.name}
                </button>
              ))}
            </div>
          )}

          <section className="panel days" aria-label={`Entries for ${monthName(month)}`}>
            {days.length > 0 && (
              <div className="days-key meta">
                <span>
                  <span className="ent-tick on" aria-hidden="true" />
                  Done
                </span>
                <span>
                  <span className="ent-tick" aria-hidden="true" />
                  Planned
                </span>
                <span>{shown ? `Each day ends on what’s in ${shown.name}` : 'Each day ends on your day-to-day balance, planned and done together'}</span>
              </div>
            )}
            {days.map((d, i) => (
              <Fragment key={d.date}>
                {i === todayAt && <TodayLine money={money} today={today} account={shown} />}
                <div className="day">
                  <div className="day-head">
                    <h3>{shortDate(d.date)}</h3>
                    <span className="day-bal">
                      {!shown && d.date === lowDate && calc.lowest < calc.opening && <span className="chip chip-warn">Lowest</span>}
                      <Calc v={balanceAt(d.date)} title={`End of ${shortDate(d.date)}: ${shown ? `what’s in ${shown.name}` : 'your day-to-day accounts'}, counting everything up to then, planned or done`} />
                    </span>
                  </div>
                  {d.list.map((e) => (
                    <EntryRow
                      key={e.id}
                      e={e}
                      money={money}
                      today={today}
                      open={editing === e.id}
                      onOpen={() => setEditing(e.id)}
                      onClose={() => setEditing(null)}
                      onPatch={(p) => patch(e.id, p)}
                      onDelete={() => remove(e)}
                      onOpenOwed={onOpenOwed}
                    />
                  ))}
                </div>
              </Fragment>
            ))}
            {todayAt === -1 && <TodayLine money={money} today={today} account={shown} />}
            {!entries.length && (
              <p className="month-empty">
                {shown
                  ? `Nothing in or out of ${shown.name} in ${monthName(month)}.`
                  : `Nothing in ${monthName(month)} yet. Plan what you expect to spend and earn, then tick, change or delete entries as the days go by.`}
              </p>
            )}
          </section>
    </>
  );

  return (
    <div className="money-body month-tab">
      <div className="month-bar">
        <div className="month-nav">
          <button className="icon-btn md" aria-label="Previous month" disabled={month <= addMonths(keys[0], -1)} onClick={() => onMonth(addMonths(month, -1))}>
            <i className="ph-duotone ph-caret-left" />
          </button>
          <h2 className="serif month-title">{monthName(month)}</h2>
          <button className="icon-btn md" aria-label="Next month" disabled={month >= addMonths(today.slice(0, 7), 24)} onClick={() => onMonth(addMonths(month, 1))}>
            <i className="ph-duotone ph-caret-right" />
          </button>
          {!isNow && (
            <button className="btn btn-ghost btn-small" onClick={() => onMonth(today.slice(0, 7))}>
              This month
            </button>
          )}
        </div>
        {!together && (
        <div className="tabs layout-tabs" role="group" aria-label="Show as">
          {(['list', 'calendar'] as const).map((l) => (
            <button key={l} className={'tab' + (layout === l ? ' active' : '')} aria-pressed={layout === l} onClick={() => setLayout(l)}>
              <i className={'ph-duotone ' + (l === 'list' ? 'ph-list-bullets' : 'ph-calendar-blank')} />
              {l === 'list' ? 'List' : 'Calendar'}
            </button>
          ))}
        </div>
        )}
      </div>

      <section className="month-sum" aria-label={`${monthName(month)} in numbers`}>
        <div className="m-stats">
          {isNow ? (
            <MonthStat label="In the bank now" value={balanceOn(money, today, true)} note="day-to-day accounts, from what’s done" hero />
          ) : (
            <MonthStat label="Started with" value={calc.opening} note={month <= keys[0] ? 'what your day-to-day accounts opened with' : 'last month’s closing balance'} hero />
          )}
          <MonthStat label={`End of ${monthName(month, true)}`} value={calc.closing} note={calc.plannedIn || calc.plannedOut ? 'if the plan holds' : 'all of it done'} />
          <MonthStat label="Money in" value={calc.totalIn} sign tone="in" note={calc.plannedIn ? `${fmtMoney(calc.plannedIn)} still to come` : 'all of it done'} />
          <MonthStat label="Money out" value={-calc.totalOut} sign note={calc.plannedOut ? `${fmtMoney(calc.plannedOut)} still to come` : 'all of it done'} />
        </div>
        <p className="month-foot">
          {isNow && (
            <span>
              Started the month with <Calc v={calc.opening} title="What your day-to-day accounts had at the start of the month" strong />
            </span>
          )}
          {calc.lowest < calc.opening && (
            <span>
              <i className="ph-duotone ph-trend-down" aria-hidden="true" />
              Lowest point <Calc v={calc.lowest} title="The lowest end-of-day balance this month" strong /> on {shortDate(lowDate)}
            </span>
          )}
        </p>
      </section>

      {review.length > 0 && (
        <div className="review-bar">
          <div className="review-head">
            <i className="ph-duotone ph-clock-countdown" />
            <b>Did {review.length === 1 ? 'this' : 'these'} happen?</b>
            <span>Planned for a day that’s passed.</span>
            {review.length > 1 && (
              <button className="btn btn-secondary btn-small" onClick={() => setEntries(money.entries.map((e) => (review.includes(e) ? { ...e, planned: false } : e)))}>
                Mark all {review.length} as done
              </button>
            )}
          </div>
          {review.slice(0, 5).map((e) => (
            <div key={e.id} className="review-item">
              <span className="review-what">
                {entryTitle(e, names)} <span className="meta">· {shortDate(e.date)}</span>
              </span>
              <b className="tnum">{fmtMoney(e.kind === 'move' ? e.amount : signed(e), e.kind !== 'move')}</b>
              <button className="btn btn-small review-yes" onClick={() => patch(e.id, { planned: false })}>
                Yes, it’s done
              </button>
              <button className="btn btn-ghost btn-small" onClick={() => (setLayout('list'), setOnly(''), setEditing(e.id))}>
                Change it
              </button>
            </div>
          ))}
          {review.length > 5 && <span className="review-more">and {review.length - 5} more, marked Overdue in the list</span>}
        </div>
      )}

      {together ? (
        <div className="month-split">
          <MonthCalendar month={month} money={money} entries={inMonth} calc={calc} today={today} onPick={addOn} />
          <div className="month-list-col">{listPart}</div>
        </div>
      ) : layout === 'calendar' ? (
        <MonthCalendar month={month} money={money} entries={inMonth} calc={calc} today={today} onPick={addOn} />
      ) : (
        listPart
      )}
    </div>
  );
}

function MonthStat({ label, value, note, sign, tone, hero }: { label: string; value: number; note: string; sign?: boolean; tone?: 'in'; hero?: boolean }) {
  return (
    <div className={'m-stat' + (hero ? ' hero' : '')}>
      <span className="meta">{label}</span>
      <span className={'serif tnum' + (tone === 'in' ? ' m-in' : '')} style={value < 0 && !sign ? { color: 'var(--wn)' } : undefined}>
        {fmtMoney(value, sign)}
      </span>
      <span className="meta">{note}</span>
    </div>
  );
}
