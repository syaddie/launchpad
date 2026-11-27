import { describe, expect, it } from 'vitest';
import { landedDay, periodStep, readoutCells, rollDirection, unseen, viewStep } from '../web/src/motion';

describe('periodStep', () => {
  it('goes next to a later period and prev to an earlier one', () => {
    expect(periodStep('2026-11', '2026-12')).toBe('next');
    expect(periodStep('2026-11', '2025-12')).toBe('prev');
    expect(periodStep(2026, 2025)).toBe('prev');
    expect(periodStep(-1, 0)).toBe('next');
    expect(periodStep(-2, -10)).toBe('prev');
  });

  it('is no change to the same period', () => {
    expect(periodStep('2026-11', '2026-11')).toBeNull();
    expect(periodStep(0, 0)).toBeNull();
  });
});

describe('viewStep', () => {
  it('goes next along the rail and back toward Home', () => {
    expect(viewStep('home', 'money')).toBe('next');
    expect(viewStep('money', 'digest')).toBe('prev');
    expect(viewStep('review', 'music')).toBe('next');
    expect(viewStep('music', 'home')).toBe('prev');
  });

  it('stays put on the same view', () => {
    expect(viewStep('learn', 'learn')).toBe('none');
  });
});

describe('readoutCells', () => {
  it('marks digits, and what was in their place before', () => {
    const cells = readoutCells('10:05', '09:59');
    expect(cells.map((c) => c.char).join('')).toBe('10:05');
    expect(cells.map((c) => c.digit)).toEqual([true, true, false, true, true]);
    expect(cells.map((c) => c.from)).toEqual(['0', '9', null, '5', '9']);
  });

  it('keys each character by its place from the right, so the units stay put when a figure grows', () => {
    const before = readoutCells('9 min');
    const after = readoutCells('10 min', '9 min');
    expect(before.at(-1)!.key).toBe(after.at(-1)!.key);
    // The 9's place now holds the 0; the new 1 had no digit before it.
    expect(after[1]).toMatchObject({ char: '0', from: '9' });
    expect(after[0]).toMatchObject({ char: '1', from: null });
  });

  it('has nothing to roll from the first time a figure is shown', () => {
    expect(readoutCells('$1,240').every((c) => c.from === undefined)).toBe(true);
  });

  it('keeps digits and other characters apart even in the same place', () => {
    const cells = readoutCells('1.5', '15');
    expect(cells[1]).toMatchObject({ char: '.', digit: false });
    // The point takes the place the 1 was in, under a key of its own, so the 1 doesn't roll into a point.
    expect(cells[1].key).not.toBe(readoutCells('15')[0].key);
  });
});

describe('rollDirection', () => {
  it('rolls up as a figure grows and down as it shrinks', () => {
    expect(rollDirection('13:00', '12:59')).toBe('up');
    expect(rollDirection('4 days', '5 days')).toBe('down');
    expect(rollDirection('$1,250.00', '$1,240.50')).toBe('up');
  });

  it('counts a minus sign', () => {
    expect(rollDirection('−$20', '$5')).toBe('down');
    expect(rollDirection('-3', '-8')).toBe('up');
  });

  it('rolls up the first time, or when there is no number to compare', () => {
    expect(rollDirection('7', undefined)).toBe('up');
    expect(rollDirection('Today', 'Yesterday')).toBe('up');
  });
});

describe('unseen', () => {
  it('is what was not in the last record', () => {
    expect(unseen(['Bench|90', 'Squat|105'], JSON.stringify(['Bench|90']))).toEqual(['Squat|105']);
    expect(unseen(['Bench|92.5'], JSON.stringify(['Bench|90', 'Squat|105']))).toEqual(['Bench|92.5']);
    expect(unseen([], JSON.stringify(['Bench|90']))).toEqual([]);
  });

  it('is nothing without a record, or with one that cannot be read', () => {
    expect(unseen(['Bench|90'], null)).toEqual([]);
    expect(unseen(['Bench|90'], 'not json')).toEqual([]);
    expect(unseen(['Bench|90'], '{"a":1}')).toEqual([]);
  });

  it('is everything new against an empty record', () => {
    expect(unseen(['Bench|90', 'Squat|105'], '[]')).toEqual(['Bench|90', 'Squat|105']);
  });
});

describe('landedDay', () => {
  const before = { '2026-11-26': 73.4, '2026-11-27': 73.1 };

  it('is the day added or changed', () => {
    expect(landedDay(before, { ...before, '2026-11-28': 72.9 })).toBe('2026-11-28');
    expect(landedDay(before, { ...before, '2026-11-27': 73.0 })).toBe('2026-11-27');
    expect(landedDay(before, { '2026-11-20': 74, ...before })).toBe('2026-11-20');
  });

  it('is nothing for a removal or the same weights saved back', () => {
    expect(landedDay(before, { '2026-11-26': 73.4 })).toBeNull();
    expect(landedDay(before, { ...before })).toBeNull();
  });

  it('is nothing when several days changed at once', () => {
    expect(landedDay(before, { ...before, '2026-11-28': 72.9, '2026-11-29': 72.8 })).toBeNull();
    expect(landedDay({}, before)).toBeNull();
  });
});
