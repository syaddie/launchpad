import { describe, expect, it } from 'vitest';
import { MC_COMMANDS, fillFor } from '../web/src/mcCommands';

describe('fillFor', () => {
  it('stops before the first <argument>', () => {
    expect(fillFor('op <player>')).toBe('op ');
    expect(fillFor('whitelist add <player>')).toBe('whitelist add ');
  });

  it('stops before the first [option]', () => {
    expect(fillFor('setworldspawn [pos]')).toBe('setworldspawn ');
  });

  it('keeps a command that takes no arguments whole', () => {
    expect(fillFor('time set day')).toBe('time set day');
    expect(fillFor('list')).toBe('list');
  });
});

describe('MC_COMMANDS', () => {
  it('has no empty groups, usages or descriptions', () => {
    for (const g of MC_COMMANDS) {
      expect(g.commands.length).toBeGreaterThan(0);
      for (const c of g.commands) {
        expect(c.usage.trim()).not.toBe('');
        expect(c.desc.trim()).not.toBe('');
      }
    }
  });

  it('lists each command once', () => {
    const all = MC_COMMANDS.flatMap((g) => g.commands.map((c) => c.usage));
    expect(new Set(all).size).toBe(all.length);
  });
});
