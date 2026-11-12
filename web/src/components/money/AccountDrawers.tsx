import { useState } from 'react';
import { ACCOUNT_KINDS, accountBalance, addMonths, fmtMoney, goalPerMonth, mainAccount, MAX_ENTRIES, newAccount, type Repeat, repeatDates, sortEntries, spendableKind } from '../../../../shared/money';
import type { Money, MoneyAccount, MoneyEntry } from '../../../../shared/types';
import { localSet } from '../../api';
import { newId } from '../../util';
import { Drawer } from '../Drawers';
import { isZero, monthYear } from './Accounts';
import { REPEATS } from './MonthTab';
import { AccountSelect, AmountInput, lastAccount, otherAccount, shortDate } from './shared';

/** Adds an account, or changes one: its name, kind, starting balance and goal; correcting what's in it; archiving it. */
export function AccountDrawer({ money, today, id, onChange, onClose }: { money: Money; today: string; id: string | null; onChange: (m: Money) => void; onClose: () => void }) {
  const existing = money.accounts.find((a) => a.id === id);
  const [draft, setDraft] = useState<MoneyAccount>(() => existing ?? newAccount(newId('a'), '', 'pot'));
  // Picking a kind sets whether it's day-to-day money, until that's set by hand.
  const [spendSet, setSpendSet] = useState(!!existing);
  const [plan, setPlan] = useState(true);
  const [from, setFrom] = useState(() => mainAccount(money.accounts));
  const [actual, setActual] = useState<number | null>(null);
  const month = today.slice(0, 7);
  const balance = existing ? accountBalance(money, existing.id, today, true) : draft.opening;
  const perMonth = draft.goal && draft.goalBy > month ? goalPerMonth(balance, draft.goal, draft.goalBy, today) : 0;
  const used = money.entries.some((e) => e.account === id || e.to === id);
  const name = draft.name.trim();
  const planning = !existing && plan && perMonth > 0 && money.accounts.length > 0;

  const save = () => {
    if (!name) return;
    const account: MoneyAccount = { ...draft, name, goalBy: draft.goal ? draft.goalBy : '' };
    let entries = money.entries;
    if (planning) {
      // A planned monthly move from the next month on, on today's day (or the 28th, so every month has it).
      const first = `${addMonths(month, 1)}-${String(Math.min(Number(today.slice(8)), 28)).padStart(2, '0')}`;
      const moves = repeatDates(first, 'month', account.goalBy).map(
        (date): MoneyEntry => ({ id: newId('e'), date, kind: 'move', amount: perMonth, note: `Saving for ${name}`, category: '', planned: true, account: from, to: account.id }),
      );
      entries = sortEntries([...entries, ...moves.slice(0, MAX_ENTRIES - entries.length)]);
    }
    onChange({ ...money, accounts: existing ? money.accounts.map((a) => (a.id === id ? account : a)) : [...money.accounts, account], entries });
    onClose();
  };
  /** Records the difference between what the app has and what the account really has today, as done money in or out. */
  const correct = () => {
    if (!existing || actual === null || isZero(actual - balance)) return;
    const diff = actual - balance;
    const entry: MoneyEntry = { id: newId('e'), date: today, kind: diff > 0 ? 'in' : 'out', amount: Math.abs(Math.round(diff * 100) / 100), note: 'Balance correction', category: '', planned: false, account: existing.id, to: '' };
    onChange({ ...money, entries: sortEntries([...money.entries, entry]) });
    setActual(null);
  };
  const setArchived = (archived: boolean) => {
    onChange({ ...money, accounts: money.accounts.map((a) => (a.id === id ? { ...a, archived } : a)) });
    onClose();
  };

  return (
    <Drawer title={existing ? existing.name : 'Add an account'} onClose={onClose}>
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field">
          Name
          <input className="input" maxLength={40} placeholder="Like Japan trip" autoFocus={!existing} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>

        <fieldset className="acct-kinds" role="radiogroup" aria-label="What kind?">
          <legend className="field">What kind?</legend>
          {ACCOUNT_KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={draft.kind === k.key}
              className={'acct-kind' + (draft.kind === k.key ? ' on' : '')}
              onClick={() => setDraft({ ...draft, kind: k.key, spendable: spendSet ? draft.spendable : spendableKind(k.key) })}
            >
              <i className={'ph-duotone ' + k.icon} aria-hidden="true" />
              <span>
                <b>{k.name}</b>
                <span className="meta">{k.note}</span>
              </span>
            </button>
          ))}
        </fieldset>

        <div className="field">
          <label htmlFor="acct-opening">{existing ? `What it had on ${shortDate(money.start)}, when tracking started` : 'Money in it now'}</label>
          <AmountInput id="acct-opening" value={draft.opening} onChange={(v) => setDraft({ ...draft, opening: v ?? 0 })} />
        </div>

        <div className="acct-goal-box">
          <b>
            Goal <span className="meta">(optional)</span>
          </b>
          <div className="acct-row">
            <div className="field">
              <label htmlFor="acct-goal">Save up</label>
              <AmountInput id="acct-goal" value={draft.goal} onChange={(v) => setDraft({ ...draft, goal: v && v > 0 ? v : null, goalBy: draft.goalBy || addMonths(month, 6) })} />
            </div>
            <label className="field">
              By
              <input className="input tnum" type="month" min={month} disabled={!draft.goal} value={draft.goalBy} onChange={(e) => setDraft({ ...draft, goalBy: e.target.value })} />
            </label>
          </div>
          {perMonth > 0 && (
            <span className="meta">
              That’s about <b>{fmtMoney(perMonth)} a month</b> from {monthYear(addMonths(month, 1))}.
            </span>
          )}
          {!existing && perMonth > 0 && money.accounts.length > 0 && (
            <label className="acct-check">
              <input type="checkbox" checked={plan} onChange={(e) => setPlan(e.target.checked)} />
              <span>
                Plan a monthly move of {fmtMoney(perMonth)} from{' '}
                <AccountSelect bare money={money} value={from} label="Move from" className="input sm acct-inline" onChange={setFrom} />
              </span>
            </label>
          )}
        </div>

        <label className="acct-check">
          <input
            type="checkbox"
            checked={draft.spendable}
            onChange={(e) => {
              setSpendSet(true);
              setDraft({ ...draft, spendable: e.target.checked });
            }}
          />
          <span>
            Count it as day-to-day money
            <span className="meta">“In the bank now”, the month’s balances and the forecasts only count day-to-day accounts. Leave it off for pots and investments.</span>
          </span>
        </label>

        <div className="acct-actions">
          <button type="submit" className="btn btn-primary" disabled={!name}>
            {existing ? 'Save' : name ? `Add ${name}` : 'Add account'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>

      {existing && (
        <div className="drawer-section">
          <h3 className="drawer-label">Correct the balance</h3>
          <span className="meta">
            The app has {fmtMoney(balance)} in {existing.name} today. If the real balance is different (say investments went up or down), type it here and the difference goes in as done money in or out.
          </span>
          <div className="acct-row">
            <div className="field">
              <label htmlFor="acct-actual">What it really has today</label>
              <AmountInput id="acct-actual" value={actual} onChange={setActual} />
            </div>
            <button type="button" className="btn btn-secondary acct-row-btn" disabled={actual === null || isZero(actual - balance)} onClick={correct}>
              {actual === null || isZero(actual - balance) ? 'Correct it' : `Add ${fmtMoney(actual - balance, true)}`}
            </button>
          </div>
        </div>
      )}

      {existing && (
        <div className="drawer-section">
          <h3 className="drawer-label">{existing.archived ? 'Archived' : 'Done with it?'}</h3>
          <span className="meta">
            {existing.archived
              ? 'It keeps its history but isn’t offered for new entries.'
              : 'Archiving keeps its history and balance but stops offering it for new entries.'}
          </span>
          <div className="acct-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setArchived(!existing.archived)}>
              {existing.archived ? 'Bring it back' : 'Archive'}
            </button>
            {!used && money.accounts.length > 1 && (
              <button
                type="button"
                className="btn btn-ghost acct-delete"
                onClick={() => {
                  onChange({ ...money, accounts: money.accounts.filter((a) => a.id !== id) });
                  onClose();
                }}
              >
                Delete it
              </button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

/** Moves money from one account to another, once or on repeat. The total stays the same. */
export function MoveDrawer({ money, today, onChange, onClose }: { money: Money; today: string; onChange: (m: Money) => void; onClose: () => void }) {
  const [from, setFrom] = useState(() => lastAccount(money));
  const [to, setTo] = useState(() => otherAccount(money, lastAccount(money)));
  const [amount, setAmount] = useState<number | null>(null);
  const [date, setDate] = useState(today);
  const [repeat, setRepeat] = useState<Repeat>('once');
  const [until, setUntil] = useState(today.slice(0, 7));
  const [note, setNote] = useState('');
  const dates = repeatDates(date || today, repeat, until);
  const ok = !!date && !!amount && !!to && from !== to && money.entries.length + dates.length <= MAX_ENTRIES;
  const spend = (id: string) => money.accounts.find((a) => a.id === id)?.spendable ?? false;
  const after = (id: string, sign: number) => accountBalance(money, id, today, true) + (date <= today && amount ? sign * amount : 0);

  const add = () => {
    if (!ok) return;
    const moves = dates.map((d): MoneyEntry => ({ id: newId('e'), date: d, kind: 'move', amount: Math.abs(amount!), note: note.trim(), category: '', planned: d > today, account: from, to }));
    onChange({ ...money, entries: sortEntries([...money.entries, ...moves]) });
    localSet('moneyAccount', from);
    onClose();
  };

  return (
    <Drawer title="Move money" onClose={onClose}>
      <form
        className="acct-form"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <div className="acct-row move-ends">
          <div className="field">
            <label htmlFor="move-from">From</label>
            <AccountSelect id="move-from" bare money={money} value={from} label="From" className="input" onChange={(id) => (setFrom(id), id === to && setTo(from))} />
            <span className="meta tnum">
              {fmtMoney(accountBalance(money, from, today, true))}
              {date <= today && amount ? ` → ${fmtMoney(after(from, -1))}` : ''}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn md move-swap"
            title="Swap"
            aria-label="Swap from and to"
            onClick={() => {
              setFrom(to);
              setTo(from);
            }}
          >
            <i className="ph-bold ph-arrows-left-right" />
          </button>
          <div className="field">
            <label htmlFor="move-to">To</label>
            <AccountSelect id="move-to" bare money={money} value={to} label="To" className="input" onChange={(id) => (setTo(id), id === from && setFrom(to))} />
            <span className="meta tnum">
              {fmtMoney(accountBalance(money, to, today, true))}
              {date <= today && amount ? ` → ${fmtMoney(after(to, 1))}` : ''}
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="move-amount">Amount</label>
          <AmountInput id="move-amount" value={amount} onChange={(v) => setAmount(v === null ? null : Math.abs(v))} />
        </div>
        <div className="acct-row">
          <label className="field">
            Date
            <input className="input tnum" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="field">
            Repeat
            <select className="input" value={repeat} onChange={(e) => setRepeat(e.target.value as Repeat)}>
              {REPEATS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          {repeat !== 'once' && (
            <label className="field">
              Until the end of
              <input className="input tnum" type="month" min={date.slice(0, 7)} value={until} onChange={(e) => e.target.value && setUntil(e.target.value)} />
            </label>
          )}
        </div>
        <label className="field">
          Note (optional)
          <input className="input" maxLength={120} placeholder="Like Monthly invest" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
        <p className="acct-note">
          {dates.length > 1 ? `${dates.length} moves, the first ` : 'It goes in '}
          {date > today ? 'as planned: tick it in Month once it’s happened.' : 'as done.'}{' '}
          {spend(from) === spend(to)
            ? 'Your total and day-to-day balance stay the same; only where the money sits changes.'
            : spend(from)
              ? `Your total stays the same, but it leaves your day-to-day money, so it counts as money out in Month.`
              : `Your total stays the same, but it comes into your day-to-day money, so it counts as money in in Month.`}
        </p>
        <div className="acct-actions">
          <button type="submit" className="btn btn-primary" disabled={!ok}>
            {amount ? `Move ${fmtMoney(amount)}${dates.length > 1 ? ` × ${dates.length}` : ''}` : 'Move'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
        </div>
        {from === to && <span className="meta">Pick two different accounts.</span>}
      </form>
    </Drawer>
  );
}
