import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { diagScript, explain, parseDiag, startScript, type DiagFacts } from '../server/src/minecraft';
import { report } from '../web/src/components/Minecraft';
import type { McServer } from '../shared/types';

const server: McServer = { id: 'a', name: 'Survival', dir: '/home/me/survival', mux: 'tmux', session: 'survival', start: './start.sh' };

/** Facts for a healthy server; each test breaks one thing. */
const ok: DiagFacts = {
  dirExists: true,
  hasMux: true,
  java: 'openjdk version "21.0.2"',
  startFile: 'ok',
  eula: 'true',
  port: 25565,
  portBusy: null,
  diskFreeMb: 50_000,
  recentCrash: null,
  pane: '',
  log: '',
};
const texts = (f: DiagFacts, running = false, s = server) => explain(f, s, running).map((x) => x.text);

describe('startScript', () => {
  it('finds the script a start command runs', () => {
    expect(startScript(server)).toBe('/home/me/survival/start.sh');
    expect(startScript({ ...server, start: '/opt/mc/run.sh --fast' })).toBe('/opt/mc/run.sh');
  });
  it('is null when the start command is a program, not a script', () => {
    expect(startScript({ ...server, start: 'java -Xmx4G -jar server.jar nogui' })).toBeNull();
    expect(startScript({ ...server, start: '' })).toBeNull();
  });
});

describe('diagScript', () => {
  it('is valid shell, even for odd folder and session names', () => {
    const sh = spawnSync('sh', ['-n'], { input: diagScript(server) });
    if (sh.error) return; // no sh here (plain Windows): nothing to check against
    expect(sh.stderr.toString()).toBe('');
    expect(sh.status).toBe(0);
    for (const odd of [{ dir: "/home/me/it's here" }, { mux: 'screen' as const }, { start: 'java -jar "my server.jar"' }]) {
      const r = spawnSync('sh', ['-n'], { input: diagScript({ ...server, ...odd }) });
      expect(r.stderr.toString()).toBe('');
    }
  });
  it('quotes the folder so it can’t break out of the command', () => {
    expect(diagScript({ ...server, dir: "/x'; rm -rf ~; '" })).not.toContain("'; rm -rf ~; '/");
  });
  it('reads the screen session with hardcopy, and tmux with capture-pane', () => {
    expect(diagScript(server)).toContain('capture-pane');
    expect(diagScript({ ...server, mux: 'screen' })).toContain('hardcopy');
  });
});

describe('parseDiag', () => {
  const out = [
    '@@dir', 'yes',
    '@@mux', 'yes',
    '@@java', 'openjdk version "17.0.9" 2023-10-17',
    '@@startfile', 'notexec',
    '@@eula', 'eula=false',
    '@@port', 'port=25570', 'LISTEN 0 50 *:25570 *:* users:(("java",pid=812,fd=95))',
    '@@disk', '/dev/sda1 100000000 99900000 102400 99% /',
    '@@crash', '/home/me/survival/crash-reports/crash-2026-11-13.txt',
    '@@pane', 'bash: ./start.sh: Permission denied',
    '@@log', '[12:00:00] [Server thread/INFO]: Starting',
  ].join('\n');

  it('reads every section', () => {
    expect(parseDiag(out)).toEqual({
      dirExists: true,
      hasMux: true,
      java: 'openjdk version "17.0.9" 2023-10-17',
      startFile: 'notexec',
      eula: 'false',
      port: 25570,
      portBusy: 'LISTEN 0 50 *:25570 *:* users:(("java",pid=812,fd=95))',
      diskFreeMb: 100,
      recentCrash: '/home/me/survival/crash-reports/crash-2026-11-13.txt',
      pane: 'bash: ./start.sh: Permission denied',
      log: '[12:00:00] [Server thread/INFO]: Starting',
    });
  });
  it('treats an empty answer as everything missing, not as a crash', () => {
    const f = parseDiag('');
    expect(f).toMatchObject({ dirExists: false, hasMux: false, java: null, startFile: 'none', eula: 'missing', port: 25565, portBusy: null, diskFreeMb: null });
  });
  it('falls back to the default port when server.properties gives none', () => {
    expect(parseDiag('@@port\nport=25565').port).toBe(25565);
  });
});

describe('explain', () => {
  it('says nothing is wrong when nothing is', () => {
    const f = explain(ok, server, false);
    expect(f.every((x) => x.level === 'info')).toBe(true);
    expect(f[0].text).toMatch(/Nothing obviously wrong/);
  });
  it('flags a missing folder', () => {
    expect(texts({ ...ok, dirExists: false })[0]).toMatch(/folder \/home\/me\/survival isn’t on the server/);
  });
  it('flags a missing tmux, naming the one the server uses', () => {
    expect(texts({ ...ok, hasMux: false })[0]).toMatch(/tmux isn’t installed/);
    expect(texts({ ...ok, hasMux: false }, false, { ...server, mux: 'screen' })[0]).toMatch(/screen isn’t installed/);
  });
  it('flags a missing or non-executable start script, with the fix', () => {
    expect(texts({ ...ok, startFile: 'missing' })[0]).toMatch(/start\.sh doesn’t exist/);
    expect(texts({ ...ok, startFile: 'notexec' })[0]).toMatch(/chmod \+x start\.sh/);
  });
  it('flags eula=false, and a missing eula.txt only when it isn’t running', () => {
    expect(texts({ ...ok, eula: 'false' })[0]).toMatch(/eula=true/);
    expect(texts({ ...ok, eula: 'missing' }).join()).toMatch(/no eula\.txt/);
    expect(texts({ ...ok, eula: 'missing' }, true).join()).not.toMatch(/no eula\.txt/);
  });
  it('flags a busy port only when the server isn’t the one using it', () => {
    const busy = { ...ok, portBusy: 'LISTEN *:25565' };
    expect(texts(busy)[0]).toMatch(/Port 25565 is already in use/);
    expect(texts(busy, true).join()).not.toMatch(/already in use/);
  });
  it('warns about low disk space and recent crashes', () => {
    expect(texts({ ...ok, diskFreeMb: 80 })[0]).toMatch(/Only 80 MB/);
    const crash = explain({ ...ok, recentCrash: 'crash-1.txt' }, server, false)[0];
    expect(crash).toMatchObject({ level: 'warn', detail: 'crash-1.txt' });
  });
  it('warns, not errors, when Java isn’t on the SSH PATH', () => {
    const j = explain({ ...ok, java: null }, server, false)[0];
    expect(j.level).toBe('warn');
    expect(explain({ ...ok, java: null }, server, true).some((x) => /Java wasn’t found/.test(x.text))).toBe(false);
  });
  it('explains known messages in the terminal and log, quoting the line', () => {
    const f = explain({ ...ok, pane: 'bash: ./start.sh: No such file or directory\nUnsupportedClassVersionError: class file version 65.0' }, server, false);
    expect(f.map((x) => x.text).join(' ')).toMatch(/newer version of Java/);
    expect(f.find((x) => /doesn’t exist/.test(x.text))?.detail).toBe('bash: ./start.sh: No such file or directory');
  });
  it('ignores the "terminal" when tmux isn’t installed: that text is our own command failing', () => {
    const f = explain({ ...ok, hasMux: false, pane: 'sh: line 9: tmux: command not found' }, server, false);
    expect(f.map((x) => x.text).join(' ')).not.toMatch(/doesn’t know a command/);
    expect(f[0].text).toMatch(/tmux isn’t installed/);
  });
  it('reports each known message once, even if it repeats', () => {
    const log = 'java.lang.OutOfMemoryError: Java heap space\njava.lang.OutOfMemoryError: Java heap space';
    expect(explain({ ...ok, log }, server, false).filter((x) => /ran out of memory/.test(x.text))).toHaveLength(1);
  });
  it('puts errors before warnings before notes', () => {
    const f = explain({ ...ok, diskFreeMb: 50, eula: 'false', recentCrash: 'c.txt' }, server, false);
    const levels = f.map((x) => x.level);
    expect(levels).toEqual([...levels].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a] - ({ error: 0, warn: 1, info: 2 })[b]));
    expect(levels[0]).toBe('error');
  });
  it('notes an empty session when stopped', () => {
    expect(texts(ok).join()).toMatch(/session printed nothing/);
  });
  it('cuts a very long matching line', () => {
    const f = explain({ ...ok, log: 'OutOfMemoryError ' + 'x'.repeat(1000) }, server, false);
    expect(f.find((x) => /ran out of memory/.test(x.text))?.detail?.length).toBe(240);
  });
});

describe('report', () => {
  it('gathers the findings and the raw output into one block of text', () => {
    const text = report(server, { findings: [{ level: 'error', text: 'Bad thing', detail: 'a line' }], pane: 'pane text', log: '', running: false, at: Date.UTC(2026, 10, 13) });
    expect(text).toContain('Survival (stopped)');
    expect(text).toContain('- [error] Bad thing\n    a line');
    expect(text).toContain('--- tmux session ---\npane text');
    expect(text).toContain('logs/latest.log (end) ---\n(nothing)');
  });
});
