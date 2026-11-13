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
