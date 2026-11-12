import { describe, expect, it } from 'vitest';
import { cleanMoney, starterAccounts } from '../shared/money';
import { cancelSub, everyOf, extendSub, looksLikeSub, markSub, patchSub, perMonth, perYear, seriesByEntry, seriesList, subRows, subTotals, unmarked, unmarkSub } from '../shared/subscriptions';
import type { Money, MoneyEntry } from '../shared/types';

const today = '2026-11-12';
let seq = 0;
const out = (date: string, note: string, amount: number, extra: Partial<MoneyEntry> = {}): MoneyEntry => ({
  id: `e${seq++}`, date, kind: 'out', amount, note, category: '', planned: date > today, account: 'posb', to: '', ...extra,
});
const money = (entries: MoneyEntry[], subs: Money['subs'] = []): Money => ({ start: '2026-09-01', accounts: starterAccounts(500), entries, wishlist: [], invoices: [], subs, goals: [] });

describe('repeats', () => {
  it('tells weekly, fortnightly and monthly spacing apart, give or take a day or two', () => {
    expect(everyOf(['2026-10-01', '2026-10-08', '2026-10-14'])).toBe('week');
    expect(everyOf(['2026-10-01', '2026-10-15', '2026-10-29'])).toBe('fortnight');
    expect(everyOf(['2026-10-31', '2026-11-30', '2026-12-31', '2027-01-29'])).toBe('month');
    expect(everyOf(['2026-10-01', '2026-10-03'])).toBeNull();
    expect(everyOf(['2026-10-01', '2026-12-01'])).toBeNull();
    expect(everyOf(['2026-10-01'])).toBeNull();
  });
  it('finds series by their link, and older repeats by note, account and spacing', () => {
    const m = money([
      out('2026-10-03', 'Netflix', 17.98),
      out('2026-11-03', 'netflix ', 19.98),
      out('2026-12-03', 'Netflix', 19.98),
      out('2026-10-05', 'Lunch', 8),
      out('2026-10-06', 'Lunch', 9),
      out('2026-11-01', 'Gym', 80, { series: 's1' }),
      out('2026-12-01', 'Gym (new price)', 85, { series: 's1' }),
      out('2026-11-04', 'Netflix', 19.98, { account: 'trust' }),
    ]);
    const list = seriesList(m);
    expect(list.map((s) => [s.id, s.linked, s.every, s.entries.length])).toEqual([
      ['s1', true, 'month', 2],
      ['loose:netflix|posb', false, 'month', 3],
    ]);
    const by = seriesByEntry(m);
    expect(by.get(m.entries[1].id)?.id).toBe('loose:netflix|posb');
    expect(by.has(m.entries[3].id)).toBe(false);
  });
  it('nudges about what looks like a subscription', () => {
    expect(['Spotify Family', 'iCloud+ 200GB', 'Singtel mobile plan', 'ChatGPT Plus'].every(looksLikeSub)).toBe(true);
    expect(['Rent', 'Lunch', 'Allowance to mum'].some(looksLikeSub)).toBe(false);
    const m = money([out('2026-10-03', 'Spotify', 11.98), out('2026-11-03', 'Spotify', 11.98), out('2026-10-01', 'Rent', 900), out('2026-11-01', 'Rent', 900), out('2026-01-01', 'Old', 5), out('2026-02-01', 'Old', 5)]);
    const u = unmarked(m, today);
    expect(u.likely.map((s) => s.entries[0].note)).toEqual(['Spotify']);
    // Old repeats that stopped months ago aren't offered.
    expect(u.other.map((s) => s.entries[0].note)).toEqual(['Rent']);
  });
});

describe('subscriptions', () => {
  const netflix = () => money([out('2026-10-03', 'Netflix', 19.98), out('2026-11-03', 'Netflix', 19.98), out('2026-12-03', 'Netflix', 19.98), out('2027-01-03', 'Netflix', 19.98)]);

  it('marks an older repeat, linking its entries', () => {
    const m = netflix();
    const s = unmarked(m, today).likely[0];
    const marked = markSub(m, s, 'sub1');
    expect(marked.entries.every((e) => e.series === 'sub1')).toBe(true);
    expect(marked.subs).toEqual([{ id: 'sub1', every: 'month', review: false, since: '' }]);
    expect(unmarked(marked, today).likely).toEqual([]);
    expect(markSub(marked, seriesList(marked)[0], 'again')).toBe(marked);
    // It survives cleaning, as the server stores it.
    expect(cleanMoney(marked).subs).toEqual(marked.subs);
  });
  it('works out the cost a month and a year, the next charge and since when', () => {
    const n = netflix();
    const m = markSub(n, unmarked(n, today).likely[0], 'sub1');
    const weekly = money([out('2026-11-10', 'Hevy', 3, { series: 'w' }), out('2026-11-17', 'Hevy', 3, { series: 'w' })], [{ id: 'w', every: 'week', review: true, since: '' }]);
    const both: Money = { ...m, entries: [...m.entries, ...weekly.entries], subs: [...m.subs, { ...weekly.subs[0] }] };
    const rows = subRows(patchSub(both, 'sub1', { since: '2024-05' }), today);
    expect(rows.map((r) => [r.name, r.amount, r.perMonth, r.perYear, r.next, r.last, r.since, r.account])).toEqual([
      ['Netflix', 19.98, 19.98, 239.76, '2026-12-03', '2027-01-03', '2024-05', 'posb'],
      ['Hevy', 3, 13, 156, '2026-11-17', '2026-11-17', '2026-11', 'posb'],
    ]);
    expect(subTotals(rows)).toEqual({ count: 2, perMonth: 32.98, perYear: 395.76, review: { count: 1, perYear: 156 } });
    expect([perMonth(10, 'fortnight'), perYear(10, 'fortnight')]).toEqual([21.67, 260]);
  });
  it('shows no next charge once the planned ones run out, and plans more like the last', () => {
    const m = money([out('2026-08-31', 'iCloud', 4.48, { series: 'c' }), out('2026-09-30', 'iCloud', 4.48, { series: 'c', category: 'Bills' }), out('2026-10-31', 'iCloud', 4.48, { series: 'c', category: 'Bills' })], [{ id: 'c', every: 'month', review: false, since: '' }]);
    expect(subRows(m, today)[0]).toMatchObject({ next: '', last: '2026-10-31' });
    let n = 0;
    const more = extendSub(m, 'c', 3, () => `x${n++}`);
    const added = more.entries.filter((e) => e.id.startsWith('x'));
    // Monthly keeps the first charge's day, or the month's last.
    expect(added.map((e) => [e.date, e.planned, e.series, e.category])).toEqual([
      ['2026-11-30', true, 'c', 'Bills'],
      ['2026-12-31', true, 'c', 'Bills'],
      ['2027-01-31', true, 'c', 'Bills'],
    ]);
    expect(subRows(more, today)[0].next).toBe('2026-11-30');
  });
  it('cancels: planned charges ahead go, what happened stays', () => {
    const n = netflix();
    const m = markSub(n, unmarked(n, today).likely[0], 'sub1');
    const c = cancelSub(m, 'sub1', today);
    expect(c.subs).toEqual([]);
    expect(c.entries.map((e) => e.date)).toEqual(['2026-10-03', '2026-11-03']);
    const u = unmarkSub(m, 'sub1');
    expect([u.subs.length, u.entries.length]).toEqual([0, 4]);
  });
});
