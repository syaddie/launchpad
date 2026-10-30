import { describe, expect, it } from 'vitest';
import {
  cleanKg, cleanMuscleMap, cleanTraining, e1rm, exerciseHistory, fmtSet, gymPerSession, gymWorkout, lastTrained, liftTrends, muscleOf, musclesOf, parseCsv, parseHevyTime,
  parseWeight, prsByWorkout, setsPerMuscle, volumeKg, weekStreak, weekSummary, weeklyCounts, weightChange, weightSeries, workingSets, workoutLabel, workoutsFromHevyCsv,
} from '../shared/training';

const HEAD = '"title","start_time","end_time","description","exercise_title","superset_id","exercise_notes","set_index","set_type","weight_kg","reps","distance_km","duration_seconds","rpe"';
const row = (title: string, start: string, end: string, ex: string, i: number, kg: number | '', reps: number | '', type = 'normal', extra = ',,') =>
  `"${title}","${start}","${end}","","${ex}",,"",${i},"${type}",${kg},${reps},${extra}`;

// Newest first, as Hevy exports it. Thu 29 Oct and Mon 26 Oct 2026 are this week; 14 Oct is two weeks back.
const CSV = [
  HEAD,
  row('Morning workout ☀️', '29 Oct 2026, 10:00', '29 Oct 2026, 10:45', 'Lat Pulldown - Close Grip (Cable)', 0, 75, 12),
  row('Morning workout ☀️', '29 Oct 2026, 10:00', '29 Oct 2026, 10:45', 'Lat Pulldown - Close Grip (Cable)', 1, 75, 10),
  row('Morning workout ☀️', '29 Oct 2026, 10:00', '29 Oct 2026, 10:45', 'Bicep Curl (Dumbbell)', 0, 12.5, 10),
  row('Push', '26 Oct 2026, 06:30', '26 Oct 2026, 07:30', 'Incline Bench Press (Dumbbell)', 0, 10, 15, 'warmup'),
  row('Push', '26 Oct 2026, 06:30', '26 Oct 2026, 07:30', 'Incline Bench Press (Dumbbell)', 1, 30, 6),
  row('Push', '26 Oct 2026, 06:30', '26 Oct 2026, 07:30', 'Pull Up', 0, '', 7),
  row('Push', '26 Oct 2026, 06:30', '26 Oct 2026, 07:30', 'Treadmill', 0, '', '', 'normal', '2.17,1010,'),
  row('Morning workout ☀️', '14 Oct 2026, 07:00', '14 Oct 2026, 07:40', 'Lat Pulldown - Close Grip (Cable)', 0, 70, 10),
  row('Morning workout ☀️', '14 Oct 2026, 07:00', '14 Oct 2026, 07:40', 'Incline Bench Press (Dumbbell)', 0, 30, 8),
].join('\r\n');

const today = new Date(2026, 9, 30, 18);

describe('reading the Hevy export', () => {
  it('reads quoted fields with commas, doubled quotes and line breaks', () => {
    expect(parseCsv('﻿a,"b, c","say ""hi""","two\nlines"\r\n1,2,3,4\n')).toEqual([['a', 'b, c', 'say "hi"', 'two\nlines'], ['1', '2', '3', '4']]);
  });
  it('reads Hevy’s times as local time', () => {
    expect(parseHevyTime('30 Oct 2026, 10:24')).toEqual(new Date(2026, 9, 30, 10, 24));
    expect(parseHevyTime('Oct 30, 2026, 1:05 PM')).toEqual(new Date(2026, 9, 30, 13, 5));
    expect(parseHevyTime('2026-10-30 07:45:00')).toEqual(new Date(2026, 9, 30, 7, 45));
    expect(parseHevyTime('31 Feb 2026, 10:00')).toBeNull();
    expect(parseHevyTime('yesterday')).toBeNull();
  });
  it('groups the rows into workouts, exercises and sets, newest first', () => {
    const ws = workoutsFromHevyCsv(CSV);
    expect(ws.map((w) => w.title)).toEqual(['Morning workout ☀️', 'Push', 'Morning workout ☀️']);
    expect(ws[0].start).toBe(new Date(2026, 9, 29, 10).toISOString());
    expect(ws[0].exercises.map((e) => [e.title, e.sets.length])).toEqual([['Lat Pulldown - Close Grip (Cable)', 2], ['Bicep Curl (Dumbbell)', 1]]);
    expect(ws[1].exercises[0].sets[0]).toEqual({ type: 'warmup', kg: 10, reps: 15, km: null, sec: null, rpe: null });
    expect(ws[1].exercises[1].sets[0]).toMatchObject({ kg: null, reps: 7 });
    expect(ws[1].exercises[2].sets[0]).toMatchObject({ km: 2.17, sec: 1010 });
    expect(new Set(ws.map((w) => w.id)).size).toBe(3);
  });
  it('starts a new exercise when the same one comes round again', () => {
    const ws = workoutsFromHevyCsv([HEAD, row('A', '1 Oct 2026, 10:00', '1 Oct 2026, 11:00', 'Face Pull', 0, 20, 12), row('A', '1 Oct 2026, 10:00', '1 Oct 2026, 11:00', 'Face Pull', 0, 20, 12)].join('\n'));
    expect(ws[0].exercises).toHaveLength(2);
  });
  it('says what’s wrong with a file that isn’t the export', () => {
    expect(() => workoutsFromHevyCsv('date,amount\n2026-10-01,5')).toThrow(/doesn’t look like a Hevy workout export/);
    expect(() => workoutsFromHevyCsv(HEAD.replace('weight_kg', 'weight_lbs'))).toThrow(/in pounds/);
    expect(() => workoutsFromHevyCsv([HEAD, row('A', 'soon', 'soon', 'Face Pull', 0, 20, 12)].join('\n'))).toThrow(/Row 2 .*“soon”/);
    expect(() => workoutsFromHevyCsv(HEAD)).toThrow(/no workouts/);
  });
  it('cleans what the page sends', () => {
    const t = cleanTraining({
      workouts: [{ id: 'x', title: 'A', start: '2026-10-01T02:00:00.000Z', end: 'nope', exercises: [{ title: 'Row', sets: [{ type: 'weird', kg: -5, reps: 8, rpe: 'hard' }] }, { title: '' }] }, { start: 'bad' }],
      source: 'csv',
      importedAt: 'never',
    });
    expect(t).toEqual({
      workouts: [{ id: 'x', title: 'A', start: '2026-10-01T02:00:00.000Z', end: '2026-10-01T02:00:00.000Z', exercises: [{ title: 'Row', notes: '', sets: [{ type: 'normal', kg: null, reps: 8, km: null, sec: null, rpe: null }] }] }],
      source: 'csv',
      importedAt: null,
    });
    expect(cleanTraining(null)).toEqual({ workouts: [], source: '', importedAt: null });
  });
});

describe('training numbers', () => {
  const ws = workoutsFromHevyCsv(CSV);

  it('reads the main muscle from the exercise name', () => {
    expect(muscleOf('Lat Pulldown - Close Grip (Cable)')).toBe('lats');
    expect(muscleOf('Iso-Lateral Row (Machine)')).toBe('upper_back');
    expect(muscleOf('Single Arm Lateral Raise (Cable)')).toBe('shoulders');
    expect(muscleOf('Lying Leg Curl (Machine)')).toBe('hamstrings');
    expect(muscleOf('Bicep Curl (Barbell)')).toBe('biceps');
    expect(muscleOf('Triceps Kickback (Dumbbell)')).toBe('triceps');
    expect(muscleOf('Decline Crunch (Weighted)')).toBe('abdominals');
    expect(muscleOf('Cable Fly Crossovers')).toBe('chest');
    expect(muscleOf('Single Leg Press (Machine)')).toBe('quadriceps');
    expect(muscleOf('Treadmill')).toBe('cardio');
    expect(muscleOf('Mystery Move')).toBe('other');
  });
  it('names a workout by what it trained when Hevy named it after the time of day', () => {
    expect(workoutLabel(ws[0])).toBe('Lats · Biceps');
    expect(workoutLabel(ws[1])).toBe('Push');
  });
  it('leaves warmups out of sets and volume', () => {
    expect(workingSets(ws[1])).toBe(3);
    expect(volumeKg(ws[1])).toBe(180);
    expect(volumeKg(ws[0])).toBe(75 * 12 + 75 * 10 + 125);
  });
  it('estimates a 1-rep max only from sets of 20 reps or fewer', () => {
    expect(e1rm(100, 1)).toBe(100);
    expect(e1rm(75, 12)).toBeCloseTo(105);
    expect(e1rm(20, 26)).toBeNull();
    expect(e1rm(0, 10)).toBeNull();
  });
  it('writes sets the way the gym does', () => {
    expect(fmtSet({ type: 'normal', kg: 48.75, reps: 11, km: null, sec: null, rpe: null })).toBe('48.75 × 11');
    expect(fmtSet({ type: 'normal', kg: null, reps: 7, km: null, sec: null, rpe: null })).toBe('bodyweight × 7');
    expect(fmtSet({ type: 'normal', kg: null, reps: null, km: 2.17, sec: 1010, rpe: null })).toBe('2.17 km · 16:50');
  });
  it('sums up this week, Monday to Sunday', () => {
    const w = weekSummary(ws, today);
    expect(w.days[0].date).toEqual(new Date(2026, 9, 26));
    expect(w.days.map((d) => d.workouts.length)).toEqual([1, 0, 0, 1, 0, 0, 0]);
    expect(w).toMatchObject({ sessions: 2, minutes: 105, sets: 6 });
  });
  it('counts sessions a week and the run of weeks with one', () => {
    expect(weeklyCounts(ws, today, 3).map((c) => c.count)).toEqual([1, 0, 2]);
    expect(weekStreak(ws, today)).toBe(1);
    // Before this week's first session, last week's run still stands.
    expect(weekStreak(ws.slice(2), new Date(2026, 9, 20))).toBe(1);
    expect(weekStreak(ws.slice(2), new Date(2026, 9, 30))).toBe(0);
  });
  it('counts working sets per muscle, half for secondary ones, listing the main ones even at zero', () => {
    const week = setsPerMuscle(ws, today, 7);
    // Pulldown 2 sets and pull-up 1 → lats 3; biceps 1 from the curl, plus half of the pulldown and pull-up sets.
    expect(week.slice(0, 7)).toEqual([
      { muscle: 'lats', sets: 3 }, { muscle: 'biceps', sets: 2.5 }, { muscle: 'upper_back', sets: 1.5 }, { muscle: 'chest', sets: 1 },
      { muscle: 'shoulders', sets: 0.5 }, { muscle: 'triceps', sets: 0.5 }, { muscle: 'forearms', sets: 0.5 },
    ]);
    expect(week.find((m) => m.muscle === 'calves')).toEqual({ muscle: 'calves', sets: 0 });
    expect(week.some((m) => m.muscle === 'cardio')).toBe(false);
    expect(setsPerMuscle(ws, today, 28).find((m) => m.muscle === 'lats')).toEqual({ muscle: 'lats', sets: 4 });
  });
  it('uses Claude’s reading of an exercise over the name rules', () => {
    const map = { 'Lat Pulldown - Close Grip (Cable)': { primary: 'upper_back' as const, secondary: [] } };
    expect(musclesOf('Lat Pulldown - Close Grip (Cable)', map)).toEqual({ primary: 'upper_back', secondary: [] });
    expect(musclesOf('Bicep Curl (Dumbbell)', map)).toEqual({ primary: 'biceps', secondary: ['forearms'] });
    expect(workoutLabel(ws[0], map)).toBe('Upper back · Biceps');
    expect(setsPerMuscle(ws, today, 7, map).find((m) => m.muscle === 'upper_back')).toEqual({ muscle: 'upper_back', sets: 2.5 });
  });
  it('keeps only known muscles, for the exercises asked about', () => {
    expect(cleanMuscleMap([
      { name: 'Row', primary: 'upper_back', secondary: ['lats', 'upper_back', 'lats', 'wings', 'other'] },
      { name: 'Fly', primary: 'pecs', secondary: [] },
      { name: 'Unasked', primary: 'chest', secondary: [] },
      null,
    ], ['Row', 'Fly'])).toEqual({ Row: { primary: 'upper_back', secondary: ['lats'] } });
    expect(cleanMuscleMap('nope', ['Row'])).toEqual({});
  });
  it('follows the lifts done in at least two sessions, and spots a new best', () => {
    const lifts = liftTrends(ws, today);
    expect(lifts.map((l) => l.title)).toEqual(['Lat Pulldown - Close Grip (Cable)', 'Incline Bench Press (Dumbbell)']);
    const pull = lifts[0];
    expect(pull.measure).toBe('e1rm');
    expect(pull.points.map((p) => Math.round(p.value * 10) / 10)).toEqual([93.3, 105]);
    expect(pull.pr).toBe(true);
    expect(fmtSet(pull.top!)).toBe('75 × 12');
    // 30 × 6 (36 kg) is below 30 × 8 (38 kg) two weeks earlier.
    expect(lifts[1].pr).toBe(false);
    expect(prsByWorkout(ws)).toEqual(new Map([[ws[0].id, ['Lat Pulldown - Close Grip (Cable)']]]));
  });
  it('puts pinned lifts first, even ones done once, and fills up with the most done', () => {
    const lifts = liftTrends(ws, today, { pinned: ['Bicep Curl (Dumbbell)', 'Never Done'], n: 2 });
    expect(lifts.map((l) => [l.title, l.pinned])).toEqual([['Bicep Curl (Dumbbell)', true], ['Lat Pulldown - Close Grip (Cable)', false]]);
    expect(lifts[0]).toMatchObject({ sessions: 1, pr: false });
    expect(lifts[0].latest).toBeCloseTo(16.67, 1);
  });
  it('lists every session of one exercise, newest first, with its bests', () => {
    const h = exerciseHistory(ws, 'Lat Pulldown - Close Grip (Cable)');
    expect(h.measure).toBe('e1rm');
    expect(h.sessions.map((s) => [s.sets.length, Math.round(s.best! * 10) / 10, s.pr])).toEqual([[2, 105, true], [1, 93.3, false]]);
    expect(h.best).toEqual({ value: 105, at: ws[0].start });
    expect(exerciseHistory(ws, 'Pull Up').measure).toBe('reps');
    expect(exerciseHistory(ws, 'Nothing').sessions).toEqual([]);
  });
  it('says when you last trained', () => {
    expect(lastTrained(ws, today)).toEqual({ workout: ws[0], days: 1 });
    expect(lastTrained([], today)).toBeNull();
  });
});

describe('training and the rest of the day', () => {
  const ws = workoutsFromHevyCsv(CSV);
  const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();

  it('works out what each gym session cost this month from the monthly fee', () => {
    expect(gymPerSession(129, ws, '2026-10')).toEqual({ sessions: 3, perSession: 43 });
    expect(gymPerSession(100, ws, '2026-10').perSession).toBe(33.33);
    expect(gymPerSession(129, ws, '2026-09')).toEqual({ sessions: 0, perSession: null });
    expect(gymPerSession(0, ws, '2026-10')).toEqual({ sessions: 3, perSession: null });
  });
  it('finds the workout logged for a gym block in the calendar', () => {
    const ev = (title: string, d: number, h: number) => ({ title, start: at(d, h), end: at(d, h + 1) });
    expect(gymWorkout(ev('Gym', 29, 9), ws)).toBe(ws[0]);
    expect(gymWorkout(ev('Leg day', 26, 7), ws)).toBe(ws[1]);
    expect(gymWorkout(ev('Standup', 29, 10), ws)).toBeNull();
    expect(gymWorkout(ev('Gym', 27, 9), ws)).toBeNull();
  });
});

describe('body weight', () => {
  it('reads a weight typed in ⌘K', () => {
    expect(parseWeight('weight 72.4')).toBe(72.4);
    expect(parseWeight('W 72,45 kg')).toBe(72.45);
    expect(parseWeight('log weight 101')).toBe(101);
    expect(parseWeight('weight 7')).toBeNull();
    expect(parseWeight('weight 999')).toBeNull();
    expect(parseWeight('weightlifting 72')).toBeNull();
    expect(parseWeight('72.4')).toBeNull();
  });
  it('keeps only body weights, to two decimals', () => {
    expect(cleanKg(72.456)).toBe(72.46);
    expect(cleanKg('70,5')).toBe(70.5);
    expect(cleanKg(5)).toBeNull();
    expect(cleanKg('heavy')).toBeNull();
  });
  it('averages the entries in the 7 days up to each one, and compares the latest with one a period back', () => {
    const series = weightSeries({ '2026-10-01': 74, '2026-10-05': 73, '2026-10-08': 72, '2026-10-20': 71, '2026-10-30': 70.5 });
    expect(series.map((p) => [p.date, p.avg])).toEqual([
      ['2026-10-01', 74], ['2026-10-05', 73.5], ['2026-10-08', 72.5], ['2026-10-20', 71], ['2026-10-30', 70.5],
    ]);
    // 25 days before 30 Oct is 5 Oct.
    expect(weightChange(series, 25)).toEqual({ kg: -3, since: '2026-10-05', full: true });
    // Nothing 90 days back, so it's since the first entry.
    expect(weightChange(series, 90)).toEqual({ kg: -3.5, since: '2026-10-01', full: false });
    // Only the latest entry in the last 5 days: nothing to compare.
    expect(weightChange(series, 5)).toEqual({ kg: -0.5, since: '2026-10-20', full: true });
    expect(weightChange(series.slice(0, 1), 30)).toBeNull();
    expect(weightChange([], 30)).toBeNull();
  });
});
