// Claude's job for Training: reading what each exercise trains (once per new
// exercise name, saved). Needs ANTHROPIC_API_KEY; without it the page uses the
// name rules in shared/training.ts.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { store } from './store';
import { MUSCLES, cleanMuscleMap, exerciseNames } from '../../shared/training';
import type { ExerciseMuscles, Training } from '../../shared/types';

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
      feature: 'training',
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

// ---------- refresh ----------

let labelling: Promise<void> | null = null;

/** Label any exercises Claude hasn't read yet, one run at a time. Failures are logged; the page falls back to name rules. */
export function refreshTraining(): Promise<void> {
  labelling ??= (async () => {
    const training = store.training();
    if (!claudeEnabled() || !training.workouts.length) return;
    try {
      await labelExercises(training);
    } catch (e) {
      console.error('Labelling exercises failed:', (e as Error).message);
    }
  })().finally(() => {
    labelling = null;
  });
  return labelling;
}
