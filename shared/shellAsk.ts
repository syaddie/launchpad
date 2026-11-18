// The Terminal's "Ask for a command": a plain-English request goes to Claude with the
// server's OS and the shell's folder, and one command comes back to put at the prompt.
// Nothing here runs it; the page types it without a newline and the owner presses Enter.
// What Claude sends is cleaned here, on the server and again on the page, so only a single
// line of printable text ever reaches the terminal.

/** The longest request sent to Claude. */
export const MAX_SHELL_ASK = 400;
/** The longest command typed at the prompt. */
export const MAX_COMMAND = 1000;

export type ShellRisk = 'deletes' | 'overwrites' | 'sudo';
const RISKS: ShellRisk[] = ['deletes', 'overwrites', 'sudo'];

export interface ShellAnswer {
  command: string;
  /** One line on what it does. */
  explanation: string;
  /** What it could delete, overwrite or need sudo for, in a sentence or two; null when it's harmless. */
  warning: string | null;
  risks: ShellRisk[];
}

export type ShellAskResult = ShellAnswer | { error: string };

/** Whether the box can be used, for the page to show before anything is typed. */
export interface ShellAskStatus {
  /** There's an Anthropic API key on the server. */
  enabled: boolean;
  /** Why asking would be refused now (over the monthly budget), or null. */
  blocked: string | null;
}

/** The server, read once over SSH. */
export interface HostInfo {
  /** e.g. "Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic)", or null when it couldn't be checked. */
  os: string | null;
  /** The SSH user's login shell, e.g. /bin/bash. */
  shell: string | null;
}

/** What Claude knows when it writes the command. */
export interface ShellContext extends HostInfo {
  /** The terminal's folder, when the shell reports it. */
  cwd: string | null;
}

/** What Claude fills in. Every field required, nothing else allowed. */
export const SHELL_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'One shell command on one line, or empty when it can’t be done in one.' },
    explanation: { type: 'string', description: 'One short sentence on what the command does, or why there isn’t one.' },
    deletes: { type: 'boolean', description: 'It removes files, folders, containers, packages or other data.' },
    overwrites: { type: 'boolean', description: 'It can replace or change what’s in existing files.' },
    sudo: { type: 'boolean', description: 'It uses sudo.' },
    warning: { type: 'string', description: 'When deletes, overwrites or sudo is true: one short sentence on what could be lost or changed. Otherwise empty.' },
  },
  required: ['command', 'explanation', 'deletes', 'overwrites', 'sudo', 'warning'],
  additionalProperties: false,
} as const;

export function shellSystem(c: ShellContext): string {
  const os = c.os ? `The server runs ${c.os}.` : 'The server runs Linux; which distribution couldn’t be checked, so stick to commands found on most.';
  const shell = c.shell ? ` The login shell is ${c.shell}.` : '';
  const cwd = c.cwd
    ? `The terminal is in ${c.cwd}. “Here” and “this folder” mean that folder.`
    : 'The terminal’s current folder isn’t known; use . for “here”.';
  return [
    'You turn a plain-English request into one shell command for the user’s own server.',
    'The command is typed at their terminal’s prompt and only runs if they press Enter, so write it to be read first.',
    '',
    `${os}${shell}`,
    cwd,
    '',
    'Rules:',
    '- command: exactly one line. Chain steps with &&, ; or | instead of newlines. No comments, no prompt sign, no backticks or code fences.',
    '- Use tools that come with this system. Prefer the read-only form when the request allows it, and quote paths that could hold spaces.',
    '- Only use sudo when the job can’t be done without it.',
    '- explanation: one short, plain sentence on what the command does.',
    '- deletes: true when it removes files, folders, containers, images, packages or other data (rm, find -delete, rsync --delete, docker prune, apt remove…).',
    '- overwrites: true when it can replace or change existing files (> redirection, sed -i, mv or cp onto files that exist, tee, dd, mkfs, truncate…).',
    '- sudo: true when it uses sudo.',
    '- warning: when any of those is true, one short sentence on what could be lost or changed. Otherwise an empty string.',
    '- If it can’t be done with one command, or it isn’t something a shell does, leave command empty and say why in explanation.',
  ].join('\n');
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
// Zero-width and direction-changing characters: they'd make the command read differently from what runs.
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const HAS_INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const LINE_BREAK = /[\n\r\u000b\u000c\u0085\u2028\u2029]/;

/** One line of text for the page: whitespace runs (newlines too) become a space, control characters go. */
export function oneLine(v: unknown, max = 300): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').replace(CONTROL, '').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/**
 * A command that's safe to type at the prompt: a single line of printable text. Code fences,
 * wrapping backticks and a "$ " prompt are taken off; tabs (which would trigger completion)
 * become spaces and other control characters are dropped. More than one line is refused.
 */
export function cleanCommand(v: unknown): { ok: true; command: string } | { ok: false; error: string } {
  if (typeof v !== 'string') return { ok: false, error: 'Claude’s answer came back garbled. Try again.' };
  let s = v.replace(INVISIBLE, '').trim();
  // ```bash … ``` around it, or `…`.
  if (s.startsWith('```')) s = s.replace(/^```(?:[\w-]*[ \t]*\r?\n)?/, '').replace(/\s*```$/, '').trim();
  if (/^`[^`]+`$/.test(s)) s = s.slice(1, -1).trim();
  if (s.startsWith('$ ')) s = s.slice(2).trim();
  if (LINE_BREAK.test(s)) return { ok: false, error: 'Claude’s answer was more than one line, so Launchpad won’t type it. Try asking for something smaller.' };
  s = s.replace(/\t/g, ' ').replace(CONTROL, '').trim();
  if (!s) return { ok: false, error: 'Claude didn’t come up with a command. Try saying it another way.' };
  if (s.length > MAX_COMMAND) return { ok: false, error: `Claude’s command was over ${MAX_COMMAND} characters, so Launchpad won’t type it. Try asking for something smaller.` };
  return { ok: true, command: s };
}

// A command word: at the start, or after a space, ;, &, |, ( or `, and followed by a space or the end.
const word = (words: string) => String.raw`(?:^|[\s;&|(` + '`' + String.raw`])(?:${words})(?=$|[\s;&|)])`;
const at = (words: string) => new RegExp(word(words));
const SUDO = at('sudo|doas|pkexec|su');
const DELETES = [
  at('rm|rmdir|unlink|shred|wipefs|srm'),
  /(?:^|\s)-delete(?=$|\s)/,
  /(?:^|\s)--(?:delete|remove-files)(?:[-=]\S*)?(?=$|\s)/,
  /\b(?:docker|podman)\s+(?:[a-z]+\s+)?(?:rm|rmi|prune)\b/,
  /\b(?:apt|apt-get|dnf|yum|zypper|snap|flatpak)\s+(?:-\S+\s+)*(?:remove|purge|autoremove|uninstall|erase)\b/,
  /\bpacman\s+-R/,
  /\bgit\s+clean\b/,
  /\bcrontab\s+-r\b/,
];
const OVERWRITES = [
  at(String.raw`dd|mkfs(?:\.\w+)?|truncate|mv|cp|rsync`),
  // tee without -a.
  new RegExp(word('tee') + String.raw`(?![^|;&]*\s-(?:a|-append)(?=$|\s))`),
  /(?:^|[\s;&|(])(?:sed|perl)\s+(?:[^|;&]*\s)?(?:-[a-zA-Z]*i\S*|--in-place\S*)(?=$|\s)/,
  /\bgit\s+(?:reset\s+--hard\b|checkout\s+--(?=$|\s)|restore\b)/,
  /\bunzip\s+(?:[^|;&]*\s)?-o\b/,
];

/** Single- and double-quoted strings emptied, so a > or rm inside quotes isn't read as one. */
const unquoted = (cmd: string) => cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** A > or >| redirect onto a file: not >> (appends), not >&2 or 2>&1, not /dev/null, not >( ). */
function redirects(cmd: string): boolean {
  for (const m of cmd.matchAll(/(>>?)\|?(&?)\s*([^\s;&|<>()]*)/g)) {
    if (m[1] === '>>' || m[2] || !m[3]) continue;
    if (/^\/dev\/(?:null|stdout|stderr|tty)$/.test(m[3])) continue;
    return true;
  }
  return false;
}

/** What Launchpad can tell from the command itself, on top of what Claude says. */
export function commandRisks(cmd: string): ShellRisk[] {
  const s = unquoted(cmd);
  const out: ShellRisk[] = [];
  if (DELETES.some((r) => r.test(s))) out.push('deletes');
  if (OVERWRITES.some((r) => r.test(s)) || redirects(s)) out.push('overwrites');
  if (SUDO.test(s)) out.push('sudo');
  return out;
}

/** "Deletes files and needs sudo." */
export function riskLine(risks: ShellRisk[]): string {
  const parts = RISKS.filter((r) => risks.includes(r)).map((r) => (r === 'deletes' ? 'deletes files' : r === 'overwrites' ? 'can overwrite files' : 'needs sudo'));
  if (!parts.length) return '';
  const s = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
  return s[0].toUpperCase() + s.slice(1) + '.';
}

/** Claude's answer → what the page shows, or why there's nothing to type. */
export function shellAnswer(raw: unknown): ShellAskResult {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const explanation = oneLine(r.explanation);
  if (typeof r.command === 'string' && !r.command.trim()) return { error: explanation || 'Claude couldn’t turn that into one command. Try saying it another way.' };
  const c = cleanCommand(r.command);
  if (!c.ok) return { error: c.error };
  const flagged = new Set<ShellRisk>(commandRisks(c.command));
  for (const k of RISKS) if (r[k] === true) flagged.add(k);
  const risks = RISKS.filter((k) => flagged.has(k));
  const note = oneLine(r.warning);
  const warning = risks.length ? [riskLine(risks), note].filter(Boolean).join(' ') : note || null;
  return { command: c.command, explanation, warning: warning || null, risks };
}

/** The folder in a window title like Debian's "user@host: ~/logs" or Fedora's "user@host:~/logs". */
export function folderFromTitle(title: string): string | null {
  const m = /^(?:\([^)]*\))?[^\s@:]+@[^\s:]+:\s?([~/].*)$/.exec(title.trim());
  return m ? cleanFolder(m[1]) : null;
}

/** The folder in an OSC 7 report, file://host/path. */
export function folderFromOsc7(data: string): string | null {
  try {
    const u = new URL(data);
    if (u.protocol !== 'file:') return null;
    return cleanFolder(decodeURIComponent(u.pathname));
  } catch {
    return null;
  }
}

/** A folder to tell Claude about: absolute or under ~, one line, not absurdly long. */
export function cleanFolder(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 1024 || !/^(?:\/|~(?:\/|$))/.test(s) || /[\u0000-\u001f\u007f-\u009f]/.test(s) || HAS_INVISIBLE.test(s)) return null;
  return s;
}

/** "PRETTY_NAME" from /etc/os-release, with the kernel from uname -sr. */
export function describeOs(uname: string, osRelease: string): string | null {
  const kernel = oneLine(uname, 120);
  const pretty = /^PRETTY_NAME=(.*)$/m.exec(osRelease)?.[1] ?? /^NAME=(.*)$/m.exec(osRelease)?.[1];
  const name = pretty ? oneLine(pretty.trim().replace(/^(['"])(.*)\1$/, '$2'), 120) : '';
  if (name && kernel) return `${name} (${kernel})`;
  return name || kernel || null;
}

/** Run once over SSH: the kernel and the login shell on lines of their own, then /etc/os-release. */
export const HOST_COMMAND = `printf 'KERNEL=%s\\nSHELL=%s\\n' "$(uname -sr 2>/dev/null)" "$SHELL"; cat /etc/os-release 2>/dev/null`;

/** What HOST_COMMAND printed. Each line is read by its label, so a missing uname or os-release just leaves a gap. */
export function parseHostInfo(out: string): HostInfo {
  const lines = out.split(/\r?\n/);
  const pick = (key: string) => lines.find((l) => l.startsWith(key + '='))?.slice(key.length + 1) ?? '';
  const release = lines.filter((l) => !/^(?:KERNEL|SHELL)=/.test(l)).join('\n');
  return { os: describeOs(pick('KERNEL'), release), shell: oneLine(pick('SHELL'), 80) || null };
}
