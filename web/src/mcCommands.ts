/** The Minecraft console's command cheatsheet (vanilla Java Edition). */
export interface McCommand {
  /** The command as you'd type it. <x> is required, [x] is optional. */
  usage: string;
  /** What it does, in a few words. */
  desc: string;
}

export interface McCommandGroup {
  title: string;
  commands: McCommand[];
}

export const MC_COMMANDS: McCommandGroup[] = [
  {
    title: 'Server',
    commands: [
      { usage: 'list', desc: 'Who is online' },
      { usage: 'say <message>', desc: 'Announce to everyone' },
      { usage: 'save-all', desc: 'Save the world now' },
      { usage: 'save-off', desc: 'Pause autosave (before a backup)' },
      { usage: 'save-on', desc: 'Resume autosave' },
      { usage: 'stop', desc: 'Save and shut down' },
    ],
  },
  {
    title: 'Players',
    commands: [
      { usage: 'op <player>', desc: 'Make an operator' },
      { usage: 'deop <player>', desc: 'Remove operator' },
      { usage: 'kick <player> [reason]', desc: 'Disconnect a player' },
      { usage: 'ban <player> [reason]', desc: 'Ban a player' },
      { usage: 'pardon <player>', desc: 'Unban a player' },
      { usage: 'whitelist add <player>', desc: 'Allow a player in' },
      { usage: 'whitelist remove <player>', desc: 'Take a player off the list' },
      { usage: 'whitelist list', desc: 'Show who is allowed' },
    ],
  },
  {
    title: 'World',
    commands: [
      { usage: 'time set day', desc: 'Make it morning' },
      { usage: 'time set night', desc: 'Make it night' },
      { usage: 'weather clear', desc: 'Stop the rain' },
      { usage: 'weather thunder', desc: 'Start a storm' },
      { usage: 'difficulty <peaceful|easy|normal|hard>', desc: 'Change difficulty' },
      { usage: 'gamerule keepInventory true', desc: 'Keep items on death' },
      { usage: 'setworldspawn', desc: 'Spawn point to where you stand' },
      { usage: 'seed', desc: 'Show the world seed' },
    ],
  },
  {
    title: 'Fun',
    commands: [
      { usage: 'gamemode <survival|creative|spectator> [player]', desc: 'Change game mode' },
      { usage: 'tp <player> <target>', desc: 'Teleport to a player' },
      { usage: 'give <player> <item> [count]', desc: 'Hand out items' },
      { usage: 'effect give <player> <effect> [seconds]', desc: 'Apply a potion effect' },
      { usage: 'xp add <player> <amount> levels', desc: 'Give experience levels' },
    ],
  },
];

/** What clicking a command puts in the input: everything before the first <argument> or [option]. */
export function fillFor(usage: string): string {
  return usage.split(/[<[]/)[0];
}

/** One entry in the full list: every command the server answers to `help` with. */
export interface McListed {
  /** As in McCommand, but a command's subcommands are one <a|b|c> to pick from. */
  usage: string;
  group: string;
  desc?: string;
  /** The mod it comes from, when that's known. */
  mod?: string;
  /** Other names for it, without the slash. */
  also?: string[];
}

/** The full list's groups, in the order they're shown. */
export const MC_GROUPS = ['Server', 'Access', 'Players', 'World', 'Scripting', 'Mods'];

/** The commands that match every word typed, in `group` unless it's null. */
export function filterCommands(all: McListed[], query: string, group: string | null): McListed[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return all.filter((c) => {
    if (group && c.group !== group) return false;
    const hay = [c.usage, c.desc, c.mod, ...(c.also ?? [])].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** The pins that were saved: only commands still in the list, each once. */
export function parsePins(raw: string | null, all: McListed[]): string[] {
  try {
    const v: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(v)) return [];
    const known = new Set(all.map((c) => c.usage));
    return [...new Set(v.filter((x): x is string => typeof x === 'string' && known.has(x)))];
  } catch {
    return [];
  }
}

/** `pins` with `usage` added at the end, or taken out if it was there. */
export function togglePin(pins: string[], usage: string): string[] {
  return pins.includes(usage) ? pins.filter((p) => p !== usage) : [...pins, usage];
}
