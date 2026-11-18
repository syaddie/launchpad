import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = vi.hoisted(() => [] as { kind: string; key: string; title: string; body?: string }[]);
vi.mock('../server/src/notify', () => ({
  kindOn: () => true,
  topicUrl: () => 'https://ntfy.example/topic',
  notify: vi.fn(async (a: { kind: string; key: string; title: string; body?: string }) => {
    sent.push(a);
    return 'sent';
  }),
}));

import { mcAlert, onEvent, PAIR_WAIT, resetMcAlertsForTests } from '../server/src/mc-alerts';
import type { McEvent } from '../server/src/minecraft';

const ev = (type: McEvent['type'], over: Partial<McEvent> = {}): McEvent => ({
  type,
  serverId: 's1',
  server: 'Survival',
  at: new Date().toISOString(),
  reason: type === 'crash' ? 'It crashed: <Steve> my password is hunter2' : 'Started it again (1 of 3 in 15 minutes).',
  crashReport: null,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
});
afterEach(() => {
  resetMcAlertsForTests();
  vi.useRealTimers();
});

describe('Minecraft alerts', () => {
  it('sends a crash and its restart as one alert', () => {
    onEvent(ev('crash', { crashReport: 'crash-2026-11-18_10.20.33-server.txt' }), true);
    expect(sent).toEqual([]);
    onEvent(ev('restart'), true);
    expect(sent).toEqual([{ kind: 'minecraft', key: 'minecraft:s1', title: 'Minecraft: Survival crashed', body: 'Launchpad started it again. It wrote a crash report. The Minecraft tab has what happened.' }]);
    vi.advanceTimersByTime(PAIR_WAIT * 2);
    expect(sent).toHaveLength(1);
  });

  it('says it’s down when Launchpad gives up', () => {
    onEvent(ev('crash'), true);
    onEvent(ev('gave-up', { reason: 'It crashed 4 times in 15 minutes' }), true);
    expect(sent.map((s) => s.title)).toEqual(['Minecraft: Survival is down']);
    expect(sent[0].body).toMatch(/stopped restarting it/);
  });

  it('sends a crash at once for a server that isn’t restarted', () => {
    onEvent(ev('crash'), false);
    expect(sent).toEqual([{ kind: 'minecraft', key: 'minecraft:s1', title: 'Minecraft: Survival crashed', body: 'It’s stopped. The Minecraft tab says why.' }]);
  });

  it('sends a crash on its own when nothing follows it', () => {
    onEvent(ev('crash'), true);
    vi.advanceTimersByTime(PAIR_WAIT - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent.map((s) => s.body)).toEqual(['It’s stopped. The Minecraft tab says why.']);
  });

  it('keeps servers apart, and lets a second crash push out the first', () => {
    onEvent(ev('crash'), true);
    onEvent(ev('crash', { serverId: 's2', server: 'Creative' }), true);
    onEvent(ev('crash'), true);
    expect(sent.map((s) => s.key)).toEqual(['minecraft:s1']);
    onEvent(ev('restart', { serverId: 's2', server: 'Creative' }), true);
    expect(sent.map((s) => s.title)).toEqual(['Minecraft: Survival crashed', 'Minecraft: Creative crashed']);
  });

  it('never puts the log’s own words on the phone', () => {
    for (const type of ['crash', 'restart', 'gave-up'] as const) {
      const a = mcAlert(ev(type, { reason: 'It crashed: <Steve> my password is hunter2' }), null);
      expect(a.title + a.body).not.toMatch(/Steve|hunter2/);
    }
  });
});
