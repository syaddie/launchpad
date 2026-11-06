// Validation and cleaning for full-state backups (v1 and v2).
import { DEFAULT_ENGINES, DEFAULT_PREFS, HIDEABLE_KEYS } from './defaults';
import { cleanLearn } from './learn';
import { cleanMoney } from './money';
import { MUSCLES, cleanKg, cleanTraining } from './training';
import type {
  Backup, BookmarkGroup, Countdown, ExerciseMuscles, Learn, Money, Mood, Muscle, Note, Package, Prefs, SearchEngine, Stage, TrackingEvent, Training,
} from './types';

const isStr = (v: unknown): v is string => typeof v === 'string';
const isYmd = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const isIso = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const num = (v: unknown, min: number, max: number, d: number) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;

export function validBookmarks(v: unknown): v is BookmarkGroup[] {
  return (
    Array.isArray(v) &&
    v.every(
      (g) =>
        g &&
        isStr(g.id) &&
        isStr(g.name) &&
        Array.isArray(g.items) &&
        g.items.every((b: any) => b && isStr(b.id) && isStr(b.name) && isStr(b.url)),
    )
  );
}

export function validNotes(v: unknown): v is Note[] {
  return Array.isArray(v) && v.length > 0 && v.every((n) => n && isStr(n.id) && isStr(n.name) && isStr(n.text));
}

/** Trimmed, de-duplicated (ignoring case), at most 8 topics of 60 characters. */
export function cleanTopics(v: unknown[]): string[] {
  const seen = new Set<string>();
  return v
    .filter(isStr)
    .map((t) => t.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter((t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()))
    .slice(0, 8);
}

/** Prefixes are single words, unique ignoring case; URLs must be http(s). At most 12. */
export function cleanEngines(v: unknown[]): SearchEngine[] {
  const seen = new Set<string>();
  const out: SearchEngine[] = [];
  for (const e of v as Partial<SearchEngine>[]) {
    if (!e || !isStr(e.prefix) || !isStr(e.name) || !isStr(e.url)) continue;
    const prefix = e.prefix.trim().toLowerCase().replace(/\s+/g, '').slice(0, 12);
    const url = e.url.trim();
    if (!prefix || seen.has(prefix) || !/^https?:\/\//i.test(url)) continue;
    seen.add(prefix);
    out.push({ prefix, name: e.name.trim().slice(0, 40) || prefix, url: url.slice(0, 500) });
  }
  return out.slice(0, 12);
}

export function cleanPrefs(body: Partial<Prefs> | undefined | null, prev: Prefs = DEFAULT_PREFS): Prefs {
  const b = body && typeof body === 'object' ? body : {};
  const next: Prefs = {
    name: isStr(b.name) ? b.name.slice(0, 40) : prev.name,
    theme: ['system', 'light', 'dark'].includes(b.theme as string) ? b.theme! : prev.theme,
    accent: ['sage', 'slate', 'terracotta'].includes(b.accent as string) ? b.accent! : prev.accent,
    design: ['broadsheet', 'console', 'bento', 'horizon'].includes(b.design as string) ? b.design! : prev.design ?? 'broadsheet',
    hiddenCalendars: Array.isArray(b.hiddenCalendars) ? b.hiddenCalendars.filter(isStr) : prev.hiddenCalendars,
    sources: {
      calendar: typeof b.sources?.calendar === 'boolean' ? b.sources.calendar : prev.sources.calendar,
      tasks: typeof b.sources?.tasks === 'boolean' ? b.sources.tasks : prev.sources.tasks,
      gmail: typeof b.sources?.gmail === 'boolean' ? b.sources.gmail : prev.sources.gmail,
    },
    newsTopics: Array.isArray(b.newsTopics) ? cleanTopics(b.newsTopics) : prev.newsTopics,
    weatherArea: isStr(b.weatherArea) ? b.weatherArea.trim().slice(0, 60) : prev.weatherArea,
    aboutMe: isStr(b.aboutMe) ? b.aboutMe.trim().slice(0, 1000) : prev.aboutMe,
    hidden: Array.isArray(b.hidden) ? [...new Set(b.hidden.filter((h) => isStr(h) && HIDEABLE_KEYS.includes(h)))] : prev.hidden,
    searchEngines: Array.isArray(b.searchEngines) ? cleanEngines(b.searchEngines) : prev.searchEngines,
    cigaretteLimit: num(b.cigaretteLimit, 0, 99, prev.cigaretteLimit),
    speedTestHours: num(b.speedTestHours, 0, 24, prev.speedTestHours),
    speedPlanMbps: num(b.speedPlanMbps, 0, 100_000, prev.speedPlanMbps),
    setsPerWeek: num(b.setsPerWeek, 1, 40, prev.setsPerWeek),
    gymMonthly: typeof b.gymMonthly === 'number' && Number.isFinite(b.gymMonthly) ? Math.min(10_000, Math.max(0, Math.round(b.gymMonthly * 100) / 100)) : prev.gymMonthly,
    pinnedLifts: Array.isArray(b.pinnedLifts) ? [...new Set(b.pinnedLifts.filter(isStr).map((t) => t.slice(0, 120)))].slice(0, 12) : prev.pinnedLifts,
  };
  if (!next.searchEngines.length) next.searchEngines = DEFAULT_ENGINES;
  return next;
}

export function cleanCountdowns(v: unknown): Countdown[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x: Partial<Countdown>) => x && isStr(x.id) && isStr(x.title) && x.title.trim() && isYmd(x.date))
    .slice(0, 50)
    .map((x: Countdown) => ({
      id: x.id.slice(0, 40),
      title: x.title.trim().slice(0, 60),
      date: x.date,
      yearly: x.yearly === true,
      createdAt: isIso(x.createdAt) ? x.createdAt : new Date().toISOString(),
    }));
}

export function cleanSmokes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isIso)
    .map((s) => new Date(s).toISOString())
    .sort()
    .slice(-20_000);
}

export function cleanMoods(v: unknown): Record<string, Mood> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, Mood> = {};
  for (const [date, m] of Object.entries(v as Record<string, Partial<Mood>>)) {
    if (!isYmd(date) || !m || typeof m !== 'object') continue;
    const level = num(m.level, 1, 5, 0);
    if (level >= 1 && level <= 5) {
      out[date] = { level, note: isStr(m.note) ? m.note.trim().slice(0, 280) : '' };
    }
  }
  return out;
}

export function cleanWeights(v: unknown): Record<string, number> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  for (const [date, rawKg] of Object.entries(v as Record<string, unknown>)) {
    if (!isYmd(date)) continue;
    const kg = cleanKg(rawKg);
    if (kg !== null) out[date] = kg;
  }
  return out;
}

export function cleanPackages(v: unknown): Package[] {
  if (!Array.isArray(v)) return [];
  const out: Package[] = [];
  for (const p of v as Partial<Package>[]) {
    if (!p || !isStr(p.id) || !isStr(p.number) || !isStr(p.carrier)) continue;
    const stage: Stage = p.stage === 0 || p.stage === 1 || p.stage === 2 || p.stage === 3 ? p.stage : 0;
    const timeline: TrackingEvent[] = Array.isArray(p.timeline)
      ? p.timeline
          .filter((t) => t && isIso(t.at) && isStr(t.event))
          .map((t) => ({ at: t.at, location: isStr(t.location) ? t.location : '', event: t.event }))
      : [];
    out.push({
      id: p.id.slice(0, 60),
      label: isStr(p.label) && p.label.trim() ? p.label.trim().slice(0, 120) : `${p.carrier} parcel`,
      carrier: p.carrier.slice(0, 40),
      number: p.number.trim().slice(0, 60),
      stage,
      exception: p.exception === true,
      statusText: isStr(p.statusText) ? p.statusText.slice(0, 200) : '',
      source: p.source === 'gmail' ? 'gmail' : 'manual',
      isNew: p.isNew === true,
      timeline,
      deliveredAt: isIso(p.deliveredAt) ? p.deliveredAt : null,
      archived: p.archived === true,
      createdAt: isIso(p.createdAt) ? p.createdAt : new Date().toISOString(),
      lastChecked: isIso(p.lastChecked) ? p.lastChecked : null,
      trackingError: isStr(p.trackingError) ? p.trackingError : null,
    });
  }
  return out.slice(0, 500);
}

export function cleanExerciseMuscles(v: unknown): Record<string, ExerciseMuscles> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const validMuscle = (m: unknown): m is Muscle => isStr(m) && (MUSCLES as readonly string[]).includes(m);
  const out: Record<string, ExerciseMuscles> = {};
  for (const [name, em] of Object.entries(v as Record<string, Partial<ExerciseMuscles>>)) {
    const k = name.trim().slice(0, 120);
    if (!k || !em || !validMuscle(em.primary)) continue;
    const secondary = Array.isArray(em.secondary)
      ? [...new Set(em.secondary.filter(validMuscle).filter((m) => m !== em.primary))].slice(0, 3)
      : [];
    out[k] = { primary: em.primary, secondary };
  }
  return out;
}

export interface ParsedBackup {
  bookmarks?: BookmarkGroup[];
  notes?: Note[];
  prefs?: Prefs;
  packages?: Package[];
  countdowns?: Countdown[];
  smokes?: string[];
  moods?: Record<string, Mood>;
  weights?: Record<string, number>;
  money?: Money;
  training?: Training;
  exerciseMuscles?: Record<string, ExerciseMuscles>;
  learn?: Learn;
  summary: string;
}

/** Validate and clean a v1 or v2 backup object. Returns null when nothing recognisable is in `raw`. */
export function parseBackup(raw: unknown, prevPrefs: Prefs = DEFAULT_PREFS): ParsedBackup | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  const out: Omit<ParsedBackup, 'summary'> = {};
  const parts: string[] = [];

  if (validBookmarks(d.bookmarks)) {
    out.bookmarks = d.bookmarks;
    parts.push(`${d.bookmarks.length} bookmark group${d.bookmarks.length === 1 ? '' : 's'}`);
  }
  if (validNotes(d.notes)) {
    out.notes = d.notes;
    parts.push(`${d.notes.length} notepad${d.notes.length === 1 ? '' : 's'}`);
  }
  if (d.prefs && typeof d.prefs === 'object' && !Array.isArray(d.prefs)) {
    out.prefs = cleanPrefs(d.prefs as Partial<Prefs>, prevPrefs);
    parts.push('settings');
  }
  if (Array.isArray(d.packages)) {
    out.packages = cleanPackages(d.packages);
    if (out.packages.length) parts.push(`${out.packages.length} package${out.packages.length === 1 ? '' : 's'}`);
  }
  if (Array.isArray(d.countdowns)) {
    out.countdowns = cleanCountdowns(d.countdowns);
    if (out.countdowns.length) parts.push(`${out.countdowns.length} countdown${out.countdowns.length === 1 ? '' : 's'}`);
  }
  if (Array.isArray(d.smokes)) {
    out.smokes = cleanSmokes(d.smokes);
    if (out.smokes.length) parts.push(`${out.smokes.length} smoke log${out.smokes.length === 1 ? '' : 's'}`);
  }
  if (d.moods && typeof d.moods === 'object' && !Array.isArray(d.moods)) {
    out.moods = cleanMoods(d.moods);
    const n = Object.keys(out.moods).length;
    if (n) parts.push(`${n} mood${n === 1 ? '' : 's'}`);
  }
  if (d.weights && typeof d.weights === 'object' && !Array.isArray(d.weights)) {
    out.weights = cleanWeights(d.weights);
    const n = Object.keys(out.weights).length;
    if (n) parts.push(`${n} weight${n === 1 ? '' : 's'}`);
  }
  if (d.money && typeof d.money === 'object' && Array.isArray((d.money as Money).entries)) {
    out.money = cleanMoney(d.money);
    parts.push(`money (${out.money.entries.length} entries)`);
  }
  if (d.training && typeof d.training === 'object' && Array.isArray((d.training as Training).workouts)) {
    out.training = cleanTraining(d.training);
    if (out.training.workouts.length) parts.push(`${out.training.workouts.length} workout${out.training.workouts.length === 1 ? '' : 's'}`);
  }
  if (d.exerciseMuscles && typeof d.exerciseMuscles === 'object' && !Array.isArray(d.exerciseMuscles)) {
    out.exerciseMuscles = cleanExerciseMuscles(d.exerciseMuscles);
  }
  if (d.learn && typeof d.learn === 'object' && Array.isArray((d.learn as Learn).courses)) {
    out.learn = cleanLearn(d.learn);
    if (out.learn.courses.length || out.learn.sessions.length || out.learn.side.length) {
      parts.push(`learn (${out.learn.courses.length} course${out.learn.courses.length === 1 ? '' : 's'})`);
    }
  }

  if (!Object.keys(out).length) return null;
  const summary = `Restored ${parts.length ? parts.join(', ') : 'backup'}.`;
  return { ...out, summary };
}

