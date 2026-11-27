import { describe, expect, it } from 'vitest';
import { lastSaved, noteSent, onUplink, uplinkOf } from '../web/src/uplink';

describe('uplinkOf', () => {
  it('gives a save to a synced source that source’s light', () => {
    expect(uplinkOf('POST', '/api/calendar/events')).toBe('calendar');
    expect(uplinkOf('POST', '/api/inbox/modify')).toBe('inbox');
    expect(uplinkOf('DELETE', '/api/bills/b1')).toBe('inbox');
    expect(uplinkOf('PATCH', '/api/digest/cards/c%201')).toBe('digest');
    expect(uplinkOf('POST', '/api/digest/recall')).toBe('digest');
    expect(uplinkOf('POST', '/api/news/saved')).toBe('digest');
    expect(uplinkOf('PATCH', '/api/news/saved/s1')).toBe('digest');
    expect(uplinkOf('DELETE', '/api/news/saved/s1')).toBe('digest');
  });

  it('gives what Launchpad keeps itself its own light', () => {
    for (const k of ['notes', 'money', 'learn', 'bookmarks', 'prefs', 'countdowns', 'training']) expect(uplinkOf('PUT', `/api/${k}`)).toBe('launchpad');
    expect(uplinkOf('POST', '/api/smokes')).toBe('launchpad');
    expect(uplinkOf('DELETE', '/api/smokes?at=2026-11-28T01%3A00%3A00.000Z')).toBe('launchpad');
    expect(uplinkOf('PUT', '/api/moods/2026-11-28')).toBe('launchpad');
    expect(uplinkOf('PUT', '/api/weights/2026-11-28')).toBe('launchpad');
    expect(uplinkOf('PUT', '/api/cravings/c1')).toBe('launchpad');
    expect(uplinkOf('DELETE', '/api/cravings/c1')).toBe('launchpad');
    expect(uplinkOf('POST', '/api/photos')).toBe('launchpad');
    expect(uplinkOf('DELETE', '/api/photos/p1')).toBe('launchpad');
    expect(uplinkOf('POST', '/api/notes/n1/history')).toBe('launchpad');
    expect(uplinkOf('PUT', '/api/shell/snippets/s1')).toBe('launchpad');
    expect(uplinkOf('POST', '/api/minecraft/servers')).toBe('launchpad');
    expect(uplinkOf('POST', '/api/nac/watches')).toBe('launchpad');
    expect(uplinkOf('put', '/api/alerts')).toBe('launchpad');
  });

  it('leaves out reads, refreshes, syncs, questions and actions on the server', () => {
    expect(uplinkOf('GET', '/api/notes')).toBeNull();
    expect(uplinkOf('GET', '/api/state')).toBeNull();
    expect(uplinkOf('POST', '/api/sync/calendar')).toBeNull();
    expect(uplinkOf('POST', '/api/learn/refresh')).toBeNull();
    expect(uplinkOf('POST', '/api/digest/cards/c1/ask')).toBeNull();
    expect(uplinkOf('POST', '/api/digest/cards/c1/swap')).toBeNull();
    expect(uplinkOf('POST', '/api/ask')).toBeNull();
    expect(uplinkOf('POST', '/api/money/statement')).toBeNull();
    expect(uplinkOf('POST', '/api/speedtest')).toBeNull();
    expect(uplinkOf('POST', '/api/server/containers/x/restart')).toBeNull();
    expect(uplinkOf('PUT', '/api/files/text')).toBeNull();
    expect(uplinkOf('POST', '/api/minecraft/m1/command')).toBeNull();
    expect(uplinkOf('POST', '/api/alerts/test')).toBeNull();
    expect(uplinkOf('POST', '/api/backup')).toBeNull();
  });
});

describe('noteSent', () => {
  it('tells listeners about saves only, and remembers when the last was', () => {
    const heard: string[] = [];
    const off = onUplink((k) => heard.push(k));
    noteSent('GET', '/api/state');
    noteSent('POST', '/api/sync/digest');
    expect(heard).toEqual([]);
    const before = Date.now();
    noteSent('PUT', '/api/notes');
    noteSent('POST', '/api/inbox/modify');
    expect(heard).toEqual(['launchpad', 'inbox']);
    expect(lastSaved()).toBeGreaterThanOrEqual(before);
    off();
    noteSent('PUT', '/api/money');
    expect(heard).toHaveLength(2);
  });
});
