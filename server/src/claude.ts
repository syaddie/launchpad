// The one Claude call Launchpad makes: a system prompt, a user message and a
// JSON schema in, the parsed JSON out. Used by the News and Inbox summaries.
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config';

export const claudeEnabled = () => !!config.anthropicKey;

let client: Anthropic | null = null;

// Models that accept server-side refusal fallbacks.
const FALLBACK_MODELS = ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5'];

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
  const res = await client.beta.messages.create({
    model: opts.model,
    max_tokens: 16000,
    system: opts.system,
    output_config: { effort: opts.effort, format: { type: 'json_schema', schema: opts.schema } },
    messages: [{ role: 'user', content: opts.user }],
    ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
  });
  if (res.stop_reason === 'refusal') throw new Error(`Claude declined to ${opts.task}.`);
  if (res.stop_reason === 'max_tokens') throw new Error('The summary was cut off.');
  const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return JSON.parse(text) as T;
}
