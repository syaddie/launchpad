// The daily digest: one short lesson a day for each subject followed (prefs.digestSubjects),
// written by Claude on the server (server/src/digest.ts). Every day is kept, so past lessons
// can be searched and starred, and Quick recall asks one question a day about a lesson from
// a few days back: right answers push its next turn further out, a wrong one brings it back soon.
import { addDays, dayDiff, parseYmd, startOfDay, ymd } from './dates';
import type { DigestCard, DigestDay, DigestFeedback, DigestQuiz, DigestRecall, DigestStore, RecallQuestion } from './types';

/** The subjects a new Launchpad follows. */
export const DEFAULT_SUBJECTS = ['Software engineering', 'Data science and ML', 'Mechanical and aerospace', 'Anything curious'];
/** Most subjects followed at once; each one is a lesson (and tokens) every day. */
export const MAX_SUBJECTS = 6;
export const MAX_SUBJECT_LEN = 60;
/** Days kept: ten years of lessons. */
export const MAX_DAYS = 3660;
/** Days the page gets with its state; older ones come from the archive's search. */
export const RECENT_DAYS = 14;
/** Concepts swapped out with "Another one", kept so they aren't written again. */
export const MAX_SKIPPED = 300;
/** A lesson first comes up in Quick recall this many days after it was written. */
export const FIRST_RECALL_DAYS = 3;
/** Days to the next recall after 1, 2 and 3 right answers in a row; after the last, it's learnt and stops coming up. */
export const RECALL_GAPS = [7, 21, 60];
/** Days to the next recall after a wrong answer. */
export const RETRY_DAYS = 2;

export const EMPTY_DIGEST: DigestStore = { days: [], skipped: [], error: null };

const isStr = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is string => isStr(v) && !Number.isNaN(Date.parse(v));
const isYmd = (v: unknown): v is string => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const text = (v: unknown, max: number) => (isStr(v) ? v.trim().slice(0, max) : '');

/** Same subject, ignoring case and spacing. */
export const sameSubject = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

/** Trimmed, de-duplicated (ignoring case), at most six of up to 60 characters. */
export function cleanSubjects(v: unknown): string[] {
  const out: string[] = [];
  for (const s of Array.isArray(v) ? v : []) {
    const t = text(s, 200).replace(/\s+/g, ' ').slice(0, MAX_SUBJECT_LEN);
    if (t && !out.some((o) => sameSubject(o, t))) out.push(t);
  }
  return out.slice(0, MAX_SUBJECTS);
}

function cleanQuiz(v: unknown): DigestQuiz | null {
  const q = (v && typeof v === 'object' ? v : {}) as Partial<DigestQuiz>;
  const question = text(q.question, 400);
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => text(o, 200)).filter(Boolean).slice(0, 5);
  const answer = typeof q.answer === 'number' && Number.isInteger(q.answer) ? q.answer : -1;
  if (!question || options.length < 2 || answer < 0 || answer >= options.length) return null;
  return { question, options, answer, why: text(q.why, 600) };
}

function cleanRecalls(v: unknown, options: number): DigestRecall[] {
  return (Array.isArray(v) ? v : [])
    .filter((r): r is DigestRecall => !!r && isTime(r.at) && typeof r.right === 'boolean')
    .map((r) => ({ at: r.at, right: r.right, choice: typeof r.choice === 'number' && Number.isInteger(r.choice) && r.choice >= 0 && r.choice < options ? r.choice : -1 }))
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-20);
}

/**
 * One lesson, as the store keeps it, or null when it's missing what the page needs (a subject,
 * a title, something to read). `id` is kept when it's there; Claude's new cards are given one first.
 */
export function cleanCard(v: unknown): DigestCard | null {
  const c = (v && typeof v === 'object' ? v : {}) as Partial<DigestCard>;
  const id = text(c.id, 40);
  const subject = text(c.subject, MAX_SUBJECT_LEN);
  const title = text(c.title, 120);
  const body = (Array.isArray(c.body) ? c.body : []).map((p) => text(p, 2000)).filter(Boolean).slice(0, 6);
  if (!id || !subject || !title || !body.length) return null;
  const quiz = cleanQuiz(c.quiz);
  return {
    id,
    subject,
    title,
    hook: text(c.hook, 400),
    body,
    example: text(c.example, 2500),
    takeaway: text(c.takeaway, 400),
    search: text(c.search, 120) || title,
    quiz,
    starred: c.starred === true,
    feedback: (['basic', 'deep'] as const).includes(c.feedback as 'basic') ? (c.feedback as DigestFeedback) : '',
    recalls: quiz ? cleanRecalls(c.recalls, quiz.options.length) : [],
  };
}

/** The digest as the store keeps it: days newest first, one per date, cards with unique ids. */
export function cleanDigest(v: unknown): DigestStore {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<DigestStore>;
  const ids = new Set<string>();
  const byDate = new Map<string, DigestDay>();
  for (const d of Array.isArray(o.days) ? o.days : []) {
    if (!d || !isYmd(d.date) || byDate.has(d.date)) continue;
    const cards = (Array.isArray(d.cards) ? d.cards : [])
      .map(cleanCard)
      .filter((c): c is DigestCard => !!c && !ids.has(c.id) && !!ids.add(c.id))
      .slice(0, MAX_SUBJECTS * 3);
    if (cards.length) byDate.set(d.date, { date: d.date, cards });
  }
  const days = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_DAYS);
  const skipped = (Array.isArray(o.skipped) ? o.skipped : []).map((s) => text(s, 200)).filter(Boolean).slice(-MAX_SKIPPED);
  return { days, skipped, error: isStr(o.error) ? o.error.slice(0, 1000) : null };
}

/** The subjects followed that have no lesson on `date` yet, in the order they're followed. */
export function subjectsMissing(digest: DigestStore, subjects: string[], date: string): string[] {
  const day = digest.days.find((d) => d.date === date);
  return subjects.filter((s) => !day?.cards.some((c) => sameSubject(c.subject, s)));
}

/** "subject: title" for every lesson so far (newest first) and every one swapped out: what not to write again. */
export function coveredTitles(digest: DigestStore, subject: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (t: string) => {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  };
  for (const d of digest.days) for (const c of d.cards) if (sameSubject(c.subject, subject)) add(c.title);
  for (const s of digest.skipped) {
    const i = s.indexOf(': ');
    if (i > 0 && sameSubject(s.slice(0, i), subject)) add(s.slice(i + 2));
  }
  return out;
}

/** Recent "too basic" and "too deep" on a subject's lessons, newest first, for pitching the next one. */
export function feedbackFor(digest: DigestStore, subject: string, max = 8): { title: string; feedback: 'basic' | 'deep' }[] {
  return digest.days
    .flatMap((d) => d.cards)
    .filter((c) => c.feedback && sameSubject(c.subject, subject))
    .slice(0, max)
    .map((c) => ({ title: c.title, feedback: c.feedback as 'basic' | 'deep' }));
}

/** The day a lesson is next due in Quick recall, or null once it's learnt (or has no question). */
export function recallDue(card: DigestCard, written: string): string | null {
  if (!card.quiz) return null;
  const last = card.recalls[card.recalls.length - 1];
  if (!last) return ymd(addDays(parseYmd(written), FIRST_RECALL_DAYS));
  const on = startOfDay(new Date(last.at));
  if (!last.right) return ymd(addDays(on, RETRY_DAYS));
  let streak = 0;
  for (let i = card.recalls.length - 1; i >= 0 && card.recalls[i].right; i--) streak++;
  return streak > RECALL_GAPS.length ? null : ymd(addDays(on, RECALL_GAPS[streak - 1]));
}

/**
 * Today's recall question: the lesson already asked about today (with how it went), or else
 * the one most overdue, the older lesson first when two are due the same day. Null when nothing's due.
 */
export function recallFor(digest: DigestStore, now: Date): { card: DigestCard; date: string; answered: DigestRecall | null } | null {
  const today = ymd(now);
  let best: { card: DigestCard; date: string; due: string } | null = null;
  for (const d of digest.days) {
    for (const card of d.cards) {
      const asked = card.recalls.find((r) => ymd(new Date(r.at)) === today);
      if (asked) return { card, date: d.date, answered: asked };
      const due = recallDue(card, d.date);
      // Most overdue first; between two due the same day, the older lesson, then the first of its day.
      if (due && due <= today && (!best || due < best.due || (due === best.due && d.date < best.date))) best = { card, date: d.date, due };
    }
  }
  return best && { card: best.card, date: best.date, answered: null };
}

/** What the page gets for Quick recall: the answer only once it's been given. */
export function recallQuestion(digest: DigestStore, now: Date): RecallQuestion | null {
  const r = recallFor(digest, now);
  if (!r || !r.card.quiz) return null;
  const { quiz } = r.card;
  return {
    cardId: r.card.id,
    date: r.date,
    subject: r.card.subject,
    title: r.card.title,
    question: quiz.question,
    options: quiz.options,
    answered: r.answered && { choice: r.answered.choice, right: r.answered.right, answer: quiz.answer, why: quiz.why, takeaway: r.card.takeaway },
  };
}

/** Lessons answered right in recall three times in a row (or more): learnt. */
export const isLearnt = (card: DigestCard) => !!card.quiz && card.recalls.length > RECALL_GAPS.length && card.recalls.slice(-RECALL_GAPS.length - 1).every((r) => r.right);

export interface ArchiveQuery {
  /** Words to find in the subject, title, hook, text, example or takeaway. */
  q?: string;
  subject?: string;
  starred?: boolean;
  /** Skip this many matches (for "Show more"). */
  offset?: number;
  limit?: number;
}

export type ArchiveCard = DigestCard & { date: string };

/** Lessons matching a search, newest first: every word has to appear somewhere in the lesson. */
export function searchArchive(digest: DigestStore, query: ArchiveQuery): { cards: ArchiveCard[]; total: number } {
  const words = (query.q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 10);
  const matches: ArchiveCard[] = [];
  for (const d of digest.days) {
    for (const c of d.cards) {
      if (query.subject && !sameSubject(c.subject, query.subject)) continue;
      if (query.starred && !c.starred) continue;
      if (words.length) {
        const hay = [c.subject, c.title, c.hook, ...c.body, c.example, c.takeaway].join('\n').toLowerCase();
        if (!words.every((w) => hay.includes(w))) continue;
      }
      matches.push({ ...c, date: d.date });
    }
  }
  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.min(100, Math.max(1, query.limit ?? 40));
  return { cards: matches.slice(offset, offset + limit), total: matches.length };
}

/** Every subject that has lessons in the archive, most lessons first: the archive's filter. */
export function archiveSubjects(digest: DigestStore): { subject: string; count: number }[] {
  const counts: { subject: string; count: number }[] = [];
  for (const d of digest.days) {
    for (const c of d.cards) {
      const row = counts.find((x) => sameSubject(x.subject, c.subject));
      if (row) row.count++;
      else counts.push({ subject: c.subject, count: 1 });
    }
  }
  return counts.sort((a, b) => b.count - a.count);
}

/** Where "Go deeper" goes: Wikipedia's article when the words name one, its search results when they don't. */
export const deeperUrl = (card: Pick<DigestCard, 'search' | 'title'>) =>
  `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(card.search || card.title)}&go=Go`;

/** Whole days from a lesson's date to today: 0 today, 1 yesterday. */
export function daysSince(date: string, now: Date): number {
  return dayDiff(parseYmd(date), startOfDay(now));
}
