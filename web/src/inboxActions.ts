// What the Inbox view's actions make: a task from a digest item or an email, and a Money
// entry from a bill suggestion. Kept free of React so they can be unit tested.
import { findDay, parseYmd } from '../../shared/dates';
import { fmtMoney, mainAccount, sortEntries } from '../../shared/money';
import type { BillSuggestion, InboxEmail, InboxItem, Money, MoneyEntry } from '../../shared/types';
import { fmtDay } from './util';

export const gmailUrl = (account: string | undefined, threadId: string) => `https://mail.google.com/mail/u/${encodeURIComponent(account || '0')}/#all/${threadId}`;

/** A digest item or a single email → a task: its headline or subject, any deadline, and links back to the emails. */
export function emailTask(source: { item: InboxItem; emails: InboxEmail[] } | { email: InboxEmail }, account: string | undefined, today: Date): { title: string; due: string | null; notes: string } {
  if ('email' in source) {
    const e = source.email;
    return { title: e.subject.slice(0, 200), due: null, notes: `From ${e.from}\n${gmailUrl(account, e.threadId)}` };
  }
  const { item, emails } = source;
  const threads = [...new Set(emails.map((e) => e.threadId))];
  const links = threads.map((t) => gmailUrl(account, t)).join('\n');
  return {
    title: item.headline.slice(0, 200),
    due: item.due ? findDay(item.due, today) : null,
    notes: [item.summary, item.due ? `Deadline: ${item.due}` : '', links].filter(Boolean).join('\n\n'),
  };
}

const amountText = (b: BillSuggestion) => (b.currency === 'SGD' ? fmtMoney(b.amount) : `${b.currency} ${b.amount.toFixed(2)}`);

/** "Add $45.20 to Money: SP Group bill, due Fri 20 Nov, Bills" */
export function billLine(b: BillSuggestion): string {
  const when = b.status === 'due' ? (b.noDate ? 'no due date given' : `due ${fmtDay(parseYmd(b.date))}`) : `paid ${fmtDay(parseYmd(b.date))}`;
  return `Add ${amountText(b)} to Money: ${b.payee}${b.status === 'due' ? ' bill' : ''}, ${when}${b.category ? `, ${b.category}` : ''}`;
}

/** Keep: planned money out on the due date for a bill, done on the day it was paid for a receipt. */
export function billEntry(b: BillSuggestion, money: Money, id: string): MoneyEntry {
  return {
    id,
    date: b.date,
    kind: 'out',
    amount: b.amount,
    note: `${b.payee}${b.status === 'due' ? ' bill' : ''}${b.currency === 'SGD' ? '' : ` (${b.currency} ${b.amount.toFixed(2)})`}`,
    category: b.category,
    planned: b.status === 'due',
    account: mainAccount(money.accounts),
    to: '',
  };
}

export const withBill = (money: Money, b: BillSuggestion, id: string): Money => ({ ...money, entries: sortEntries([...money.entries, billEntry(b, money, id)]) });

/** The emails a digest item still shows: the ones not archived from here. */
export const liveEmails = (item: InboxItem, byId: Map<string, InboxEmail>) => item.emails.flatMap((id) => byId.get(id) ?? []).filter((e) => !e.archived);
