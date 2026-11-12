import { useState } from 'react';
import { CATEGORIES, fmtMoney, mainAccount, parseMoney } from '../../../../shared/money';
import type { Money, MoneyCategory, MoneyEntry } from '../../../../shared/types';
import { localGet } from '../../api';
import { fmtDay, parseYmd } from '../../util';

export type Notify = (msg: string, action?: { label: string; run: () => void }) => void;
/** Enter and ↑/↓ move between rows of the same column, like a spreadsheet; Esc leaves the cell. */
export function cellKeys(e: React.KeyboardEvent<HTMLElement>) {
  const el = e.currentTarget;
  if (e.key === 'Escape') {
    e.stopPropagation();
    el.blur();
    return;
  }
  const step = e.key === 'ArrowDown' || (e.key === 'Enter' && !e.shiftKey) ? 1 : e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey) ? -1 : 0;
  if (!step || el.tagName === 'SELECT' || !el.dataset.r) return;
  const grid = el.closest('[data-grid]');
  const next = grid?.querySelector<HTMLInputElement>(`[data-r="${Number(el.dataset.r) + step}"][data-c="${el.dataset.c}"]`);
  e.preventDefault();
  if (next) {
    next.focus();
    requestAnimationFrame(() => next.select?.());
  } else if (e.key === 'Enter') el.blur();
}

/** An amount: shows "$1,200" and edits as "1200". Balances recalculate as you type. */
export function NumCell({ value, onChange, label, r, c, className = '' }: {
  value: number | null;
  onChange: (v: number | null) => void;
  label: string;
  r?: number;
  c?: number;
  className?: string;
}) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseMoney(text) === undefined;
  return (
    <input
      className={'cell num tnum ' + className + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      aria-invalid={bad || undefined}
      title={bad ? 'Type an amount, like 120 or 45.50' : undefined}
      data-r={r}
      data-c={c}
      value={text ?? (value === null ? '' : fmtMoney(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
      onKeyDown={cellKeys}
    />
  );
}

export function TextCell({ value, onChange, label, r, c, max, placeholder, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  r?: number;
  c?: number;
  max: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      className={'cell ' + className}
      autoComplete="off"
      aria-label={label}
      title={value.length > 18 ? value : undefined}
      data-r={r}
      data-c={c}
      value={value}
      maxLength={max}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={cellKeys}
    />
  );
}

/** A date that only commits when you leave the cell, so a row doesn't re-sort while you type. */
export function DateCell({ value, onChange, label, r, c }: { value: string; onChange: (v: string) => void; label: string; r?: number; c?: number }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft && draft !== value) onChange(draft);
    setDraft(null);
  };
  return (
    <input
      type="date"
      className="cell date tnum"
      aria-label={label}
      data-r={r}
      data-c={c}
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        cellKeys(e);
      }}
    />
  );
}

export function CategoryCell({ value, onChange, label, className = '', empty = '–' }: {
  value: MoneyCategory | '';
  onChange: (v: MoneyCategory | '') => void;
  label: string;
  className?: string;
  /** What "no category" shows as. */
  empty?: string;
}) {
  return (
    <select className={'cell pick ' + className + (value ? ' tone-neutral' : '')} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as MoneyCategory | '')} onKeyDown={cellKeys}>
      <option value="">{empty}</option>
      {CATEGORIES.map((x) => (
        <option key={x}>{x}</option>
      ))}
    </select>
  );
}

/** A worked-out value: not editable, and negative ones in the warning colour. */
export function Calc({ v, sign, title, strong }: { v: number; sign?: boolean; title: string; strong?: boolean }) {
  return (
    <span className={'calc tnum' + (v < 0 ? ' neg' : '') + (strong ? ' strong' : '')} title={title}>
      {fmtMoney(v, sign)}
    </span>
  );
}

export const shortDate = (d: string) => fmtDay(parseYmd(d));
export type Kind = MoneyEntry['kind'];
export const signed = (e: MoneyEntry) => (e.kind === 'in' ? e.amount : e.kind === 'out' ? -e.amount : 0);

/** Account names by id. */
export const namesOf = (money: Money) => new Map(money.accounts.map((a) => [a.id, a.name]));

/** What an entry is called in a list: its note, or for a move where it went. */
export const entryTitle = (e: MoneyEntry, names: Map<string, string>) => (e.kind === 'move' ? `${names.get(e.account) ?? '?'} → ${names.get(e.to) ?? '?'}` : e.note || 'No note');

/** The account the last entry went into, if it's still in use. */
export function lastAccount(money: Money): string {
  const id = localGet('moneyAccount');
  return money.accounts.some((a) => a.id === id && !a.archived) ? id! : mainAccount(money.accounts);
}

/** Another account in use, for the other end of a move. */
export const otherAccount = (money: Money, id: string) => (money.accounts.find((a) => a.id !== id && !a.archived) ?? money.accounts.find((a) => a.id !== id))?.id ?? '';
export function KindSwitch({ kind, label, onChange }: { kind: Kind; label: string; onChange: (k: Kind) => void }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {(['out', 'in', 'move'] as const).map((k) => (
        <button key={k} type="button" className={kind === k ? 'on' : undefined} aria-pressed={kind === k} title={k === 'move' ? 'Move money from one account to another' : undefined} onClick={() => onChange(k)}>
          {k === 'out' ? 'Out' : k === 'in' ? 'In' : 'Move'}
        </button>
      ))}
    </div>
  );
}

/** Picks one of the accounts in use (or the one already picked, if it's archived). `bare` drops the cell look, for forms. */
export function AccountSelect({ money, value, label, id, bare, className = '', onChange }: {
  money: Money;
  value: string;
  label: string;
  id?: string;
  bare?: boolean;
  className?: string;
  onChange: (id: string) => void;
}) {
  return (
    <select id={id} className={(bare ? '' : 'cell pick tone-neutral ') + className} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={bare ? undefined : cellKeys}>
      {money.accounts
        .filter((a) => !a.archived || a.id === value)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
    </select>
  );
}

/** An amount in a form field: shows "$1,200" and edits as "1200". */
export function AmountInput({ id, value, onChange }: { id: string; value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState<string | null>(null);
  const bad = text !== null && parseMoney(text) === undefined;
  return (
    <input
      id={id}
      className={'input tnum' + (bad ? ' bad' : '')}
      inputMode="decimal"
      autoComplete="off"
      placeholder="$0"
      aria-invalid={bad || undefined}
      value={text ?? (value === null ? '' : fmtMoney(value))}
      onFocus={() => setText(value === null ? '' : String(value))}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseMoney(e.target.value);
        if (v !== undefined) onChange(v);
      }}
      onBlur={() => setText(null)}
    />
  );
}
