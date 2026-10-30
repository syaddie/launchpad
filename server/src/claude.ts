// The one Claude call Launchpad makes: a system prompt, a user message and a
// JSON schema in, the parsed JSON out. Used by the News and Inbox summaries
// and by Training (exercise muscles and the note).
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

export const claudeEnabled = () => !!config.anthropicKey;

let client: Anthropic | null = null;

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

/** An API failure → what went wrong and what to do about it, for the News and Inbox views. */
export function claudeErrorMessage(e: unknown, model: string): string {
  if (e instanceof Anthropic.APIConnectionTimeoutError) return 'Claude took too long to answer. It tries again on the next sync, or press refresh.';
  if (e instanceof Anthropic.APIConnectionError) {
    return 'Couldn’t reach the Claude API. Check the server’s internet connection and that api.anthropic.com isn’t blocked, then press refresh.';
  }
  if (!(e instanceof Anthropic.APIError)) return (e as Error).message;
  const body = e.error as { error?: { type?: string; message?: string } } | undefined;
  const detail = body?.error?.message || e.message;
  if (e.status === 401) {
    return 'Anthropic rejected the API key. Check ANTHROPIC_API_KEY in .env on the server: it may be mistyped, revoked or expired. Make a new key at platform.claude.com if needed, then restart Launchpad.';
  }
  if (e.type === 'billing_error' || /credit balance|spend limit|billing/i.test(detail)) {
    return 'Your Anthropic account is out of credit or over its spend limit. Add credit or raise the limit at platform.claude.com → Billing; summaries pick up again on the next sync.';
  }
  if (e.status === 403) return `This API key isn’t allowed to use Claude (${detail}). Check the key’s workspace at platform.claude.com.`;
  if (e.status === 404) {
    return `The model “${model}” isn’t available. Check NEWS_MODEL, INBOX_MODEL and TRAINING_MODEL in .env (or remove them to use the default), then restart Launchpad.`;
  }
  if (e.status === 429) return 'Hit the Claude API rate limit. It tries again on the next sync; if it keeps happening, check your limits at platform.claude.com.';
  if (e.status && e.status >= 500) return `The Claude API is having trouble (${e.status} ${detail}). It tries again on the next sync.`;
  return `Claude API error: ${detail}`;
}

export async function askJson<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  /** Finishes the error messages, e.g. "summarise these headlines". */
  task: string;
}): Promise<T> {
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  const fallback = FALLBACK_MODELS.includes(opts.model);
  let res;
  try {
    res = await client.beta.messages.create({
      model: opts.model,
      max_tokens: 16000,
      system: opts.system,
      output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
      messages: [{ role: 'user', content: opts.user }],
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
  } catch (e) {
    throw new Error(claudeErrorMessage(e, opts.model));
  }
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined to ${opts.task}.`);
  if (res.stop_reason === 'max_tokens') throw new Error('The summary was cut off. Press refresh to try again.');
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Claude’s answer came back garbled. It tries again on the next sync, or press refresh.');
  }
}
