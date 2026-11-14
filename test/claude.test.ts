import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LONG, addUsage, costOf, fmtTokens, fmtUsd, monthCost, priceKey, pruneUsage, summariseUsage, type TokenCount, type UsageLog } from '../shared/claudeUsage';
import { DEFAULT_PREFS } from '../shared/defaults';
import { emptyLearn } from '../shared/learn';
import { starterMoney } from '../shared/money';
import { EMPTY_TRAINING } from '../shared/training';

// recordUsage writes to the store, so this file gets a database of its own.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-claude-'));
process.env.DATA_DIR = dataDir;
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows won't delete the database while it's open; it's in the temp folder anyway.
  }
});
let claude: typeof import('../server/src/claude');
let store: typeof import('../server/src/store').store;
beforeAll(async () => {
  claude = await import('../server/src/claude');
  store = (await import('../server/src/store')).store;
});

const t = (input: number, output: number, cacheRead = 0, cacheWrite = 0, calls = 1): TokenCount => ({ calls, input, output, cacheRead, cacheWrite });

describe('pricing', () => {
  it('prices Haiku 5.5 from the table, and long prompts at the long rate', () => {
    expect(costOf('claude-haiku-5-5', t(1_000_000, 1_000_000))).toBeCloseTo(0.6);
    expect(costOf('claude-haiku-5-5', t(0, 0, 1_000_000, 1_000_000))).toBeCloseTo(0.135);
    expect(priceKey('claude-haiku-5-5', 100_000)).toBe('claude-haiku-5-5');
    expect(priceKey('claude-haiku-5-5', 100_001)).toBe('claude-haiku-5-5' + LONG);
    expect(costOf('claude-haiku-5-5' + LONG, t(1_000_000, 0))).toBeCloseTo(0.5);
    expect(priceKey('claude-opus-5-5', 900_000)).toBe('claude-opus-5-5');
  });

  it('prices a dated model id as its model, and an unknown one as nothing', () => {
    expect(costOf('claude-opus-5-5-20261001', t(1_000_000, 0))).toBeCloseTo(4);
    expect(costOf('some-new-model', t(1_000_000, 1_000_000))).toBe(0);
  });

  it('formats small amounts', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(0.004)).toBe('<$0.01');
    expect(fmtUsd(1.2)).toBe('$1.20');
    expect(fmtTokens(980)).toBe('980');
    expect(fmtTokens(34_200)).toBe('34k');
    expect(fmtTokens(1_234_567)).toBe('1.2M');
  });
});

describe('adding up usage', () => {
  let log: UsageLog = {};
  log = addUsage(log, '2026-11-12', 'news', 'claude-haiku-5-5', t(10_000, 2_000));
  log = addUsage(log, '2026-11-12', 'news', 'claude-haiku-5-5', t(10_000, 2_000));
  log = addUsage(log, '2026-11-03', 'inbox', 'claude-opus-5-5', t(100_000, 10_000));
  log = addUsage(log, '2026-11-03', 'mystery', 'unknown-model', t(5, 5));
  log = addUsage(log, '2026-10-31', 'learn', 'claude-haiku-5-5', t(4_000, 1_000, 2_000));
  log = addUsage(log, '2025-01-01', 'learn', 'claude-haiku-5-5', t(1, 1));
  const now = new Date(2026, 10, 12, 9, 30);
  const s = summariseUsage(log, now);

  it('adds calls and tokens per feature and month, dearest first', () => {
    const [nov, oct] = s.months;
    expect(nov.key).toBe('2026-11');
    expect(oct.key).toBe('2026-10');
    expect(nov.features.map((f) => f.feature)).toEqual(['inbox', 'news', 'mystery']);
    const news = nov.features.find((f) => f.feature === 'news')!;
    expect(news).toMatchObject({ name: 'News', calls: 2, input: 20_000, output: 4_000, models: ['claude-haiku-5-5'] });
    expect(news.cost).toBeCloseTo((20_000 * 0.1 + 4_000 * 0.5) / 1e6);
    expect(nov.total.calls).toBe(4);
    expect(nov.total.cost).toBeCloseTo(0.6 + 0.004);
    expect(oct.features).toHaveLength(1);
    expect(oct.features[0]).toMatchObject({ feature: 'learn', cacheRead: 2_000 });
    expect(monthCost(log, now)).toBeCloseTo(nov.total.cost);
  });

  it('has the last 30 days, oldest first, and names unpriced models', () => {
    expect(s.days).toHaveLength(30);
    expect(s.days[0].date).toBe('2026-10-14');
    expect(s.days[29]).toMatchObject({ date: '2026-11-12', calls: 2 });
    expect(s.days.find((d) => d.date === '2026-10-31')!.calls).toBe(1);
    expect(s.unpriced).toEqual(['unknown-model']);
  });

  it('starts January’s last month in December', () => {
    expect(summariseUsage(log, new Date(2027, 0, 5)).months[1].key).toBe('2026-12');
  });

  it('drops days older than it keeps', () => {
    expect(Object.keys(pruneUsage(log, now))).not.toContain('2025-01-01');
    expect(Object.keys(pruneUsage(log, now))).toContain('2026-10-31');
  });
});

describe('recording a call', () => {
  const usage = (extra: Record<string, unknown> = {}) =>
    ({ input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 800, iterations: null, ...extra }) as unknown as Parameters<typeof claude.recordUsage>[2];

  it('counts a call towards its feature and model', () => {
    store.setClaudeUsage({});
    const at = new Date(2026, 10, 12, 8);
    claude.recordUsage('briefing', 'claude-haiku-5-5', usage(), at);
    claude.recordUsage('briefing', 'claude-haiku-5-5', usage(), at);
    expect(store.claudeUsage()['2026-11-12'].briefing['claude-haiku-5-5']).toEqual({ calls: 2, input: 2400, output: 600, cacheWrite: 0, cacheRead: 1600 });
  });

  it('splits a refusal fallback between the models that ran, as one call', () => {
    store.setClaudeUsage({});
    const at = new Date(2026, 10, 12, 8);
    claude.recordUsage('ask', 'claude-sonnet-5', usage({
      iterations: [
        { type: 'message', model: 'claude-sonnet-5-5', input_tokens: 500, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        { type: 'fallback_message', model: 'claude-sonnet-5', input_tokens: 700, output_tokens: 290, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 },
      ],
    }), at);
    const day = store.claudeUsage()['2026-11-12'].ask;
    expect(day['claude-sonnet-5-5']).toMatchObject({ calls: 1, input: 500, output: 10 });
    expect(day['claude-sonnet-5']).toMatchObject({ calls: 0, input: 700, cacheRead: 800 });
  });
});
