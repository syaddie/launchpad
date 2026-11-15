import { describe, expect, it } from 'vitest';
import { MC_ALL_COMMANDS } from '../web/src/mcAllCommands';
import { MC_COMMANDS, MC_GROUPS, fillFor, filterCommands, parsePins, togglePin } from '../web/src/mcCommands';

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

describe('MC_ALL_COMMANDS', () => {
  it('lists each command once, in a group that is shown', () => {
    expect(new Set(MC_ALL_COMMANDS.map((c) => c.usage)).size).toBe(MC_ALL_COMMANDS.length);
    for (const c of MC_ALL_COMMANDS) {
      expect(c.usage.trim()).not.toBe('');
      expect(MC_GROUPS).toContain(c.group);
    }
  });

  it('has every group filled, and describes the vanilla commands', () => {
    for (const g of MC_GROUPS) expect(MC_ALL_COMMANDS.some((c) => c.group === g)).toBe(true);
    for (const c of MC_ALL_COMMANDS.filter((c) => c.group !== 'Mods')) expect(c.desc?.trim()).toBeTruthy();
  });

  it('fills the box with the command and none of the <parts> to fill in', () => {
    for (const c of MC_ALL_COMMANDS) {
      const fill = fillFor(c.usage);
      expect(fill).toMatch(/^[\w-]/);
      expect(fill).not.toMatch(/[<\[(|]/);
    }
  });

  it('has every command in the short list, under that name or an alias', () => {
    const names = new Set(MC_ALL_COMMANDS.flatMap((c) => [c.usage.split(' ')[0], ...(c.also ?? [])]));
    for (const g of MC_COMMANDS) for (const c of g.commands) expect(names.has(c.usage.split(' ')[0])).toBe(true);
  });
});

describe('filterCommands', () => {
  const all = MC_ALL_COMMANDS;

  it('returns everything for an empty search', () => {
    expect(filterCommands(all, '  ', null)).toHaveLength(all.length);
  });

  it('matches the usage, the description, a mod and another name', () => {
    expect(filterCommands(all, 'whitelist', null).map((c) => c.usage.split(' ')[0])).toContain('whitelist');
    expect(filterCommands(all, 'potion', null).map((c) => c.usage.split(' ')[0])).toContain('effect');
    expect(filterCommands(all, 'ftb teams', null).map((c) => c.usage.split(' ')[0])).toContain('ftbteams');
    expect(filterCommands(all, 'xp', null).map((c) => c.usage.split(' ')[0])).toContain('experience');
  });

  it('needs every word, in any order and case', () => {
    const hit = filterCommands(all, 'SAVE world', null).map((c) => c.usage.split(' ')[0]);
    expect(hit).toContain('save-all');
    expect(hit).not.toContain('stop');
  });

  it('stays inside the group asked for', () => {
    const hits = filterCommands(all, 'list', 'Mods');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((c) => c.group === 'Mods')).toBe(true);
  });

  it('finds nothing for nonsense', () => {
    expect(filterCommands(all, 'zzzzqq', null)).toEqual([]);
  });
});

describe('pins', () => {
  const all = [
    { usage: 'a <x>', group: 'Server' },
    { usage: 'b', group: 'Server' },
  ];

  it('keeps what was saved, once, and drops what is no longer in the list', () => {
    expect(parsePins(JSON.stringify(['b', 'gone', 'b', 5, 'a <x>']), all)).toEqual(['b', 'a <x>']);
  });

  it('starts empty for missing or broken storage', () => {
    expect(parsePins(null, all)).toEqual([]);
    expect(parsePins('{oops', all)).toEqual([]);
    expect(parsePins('{"a":1}', all)).toEqual([]);
  });

  it('adds at the end and removes on a second toggle', () => {
    expect(togglePin(['a <x>'], 'b')).toEqual(['a <x>', 'b']);
    expect(togglePin(['a <x>', 'b'], 'a <x>')).toEqual(['b']);
  });
});
