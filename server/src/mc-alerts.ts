// Minecraft crashes on the phone. What the watcher in minecraft.ts notices goes out through
// notify(). With Restart if it crashes on, a crash is followed straight away by a restart or by
// Launchpad giving up, so the phone hears once, about both. The rest of the saved servers are
// watched for crashes too while Minecraft alerts are on. Messages are in Launchpad's own words:
// the log line behind a crash can hold chat, names or addresses, so it stays in the Minecraft tab.
import { kindOn, notify, topicUrl } from './notify';
import { onMcEvent, watchCrashesToo, type McEvent } from './minecraft';
import { store } from './store';

/** How long a crash waits for its restart (or Launchpad giving up) before it's sent on its own. */
export const PAIR_WAIT = 3 * 60_000;

export interface McAlert {
  key: string;
  title: string;
  body: string;
}

/** What to tell the phone about `e`; `crash` is the crash it follows, if any. */
export function mcAlert(e: McEvent, crash: McEvent | null): McAlert {
  const key = `minecraft:${e.serverId}`;
  const report = (crash ?? e).crashReport ? ' It wrote a crash report.' : '';
  if (e.type === 'restart') return { key, title: `Minecraft: ${e.server} crashed`, body: `Launchpad started it again.${report} The Minecraft tab has what happened.` };
  if (e.type === 'gave-up') return { key, title: `Minecraft: ${e.server} is down`, body: `It keeps crashing, or won’t start, so Launchpad stopped restarting it. It stays down until you start it.${report} The Minecraft tab says why.` };
  return { key, title: `Minecraft: ${e.server} crashed`, body: `It’s stopped.${report} The Minecraft tab says why.` };
}

const waiting = new Map<string, { crash: McEvent; timer: ReturnType<typeof setTimeout> }>();

function send(a: McAlert): void {
  void notify({ kind: 'minecraft', ...a });
}

/** One event from the watcher. Exported for tests. */
export function onEvent(e: McEvent, restarts: boolean): void {
  const held = waiting.get(e.serverId);
  if (held) {
    clearTimeout(held.timer);
    waiting.delete(e.serverId);
  }
  if (e.type === 'crash') {
    // An earlier crash that never heard back goes now, on its own.
    if (held) send(mcAlert(held.crash, null));
    if (!restarts) return send(mcAlert(e, null));
    const timer = setTimeout(() => {
      waiting.delete(e.serverId);
      send(mcAlert(e, null));
    }, PAIR_WAIT);
    timer.unref?.();
    waiting.set(e.serverId, { crash: e, timer });
    return;
  }
  send(mcAlert(e, held?.crash ?? null));
}

let started = false;

/** Called once at boot. */
export function startMcAlerts(): void {
  if (started) return;
  started = true;
  watchCrashesToo(() => kindOn('minecraft') && !!topicUrl());
  onMcEvent((e) => onEvent(e, store.minecraft().some((s) => s.id === e.serverId && !!s.autoRestart && !!s.start)));
}

/** For tests. */
export function resetMcAlertsForTests(): void {
  for (const w of waiting.values()) clearTimeout(w.timer);
  waiting.clear();
}
