// The daily digest: Claude writes one bite-sized lesson a day for each subject in
// prefs.digestSubjects, on the hourly sync (and when the Digest view opens on a day that
// hasn't got one yet). Each lesson comes with a quick question to answer on the card, and
// another that Quick recall asks a few days later; follow-up questions on a lesson are answered
// by a cheaper model (askCard). Only with ANTHROPIC_API_KEY. See shared/digest.ts for the rest.
import { randomBytes } from 'node:crypto';
import { askJson } from './claude';
import { config } from './config';
import { store } from './store';
import { DOW, MON, parseYmd, ymd } from '../../shared/dates';
import { cleanCard, coveredTitles, feedbackFor, MAX_ANSWER_LEN, MAX_ASK_LEN, MAX_ASKS, MAX_SKIPPED, recallFor, sameSubject, subjectsMissing } from '../../shared/digest';
import { repairTex } from '../../shared/math';
import type { DigestCard, DigestQuiz, DigestStore } from '../../shared/types';

const SYSTEM = `You write the daily digest on a personal dashboard: each day, one bite-sized lesson for each subject the owner follows, so they learn something new every day. They glance at it on a new browser tab and lose interest in long text, so every lesson is short and concrete: the core takes about twenty seconds to read, and there's a little more for when they tap in. Cut every word that isn't pulling its weight.

For each subject, pick one concept that:
- is worth knowing: an idea, method, law, effect or rule of thumb that changes how someone thinks about or does things in that field, with a name they can look up later
- is not in that subject's list of concepts already covered (not the same idea under another name, either)
- is pitched for a curious, technically minded adult. Use their feedback: when they marked a lesson "too basic", go further into the field next time; "too deep", go back towards foundations
- moves around the subject's areas from one day to the next, rather than staying in one corner
A broad subject such as "Anything curious" can come from any field: science, history, economics, psychology, language, the arts.

Write, for each lesson:
- subject: the subject exactly as given
- title: the concept's usual name, e.g. "Idempotency", "Bias–variance trade-off", "Reynolds number"
- hook: a teaser of at most 15 words that makes them want to know more: a surprising fact, a puzzle or a question. Not a definition.
- gist: the whole idea in one or two plain sentences, at most 40 words. Someone who reads only this should get it.
- formula: the concept's key formula or relation in LaTeX, without dollar signs, e.g. "Re = \\frac{\\rho v L}{\\mu}". Leave it empty when the idea has no formula; don't force one.
- where: what each symbol in the formula stands for, in one short line, e.g. "$\\rho$ density, $v$ speed, $L$ length, $\\mu$ viscosity". Empty when there's no formula.
- points: two or three short lines on how it works, when it applies or where it shows up, each at most 18 words. None repeats the gist.
- example: one tiny worked example of at most four short lines: real numbers worked through, or a few lines of code.
- exampleCode: true when the example is code.
- search: the words to look it up by on Wikipedia, usually the title
- check: a quick question shown right under the gist, so they test the idea straight away (the idea, not its name): three short options of at most 8 words each, the index of the right one (0 to 2), and why: one short sentence.
- quiz: a different question on the same idea, asked again a few days later to see if it stuck: four options, the index of the right one (0 to 3), and why: one or two sentences.
In both questions, make the wrong options plausible, and don't always put the right one in the same place.

All maths is LaTeX between single dollar signs, wherever it appears (gist, points, example, questions, options), e.g. "$E = mc^2$" or "$\\sigma(z) = \\frac{1}{1 + e^{-z}}$"; never write a formula as plain text such as "sigma(z) = 1/(1+e^-z)" or "x^2". A worked sum in the example is LaTeX too, one step per line. Plain numbers and units in a sentence ("about 2,300", "40 km/h") stay as they are. Write money as "USD 5" or with an escaped dollar sign, "\\$5". Code in the example is plain lines, with no dollar-sign maths.

Be accurate: only teach what's well established, and say when a figure is approximate. Write plainly, like a friend who knows the field: short words, short sentences. No hype, no emoji, no Markdown (no asterisks, headings or bullet symbols).`;

const QUIZ = (options: number) => ({
  type: 'object',
  properties: {
    question: { type: 'string' },
    options: { type: 'array', items: { type: 'string' }, description: `${options} options` },
    answer: { type: 'integer' },
    why: { type: 'string' },
  },
  required: ['question', 'options', 'answer', 'why'],
  additionalProperties: false,
});

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
          gist: { type: 'string' },
          formula: { type: 'string' },
          where: { type: 'string' },
          points: { type: 'array', items: { type: 'string' } },
          example: { type: 'string' },
          exampleCode: { type: 'boolean' },
          search: { type: 'string' },
          check: QUIZ(3),
          quiz: QUIZ(4),
        },
        required: ['subject', 'title', 'hook', 'gist', 'formula', 'where', 'points', 'example', 'exampleCode', 'search', 'check', 'quiz'],
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
  gist: string;
  formula: string;
  where: string;
  points: string[];
  example: string;
  exampleCode: boolean;
  search: string;
  check: DigestQuiz;
  quiz: DigestQuiz;
}

const fixQuiz = (q: DigestQuiz | undefined) => q && { ...q, question: fix(q.question), options: Array.isArray(q.options) ? q.options.map(fix) : q.options, why: fix(q.why) };
const fix = (v: unknown) => (typeof v === 'string' ? repairTex(v) : v) as string;

/** A lesson as Claude wrote it, with any LaTeX that lost a backslash on the way put right. */
function fixWritten(w: Written): Written {
  return {
    ...w,
    hook: fix(w.hook),
    gist: fix(w.gist),
    formula: typeof w.formula === 'string' ? repairTex(w.formula, true) : w.formula,
    where: fix(w.where),
    points: Array.isArray(w.points) ? w.points.map(fix) : w.points,
    example: w.exampleCode ? w.example : fix(w.example),
    check: fixQuiz(w.check)!,
    quiz: fixQuiz(w.quiz)!,
  };
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
    const card = cleanCard({ ...fixWritten(w), id: newId(), subject, starred: false, feedback: '', recalls: [], checked: -1, asks: [] });
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

/**
 * Star a lesson or not, say it was too basic or too deep (or clear that with ''), or answer its
 * quick check. Only the first answer to the check counts.
 */
export function markCard(id: string, patch: { starred?: unknown; feedback?: unknown; checked?: unknown }): void {
  const digest = store.digest();
  const found = findCard(digest, id);
  if (!found) throw new DigestError('That lesson isn’t in the digest any more.', 404);
  const { check } = found.card;
  const checked = patch.checked;
  if (checked !== undefined && (!check || typeof checked !== 'number' || !Number.isInteger(checked) || checked < 0 || checked >= check.options.length)) {
    throw new DigestError('Pick one of the answers.');
  }
  store.setDigest(
    mapCard(digest, id, (c) => ({
      ...c,
      ...(typeof patch.starred === 'boolean' ? { starred: patch.starred } : {}),
      ...(patch.feedback === '' || patch.feedback === 'basic' || patch.feedback === 'deep' ? { feedback: patch.feedback } : {}),
      ...(typeof checked === 'number' && c.checked < 0 ? { checked } : {}),
    })),
  );
}

const ASK_SYSTEM = `You answer follow-up questions on a lesson in the owner's daily digest, on their personal dashboard. They read the digest to learn a little every day and lose interest in long text, so answer briefly: two to four short sentences, about 70 words at most, unless they ask for an example or a derivation (then a few short lines). Answer what was asked, straight away: no preamble, no restating the question, no "great question".

All maths is LaTeX between single dollar signs, e.g. "$F = ma$", and an equation on a line of its own goes between double dollar signs. Write money as "USD 5" or "\\$5". Code is plain lines, with no dollar-sign maths. No Markdown (no asterisks, headings or bullet symbols), no emoji.

Be accurate: if something is uncertain, approximate or debated, say so in a few words. If the question strays from the lesson, answer it briefly anyway.`;

const ASK_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false };

const dayOf = (date: string) => day(parseYmd(date));

/** The request for a follow-up: the lesson, what's been asked on it so far, and the question. */
export function askInput(card: DigestCard, date: string, question: string): string {
  const lines = [`The lesson (${card.subject}, from ${dayOf(date)}): ${card.title}`];
  const add = (label: string, v: string) => v && lines.push(`${label}: ${v}`);
  add('Teaser', card.hook);
  add('The idea', card.gist || card.body.join(' '));
  add('Formula', card.formula && `$${card.formula}$${card.where ? ` (${card.where})` : ''}`);
  if (card.points.length) add('How it works', card.points.join(' / '));
  add('Example', card.example);
  add('To remember', card.takeaway);
  if (card.asks.length) {
    lines.push('', 'Asked on it already, oldest first:');
    for (const a of card.asks.slice(-6)) lines.push(`Q: ${a.q}`, `A: ${a.a}`);
  }
  lines.push('', `Their question: ${question}`);
  return lines.join('\n');
}

/** Claude's errors say it tries again on the next sync; a question is asked again by hand. */
const askAgain = (e: unknown) =>
  new Error(
    (e as Error).message
      .replace(/ It tries again on the next sync(?:, or press refresh)?([.;])/, ' Try asking again in a minute$1')
      .replace('Press refresh to try again.', 'Try asking again.'),
  );

/** A follow-up question on a lesson, answered by Claude and kept with it (the newest dozen). */
export async function askCard(id: string, question: unknown, now = new Date()): Promise<DigestCard> {
  const q = typeof question === 'string' ? question.trim().replace(/\s+/g, ' ') : '';
  if (!q) throw new DigestError('Type a question first.');
  if (q.length > MAX_ASK_LEN) throw new DigestError(`Keep the question under ${MAX_ASK_LEN} characters.`);
  const found = findCard(store.digest(), id);
  if (!found) throw new DigestError('That lesson isn’t in the digest any more.', 404);
  const r = await askJson<{ answer: string }>({
    model: config.digestAskModel,
    system: ASK_SYSTEM,
    user: askInput(found.card, found.day.date, q),
    schema: ASK_SCHEMA,
    effort: 'low',
    task: 'answer that question',
    feature: 'digest',
  }).catch((e) => {
    throw askAgain(e);
  });
  const answer = typeof r.answer === 'string' ? repairTex(r.answer).trim().slice(0, MAX_ANSWER_LEN) : '';
  if (!answer) throw new Error('Claude’s answer came back empty. Try asking again.');
  // Read again: the lesson may have been swapped, or another question answered, meanwhile.
  const digest = store.digest();
  if (!findCard(digest, id)) throw new DigestError('That lesson was swapped while Claude was answering.', 409);
  store.setDigest(mapCard(digest, id, (c) => ({ ...c, asks: [...c.asks, { q, a: answer, at: now.toISOString() }].slice(-MAX_ASKS) })));
  return findCard(store.digest(), id)!.card;
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
