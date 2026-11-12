import { useState } from 'react';
import { calcMonths, fmtMoney, goalRows, type GoalRow, MAX_GOALS, monthKeys, monthName } from '../../../../shared/money';
import type { Money, SavingsGoal } from '../../../../shared/types';
import { newId } from '../../util';
import { Calc, cellKeys, NumCell, shortDate, TextCell } from './shared';

const blankGoal = (id: string): SavingsGoal => ({ id, name: '', target: null, by: '', account: '', saved: 0 });

/**
 * Savings goals: each with a target, an optional month, and an account it's kept in or
 * an amount set aside elsewhere. Shows the progress, when the forecast gets there and
 * what a month it takes to hit the date. The pots' own goals are listed too.
 */
export function Goals({ money, today, onChange }: { money: Money; today: string; onChange: (m: Money) => void }) {
  const list = money.goals;
  const [ghostId, setGhostId] = useState(() => newId('g'));
  const months = calcMonths(money, monthKeys(money, today));
  const lastKey = months[months.length - 1].key;
  const calc = goalRows(money, months, today);
  const byId = new Map(calc.map((r) => [r.goal.id, r]));
  const pots = calc.filter((r) => r.fromAccount);
  const rows = list.length < MAX_GOALS ? [...list, blankGoal(ghostId)] : list;
  const accounts = money.accounts.filter((a) => !a.archived);

  const set = (g: SavingsGoal, patch: Partial<SavingsGoal>) => {
    const next = { ...g, ...patch };
    if (g.id === ghostId) {
      onChange({ ...money, goals: [...list, next] });
      setGhostId(newId('g'));
    } else onChange({ ...money, goals: list.map((x) => (x.id === g.id ? next : x)) });
  };

  return (
    <section className="panel you-panel" aria-label="Savings goals" data-grid>
      <div className="panel-head">
        <h2 className="panel-title">Savings goals</h2>
        <span className="meta">Type in the last row to add one · “Reachable” is from your forecast, after everything planned</span>
      </div>
      <div className="sum-scroll">
        <table className="sheet wish goals">
          <colgroup>
            <col style={{ width: '20%' }} />
            <col style={{ width: 104 }} />
            <col style={{ width: 150 }} />
            <col style={{ width: 140 }} />
            <col style={{ width: 104 }} />
            <col />
            <col style={{ width: 130 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 34 }} />
          </colgroup>
          <thead>
            <tr>
              <th>Goal</th>
              <th className="r">Target</th>
              <th>By</th>
              <th>Kept in</th>
              <th className="r">Saved</th>
              <th>Progress</th>
              <th>Reachable</th>
              <th className="r" title="A month from here to hit the date">A month</th>
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody>
            {rows.map((g, r) => {
              const ghost = g.id === ghostId;
              const row = byId.get(g.id);
              return (
                <tr key={g.id} className={ghost ? 'ghost' : undefined}>
                  <td>
                    <TextCell value={g.name} label="Goal" r={r} c={0} max={60} placeholder={ghost ? 'Add a goal…' : undefined} className="wish-name" onChange={(v) => set(g, { name: v })} />
                  </td>
                  <td>
                    <NumCell value={g.target} label="Target" r={r} c={1} onChange={(v) => set(g, { target: v === null ? null : Math.abs(v) })} />
                  </td>
                  <td>
                    <input className={'cell tnum' + (g.by ? '' : ' unset')} type="month" aria-label="Reach it by" min={today.slice(0, 7)} value={g.by} onChange={(e) => set(g, { by: e.target.value })} onKeyDown={cellKeys} />
                  </td>
                  <td>
                    <select className="cell pick tone-neutral" aria-label="Kept in" value={g.account} onChange={(e) => set(g, { account: e.target.value })} onKeyDown={cellKeys}>
                      <option value="">Somewhere else</option>
                      {accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {g.account ? (
                      <span className="txt r">
                        <Calc v={row?.have ?? 0} title="What’s in the account now, from what’s done" />
                      </span>
                    ) : (
                      <NumCell value={ghost ? null : g.saved} label="Set aside so far" r={r} c={4} onChange={(v) => set(g, { saved: Math.abs(v ?? 0) })} />
                    )}
                  </td>
                  <td>{row && <Progress row={row} />}</td>
                  <td className="fits">{row && <Reach row={row} lastKey={lastKey} today={today} />}</td>
                  <td className="fits r tnum">{row?.perMonth ? fmtMoney(row.perMonth) : ''}</td>
                  <td className="c">
                    {!ghost && (
                      <button className="icon-btn row-x" title={`Remove ${g.name || 'this goal'}`} aria-label={`Remove ${g.name || 'this goal'}`} onClick={() => onChange({ ...money, goals: list.filter((x) => x.id !== g.id) })}>
                        <i className="ph-duotone ph-x" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {pots.map((row) => (
              <tr key={row.goal.id} className="pot-goal">
                <td className="txt" title="The account’s own goal: change it in the account, in Overview">
                  <span className="wish-name">{row.goal.name}</span> <span className="chip chip-muted">Pot</span>
                </td>
                <td className="txt r tnum">{fmtMoney(row.goal.target!)}</td>
                <td className="txt tnum">{row.goal.by ? monthName(row.goal.by) : ''}</td>
                <td className="txt">{row.goal.name}</td>
                <td className="txt r">
                  <Calc v={row.have} title="What’s in the account now, from what’s done" />
                </td>
                <td>
                  <Progress row={row} />
                </td>
                <td className="fits">
                  <Reach row={row} lastKey={lastKey} today={today} />
                </td>
                <td className="fits r tnum">{row.perMonth ? fmtMoney(row.perMonth) : ''}</td>
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Progress({ row }: { row: GoalRow }) {
  const pct = Math.min(100, Math.max(0, (row.have / row.goal.target!) * 100));
  return (
    <span className="goal-progress" title={`${fmtMoney(row.have)} of ${fmtMoney(row.goal.target!)}`}>
      <span className="acct-bar" role="img" aria-label={`${Math.round(pct)}% of the goal`}>
        <span style={{ width: `${pct}%` }} />
      </span>
      <span className="meta tnum">{row.left ? `${fmtMoney(row.left)} to go` : 'There'}</span>
    </span>
  );
}

function Reach({ row, lastKey, today }: { row: GoalRow; lastKey: string; today: string }) {
  if (row.how === 'done') return <span className="ok">Reached</span>;
  if (!row.reachOn)
    return (
      <span className="neg" title={`The forecast doesn’t have the ${fmtMoney(row.left)} still needed to spare through ${monthName(lastKey)}`}>
        Not by {monthName(lastKey, true)}
      </span>
    );
  const when = shortDate(row.reachOn).replace(/^\w+ /, '');
  const title =
    row.how === 'planned'
      ? 'With the moves into the account that are planned'
      : `From then on, your day-to-day forecast could spare the ${fmtMoney(row.left)} still needed and stay above $0`;
  return (
    <span className={row.late ? 'neg' : undefined} title={row.late ? `${title}. That’s after ${monthName(row.goal.by)}` : title}>
      {row.how === 'planned' ? `${when}, as planned` : row.reachOn === today ? 'Now' : `From ${when}`}
    </span>
  );
}
