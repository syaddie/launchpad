// The Claude calls Launchpad makes, all through here so each one's tokens are counted
// (the usage meter in the Server view). askJson: a system prompt, a user message and a
// JSON schema in, the parsed JSON out; used by the News and Inbox summaries, Training,
// Learn and the weekly recap. askTool: the same, but Claude picks one of a few tools
// (⌘K's "Ask Launchpad"). Pass `feature` so the meter can say what the tokens were for.
import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessage, BetaTool, MessageCreateParamsNonStreaming as BetaMessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { config } from './config';
import { store } from './store';
import { addUsage, priceKey, pruneUsage } from '../../shared/claudeUsage';
import { ymd } from '../../shared/dates';

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
    return `The model “${model}” isn’t available. Check NEWS_MODEL, INBOX_MODEL and TRAINING_MODEL in .env, and LEARN_MODEL and ASK_MODEL too (or remove them to use the default), then restart Launchpad.`;
  }
  if (e.status === 429) return 'Hit the Claude API rate limit. It tries again on the next sync; if it keeps happening, check your limits at platform.claude.com.';
  if (e.status && e.status >= 500) return `The Claude API is having trouble (${e.status} ${detail}). It tries again on the next sync.`;
  return `Claude API error: ${detail}`;
}

type Usage = BetaMessage['usage'];

/**
 * Count one response's tokens towards `feature`, under the model that served it (with a
 * refusal fallback, each model's share separately). Never throws: the meter mustn't break a call.
 */
export function recordUsage(feature: string, model: string, usage: Usage, at = new Date()): void {
  try {
    const parts = usage.iterations?.filter((i) => i.type === 'message' || i.type === 'fallback_message') ?? [];
    const split = parts.some((i) => i.type === 'fallback_message');
    const rows = split
      ? parts.map((i) => ({ model: ('model' in i && i.model) || model, input: i.input_tokens, output: i.output_tokens, write: i.cache_creation_input_tokens, read: i.cache_read_input_tokens }))
      : [{ model, input: usage.input_tokens, output: usage.output_tokens, write: usage.cache_creation_input_tokens ?? 0, read: usage.cache_read_input_tokens ?? 0 }];
    let log = pruneUsage(store.claudeUsage(), at);
    rows.forEach((r, i) => {
      const key = priceKey(r.model, r.input + r.write + r.read);
      log = addUsage(log, ymd(at), feature, key, { calls: i === 0 ? 1 : 0, input: r.input, output: r.output, cacheWrite: r.write, cacheRead: r.read });
    });
    store.setClaudeUsage(log);
  } catch (e) {
    console.error('[claude] couldn’t record usage:', (e as Error).message);
  }
}

/** Send a request, count its tokens, and turn API failures into plain messages. */
async function create(feature: string, params: BetaMessageCreateParamsNonStreaming): Promise<BetaMessage> {
  client ??= new Anthropic({ apiKey: config.anthropicKey });
  const fallback = FALLBACK_MODELS.includes(params.model);
  let res: BetaMessage;
  try {
    res = await client.beta.messages.create({
      ...params,
      ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
  } catch (e) {
    throw new Error(claudeErrorMessage(e, params.model));
  }
  recordUsage(feature, res.model || params.model, res.usage);
  return res;
}

export async function askJson<T>(opts: {
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  effort: 'low' | 'medium' | 'high';
  /** Finishes the error messages, e.g. "summarise these headlines". */
  task: string;
  /** What the tokens are for in the usage meter: news, inbox, training, learn, briefing, review… */
  feature?: string;
}): Promise<T> {
  const res = await create(opts.feature ?? 'other', {
    model: opts.model,
    max_tokens: 16000,
    system: opts.system,
    output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
    messages: [{ role: 'user', content: opts.user }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined to ${opts.task}.`);
  if (res.stop_reason === 'max_tokens') throw new Error('The summary was cut off. Press refresh to try again.');
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error('Claude’s answer came back garbled. It tries again on the next sync, or press refresh.');
  }
}

/**
 * Claude picks at most one of `tools` for the user's message. Returns the tool and its
 * input (parsed, not yet checked: check it against your own rules), or Claude's words
 * when no tool fits.
 */
export async function askTool(opts: {
  model: string;
  system: string;
  user: string;
  tools: BetaTool[];
  effort: 'low' | 'medium' | 'high';
  task: string;
  feature: string;
}): Promise<{ name: string; input: unknown } | { text: string }> {
  const res = await create(opts.feature, {
    model: opts.model,
    max_tokens: 4000,
    system: opts.system,
    tools: opts.tools,
    // "auto": forcing a tool isn't accepted by every model. The prompt asks for one.
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    output_config: { effort: opts.effort },
    messages: [{ role: 'user', content: opts.user }],
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined to ${opts.task}.`);
  if (res.stop_reason === 'max_tokens') throw new Error('Claude’s answer was cut off. Try again, or say it more simply.');
  const use = res.content.find((b) => b.type === 'tool_use');
  if (use && use.type === 'tool_use') return { name: use.name, input: use.input };
  return { text: res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('').trim() };
}
