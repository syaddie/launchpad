// "Explain this log", for the Minecraft console and the containers' logs: the last
// error in a log (a few KB of it, with what led up to it) goes to Claude, which says in
// plain English what likely went wrong and how to fix it. Tokens, passwords and keys
// are taken out first, and the excerpt sent is shown with the answer. Only with
// ANTHROPIC_API_KEY, and not once this month's spending has reached the budget.
import crypto from 'node:crypto';
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { store } from './store';
import { FileError } from './shell';
import { fmtUsd, monthCost } from '../../shared/claudeUsage';
import type { ExplainResult, ExplainStatus } from '../../shared/types';

/** About this much of the log is sent. */
export const EXPLAIN_MAX = 6000;

// ---------- the part of the log that matters ----------

/** A line that reports something going wrong. */
const ERRORISH = /\b(ERROR|FATAL|SEVERE|CRITICAL|PANIC|Exception|Error:|Traceback|panic:|failed|fatal:|crash(ed)?|Caused by)\b|\/(ERROR|FATAL)\]|\[(ERROR|FATAL|SEVERE)\]|\b(error|err)\b[:=]/i;
/** A line that carries on the one before: a stack frame, "Caused by", "... 12 more", an indented line. */
const CONTINUES = /^(\s+|\t|Caused by|Suppressed:|\.\.\. \d+ more|\s*at\s)|^\s*File ".*", line \d+/;

/**
 * The last error in `text` with a few lines of what led up to it, cut to about `max`
 * characters (keeping the start, where the error says what it is, and the end, where
 * "Caused by" says why). Without an error line, the log's last lines.
 */
export function lastErrorBlock(text: string, max = EXPLAIN_MAX): { text: string; found: boolean } {
  const lines = text.replace(/\r/g, '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ERRORISH.test(lines[i])) {
      last = i;
      break;
    }
  }
  if (last < 0) return { text: cut(lines.slice(-60), max), found: false };
  // Back to where this error began: up through its stack and the error lines right before it.
  let start = last;
  while (start > 0 && (CONTINUES.test(lines[start]) || ERRORISH.test(lines[start - 1]) || CONTINUES.test(lines[start - 1]))) start--;
  let end = last;
  while (end + 1 < lines.length && CONTINUES.test(lines[end + 1])) end++;
  const from = Math.max(0, start - 10);
  const to = Math.min(lines.length, end + 6);
  return { text: cut(lines.slice(from, to), max), found: true };
}

/**
 * A Minecraft crash report says what went wrong at the top (Description, the exception
 * and its stack) and what it ran on at the bottom (System Details: versions, Java, mods).
 * Both, cut to about `max`.
 */
export function crashExcerpt(text: string, max = EXPLAIN_MAX): string {
  const t = text.replace(/\r/g, '');
  const walk = t.search(/^A detailed walkthrough of the error/m);
  const head = (walk > 0 ? t.slice(0, walk) : t).slice(0, Math.round(max * 0.65)).trimEnd();
  const at = t.search(/^-- System Details --/m);
  const details = at >= 0 ? t.slice(at, at + Math.round(max * 0.35) - 40).trimEnd() : '';
  return cut([...head.split('\n'), ...(details ? ['', '…', '', ...details.split('\n')] : [])], max);
}

function cut(lines: string[], max: number): string {
  const short = lines.map((l) => (l.length > 500 ? l.slice(0, 500) + '…' : l));
  const all = short.join('\n');
  if (all.length <= max) return all;
  const head: string[] = [];
  const tail: string[] = [];
  let size = 0;
  let i = 0;
  let j = short.length - 1;
  // About two fifths from the start, the rest from the end.
  while (i <= j && size + short[i].length + 1 <= max * 0.4) {
    size += short[i].length + 1;
    head.push(short[i++]);
  }
  while (j >= i && size + short[j].length + 1 <= max - 40) {
    size += short[j].length + 1;
    tail.unshift(short[j--]);
  }
  const left = j - i + 1;
  return [...head, ...(left > 0 ? [`… (${left} line${left === 1 ? '' : 's'} left out) …`] : []), ...tail].join('\n');
}

// ---------- secrets out ----------

/** Names a secret's value goes by: the end of a key such as db.password, access_token or x-api-key. */
const SECRET_WORDS = 'pass(?:word|wd|phrase)|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|authorization|cookie|session[_-]?(?:id|token|key)|license[_-]?key';
const SECRET_PAIR = new RegExp(`(["']?)\\b((?:[A-Za-z0-9]+[._-])*(?:${SECRET_WORDS}))\\1(\\s*[:=]\\s*)("[^"]*"|'[^']*'|[^\\s,;&"'})\\]]+)`, 'gi');
/** Values that aren't secrets: empty, masked already, or the Bearer in front of a token taken out already. */
const NOT_SECRET = /^["']?(null|none|true|false|bearer|basic|token|\*+|\[redacted\])?["']?$/i;

/** Tokens, passwords and keys replaced with [redacted], as far as they can be told apart from the rest. */
export function redact(text: string): string {
  return (
    text
      // Private keys, whole.
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]')
      // user:password@ in URLs.
      .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, '$1[redacted]@')
      // Authorization: Bearer …, Basic …
      .replace(/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [redacted]')
      // password=…, "token": "…", api_key: …, ?access_token=…
      .replace(SECRET_PAIR, (m: string, qt: string, k: string, sep: string, v: string) => (NOT_SECRET.test(v) ? m : `${qt}${k}${qt}${sep}[redacted]`))
      // Well-known token shapes.
      .replace(/\b(sk-ant-[A-Za-z0-9_-]{10,}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
      // JWTs.
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
      // Long runs of hex or base64-ish characters with letters and digits mixed: keys more often than not.
      .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]')
      .replace(/(?<![\w/.-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])[A-Za-z0-9_-]{40,}(?![\w/.-])/g, '[redacted]')
  );
}

// ---------- asking Claude ----------

export function explainStatus(now = new Date()): ExplainStatus {
  if (!claudeEnabled()) return { configured: false, ready: false, reason: 'Explaining needs Claude: set ANTHROPIC_API_KEY on the server and restart Launchpad.' };
  const budget = store.prefs().claudeBudget ?? 0;
  const spent = monthCost(store.claudeUsage(), now);
  if (budget > 0 && spent >= budget) return { configured: true, ready: false, reason: `This month’s Claude spending (${fmtUsd(spent)}) has reached your ${fmtUsd(budget)} budget. Raise it in Settings to explain more logs.` };
  return { configured: true, ready: true, reason: null };
}

const SYSTEM = [
  'You help someone who runs their own home server read a log. They are comfortable with a terminal but are not a Java or Docker expert.',
  'You get the end of one log: usually its last error with the lines before it. Work out the most likely root cause and how to fix it.',
  'Write plain, friendly English in short sentences. Name the actual file, setting, mod, plugin or command when the log shows it. No markdown.',
  'summary: one sentence on what happened. cause: two or three sentences on the most likely root cause, saying how sure you are when it is a guess.',
  'fix: up to five short steps, the likeliest fix first; commands or settings as they would be typed. If the log shows nothing wrong, say so and leave fix empty.',
  'Parts of the log may read [redacted]: secrets were taken out on purpose. Never ask for them.',
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    cause: { type: 'string' },
    fix: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'cause', 'fix'],
  additionalProperties: false,
};

/** The same excerpt twice in a few minutes gets the same answer, without paying again. */
const answers = new Map<string, { at: number; result: Promise<ExplainResult> }>();
const KEEP = 15 * 60_000;

/**
 * Explain the end of `log`. `what` says what it's from, e.g. "the Minecraft server Survival
 * (Paper 1.21.1)" or "the Docker container nextcloud".
 */
export function explainLog(what: string, log: string, opts: { crashReport?: boolean } = {}): Promise<ExplainResult> {
  const status = explainStatus();
  if (!status.ready) return Promise.reject(new FileError(status.reason!, 409));
  const block = opts.crashReport ? { text: crashExcerpt(log), found: true } : lastErrorBlock(log);
  if (!block.text.trim()) return Promise.reject(new FileError('The log is empty, so there’s nothing to explain.'));
  const excerpt = redact(block.text);
  const key = crypto.createHash('sha1').update(what + '\n' + excerpt).digest('hex');
  for (const [k, v] of answers) if (Date.now() - v.at > KEEP) answers.delete(k);
  const hit = answers.get(key);
  if (hit) return hit.result;
  const result = askJson<{ summary: string; cause: string; fix: string[] }>({
    model: config.explainModel,
    feature: 'explain',
    system: SYSTEM,
    user: `This is from ${what.slice(0, 200)}. ${opts.crashReport ? 'The start of the report and its system details:' : block.found ? 'Its last error, with what led up to it:' : 'There is no clear error line, so these are its last lines:'}\n\n${excerpt}`,
    schema: SCHEMA,
    effort: 'low',
    task: 'explain this log',
  }).then((r) => ({
    summary: String(r.summary ?? '').trim(),
    cause: String(r.cause ?? '').trim(),
    fix: Array.isArray(r.fix) ? r.fix.map((x) => String(x).trim()).filter(Boolean).slice(0, 6) : [],
    excerpt,
    foundError: block.found,
  }));
  answers.set(key, { at: Date.now(), result });
  result.catch(() => answers.get(key)?.result === result && answers.delete(key));
  return result;
}
