import { describe, expect, it } from 'vitest';
import { BUZZ_GAP_MS, BUZZ_PATTERNS, buzzPattern, type BuzzWhen } from '../web/src/buzz';

const ok: BuzzWhen = { can: true, on: true, visible: true, still: false, mission: true, since: 10_000 };

describe('a short vibration', () => {
  it('is short and few: a tick one tap, a lock-on two, a launch a tap and a rumble', () => {
    expect(BUZZ_PATTERNS.tick).toEqual([10]);
    for (const p of Object.values(BUZZ_PATTERNS)) expect(p.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120);
    expect(buzzPattern('tick', ok)).toEqual([10]);
    expect(buzzPattern('lock', ok)).toEqual(BUZZ_PATTERNS.lock);
    expect(buzzPattern('launch', ok)).toEqual(BUZZ_PATTERNS.launch);
  });

  it('only where the device can, it’s switched on, the page is in view and there’s motion', () => {
    for (const kind of ['tick', 'lock', 'launch'] as const) {
      expect(buzzPattern(kind, { ...ok, can: false })).toBeNull();
      expect(buzzPattern(kind, { ...ok, on: false })).toBeNull();
      expect(buzzPattern(kind, { ...ok, visible: false })).toBeNull();
      expect(buzzPattern(kind, { ...ok, still: true })).toBeNull();
    }
  });

  it('ticks in every layout; launches and lock-ons are Mission’s', () => {
    expect(buzzPattern('tick', { ...ok, mission: false })).toEqual([10]);
    expect(buzzPattern('lock', { ...ok, mission: false })).toBeNull();
    expect(buzzPattern('launch', { ...ok, mission: false })).toBeNull();
  });

  it('several at once are felt as one', () => {
    expect(buzzPattern('tick', { ...ok, since: BUZZ_GAP_MS - 1 })).toBeNull();
    expect(buzzPattern('launch', { ...ok, since: 0 })).toBeNull();
    expect(buzzPattern('tick', { ...ok, since: BUZZ_GAP_MS })).toEqual([10]);
    expect(buzzPattern('tick', { ...ok, since: Infinity })).toEqual([10]);
  });
});
