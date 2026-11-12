// Subscriptions in the money tracker. A subscription is a repeating money-out entry:
// the entries added together on repeat share a `series`, and marking that series
// keeps a small record of how often it charges and whether to reconsider it. Name,
// amount, account and dates all come from the entries. Repeats added before series
// existed are found by note, account and a regular spacing, and get linked when marked.
import { dayDiff, parseYmd } from './dates';
import { addMonths, MAX_ENTRIES, repeatDates, sortEntries } from './money';
import type { Every, Money, MoneyEntry, Subscription } from './types';

export const EVERY_NAMES: Record<Every, string> = { week: 'Every week', fortnight: 'Every 2 weeks', month: 'Every month' };
const PER_YEAR: Record<Every, number> = { week: 52, fortnight: 26, month: 12 };

const cents = (n: number) => Math.round(n * 100) / 100;
/** What one charge comes to over a month or a year. */
export const perMonth = (amount: number, every: Every) => cents((amount * PER_YEAR[every]) / 12);
export const perYear = (amount: number, every: Every) => cents(amount * PER_YEAR[every]);

/** Names that are usually subscriptions, for the nudge on repeats that aren't marked yet. */
const LOOKS_LIKE =
  /netflix|spotify|icloud|apple (one|music|tv)|youtube|disney|prime video|amazon prime|hbo|viu|crunchyroll|chatgpt|openai|claude|anthropic|adobe|microsoft|office 365|xbox|playstation|ps plus|nintendo|google one|dropbox|notion|figma|github|canva|duolingo|audible|kindle|patreon|1password|bitwarden|nordvpn|vpn|hevy|strava|gym|membership|subscription|\bsub\b|plan\b|mobile|singtel|starhub|m1\b|circles|gomo|giga|broadband|fibre|fiber/i;
export const looksLikeSub = (note: string) => LOOKS_LIKE.test(note);

/** How far apart some dates are, when they're evenly weekly, fortnightly or monthly (give or take a couple of days). */
export function everyOf(dates: string[]): Every | null {
  if (dates.length < 2) return null;
  const gaps = dates.slice(1).map((d, i) => ({ days: dayDiff(parseYmd(dates[i]), parseYmd(d)), months: (Number(d.slice(0, 4)) - Number(dates[i].slice(0, 4))) * 12 + Number(d.slice(5, 7)) - Number(dates[i].slice(5, 7)) }));
  if (gaps.every((g) => g.days >= 6 && g.days <= 8)) return 'week';
  if (gaps.every((g) => g.days >= 13 && g.days <= 15)) return 'fortnight';
  if (gaps.every((g) => g.months === 1 && g.days >= 26 && g.days <= 35)) return 'month';
  return null;
}

export interface Series {
  /** The entries' `series`; for repeats from before there were series, a made-up key until they're marked. */
  id: string;
  /** Its entries share a `series` already. */
  linked: boolean;
  /** Oldest first. */
  entries: MoneyEntry[];
  every: Every | null;
}

/** Repeating money out: entries added on repeat, and older evenly spaced ones with the same note and account. */
export function seriesList(money: Money): Series[] {
  const linked = new Map<string, MoneyEntry[]>();
  const loose = new Map<string, MoneyEntry[]>();
  for (const e of sortEntries(money.entries)) {
    if (e.kind !== 'out' || e.invoice) continue;
    if (e.series) linked.set(e.series, [...(linked.get(e.series) ?? []), e]);
    else if (e.note.trim()) {
      const key = `${e.note.trim().toLowerCase()}|${e.account}`;
      loose.set(key, [...(loose.get(key) ?? []), e]);
    }
  }
  const subs = new Map(money.subs.map((s) => [s.id, s]));
  return [
    ...[...linked].map(([id, entries]) => ({ id, linked: true, entries, every: everyOf(entries.map((e) => e.date)) ?? subs.get(id)?.every ?? null })),
    ...[...loose].map(([key, entries]) => ({ id: `loose:${key}`, linked: false, entries, every: everyOf(entries.map((e) => e.date)) })).filter((s) => s.every),
  ];
}

/** The series an entry belongs to, by entry id; only those that repeat (or are already a subscription). */
export function seriesByEntry(money: Money): Map<string, Series> {
  const subs = new Set(money.subs.map((s) => s.id));
  const out = new Map<string, Series>();
  for (const s of seriesList(money)) if (s.every && (s.entries.length > 1 || subs.has(s.id))) for (const e of s.entries) out.set(e.id, s);
  return out;
}

export interface SubRow {
  sub: Subscription;
  name: string;
  amount: number;
  account: string;
  perMonth: number;
  perYear: number;
  /** The next charge from today on; empty once the planned ones run out. */
  next: string;
  /** The last charge in the tracker. */
  last: string;
  /** YYYY-MM: when it started, as typed, or the first charge here. */
  since: string;
}

/** Each subscription as of today, biggest yearly cost first. */
export function subRows(money: Money, today: string): SubRow[] {
  const bySeries = new Map<string, MoneyEntry[]>();
  for (const e of sortEntries(money.entries)) if (e.series) bySeries.set(e.series, [...(bySeries.get(e.series) ?? []), e]);
  return money.subs
    .flatMap((sub): SubRow[] => {
      const list = bySeries.get(sub.id);
      if (!list?.length) return [];
      const next = list.find((e) => e.date >= today);
      const shown = next ?? list[list.length - 1];
      return [{
        sub,
        name: shown.note || 'Subscription',
        amount: shown.amount,
        account: shown.account,
        perMonth: perMonth(shown.amount, sub.every),
        perYear: perYear(shown.amount, sub.every),
        next: next?.date ?? '',
        last: list[list.length - 1].date,
        since: sub.since && sub.since < list[0].date.slice(0, 7) ? sub.since : list[0].date.slice(0, 7),
      }];
    })
    .sort((a, b) => b.perYear - a.perYear);
}

/** What the subscriptions cost all together, and what the ones marked to reconsider come to. */
export function subTotals(rows: SubRow[]) {
  const sum = (list: SubRow[], f: (r: SubRow) => number) => cents(list.reduce((a, r) => a + f(r), 0));
  const review = rows.filter((r) => r.sub.review);
  return { count: rows.length, perMonth: sum(rows, (r) => r.perMonth), perYear: sum(rows, (r) => r.perYear), review: { count: review.length, perYear: sum(review, (r) => r.perYear) } };
}

/** Repeating money out that isn't a subscription yet: what looks like one first, then the rest. */
export function unmarked(money: Money, today: string): { likely: Series[]; other: Series[] } {
  const subs = new Set(money.subs.map((s) => s.id));
  const live = seriesList(money).filter((s) => !subs.has(s.id) && s.every && s.entries.length > 1 && s.entries[s.entries.length - 1].date >= addMonths(today.slice(0, 7), -2));
  const name = (s: Series) => s.entries[s.entries.length - 1].note;
  return { likely: live.filter((s) => looksLikeSub(name(s))), other: live.filter((s) => !looksLikeSub(name(s))) };
}

/** Marks a series as a subscription; repeats from before series get `id` as theirs. */
export function markSub(money: Money, s: Series, id: string): Money {
  const series = s.linked ? s.id : id;
  const ids = new Set(s.entries.map((e) => e.id));
  if (money.subs.some((x) => x.id === series) || !s.every) return money;
  return {
    ...money,
    entries: s.linked ? money.entries : money.entries.map((e) => (ids.has(e.id) ? { ...e, series } : e)),
    subs: [...money.subs, { id: series, every: s.every, review: false, since: '' }],
  };
}

export const patchSub = (money: Money, id: string, p: Partial<Subscription>): Money => ({ ...money, subs: money.subs.map((s) => (s.id === id ? { ...s, ...p } : s)) });

/** No longer a subscription; its entries stay as they are. */
export const unmarkSub = (money: Money, id: string): Money => ({ ...money, subs: money.subs.filter((s) => s.id !== id) });

/** Cancelled: the planned charges after today go, the ones that happened stay, and it's no longer listed. */
export const cancelSub = (money: Money, id: string, today: string): Money => ({
  ...unmarkSub(money, id),
  entries: money.entries.filter((e) => !(e.series === id && e.planned && e.date > today)),
});

/** Plans `months` more months of charges after the last one, like it. */
export function extendSub(money: Money, id: string, months: number, newId: () => string): Money {
  const sub = money.subs.find((s) => s.id === id);
  const list = sortEntries(money.entries.filter((e) => e.series === id));
  const last = list[list.length - 1];
  if (!sub || !last) return money;
  const dates = repeatDates(list.length > 1 && sub.every === 'month' ? list[0].date : last.date, sub.every, addMonths(last.date.slice(0, 7), months)).filter((d) => d > last.date);
  const add = dates.slice(0, Math.max(0, MAX_ENTRIES - money.entries.length)).map((date): MoneyEntry => ({ ...last, id: newId(), date, planned: true }));
  return { ...money, entries: sortEntries([...money.entries, ...add]) };
}
