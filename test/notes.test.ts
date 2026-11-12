import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeNotes } from '../shared/merge';
import { addVersions, allTags, backlinks, cleanHistory, cleanTags, imageIds, imageMarkdown, linksIn, parseTags, pinnedFirst, renameLinks, searchNotes, thinHistory } from '../shared/notes';
import type { Note, NoteVersion } from '../shared/types';
import { insertLines } from '../web/src/components/Notes';

// This file writes to the store and the image folder, so it gets a data folder of its own.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-notes-'));
process.env.DATA_DIR = dataDir;
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows won't delete the database while it's open; it's in the temp folder anyway.
  }
});
let store: typeof import('../server/src/store').store;
let notesMod: typeof import('../server/src/notes');
let backup: typeof import('../server/src/backup');
let clean: typeof import('../server/src/clean');
beforeAll(async () => {
  ({ store } = await import('../server/src/store'));
  notesMod = await import('../server/src/notes');
  backup = await import('../server/src/backup');
  clean = await import('../server/src/clean');
}, 30_000);

const n = (id: string, name: string, text = '', extra: Partial<Note> = {}): Note => ({ id, name, text, ...extra });
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const t0 = Date.parse('2026-11-12T04:00:00Z');

describe('links between notepads', () => {
  const notes = [n('a', 'Groceries', 'eggs'), n('b', 'Plans', 'Buy from [[groceries]] and [[Trip ideas]]'), n('c', 'Week', 'See [[Groceries]].')];

  it('finds links and what links here, ignoring case', () => {
    expect(linksIn(notes[1].text)).toEqual(['groceries', 'Trip ideas']);
    expect(backlinks(notes, notes[0]).map((x) => x.id)).toEqual(['b', 'c']);
    expect(backlinks(notes, notes[1])).toEqual([]);
  });

  it('points links at a new name, and leaves other notepads as they were', () => {
    const next = renameLinks(notes, 'Groceries', 'Shopping');
    expect(next[1].text).toBe('Buy from [[Shopping]] and [[Trip ideas]]');
    expect(next[2].text).toBe('See [[Shopping]].');
    expect(next[0]).toBe(notes[0]);
  });
});

describe('tags, pins and search', () => {
  it('tidies tags', () => {
    expect(cleanTags(['#Work', 'work', ' big ideas ', 'a/b', '', 3])).toEqual(['work', 'big-ideas', 'ab']);
    expect(parseTags('work, home  ideas')).toEqual(['work', 'home', 'ideas']);
  });

  it('counts tags and puts pinned notepads first without changing the rest', () => {
    const notes = [n('a', 'A', '', { tags: ['x'] }), n('b', 'B', '', { pinned: true, tags: ['x', 'y'] }), n('c', 'C')];
    expect(allTags(notes)).toEqual([{ tag: 'x', count: 2 }, { tag: 'y', count: 1 }]);
    expect(pinnedFirst(notes).map((x) => x.id)).toEqual(['b', 'a', 'c']);
  });

  it('searches names, tags and text, every word, name matches first', () => {
    const notes = [n('a', 'Recipes', 'pasta with garlic\nsoup'), n('b', 'Garlic', 'grow it', { tags: ['garden'] }), n('c', 'Other', 'nothing')];
    const hits = searchNotes(notes, 'garlic');
    expect(hits.map((h) => h.note.id)).toEqual(['b', 'a']);
    expect(hits[1].lines).toEqual(['pasta with garlic']);
    expect(searchNotes(notes, '#garden').map((h) => h.note.id)).toEqual(['b']);
    expect(searchNotes(notes, 'pasta soup').map((h) => h.note.id)).toEqual(['a']);
    expect(searchNotes(notes, '  ')).toEqual([]);
  });
});

describe('images in notes', () => {
  it('goes on a line of its own where the cursor was', () => {
    const md = imageMarkdown('AbCdEfGhIjKlMnOp');
    expect(insertLines('one\ntwo', 3, md)).toBe(`one\n${md}\ntwo`);
    expect(insertLines('onetwo', 3, md)).toBe(`one\n${md}\ntwo`);
    expect(insertLines('', 0, md)).toBe(md);
    expect(imageIds(`x ${md} ![a](/api/note-images/short) ![](https://elsewhere.example/a.png)`)).toEqual(['AbCdEfGhIjKlMnOp']);
  });

  it('removes an image no note or version shows only once it’s been unused for a week', () => {
    const folder = fs.mkdtempSync(path.join(dataDir, 'imgs-'));
    const file = (id: string, ageDays: number) => {
      fs.writeFileSync(path.join(folder, id), 'x');
      const t = new Date(t0 - ageDays * DAY);
      fs.utimesSync(path.join(folder, id), t, t);
    };
    file('UsedOldUsedOld12', 30);
    file('UnusedOldUnused1', 8);
    file('UnusedNewUnused1', 2);
    fs.writeFileSync(path.join(folder, 'not-an-image-id'), 'x');
    const removed = notesMod.sweepNoteImages(new Set(['UsedOldUsedOld12']), t0, folder);
    expect(removed).toBe(1);
    expect(fs.readdirSync(folder).sort()).toEqual(['UnusedNewUnused1', 'UsedOldUsedOld12', 'not-an-image-id']);
    // Seen in use just now, so it gets a full week once it isn't.
    expect(fs.statSync(path.join(folder, 'UsedOldUsedOld12')).mtimeMs).toBe(t0);
    // A day short of a week unused: still there (the newer one, a week old by then, goes).
    expect(notesMod.sweepNoteImages(new Set(), t0 + 6 * DAY, folder)).toBe(1);
    expect(fs.readdirSync(folder)).toContain('UsedOldUsedOld12');
    expect(notesMod.sweepNoteImages(new Set(), t0 + 7 * DAY, folder)).toBe(1);
  });

  it('counts images in earlier versions as in use', () => {
    const md = imageMarkdown('InHistoryOnly123');
    expect([...notesMod.usedImages([n('a', 'A', 'none')], { a: [{ at: new Date(t0).toISOString(), name: 'A', text: md }] })]).toEqual(['InHistoryOnly123']);
  });
});

describe('version history', () => {
  const v = (hoursAgo: number, text = 't'): NoteVersion => ({ at: new Date(t0 - hoursAgo * HOUR).toISOString(), name: 'A', text });

  it('keeps every version from the last day, then one a day for a month', () => {
    const list = [v(1), v(5), v(23), v(30), v(31), v(50), v(24 * 29), v(24 * 31)];
    expect(thinHistory(list, t0).map((x) => (t0 - Date.parse(x.at)) / HOUR)).toEqual([1, 5, 23, 30, 50, 24 * 29]);
  });

  it('adds the earlier text when a notepad changes, at most once an hour', () => {
    const before = [n('a', 'A', 'first'), n('b', 'B', 'same')];
    const after = [n('a', 'A', 'second'), n('b', 'B', 'same')];
    const h1 = addVersions({}, before, after, t0)!;
    expect(h1).toEqual({ a: [{ at: new Date(t0).toISOString(), name: 'A', text: 'first' }] });
    // Half an hour later: not again.
    expect(addVersions(h1, after, [n('a', 'A', 'third'), after[1]], t0 + HOUR / 2)).toBeNull();
    const h2 = addVersions(h1, after, [n('a', 'A', 'third'), after[1]], t0 + HOUR)!;
    expect(h2.a.map((x) => x.text)).toEqual(['second', 'first']);
    // Nothing changed: nothing to write.
    expect(addVersions(h2, after, after, t0 + 2 * HOUR)).toBeNull();
  });

  it('keeps a long note at once when most of it is cut', () => {
    const long = 'x'.repeat(500);
    const h = addVersions({}, [n('a', 'A', 'old')], [n('a', 'A', long)], t0)!;
    const h2 = addVersions(h, [n('a', 'A', long)], [n('a', 'A', 'oops')], t0 + 60_000)!;
    expect(h2.a[0].text).toBe(long);
  });

  it('records versions as notes are saved on the server, and keeps one on request', () => {
    store.setNoteHistory({});
    const before = [n('h1', 'Diary', 'monday')];
    store.setNotes(before);
    notesMod.recordVersions(before, [n('h1', 'Diary', 'monday tuesday')]);
    expect(store.noteHistory().h1.map((x) => x.text)).toEqual(['monday']);
    store.setNotes([n('h1', 'Diary', 'monday tuesday')]);
    // Within the hour, another save adds nothing…
    notesMod.recordVersions(store.notes(), [n('h1', 'Diary', 'monday tuesday wednesday')]);
    expect(store.noteHistory().h1).toHaveLength(1);
    // …but asked for one, the current text is kept.
    expect(notesMod.keepVersion('h1').map((x) => x.text)).toEqual(['monday tuesday', 'monday']);
  });

  it('drops malformed versions', () => {
    expect(cleanHistory({ a: [{ at: new Date().toISOString(), name: 'A', text: 'ok' }, { at: 1 }], b: 'no' })).toEqual({ a: [expect.objectContaining({ text: 'ok' })] });
  });
});

describe('notes stay compatible', () => {
  it('accepts tags and pins, and notes without them, but nothing malformed', () => {
    expect(clean.validNotes([n('a', 'A'), n('b', 'B', '', { tags: ['x'], pinned: true })])).toBe(true);
    expect(clean.validNotes([n('a', 'A', '', { tags: 'x' as never })])).toBe(false);
    expect(clean.validNotes([n('a', 'A', '', { pinned: 'yes' as never })])).toBe(false);
  });

  it('merges tags and pins made on two devices', () => {
    const base = [n('a', 'A', 'text'), n('b', 'B')];
    const mine = [n('a', 'A', 'text', { pinned: true }), n('b', 'B')];
    const theirs = [n('a', 'A', 'text'), n('b', 'B', '', { tags: ['work'] })];
    expect(mergeNotes(base, mine, theirs).value).toEqual([n('a', 'A', 'text', { pinned: true }), n('b', 'B', '', { tags: ['work'] })]);
  });

  it('backs up and restores the history, and puts note images back from a .zip', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ffbf1e000502027fdd2a3a0000000049454e44ae426082', 'hex');
    const id = notesMod.writeNoteImage(png);
    store.setNotes([n('z', 'Pics', `look\n${imageMarkdown(id)}`)]);
    store.setNoteHistory({ z: [{ at: new Date().toISOString(), name: 'Pics', text: 'before' }] });
    const b = backup.exportBackup();
    expect(b.noteHistory?.z[0].text).toBe('before');
    const zip = Buffer.from(await new Response(backup.zipBackup()).arrayBuffer());
    fs.rmSync(path.join(dataDir, 'note-images', id));
    store.setNoteHistory({});
    backup.restoreBackup(backup.readBackupUpload(zip));
    expect(notesMod.readNoteImage(id)?.mime).toBe('image/png');
    expect(store.noteHistory().z[0].text).toBe('before');
    expect(store.notes()[0].text).toContain(id);
  });
});
