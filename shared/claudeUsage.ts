// What Launchpad's Claude calls cost: the tokens each call used, added up per day,
// feature and model, and priced from one table. The server keeps the log; the Server
// view shows this month and last month per feature and the last 30 days.
import { addDays, pad2, startOfDay, ymd } from './dates';

/** The features that call Claude. Others still count, under their own name. */
export const CLAUDE_FEATURES: Record<string, string> = {
  news: 'News',
  inbox: 'Inbox',
  training: 'Training',
  learn: 'Learn',
  briefing: 'Daily briefing',
  ask: '⌘K',
  review: 'Weekly review',
  other: 'Other',
};

export const featureName = (key: string) => CLAUDE_FEATURES[key] ?? key[0].toUpperCase() + key.slice(1);

export interface TokenCount {
  calls: number;
  input: number;
  output: number;
  /** Tokens written to the prompt cache (5-minute). */
  cacheWrite: number;
  cacheRead: number;
}

/** Day (YYYY-MM-DD) → feature → model → tokens. A model ending in LONG is a call priced at its long-prompt rate. */
export type UsageLog = Record<string, Record<string, Record<string, TokenCount>>>;

/** Calls whose prompt went over a model's long-prompt threshold are kept under `model + LONG`. */
export const LONG = ' (long prompt)';

export interface Price {
  /** US dollars per million tokens. */
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/**
 * Anthropic's list prices per million tokens (platform.claude.com/docs/en/about-claude/pricing,
 * checked November 2026). The one place to update when they change.
 */
export const PRICES: Record<string, Price> = {
  'claude-fable-5-2': { input: 8, output: 40, cacheWrite: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 0.25 },
  'claude-fable-5': { input: 10, output: 50, cacheWrite: 12.5, cacheRead: 1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-7': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-6': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 },
  ['claude-haiku-5-5' + LONG]: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** Models with dearer prices for long prompts, and where long starts (all input tokens, cached or not). */
const LONG_FROM: Record<string, number> = { 'claude-haiku-5-5': 100_000 };

/** The key a call is logged under: its model, or its model's long-prompt rate. */
export function priceKey(model: string, promptTokens: number): string {
  const from = LONG_FROM[model];
  return from !== undefined && promptTokens > from ? model + LONG : model;
}

/** A dated id (claude-haiku-5-5-20261001) priced as its model; unknown models as null. */
export function priceOf(key: string): Price | null {
  if (PRICES[key]) return PRICES[key];
  const long = key.endsWith(LONG);
  const base = (long ? key.slice(0, -LONG.length) : key).replace(/-\d{8}$/, '');
  return PRICES[long ? base + LONG : base] ?? null;
}

/** Estimated US dollars for these tokens; 0 for a model not in the table. */
export function costOf(key: string, t: TokenCount): number {
  const p = priceOf(key);
  if (!p) return 0;
  return (t.input * p.input + t.output * p.output + t.cacheWrite * p.cacheWrite + t.cacheRead * p.cacheRead) / 1_000_000;
}

const ZERO = (): TokenCount => ({ calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

function add(a: TokenCount, b: TokenCount): TokenCount {
  return { calls: a.calls + b.calls, input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}

/** The log with one call added (`calls` is how many requests it took: 1, or 0 for the second model of a fallback). */
export function addUsage(log: UsageLog, day: string, feature: string, key: string, t: TokenCount): UsageLog {
  const f = log[day]?.[feature] ?? {};
  return { ...log, [day]: { ...log[day], [feature]: { ...f, [key]: add(f[key] ?? ZERO(), t) } } };
}

/** Days older than `keepDays` dropped, so the log stays small. */
export function pruneUsage(log: UsageLog, today: Date, keepDays = 400): UsageLog {
  const from = ymd(addDays(startOfDay(today), -keepDays));
  return Object.fromEntries(Object.entries(log).filter(([d]) => d >= from));
}

export interface FeatureUsage extends TokenCount {
  feature: string;
  name: string;
  cost: number;
  /** Models used, most expensive first. */
  models: string[];
}

export interface MonthUsage {
  /** YYYY-MM. */
  key: string;
  features: FeatureUsage[];
  total: TokenCount & { cost: number };
}

export interface UsageSummary {
  /** This month, then last month. */
  months: [MonthUsage, MonthUsage];
  /** The last 30 days, oldest first. */
  days: { date: string; calls: number; cost: number }[];
  /** Models in the log without a price, so their cost shows as $0. */
  unpriced: string[];
}

const monthKey = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

function month(log: UsageLog, key: string): MonthUsage {
  const byFeature = new Map<string, { t: TokenCount; cost: number; models: Map<string, number> }>();
  for (const [day, features] of Object.entries(log)) {
    if (!day.startsWith(key + '-')) continue;
    for (const [feature, models] of Object.entries(features)) {
      const row = byFeature.get(feature) ?? { t: ZERO(), cost: 0, models: new Map() };
      for (const [m, t] of Object.entries(models)) {
        const c = costOf(m, t);
        row.t = add(row.t, t);
        row.cost += c;
        const name = m.endsWith(LONG) ? m.slice(0, -LONG.length) : m;
        row.models.set(name, (row.models.get(name) ?? 0) + c);
      }
      byFeature.set(feature, row);
    }
  }
  const features = [...byFeature.entries()]
    .map(([feature, r]): FeatureUsage => ({ feature, name: featureName(feature), ...r.t, cost: r.cost, models: [...r.models.entries()].sort((a, b) => b[1] - a[1]).map(([m]) => m) }))
    .sort((a, b) => b.cost - a.cost || b.calls - a.calls);
  const total = features.reduce((a, f) => add(a, f), ZERO());
  return { key, features, total: { ...total, cost: features.reduce((a, f) => a + f.cost, 0) } };
}

/** What GET /api/claude/usage sends: the summary, whether there's an API key, and the monthly budget (0 for none). */
export type UsageReport = UsageSummary & { enabled: boolean; budget: number };

/** This month and last month per feature, and the last 30 days, for the Server view. */
export function summariseUsage(log: UsageLog, now: Date): UsageSummary {
  const today = startOfDay(now);
  const days = Array.from({ length: 30 }, (_, i) => {
    const date = ymd(addDays(today, i - 29));
    const models = Object.values(log[date] ?? {}).flatMap((f) => Object.entries(f));
    return { date, calls: models.reduce((a, [, t]) => a + t.calls, 0), cost: models.reduce((a, [m, t]) => a + costOf(m, t), 0) };
  });
  const unpriced = [...new Set(Object.values(log).flatMap((d) => Object.values(d).flatMap((f) => Object.keys(f))))].filter((m) => !priceOf(m)).sort();
  return { months: [month(log, monthKey(today)), month(log, monthKey(new Date(today.getFullYear(), today.getMonth() - 1, 1)))], days, unpriced };
}

/** This month's estimated cost so far. */
export const monthCost = (log: UsageLog, now: Date) => month(log, monthKey(now)).total.cost;

/** "$0.04", "$1.20", "<$0.01". */
export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString('en-US')}`;
}

/** "1.2M", "34k", "980". */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}
