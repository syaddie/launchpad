import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// This file writes the digest to the store, so it gets a database of its own.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-digest-'));
process.env.DATA_DIR = dataDir;
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows won't delete the database while it's open; it's in the temp folder anyway.
  }
});

const claude = vi.hoisted(() => ({ enabled: true, calls: [] as { model: string; feature?: string; user: string; system: string }[], answer: null as unknown, fail: '' }));
vi.mock('../server/src/claude', () => ({
  claudeEnabled: () => claude.enabled,
  askJson: vi.fn(async (o: { model: string; feature?: string; user: string; system: string }) => {
    claude.calls.push(o);
    if (claude.fail) throw new Error(claude.fail);
    return claude.answer;
  }),
}));

import {
  cleanCard, cleanDigest, cleanSubjects, coveredTitles, deeperUrl, EMPTY_DIGEST, feedbackFor, isLearnt, recallDue, recallFor, recallQuestion, searchArchive, subjectsMissing,
} from '../shared/digest';
import { ymd } from '../shared/dates';
import type { DigestCard, DigestStore } from '../shared/types';

let digest: typeof import('../server/src/digest');
let store: typeof import('../server/src/store').store;
let state: typeof import('../server/src/state').state;
let backup: typeof import('../server/src/backup');
let clean: typeof import('../server/src/clean');

beforeAll(async () => {
  digest = await import('../server/src/digest');
  ({ store } = await import('../server/src/store'));
  ({ state } = await import('../server/src/state'));
  backup = await import('../server/src/backup');
  clean = await import('../server/src/clean');
}, 30_000);

const quiz = { question: 'Which is idempotent?', options: ['POST', 'PUT', 'PATCH', 'CONNECT'], answer: 1, why: 'PUT sets the same state however often it runs.' };
const card = (id: string, over: Partial<DigestCard> = {}): DigestCard => ({
  id,
  subject: 'Software engineering',
  title: `Concept ${id}`,
  hook: 'Why it matters.',
  body: ['What it is.'],
  example: 'An example.',
  takeaway: 'Remember this.',
  search: `Concept ${id}`,
  quiz,
  starred: false,
  feedback: '',
  recalls: [],
  ...over,
});
const at = (date: string, h = 9) => new Date(`${date}T${String(h).padStart(2, '0')}:00:00+08:00`);
const withDays = (...days: [string, DigestCard[]][]): DigestStore => cleanDigest({ days: days.map(([date, cards]) => ({ date, cards })), skipped: [], error: null });

describe('subjects', () => {
  it('trims, drops repeats ignoring case and spacing, and keeps at most six', () => {
    expect(cleanSubjects([' Software  engineering ', 'software engineering', '', 3, 'Finance'])).toEqual(['Software engineering', 'Finance']);
    expect(cleanSubjects(Array.from({ length: 9 }, (_, i) => `S${i}`))).toHaveLength(6);
    expect(cleanSubjects(['x'.repeat(100)])[0]).toHaveLength(60);
    expect(cleanSubjects('nope')).toEqual([]);
  });

  it('are saved with the settings, and a News view switched off stays off as the Digest', () => {
    const prev = store.prefs();
    expect(prev.digestSubjects.length).toBeGreaterThan(0);
    const next = clean.cleanPrefs({ digestSubjects: ['Finance', 'finance'], hidden: ['view:news', 'view:money'] }, prev);
    expect(next.digestSubjects).toEqual(['Finance']);
    expect(next.hidden).toEqual(['view:digest', 'view:money']);
    // What the old News view followed is kept as it was.
    expect(next.newsTopics).toEqual(prev.newsTopics);
    store.setPrefs({ ...prev, hidden: ['view:news'] });
    expect(store.prefs().hidden).toEqual(['view:digest']);
    store.setPrefs(prev);
  });
});

describe('cleaning what the store keeps', () => {
  it('drops lessons without what the page needs and questions that don’t add up', () => {
    expect(cleanCard({ ...card('a'), title: '' })).toBeNull();
    expect(cleanCard({ ...card('a'), body: [] })).toBeNull();
    expect(cleanCard({ ...card('a'), quiz: { ...quiz, answer: 4 } })!.quiz).toBeNull();
    expect(cleanCard({ ...card('a'), quiz: { ...quiz, options: ['only one'], answer: 0 } })!.quiz).toBeNull();
    const c = cleanCard({ ...card('a'), feedback: 'meh', starred: 'yes', search: '', recalls: [{ at: 'never', right: true }, { at: '2026-11-01T01:00:00Z', right: false, choice: 9 }] })!;
    expect(c).toMatchObject({ feedback: '', starred: false, search: 'Concept a' });
    expect(c.recalls).toEqual([{ at: '2026-11-01T01:00:00Z', right: false, choice: -1 }]);
  });

  it('keeps days newest first, one per date, with each lesson once', () => {
    const d = cleanDigest({
      days: [
        { date: '2026-11-18', cards: [card('a')] },
        { date: '2026-11-20', cards: [card('b'), card('a')] },
        { date: '2026-11-18', cards: [card('c')] },
        { date: 'soon', cards: [card('d')] },
        { date: '2026-11-19', cards: [] },
      ],
      skipped: ['Software engineering: Old', 4],
      error: 7,
    });
    expect(d.days.map((x) => [x.date, x.cards.map((c) => c.id)])).toEqual([['2026-11-20', ['b']], ['2026-11-18', ['a']]]);
    expect(d.skipped).toEqual(['Software engineering: Old']);
    expect(d.error).toBeNull();
    expect(cleanDigest(null)).toEqual(EMPTY_DIGEST);
  });
});

describe('what to write next', () => {
  const d: DigestStore = {
    ...withDays(['2026-11-20', [card('a', { feedback: 'basic' })]], ['2026-11-19', [card('b'), card('c', { subject: 'Finance', feedback: 'deep' })]]),
    skipped: ['software engineering: Swapped out', 'Finance: Compound interest'],
  };

  it('knows which subjects have no lesson today', () => {
    expect(subjectsMissing(d, ['Software Engineering', 'Finance', 'Poetry'], '2026-11-20')).toEqual(['Finance', 'Poetry']);
    expect(subjectsMissing(EMPTY_DIGEST, ['Finance'], '2026-11-20')).toEqual(['Finance']);
  });

  it('lists what each subject has covered, swapped-out lessons included', () => {
    expect(coveredTitles(d, 'Software engineering')).toEqual(['Concept a', 'Concept b', 'Swapped out']);
    expect(coveredTitles(d, 'finance')).toEqual(['Concept c', 'Compound interest']);
  });

  it('passes on “too basic” and “too deep”, per subject', () => {
    expect(feedbackFor(d, 'Software engineering')).toEqual([{ title: 'Concept a', feedback: 'basic' }]);
    expect(feedbackFor(d, 'Finance')).toEqual([{ title: 'Concept c', feedback: 'deep' }]);
  });

  it('tells Claude the day, the reader, and per subject what’s done and how it went down', () => {
    const user = digest.digestInput(d, ['Software engineering', 'Finance'], at('2026-11-21'), 'I work on jet engines.', ['Finance: Rule of 72']);
    expect(user).toContain('Today is Sat 21 Nov 2026.');
    expect(user).toContain('I work on jet engines.');
    expect(user).toContain('Subject: Software engineering\nAlready covered, newest first: Concept a; Concept b; Swapped out');
    expect(user).toContain('"Concept a" was too basic');
    expect(user).toContain('Already covered, newest first: Rule of 72; Concept c; Compound interest');
    expect(digest.digestInput(EMPTY_DIGEST, ['Poetry'], at('2026-11-21'), '')).toContain('nothing yet (this is the first lesson)');
  });
});

describe('reading Claude’s lessons', () => {
  const w = (subject: string, title = 'Idempotency') => ({ subject, title, hook: 'h', body: ['b'], example: 'e', takeaway: 't', search: title, quiz });

  it('matches each lesson to the subject it was written for, and drops ones it can’t use', () => {
    const cards = digest.readCards([w('finance', 'Compounding'), w('Software engineering'), w('Software engineering', 'Twice'), { ...w('Poetry'), body: [] }], ['Software engineering', 'Finance', 'Poetry']);
    expect(cards.map((c) => [c.subject, c.title])).toEqual([['Finance', 'Compounding'], ['Software engineering', 'Idempotency']]);
    expect(new Set(cards.map((c) => c.id)).size).toBe(2);
    expect(cards[0]).toMatchObject({ starred: false, feedback: '', recalls: [] });
  });

  it('goes by order when the names come back changed but the count is right', () => {
    expect(digest.readCards([w('SWE'), w('Money')], ['Software engineering', 'Finance']).map((c) => c.subject)).toEqual(['Software engineering', 'Finance']);
  });
});

describe('Quick recall', () => {
  it('first asks three days after a lesson, then later after each right answer, and soon after a wrong one', () => {
    const c = card('a');
    expect(recallDue(c, '2026-11-01')).toBe('2026-11-04');
    const r = (date: string, right: boolean) => ({ at: at(date).toISOString(), choice: right ? 1 : 0, right });
    expect(recallDue({ ...c, recalls: [r('2026-11-04', false)] }, '2026-11-01')).toBe('2026-11-06');
    expect(recallDue({ ...c, recalls: [r('2026-11-04', true)] }, '2026-11-01')).toBe('2026-11-11');
    expect(recallDue({ ...c, recalls: [r('2026-11-04', true), r('2026-11-11', true)] }, '2026-11-01')).toBe('2026-12-02');
    expect(recallDue({ ...c, recalls: [r('2026-11-04', true), r('2026-11-11', true), r('2026-12-02', true)] }, '2026-11-01')).toBe('2027-01-31');
    const learnt = { ...c, recalls: [r('2026-11-04', true), r('2026-11-11', true), r('2026-12-02', true), r('2027-01-31', true)] };
    expect(recallDue(learnt, '2026-11-01')).toBeNull();
    expect(isLearnt(learnt)).toBe(true);
    // A wrong answer starts the streak again.
    expect(recallDue({ ...c, recalls: [r('2026-11-04', true), r('2026-11-11', false), r('2026-11-13', true)] }, '2026-11-01')).toBe('2026-11-20');
    expect(recallDue({ ...c, quiz: null }, '2026-11-01')).toBeNull();
  });

  it('asks about the most overdue lesson, the older one when two are due together, and nothing when none is', () => {
    const d = withDays(['2026-11-19', [card('new')]], ['2026-11-17', [card('mid')]], ['2026-11-16', [card('old1'), card('old2')]]);
    expect(recallFor(d, at('2026-11-18'))).toBeNull();
    expect(recallFor(d, at('2026-11-19'))!.card.id).toBe('old1');
    expect(recallFor(d, at('2026-11-20'))!.card.id).toBe('old1');
    // Answered right yesterday: that one comes back in a week, so the next most overdue is asked.
    const answered = withDays(['2026-11-17', [card('mid')]], ['2026-11-16', [card('old1', { recalls: [{ at: at('2026-11-19').toISOString(), choice: 1, right: true }] }), card('old2')]]);
    expect(recallFor(answered, at('2026-11-20'))!.card.id).toBe('old2');
  });

  it('keeps today’s question on screen once answered, with the answer only then', () => {
    const d = withDays(['2026-11-16', [card('a')]]);
    const q = recallQuestion(d, at('2026-11-20'))!;
    expect(q).toMatchObject({ cardId: 'a', date: '2026-11-16', question: quiz.question, options: quiz.options, answered: null });
    expect(JSON.stringify(q)).not.toContain(quiz.why);
    const done = withDays(['2026-11-16', [card('a', { recalls: [{ at: at('2026-11-20', 8).toISOString(), choice: 2, right: false }] })]]);
    expect(recallQuestion(done, at('2026-11-20', 22))!.answered).toEqual({ choice: 2, right: false, answer: 1, why: quiz.why, takeaway: 'Remember this.' });
    // The next day it's gone: due again two days after the wrong answer.
    expect(recallQuestion(done, at('2026-11-21'))).toBeNull();
    expect(recallQuestion(done, at('2026-11-22'))!.answered).toBeNull();
  });
});

describe('the archive', () => {
  const d = withDays(
    ['2026-11-20', [card('a', { title: 'Idempotency', body: ['Retries are safe.'] }), card('b', { subject: 'Finance', title: 'Compound interest', starred: true })]],
    ['2026-11-19', [card('c', { title: 'Backpressure', example: 'A queue that retries slows producers.' })]],
  );

  it('finds every word anywhere in a lesson, newest first', () => {
    expect(searchArchive(d, {}).cards.map((c) => [c.id, c.date])).toEqual([['a', '2026-11-20'], ['b', '2026-11-20'], ['c', '2026-11-19']]);
    expect(searchArchive(d, { q: 'RETRIES' }).cards.map((c) => c.id)).toEqual(['a', 'c']);
    expect(searchArchive(d, { q: 'retries queue' }).cards.map((c) => c.id)).toEqual(['c']);
    expect(searchArchive(d, { q: 'nothing here' })).toEqual({ cards: [], total: 0 });
  });

  it('filters by subject and stars, and pages', () => {
    expect(searchArchive(d, { subject: 'finance' }).cards.map((c) => c.id)).toEqual(['b']);
    expect(searchArchive(d, { starred: true }).cards.map((c) => c.id)).toEqual(['b']);
    expect(searchArchive(d, { offset: 1, limit: 1 })).toMatchObject({ total: 3, cards: [{ id: 'b' }] });
  });

  it('links Go deeper to Wikipedia', () => {
    expect(deeperUrl({ search: 'Bias–variance tradeoff', title: 'x' })).toBe('https://en.wikipedia.org/wiki/Special:Search?search=Bias%E2%80%93variance%20tradeoff&go=Go');
  });
});

describe('on the server', () => {
  const today = ymd(new Date());
  const lesson = (subject: string, title: string) => ({ subject, title, hook: 'h', body: ['b'], example: 'e', takeaway: 't', search: title, quiz });

  beforeEach(() => {
    claude.calls = [];
    claude.fail = '';
    claude.enabled = true;
    store.setDigest(EMPTY_DIGEST);
    store.setPrefs({ ...store.prefs(), digestSubjects: ['Software engineering', 'Finance'], aboutMe: '' });
  });

  it('writes today’s lessons once, and only the missing subject’s when one is added', async () => {
    claude.answer = { cards: [lesson('Software engineering', 'Idempotency'), lesson('Finance', 'Compound interest')] };
    await digest.runDigest();
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]).toMatchObject({ feature: 'digest' });
    expect(store.digest().days[0]).toMatchObject({ date: today, cards: [{ subject: 'Software engineering' }, { subject: 'Finance' }] });
    await digest.runDigest();
    expect(claude.calls).toHaveLength(1);

    store.setPrefs({ ...store.prefs(), digestSubjects: ['Poetry', 'Software engineering', 'Finance'] });
    claude.answer = { cards: [lesson('Poetry', 'Enjambment')] };
    await digest.runDigest();
    expect(claude.calls[1].user).toContain('Subject: Poetry');
    expect(claude.calls[1].user).not.toContain('Subject: Finance');
    // In the order the subjects are followed.
    expect(store.digest().days[0].cards.map((c) => c.title)).toEqual(['Enjambment', 'Idempotency', 'Compound interest']);
  });

  it('keeps why it failed, and clears it once lessons are written', async () => {
    claude.fail = 'Hit the Claude API rate limit.';
    await expect(digest.runDigest()).rejects.toThrow(/rate limit/);
    expect(store.digest().error).toBe('Hit the Claude API rate limit.');
    expect(state().digest.error).toBe('Hit the Claude API rate limit.');
    claude.fail = '';
    claude.answer = { cards: [] };
    await expect(digest.runDigest()).rejects.toThrow(/without anything to read/);
    claude.answer = { cards: [lesson('Software engineering', 'Idempotency'), lesson('Finance', 'Compound interest')] };
    await digest.runDigest();
    expect(store.digest().error).toBeNull();
  });

  it('stars and rates a lesson, and swaps today’s for another one it won’t write again', async () => {
    claude.answer = { cards: [lesson('Software engineering', 'Idempotency'), lesson('Finance', 'Compound interest')] };
    await digest.runDigest();
    const [a] = store.digest().days[0].cards;
    digest.markCard(a.id, { starred: true, feedback: 'deep' });
    expect(store.digest().days[0].cards[0]).toMatchObject({ starred: true, feedback: 'deep' });
    digest.markCard(a.id, { feedback: 'nonsense' });
    expect(store.digest().days[0].cards[0].feedback).toBe('deep');
    expect(() => digest.markCard('nope', { starred: true })).toThrow(/isn’t in the digest/);

    claude.answer = { cards: [lesson('Software engineering', 'Backpressure')] };
    await digest.swapCard(a.id);
    expect(claude.calls[1].user).toContain('Already covered, newest first: Idempotency');
    expect(store.digest().days[0].cards.map((c) => c.title)).toEqual(['Backpressure', 'Compound interest']);
    expect(store.digest().skipped).toEqual(['Software engineering: Idempotency']);
    expect(coveredTitles(store.digest(), 'Software engineering')).toEqual(['Backpressure', 'Idempotency']);
  });

  it('only swaps today’s lessons', async () => {
    store.setDigest(withDays(['2026-01-02', [card('old')]]));
    await expect(digest.swapCard('old')).rejects.toThrow(/Only today’s/);
    expect(claude.calls).toHaveLength(0);
  });

  it('takes one answer to today’s question, and none to any other', () => {
    store.setDigest(withDays([ymd(new Date(Date.now() - 5 * 86_400_000)), [card('q1'), card('q2')]]));
    expect(state().digest.recall).toMatchObject({ cardId: 'q1', answered: null });
    expect(() => digest.answerRecall('q2', 1)).toThrow(/isn’t today’s question/);
    expect(() => digest.answerRecall('q1', 9)).toThrow(/Pick one/);
    digest.answerRecall('q1', 0);
    digest.answerRecall('q1', 1);
    const recalls = store.digest().days[0].cards[0].recalls;
    expect(recalls).toHaveLength(1);
    expect(recalls[0]).toMatchObject({ choice: 0, right: false });
    expect(state().digest.recall!.answered).toMatchObject({ choice: 0, right: false, answer: 1 });
  });

  it('sends the page two weeks of lessons, with the archive’s size and subjects', () => {
    const days = Array.from({ length: 20 }, (_, i) => [ymd(new Date(Date.now() - i * 86_400_000)), [card(`c${i}`, i % 2 ? { subject: 'Finance' } : {})]] as [string, DigestCard[]]);
    store.setDigest(withDays(...days));
    const s = state().digest;
    expect(s.days).toHaveLength(14);
    expect(s.total).toBe(20);
    expect(s.subjects).toEqual([{ subject: 'Software engineering', count: 10 }, { subject: 'Finance', count: 10 }]);
  });

  it('goes into backups and comes back from them', () => {
    store.setDigest(withDays(['2026-11-16', [card('kept', { starred: true })]]));
    const file = backup.exportBackup();
    expect(file.digest!.days[0].cards[0]).toMatchObject({ id: 'kept', starred: true });
    store.setDigest(EMPTY_DIGEST);
    expect(backup.restoreBackup({ version: 2, exported: new Date().toISOString(), bookmarks: [], notes: [], digest: file.digest })).toContain('digest');
    expect(store.digest().days[0].cards[0].id).toBe('kept');
  });
});
