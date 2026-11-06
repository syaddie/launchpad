import { describe, expect, it } from 'vitest';
import { deepEqual, merge3, mergeNotes } from '../shared/merge';
import type { Note } from '../shared/types';

const e = (id: string, amount: number, note = '') => ({ id, amount, note });

describe('three-way merge', () => {
  it('takes whichever side changed', () => {
    expect(merge3(1, 1, 2)).toEqual({ value: 2, conflicts: 0 });
    expect(merge3(1, 3, 1)).toEqual({ value: 3, conflicts: 0 });
    expect(merge3({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({ value: { a: 2, b: 3 }, conflicts: 0 });
  });

  it('keeps this device’s value when both changed the same one, and counts it', () => {
    expect(merge3({ a: 1 }, { a: 2 }, { a: 3 })).toEqual({ value: { a: 2 }, conflicts: 1 });
  });

  it('merges lists item by item: both sides’ additions, edits and deletions', () => {
    const base = { entries: [e('1', 10), e('2', 20), e('3', 30)] };
    // This device: edits 1, deletes 3, adds 4. The other: edits 2, adds 5 after 1.
    const mine = { entries: [e('1', 11), e('2', 20), e('4', 40)] };
    const theirs = { entries: [e('1', 10), e('5', 50), e('2', 22), e('3', 30)] };
    const { value, conflicts } = merge3(base, mine, theirs);
    expect(conflicts).toBe(0);
    expect(value.entries).toEqual([e('1', 11), e('5', 50), e('2', 22), e('4', 40)]);
  });

  it('keeps an item one side deleted if the other changed it', () => {
    const base = [e('1', 10)];
    expect(merge3(base, [], [e('1', 12)]).value).toEqual([e('1', 12)]);
    expect(merge3(base, [e('1', 13)], []).value).toEqual([e('1', 13)]);
  });

  it('merges fields inside the same item', () => {
    const base = [e('1', 10, '')];
    expect(merge3(base, [e('1', 15, '')], [e('1', 10, 'rent')]).value).toEqual([e('1', 15, 'rent')]);
  });

  it('works with no base at all (both added the same item)', () => {
    expect(merge3(undefined, [e('1', 1)], [e('1', 1), e('2', 2)]).value).toEqual([e('1', 1), e('2', 2)]);
  });

  it('compares deeply, ignoring key order and undefined keys', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });
});

describe('merging notes', () => {
  const n = (id: string, text: string, name = id): Note => ({ id, name, text });

  it('merges different notepads without fuss', () => {
    const r = mergeNotes([n('a', 'x'), n('b', 'y')], [n('a', 'x!'), n('b', 'y')], [n('a', 'x'), n('b', 'y?')]);
    expect(r).toMatchObject({ value: [n('a', 'x!'), n('b', 'y?')], conflicts: 0, copies: 0 });
  });

  it('keeps the other device’s text as a copy when both rewrote the same notepad', () => {
    const r = mergeNotes([n('a', 'base', 'Ideas')], [n('a', 'mine', 'Ideas')], [n('a', 'theirs', 'Ideas')], 0);
    expect(r.copies).toBe(1);
    expect(r.conflicts).toBe(0);
    expect(r.value).toEqual([n('a', 'mine', 'Ideas'), { id: 'a-c0', name: 'Ideas (other device)', text: 'theirs' }]);
  });
});
