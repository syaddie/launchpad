import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STARTER_NOTES } from '../shared/defaults';

// This file writes to the store, so it gets a database of its own rather than the shared test one.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-state-'));
process.env.DATA_DIR = dataDir;
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows won't delete the database while it's open; it's in the temp folder anyway.
  }
});
let st: typeof import('../server/src/state');
let store: typeof import('../server/src/store').store;
let docVersion: typeof import('../server/src/store').docVersion;

beforeAll(async () => {
  st = await import('../server/src/state');
  ({ store, docVersion } = await import('../server/src/store'));
  // The first import of the server modules can be slow on a cold start.
}, 30_000);

describe('state for changed keys', () => {
  it('maps store keys to the parts of the state they feed', () => {
    expect(st.fieldsFor(['calendar'])!.sort()).toEqual(['calendars', 'events', 'google']);
    expect(st.fieldsFor(['tasks'])!.sort()).toEqual(['google', 'taskLists', 'tasks']);
    expect(st.fieldsFor(['inbox'])!.sort()).toEqual(['google', 'inbox']);
    expect(st.fieldsFor(['sync'])).toEqual(['sync']);
    expect(st.fieldsFor(['prefs'])!.sort()).toEqual(['news', 'prefs']);
    expect(st.fieldsFor(['money', 'smokes'])!.sort()).toEqual(['money', 'smokeDays', 'smokes']);
    // Two keys feeding the same field send it once.
    expect(st.fieldsFor(['calendar', 'tasks'])!.filter((f) => f === 'google')).toHaveLength(1);
    // Keys the page doesn't show.
    expect(st.fieldsFor(['gmailSeen', 'speedTests'])).toEqual([]);
  });

  it('sends everything for a key it doesn’t know', () => {
    expect(st.fieldsFor(['calendar', 'somethingNew'])).toBeNull();
    expect(st.fieldsFor(['__proto__'])).toBeNull();
    expect(Object.keys(st.stateFor(['somethingNew'])).sort()).toEqual(Object.keys(st.state()).sort());
  });

  it('knows every key the store writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '../server/src/store.ts'), 'utf8');
    const keys = new Set([...src.matchAll(/\b(?:set|del)\('(\w+)'/g)].map((m) => m[1]));
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) expect(st.KEY_FIELDS, `store key ${k}`).toHaveProperty(k);
  });

  it('has a key behind every part of the state that changes', () => {
    const fed = new Set(Object.values(st.KEY_FIELDS).flat());
    // Set from the server's config, so they only change with a restart (and a full fetch).
    const fixed = ['tracking', 'newsSummaries', 'versions'];
    for (const f of Object.keys(st.state())) if (!fixed.includes(f)) expect(fed.has(f as never), f).toBe(true);
  });

  it('returns just those parts, with the versions of documents among them', () => {
    const notes = [{ ...STARTER_NOTES[0], text: 'changed' }];
    store.setNotes(notes);
    const s = st.stateFor(['notes', 'sync']);
    expect(Object.keys(s).sort()).toEqual(['notes', 'sync', 'versions']);
    expect(s.notes).toEqual(notes);
    expect(s.versions).toEqual({ notes: docVersion('notes') });
    expect(s.sync).toEqual(st.state().sync);
    // No document among them: no versions.
    expect(Object.keys(st.stateFor(['calendar'])).sort()).toEqual(['calendars', 'events', 'google']);
  });

  it('builds the full state with every document’s version', () => {
    const s = st.state();
    expect(Object.keys(s.versions!).sort()).toEqual(['bookmarks', 'learn', 'money', 'notes']);
    expect(s.versions!.notes).toBe(docVersion('notes'));
  });
});
