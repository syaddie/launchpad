// Checks for what the page sends, shared by the save routes and backup restore,
// so a restored file can't put anything in the store a normal save couldn't.
import { DEFAULT_ENGINES, HIDEABLE_KEYS } from '../../shared/defaults';
import { cleanKg } from '../../shared/training';
import type { BookmarkGroup, Countdown, Mood, Note, Package, Prefs, SearchEngine, Snippet } from '../../shared/types';

export const isStr = (v: unknown): v is string => typeof v === 'string';

export const isYmd = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

export const num = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d);

export function validBookmarks(v: unknown): v is BookmarkGroup[] {
  return Array.isArray(v) && v.every((g) => g && isStr(g.id) && isStr(g.name) && Array.isArray(g.items)
    && g.items.every((b: any) => b && isStr(b.id) && isStr(b.name) && isStr(b.url)));
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

/** Settings from the page, field by field; anything missing or wrong keeps what `prev` has. */
export function cleanPrefs(body: Partial<Prefs>, prev: Prefs): Prefs {
  const next: Prefs = {
    name: isStr(body.name) ? body.name.slice(0, 40) : prev.name,
    theme: ['system', 'light', 'dark'].includes(body.theme as string) ? body.theme! : prev.theme,
    accent: ['sage', 'slate', 'terracotta'].includes(body.accent as string) ? body.accent! : prev.accent,
    design: ['broadsheet', 'console', 'bento', 'horizon'].includes(body.design as string) ? body.design! : prev.design ?? 'broadsheet',
    hiddenCalendars: Array.isArray(body.hiddenCalendars) ? body.hiddenCalendars.filter(isStr) : prev.hiddenCalendars,
    sources: { ...prev.sources, ...pickBools(body.sources, Object.keys(prev.sources)) },
    newsTopics: Array.isArray(body.newsTopics) ? cleanTopics(body.newsTopics) : prev.newsTopics,
    weatherArea: isStr(body.weatherArea) ? body.weatherArea.trim().slice(0, 60) : prev.weatherArea,
    aboutMe: isStr(body.aboutMe) ? body.aboutMe.trim().slice(0, 1000) : prev.aboutMe,
    hidden: Array.isArray(body.hidden) ? [...new Set(body.hidden.filter((h) => isStr(h) && HIDEABLE_KEYS.includes(h)))] : prev.hidden,
    searchEngines: Array.isArray(body.searchEngines) ? cleanEngines(body.searchEngines) : prev.searchEngines,
    cigaretteLimit: num(body.cigaretteLimit, 0, 99, prev.cigaretteLimit),
    speedTestHours: num(body.speedTestHours, 0, 24, prev.speedTestHours),
    speedPlanMbps: num(body.speedPlanMbps, 0, 100_000, prev.speedPlanMbps),
    setsPerWeek: num(body.setsPerWeek, 1, 40, prev.setsPerWeek),
    gymMonthly: typeof body.gymMonthly === 'number' && Number.isFinite(body.gymMonthly) ? Math.min(10_000, Math.max(0, Math.round(body.gymMonthly * 100) / 100)) : prev.gymMonthly,
    pinnedLifts: Array.isArray(body.pinnedLifts) ? [...new Set(body.pinnedLifts.filter(isStr).map((t) => t.slice(0, 120)))].slice(0, 12) : prev.pinnedLifts,
  };
  if (!next.searchEngines.length) next.searchEngines = DEFAULT_ENGINES;
  return next;
}

/** Only the given keys, and only where they're true or false. */
function pickBools<K extends string>(v: unknown, keys: K[]): Partial<Record<K, boolean>> {
  if (!v || typeof v !== 'object') return {};
  const out: Partial<Record<K, boolean>> = {};
  for (const k of keys) if (typeof (v as Record<string, unknown>)[k] === 'boolean') out[k] = (v as Record<K, boolean>)[k];
  return out;
}

export function cleanCountdowns(body: unknown[]): Countdown[] {
  return body
    .filter((x): x is Countdown => !!x && isStr((x as Countdown).id) && isStr((x as Countdown).title) && !!(x as Countdown).title.trim() && isYmd((x as Countdown).date))
    .slice(0, 50)
    .map((x) => ({
      id: x.id.slice(0, 40),
      title: x.title.trim().slice(0, 60),
      date: x.date,
      yearly: x.yearly === true,
      createdAt: isStr(x.createdAt) && !Number.isNaN(Date.parse(x.createdAt)) ? x.createdAt : new Date().toISOString(),
    }));
}

/** A day's mood; null when the level isn't 1–5. */
export function cleanMood(v: Partial<Mood> | null | undefined, prevNote = ''): Mood | null {
  const level = num(v?.level, 0, 5, 0);
  if (!level) return null;
  return { level, note: isStr(v?.note) ? v.note.trim().slice(0, 280) : prevNote };
}

export function cleanMoods(v: unknown): Record<string, Mood> {
  const out: Record<string, Mood> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [date, m] of Object.entries(v)) {
    const mood = isYmd(date) ? cleanMood(m as Partial<Mood>) : null;
    if (mood) out[date] = mood;
  }
  return out;
}

export function cleanWeights(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  for (const [date, kg] of Object.entries(v)) {
    const clean = isYmd(date) ? cleanKg(kg) : null;
    if (clean !== null) out[date] = clean;
  }
  return out;
}

/** ISO times, oldest first, none in the future. */
export function cleanSmokes(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const soon = Date.now() + 60_000;
  return v
    .filter((s): s is string => isStr(s) && !Number.isNaN(Date.parse(s)) && Date.parse(s) <= soon)
    .map((s) => new Date(s).toISOString())
    .sort();
}

/** Packages as the store keeps them; ones without a number, carrier or id are dropped. */
export function cleanPackages(v: unknown): Package[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set<string>();
  return v.filter((p): p is Package => {
    if (!p || !isStr(p.id) || !isStr(p.number) || !isStr(p.carrier) || !isStr(p.label) || ids.has(p.id)) return false;
    ids.add(p.id);
    return true;
  }).map((p) => ({
    id: p.id,
    label: p.label.slice(0, 200),
    carrier: p.carrier,
    number: p.number,
    stage: num(p.stage, 0, 3, 0) as Package['stage'],
    exception: p.exception === true,
    statusText: isStr(p.statusText) ? p.statusText : '',
    source: p.source === 'gmail' ? 'gmail' : 'manual',
    isNew: p.isNew === true,
    timeline: Array.isArray(p.timeline) ? p.timeline.filter((t) => t && isStr(t.at) && isStr(t.event)).map((t) => ({ at: t.at, location: isStr(t.location) ? t.location : '', event: t.event })) : [],
    deliveredAt: isStr(p.deliveredAt) ? p.deliveredAt : null,
    archived: p.archived === true,
    createdAt: isStr(p.createdAt) ? p.createdAt : new Date().toISOString(),
    lastChecked: isStr(p.lastChecked) ? p.lastChecked : null,
    trackingError: isStr(p.trackingError) ? p.trackingError : null,
  }));
}

export const MAX_SNIPPETS = 200;

/** One terminal snippet: a name up to 80 characters and a command up to 4,000. Null when either is empty. */
export function cleanSnippet(v: unknown, id: string): Snippet | null {
  const s = v as Partial<Snippet> | null;
  if (!s || !isStr(s.name) || !isStr(s.command)) return null;
  const name = s.name.trim().slice(0, 80);
  const command = s.command.replace(/\r\n?/g, '\n').replace(/\s+$/, '').slice(0, 4000);
  return name && command.trim() ? { id, name, command } : null;
}

/** Snippets as the store keeps them; ones without a name, a command or an id of their own are dropped. */
export function cleanSnippets(v: unknown): Snippet[] {
  if (!Array.isArray(v)) return [];
  const ids = new Set<string>();
  return v.flatMap((s) => {
    const id = s && isStr(s.id) && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && !ids.has(s.id) ? s.id : null;
    const c = id && cleanSnippet(s, id);
    if (!c) return [];
    ids.add(c.id);
    return [c];
  }).slice(0, MAX_SNIPPETS);
}
