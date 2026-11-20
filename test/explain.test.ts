import { beforeEach, describe, expect, it, vi } from 'vitest';

const claude = vi.hoisted(() => ({ enabled: true, calls: [] as { model: string; feature?: string; user: string; system: string }[], answer: { summary: 'It ran out of memory.', cause: 'The heap is too small.', fix: ['Raise -Xmx to 6G.', ' '] } as unknown, fail: '' }));
vi.mock('../server/src/claude', () => ({
  claudeEnabled: () => claude.enabled,
  askJson: vi.fn(async (o: { model: string; feature?: string; user: string; system: string }) => {
    claude.calls.push(o);
    if (claude.fail) throw new Error(claude.fail);
    return claude.answer;
  }),
}));

import { crashExcerpt, EXPLAIN_MAX, explainLog, explainStatus, lastErrorBlock, redact } from '../server/src/explain';
import { store } from '../server/src/store';
import { ymd } from '../shared/dates';
import { DEFAULT_PREFS } from '../shared/defaults';

const PAPER = [
  '[12:00:00 INFO]: Starting minecraft server version 1.21.1',
  '[12:00:01 INFO]: Loading properties',
  '[12:00:02 INFO]: Preparing level "world"',
  '[12:00:03 WARN]: Can\'t keep up! Is the server overloaded?',
  '[12:00:04 ERROR]: Could not pass event PlayerJoinEvent to Essentials v2.20',
  'java.lang.OutOfMemoryError: Java heap space',
  '\tat java.base/java.util.Arrays.copyOf(Arrays.java:3537)',
  '\tat com.earth2me.essentials.User.<init>(User.java:88)',
  'Caused by: java.lang.IllegalStateException: no room',
  '\t... 12 more',
  '[12:00:05 INFO]: Steve left the game',
  '[12:00:06 INFO]: Saving chunks for level \'world\'',
].join('\n');

describe('the part of the log that matters', () => {
  it('is the last error, its stack, and a little either side', () => {
    const b = lastErrorBlock(PAPER);
    expect(b.found).toBe(true);
    expect(b.text).toContain('Could not pass event PlayerJoinEvent');
    expect(b.text).toContain('Caused by: java.lang.IllegalStateException: no room');
    expect(b.text).toContain('Starting minecraft server');
    expect(b.text).toContain('Saving chunks');
  });
  it('is the last lines when nothing went wrong', () => {
    const log = Array.from({ length: 200 }, (_, i) => `[12:00:00 INFO]: line ${i}`).join('\n');
    const b = lastErrorBlock(log);
    expect(b.found).toBe(false);
    expect(b.text.split('\n')).toHaveLength(60);
    expect(b.text.endsWith('line 199')).toBe(true);
  });
  it('is cut to a few KB, keeping the start and the end', () => {
    const stack = Array.from({ length: 2000 }, (_, i) => `\tat com.example.Deep.call${i}(Deep.java:${i})`);
    const log = ['[12:00:00 ERROR]: Exception in server tick loop', 'java.lang.StackOverflowError', ...stack, 'Caused by: java.lang.RuntimeException: the real cause'].join('\n');
    const b = lastErrorBlock(log);
    expect(b.text.length).toBeLessThanOrEqual(EXPLAIN_MAX);
    expect(b.text).toContain('java.lang.StackOverflowError');
    expect(b.text).toContain('the real cause');
    expect(b.text).toMatch(/… \(\d+ lines left out\) …/);
  });
  it('for a crash report, is its top and its system details', () => {
    const report = `---- Minecraft Crash Report ----\nDescription: Ticking entity\n\njava.lang.NullPointerException: x\n\tat a.b(C.java:1)\n\nA detailed walkthrough of the error, its code path and all known details is as follows:\n${'filler\n'.repeat(3000)}-- System Details --\nDetails:\n\tMinecraft Version: 1.21.1\n\tJava Version: 21.0.2\n`;
    const e = crashExcerpt(report);
    expect(e).toContain('Description: Ticking entity');
    expect(e).toContain('Minecraft Version: 1.21.1');
    expect(e).not.toContain('filler');
    expect(e.length).toBeLessThanOrEqual(EXPLAIN_MAX);
  });
});

describe('secrets out', () => {
  it('takes out passwords, tokens and keys', () => {
    const cases: [string, string][] = [
      ['rcon.password=hunter2', 'rcon.password=[redacted]'],
      ['DB_PASSWORD: s3cr3t!', 'DB_PASSWORD: [redacted]'],
      ['{"access_token": "abc.def", "user": "sam"}', '{"access_token": [redacted], "user": "sam"}'],
      ['GET /api?api_key=XYZ123&page=2', 'GET /api?api_key=[redacted]&page=2'],
      ['Retrying in 10 s (token=abc123)', 'Retrying in 10 s (token=[redacted])'],
      ['x-api-key: 9f8e7d6c', 'x-api-key: [redacted]'],
      ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer [redacted]'],
      ['connecting to postgres://app:pa55w0rd@db:5432/app', 'connecting to postgres://[redacted]@db:5432/app'],
      ['key sk-ant-api03-AbCdEf0123456789xyz', 'key [redacted]'],
      ['token ghp_0123456789abcdefghijABCDEFGHIJ012345', 'token [redacted]'],
      ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', 'jwt [redacted]'],
      ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', '[redacted private key]'],
      ['secret=9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b', 'secret=[redacted]'],
      ['value AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh end', 'value [redacted] end'],
    ];
    for (const [i, o] of cases) expect(redact(i), i).toBe(o);
  });
  it('leaves the rest of a log alone', () => {
    const keep = [
      'java.lang.IllegalStateException: Failed to bind to port',
      'com.mojang.authlib.exceptions.AuthenticationException: Invalid credentials',
      'at com.mojang.authlib.yggdrasil.YggdrasilMinecraftSessionService.joinServer(YggdrasilMinecraftSessionService.java:52)',
      'UUID of player Steve is 069a79f4-44e9-4726-a5be-fca90e38aaf5',
      '/home/me/minecraft/survival/plugins/EssentialsX-2.20.1.jar',
      'password: null',
      'Unexpected token: }',
    ];
    for (const l of keep) expect(redact(l), l).toBe(l);
  });
});

describe('asking Claude', () => {
  beforeEach(() => {
    claude.enabled = true;
    claude.calls = [];
    claude.fail = '';
    store.setPrefs({ ...DEFAULT_PREFS, claudeBudget: 0 });
    store.setClaudeUsage({});
  });

  it('isn’t offered without an API key', async () => {
    claude.enabled = false;
    expect(explainStatus()).toEqual({ configured: false, ready: false, reason: expect.stringMatching(/ANTHROPIC_API_KEY/) });
    await expect(explainLog('x', PAPER)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(claude.calls).toHaveLength(0);
  });

  it('stops once this month’s spending reaches the budget', async () => {
    store.setPrefs({ ...DEFAULT_PREFS, claudeBudget: 1 });
    store.setClaudeUsage({ [ymd(new Date())]: { news: { 'claude-opus-5-5': { calls: 1, input: 0, output: 100_000, cacheWrite: 0, cacheRead: 0 } } } });
    const st = explainStatus();
    expect(st).toMatchObject({ configured: true, ready: false });
    expect(st.reason).toMatch(/\$2\.00.*\$1\.00 budget/);
    await expect(explainLog('x', PAPER)).rejects.toThrow(/budget/);
    expect(claude.calls).toHaveLength(0);
  });

  it('sends the excerpt with secrets out, and tidies the answer', async () => {
    const r = await explainLog('the Docker container nextcloud', `${PAPER}\nERROR: login failed password=hunter2`);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0].feature).toBe('explain');
    expect(claude.calls[0].user).toContain('the Docker container nextcloud');
    expect(claude.calls[0].user).not.toContain('hunter2');
    expect(r).toEqual({ summary: 'It ran out of memory.', cause: 'The heap is too small.', fix: ['Raise -Xmx to 6G.'], excerpt: expect.stringContaining('password=[redacted]'), foundError: true });
  });

  it('answers the same excerpt twice without paying twice, but tries again after a failure', async () => {
    const log = `${PAPER}\nthe same one`;
    await explainLog('a', log);
    await explainLog('a', log);
    expect(claude.calls).toHaveLength(1);
    claude.fail = 'Claude took too long';
    await expect(explainLog('b', log)).rejects.toThrow('too long');
    claude.fail = '';
    await explainLog('b', log);
    expect(claude.calls).toHaveLength(3);
  });

  it('refuses an empty log', async () => {
    await expect(explainLog('x', '\n\n')).rejects.toThrow('empty');
  });
});
