// Claude's two jobs for Training: reading what each exercise trains (once per
// new exercise name, saved), and a short note on the training after an import.
// Both need ANTHROPIC_API_KEY; without it the page uses the name rules in
// shared/training.ts and shows no note.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { store } from './store';
import { DOW, MON, addDays, startOfDay } from '../../shared/dates';
import {
  MUSCLES, MUSCLE_NAMES, cleanMuscleMap, exerciseNames, fmtSet, liftTrends, minutes, musclesOf, setsPerMuscle, weekSummary, weeklyCounts, workingSets,
} from '../../shared/training';
import type { ExerciseMuscles, Training, TrainingNote } from '../../shared/types';

// ---------- muscles ----------

const MUSCLE_SYSTEM = `You label gym exercises with the muscles they train, for a training log. You get exercise names as Hevy (the workout app) writes them, such as "Iso-Lateral Row (Machine)" or "Bulgarian Split Squat (Dumbbell)".

For each one give:
- primary: the one muscle group it mainly trains
- secondary: up to three groups it works noticeably less, or none

Use only these names: ${MUSCLES.join(', ')}. Use "cardio" for conditioning machines and runs, and "other" only when the name gives no clue. Follow how Hevy itself labels its built-in exercises when you know it.`;

const MUSCLE_SCHEMA = {
  type: 'object',
  properties: {
    exercises: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          primary: { type: 'string', enum: MUSCLES },
          secondary: { type: 'array', items: { type: 'string', enum: MUSCLES } },
        },
        required: ['name', 'primary', 'secondary'],
        additionalProperties: false,
      },
    },
  },
  required: ['exercises'],
  additionalProperties: false,
};

/** Names asked about at once; a first import of a long history can have a few hundred. */
const MUSCLE_BATCH = 80;

/** Ask Claude about exercise names it hasn't labelled yet and save the answers. Returns the whole map. */
export async function labelExercises(training: Training): Promise<Record<string, ExerciseMuscles>> {
  const known = store.exerciseMuscles();
  const todo = exerciseNames(training.workouts).filter((n) => !known[n]);
  if (!claudeEnabled() || !todo.length) return known;
  for (let i = 0; i < todo.length; i += MUSCLE_BATCH) {
    const batch = todo.slice(i, i + MUSCLE_BATCH);
    const res = await askJson<{ exercises: unknown[] }>({
      model: config.trainingModel,
      system: MUSCLE_SYSTEM,
      user: batch.join('\n'),
      schema: MUSCLE_SCHEMA,
      effort: 'low',
      task: 'label these exercises',
    });
    Object.assign(known, cleanMuscleMap(res.exercises, batch));
    store.setExerciseMuscles(known);
  }
  return known;
}

// ---------- the note ----------

const NOTE_SYSTEM = `You write a short note about someone's strength training on their personal dashboard, from their workout log. They read it on a new browser tab, so it has to be quick to take in.

Write:
- headline: one or two sentences on how this week and the last few have gone, with real numbers from the log
- points: two to four short points, each one specific thing worth knowing or trying next, such as a muscle group that's being skipped, a lift that's stalled or climbing, or how often they're training

Only use what's in the log. Be plain and direct, like a training partner who has read the numbers; don't cheer, scold or pad. No emoji, no medical or diet advice. Weights are in kg. Est. 1RM is an estimated one-rep max from the best set (weight × (1 + reps ÷ 30)).`;

const NOTE_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    points: { type: 'array', items: { type: 'string' } },
  },
  required: ['headline', 'points'],
  additionalProperties: false,
};

const day = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;

/** The log as Claude reads it: totals, sets per muscle, lift trends and the last four weeks of workouts. */
export function noteInput(training: Training, muscles: Record<string, ExerciseMuscles>, setsPerWeek: number, now: Date): string {
  const today = startOfDay(now);
  const ws = training.workouts;
  const week = weekSummary(ws, today);
  const lines = [
    `Today is ${day(today)} ${today.getFullYear()}. Weeks start on Monday.`,
    `Their target: ${setsPerWeek} working sets a week per muscle.`,
    `This week so far: ${week.sessions} sessions, ${week.minutes} min, ${week.sets} working sets, ${Math.round(week.volume)} kg lifted.`,
    `Sessions a week, last 12 weeks, oldest first: ${weeklyCounts(ws, today, 12).map((w) => w.count).join(', ')}.`,
    `Working sets per muscle in the last 4 weeks (secondary muscles count half): ${setsPerMuscle(ws, today, 28, muscles).map((m) => `${MUSCLE_NAMES[m.muscle]} ${m.sets}`).join(', ')}.`,
    '',
    'Most-done exercises over 12 weeks, best per session oldest first:',
    ...liftTrends(ws, today, { muscles }).map((l) => {
      const unit = l.measure === 'e1rm' ? 'kg est. 1RM' : l.measure === 'reps' ? 'reps' : l.measure === 'km' ? 'km' : 'seconds';
      return `- ${l.title}: ${l.points.map((p) => Math.round(p.value * 10) / 10).join(', ')} (${unit}); latest top set ${l.top ? fmtSet(l.top) : 'none'}${l.pr ? '; latest is a new best' : ''}`;
    }),
    '',
    'Workouts in the last 4 weeks, newest first:',
  ];
  const from = addDays(today, -27).getTime();
  for (const w of ws.filter((x) => Date.parse(x.start) >= from)) {
    const start = new Date(w.start);
    lines.push(`- ${day(start)}, ${minutes(w)} min, ${workingSets(w)} working sets: ${w.title}`);
    for (const e of w.exercises) {
      const m = musclesOf(e.title, muscles);
      const sets = e.sets.filter((s) => s.type !== 'warmup').map(fmtSet).join(', ');
      lines.push(`  · ${e.title} [${MUSCLE_NAMES[m.primary]}]: ${sets || 'no working sets'}${e.notes ? ` (note: ${e.notes})` : ''}`);
    }
  }
  return lines.join('\n');
}

let writing: Promise<void> | null = null;

/**
 * Label any new exercises, then write a note when there isn't one for the newest workout yet (or always, with `force`).
 * Failures are kept for the page to show. Runs one at a time.
 */
export function refreshTraining(force = false): Promise<void> {
  writing ??= (async () => {
    const training = store.training();
    const state = store.trainingNote();
    if (!claudeEnabled() || !training.workouts.length) {
      store.setTrainingNote({ note: null, error: null });
      return;
    }
    try {
      const muscles = await labelExercises(training);
      const latest = training.workouts[0].start;
      if (!force && state.note?.latest === latest && !state.error) return;
      const res = await askJson<{ headline: string; points: string[] }>({
        model: config.trainingModel,
        system: NOTE_SYSTEM,
        user: noteInput(training, muscles, store.prefs().setsPerWeek, new Date()),
        schema: NOTE_SCHEMA,
        effort: 'low',
        task: 'write a note on this training',
      });
      const note: TrainingNote = { headline: res.headline.trim(), points: res.points.map((p) => p.trim()).filter(Boolean).slice(0, 5), writtenAt: new Date().toISOString(), latest };
      store.setTrainingNote({ note, error: null });
    } catch (e) {
      store.setTrainingNote({ note: state.note, error: (e as Error).message });
    }
  })().finally(() => {
    writing = null;
  });
  return writing;
}
