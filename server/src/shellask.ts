// The Terminal's "Ask for a command" on the server: what's typed goes to Claude with the
// host's OS and login shell (read once over SSH and kept) and the shell's folder when the
// page knows it, and one cleaned command comes back. Launchpad never runs it: the page
// types it at the prompt without a newline, and nothing happens until the owner presses Enter.
import { askJson, claudeEnabled } from './claude';
import { config } from './config';
import { runCommand, shellConfigured } from './shell';
import { store } from './store';
import { fmtUsd, monthCost } from '../../shared/claudeUsage';
import { cleanFolder, HOST_COMMAND, MAX_SHELL_ASK, parseHostInfo, shellAnswer, SHELL_SCHEMA, shellSystem, type HostInfo, type ShellAskResult, type ShellAskStatus } from '../../shared/shellAsk';

const UNKNOWN: HostInfo = { os: null, shell: null };
let host: Promise<HostInfo> | null = null;

/** The host's OS and login shell, read once. A read that fails is tried again on the next ask. */
export function hostInfo(): Promise<HostInfo> {
  if (!host) {
    const p = runCommand(HOST_COMMAND, 10_000).then((r) => parseHostInfo(r.stdout));
    host = p;
    p.then(
      (h) => !h.os && host === p && (host = null),
      () => host === p && (host = null),
    );
  }
  return host.catch(() => UNKNOWN);
}

/** Why asking is refused now: over the monthly Claude budget (Settings › General). */
export function overBudget(now = new Date()): string | null {
  const budget = store.prefs().claudeBudget ?? 0;
  if (!budget) return null;
  const spend = monthCost(store.claudeUsage(), now);
  if (spend <= budget) return null;
  return `Claude has cost about ${fmtUsd(spend)} this month, over your ${fmtUsd(budget)} budget. Raise the budget in Settings › General to ask for more commands.`;
}

export const shellAskStatus = (): ShellAskStatus => (claudeEnabled() ? { enabled: true, blocked: overBudget() } : { enabled: false, blocked: null });

/** Claude's error messages are written for the summaries that sync on their own; here the owner asks again. */
export function plainError(m: string): string {
  return m
    .replace('The summary was cut off.', 'Claude’s answer was cut off.')
    .replace('; summaries pick up again on the next sync.', '.')
    .replace(', then press refresh.', ', then try again.')
    .replace(/It tries again on the next sync(?:, or press refresh)?([.;])/, 'Try again$1')
    .replace('Press refresh to try again.', 'Try again.');
}

/** POST /api/shell/ask: the checks, then the ask. What to send, with its status code. */
export async function shellAskRequest(body: unknown): Promise<[ShellAskResult, 200 | 400]> {
  if (!claudeEnabled()) return [{ error: 'Add an Anthropic API key on the server (ANTHROPIC_API_KEY) to ask Claude for commands.' }, 400];
  if (!shellConfigured()) return [{ error: 'SSH isn’t set up: set SSH_HOST and SSH_USER.' }, 400];
  const over = overBudget();
  if (over) return [{ error: over }, 400];
  const b = (body && typeof body === 'object' ? body : {}) as { text?: unknown; cwd?: unknown };
  const typed = typeof b.text === 'string' ? b.text.trim() : '';
  if (!typed) return [{ error: 'Type what you want to do.' }, 400];
  if (typed.length > MAX_SHELL_ASK) return [{ error: `That’s over ${MAX_SHELL_ASK} characters.` }, 400];
  const h = await hostInfo();
  try {
    const raw = await askJson<unknown>({
      model: config.askModel,
      feature: 'terminal',
      system: shellSystem({ ...h, cwd: cleanFolder(b.cwd) }),
      user: typed,
      schema: SHELL_SCHEMA,
      effort: 'low',
      task: 'write that command',
    });
    return [shellAnswer(raw), 200];
  } catch (e) {
    return [{ error: plainError((e as Error).message) }, 200];
  }
}
