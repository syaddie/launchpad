// What the page shows (AppState), built from the store. The page fetches all of it on load
// and as a backstop; when the change stream says which store keys changed, it fetches
// only the parts those keys feed (GET /api/state?keys=…).
import { config, googleConfigured } from './config';
import { claudeEnabled } from './claude';
import { missingScopes } from './google';
import { driveStatus } from './drive';
import { currentWarnings } from './health';
import { docVersion, store } from './store';
import type { AppState, NewsTopic, Photo, SavedDoc } from '../../shared/types';

type Field = Exclude<keyof AppState, 'versions'>;

/** Bodies and the ids behind each digest stay on the server. */
function inboxState(): AppState['inbox'] {
  const { emails, digests, fetchedAt, error } = store.inbox();
  const digest = (d: (typeof digests)['2d']) => d && { overview: d.overview, items: d.items, skimmed: d.skimmed, emailCount: d.emailCount, summarisedAt: d.summarisedAt };
  return {
    emails: emails.map(({ body: _, ...e }) => e),
    digests: { '2d': digest(digests['2d']), '7d': digest(digests['7d']) },
    fetchedAt,
    error,
  };
}

const SMOKES_IN_STATE = 60 * 86_400_000;
export const recentSmokes = () => store.smokes().filter((s) => Date.now() - Date.parse(s) < SMOKES_IN_STATE);

/** How each part of the page's state is made. */
const FIELDS: { [F in Field]: () => AppState[F] } = {
  bookmarks: () => store.bookmarks(),
  notes: () => store.notes(),
  prefs: () => store.prefs(),
  google: () => {
    const g = store.google();
    return { configured: googleConfigured(), connected: !!g, email: g?.email, name: g?.name, signedOut: g ? undefined : store.googleSignedOut() ?? undefined, missingScopes: g ? missingScopes() : undefined };
  },
  calendars: () => store.calendar().calendars,
  events: () => store.calendar().events,
  taskLists: () => store.tasks().lists,
  tasks: () => store.tasks().tasks,
  packages: () => store.packages().filter((p) => !p.archived),
  sync: () => store.sync(),
  tracking: () => ({ allCarriers: !!config.seventeenTrackKey }),
  // In the order of the topics in prefs; ones not fetched yet show as loading.
  news: () => {
    const news = store.news();
    return store.prefs().newsTopics.map((topic): NewsTopic => {
      const n = news[topic.toLowerCase()];
      return n
        ? { topic, articles: n.articles, stories: n.stories, summarisedAt: n.summarisedAt, fetchedAt: n.fetchedAt, error: n.error }
        : { topic, articles: [], stories: null, summarisedAt: null, fetchedAt: null, error: null };
    });
  },
  newsSummaries: () => claudeEnabled(),
  inbox: inboxState,
  weather: () => store.weather(),
  photos: () => store.photos().map(({ id, focus }): Photo => ({ id, focus })),
  countdowns: () => store.countdowns(),
  smokes: recentSmokes,
  moods: () => store.moods(),
  money: () => store.money(),
  training: () => store.training(),
  exerciseMuscles: () => (claudeEnabled() ? store.exerciseMuscles() : {}),
  trainingNote: () => (claudeEnabled() ? store.trainingNote() : { note: null, error: null }),
  weights: () => store.weights(),
  learn: () => store.learn(),
  learnNote: () => (claudeEnabled() ? store.learnNote() : { note: null, error: null }),
  drive: driveStatus,
  health: currentWarnings,
};

const SAVED: SavedDoc[] = ['bookmarks', 'notes', 'money', 'learn'];

/**
 * The parts of the page's state each store key feeds. Keys missing here aren't in the
 * page's state (Gmail ids already scanned, speed tests, upload folders). The Google
 * connection is cheap and changes along with what it syncs, so it comes with those.
 */
export const KEY_FIELDS: Record<string, Field[]> = {
  bookmarks: ['bookmarks'],
  notes: ['notes'],
  // News comes in the order of the topics in prefs.
  prefs: ['prefs', 'news', 'drive'],
  google: ['google', 'drive'],
  googleSignedOut: ['google'],
  calendar: ['calendars', 'events', 'google'],
  tasks: ['taskLists', 'tasks', 'google'],
  packages: ['packages'],
  news: ['news'],
  inbox: ['inbox', 'google'],
  weather: ['weather'],
  photos: ['photos'],
  countdowns: ['countdowns'],
  smokes: ['smokes'],
  moods: ['moods'],
  weights: ['weights'],
  money: ['money'],
  training: ['training'],
  exerciseMuscles: ['exerciseMuscles'],
  trainingNote: ['trainingNote'],
  learn: ['learn'],
  learnNote: ['learnNote'],
  sync: ['sync', 'health'],
  driveBackup: ['drive', 'health'],
  gmailSeen: [],
  registered17: [],
  speedTests: [],
  uploadDirs: [],
};

/** The fields changed store keys feed, or null when one isn't known (then send everything). */
export function fieldsFor(keys: string[]): Field[] | null {
  const out = new Set<Field>();
  for (const k of keys) {
    const f = Object.hasOwn(KEY_FIELDS, k) ? KEY_FIELDS[k] : undefined;
    if (!f) return null;
    for (const x of f) out.add(x);
  }
  return [...out];
}

/** Everything the page shows. */
export function state(): AppState {
  const s = Object.fromEntries(Object.entries(FIELDS).map(([k, make]) => [k, make()])) as unknown as AppState;
  s.versions = Object.fromEntries(SAVED.map((k) => [k, docVersion(k)]));
  return s;
}

/** Just the parts of the state these store keys feed, with the versions of any documents among them. */
export function stateFor(keys: string[]): Partial<AppState> {
  const fields = fieldsFor(keys);
  if (!fields) return state();
  const s: Partial<AppState> = Object.fromEntries(fields.map((k) => [k, FIELDS[k]()]));
  const docs = SAVED.filter((k) => fields.includes(k));
  if (docs.length) s.versions = Object.fromEntries(docs.map((k) => [k, docVersion(k)]));
  return s;
}
