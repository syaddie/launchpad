import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { askPing, dashed, metersScript, parseJsonList, parseList, parseMeters, parsePing, parseTps, pingRequest, playerCommand, readPingResponse, readVarint, varint } from '../server/src/mc-players';
import { fmtUptime, lineLevel, meterParts } from '../web/src/components/Minecraft';
import { headUrl } from '../web/src/components/McPlayers';
import type { McMeters } from '../shared/types';

const STEVE = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

/** A status response packet, the way a server writes it. */
function statusPacket(json: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(json));
  const data = Buffer.concat([varint(0), varint(body.length), body]);
  return Buffer.concat([varint(data.length), data]);
}

describe('Server List Ping', () => {
  it('writes and reads varints, -1 included', () => {
    for (const n of [0, 1, 127, 128, 255, 25565, 2097151, 2147483647]) expect(readVarint(varint(n), 0)).toEqual({ value: n, size: varint(n).length });
    expect(varint(-1)).toEqual(Buffer.from([0xff, 0xff, 0xff, 0xff, 0x0f]));
    expect(readVarint(Buffer.from([0x80]), 0)).toBeNull();
  });
  it('asks with a handshake for status, then the status request', () => {
    const req = pingRequest('127.0.0.1', 25565);
    const len = readVarint(req, 0)!;
    const hs = req.subarray(len.size, len.size + len.value);
    expect(hs[0]).toBe(0x00);
    expect(hs.subarray(hs.length - 3)).toEqual(Buffer.from([0x63, 0xdd, 0x01]));
    expect(req.subarray(len.size + len.value)).toEqual(Buffer.from([0x01, 0x00]));
  });
  it('waits for the whole answer', () => {
    const p = statusPacket({ players: { online: 1, max: 20 } });
    expect(readPingResponse(p.subarray(0, 5))).toBeNull();
    expect(readPingResponse(p)).toEqual({ players: { online: 1, max: 20 } });
    expect(() => readPingResponse(Buffer.from([0x02, 0x05, 0x00]))).toThrow();
  });
  it('keeps real players and drops hidden ones and lines of text', () => {
    const p = parsePing({
      version: { name: '§6Paper 1.21.1' },
      players: { online: 3, max: 20, sample: [{ name: 'Steve', id: STEVE }, { name: 'Anonymous Player', id: '00000000-0000-0000-0000-000000000000' }, { name: '§aWelcome!', id: '00000000-0000-0000-0000-000000000000' }] },
    });
    expect(p).toEqual({ online: 3, max: 20, sample: [{ name: 'Steve', uuid: STEVE }], version: 'Paper 1.21.1' });
    expect(parsePing(null)).toEqual({ online: 0, max: 0, sample: [], version: null });
  });
  it('puts dashes into a bare uuid', () => {
    expect(dashed(STEVE.replace(/-/g, ''))).toBe(STEVE);
    expect(dashed('nope')).toBeNull();
  });

  // A pretend server that answers in two pieces, as a real one may.
  let server: net.Server;
  let port = 0;
  beforeAll(async () => {
    server = net.createServer((sock) => {
      sock.once('data', () => {
        const p = statusPacket({ version: { name: '1.21.1' }, players: { online: 2, max: 10, sample: [{ name: 'Alex', id: STEVE }] } });
        sock.write(p.subarray(0, 3));
        setTimeout(() => sock.write(p.subarray(3)), 20);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as net.AddressInfo).port;
  });
  afterAll(() => server.close());

  it('talks to a server', async () => {
    const sock = net.connect(port, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    expect(await askPing(sock, '127.0.0.1', port, 2000)).toEqual({ online: 2, max: 10, sample: [{ name: 'Alex', uuid: STEVE }], version: '1.21.1' });
  });
  it('gives up on a server that says nothing', async () => {
    const quiet = net.createServer(() => {});
    await new Promise<void>((r) => quiet.listen(0, '127.0.0.1', () => r()));
    const q = (quiet.address() as net.AddressInfo).port;
    const sock = net.connect(q, '127.0.0.1');
    await new Promise((r) => sock.once('connect', r));
    await expect(askPing(sock, '127.0.0.1', q, 200)).rejects.toThrow('didn’t answer');
    quiet.close();
  });
});

describe('the console’s list', () => {
  it('reads vanilla, Paper and Fabric', () => {
    expect(parseList(['Done (3.2s)! For help, type "help"', 'There are 2 of a max of 20 players online: Steve, Alex_99'])).toEqual({ online: 2, max: 20, names: ['Steve', 'Alex_99'] });
    expect(parseList(['There are 0 of a max of 20 players online: '])).toEqual({ online: 0, max: 20, names: [] });
    expect(parseList([`There are 1 of a max of 20 players online: Steve (${STEVE})`])?.names).toEqual(['Steve']);
  });
  it('reads older Bukkit, with names on the next line', () => {
    expect(parseList(['There are 2/20 players online:', 'Steve, Alex'])).toEqual({ online: 2, max: 20, names: ['Steve', 'Alex'] });
  });
  it('reads EssentialsX’s groups, tags and nicknames', () => {
    expect(parseList(['There are 3 out of maximum 20 players online.', 'Admins: [AFK]Steve', 'default: Alex, ~Notch'])).toEqual({ online: 3, max: 20, names: ['Steve', 'Alex', 'Notch'] });
  });
  it('takes the newest answer and nothing that isn’t a name', () => {
    expect(parseList(['There are 1 of a max of 20 players online: Old', 'There are 1 of a max of 20 players online: New'])?.names).toEqual(['New']);
    expect(parseList(['There are 1 of a max of 5 players online: bad name!'])?.names).toEqual([]);
    expect(parseList(['Unknown command'])).toBeNull();
  });
  it('reads ops.json and whitelist.json, skipping what doesn’t fit', () => {
    expect(parseJsonList(JSON.stringify([{ uuid: STEVE, name: 'Steve', level: 4 }, { name: 'x y' }, null]))).toEqual([{ name: 'Steve', uuid: STEVE }]);
    expect(parseJsonList('not json')).toEqual([]);
    expect(parseJsonList(null)).toEqual([]);
  });
});

describe('the player buttons', () => {
  it('build one console command from a checked name', () => {
    expect(playerCommand('kick', 'Steve')).toBe('kick Steve');
    expect(playerCommand('op', 'Steve')).toBe('op Steve');
    expect(playerCommand('deop', 'Steve')).toBe('deop Steve');
    expect(playerCommand('whitelist-add', '.BedrockGuy')).toBe('whitelist add .BedrockGuy');
    expect(playerCommand('whitelist-remove', 'Steve')).toBe('whitelist remove Steve');
    expect(playerCommand('tp', 'Steve', 'Alex')).toBe('tp Alex Steve');
  });
  it('refuse anything that could carry another command', () => {
    expect(() => playerCommand('kick', 'Steve; stop')).toThrow('name');
    expect(() => playerCommand('kick', 'Steve stop')).toThrow('name');
    expect(() => playerCommand('kick', '')).toThrow('name');
    expect(() => playerCommand('ban', 'Steve')).toThrow('doesn’t know');
    expect(() => playerCommand('tp', 'Steve')).toThrow('who');
    expect(() => playerCommand('tp', 'Steve', 'steve')).toThrow('someone else');
  });
  it('show heads by id, or by name when there’s no id', () => {
    expect(headUrl({ name: 'Steve', uuid: STEVE })).toBe('https://mc-heads.net/avatar/069a79f444e94726a5befca90e38aaf5/32');
    expect(headUrl({ name: 'Steve', uuid: null })).toBe('https://mc-heads.net/avatar/Steve/32');
  });
});

describe('meters', () => {
  it('is valid shell', () => {
    const r = spawnSync('sh', ['-n'], { input: metersScript(1234) });
    if (!r.error) expect(r.stderr.toString()).toBe('');
  });
  it('works out CPU over the second between readings', () => {
    // 150 ticks of CPU at 100 a second, over one second, on 4 cores: 1.5 cores busy, 37.5%.
    const out = 'rss 2097152\nup 3700\na 1700000000000000000 1000 500\nb 1700000001000000000 1100 550\nhz 100\ncores 4\n';
    expect(parseMeters(out)).toEqual({ rss: 2097152 * 1024, cpu: 37.5, cores: 4, uptime: 3700 });
  });
  it('falls back to the second it slept when date has no nanoseconds', () => {
    expect(parseMeters('rss 1024\nup 10\na 1700000000N 0 0\nb 1700000001N 50 0\nhz 100\ncores 1\n')?.cpu).toBe(50);
  });
  it('knows when the process has gone', () => {
    expect(parseMeters('gone\n')).toBeNull();
  });
  it('reads TPS from Spark, Paper and vanilla', () => {
    const spark = ['[⚡] TPS from last 5s, 10s, 1m, 5m, 15m:', '[⚡]  *20.0, 19.8, 19.9, 20.0, 20.0', '[⚡] ', '[⚡] Tick durations (min/med/95%ile/max ms) from last 10s, 1m:', '[⚡]  0.5/1.1/2.3/14.1;  0.4/1.0/2.1/20.3'];
    expect(parseTps(spark, 'spark')).toEqual({ tps: 20, mspt: 1.1 });
    expect(parseTps(['TPS from last 1m, 5m, 15m: 19.5, 19.9, 20.0'], 'paper')).toEqual({ tps: 19.5, mspt: null });
    expect(parseTps(['Server tick times (avg/min/max) from last 5s, 10s, 1m:', '◴ 1.4/0.9/5.6, 1.3/0.8/5.6, 1.2/0.7/12.0'], 'paper').mspt).toBe(1.4);
    expect(parseTps(['The game is running normally', 'Target tick rate: 20.0 per second.', 'Average time per tick: 0.8ms (Target: 50.0ms)'], 'vanilla')).toEqual({ tps: 20, mspt: 0.8 });
    expect(parseTps(['Target tick rate: 20.0 per second.', 'Average time per tick: 80.0ms (Target: 50.0ms)'], 'vanilla')).toEqual({ tps: 12.5, mspt: 80 });
    expect(parseTps(['Unknown or incomplete command, see below for error'], 'vanilla')).toEqual({ tps: null, mspt: null });
  });
  it('show only what’s known, never a 0 for unknown', () => {
    const m: McMeters = { running: true, rss: 1.5 * 1024 ** 3, cpu: 12.34, cores: 4, uptime: 4000, online: 2, max: 20, tps: null, mspt: null, tpsFrom: null, tpsAt: null, at: 0 };
    expect(meterParts(m).map((p) => p.text)).toEqual(['1.5 GB', 'CPU 12%', '2/20 online', 'up 1 h 6 min']);
    const tps = meterParts({ ...m, tps: 15.2, mspt: 65.8, tpsFrom: 'paper', tpsAt: Date.now() });
    expect(tps.map((p) => p.text)).toContain('15.2 TPS');
    expect(tps.find((p) => p.text === '15.2 TPS')?.warn).toBe(true);
    expect(tps.find((p) => p.text === '66 ms/tick')?.warn).toBe(true);
    expect(meterParts({ ...m, rss: null, cpu: null, online: null, uptime: null })).toEqual([]);
    expect(meterParts({ ...m, running: false })).toEqual([]);
    expect(meterParts(null)).toEqual([]);
  });
  it('say how long it has been up', () => {
    expect(fmtUptime(30)).toBe('1 min');
    expect(fmtUptime(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(fmtUptime(3 * 86400 + 4 * 3600)).toBe('3 d 4 h');
  });
  it('show Launchpad’s own TPS questions quieter in the console', () => {
    expect(lineLevel('[12:00:00 INFO]: TPS from last 1m, 5m, 15m: 20.0, 20.0, 20.0')).toBe('quiet');
    expect(lineLevel('[12:00:00 INFO]: [⚡] TPS from last 5s, 10s, 1m, 5m, 15m:')).toBe('quiet');
    expect(lineLevel('Average time per tick: 0.8ms (Target: 50.0ms)')).toBe('quiet');
    expect(lineLevel('[12:00:00] [Server thread/INFO]: There are 0 of a max of 20 players online: ')).toBe('');
    expect(lineLevel('[12:00:00] [Server thread/WARN]: TPS from last')).toBe('warn');
  });
});
