import { describe, expect, it } from 'vitest';
import type { MoneyEntry } from '../shared/types';
import { dayGroups, dayName, dayTitle, scrollFor, stepDay } from '../web/src/components/money/monthList';

const entry = (id: string, date: string): MoneyEntry => ({ id, date, kind: 'out', amount: 10, note: id, category: '', planned: false, account: 'a', to: '' });

describe('the month a day at a time', () => {
  const list = [entry('a', '2026-11-02'), entry('b', '2026-11-02'), entry('c', '2026-11-05'), entry('d', '2026-11-19')];

  it('groups entries by day, in order', () => {
    expect(dayGroups(list).map((d) => [d.date, d.list.map((e) => e.id)])).toEqual([
      ['2026-11-02', ['a', 'b']],
      ['2026-11-05', ['c']],
      ['2026-11-19', ['d']],
    ]);
  });

  it('puts a picked day with nothing on it in its place, empty', () => {
    expect(dayGroups(list, '2026-11-10').map((d) => [d.date, d.list.length])).toEqual([
      ['2026-11-02', 2],
      ['2026-11-05', 1],
      ['2026-11-10', 0],
      ['2026-11-19', 1],
    ]);
  });

  it('puts it first or last when it comes before or after them all', () => {
    expect(dayGroups(list, '2026-11-01')[0]).toEqual({ date: '2026-11-01', list: [] });
    expect(dayGroups(list, '2026-11-30').at(-1)).toEqual({ date: '2026-11-30', list: [] });
  });

  it('adds nothing for a picked day that has entries, or a month with none', () => {
    expect(dayGroups(list, '2026-11-05')).toHaveLength(3);
    expect(dayGroups([])).toEqual([]);
    expect(dayGroups([], '2026-11-12')).toEqual([{ date: '2026-11-12', list: [] }]);
  });
});

describe("what a day's heading says", () => {
  const today = '2026-11-27';

  it('names today, yesterday and tomorrow, with the date in full', () => {
    expect(dayTitle('2026-11-27', today)).toEqual({ rel: 'Today', full: 'Friday 27 November' });
    expect(dayTitle('2026-11-26', today)).toEqual({ rel: 'Yesterday', full: 'Thursday 26 November' });
    expect(dayTitle('2026-11-28', today)).toEqual({ rel: 'Tomorrow', full: 'Saturday 28 November' });
  });

  it('gives any other day just its date', () => {
    expect(dayTitle('2026-11-19', today)).toEqual({ rel: '', full: 'Thursday 19 November' });
    expect(dayTitle('2026-12-01', today)).toEqual({ rel: '', full: 'Tuesday 1 December' });
  });

  it('counts across a month and a year', () => {
    expect(dayTitle('2026-12-01', '2026-11-30').rel).toBe('Tomorrow');
    expect(dayTitle('2026-12-31', '2027-01-01')).toEqual({ rel: 'Yesterday', full: 'Thursday 31 December' });
  });

  it('reads as one phrase', () => {
    expect(dayName('2026-11-27', today)).toBe('Today, Friday 27 November');
    expect(dayName('2026-11-03', today)).toBe('Tuesday 3 November');
  });
});

describe('the arrow keys on the calendar', () => {
  const m = '2026-11';

  it('moves a day either way and a week up or down', () => {
    expect(stepDay('2026-11-19', 'ArrowLeft', m)).toBe('2026-11-18');
    expect(stepDay('2026-11-19', 'ArrowRight', m)).toBe('2026-11-20');
    expect(stepDay('2026-11-19', 'ArrowUp', m)).toBe('2026-11-12');
    expect(stepDay('2026-11-19', 'ArrowDown', m)).toBe('2026-11-26');
  });

  it('goes to the first and last of the month with Home and End', () => {
    expect(stepDay('2026-11-19', 'Home', m)).toBe('2026-11-01');
    expect(stepDay('2026-11-19', 'End', m)).toBe('2026-11-30');
    expect(stepDay('2026-02-10', 'End', '2026-02')).toBe('2026-02-28');
    expect(stepDay('2028-02-10', 'End', '2028-02')).toBe('2028-02-29');
  });

  it('stays in the month at its ends', () => {
    expect(stepDay('2026-11-01', 'ArrowLeft', m)).toBeNull();
    expect(stepDay('2026-11-30', 'ArrowRight', m)).toBeNull();
    expect(stepDay('2026-11-05', 'ArrowUp', m)).toBeNull();
    expect(stepDay('2026-11-25', 'ArrowDown', m)).toBeNull();
  });

  it('ignores other keys', () => {
    expect(stepDay('2026-11-19', 'Enter', m)).toBeNull();
    expect(stepDay('2026-11-19', 'a', m)).toBeNull();
  });
});

describe('scrolling the list to a day or an entry', () => {
  const view = { scrollTop: 1000, height: 400 };

  it('puts a day at the top', () => {
    expect(scrollFor({ top: 2500, height: 120 }, view, 'start')).toBe(2500);
    expect(scrollFor({ top: 30, height: 120 }, view, 'start')).toBe(30);
  });

  it('puts a day under what covers the top (a phone rail)', () => {
    expect(scrollFor({ top: 2500, height: 120 }, view, 'start', 64)).toBe(2436);
    expect(scrollFor({ top: 20, height: 120 }, view, 'start', 64)).toBe(0);
  });

  it('centres an entry in the room under the heading', () => {
    // 360 of room under a 40px heading: a 60px entry sits 150 below the heading.
    expect(scrollFor({ top: 2000, height: 60 }, view, 'center', 40)).toBe(2000 - 40 - 150);
    // Taller than the room: shown from its top.
    expect(scrollFor({ top: 2000, height: 500 }, view, 'center', 40)).toBe(1960);
  });

  it('scrolls the least to bring an entry into view, or not at all', () => {
    // Already in view.
    expect(scrollFor({ top: 1100, height: 60 }, view, 'nearest', 40)).toBe(1000);
    // Above, or under the heading: brought down just under it.
    expect(scrollFor({ top: 900, height: 60 }, view, 'nearest', 40)).toBe(860);
    expect(scrollFor({ top: 1010, height: 60 }, view, 'nearest', 40)).toBe(970);
    // Below: its bottom at the bottom.
    expect(scrollFor({ top: 1500, height: 60 }, view, 'nearest', 40)).toBe(1160);
    // Taller than the room: from its top.
    expect(scrollFor({ top: 1200, height: 380 }, view, 'nearest', 40)).toBe(1160);
  });

  it('never goes above the top of the list', () => {
    expect(scrollFor({ top: 10, height: 60 }, view, 'center', 40)).toBe(0);
    expect(scrollFor({ top: 10, height: 60 }, view, 'nearest', 40)).toBe(0);
  });
});
