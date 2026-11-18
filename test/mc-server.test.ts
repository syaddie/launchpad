import { spawnSync } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The watcher reaches the host only through runCommand; here a pretend host answers it.
const host = vi.hoisted(() => ({ pid: 1000, running: true, log: '', crash: null as null | { name: string; text: string }, starts: 0, commands: [] as string[] }));
vi.mock('../server/src/shell', async (orig) => ({
  ...(await orig<typeof import('../server/src/shell')>()),
  shellConfigured: () => true,
  runCommand: vi.fn(async (cmd: string) => {
    host.commands.push(cmd);
    if (cmd.includes('@@tmux')) {
      const ps = [' 900 1 tmux new-session -d -s survival', ' 901 900 -bash', ...(host.running ? [` ${host.pid} 901 java -Xmx4G -jar paper.jar nogui`] : [])];
      return { code: 0, stdout: [...ps, '@@tmux', '901\tsurvival', '@@screen', '@@java', ...(host.running ? [`${host.pid}\t/srv/mc/survival\tserver.properties`] : []), ''].join('\n'), stderr: '' };
    }
    if (cmd.includes('@@crashfile')) return { code: 0, stdout: `@@log\n${host.log}\n@@crashfile\n${host.crash?.name ?? ''}\n@@crashtext\n${host.crash?.text ?? ''}\n`, stderr: '' };
    if (cmd.includes('tmux has-session')) host.starts++;
    return { code: 0, stdout: '', stderr: '' };
  }),
}));

import {
  classifyStop, cleanLevel, cleanMcServer, oneAtATime, cleanMcServers, COME_UP, diagScript, expectStop, GRACE, MAX_RESTARTS, NEW_MEM, onMcEvent, parseCrash, parseDiag, parseFacts, parseProps, stopScript, WATCH_EVERY, watchCrashesToo, watchStep, watchTick, worldFolders, type McEvent,
} from '../server/src/minecraft';
import { store } from '../server/src/store';
import type { McServer } from '../shared/types';

const sh = (script: string) => {
  const r = spawnSync('sh', ['-n'], { input: script });
  return r.error ? null : r.stderr.toString();
};

const base = { name: 'Survival', dir: '/srv/mc/survival', mux: 'tmux', session: 'survival', start: './start.sh' };

describe('saved servers: the new settings', () => {
  it('leaves the defaults out, so older saves and backups compare the same', () => {
    expect(cleanMcServer(base, 'a')).toEqual({ id: 'a', ...base });
    expect(cleanMcServer({ ...base, autoRestart: false, keepBackups: 7, backupDir: '  ' }, 'a')).toEqual({ id: 'a', ...base });
  });
  it('keeps Restart if it crashes only with a start command', () => {
    expect(cleanMcServer({ ...base, autoRestart: true }, 'a').autoRestart).toBe(true);
    expect(cleanMcServer({ ...base, autoRestart: true, start: '' }, 'a').autoRestart).toBeUndefined();
    expect(cleanMcServer({ ...base, autoRestart: 'yes' }, 'a').autoRestart).toBeUndefined();
  });
  it('puts an odd number of backups right rather than dropping the server', () => {
    expect(cleanMcServer({ ...base, keepBackups: 3 }, 'a').keepBackups).toBe(3);
    expect(cleanMcServer({ ...base, keepBackups: '12' }, 'a').keepBackups).toBe(12);
    expect(cleanMcServer({ ...base, keepBackups: 0 }, 'a').keepBackups).toBe(1);
    expect(cleanMcServer({ ...base, keepBackups: 5000 }, 'a').keepBackups).toBe(100);
    expect(cleanMcServer({ ...base, keepBackups: 'lots' }, 'a').keepBackups).toBeUndefined();
  });
  it('wants a full path for the backups folder', () => {
    expect(cleanMcServer({ ...base, backupDir: '/mnt/big/backups/' }, 'a').backupDir).toBe('/mnt/big/backups');
    expect(() => cleanMcServer({ ...base, backupDir: 'backups' }, 'a')).toThrow('full path');
    expect(() => cleanMcServer({ ...base, backupDir: '/' }, 'a')).toThrow('root');
  });
  it('carries them through a backup and back', () => {
    const s = cleanMcServer({ ...base, autoRestart: true, keepBackups: 3, backupDir: '/mnt/b' }, 'a');
    expect(cleanMcServers(JSON.parse(JSON.stringify([s])))).toEqual([s]);
  });
});

describe('the server’s own settings', () => {
  it('reads server.properties, escapes and all', () => {
    const p = parseProps('#Minecraft server properties\nlevel-name=My\\ World\nserver-port = 25570\nmotd=A \\u00A7aGreen\\:server\n\nwhite-list=true\n');
    expect(p['level-name']).toBe('My World');
    expect(p['server-port']).toBe('25570');
    expect(p.motd).toBe('A §aGreen:server');
    expect(p['white-list']).toBe('true');
  });
  it('only takes a level-name inside the server’s folder', () => {
    expect(cleanLevel(undefined)).toBe('world');
    expect(cleanLevel('worlds/survival')).toBe('worlds/survival');
    expect(cleanLevel('../elsewhere')).toBeNull();
    expect(cleanLevel('/etc')).toBeNull();
    expect(cleanLevel('a//b')).toBeNull();
  });
  it('tells Bukkit-style servers, Paper and Spark apart, and where their worlds are', () => {
    const paper = parseFacts('@@props\nlevel-name=survival\nserver-port=25566\nserver-ip=\n@@marks\nbukkit.yml\nspigot.yml\nconfig/paper-global.yml\nplugins/spark-1.10.73-bukkit.jar\n');
    expect(paper).toMatchObject({ port: 25566, ip: null, level: 'survival', bukkit: true, paper: true, spark: true, whitelistOn: false });
    expect(worldFolders(paper)).toEqual(['survival', 'survival_nether', 'survival_the_end']);
    const vanilla = parseFacts('@@props\nserver-ip=192.168.1.5\n@@marks\n');
    expect(vanilla).toMatchObject({ port: 25565, ip: '192.168.1.5', level: 'world', bukkit: false, paper: false, spark: false });
    expect(worldFolders(vanilla)).toEqual(['world']);
    expect(worldFolders(parseFacts('@@props\nlevel-name=../x\n@@marks\n'))).toEqual([]);
  });
});

const REPORT = `---- Minecraft Crash Report ----
// Who set us up the TNT?

Time: 2026-11-18 14:30:00
Description: Exception in server tick loop

java.lang.NullPointerException: Cannot invoke "net.minecraft.world.entity.Entity.getId()" because "entity" is null
\tat net.minecraft.server.level.ServerLevel.tick(ServerLevel.java:412)
\tat net.minecraft.server.MinecraftServer.tickChildren(MinecraftServer.java:1600)
\tat net.minecraft.server.MinecraftServer.tickServer(MinecraftServer.java:1450)
\tat net.minecraft.server.MinecraftServer.runServer(MinecraftServer.java:1200)
\tat net.minecraft.server.MinecraftServer.lambda$spin$2(MinecraftServer.java:300)
\tat net.minecraft.server.MinecraftServer.a(MinecraftServer.java:12)
\tat net.minecraft.server.MinecraftServer.b(MinecraftServer.java:13)
\tat java.base/java.lang.Thread.run(Thread.java:1583)
Caused by: java.lang.IllegalStateException: boom
\tat x.y(Z.java:1)

A detailed walkthrough of the error, its code path and all known details is as follows:
`;

describe('crash reports', () => {
  it('takes the Description and the exception with its first lines', () => {
    const c = parseCrash(REPORT);
    expect(c.description).toBe('Exception in server tick loop');
    expect(c.lines[0]).toMatch(/^java.lang.NullPointerException/);
    // Six stack lines at most, but a Caused by still shows.
    expect(c.lines.filter((l) => /^\s+at /.test(l))).toHaveLength(6);
    expect(c.lines).toContain('Caused by: java.lang.IllegalStateException: boom');
  });
  it('copes with a report that has no Description', () => {
    expect(parseCrash('nothing much here')).toEqual({ description: null, lines: [] });
  });
  it('comes with Diagnose: the newest report, however old', () => {
    const out = `@@dir\nyes\n@@crashfile\ncrash-2026-11-18_14.30.00-server.txt\n1795000000 5120\n@@crashtext\n${REPORT}\n@@pane\n\n@@log\n`;
    const d = parseDiag(out);
    expect(d.crash).toMatchObject({ name: 'crash-2026-11-18_14.30.00-server.txt', size: 5120, description: 'Exception in server tick loop', at: new Date(1795000000 * 1000).toISOString() });
    expect(parseDiag('@@dir\nyes\n@@crashfile\n@@crashtext\n').crash).toBeNull();
  });
  it('is valid shell', () => {
    const s: McServer = { id: 'a', ...base, mux: 'tmux', dir: "/srv/it's here" };
    for (const script of [diagScript(s), stopScript(s, 3)]) {
      const err = sh(script);
      if (err !== null) expect(err).toBe('');
    }
  });
});

describe('telling a crash from a clean stop', () => {
  it('trusts a new crash report first', () => {
    expect(classifyStop('[12:00:00] [Server thread/INFO]: Stopping the server', { name: 'c.txt', description: 'Ticking entity' })).toEqual({ crashed: true, reason: 'It crashed: Ticking entity.' });
  });
  it('reads a crash in the log, even with Stopping server after it', () => {
    const log = '[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception\njava.lang.RuntimeException: x\n[12:00:01] [Server thread/INFO]: Stopping server';
    expect(classifyStop(log, null)).toMatchObject({ crashed: true, reason: 'It crashed: Encountered an unexpected exception' });
    expect(classifyStop('[12:00:00 ERROR]: java.lang.OutOfMemoryError: Java heap space', null).crashed).toBe(true);
    expect(classifyStop('[12:00:00] [Server Watchdog/FATAL]: A single server tick took 60.00 seconds (should be max 0.05)', null).crashed).toBe(true);
  });
  it('lets a clean stop be', () => {
    expect(classifyStop('[12:00:00] [Server thread/INFO]: Stopping the server\n[12:00:01] [Server thread/INFO]: ThreadedAnvilChunkStorage: All dimensions are saved', null).crashed).toBe(false);
    expect(classifyStop('[12:00:00 INFO]: Stopping server', null).crashed).toBe(false);
  });
  it('counts a process that just vanished as a crash', () => {
    expect(classifyStop('[12:00:00] [Server thread/INFO]: Steve joined the game', null)).toMatchObject({ crashed: true, reason: expect.stringMatching(/without shutting down/) });
    expect(classifyStop('', null)).toMatchObject({ crashed: true, reason: expect.stringMatching(/says nothing/) });
  });
});

describe('typing into a session', () => {
  it('types one line at a time, even when one fails', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number, fail = false) => () =>
      new Promise<string>((res, rej) =>
        setTimeout(() => {
          order.push(name);
          if (fail) rej(new Error(name));
          else res(name);
        }, ms),
      );
    const a = oneAtATime('tmux:s', slow('whitelist add Steve', 30));
    const b = oneAtATime('tmux:s', slow('list', 1, true));
    const c = oneAtATime('tmux:s', slow('tps', 1));
    const other = oneAtATime('tmux:other', slow('other session', 1));
    await expect(b).rejects.toThrow('list');
    expect(await Promise.all([a, c, other])).toEqual(['whitelist add Steve', 'tps', 'other session']);
    expect(order).toEqual(['other session', 'whitelist add Steve', 'list', 'tps']);
  });
});

describe('watchStep', () => {
  const t0 = 1_000_000;
  it('does nothing on the first look', () => {
    expect(watchStep(NEW_MEM, null, t0).act).toBe('none');
    expect(watchStep(NEW_MEM, 1000, t0).mem).toMatchObject({ was: true, lastUp: t0 });
  });
  it('waits out the grace period after a stop, then looks into it', () => {
    let m = watchStep(NEW_MEM, 1000, t0).mem;
    const stopped = watchStep(m, null, t0 + 1000);
    expect(stopped.act).toBe('none');
    m = stopped.mem;
    expect(watchStep(m, null, t0 + 1000 + GRACE - 1).act).toBe('none');
    expect(watchStep(m, null, t0 + 1000 + GRACE).act).toBe('check');
    // A start script that loops brought it back in time: nothing to do.
    expect(watchStep(m, 1000, t0 + 2000).act).toBe('none');
  });
  it('lets a stop Launchpad typed be', () => {
    const m = watchStep(watchStep(NEW_MEM, 1000, t0).mem, false, t0 + 1000, t0 + 500).mem;
    expect(m.downAt).toBeNull();
    expect(watchStep(m, null, t0 + 60_000).act).toBe('none');
  });
  it('doesn’t let a stop typed into an earlier run excuse a crash of the next one', () => {
    // Stopped from Launchpad as process 1000, started again as 2000, which then crashes.
    const m = watchStep(watchStep(NEW_MEM, 2000, t0).mem, null, t0 + 1000, { at: t0 - 60_000, pid: 1000 }).mem;
    expect(m.downAt).toBe(t0 + 1000);
    expect(watchStep(m, null, t0 + 1000 + GRACE).act).toBe('check');
  });
  it('gives a restart time to come up, then calls it failed', () => {
    const m = { ...NEW_MEM, was: false, restartedAt: t0 };
    expect(watchStep(m, null, t0 + COME_UP - 1).act).toBe('none');
    expect(watchStep(m, null, t0 + COME_UP).act).toBe('failed');
    expect(watchStep(m, 1000, t0 + 5000).mem.restartedAt).toBeNull();
  });
});

describe('Restart if it crashes', () => {
  let events: McEvent[] = [];
  let t = Date.now();
  const look = async (running: boolean, dt = WATCH_EVERY) => {
    host.running = running;
    t += dt;
    await watchTick(t);
  };
  const types = () => events.map((e) => e.type);
  const serve = (id: string, over: Partial<McServer> = {}) => store.setMinecraft([{ id, ...base, mux: 'tmux', autoRestart: true, ...over }]);

  beforeEach(() => {
    events = [];
    host.running = true;
    host.pid = 1000;
    host.log = '';
    host.crash = null;
    host.starts = 0;
    host.commands = [];
    store.setMcWatch({});
    t += 24 * 60 * 60_000;
  });
  onMcEvent((e) => events.push(e));
  // A listener that fails doesn't stop the others hearing.
  onMcEvent(() => {
    throw new Error('alerts are down');
  });

  it('starts a crashed server again, and gives up after three in 15 minutes', async () => {
    serve('w1');
    await look(true);
    host.log = '[12:00:00] [Server thread/ERROR]: Encountered an unexpected exception';
    for (let i = 1; i <= MAX_RESTARTS; i++) {
      await look(false);
      expect(host.starts).toBe(i - 1);
      await look(false);
      expect(host.starts).toBe(i);
      await look(true);
    }
    expect(types()).toEqual(['crash', 'restart', 'crash', 'restart', 'crash', 'restart']);
    expect(events[0]).toMatchObject({ serverId: 'w1', server: 'Survival', reason: 'It crashed: Encountered an unexpected exception', crashReport: null });
    await look(false);
    await look(false);
    expect(types().slice(-2)).toEqual(['crash', 'gave-up']);
    expect(host.starts).toBe(MAX_RESTARTS);
    expect(store.mcWatch().w1.gaveUp).toBe(true);
    // Given up: it stays down and says nothing more.
    await look(false);
    await look(false);
    expect(events).toHaveLength(8);
    // Started by hand: it watches again.
    await look(true);
    expect(store.mcWatch().w1.gaveUp).toBe(false);
    expect(store.mcWatch().w1.log.map((e) => e.kind)).toEqual(['crash', 'restart', 'crash', 'restart', 'crash', 'restart', 'crash', 'gave-up']);
  });

  it('names the crash report it finds', async () => {
    serve('w2');
    await look(true);
    host.crash = { name: 'crash-2026-11-18_14.30.00-server.txt', text: REPORT };
    await look(false);
    await look(false);
    expect(events[0]).toMatchObject({ type: 'crash', reason: 'It crashed: Exception in server tick loop.', crashReport: 'crash-2026-11-18_14.30.00-server.txt' });
    expect(types()).toEqual(['crash', 'restart']);
  });

  it('spreads out crashes don’t add up', async () => {
    serve('w3');
    await look(true);
    host.log = 'java.lang.OutOfMemoryError';
    for (let i = 0; i < MAX_RESTARTS + 2; i++) {
      await look(false);
      await look(false);
      await look(true, 10 * 60_000);
    }
    expect(types().filter((x) => x === 'restart')).toHaveLength(MAX_RESTARTS + 2);
    expect(types()).not.toContain('gave-up');
  });

  it('leaves a clean stop alone', async () => {
    serve('w4');
    await look(true);
    host.log = '[12:00:00] [Server thread/INFO]: Stopping the server';
    await look(false);
    await look(false);
    await look(false);
    expect(events).toEqual([]);
    expect(host.starts).toBe(0);
  });

  it('looks into the next stop after a restart, even one soon after a stop from Launchpad', async () => {
    serve('w8');
    await look(true);
    expectStop('w8', 1000, t);
    await look(false);
    await look(false);
    expect(events).toEqual([]);
    // Started again, as a new process, and then it crashes.
    host.pid = 2000;
    await look(true);
    host.log = 'java.lang.OutOfMemoryError';
    await look(false);
    await look(false);
    expect(types()).toEqual(['crash', 'restart']);
  });

  it('leaves a stop from Launchpad alone, without even looking', async () => {
    serve('w5');
    await look(true);
    expectStop('w5', 1000, t);
    await look(false);
    await look(false);
    expect(events).toEqual([]);
    expect(host.commands.some((c) => c.includes('@@crashfile'))).toBe(false);
  });

  it('counts a restart that never comes up, and tries again', async () => {
    serve('w6');
    await look(true);
    host.log = 'java.lang.OutOfMemoryError';
    await look(false);
    await look(false);
    expect(types()).toEqual(['crash', 'restart']);
    // The start never comes up and writes nothing new.
    host.log = '';
    await look(false, COME_UP);
    expect(types()).toEqual(['crash', 'restart', 'crash', 'restart']);
    expect(events[2].reason).toMatch(/didn’t come back up/);
  });

  it('only watches servers that have it on', async () => {
    serve('w7', { autoRestart: false });
    await look(true);
    host.log = 'java.lang.OutOfMemoryError';
    await look(false);
    await look(false);
    expect(events).toEqual([]);
    expect(host.commands).toEqual([]);
  });

  it('watches the rest for crashes alone while asked to, and never starts them', async () => {
    let wanted = true;
    watchCrashesToo(() => wanted);
    try {
      serve('w8', { autoRestart: false });
      await look(true);
      host.log = 'java.lang.OutOfMemoryError';
      await look(false);
      await look(false);
      expect(types()).toEqual(['crash']);
      expect(events[0]).toMatchObject({ serverId: 'w8', reason: expect.stringMatching(/^It crashed/) });
      expect(host.starts).toBe(0);
      // A clean stop says nothing.
      await look(true);
      host.log = '[12:00:00] [Server thread/INFO]: Stopping the server';
      await look(false);
      await look(false);
      expect(types()).toEqual(['crash']);
      // Not asked any more (alerts turned off): no looking at all.
      wanted = false;
      host.commands = [];
      await look(true);
      expect(host.commands).toEqual([]);
    } finally {
      watchCrashesToo(() => false);
    }
  });

  it('treats a check that throws as no', async () => {
    watchCrashesToo(() => {
      throw new Error('database is locked');
    });
    try {
      serve('w9', { autoRestart: false });
      await look(true);
      expect(host.commands).toEqual([]);
    } finally {
      watchCrashesToo(() => false);
    }
  });

  it('can stop listening', () => {
    const heard: McEvent[] = [];
    const off = onMcEvent((e) => heard.push(e));
    off();
    expect(heard).toEqual([]);
  });
});
