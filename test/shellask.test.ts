import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ymd } from '../shared/dates';
import {
  cleanCommand,
  cleanFolder,
  commandRisks,
  describeOs,
  folderFromOsc7,
  folderFromTitle,
  HOST_COMMAND,
  oneLine,
  parseHostInfo,
  riskLine,
  shellAnswer,
  SHELL_SCHEMA,
  shellSystem,
  type ShellAnswer,
} from '../shared/shellAsk';

// The server half talks to Claude and SSH; both are stood in for here.
const claude = vi.hoisted(() => ({ enabled: true, askJson: vi.fn() }));
const ssh = vi.hoisted(() => ({ configured: true, runCommand: vi.fn() }));
vi.mock('../server/src/claude', () => ({ claudeEnabled: () => claude.enabled, askJson: claude.askJson }));
vi.mock('../server/src/shell', () => ({ shellConfigured: () => ssh.configured, runCommand: ssh.runCommand }));

// overBudget reads the prefs and the usage log, so this file gets a database of its own.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'launchpad-shellask-'));
process.env.DATA_DIR = dataDir;
afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // Windows won't delete the database while it's open; it's in the temp folder anyway.
  }
});
let server: typeof import('../server/src/shellask');
let store: typeof import('../server/src/store').store;
beforeAll(async () => {
  server = await import('../server/src/shellask');
  store = (await import('../server/src/store')).store;
});

const answer = (over: Partial<Record<string, unknown>> = {}) => ({ command: 'ls -la', explanation: 'Lists everything here.', deletes: false, overwrites: false, sudo: false, warning: '', ...over });
const ok = (raw: unknown): ShellAnswer => {
  const r = shellAnswer(raw);
  if ('error' in r) throw new Error(r.error);
  return r;
};
const err = (raw: unknown): string => {
  const r = shellAnswer(raw);
  if (!('error' in r)) throw new Error(`expected an error, got ${r.command}`);
  return r.error;
};

describe('what Claude is asked for', () => {
  it('has a strict schema, every field required', () => {
    expect(SHELL_SCHEMA.additionalProperties).toBe(false);
    expect([...SHELL_SCHEMA.required].sort()).toEqual(Object.keys(SHELL_SCHEMA.properties).sort());
  });

  it('tells Claude the OS, the shell and the folder when they’re known', () => {
    const s = shellSystem({ os: 'Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic)', shell: '/bin/bash', cwd: '/var/log' });
    expect(s).toContain('Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic)');
    expect(s).toContain('/bin/bash');
    expect(s).toContain('The terminal is in /var/log.');
    expect(s).toMatch(/exactly one line/);
    const bare = shellSystem({ os: null, shell: null, cwd: null });
    expect(bare).toContain('couldn’t be checked');
    expect(bare).toContain('folder isn’t known');
  });
});

describe('cleaning the command', () => {
  const clean = (v: unknown) => {
    const r = cleanCommand(v);
    if (!r.ok) throw new Error(r.error);
    return r.command;
  };
  const refused = (v: unknown) => {
    const r = cleanCommand(v);
    expect(r.ok).toBe(false);
    return r.ok ? '' : r.error;
  };

  it('keeps a plain command as it is, quotes and all', () => {
    expect(clean(`find /var/log -name '*.log' -size +100M -mtime -7`)).toBe(`find /var/log -name '*.log' -size +100M -mtime -7`);
    expect(clean('du -sh -- "My Files"/* | sort -h')).toBe('du -sh -- "My Files"/* | sort -h');
  });

  it('takes off fences, backticks, a prompt sign and the whitespace around it', () => {
    expect(clean('```bash\ndf -h\n```')).toBe('df -h');
    expect(clean('```df -h```')).toBe('df -h');
    expect(clean('`df -h`')).toBe('df -h');
    expect(clean('$ df -h')).toBe('df -h');
    expect(clean('\n  df -h  \n')).toBe('df -h');
    // $HOME isn't a prompt.
    expect(clean('$HOME/bin/x')).toBe('$HOME/bin/x');
  });

  it('refuses more than one line, however the lines are broken', () => {
    for (const v of ['ls\nrm -rf ~', 'ls\rrm -rf ~', 'ls\r\nrm x', 'ls\u2028rm x', 'ls\u2029rm x', 'ls\u0085rm x', 'ls\u000brm x', 'ls\u000crm x', '```\nls\ncat x\n```']) {
      expect(refused(v)).toMatch(/more than one line/);
    }
  });

  it('drops control characters, so nothing can press keys or escape the paste', () => {
    // An escape sequence that would end bracketed paste, a bell, a backspace, DEL and a C1 CSI.
    expect(clean('echo hi\u001b[201~ ok')).toBe('echo hi[201~ ok');
    expect(clean('ls\u0007\u0008\u007f\u009b -l')).toBe('ls -l');
    expect(clean('ls\u0000 -l')).toBe('ls -l');
    // Tabs would trigger completion.
    expect(clean('ls\t-l')).toBe('ls -l');
    // Ctrl C, Ctrl D and Ctrl Z.
    expect(clean('a\u0003b\u0004c\u001ad')).toBe('abcd');
  });

  it('drops invisible and direction-changing characters', () => {
    expect(clean('ls\u200b -l')).toBe('ls -l');
    expect(clean('echo \u202eabc\u202c')).toBe('echo abc');
    expect(clean('\ufeffls')).toBe('ls');
  });

  it('refuses nothing at all, too much, and an answer that isn’t text', () => {
    expect(refused('')).toMatch(/didn’t come up with/);
    expect(refused('\u0007\u0008')).toMatch(/didn’t come up with/);
    expect(refused('x'.repeat(1001))).toMatch(/over 1000/);
    expect(clean('x'.repeat(1000))).toHaveLength(1000);
    expect(refused(42)).toMatch(/garbled/);
    expect(refused(null)).toMatch(/garbled/);
  });

  it('keeps every character a printable command needs', () => {
    const all = 'awk -F: \'{ print $1 }\' /etc/passwd | grep -E "^(a|b)" && echo $((1+2)) ; ls ~/*.txt 2>/dev/null || true # é ü 日本';
    expect(clean(all)).toBe(all);
  });
});

describe('spotting risky commands', () => {
  const risks = (cmd: string) => commandRisks(cmd);

  it('sees deleting', () => {
    for (const c of ['rm -rf ./build', 'find . -name "*.tmp" -delete', 'find . -mtime +30 -exec rm {} +', 'ls | xargs rm', 'rsync -a --delete src/ dst/', 'docker system prune -af', 'docker image prune', 'docker rm old', 'sudo apt-get -y autoremove', 'apt purge foo', 'git clean -fdx', 'rmdir empty', 'shred -u secret', 'tar czf a.tgz x --remove-files']) {
      expect(risks(c), c).toContain('deletes');
    }
  });

  it('sees overwriting', () => {
    for (const c of ['echo hi > notes.txt', 'sort x >| y', 'cmd &> out.log', "sed -i 's/a/b/' f", 'sed -i.bak -e s/a/b/ f', "perl -pi -e 's/a/b/' f", 'mv a b', 'cp -r a b', 'dd if=/dev/zero of=disk.img bs=1M count=1', 'mkfs.ext4 /dev/sdb1', 'truncate -s 0 big.log', 'echo x | tee file', 'git reset --hard', 'git checkout -- .', 'unzip -o a.zip']) {
      expect(risks(c), c).toContain('overwrites');
    }
  });

  it('sees sudo', () => {
    for (const c of ['sudo systemctl restart nginx', 'ls && sudo du -sh /root', 'echo x | sudo tee /etc/x', 'doas reboot', 'su -c "id"']) expect(risks(c), c).toContain('sudo');
  });

  it('leaves harmless commands alone', () => {
    for (const c of [
      'ls -la',
      'df -h',
      `find /var/log -name '*.log' -size +100M -mtime -7`,
      'du -sh * 2>/dev/null | sort -h',
      'journalctl -u nginx --since today 2>&1 | tail',
      'echo hi >> notes.txt',
      'ls >/dev/null',
      'echo oops >&2',
      'grep -r "rm -rf" .',
      "awk '$5 > 100' data",
      'docker run --rm alpine echo hi',
      'docker ps -a',
      'sudoku-solver --help',
      'apt list --installed',
      'diff <(ls a) <(ls b)',
      'echo x | tee -a log',
      'sed -n 1,5p f',
      'git status',
      'rmlint --help',
    ]) {
      expect(risks(c), c).toEqual([]);
    }
  });

  it('says what the risks are in a sentence', () => {
    expect(riskLine([])).toBe('');
    expect(riskLine(['sudo'])).toBe('Needs sudo.');
    expect(riskLine(['sudo', 'deletes'])).toBe('Deletes files and needs sudo.');
    expect(riskLine(['overwrites', 'sudo', 'deletes'])).toBe('Deletes files, can overwrite files and needs sudo.');
  });
});

describe('Claude’s answer', () => {
  it('becomes a command, a line on what it does, and no warning when it’s harmless', () => {
    expect(ok(answer())).toEqual({ command: 'ls -la', explanation: 'Lists everything here.', warning: null, risks: [] });
  });

  it('warns when Claude or Launchpad sees a risk, with Claude’s words after', () => {
    expect(ok(answer({ command: 'sudo rm -rf /var/log/old', deletes: true, sudo: true, warning: 'Removes the old logs for good.' }))).toMatchObject({
      risks: ['deletes', 'sudo'],
      warning: 'Deletes files and needs sudo. Removes the old logs for good.',
    });
    // Claude forgot to say; the command says it anyway.
    expect(ok(answer({ command: 'find . -name "*.tmp" -delete' }))).toMatchObject({ risks: ['deletes'], warning: 'Deletes files.' });
    // Claude says it's risky in a way Launchpad can't see.
    expect(ok(answer({ command: 'myscript --apply', overwrites: true }))).toMatchObject({ risks: ['overwrites'], warning: 'Can overwrite files.' });
    // A warning about something else is still shown.
    expect(ok(answer({ command: 'ls -R /', warning: 'Takes a while on big disks.' }))).toMatchObject({ risks: [], warning: 'Takes a while on big disks.' });
  });

  it('keeps the explanation and warning to one line of plain text', () => {
    const a = ok(answer({ explanation: 'Lists\nevery\u001b[31m file.', warning: '  ' }));
    expect(a.explanation).toBe('Lists every[31m file.');
    expect(a.warning).toBeNull();
    expect(ok(answer({ explanation: 'x'.repeat(400) })).explanation).toHaveLength(300);
    expect(oneLine(undefined)).toBe('');
  });

  it('says why when there’s no command', () => {
    expect(err(answer({ command: '', explanation: 'That needs a GUI, not a shell.' }))).toBe('That needs a GUI, not a shell.');
    expect(err(answer({ command: '  ', explanation: '' }))).toMatch(/couldn’t turn that into one command/);
    expect(err(answer({ command: 'ls\nrm -rf ~' }))).toMatch(/more than one line/);
    expect(err(null)).toMatch(/garbled/);
    expect(err({ command: 7 })).toMatch(/garbled/);
  });
});

describe('the terminal’s folder', () => {
  it('comes from a title like the one Debian, Ubuntu and Fedora set at the prompt', () => {
    expect(folderFromTitle('irsyad@nas: ~/logs')).toBe('~/logs');
    expect(folderFromTitle('irsyad@nas:/var/log')).toBe('/var/log');
    expect(folderFromTitle('(chroot)me@box: /srv/my files')).toBe('/srv/my files');
    expect(folderFromTitle('me@box: ~')).toBe('~');
    // A title that's a running program, or anything else, says nothing.
    for (const t of ['vim notes.txt', 'htop', 'me@box', 'me@box: ', 'me@box: logs', '', 'me@box: ~/a\u0007b']) expect(folderFromTitle(t), t).toBeNull();
  });

  it('comes from an OSC 7 report', () => {
    expect(folderFromOsc7('file://nas/home/me/my%20dir')).toBe('/home/me/my dir');
    expect(folderFromOsc7('file:///tmp')).toBe('/tmp');
    expect(folderFromOsc7('http://x/y')).toBeNull();
    expect(folderFromOsc7('not a url')).toBeNull();
    expect(folderFromOsc7('file://h/%E0%A4%A')).toBeNull();
    expect(folderFromOsc7('file://h/a%0Ab')).toBeNull();
  });

  it('is only passed on when it looks like a folder', () => {
    expect(cleanFolder('/home/me')).toBe('/home/me');
    expect(cleanFolder('~/x')).toBe('~/x');
    for (const v of ['', 'relative/path', '~other', '/a\nb', '/a\u202eb', '/' + 'x'.repeat(1024), 42, null]) expect(cleanFolder(v)).toBeNull();
  });
});

describe('the server’s OS', () => {
  const RELEASE = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n';

  it('reads the name from /etc/os-release and the kernel from uname', () => {
    expect(describeOs('Linux 6.8.0-45-generic', RELEASE)).toBe('Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic)');
    expect(describeOs('Linux 6.1.0', "NAME='Alpine Linux'\n")).toBe('Alpine Linux (Linux 6.1.0)');
    expect(describeOs('Darwin 23.4.0', '')).toBe('Darwin 23.4.0');
    expect(describeOs('', '')).toBeNull();
  });

  it('reads what the one command printed, by label', () => {
    expect(parseHostInfo(`KERNEL=Linux 6.8.0-45-generic\nSHELL=/bin/bash\n${RELEASE}`)).toEqual({ os: 'Ubuntu 24.04.1 LTS (Linux 6.8.0-45-generic)', shell: '/bin/bash' });
    expect(parseHostInfo('KERNEL=Linux 6.8.0\r\nSHELL=\r\n')).toEqual({ os: 'Linux 6.8.0', shell: null });
    // No uname on the PATH: the shell line isn't mistaken for the OS.
    expect(parseHostInfo('KERNEL=\nSHELL=/usr/bin/bash\n')).toEqual({ os: null, shell: '/usr/bin/bash' });
    expect(parseHostInfo(`KERNEL=\nSHELL=/bin/zsh\n${RELEASE}`)).toEqual({ os: 'Ubuntu 24.04.1 LTS', shell: '/bin/zsh' });
    expect(parseHostInfo('')).toEqual({ os: null, shell: null });
  });
});

describe('asking on the server', () => {
  const HOST = { code: 0, stdout: 'KERNEL=Linux 6.8.0-45-generic\nSHELL=/bin/bash\nPRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\n', stderr: '' };

  beforeEach(() => {
    claude.enabled = true;
    ssh.configured = true;
    claude.askJson.mockReset();
    store.setPrefs({ ...store.prefs(), claudeBudget: 0 });
    store.setClaudeUsage({});
  });

  it('sends the OS and the folder, reads the OS only once, and cleans the answer', async () => {
    ssh.runCommand.mockReset().mockResolvedValue(HOST);
    claude.askJson.mockResolvedValue(answer({ command: 'find . -name "*.log" -size +100M -mtime -7', explanation: 'Finds big logs changed this week.' }));
    const [res, status] = await server.shellAskRequest({ text: '  find all log files over 100MB modified this week ', cwd: '/var/log' });
    expect(status).toBe(200);
    expect(res).toEqual({ command: 'find . -name "*.log" -size +100M -mtime -7', explanation: 'Finds big logs changed this week.', warning: null, risks: [] });
    const opts = claude.askJson.mock.calls[0][0];
    expect(opts.user).toBe('find all log files over 100MB modified this week');
    expect(opts.feature).toBe('terminal');
    expect(opts.system).toContain('Debian GNU/Linux 12 (bookworm) (Linux 6.8.0-45-generic)');
    expect(opts.system).toContain('The terminal is in /var/log.');
    // A folder that isn't one is left out.
    await server.shellAskRequest({ text: 'list files', cwd: 'rm -rf /\n' });
    expect(claude.askJson.mock.calls[1][0].system).toContain('folder isn’t known');
    expect(ssh.runCommand).toHaveBeenCalledTimes(1);
    expect(ssh.runCommand.mock.calls[0][0]).toBe(HOST_COMMAND);
    expect(HOST_COMMAND).toContain('uname -sr');
    expect(HOST_COMMAND).toContain('/etc/os-release');
  });

  it('never runs anything on the server but the OS check', async () => {
    claude.askJson.mockResolvedValue(answer({ command: 'rm -rf ~/tmp', deletes: true }));
    const [res] = await server.shellAskRequest({ text: 'clear my tmp folder' });
    expect(res).toMatchObject({ command: 'rm -rf ~/tmp', risks: ['deletes'] });
    // The OS was read for the first ask; nothing has been run on the server since.
    expect(ssh.runCommand).not.toHaveBeenCalled();
  });

  it('refuses multi-line answers', async () => {
    claude.askJson.mockResolvedValue(answer({ command: 'cd /tmp\nrm -rf *' }));
    const [res, status] = await server.shellAskRequest({ text: 'clean tmp' });
    expect(status).toBe(200);
    expect(res).toEqual({ error: expect.stringMatching(/more than one line/) });
  });

  it('checks the request before asking', async () => {
    expect(await server.shellAskRequest({ text: '   ' })).toEqual([{ error: 'Type what you want to do.' }, 400]);
    expect(await server.shellAskRequest(null)).toEqual([{ error: 'Type what you want to do.' }, 400]);
    expect((await server.shellAskRequest({ text: 'x'.repeat(401) }))[1]).toBe(400);
    claude.enabled = false;
    expect(await server.shellAskRequest({ text: 'ls' })).toEqual([{ error: expect.stringMatching(/ANTHROPIC_API_KEY/) }, 400]);
    claude.enabled = true;
    ssh.configured = false;
    expect(await server.shellAskRequest({ text: 'ls' })).toEqual([{ error: expect.stringMatching(/SSH_HOST/) }, 400]);
    expect(claude.askJson).not.toHaveBeenCalled();
  });

  it('stops at the monthly budget', async () => {
    // $5 of Haiku output today, against a $1 budget.
    store.setClaudeUsage({ [ymd(new Date())]: { news: { 'claude-haiku-5-5': { calls: 1, input: 0, output: 10_000_000, cacheRead: 0, cacheWrite: 0 } } } });
    store.setPrefs({ ...store.prefs(), claudeBudget: 1 });
    const blocked = server.shellAskStatus().blocked;
    expect(blocked).toBe('Claude has cost about $5.00 this month, over your $1.00 budget. Raise the budget in Settings › General to ask for more commands.');
    expect(await server.shellAskRequest({ text: 'ls' })).toEqual([{ error: blocked }, 400]);
    expect(claude.askJson).not.toHaveBeenCalled();
    // Without a key, that's what the page says, not the budget.
    claude.enabled = false;
    expect(server.shellAskStatus()).toEqual({ enabled: false, blocked: null });
    claude.enabled = true;
    store.setPrefs({ ...store.prefs(), claudeBudget: 1000 });
    expect(server.shellAskStatus()).toEqual({ enabled: true, blocked: null });
  });

  it('turns Claude’s failures into something to act on here', async () => {
    claude.askJson.mockRejectedValue(new Error('Claude took too long to answer. It tries again on the next sync, or press refresh.'));
    expect(await server.shellAskRequest({ text: 'ls' })).toEqual([{ error: 'Claude took too long to answer. Try again.' }, 200]);
    expect(server.plainError('Hit the Claude API rate limit. It tries again on the next sync; if it keeps happening, check your limits at platform.claude.com.')).toBe(
      'Hit the Claude API rate limit. Try again; if it keeps happening, check your limits at platform.claude.com.',
    );
    expect(server.plainError('The summary was cut off. Press refresh to try again.')).toBe('Claude’s answer was cut off. Try again.');
    expect(server.plainError('Couldn’t reach the Claude API. Check it, then press refresh.')).toBe('Couldn’t reach the Claude API. Check it, then try again.');
    expect(server.plainError('Add credit at platform.claude.com → Billing; summaries pick up again on the next sync.')).toBe('Add credit at platform.claude.com → Billing.');
  });
});

describe('reading the OS over SSH', () => {
  it('asks again after a failed read, and answers without the OS meanwhile', async () => {
    vi.resetModules();
    const fresh = await import('../server/src/shellask');
    ssh.runCommand.mockReset().mockRejectedValueOnce(new Error('Timed out connecting to nas:22.')).mockResolvedValue({ code: 0, stdout: 'KERNEL=Linux 6.8.0\nSHELL=/bin/zsh\n', stderr: '' });
    expect(await fresh.hostInfo()).toEqual({ os: null, shell: null });
    expect(await fresh.hostInfo()).toEqual({ os: 'Linux 6.8.0', shell: '/bin/zsh' });
    expect(await fresh.hostInfo()).toEqual({ os: 'Linux 6.8.0', shell: '/bin/zsh' });
    expect(ssh.runCommand).toHaveBeenCalledTimes(2);
  });
});
