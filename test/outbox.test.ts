import { describe, expect, it } from 'vitest';
import { STARTER_NOTES } from '../shared/defaults';
import type { AppState, Note } from '../shared/types';
import { addPending, applyPending, pendingDocs, type Pending } from '../web/src/pending';

const smoke = (at: string): Pending => ({ kind: 'addSmoke', at });
const base = { value: [{ id: 'n1', name: 'Scratch', text: 'a' }] as Note[], version: 'v1' };

describe('queue of offline edits', () => {
  it('keeps cigarettes and ticked-off tasks as their own entries, in order', () => {
    let q: Pending[] = [];
    q = addPending(q, smoke('2026-11-12T01:00:00.000Z'));
    q = addPending(q, { kind: 'removeSmoke', at: '2026-11-12T01:00:00.000Z' });
    q = addPending(q, smoke('2026-11-12T02:00:00.000Z'));
    q = addPending(q, { kind: 'completeTask', listId: 'l', id: 't1' });
    q = addPending(q, { kind: 'completeTask', listId: 'l', id: 't1' });
    expect(q.map((p) => p.kind)).toEqual(['addSmoke', 'removeSmoke', 'addSmoke', 'completeTask']);
  });

  it('replaces a save of the same thing, in its place', () => {
    let q: Pending[] = [];
    q = addPending(q, { kind: 'mood', date: '2026-11-12', mood: { level: 2 } });
    q = addPending(q, { kind: 'weight', date: '2026-11-12', kg: 72 });
    q = addPending(q, { kind: 'mood', date: '2026-11-11', mood: { level: 4 } });
    q = addPending(q, { kind: 'mood', date: '2026-11-12', mood: { level: 5 } });
    q = addPending(q, { kind: 'countdowns', value: [] });
    q = addPending(q, { kind: 'countdowns', value: [{ id: 'c', title: 'Trip', date: '2026-12-25', yearly: false, createdAt: '' }] });
    expect(q).toHaveLength(4);
    expect(q[0]).toEqual({ kind: 'mood', date: '2026-11-12', mood: { level: 5 } });
    expect(q[3]).toMatchObject({ kind: 'countdowns', value: [{ title: 'Trip' }] });
  });

  it('keeps one copy of a document, with the version its first edit started from', () => {
    let q: Pending[] = [];
    q = addPending(q, { kind: 'doc', key: 'notes', value: [{ ...base.value[0], text: 'ab' }], base, tab: 't1' });
    q = addPending(q, { kind: 'doc', key: 'notes', value: [{ ...base.value[0], text: 'abc' }], base: { value: [], version: 'v2' }, tab: 't1' });
    expect(q).toHaveLength(1);
    expect(pendingDocs(q).get('notes')).toMatchObject({ base: { version: 'v1' }, value: [{ text: 'abc' }] });
  });

  it('merges a document edited in another tab rather than dropping that tab’s edits', () => {
    const two = [...base.value, { id: 'n2', name: 'Ideas', text: 'x' }];
    const b = { value: two, version: 'v1' };
    let q: Pending[] = [];
    q = addPending(q, { kind: 'doc', key: 'notes', value: [{ ...two[0], text: 'tab one' }, two[1]], base: b, tab: 't1' });
    q = addPending(q, { kind: 'doc', key: 'notes', value: [two[0], { ...two[1], text: 'tab two' }], base: b, tab: 't2' });
    expect((pendingDocs(q).get('notes')!.value as Note[]).map((n) => n.text)).toEqual(['tab one', 'tab two']);
  });

  it('shows queued edits on a fresh copy of the state', () => {
    const s = { smokes: ['2026-11-12T00:00:00.000Z'], moods: { '2026-11-10': { level: 3 } }, weights: { '2026-11-12': 70 }, tasks: [{ id: 't1', listId: 'l', title: 'x', due: null }], notes: STARTER_NOTES } as unknown as AppState;
    const q: Pending[] = [
      smoke('2026-11-12T01:00:00.000Z'),
      { kind: 'removeSmoke', at: '2026-11-12T00:00:30.000Z' },
      { kind: 'mood', date: '2026-11-10', mood: null },
      { kind: 'weight', date: '2026-11-12', kg: 71.5 },
      { kind: 'completeTask', listId: 'l', id: 't1' },
      { kind: 'doc', key: 'notes', value: base.value, base, tab: 't' },
    ];
    const out = applyPending(s, q);
    // The undo matched the one logged 30 s earlier by the server's clock.
    expect(out.smokes).toEqual(['2026-11-12T01:00:00.000Z']);
    expect(out.moods).toEqual({});
    expect(out.weights).toEqual({ '2026-11-12': 71.5 });
    expect(out.tasks).toEqual([]);
    expect(out.notes).toEqual(base.value);
    // The state it was given is left as it was.
    expect(s.smokes).toEqual(['2026-11-12T00:00:00.000Z']);
  });

  it('only touches the parts of a partial fetch that came back', () => {
    const q: Pending[] = [{ kind: 'removeSmoke', at: '2026-11-12T00:00:00.000Z' }, { kind: 'weight', date: '2026-11-12', kg: 71 }];
    expect(applyPending({ weights: {} }, q)).toEqual({ weights: { '2026-11-12': 71 } });
    expect(applyPending({ sync: {} } as Partial<AppState>, q)).toEqual({ sync: {} });
  });
});
