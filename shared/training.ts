// Workouts from Hevy. For now they come from the CSV that Hevy's app exports
// (Settings › Export & Import Data); the shape follows Hevy's API so a live
// sync can fill the same document later. Everything shown in the Training view
// is worked out here: weekly totals, sets per muscle, lift trends and PRs.
// Also cleaning for what the page sends.
import { addDays, dayDiff, startOfDay, ymd } from './dates';
import type { ExerciseMuscles, Muscle, SetType, Training, Workout, WorkoutExercise, WorkoutSet } from './types';

export const MAX_WORKOUTS = 5000;
const MAX_EXERCISES = 60;
const MAX_SETS = 60;
const SET_TYPES: SetType[] = ['normal', 'warmup', 'dropset', 'failure'];

export const EMPTY_TRAINING: Training = { workouts: [], source: '', importedAt: null };

// ---------- reading Hevy's CSV ----------

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim()));
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** "30 Oct 2026, 10:24" (Hevy's export), "Oct 30, 2026, 10:24 AM" or "2026-10-30 10:24", read as local time. */
export function parseHevyTime(s: string): Date | null {
  const t = s.trim();
  let y: number, mo: number, d: number, h: number, mi: number;
  let m = t.match(/^(\d{1,2}) ([a-z]{3})[a-z]* (\d{4}),? (\d{1,2}):(\d{2})(?:\s*([ap]m))?/i);
  if (m) [y, mo, d, h, mi] = [+m[3], MONTHS.indexOf(m[2].toLowerCase()), +m[1], +m[4], +m[5]];
  else if ((m = t.match(/^([a-z]{3})[a-z]* (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2})(?:\s*([ap]m))?/i))) [y, mo, d, h, mi] = [+m[3], MONTHS.indexOf(m[1].toLowerCase()), +m[2], +m[4], +m[5]];
  else if ((m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/))) [y, mo, d, h, mi] = [+m[1], +m[2] - 1, +m[3], +m[4], +m[5]];
  else return null;
  const ampm = m[6]?.toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (mo < 0 || h > 23 || mi > 59) return null;
  const date = new Date(y, mo, d, h, mi);
  return date.getDate() === d ? date : null;
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || !s.trim()) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Hevy's "Export workouts" CSV: one row per set, newest workout first. */
export function workoutsFromHevyCsv(text: string): Workout[] {
  const [head, ...rows] = parseCsv(text);
  if (!head) throw new Error('The file is empty.');
  const col = Object.fromEntries(head.map((h, i) => [h.trim().toLowerCase(), i]));
  const missing = ['title', 'start_time', 'end_time', 'exercise_title', 'set_index', 'weight_kg', 'reps'].filter((c) => !(c in col));
  if (missing.length) {
    const lbs = 'weight_lbs' in col ? ' It’s in pounds: set Hevy to kg (Settings › Units) and export again.' : '';
    throw new Error(`This doesn’t look like a Hevy workout export: it has no ${missing.join(', ')} column${missing.length > 1 ? 's' : ''}.${lbs}`);
  }
  const at = (r: string[], c: string) => (c in col ? r[col[c]] ?? '' : '');

  const byKey = new Map<string, Workout>();
  const lastIndex = new Map<string, number>();
  rows.forEach((r, i) => {
    const startText = at(r, 'start_time');
    const key = `${startText}\u0000${at(r, 'title')}`;
    let w = byKey.get(key);
    if (!w) {
      const start = parseHevyTime(startText);
      if (!start) throw new Error(`Row ${i + 2} has a start time Launchpad can’t read: “${startText}”.`);
      const end = parseHevyTime(at(r, 'end_time')) ?? start;
      w = { id: 'h' + start.getTime().toString(36), title: at(r, 'title').trim() || 'Workout', start: start.toISOString(), end: end.toISOString(), exercises: [] };
      byKey.set(key, w);
    }
    const title = at(r, 'exercise_title').trim();
    if (!title) return;
    const setIndex = num(at(r, 'set_index')) ?? 0;
    // A new exercise starts when the name changes or the set count starts again.
    let ex = w.exercises[w.exercises.length - 1];
    if (!ex || ex.title !== title || setIndex <= (lastIndex.get(key) ?? -1)) {
      ex = { title, notes: at(r, 'exercise_notes').trim(), sets: [] };
      w.exercises.push(ex);
    }
    lastIndex.set(key, setIndex);
    const type = at(r, 'set_type').trim().toLowerCase() as SetType;
    ex.sets.push({
      type: SET_TYPES.includes(type) ? type : 'normal',
      kg: num(at(r, 'weight_kg')),
      reps: num(at(r, 'reps')),
      km: num(at(r, 'distance_km')),
      sec: num(at(r, 'duration_seconds')),
      rpe: num(at(r, 'rpe')),
    });
  });
  // Two workouts can't share an id, even if they started in the same minute.
  const seen = new Set<string>();
  const list = [...byKey.values()].map((w) => {
    let id = w.id;
    for (let n = 2; seen.has(id); n++) id = `${w.id}-${n}`;
    seen.add(id);
    return { ...w, id };
  });
  if (!list.length) throw new Error('There are no workouts in this file.');
  return sortWorkouts(list);
}

// ---------- cleaning ----------

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e6 ? v : null);

/** Newest first. */
const sortWorkouts = (list: Workout[]) => [...list].sort((a, b) => Date.parse(b.start) - Date.parse(a.start));

export function cleanTraining(v: unknown): Training {
  const t = (v && typeof v === 'object' ? v : {}) as Partial<Training>;
  const workouts = (Array.isArray(t.workouts) ? t.workouts : []).slice(0, MAX_WORKOUTS).flatMap((w: Partial<Workout>): Workout[] => {
    if (!w || !isIso(w.start)) return [];
    const exercises = (Array.isArray(w.exercises) ? w.exercises : []).slice(0, MAX_EXERCISES).flatMap((e: Partial<WorkoutExercise>): WorkoutExercise[] => {
      if (!e || !str(e.title, 120).trim()) return [];
      const sets = (Array.isArray(e.sets) ? e.sets : []).slice(0, MAX_SETS).map((s: Partial<WorkoutSet>): WorkoutSet => ({
        type: SET_TYPES.includes(s?.type as SetType) ? s!.type! : 'normal',
        kg: optNum(s?.kg),
        reps: optNum(s?.reps),
        km: optNum(s?.km),
        sec: optNum(s?.sec),
        rpe: optNum(s?.rpe),
      }));
      return [{ title: str(e.title, 120).trim(), notes: str(e.notes, 500), sets }];
    });
    return [{ id: str(w.id, 40) || 'h' + Date.parse(w.start).toString(36), title: str(w.title, 120) || 'Workout', start: w.start, end: isIso(w.end) ? w.end : w.start, exercises }];
  });
  return {
    workouts: sortWorkouts(workouts),
    source: t.source === 'csv' ? 'csv' : '',
    importedAt: isIso(t.importedAt) ? t.importedAt : null,
  };
}

// ---------- muscles ----------

export type { Muscle };

export const MUSCLES: Muscle[] = [
  'chest', 'lats', 'upper_back', 'shoulders', 'biceps', 'triceps', 'forearms', 'traps', 'lower_back',
  'quadriceps', 'hamstrings', 'glutes', 'calves', 'abductors', 'adductors', 'abdominals', 'neck', 'full_body', 'cardio', 'other',
];

export const MUSCLE_NAMES: Record<Muscle, string> = {
  chest: 'Chest', lats: 'Lats', upper_back: 'Upper back', shoulders: 'Shoulders', biceps: 'Biceps', triceps: 'Triceps',
  forearms: 'Forearms', traps: 'Traps', lower_back: 'Lower back', quadriceps: 'Quads', hamstrings: 'Hamstrings',
  glutes: 'Glutes', calves: 'Calves', abductors: 'Abductors', adductors: 'Adductors', abdominals: 'Abs', neck: 'Neck',
  full_body: 'Full body', cardio: 'Cardio', other: 'Other',
};

/** Always listed in Sets per muscle, so one that's skipped shows as zero. */
export const MAIN_MUSCLES: Muscle[] = ['chest', 'lats', 'upper_back', 'shoulders', 'biceps', 'triceps', 'quadriceps', 'hamstrings', 'glutes', 'calves', 'abdominals'];

/** A set counts in full for the main muscle and this much for each secondary one. */
export const SECONDARY_SHARE = 0.5;

// The export only has exercise names. Claude reads what each one trains when
// there's an API key (server/src/training.ts); these rules cover the rest.
// Checked in order: "Leg Curl" is hamstrings before "curl" is biceps, "Triceps Kickback" before "kickback" is glutes.
const MUSCLE_RULES: [RegExp, Muscle, Muscle[]][] = [
  [/treadmill|running|\brun\b|cycling|bike|elliptical|stair|rowing machine|rower|jump rope|walking|swimming|hiit/, 'cardio', []],
  [/tricep|push ?down|skull ?crusher|\bdips?\b|close grip bench|jm press/, 'triceps', []],
  [/leg curl|hamstring|nordic/, 'hamstrings', []],
  [/romanian|\brdl\b|stiff leg|good morning/, 'hamstrings', ['glutes', 'lower_back']],
  [/leg extension|sissy/, 'quadriceps', []],
  [/leg press|squat|lunge|step up/, 'quadriceps', ['glutes']],
  [/hip thrust|glute bridge|\bbridge/, 'glutes', ['hamstrings']],
  [/glute|kickback/, 'glutes', []],
  [/abduct/, 'abductors', []],
  [/adduct/, 'adductors', []],
  [/\bcalf|calves/, 'calves', []],
  [/crunch|sit ?up|leg raise|knee raise|plank|ab wheel|russian twist|hollow|v ?up|dead bug|wood ?chop|pallof/, 'abdominals', []],
  [/deadlift/, 'lower_back', ['glutes', 'hamstrings']],
  [/back extension|hyperextension|superman/, 'lower_back', ['glutes']],
  [/shrug/, 'traps', []],
  [/pull ?down|pull ?up|chin ?up/, 'lats', ['biceps', 'upper_back']],
  [/pullover|straight arm/, 'lats', []],
  [/face pull|rear delt|reverse fly|reverse pec/, 'shoulders', ['upper_back']],
  [/shoulder press|overhead press|military|arnold/, 'shoulders', ['triceps']],
  [/lateral raise|front raise|y raise/, 'shoulders', []],
  [/upright row/, 'shoulders', ['traps']],
  [/wrist|forearm|farmer|reverse curl/, 'forearms', []],
  [/curl|bicep/, 'biceps', ['forearms']],
  [/\brow/, 'upper_back', ['lats', 'biceps']],
  [/bench press|chest press|push ?up|incline press|decline press/, 'chest', ['triceps', 'shoulders']],
  [/chest|\bfly|flye|crossover|pec deck|incline|decline/, 'chest', ['shoulders']],
];

function ruleFor(exercise: string): ExerciseMuscles {
  const t = exercise.toLowerCase();
  const rule = MUSCLE_RULES.find(([re]) => re.test(t));
  return rule ? { primary: rule[1], secondary: rule[2] } : { primary: 'other', secondary: [] };
}

/** The main muscle an exercise trains, from its name alone. */
export const muscleOf = (exercise: string): Muscle => ruleFor(exercise).primary;

/** What an exercise trains: Claude's reading when there is one, else the name rules. */
export const musclesOf = (exercise: string, map?: Record<string, ExerciseMuscles>): ExerciseMuscles => map?.[exercise] ?? ruleFor(exercise);

/** Every exercise name in the workouts, once. */
export const exerciseNames = (workouts: Workout[]) => [...new Set(workouts.flatMap((w) => w.exercises.map((e) => e.title)))];

/** Keeps what Claude sent back to known muscle names, and only for exercises that were asked about. */
export function cleanMuscleMap(list: unknown, asked: string[]): Record<string, ExerciseMuscles> {
  const out: Record<string, ExerciseMuscles> = {};
  const wanted = new Set(asked);
  for (const x of Array.isArray(list) ? list : []) {
    const { name, primary, secondary } = (x ?? {}) as { name?: unknown; primary?: unknown; secondary?: unknown };
    if (typeof name !== 'string' || !wanted.has(name) || !MUSCLES.includes(primary as Muscle)) continue;
    const sec = (Array.isArray(secondary) ? secondary : []).filter((m): m is Muscle => MUSCLES.includes(m as Muscle) && m !== primary && m !== 'other');
    out[name] = { primary: primary as Muscle, secondary: [...new Set(sec)].slice(0, 4) };
  }
  return out;
}

// ---------- sets and sessions ----------

/** Warmups don't count towards sets, volume or bests. */
const working = (s: WorkoutSet) => s.type !== 'warmup';

export const workingSets = (w: Workout) => w.exercises.reduce((n, e) => n + e.sets.filter(working).length, 0);

/** Kilograms lifted: weight × reps over the working sets. */
export const volumeKg = (w: Workout) =>
  w.exercises.reduce((v, e) => v + e.sets.filter(working).reduce((s, x) => s + (x.kg ?? 0) * (x.reps ?? 0), 0), 0);

export const minutes = (w: Workout) => Math.max(0, Math.round((Date.parse(w.end) - Date.parse(w.start)) / 60_000));

/** Epley: weight × (1 + reps ÷ 30). Past 20 reps it says little, so those sets are left out. */
export function e1rm(kg: number, reps: number): number | null {
  if (!(kg > 0) || !(reps >= 1) || reps > 20) return null;
  return reps === 1 ? kg : kg * (1 + reps / 30);
}

/** What a lift is measured by: estimated 1RM when it's weighted, else reps, else time or distance. */
export type LiftMeasure = 'e1rm' | 'reps' | 'sec' | 'km';

export function measureOf(sets: WorkoutSet[]): LiftMeasure {
  if (sets.some((s) => (s.kg ?? 0) > 0 && (s.reps ?? 0) > 0)) return 'e1rm';
  if (sets.some((s) => (s.reps ?? 0) > 0)) return 'reps';
  if (sets.some((s) => (s.km ?? 0) > 0)) return 'km';
  return 'sec';
}

/** The best value of one exercise in one session, by its measure. */
export function bestOf(sets: WorkoutSet[], measure: LiftMeasure): number | null {
  let best: number | null = null;
  for (const s of sets.filter(working)) {
    const v = measure === 'e1rm' ? e1rm(s.kg ?? 0, s.reps ?? 0) : measure === 'reps' ? s.reps : measure === 'km' ? s.km : s.sec;
    if (v !== null && v > 0 && (best === null || v > best)) best = v;
  }
  return best;
}

/** The heaviest working set (most reps breaks a tie), or the longest when there's no weight. */
export function topSet(sets: WorkoutSet[]): WorkoutSet | null {
  const w = sets.filter(working);
  if (!w.length) return null;
  return w.reduce((a, b) => {
    const ka = a.kg ?? 0;
    const kb = b.kg ?? 0;
    if (kb !== ka) return kb > ka ? b : a;
    if ((b.reps ?? 0) !== (a.reps ?? 0)) return (b.reps ?? 0) > (a.reps ?? 0) ? b : a;
    return (b.km ?? 0) + (b.sec ?? 0) / 1e4 > (a.km ?? 0) + (a.sec ?? 0) / 1e4 ? b : a;
  });
}

/** "48.75", "50", "2.5" */
export const fmtKg = (n: number) => String(Math.round(n * 100) / 100);

/** "50 kg × 14", "× 8" (bodyweight), "2.17 km", "16:50" */
export function fmtSet(s: WorkoutSet): string {
  if ((s.kg ?? 0) > 0 && (s.reps ?? 0) > 0) return `${fmtKg(s.kg!)} × ${s.reps}`;
  if ((s.reps ?? 0) > 0) return `${(s.kg ?? 0) > 0 ? fmtKg(s.kg!) + ' kg' : 'bodyweight'} × ${s.reps}`;
  if ((s.km ?? 0) > 0) return `${fmtKg(s.km!)} km${s.sec ? ' · ' + fmtClock(s.sec) : ''}`;
  if ((s.sec ?? 0) > 0) return fmtClock(s.sec!);
  return '–';
}

/** 1010 → "16:50", 3725 → "1:02:05" */
export function fmtClock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 61 → "1 h 01", 45 → "45 min" */
export function fmtMinutes(m: number): string {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/** Hevy names a workout after the time of day unless it's renamed. */
const AUTO_TITLE = /^(early |late )?(morning|afternoon|evening|night|midnight|lunch(time)?) workout\b|^workout$/i;

type MuscleMap = Record<string, ExerciseMuscles>;

/** The main muscles of a workout by working sets, most first: ["chest", "triceps"]. */
export function workoutMuscles(w: Workout, n = 2, map?: MuscleMap): Muscle[] {
  const counts = new Map<Muscle, number>();
  for (const e of w.exercises) {
    const m = musclesOf(e.title, map).primary;
    if (m !== 'other') counts.set(m, (counts.get(m) ?? 0) + Math.max(1, e.sets.filter(working).length));
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([m]) => m);
}

/** The workout's own name, or what it trained when Hevy named it after the time of day: "Chest · Shoulders". */
export function workoutLabel(w: Workout, map?: MuscleMap): string {
  if (!AUTO_TITLE.test(w.title.trim())) return w.title;
  const muscles = workoutMuscles(w, 2, map);
  return muscles.length ? muscles.map((m) => MUSCLE_NAMES[m]).join(' · ') : w.title;
}

// ---------- weeks ----------

/** Weeks start on Monday. */
export function weekStart(d: Date): Date {
  const s = startOfDay(d);
  return addDays(s, -((s.getDay() + 6) % 7));
}

const inRange = (w: Workout, from: Date, to: Date) => {
  const t = Date.parse(w.start);
  return t >= from.getTime() && t < to.getTime();
};

export interface WeekSummary {
  /** Monday to Sunday, each with the workouts that started that day, earliest first. */
  days: { date: Date; workouts: Workout[] }[];
  sessions: number;
  minutes: number;
  sets: number;
  volume: number;
}

export function weekSummary(workouts: Workout[], today: Date): WeekSummary {
  const mon = weekStart(today);
  const week = workouts.filter((w) => inRange(w, mon, addDays(mon, 7)));
  const days = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(mon, i);
    return { date, workouts: week.filter((w) => inRange(w, date, addDays(date, 1))).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)) };
  });
  return {
    days,
    sessions: week.length,
    minutes: week.reduce((n, w) => n + minutes(w), 0),
    sets: week.reduce((n, w) => n + workingSets(w), 0),
    volume: week.reduce((n, w) => n + volumeKg(w), 0),
  };
}

/** Sessions in each of the last `n` weeks, this one last. */
export function weeklyCounts(workouts: Workout[], today: Date, n: number): { start: Date; count: number }[] {
  const first = addDays(weekStart(today), -7 * (n - 1));
  const counts = new Array<number>(n).fill(0);
  for (const w of workouts) {
    const i = Math.floor(dayDiff(first, new Date(w.start)) / 7);
    if (i >= 0 && i < n) counts[i]++;
  }
  return counts.map((count, i) => ({ start: addDays(first, i * 7), count }));
}

/** Weeks in a row with at least one session. This week counts once it has one; until then the run up to last week still stands. */
export function weekStreak(workouts: Workout[], today: Date): number {
  const weeks = new Set(workouts.map((w) => weekStart(new Date(w.start)).getTime()));
  let week = weekStart(today);
  if (!weeks.has(week.getTime())) week = addDays(week, -7);
  let n = 0;
  while (weeks.has(week.getTime())) n++, (week = addDays(week, -7));
  return n;
}

// ---------- muscles over a window ----------

/** Working sets per muscle over the last `days` days, ending today: a full set for the main muscle, half for each secondary one.
 *  Main muscles are listed even at zero; cardio isn't counted. */
export function setsPerMuscle(workouts: Workout[], today: Date, days: number, map?: MuscleMap): { muscle: Muscle; sets: number }[] {
  const from = addDays(startOfDay(today), -(days - 1));
  const to = addDays(startOfDay(today), 1);
  const counts = new Map<Muscle, number>(MAIN_MUSCLES.map((m) => [m, 0]));
  const add = (m: Muscle, n: number) => m !== 'cardio' && m !== 'other' && m !== 'full_body' && counts.set(m, (counts.get(m) ?? 0) + n);
  for (const w of workouts.filter((x) => inRange(x, from, to))) {
    for (const e of w.exercises) {
      const { primary, secondary } = musclesOf(e.title, map);
      if (primary === 'cardio') continue;
      const n = e.sets.filter(working).length;
      if (primary === 'other' || primary === 'full_body') counts.set(primary, (counts.get(primary) ?? 0) + n);
      else add(primary, n);
      for (const m of secondary) add(m, n * SECONDARY_SHARE);
    }
  }
  return [...counts]
    .filter(([m, n]) => n > 0 || MAIN_MUSCLES.includes(m))
    .map(([muscle, sets]) => ({ muscle, sets }))
    .sort((a, b) => b.sets - a.sets || rank(a.muscle) - rank(b.muscle));
}

/** Main muscles in their usual order, then the rest. */
const rank = (m: Muscle) => (MAIN_MUSCLES.includes(m) ? MAIN_MUSCLES.indexOf(m) : MAIN_MUSCLES.length + MUSCLES.indexOf(m));

// ---------- lifts ----------

type Session = { workoutId: string; at: string; sets: WorkoutSet[] };

/** Every exercise's sessions, oldest first. The same exercise twice in one workout is one session. Cardio is left out. */
function sessionsByExercise(workouts: Workout[], map?: MuscleMap): Map<string, Session[]> {
  const out = new Map<string, Session[]>();
  for (const w of [...workouts].reverse()) {
    for (const e of w.exercises) {
      if (musclesOf(e.title, map).primary === 'cardio' || !e.sets.some(working)) continue;
      const list = out.get(e.title) ?? [];
      const last = list[list.length - 1];
      if (last?.workoutId === w.id) last.sets.push(...e.sets);
      else list.push({ workoutId: w.id, at: w.start, sets: [...e.sets] });
      out.set(e.title, list);
    }
  }
  return out;
}

export interface LiftTrend {
  title: string;
  measure: LiftMeasure;
  /** One point per session in the window, oldest first. */
  points: { at: string; value: number }[];
  /** The latest session's best and top set, which may be before the window. */
  latest: number | null;
  top: WorkoutSet | null;
  /** Sessions in all history. */
  sessions: number;
  /** The latest session beat every earlier one, across all history. */
  pr: boolean;
  pinned: boolean;
}

/** Pinned lifts first, then the exercises done in the most sessions over the last `weeks` weeks (at least two each), up to `n` in all. */
export function liftTrends(workouts: Workout[], today: Date, opts: { weeks?: number; n?: number; pinned?: string[]; muscles?: MuscleMap } = {}): LiftTrend[] {
  const { weeks = 12, n = 5, pinned = [], muscles } = opts;
  const from = addDays(startOfDay(today), -7 * weeks + 1).getTime();
  const sessions = sessionsByExercise(workouts, muscles);
  const recent = (title: string) => (sessions.get(title) ?? []).filter((s) => Date.parse(s.at) >= from);
  const pins = pinned.filter((t) => sessions.has(t));
  const most = [...sessions.keys()]
    .filter((t) => !pins.includes(t) && recent(t).length >= 2)
    .sort((a, b) => recent(b).length - recent(a).length || Date.parse(recent(b).at(-1)!.at) - Date.parse(recent(a).at(-1)!.at));
  return [...pins, ...most.slice(0, Math.max(0, n - pins.length))].map((title): LiftTrend => {
    const all = sessions.get(title)!;
    const measure = measureOf(all.flatMap((s) => s.sets));
    const points = recent(title).flatMap((s) => {
      const value = bestOf(s.sets, measure);
      return value === null ? [] : [{ at: s.at, value }];
    });
    const latest = all[all.length - 1];
    const latestBest = bestOf(latest.sets, measure);
    const before = all.slice(0, -1).map((s) => bestOf(s.sets, measure) ?? 0);
    return {
      title,
      measure,
      points,
      latest: latestBest,
      top: topSet(latest.sets),
      sessions: all.length,
      pr: latestBest !== null && before.length > 0 && latestBest > Math.max(...before),
      pinned: pins.includes(title),
    };
  });
}

export interface ExerciseHistory {
  title: string;
  measure: LiftMeasure;
  /** Newest first, with every set and the session's best. */
  sessions: { workoutId: string; at: string; sets: WorkoutSet[]; best: number | null; pr: boolean }[];
  best: { value: number; at: string } | null;
}

/** Every session of one exercise, for its history drawer. */
export function exerciseHistory(workouts: Workout[], title: string): ExerciseHistory {
  const all = sessionsByExercise(workouts).get(title) ?? [];
  const measure = measureOf(all.flatMap((s) => s.sets));
  let top: { value: number; at: string } | null = null;
  const rows = all.map((s) => {
    const best = bestOf(s.sets, measure);
    const pr = best !== null && top !== null && best > top.value;
    if (best !== null && (!top || best > top.value)) top = { value: best, at: s.at };
    return { workoutId: s.workoutId, at: s.at, sets: s.sets, best, pr };
  });
  return { title, measure, sessions: rows.reverse(), best: top };
}

/** Exercises in each workout that beat every earlier session of that exercise, keyed by workout id. */
export function prsByWorkout(workouts: Workout[], map?: MuscleMap): Map<string, string[]> {
  const best = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const [title, list] of sessionsByExercise(workouts, map)) {
    const measure = measureOf(list.flatMap((s) => s.sets));
    for (const s of list) {
      const v = bestOf(s.sets, measure);
      if (v === null) continue;
      const prev = best.get(title);
      if (prev !== undefined && v > prev) out.set(s.workoutId, [...(out.get(s.workoutId) ?? []), title]);
      if (prev === undefined || v > prev) best.set(title, v);
    }
  }
  return out;
}

// ---------- gym ----------

/** The newest workout and how many days ago it was (0 is today). */
export function lastTrained(workouts: Workout[], today: Date): { workout: Workout; days: number } | null {
  const w = workouts[0];
  return w ? { workout: w, days: dayDiff(new Date(w.start), today) } : null;
}

/** Sessions in a month (YYYY-MM) and what each cost, from the monthly gym fee. */
export function gymPerSession(monthly: number, workouts: Workout[], month: string): { sessions: number; perSession: number | null } {
  const sessions = workouts.filter((w) => ymd(new Date(w.start)).startsWith(month)).length;
  return { sessions, perSession: monthly > 0 && sessions ? Math.round((monthly / sessions) * 100) / 100 : null };
}

/** Calendar events that look like a gym block. */
const GYM_EVENT = /\b(gym|work ?out|training|lifting|weights|leg day|push day|pull day)\b/i;
/** How far a logged workout can start before or end after the block and still count as it. */
const GYM_SLACK = 90 * 60_000;

/** The workout logged for a gym block in the calendar, if there is one. */
export function gymWorkout(event: { title: string; start: string; end: string }, workouts: Workout[]): Workout | null {
  if (!GYM_EVENT.test(event.title)) return null;
  const s = Date.parse(event.start) - GYM_SLACK;
  const e = Date.parse(event.end) + GYM_SLACK;
  return workouts.find((w) => Date.parse(w.start) < e && Date.parse(w.end) > s) ?? null;
}

// ---------- body weight ----------

export const MIN_KG = 20;
export const MAX_KG = 400;

/** Kilograms to two decimals, or null when it isn't a body weight. */
export function cleanKg(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_KG && n <= MAX_KG ? Math.round(n * 100) / 100 : null;
}

/** ⌘K: "weight 72.4", "w 72,4 kg", "log weight 72.4" → 72.4. */
export function parseWeight(q: string): number | null {
  const m = q.trim().match(/^(?:log\s+)?(?:weight|weigh|w)\s+(\d{2,3}(?:[.,]\d{1,2})?)\s*(?:kg)?$/i);
  return m ? cleanKg(m[1]) : null;
}

export interface WeightPoint {
  /** YYYY-MM-DD. */
  date: string;
  kg: number;
  /** Average of the entries in the 7 days up to and including this one, which smooths out water and food from day to day. */
  avg: number;
}

/** Every entry, oldest first, with its 7-day average. */
export function weightSeries(weights: Record<string, number>): WeightPoint[] {
  const dates = Object.keys(weights).sort();
  return dates.map((date, i) => {
    const from = ymd(addDays(new Date(date + 'T00:00:00'), -6));
    const week = dates.slice(0, i + 1).filter((d) => d >= from).map((d) => weights[d]);
    return { date, kg: weights[date], avg: Math.round((week.reduce((a, b) => a + b, 0) / week.length) * 100) / 100 };
  });
}

/**
 * The latest 7-day average against the one `days` before it. Without an entry that far back, against the first entry in those
 * days, so a log that's only weeks old still shows a change. `since` is the date compared with; null with fewer than two entries.
 */
export function weightChange(series: WeightPoint[], days: number): { kg: number; since: string; full: boolean } | null {
  const last = series[series.length - 1];
  if (!last) return null;
  const cutoff = ymd(addDays(new Date(last.date + 'T00:00:00'), -days));
  const before = [...series].reverse().find((p) => p.date <= cutoff);
  const then = before ?? series.find((p) => p.date > cutoff);
  if (!then || then === last) return null;
  return { kg: Math.round((last.avg - then.avg) * 100) / 100, since: then.date, full: !!before };
}
