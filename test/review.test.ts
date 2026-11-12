import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../shared/defaults';
import { emptyLearn } from '../shared/learn';
import { weekReview, type ReviewInput } from '../shared/review';
import {
  MAX_JOURNAL, cigPrice, cleanCravings, cravingSummary, moodYear, parseCraving, savedUnderLimit, searchJournal, smokeCountMap, smokeDaysFrom, smokeSpend,
} from '../shared/trackers';
import { bodyweightOn, strengthRatios, trainingWeeks, weightAvgOn } from '../shared/training';
import type { Craving, Money, Workout } from '../shared/types';
import { cleanMood, cleanPrefs } from '../server/src/clean';
import { recapWeek, reviewInput } from '../server/src/review';
import { addPending, applyPending, type Pending } from '../web/src/pending';

// Thu 12 Nov 2026, late afternoon in Singapore; the week runs Mon 9 to Sun 15 Nov.
const now = new Date(2026, 10, 12, 17, 30);
const at = (d: number, h: number, m = 0, month = 10) => new Date(2026, month, d, h, m).toISOString();
const craving = (p: Partial<Craving>): Craving => ({ id: 'c' + Math.random(), at: at(12, 9), strength: 2, trigger: '', note: '', ...p });

describe('cigarettes: day counts and cost', () => {
  const all = [at(1, 9, 0, 8), at(1, 21, 0, 8), at(10, 8), at(11, 8), at(11, 12), at(12, 7), at(12, 10)];

  it('sends whole days before the log’s first day as counts, and never counts a cigarette twice', () => {
    const days = smokeDaysFrom(all, now);
    expect(days.before).toBe('2026-09-14');
    expect(days.counts).toEqual({ '2026-09-01': 2 });
    // The page only has the last 60 days in full, plus the counts.
    const recent = all.filter((s) => Date.parse(s) > now.getTime() - 60 * 86_400_000);
    const map = smokeCountMap(recent, days);
    expect(Object.fromEntries(map)).toEqual({ '2026-09-01': 2, '2026-11-10': 1, '2026-11-11': 2, '2026-11-12': 2 });
    // A log that still has a cigarette from a day the counts cover doesn't add it again.
    expect(smokeCountMap([...recent, at(1, 9, 0, 8)], days).get('2026-09-01')).toBe(2);
    expect(Object.fromEntries(smokeCountMap(all))).toMatchObject({ '2026-09-01': 2 });
  });

  it('prices them from the pack', () => {
    expect(cigPrice({ packPrice: 15, packSize: 20 })).toBe(0.75);
    expect(cigPrice({ packPrice: 0, packSize: 20 })).toBe(0);
    const s = smokeSpend(smokeCountMap(all), now, 0.75);
    expect(s.today).toEqual({ count: 2, cost: 1.5 });
    expect(s.week).toEqual({ count: 5, cost: 3.75 });
    expect(s.month).toEqual({ count: 5, cost: 3.75 });
    expect(s.year).toEqual({ count: 7, cost: 5.25 });
  });

  it('counts what staying under the limit saved, on finished days since the first one logged', () => {
    const map = smokeCountMap([at(10, 8), at(11, 8), at(11, 12), at(12, 7)]);
    // 10 Nov: 1 of 3, 11 Nov: 2 of 3. Today isn't over yet.
    expect(savedUnderLimit(map, now, 3, 0.75, '2026-11-01')).toEqual({ days: 2, under: 3, saved: 2.25 });
    expect(savedUnderLimit(map, now, 3, 0.75, '2026-11-11')).toEqual({ days: 1, under: 1, saved: 0.75 });
    expect(savedUnderLimit(map, now, 0, 0.75, '2026-11-01').saved).toBe(0);
    expect(savedUnderLimit(new Map(), now, 3, 0.75, '2026-11-01').days).toBe(0);
  });

  it('keeps the pack price and size in Settings within reason', () => {
    const p = cleanPrefs({ packPrice: 14.555, packSize: 0 }, DEFAULT_PREFS);
    expect(p.packPrice).toBe(14.56);
    expect(p.packSize).toBe(1);
    expect(cleanPrefs({ packPrice: -3 } as never, DEFAULT_PREFS).packPrice).toBe(0);
    expect(cleanPrefs({}, DEFAULT_PREFS)).toMatchObject({ packPrice: 0, packSize: 20 });
  });
});

describe('cravings', () => {
  it('cleans what the page or a backup sends', () => {
    const list = cleanCravings(
      [
        { id: 'b', at: at(12, 9), strength: 3, trigger: 'coffee', note: '  after the first cup ' },
        { id: 'a', at: at(11, 9), strength: 7, trigger: 'nope' },
        { id: 'b', at: at(12, 10), strength: 1, trigger: 'stress' },
        { id: 'f', at: '2099-01-01T00:00:00Z' },
        { at: at(12, 9) },
        'junk',
      ],
      now.getTime(),
    );
    expect(list).toEqual([
      { id: 'a', at: at(11, 9), strength: 2, trigger: '', note: '' },
      { id: 'b', at: at(12, 10), strength: 1, trigger: 'stress', note: '' },
    ]);
  });

  it('reads “craving 3 stress” in ⌘K', () => {
    expect(parseCraving('craving')).toEqual({ strength: 2, trigger: '' });
    expect(parseCraving('craving 3 stress')).toEqual({ strength: 3, trigger: 'stress' });
    expect(parseCraving('urge 1 coffee')).toEqual({ strength: 1, trigger: 'coffee' });
    expect(parseCraving('log a craving after meals')).toEqual({ strength: 2, trigger: 'meal' });
    expect(parseCraving('Craving meals')).toEqual({ strength: 2, trigger: 'meal' });
    expect(parseCraving('craving waking')).toEqual({ strength: 2, trigger: 'waking' });
    expect(parseCraving('craving pizza')).toBeNull();
    expect(parseCraving('cravings are hard')).toBeNull();
  });

  it('sets them against cigarettes smoked, with the common triggers', () => {
    const list = [craving({ trigger: 'coffee' }), craving({ trigger: 'coffee', at: at(11, 9) }), craving({ trigger: 'stress', at: at(10, 9) }), craving({ at: at(10, 10) }), craving({ at: at(1, 9) })];
    const s = cravingSummary(list, smokeCountMap([at(12, 7), at(11, 8)]), now, 7);
    expect(s.resisted).toBe(4);
    expect(s.smoked).toBe(2);
    expect(s.byDay).toHaveLength(7);
    expect(s.byDay[6]).toEqual({ date: '2026-11-12', resisted: 1, smoked: 1 });
    expect(s.triggers).toEqual([{ trigger: 'coffee', count: 2 }, { trigger: 'stress', count: 1 }]);
  });

  it('queues offline like a cigarette, one entry per craving', () => {
    const a = craving({ id: 'a' });
    let q: Pending[] = [];
    q = addPending(q, { kind: 'craving', value: a });
    q = addPending(q, { kind: 'craving', value: { ...a, trigger: 'social' } });
    q = addPending(q, { kind: 'craving', value: craving({ id: 'b' }) });
    expect(q).toHaveLength(2);
    expect(applyPending({ cravings: [] }, q).cravings!.map((c) => [c.id, c.trigger])).toEqual([['a', 'social'], ['b', '']]);
    // Undoing one that never reached the server drops it from the queue.
    q = addPending(q, { kind: 'removeCraving', id: 'a' });
    expect(q.map((p) => p.kind)).toEqual(['craving']);
    q = addPending(q, { kind: 'removeCraving', id: 'old' });
    expect(applyPending({ cravings: [craving({ id: 'old' })] }, q).cravings!.map((c) => c.id)).toEqual(['b']);
  });
});

describe('journal', () => {
  it('keeps every note that’s already stored exactly as it was', () => {
    const old = { level: 3, note: 'Long day, but the run helped.' };
    expect(cleanMood(old)).toEqual(old);
    // A mood set without a note keeps the day's entry.
    expect(cleanMood({ level: 5 }, old.note)).toEqual({ level: 5, note: old.note });
    // Taking the mood off keeps the entry, as a day with only a journal.
    expect(cleanMood({ level: 0, note: old.note }, old.note)).toEqual({ level: 0, note: old.note });
    // Clearing the day with neither is still a clear.
    expect(cleanMood({ level: 0 }, old.note)).toBeNull();
    expect(cleanMood({ level: 0, note: '   ' })).toBeNull();
  });

  it('takes a long entry with its line breaks, up to the limit', () => {
    const text = '  - [ ] call home\n**Good** day\n\n' + 'x'.repeat(1000) + '\n  ';
    const m = cleanMood({ level: 4, note: text })!;
    expect(m.note).toBe(text.trimEnd());
    expect(cleanMood({ level: 4, note: 'y'.repeat(MAX_JOURNAL + 50) })!.note).toHaveLength(MAX_JOURNAL);
  });

  it('searches every entry, newest first', () => {
    const moods = {
      '2026-11-10': { level: 4, note: 'Climbed with Sam after work. Good session.' },
      '2026-03-02': { level: 2, note: 'Tired. Skipped the gym; sam called.' },
      '2025-12-31': { level: 0, note: 'Fireworks.' },
      '2026-11-11': { level: 3, note: '' },
    };
    expect(searchJournal(moods, 'sam').map((r) => r.date)).toEqual(['2026-11-10', '2026-03-02']);
    expect(searchJournal(moods, 'SAM gym').map((r) => r.date)).toEqual(['2026-03-02']);
    expect(searchJournal(moods, 'fireworks')[0]).toEqual({ date: '2025-12-31', level: 0, snippet: 'Fireworks.' });
    expect(searchJournal(moods, '  ')).toEqual([]);
    expect(moodYear(moods, 2026)).toEqual({ avg: 3, logged: 3, written: 2 });
    expect(moodYear(moods, 2025)).toEqual({ avg: null, logged: 0, written: 1 });
  });
});

const workout = (start: string, ex: { title: string; sets: [number, number][] }[]): Workout => ({
  id: 'w' + start,
  title: 'Workout',
  start,
  end: new Date(Date.parse(start) + 3600_000).toISOString(),
  exercises: ex.map((e) => ({ title: e.title, notes: '', sets: e.sets.map(([kg, reps]) => ({ type: 'normal', kg, reps, km: null, sec: null, rpe: null })) })),
});

describe('body weight against training', () => {
  const weights = { '2026-10-20': 75, '2026-10-26': 74, '2026-11-02': 73.5, '2026-11-04': 73, '2026-11-11': 72.5 };
  const workouts = [
    workout(at(11, 7), [{ title: 'Squat (Barbell)', sets: [[100, 5]] }, { title: 'Bicep Curl (Dumbbell)', sets: [[14, 10]] }]),
    workout(at(4, 7), [{ title: 'Squat (Barbell)', sets: [[95, 5]] }, { title: 'Bicep Curl (Dumbbell)', sets: [[14, 10]] }]),
    workout(at(27, 7, 0, 9), [{ title: 'Bicep Curl (Dumbbell)', sets: [[12, 10]] }]),
  ];

  it('averages the week up to a day, and falls back to the nearest weigh-in', () => {
    expect(weightAvgOn(weights, '2026-11-04')).toBe(73.25);
    expect(weightAvgOn(weights, '2026-11-10')).toBe(73);
    expect(weightAvgOn(weights, '2026-10-19')).toBeNull();
    expect(bodyweightOn(weights, '2026-10-19')).toBe(75);
    expect(bodyweightOn(weights, '2026-12-30')).toBeNull();
  });

  it('puts sessions, volume and weight side by side, a week at a time', () => {
    const w = trainingWeeks(workouts, weights, now, 3);
    expect(w.map((x) => x.start)).toEqual(['2026-10-26', '2026-11-02', '2026-11-09']);
    expect(w.map((x) => x.sessions)).toEqual([1, 1, 1]);
    expect(w[2].volume).toBe(640);
    expect(w[1].weight).toBe(73.25);
    // This week's is the average up to today.
    expect(w[2].weight).toBe(72.5);
  });

  it('divides each lift’s estimated 1RM by body weight that day, big lifts first', () => {
    const r = strengthRatios(workouts, weights, now, { weeks: 12 });
    expect(r.map((x) => x.title)).toEqual(['Squat (Barbell)', 'Bicep Curl (Dumbbell)']);
    // 100 × (1 + 5/30) = 116.7 at 72.5 kg.
    expect(r[0].points.at(-1)).toMatchObject({ e1rm: 116.7, kg: 72.5, ratio: 1.61 });
    expect(r[0].change).toBeCloseTo(1.61 - 1.51, 5);
    expect(strengthRatios(workouts, weights, now, { pinned: ['Bicep Curl (Dumbbell)'] })[0].title).toBe('Bicep Curl (Dumbbell)');
    expect(strengthRatios(workouts, {}, now)).toEqual([]);
  });
});

describe('the week in review', () => {
  const money: Money = {
    start: '2026-11-01',
    accounts: [
      { id: 'bank', name: 'Bank', kind: 'bank', spendable: true, opening: 1000, goal: null, goalBy: '', archived: false },
      { id: 'pot', name: 'Trip', kind: 'pot', spendable: false, opening: 0, goal: null, goalBy: '', archived: false },
    ],
    entries: [
      { id: '1', date: '2026-11-10', kind: 'in', amount: 500, note: 'Gig', category: 'Pay', planned: false, account: 'bank', to: '' },
      { id: '2', date: '2026-11-11', kind: 'out', amount: 40.5, note: 'Food', category: 'Food', planned: false, account: 'bank', to: '' },
      { id: '3', date: '2026-11-11', kind: 'move', amount: 100, note: '', category: '', planned: false, account: 'bank', to: 'pot' },
      { id: '4', date: '2026-11-14', kind: 'out', amount: 60, note: 'Rent share', category: 'Bills', planned: true, account: 'bank', to: '' },
      { id: '5', date: '2026-11-03', kind: 'out', amount: 9.5, note: 'Earlier', category: '', planned: false, account: 'bank', to: '' },
    ],
    wishlist: [],
    invoices: [],
  };
  const learn = {
    ...emptyLearn(),
    courses: [{ id: 'cs', code: 'CS 210', name: 'Data structures', color: '#000', target: 0, goalMin: 240, links: [], topics: [], archived: false }],
    sessions: [
      { id: 's1', courseId: 'cs', start: at(10, 20), minutes: 90 },
      { id: 's2', courseId: '', start: at(11, 20), minutes: 30 },
      { id: 's3', courseId: 'cs', start: at(5, 20), minutes: 60 },
    ],
    assessments: [
      { id: 'a1', courseId: 'cs', title: 'Lab 3', kind: 'Lab' as const, weight: 5, due: '2026-11-10', time: '', status: 'done' as const, score: null },
      { id: 'a2', courseId: 'cs', title: 'Quiz 2', kind: 'Quiz' as const, weight: 5, due: '2026-11-11', time: '', status: 'todo' as const, score: null },
      { id: 'a3', courseId: 'cs', title: 'Essay', kind: 'Essay' as const, weight: 20, due: '2026-11-14', time: '', status: 'doing' as const, score: null },
    ],
  };
  const input: ReviewInput = {
    workouts: [workout(at(11, 7), [{ title: 'Squat (Barbell)', sets: [[100, 5]] }]), workout(at(4, 7), [{ title: 'Squat (Barbell)', sets: [[95, 5]] }])],
    weights: { '2026-11-06': 73, '2026-11-08': 73.4, '2026-11-11': 72.6 },
    smokes: smokeCountMap([at(9, 8), at(10, 8), at(10, 9), at(10, 10), at(10, 11), at(12, 7), at(3, 8)]),
    cravings: [craving({ strength: 3, trigger: 'coffee' }), craving({ at: at(10, 12), trigger: 'coffee' }), craving({ at: at(10, 13), trigger: 'stress' }), craving({ at: at(2, 9) })],
    moods: { '2026-11-09': { level: 4, note: 'ok' }, '2026-11-10': { level: 2, note: '' }, '2026-11-11': { level: 0, note: 'just words' }, '2026-11-02': { level: 1, note: '' } },
    learn,
    money,
    prefs: { cigaretteLimit: 3, packPrice: 15, packSize: 20 },
    delivered: [{ label: 'Shoes', at: at(10, 15) }, { label: 'Old', at: at(1, 15) }],
    tasksDone: 7,
  };

  it('reads every module’s week', () => {
    const r = weekReview(input, now, now);
    expect(r).toMatchObject({ start: '2026-11-09', end: '2026-11-15', daysIn: 4 });
    expect(r.training).toMatchObject({ sessions: 1, volume: 500, sets: 1, prevSessions: 1, prevVolume: 475 });
    // 7-day average up to today (73, 73.4, 72.6) against the one up to last Sunday (73, 73.4).
    expect(r.weight).toEqual({ avg: 73, change: -0.2 });
    expect(r.cigarettes).toEqual({ count: 6, perDay: 1.5, limit: 3, daysOver: 1, cost: 4.5, prevCount: 1 });
    expect(r.cravings).toEqual({ resisted: 3, strong: 1, topTrigger: 'coffee' });
    expect(r.mood).toEqual({ avg: 3, logged: 2, written: 2 });
    expect(r.study.minutes).toBe(120);
    expect(r.study.courses).toEqual([
      { id: 'cs', name: 'CS 210', minutes: 90, goal: 240 },
      { id: '', name: 'General study', minutes: 30, goal: 0 },
    ]);
    expect(r.study).toMatchObject({ met: 1, late: ['Quiz 2'], ahead: 1 });
    // A move to a pot counts as money out of the day-to-day accounts; the planned rent isn't done yet.
    expect(r.money).toEqual({ in: 500, out: 140.5, closing: 1350, forecast: 1290 });
    expect(r.tasks).toBe(7);
    expect(r.packages).toEqual(['Shoes']);
  });

  it('steps back to a finished week, and leaves out what isn’t tracked', () => {
    const r = weekReview({ ...input, money: { ...money, entries: [] }, tasksDone: null, prefs: { cigaretteLimit: 0, packPrice: 0, packSize: 20 } }, new Date(2026, 10, 4), now);
    expect(r).toMatchObject({ start: '2026-11-02', daysIn: 7 });
    expect(r.cigarettes).toMatchObject({ count: 1, cost: null, daysOver: 0, limit: 0 });
    expect(r.mood).toEqual({ avg: 1, logged: 1, written: 0 });
    expect(r.money).toBeNull();
    expect(r.tasks).toBeNull();
    expect(r.study.minutes).toBe(60);
  });

  it('gives Claude the numbers but not the journal', () => {
    const text = reviewInput(weekReview(input, now, now));
    expect(text).toMatch(/Week of Mon 9 Nov to Sun 15 Nov 2026, 4 of 7 days so far/);
    expect(text).toMatch(/Cigarettes: 6, 1.5 a day; daily limit 3, over it on 1 day; cost \$4.50/);
    expect(text).toMatch(/journal written on 2 days/);
    expect(text).toMatch(/not handed in: Quiz 2/);
    expect(text).not.toMatch(/just words/);
  });

  it('writes the recap for this week from Sunday 6 pm, else for the week before', () => {
    expect(recapWeek(now)).toBe('2026-11-02');
    expect(recapWeek(new Date(2026, 10, 15, 17, 59))).toBe('2026-11-02');
    expect(recapWeek(new Date(2026, 10, 15, 18, 0))).toBe('2026-11-09');
    expect(recapWeek(new Date(2026, 10, 16, 8))).toBe('2026-11-09');
  });
});
