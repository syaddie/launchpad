import { describe, expect, it } from 'vitest';
import { autoId, cleanCommand, cleanMcServer, cleanMcServers, DETECT, LOG_MAX, LOG_TAIL, logWindow, mergeStatuses, parseDetect, plainLog, screenEscape, sendLine, startLine, takeLines } from '../server/src/minecraft';
import { cleanUrl, nameFrom, safeName, withNumber } from '../server/src/downloads';
import { cleanHashes, cleanTorrentLinks, hostDirOf, toTorrent, torrentStatus } from '../server/src/qbit';
import { addLines, lineLevel } from '../web/src/components/Minecraft';
import { canResume, fmtEta, linkKind } from '../web/src/components/Downloads';
import type { McServer } from '../shared/types';

// What DETECT prints on a server with two Minecraft servers (one in tmux, one in screen),
// a third java that isn't Minecraft, and one started outside either.
const SAMPLE = [
  '    1     0 /sbin/init',
  '  900     1 tmux new-session -d -s survival',
  '  901   900 -bash',
  ' 1000   901 java -Xmx4G -jar paper.jar nogui',
  ' 2000     1 SCREEN -dmS creative',
  ' 2001  2000 /bin/bash',
  ' 2002  2001 /bin/sh ./start.sh',
  ' 2003  2002 java -Xmx2G -jar server.jar',
  ' 3000     1 java -jar some-other-app.jar',
  ' 4000     1 java -jar velocity.jar',
  '@@tmux',
  '901\tsurvival',
  '@@screen',
  'There is a screen on:',
  '\t2000.creative\t(13/11/26 10:00:00)\t(Detached)',
  '1 Socket in /run/screen/S-me.',
  '@@java',
  '1000\t/home/me/mc/survival\tserver.properties',
  '2003\t/home/me/mc/creative\tserver.properties',
  '3000\t/opt/other\t',
  '4000\t/home/me/mc/proxy\tvelocity.toml',
  '',
].join('\n');

const saved = (over: Partial<McServer> = {}): McServer => ({ id: 's1', name: 'Survival', dir: '/home/me/mc/survival', mux: 'tmux', session: 'survival', start: './start.sh', ...over });

describe('minecraft: finding servers', () => {
  it('asks for processes, sessions and java folders in one go', () => {
    expect(DETECT).toContain('ps -eo pid=,ppid=,args=');
    expect(DETECT).toContain('tmux list-panes -a');
    expect(DETECT).toContain('screen -ls');
    expect(DETECT).toContain('pgrep -x java');
  });

  it('finds each server and the session it runs in', () => {
    const found = parseDetect(SAMPLE);
    expect(found).toEqual([
      { pid: 1000, dir: '/home/me/mc/survival', mux: 'tmux', session: 'survival' },
      { pid: 2003, dir: '/home/me/mc/creative', mux: 'screen', session: '2000.creative' },
      { pid: 4000, dir: '/home/me/mc/proxy', mux: null, session: null },
    ]);
  });

  it('takes a java with nogui as a server even without its config in view', () => {
    const out = ['  10     1 java -jar fabric.jar --nogui', '@@tmux', '@@screen', '@@java', '10\t\t'].join('\n');
    expect(parseDetect(out)).toEqual([{ pid: 10, dir: null, mux: null, session: null }]);
  });

  it('lists saved servers first, matched to running ones, then the others found', () => {
    const found = parseDetect(SAMPLE);
    const list = mergeStatuses([saved(), saved({ id: 's2', name: 'Creative', dir: '/srv/elsewhere', mux: 'screen', session: 'creative' }), saved({ id: 's3', name: 'Old', dir: '/home/me/mc/old', session: 'old' })], found);
    expect(list.map((s) => [s.id, s.running, s.session, s.attached])).toEqual([
      ['s1', true, 'survival', true],
      // Matched by screen session name, whatever the pid in front.
      ['s2', true, '2000.creative', true],
      ['s3', false, 'old', false],
      [autoId('/home/me/mc/proxy'), true, '', false],
    ]);
    expect(list[3]).toMatchObject({ name: 'proxy', saved: false, pid: 4000 });
    // The same id every time, so the page keeps its pick.
    expect(mergeStatuses([], found)[0].id).toBe(autoId('/home/me/mc/survival'));
  });
});

describe('minecraft: typing into the console', () => {
  it('types into tmux exactly, then presses Enter', () => {
    expect(sendLine('tmux', 'survival', 'say hi')).toBe(`tmux send-keys -t '=survival:' -l -- 'say hi' && tmux send-keys -t '=survival:' Enter`);
    expect(sendLine('tmux', 'survival', `say it's; rm -rf ~`)).toBe(`tmux send-keys -t '=survival:' -l -- 'say it'\\''s; rm -rf ~' && tmux send-keys -t '=survival:' Enter`);
  });

  it('escapes what screen would read as keys', () => {
    expect(screenEscape('a^b\\c')).toBe('a\\^b\\\\c');
    expect(sendLine('screen', '2000.creative', 'say ^_^')).toBe(`screen -S '2000.creative' -p 0 -X stuff 'say \\^_\\^\r'`);
  });

  it('makes the session if needed, then types the start command in the folder', () => {
    const t = startLine(saved());
    expect(t).toContain(`tmux has-session -t '=survival' 2>/dev/null || tmux new-session -d -s 'survival' -c '/home/me/mc/survival'`);
    expect(t).toContain(`-l -- 'cd '\\''/home/me/mc/survival'\\'' && ./start.sh'`);
    const s = startLine(saved({ mux: 'screen', session: 'creative' }));
    expect(s).toContain(`grep -qF -- '.creative\t'`);
    expect(s).toContain(`screen -dmS 'creative'`);
  });

  it('takes one line, without the slash', () => {
    expect(cleanCommand('  /time set day ')).toBe('time set day');
    for (const bad of ['', '   ', '/', 'say a\nstop', 'say \x1b[31m', 'x'.repeat(1001), 42]) expect(() => cleanCommand(bad)).toThrow();
  });

  it('checks a server before saving it', () => {
    expect(cleanMcServer({ name: ' Survival ', dir: '/home/me/mc/survival/', mux: 'tmux', session: 'survival', start: ' ./start.sh ' }, 'id1')).toEqual(saved({ id: 'id1' }));
    expect(cleanMcServer({ name: 'x', dir: '/x', mux: 'nope', session: 's' }, 'a').mux).toBe('tmux');
    expect(() => cleanMcServer({ name: '', dir: '/x', session: 's' }, 'a')).toThrow('name');
    expect(() => cleanMcServer({ name: 'x', dir: 'mc', session: 's' }, 'a')).toThrow('full path');
    expect(() => cleanMcServer({ name: 'x', dir: '/x', session: 'my server' }, 'a')).toThrow('session');
    expect(() => cleanMcServer({ name: 'x', dir: '/x', session: 's', start: 'a\nb' }, 'a')).toThrow('one line');
    expect(cleanMcServers([saved(), saved(), { id: 'bad', name: '' }, 'junk'])).toEqual([saved()]);
  });
});

describe('minecraft: the log', () => {
  it('starts near the end, then picks up where it stopped', () => {
    expect(logWindow(1000, null)).toEqual({ start: 0, end: 1000, reset: true });
    expect(logWindow(LOG_TAIL * 3, null)).toEqual({ start: LOG_TAIL * 2, end: LOG_TAIL * 3, reset: true });
    expect(logWindow(1000, 400)).toEqual({ start: 400, end: 1000, reset: false });
    expect(logWindow(LOG_MAX * 4, 0)).toEqual({ start: 0, end: LOG_MAX, reset: false });
    // Shorter than where it was: the server restarted and the log began again.
    expect(logWindow(100, 400)).toEqual({ start: 0, end: 100, reset: true });
  });

  it('hands over whole lines only', () => {
    const buf = Buffer.from('tail of a line\nfirst\nsecond\npart');
    expect(takeLines(buf, 500, true)).toEqual({ text: 'first\nsecond\n', offset: 500 + buf.length - 4 });
    expect(takeLines(buf, 0, false)).toEqual({ text: 'tail of a line\nfirst\nsecond\n', offset: buf.length - 4 });
    expect(takeLines(Buffer.from('no newline yet'), 10, false)).toEqual({ text: '', offset: 10 });
  });

  it('drops colour codes', () => {
    expect(plainLog('\x1b[33m[12:00:00] [Server thread/WARN]: §cHot\x1b[0m\r')).toBe('[12:00:00] [Server thread/WARN]: Hot');
  });

  it('colours lines by level, and chat', () => {
    expect(lineLevel('[12:00:00] [Server thread/WARN]: Can’t keep up!')).toBe('warn');
    expect(lineLevel('[12:00:00] [Server thread/ERROR]: Boom')).toBe('error');
    expect(lineLevel('[12:00:00] [Async Chat Thread - #0/INFO]: <Steve> hello')).toBe('chat');
    expect(lineLevel('[12:00:00] [Server thread/INFO]: Done (3.2s)!')).toBe('');
  });

  it('keeps the screen to the last lines', () => {
    expect(addLines(['a'], 'b\nc\n', false)).toEqual(['a', 'b', 'c']);
    expect(addLines(['a'], 'b\n', true)).toEqual(['b']);
    expect(addLines(['a'], '', false)).toEqual(['a']);
    expect(addLines([], 'x\n'.repeat(5000), false)).toHaveLength(3000);
  });
});

describe('downloads', () => {
  it('takes http and https links only', () => {
    expect(cleanUrl(' https://example.com/a.zip ').href).toBe('https://example.com/a.zip');
    for (const bad of ['ftp://x/y', 'magnet:?xt=urn:btih:abc', 'file:///etc/passwd', 'not a link', 42]) expect(() => cleanUrl(bad)).toThrow();
  });

  it('names the file as the site does, else from the link', () => {
    const u = new URL('https://cdn.example.com/files/Paper%201.21.jar?token=x');
    expect(nameFrom(u, null)).toBe('Paper 1.21.jar');
    expect(nameFrom(u, 'attachment; filename="server.jar"')).toBe('server.jar');
    expect(nameFrom(u, "attachment; filename*=UTF-8''caf%C3%A9.zip; filename=\"cafe.zip\"")).toBe('café.zip');
    expect(nameFrom(u, 'attachment; filename="../../etc/passwd"')).toBe('passwd');
    expect(nameFrom(new URL('https://example.com/'), null)).toBe('example.com');
  });

  it('keeps names to one plain file', () => {
    expect(safeName('..\\..\\x.txt')).toBe('x.txt');
    expect(safeName('.bashrc')).toBe('bashrc');
    expect(safeName('a\x00b\nc')).toBe('abc');
    expect(safeName('..')).toBe('');
    const long = safeName('x'.repeat(300) + '.tar');
    expect(long).toHaveLength(200);
    expect(long.endsWith('.tar')).toBe(true);
  });

  it('numbers a name that’s taken', () => {
    expect(withNumber('server.jar', 2)).toBe('server (2).jar');
    expect(withNumber('world.tar.gz', 3)).toBe('world (3).tar.gz');
    expect(withNumber('README', 2)).toBe('README (2)');
  });

  it('sends magnets and .torrent links to qBittorrent, and other links to a folder', () => {
    expect(linkKind('magnet:?xt=urn:btih:abc')).toBe('torrent');
    expect(linkKind('magnet:?xt=urn:btih:a\nmagnet:?xt=urn:btih:b')).toBe('torrent');
    expect(linkKind('https://example.com/ubuntu.iso.torrent')).toBe('torrent');
    expect(linkKind('https://example.com/ubuntu.iso')).toBe('http');
    expect(linkKind('https://a.com/x\nhttps://b.com/y')).toBe(null);
    expect(linkKind('  ')).toBe(null);
  });

  it('says how long is left', () => {
    expect(fmtEta(null)).toBe('');
    expect(fmtEta(0.2)).toBe('1 s');
    expect(fmtEta(45)).toBe('45 s');
    expect(fmtEta(600)).toBe('10 min');
    expect(fmtEta(3600 * 3 + 1200)).toBe('3 h 20 min');
    expect(fmtEta(86_400 * 2)).toBe('2 days');
  });
});

describe('qBittorrent', () => {
  it('puts its states in a few words, v4 and v5 alike', () => {
    expect(torrentStatus('pausedDL', 0.5)).toBe('paused');
    expect(torrentStatus('stoppedDL', 0.5)).toBe('paused');
    expect(torrentStatus('stoppedUP', 1)).toBe('done');
    expect(torrentStatus('stalledUP', 1)).toBe('seeding');
    expect(torrentStatus('stalledDL', 0.1)).toBe('stalled');
    expect(torrentStatus('metaDL', 0)).toBe('metadata');
    expect(torrentStatus('missingFiles', 1)).toBe('error');
    expect(torrentStatus('somethingNew', 1)).toBe('done');
    expect(canResume({ state: 'pausedUP' })).toBe(true);
    expect(canResume({ state: 'stoppedDL' })).toBe(true);
    expect(canResume({ state: 'downloading' })).toBe(false);
  });

  it('finds the save folder on the server', () => {
    expect(hostDirOf('/downloads', '/downloads', '/home/me/torrents')).toBe('/home/me/torrents');
    expect(hostDirOf('/downloads/movies/', '/downloads', '/home/me/torrents')).toBe('/home/me/torrents/movies');
    expect(hostDirOf('/downloadsX', '/downloads', '/home/me/torrents')).toBe(null);
    expect(hostDirOf('/downloads', '/downloads', '')).toBe(null);
  });

  it('reads a torrent from the API', () => {
    const t = toTorrent({ hash: 'a'.repeat(40), name: 'ubuntu.iso', size: 1000, completed: 250, progress: 0.25, dlspeed: 50, upspeed: 0, eta: 8_640_000, state: 'downloading', num_seeds: 4, num_leechs: 2, ratio: 0.1234, added_on: 1_763_000_000, save_path: '/downloads/' });
    expect(t).toMatchObject({ done: 250, progress: 0.25, etaSec: null, status: 'downloading', ratio: 0.12, addedAt: new Date(1_763_000_000_000).toISOString() });
    expect(toTorrent({ progress: 0.5, eta: 120, state: 'downloading', size: 10 }).etaSec).toBe(120);
  });

  it('takes magnets and .torrent links, one a line', () => {
    expect(cleanTorrentLinks(' magnet:?xt=urn:btih:abc&dn=x \n\nhttps://e.com/a.torrent')).toEqual(['magnet:?xt=urn:btih:abc&dn=x', 'https://e.com/a.torrent']);
    for (const bad of ['', 'magnet:?dn=no-hash', 'just words', 42]) expect(() => cleanTorrentLinks(bad)).toThrow();
  });

  it('takes info hashes only', () => {
    expect(cleanHashes(['a'.repeat(40), 'b'.repeat(64)])).toBe(`${'a'.repeat(40)}|${'b'.repeat(64)}`);
    for (const bad of [[], ['xyz'], ['a'.repeat(40) + '|all'], 'a'.repeat(40), null]) expect(() => cleanHashes(bad)).toThrow();
  });
});
