import { describe, expect, it } from 'vitest';
import { BASE_TITLE, tabClock, tabState, TITLE_MS } from '../web/src/tabTitle';

const at = (hm: string) => new Date(`2026-11-28T${hm}+08:00`);

describe('tabClock', () => {
  it('writes minutes and seconds under an hour, and hours from one', () => {
    expect(tabClock(8 * 60_000 + 12_000)).toBe('08:12');
    expect(tabClock(59_999)).toBe('00:59');
    expect(tabClock(0)).toBe('00:00');
    expect(tabClock(-5000)).toBe('00:00');
    expect(tabClock(3600_000 + 8 * 60_000 + 12_000)).toBe('1:08:12');
  });
});

describe('tabState', () => {
  const gym = { s: at('07:00:00'), title: 'Gym: push day' };

  it('counts down to an event inside the hour, the icon lit only inside ten minutes', () => {
    expect(tabState(at('06:51:48'), gym)).toEqual({ title: 'T-08:12 · Gym: push day', lit: true, ticking: true });
    expect(tabState(at('06:30:00'), gym)).toEqual({ title: 'T-30:00 · Gym: push day', lit: false, ticking: true });
    expect(tabState(at('06:49:59'), gym).lit).toBe(false);
    expect(tabState(at('06:50:00'), gym).lit).toBe(true);
  });

  it('is just Launchpad further off, once it has started, and with nothing next', () => {
    expect(tabState(new Date(gym.s.getTime() - TITLE_MS - 1000), gym)).toEqual({ title: BASE_TITLE, lit: false, ticking: false });
    expect(tabState(at('07:00:00'), gym).title).toBe(BASE_TITLE);
    expect(tabState(at('07:10:00'), gym).title).toBe(BASE_TITLE);
    expect(tabState(at('07:10:00'), null)).toEqual({ title: BASE_TITLE, lit: false, ticking: false });
  });

  it('counts up while studying, lit, capped like the timer', () => {
    const timer = { start: at('09:00:00'), what: 'Studying ASE 301' };
    expect(tabState(at('09:24:10'), null, timer)).toEqual({ title: 'T+24:10 · Studying ASE 301', lit: true, ticking: true });
    expect(tabState(at('10:24:10'), null, timer).title).toBe('T+1:24:10 · Studying ASE 301');
    expect(tabState(at('23:00:00'), null, { ...timer, maxMs: 12 * 3600_000 }).title).toBe('T+12:00:00 · Studying ASE 301');
  });

  it('puts an event inside ten minutes before the study timer, and the study timer before one further off', () => {
    const timer = { start: at('06:00:00'), what: 'Studying' };
    expect(tabState(at('06:55:00'), gym, timer).title).toBe('T-05:00 · Gym: push day');
    expect(tabState(at('06:30:00'), gym, timer).title).toBe('T+30:00 · Studying');
  });

  it('names an event with no title', () => {
    expect(tabState(at('06:55:00'), { s: gym.s, title: '  ' }).title).toBe('T-05:00 · Next event');
  });
});
