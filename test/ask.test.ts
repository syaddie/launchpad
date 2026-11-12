import { describe, expect, it } from 'vitest';
import { askable, askSystem, askTools, checkAction, dayPhrase, describeAction, type AskAction, type AskContext } from '../shared/ask';

const ctx: AskContext = {
  today: '2026-11-12',
  accounts: [{ id: 'a1', name: 'DBS' }, { id: 'a2', name: 'Cash' }],
  mainAccount: 'a1',
  taskLists: [{ id: 'L1', title: 'My Tasks' }, { id: 'L2', title: 'Errands' }],
  courses: [{ id: 'c1', code: 'CS210', name: 'Data Structures' }],
  bookmarkGroups: [{ id: 'g1', name: 'Daily' }, { id: 'g2', name: 'Work' }],
};

const ok = (name: string, input: unknown, c = ctx): AskAction => {
  const r = checkAction(name, input, c);
  if (!r.ok) throw new Error(r.error);
  return r.action;
};
const err = (name: string, input: unknown, c = ctx) => {
  const r = checkAction(name, input, c);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error;
};

describe('the tools Claude picks from', () => {
  it('has a strict schema for each, every field required', () => {
    for (const t of askTools(ctx)) {
      expect(t.strict).toBe(true);
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.input_schema.required.sort()).toEqual(Object.keys(t.input_schema.properties).sort());
    }
    expect(askTools(ctx).map((t) => t.name)).toEqual(['add_money', 'add_task', 'log_weight', 'log_cigarette', 'log_study', 'add_countdown', 'add_bookmark', 'log_mood']);
  });

  it('leaves out tools with nothing to point at', () => {
    const names = askTools({ ...ctx, accounts: [], mainAccount: '', taskLists: [], courses: [], bookmarkGroups: [] }).map((t) => t.name);
    expect(names).toEqual(['log_weight', 'log_cigarette', 'add_countdown', 'log_mood']);
  });

  it('only offers ids that exist, and tells Claude today’s date', () => {
    const money = askTools(ctx).find((t) => t.name === 'add_money')!;
    expect((money.input_schema.properties.account as { enum: string[] }).enum).toEqual(['a1', 'a2']);
    expect((money.input_schema.properties.category as { enum: string[] }).enum).toContain('Food');
    expect(askSystem(ctx)).toContain('Thu 12 Nov 2026 (2026-11-12)');
  });
});

describe('checking what Claude sent', () => {
  it('takes a money entry and fills the gaps', () => {
    expect(ok('add_money', { kind: 'out', amount: 12, category: 'Food', note: ' lunch ', date: '2026-11-12', account: 'a1' })).toEqual({
      type: 'money', kind: 'out', amount: 12, category: 'Food', note: 'lunch', date: '2026-11-12', account: 'a1',
    });
    // An unknown account goes to the main one; an unknown category is left empty; amounts round to cents.
    expect(ok('add_money', { kind: 'in', amount: 20.456, category: 'Snacks', note: '', date: '2026-11-12', account: 'zz' })).toMatchObject({ account: 'a1', category: '', amount: 20.46 });
  });

  it('refuses money that doesn’t add up', () => {
    expect(err('add_money', { kind: 'out', amount: 0, category: '', note: '', date: '2026-11-12', account: 'a1' })).toMatch(/amount/);
    expect(err('add_money', { kind: 'out', amount: Infinity, category: '', note: '', date: '2026-11-12', account: 'a1' })).toMatch(/amount/);
    expect(err('add_money', { kind: 'sideways', amount: 5, category: '', note: '', date: '2026-11-12', account: 'a1' })).toMatch(/in or out/);
    expect(err('add_money', { kind: 'out', amount: 5, category: '', note: '', date: '2026-02-30', account: 'a1' })).toMatch(/date/);
    expect(err('add_money', { kind: 'out', amount: 5, category: '', note: '', date: '2040-01-01', account: 'a1' })).toMatch(/date/);
    expect(err('add_money', { kind: 'out', amount: 5, category: '', note: '', date: '2026-11-12', account: 'a1' }, { ...ctx, accounts: [], mainAccount: '' })).toMatch(/account/);
  });

  it('takes tasks with or without a due date', () => {
    expect(ok('add_task', { title: 'Pay rent', due: '2026-12-01', list: 'L2' })).toEqual({ type: 'task', title: 'Pay rent', due: '2026-12-01', listId: 'L2' });
    expect(ok('add_task', { title: 'Call mum', due: '', list: 'nope' })).toEqual({ type: 'task', title: 'Call mum', due: null, listId: 'L1' });
    expect(err('add_task', { title: '  ', due: '', list: 'L1' })).toMatch(/title/);
    expect(err('add_task', { title: 'x', due: 'soon', list: 'L1' })).toMatch(/due date/);
    expect(err('add_task', { title: 'x', due: '', list: 'L1' }, { ...ctx, taskLists: [] })).toMatch(/Google/);
  });

  it('keeps weight, study and mood in range and out of the future', () => {
    expect(ok('log_weight', { kg: 72.44, date: '2026-11-12' })).toEqual({ type: 'weight', kg: 72.4, date: '2026-11-12' });
    expect(err('log_weight', { kg: 7, date: '2026-11-12' })).toMatch(/between/);
    expect(err('log_weight', { kg: 72, date: '2026-11-13' })).toMatch(/date/);
    expect(ok('log_study', { minutes: 45, course: 'c1' })).toEqual({ type: 'study', minutes: 45, courseId: 'c1' });
    expect(err('log_study', { minutes: 45, course: 'c9' })).toMatch(/course/);
    expect(err('log_study', { minutes: 0, course: 'c1' })).toMatch(/between/);
    expect(err('log_study', { minutes: 13 * 60, course: 'c1' })).toMatch(/between/);
    expect(ok('log_mood', { level: 4, note: 'good gym', date: '2026-11-12' })).toEqual({ type: 'mood', level: 4, note: 'good gym', date: '2026-11-12' });
    expect(err('log_mood', { level: 6, note: '', date: '2026-11-12' })).toMatch(/1 to 5/);
  });

  it('takes countdowns, cigarettes and bookmarks', () => {
    expect(ok('add_countdown', { title: 'Japan trip', date: '2027-03-03', yearly: false })).toEqual({ type: 'countdown', title: 'Japan trip', date: '2027-03-03', yearly: false });
    expect(ok('log_cigarette', {})).toEqual({ type: 'smoke' });
    expect(ok('add_bookmark', { name: '', url: 'www.example.com/a', group: 'g2' })).toEqual({ type: 'bookmark', name: 'example.com', url: 'https://www.example.com/a', groupId: 'g2' });
    expect(err('add_bookmark', { name: 'x', url: 'javascript:alert(1)', group: 'g1' })).toMatch(/address/);
    expect(err('add_bookmark', { name: 'x', url: 'not a url', group: 'g1' })).toMatch(/address/);
  });

  it('refuses tools it doesn’t know and input that isn’t an object', () => {
    expect(err('delete_everything', {})).toMatch(/can’t do/);
    expect(err('add_task', null)).toMatch(/title/);
  });
});

describe('saying what Enter will do', () => {
  it('phrases each action', () => {
    expect(describeAction(ok('add_money', { kind: 'out', amount: 12, category: 'Food', note: 'lunch', date: '2026-11-12', account: 'a1' }), ctx)).toEqual({ label: 'Add $12 out, Food, today', sub: '“lunch” · DBS · done' });
    expect(describeAction(ok('add_money', { kind: 'in', amount: 900, category: '', note: '', date: '2026-12-01', account: 'a2' }), ctx).sub).toBe('Cash · planned');
    expect(describeAction(ok('add_task', { title: 'Pay rent', due: '2026-12-01', list: 'L1' }), ctx).label).toBe('Add task “Pay rent”, due Tue 1 Dec');
    expect(describeAction(ok('log_study', { minutes: 45, course: 'c1' }), ctx).label).toBe('Log 45m of CS210');
    expect(describeAction(ok('add_countdown', { title: 'Japan trip', date: '2027-03-03', yearly: false }), ctx)).toEqual({ label: 'Add countdown “Japan trip” to Wed 3 Mar 2027', sub: 'One-off · 111 days away' });
    expect(describeAction({ type: 'mood', level: 2, note: '', date: '2026-11-11' }, ctx).label).toBe('Log yesterday’s mood: Low');
  });

  it('names days near today', () => {
    expect(dayPhrase('2026-11-13', '2026-11-12')).toBe('tomorrow');
    expect(dayPhrase('2026-11-20', '2026-11-12')).toBe('Fri 20 Nov');
  });

  it('only offers to ask for a few words', () => {
    expect(askable('spent 12 on lunch')).toBe(true);
    expect(askable('money')).toBe(false);
    expect(askable('a b')).toBe(false);
  });
});
