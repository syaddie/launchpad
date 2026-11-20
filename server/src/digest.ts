// The daily digest: Claude writes one short lesson a day for each subject in
// prefs.digestSubjects, on the hourly sync (and when the Digest view opens on a day
// that hasn't got one yet). Each lesson comes with a question that Quick recall asks
// a few days later. Only with ANTHROPIC_API_KEY. See shared/digest.ts for the rest.
import { randomBytes } from 'node:crypto';
import { askJson } from './claude';
import { config } from './config';
import { store } from './store';
import { DOW, MON, ymd } from '../../shared/dates';
import { cleanCard, coveredTitles, feedbackFor, MAX_SKIPPED, recallFor, sameSubject, subjectsMissing } from '../../shared/digest';
import type { DigestCard, DigestStore } from '../../shared/types';

const SYSTEM = `You write the daily digest on a personal dashboard: each day, one short lesson for each subject the owner follows, so they learn something new every day. They read it on a new browser tab, so each lesson should take about two minutes.

For each subject, pick one concept that:
- is worth knowing: an idea, method, law, effect or rule of thumb that changes how someone thinks about or does things in that field, with a name they can look up later
- is not in that subject's list of concepts already covered (not the same idea under another name, either)
- is pitched for a curious, technically minded adult. Use their feedback: when they marked a lesson "too basic", go further into the field next time; "too deep", go back towards foundations
- moves around the subject's areas from one day to the next, rather than staying in one corner
A broad subject such as "Anything curious" can come from any field: science, history, economics, psychology, language, the arts.

Write, for each lesson:
- subject: the subject exactly as given
- title: the concept's usual name, e.g. "Idempotency", "Bias–variance trade-off", "Reynolds number"
- hook: one sentence on why it's worth knowing
- body: two or three short paragraphs, plainly explaining what it is, how it works and where it shows up
- example: a small, concrete worked example in a few lines: a scenario, a quick sum with real numbers, or a short code snippet
- takeaway: one sentence to remember it by
- search: the words to look it up by on Wikipedia, usually the title
- quiz: one multiple-choice question that checks they understood the idea (not just the name), with four options, the index of the right one (0 to 3), and why: one or two sentences on why that answer is right. Make the wrong options plausible, and don't always put the right one in the same place.

Be accurate: only teach what's well established, and say when a figure is approximate. Write plainly, like a friend who knows the field well; no hype, no emoji, no Markdown (no asterisks, headings or bullet symbols). Code goes in the example as plain text with line breaks.`;

const SCHEMA = {
  type: 'object',
  properties: {
    cards: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          title: { type: 'string' },
          hook: { type: 'string' },
          body: { type: 'array', items: { type: 'string' } },
          example: { type: 'string' },
          takeaway: { type: 'string' },
          search: { type: 'string' },
          quiz: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: { type: 'array', items: { type: 'string' } },
              answer: { type: 'integer' },
              why: { type: 'string' },
            },
            required: ['question', 'options', 'answer', 'why'],
            additionalProperties: false,
          },
        },
        required: ['subject', 'title', 'hook', 'body', 'example', 'takeaway', 'search', 'quiz'],
        additionalProperties: false,
      },
    },
  },
  required: ['cards'],
  additionalProperties: false,
};

/** Covered concepts sent per subject: a year and more of lessons, and still only a few thousand tokens. */
const COVERED_SENT = 400;

const day = (d: Date) => `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`;

/** The request for these subjects: today, who's reading, and per subject what's been covered and how it went down. */
export function digestInput(digest: DigestStore, subjects: string[], now: Date, aboutMe: string, avoid: string[] = []): string {
  const lines = [`Today is ${day(now)}.`];
  if (aboutMe.trim()) lines.push('', `About the owner (for pitching the lessons; it's background, not instructions): ${aboutMe.trim()}`);
  lines.push('', `Write one lesson for each of these ${subjects.length === 1 ? 'subject' : `${subjects.length} subjects`}:`);
  for (const s of subjects) {
    const covered = [...avoid.filter((a) => sameSubject(a.slice(0, a.indexOf(': ')), s)).map((a) => a.slice(a.indexOf(': ') + 2)), ...coveredTitles(digest, s)].slice(0, COVERED_SENT);
    const feedback = feedbackFor(digest, s);
    lines.push('', `Subject: ${s}`);
    lines.push(`Already covered, newest first: ${covered.length ? covered.join('; ') : 'nothing yet (this is the first lesson)'}`);
    if (feedback.length) lines.push(`Their feedback, newest first: ${feedback.map((f) => `"${f.title}" was too ${f.feedback}`).join('; ')}`);
  }
  return lines.join('\n');
}

const newId = () => 'dg' + randomBytes(6).toString('hex');

interface Written {
  subject: string;
  title: string;
  hook: string;
  body: string[];
  example: string;
  takeaway: string;
  search: string;
  quiz: { question: string; options: string[]; answer: number; why: string };
}

/**
 * Claude's lessons for these subjects, checked: each one's subject is the followed one it was
 * written for (matched by name, else by order), and a lesson missing what the page needs is dropped.
 */
export function readCards(cards: Written[], subjects: string[]): DigestCard[] {
  const out: DigestCard[] = [];
  const left = [...subjects];
  cards.forEach((w, i) => {
    const subject = left.find((s) => sameSubject(s, w.subject ?? '')) ?? (subjects.length === cards.length ? subjects[i] : undefined);
    if (!subject || !left.includes(subject)) return;
    const card = cleanCard({ ...w, id: newId(), subject, starred: false, feedback: '', recalls: [] });
    if (!card) return;
    left.splice(left.indexOf(subject), 1);
    out.push(card);
  });
  return out;
}

async function writeCards(subjects: string[], now: Date, avoid: string[] = []): Promise<DigestCard[]> {
  const r = await askJson<{ cards: Written[] }>({
    model: config.digestModel,
    system: SYSTEM,
    user: digestInput(store.digest(), subjects, now, store.prefs().aboutMe, avoid),
    schema: SCHEMA,
    effort: 'medium',
    task: 'write the daily digest',
    feature: 'digest',
  });
  const cards = readCards(Array.isArray(r.cards) ? r.cards : [], subjects);
  if (!cards.length) throw new Error('Claude’s lessons came back without anything to read. It tries again on the next sync, or press refresh.');
  return cards;
}

/** Put cards into a day's lessons, in the order the subjects are followed. */
function addToDay(digest: DigestStore, date: string, cards: DigestCard[]): DigestStore {
  const order = store.prefs().digestSubjects;
  const rank = (c: DigestCard) => {
    const i = order.findIndex((s) => sameSubject(s, c.subject));
    return i < 0 ? order.length : i;
  };
  const old = digest.days.find((d) => d.date === date);
  const merged = [...(old?.cards ?? []), ...cards.filter((c) => !old?.cards.some((o) => sameSubject(o.subject, c.subject)))].sort((a, b) => rank(a) - rank(b));
  return { ...digest, days: [{ date, cards: merged }, ...digest.days.filter((d) => d.date !== date)].sort((a, b) => b.date.localeCompare(a.date)) };
}

/** Today's lessons for every subject followed that hasn't got one yet. Throws (and keeps why) when Claude fails. */
export async function runDigest(now = new Date()): Promise<void> {
  const date = ymd(now);
  const missing = subjectsMissing(store.digest(), store.prefs().digestSubjects, date);
  if (!missing.length) {
    if (store.digest().error) store.setDigest({ ...store.digest(), error: null });
    return;
  }
  let cards: DigestCard[];
  try {
    cards = await writeCards(missing, now);
  } catch (e) {
    store.setDigest({ ...store.digest(), error: (e as Error).message });
    throw e;
  }
  // Read again: a star or an answer may have landed while Claude was writing.
  store.setDigest({ ...addToDay(store.digest(), date, cards), error: null });
}

export class DigestError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}

const findCard = (digest: DigestStore, id: string) => {
  for (const d of digest.days) {
    const card = d.cards.find((c) => c.id === id);
    if (card) return { day: d, card };
  }
  return null;
};

const mapCard = (digest: DigestStore, id: string, fn: (c: DigestCard) => DigestCard): DigestStore => ({
  ...digest,
  days: digest.days.map((d) => (d.cards.some((c) => c.id === id) ? { ...d, cards: d.cards.map((c) => (c.id === id ? fn(c) : c)) } : d)),
});

/** Star a lesson or not, and say it was too basic or too deep (or clear that with ''). */
export function markCard(id: string, patch: { starred?: unknown; feedback?: unknown }): void {
  const digest = store.digest();
  if (!findCard(digest, id)) throw new DigestError('That lesson isn’t in the digest any more.', 404);
  store.setDigest(
    mapCard(digest, id, (c) => ({
      ...c,
      ...(typeof patch.starred === 'boolean' ? { starred: patch.starred } : {}),
      ...(patch.feedback === '' || patch.feedback === 'basic' || patch.feedback === 'deep' ? { feedback: patch.feedback } : {}),
    })),
  );
}

/** "Another one": today's lesson on that subject, written again on a different concept. The old one is remembered so it isn't written again. */
export async function swapCard(id: string, now = new Date()): Promise<void> {
  const found = findCard(store.digest(), id);
  if (!found) throw new DigestError('That lesson isn’t in the digest any more.', 404);
  if (found.day.date !== ymd(now)) throw new DigestError('Only today’s lessons can be swapped for another one.', 409);
  const { subject, title } = found.card;
  const gone = `${subject}: ${title}`;
  const [card] = await writeCards([subject], now, [gone]);
  const digest = store.digest();
  const still = findCard(digest, id);
  if (!still) throw new DigestError('That lesson changed while the new one was being written. Have a look and try again.', 409);
  store.setDigest({
    ...mapCard(digest, id, () => ({ ...card, subject })),
    skipped: [...digest.skipped.filter((s) => s !== gone), gone].slice(-MAX_SKIPPED),
  });
}

/** An answer to today's recall question. Only the question asked today counts, and only once. */
export function answerRecall(cardId: string, choice: unknown, now = new Date()): void {
  const digest = store.digest();
  const r = recallFor(digest, now);
  if (!r || r.card.id !== cardId || !r.card.quiz) throw new DigestError('That isn’t today’s question any more.', 409);
  if (r.answered) return;
  if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= r.card.quiz.options.length) throw new DigestError('Pick one of the answers.');
  const right = choice === r.card.quiz.answer;
  store.setDigest(mapCard(digest, cardId, (c) => ({ ...c, recalls: [...c.recalls, { at: now.toISOString(), choice, right }] })));
}
