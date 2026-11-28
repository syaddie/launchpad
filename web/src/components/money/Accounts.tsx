import { type CSSProperties, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ACCOUNT_KINDS, accountBalance, addMonths, daysIn, fmtMoney, goalPerMonth, MAX_ACCOUNTS, monthName } from '../../../../shared/money';
import type { Money, MoneyAccount } from '../../../../shared/types';
import { Readout, useSeenOnScreen, useUnseen } from '../Motion';
import { AccountDrawer, MoveDrawer } from './AccountDrawers';
import { entryTitle, namesOf, shortDate } from './shared';

/** Colours for each account's share of the total, in account order. */
const SHARE = ['var(--acd)', '#c9a77a', 'var(--ac)', '#6f8fae', '#a7869e', '#b9b2a8'];

type AccountRow = { a: MoneyAccount; now: number; end: number; change: number; color: string };

const lastDay = (key: string) => `${key}-${String(daysIn(key)).padStart(2, '0')}`;
export const monthYear = (key: string) => `${monthName(key, true)} ${key.slice(0, 4)}`;
export const isZero = (n: number) => Math.abs(n) < 0.005;

/** A move made just now that changes today's balances: from one account to another. */
type Orbit = { from: string; to: string; n: number };

/** How long a move's light is in the air and the cards answer it: past the landing's flare. */
const ORBIT_MS = 2200;

/**
 * Mission's transfer orbit (mission.css, MONEY › ACCOUNTS): a point of light leaves the account the money came from and
 * travels on an arc to the one it went to, over a faint trace, then both balances roll. Drawn over the cards (the grid
 * is positioned), in the grid's own units, so a grid drawn scaled (Vista's views come in scaled) puts it in the same
 * place. Hidden in the other layouts, where the balances just roll. Nothing is drawn when a card isn't on screen (an
 * archived account, hidden).
 */
function TransferOrbit({ grid, orbit }: { grid: RefObject<HTMLDivElement | null>; orbit: Orbit | null }) {
  const [d, setD] = useState<string | null>(null);
  useLayoutEffect(() => {
    const g = grid.current;
    const card = (id: string) => g?.querySelector<HTMLElement>(`[data-acct="${CSS.escape(id)}"] .acct-bal`);
    const a = orbit && card(orbit.from);
    const b = orbit && card(orbit.to);
    if (!g || !a || !b) return setD(null);
    const box = g.getBoundingClientRect();
    const k = box.width / g.offsetWidth || 1;
    const at = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return { x: (r.left + Math.min(r.width, 60) / 2 - box.left) / k, y: (r.top + r.height / 2 - box.top) / k };
    };
    const p = at(a);
    const q = at(b);
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    // Bulging away from the line between them: upward where they're side by side, outward where they're stacked.
    let nx = -(q.y - p.y) / len;
    let ny = (q.x - p.x) / len;
    if (ny > 0 || (Math.abs(ny) < 0.2 && nx < 0)) (nx = -nx), (ny = -ny);
    const lift = Math.max(36, len * 0.42);
    const c = { x: (p.x + q.x) / 2 + nx * lift, y: (p.y + q.y) / 2 + ny * lift };
    const r = (v: number) => Math.round(v * 10) / 10;
    setD(`M${r(p.x)} ${r(p.y)} Q${r(c.x)} ${r(c.y)} ${r(q.x)} ${r(q.y)}`);
  }, [grid, orbit]);
  if (!orbit || !d) return null;
  return (
    <span key={orbit.n} className="acct-orbit" aria-hidden="true">
      <svg>
        <path className="acct-orbit-trace" d={d} />
      </svg>
      <i className="acct-orbit-dot" style={{ offsetPath: `path('${d}')` }} />
    </span>
  );
}

/** Where the money is today: each account, the total and how it splits, and the latest moves between them. */
export function AccountsPanel({ money, today, onChange }: { money: Money; today: string; onChange: (m: Money) => void }) {
  const [open, setOpen] = useState<{ kind: 'account'; id: string | null } | { kind: 'move' } | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [orbit, setOrbit] = useState<Orbit | null>(null);
  useEffect(() => {
    if (!orbit) return;
    const t = window.setTimeout(() => setOrbit(null), ORBIT_MS);
    return () => window.clearTimeout(t);
  }, [orbit]);
  const month = today.slice(0, 7);
  const prevEnd = lastDay(addMonths(month, -1));
  const names = namesOf(money);

  // Esc closes the drawer. Caught first, so the page's own Esc (back to Home) doesn't also run.
  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(null);
    };
    window.addEventListener('keydown', close, true);
    return () => window.removeEventListener('keydown', close, true);
  }, [open]);

  const rows: AccountRow[] = money.accounts.map((a, i) => {
    const now = accountBalance(money, a.id, today, true);
    return { a, now, end: accountBalance(money, a.id, lastDay(month)), change: now - accountBalance(money, a.id, prevEnd, true), color: SHARE[i % SHARE.length] };
  });
  const archived = rows.filter((r) => r.a.archived);
  const sum = (list: AccountRow[]) => list.reduce((s, r) => s + r.now, 0);
  const groups = [
    { name: 'Day to day', amount: sum(rows.filter((r) => r.a.spendable)) },
    { name: 'Set aside', amount: sum(rows.filter((r) => !r.a.spendable && r.a.kind !== 'invest')) },
    { name: 'Invested', amount: sum(rows.filter((r) => !r.a.spendable && r.a.kind === 'invest')) },
  ].filter((g) => !isZero(g.amount));
  const share = rows.filter((r) => r.now > 0);
  const positive = sum(share);
  const pct = (r: AccountRow) => Math.round((r.now / positive) * 100);
  const moves = money.entries.filter((e) => e.kind === 'move' && e.date <= today).slice(-4).reverse();
  // A pot that has just reached its goal launches its card, once (Mission, mission.css).
  const lifting = useUnseen('moneyPotsReached', rows.filter((r) => !r.a.archived && r.a.goal !== null && r.now >= r.a.goal).map((r) => r.a.id));

  return (
    <section className="panel you-panel accts" aria-label="Accounts">
      <div className="panel-head accts-head">
        <div>
          <h2 className="panel-title">Accounts</h2>
          <span className="meta">Where your money is today, from what’s done · click one to change it</span>
        </div>
        {money.accounts.length > 1 && (
          <button className="btn btn-primary btn-small" onClick={() => setOpen({ kind: 'move' })}>
            <i className="ph-duotone ph-arrows-left-right" />
            Move money
          </button>
        )}
      </div>

      <div className="acct-grid" ref={gridRef}>
        {rows
          .filter((r) => showArchived || !r.a.archived)
          .map((r) => (
            <AccountCard key={r.a.id} row={r} today={today} lift={lifting.has(r.a.id)} orbit={orbit?.from === r.a.id ? 'from' : orbit?.to === r.a.id ? 'to' : undefined} onOpen={() => setOpen({ kind: 'account', id: r.a.id })} />
          ))}
        <TransferOrbit grid={gridRef} orbit={orbit} />
        {money.accounts.length < MAX_ACCOUNTS && (
          <button className="acct-card acct-add" onClick={() => setOpen({ kind: 'account', id: null })}>
            <span className="acct-icon">
              <i className="ph-duotone ph-plus" aria-hidden="true" />
            </span>
            <b>Add account</b>
            <span className="meta">A bank, cash, investments, or a pot for something you’re saving for</span>
          </button>
        )}
      </div>

      <div className="acct-total">
        <div className="acct-total-head">
          <span>
            Total <span className={'serif tnum acct-total-v' + (sum(rows) < 0 ? ' neg' : '')}>{fmtMoney(sum(rows))}</span>
          </span>
          {groups.length > 1 && (
            <span className="acct-groups">
              {groups.map((g) => (
                <span key={g.name}>
                  {g.name} <b className="tnum">{fmtMoney(g.amount)}</b>
                </span>
              ))}
            </span>
          )}
        </div>
        {share.length > 1 && (
          <>
            <div className="acct-share" role="img" aria-label={`Share of the total: ${share.map((r) => `${r.a.name} ${pct(r)}%`).join(', ')}`}>
              {share.map((r) => (
                <span key={r.a.id} style={{ flexGrow: r.now, background: r.color }} />
              ))}
            </div>
            <div className="acct-legend">
              {share.map((r) => (
                <span key={r.a.id}>
                  <span className="acct-swatch" style={{ background: r.color }} />
                  {r.a.name} {pct(r)}%
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      {moves.length > 0 && (
        <div className="acct-moves">
          <h3 className="drawer-label">Latest moves</h3>
          {moves.map((e) => (
            <div key={e.id} className="acct-move">
              <span className="meta tnum">{shortDate(e.date)}</span>
              <span className="acct-move-what">
                {entryTitle(e, names)}
                {e.note && <span className="meta"> · {e.note}</span>}
                {e.planned && <span className="chip chip-muted">Planned</span>}
              </span>
              <span className="tnum">{fmtMoney(e.amount)}</span>
            </div>
          ))}
        </div>
      )}

      {archived.length > 0 && (
        <button className="btn-link meta acct-archived" onClick={() => setShowArchived(!showArchived)}>
          {showArchived ? 'Hide archived accounts' : `Show ${archived.length} archived account${archived.length === 1 ? '' : 's'}`}
        </button>
      )}

      {open?.kind === 'account' && <AccountDrawer money={money} today={today} id={open.id} onChange={onChange} onClose={() => setOpen(null)} />}
      {open?.kind === 'move' && <MoveDrawer money={money} today={today} onChange={onChange} onMoved={(from, to) => setOrbit((o) => ({ from, to, n: (o?.n ?? 0) + 1 }))} onClose={() => setOpen(null)} />}
    </section>
  );
}

/**
 * `orbit`: money just moved from or to this account (Mission's transfer orbit leaves or lands here). `lift`: it has just
 * reached its goal, so its card launches once it's on the screen.
 */
function AccountCard({ row: { a, now, end, change }, today, orbit, lift, onOpen }: { row: AccountRow; today: string; orbit?: 'from' | 'to'; lift?: boolean; onOpen: () => void }) {
  const kind = ACCOUNT_KINDS.find((k) => k.key === a.kind) ?? ACCOUNT_KINDS[0];
  const month = today.slice(0, 7);
  const ref = useRef<HTMLButtonElement>(null);
  const launch = useSeenOnScreen(ref, !!lift);
  const fill = a.goal !== null ? `${Math.min(100, Math.max(0, (now / a.goal) * 100))}%` : '';
  return (
    <button ref={ref} className={'acct-card' + (a.archived ? ' archived' : '')} title={`Change ${a.name}`} data-acct={a.id} data-orbit={orbit} data-liftoff={launch ? '' : undefined} onClick={onOpen}>
      <span className="acct-name">
        <span className="acct-icon">
          <i className={'ph-duotone ' + kind.icon} aria-hidden="true" />
        </span>
        <span className="acct-name-in">
          <b>{a.name}</b>
          <span className="meta">{a.archived ? 'Archived' : a.spendable ? 'Day to day' : kind.name}</span>
        </span>
      </span>
      {/* It rolls when money moves (in Mission, once the transfer's light has landed). */}
      <span className={'serif tnum acct-bal' + (now < 0 ? ' neg' : '')}>
        <Readout text={fmtMoney(now)} id={`acct-${a.id}`} />
      </span>
      {a.goal !== null ? (
        <span className="acct-lines">
          <span className="acct-bar" role="img" aria-label={`${Math.round((Math.max(0, now) / a.goal) * 100)}% of the goal`}>
            <span style={{ width: fill, '--fill': fill } as CSSProperties} />
          </span>
          <span className="meta">
            {fmtMoney(now)} of {fmtMoney(a.goal)}
            {a.goalBy && ` · by ${monthYear(a.goalBy)}`}
          </span>
          <span className={'meta' + (now >= a.goal ? ' acct-up' : '')}>
            {now >= a.goal
              ? 'Goal reached'
              : a.goalBy > month
                ? `About ${fmtMoney(goalPerMonth(now, a.goal, a.goalBy, today))} a month to get there`
                : `${fmtMoney(a.goal - now)} to go`}
          </span>
        </span>
      ) : (
        <span className="acct-lines meta">
          <span className={change > 0 && !isZero(change) ? 'acct-up' : undefined}>{isZero(change) ? 'No change this month' : `${fmtMoney(change, true)} this month`}</span>
          {!isZero(end - now) && (
            <span>
              End of {monthName(month, true)} {fmtMoney(end)}
            </span>
          )}
        </span>
      )}
    </button>
  );
}
