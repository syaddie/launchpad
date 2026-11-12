import { describe, expect, it } from 'vitest';
import { dockerRequestAllowed, isOwnContainer, parseDockerLogs, restartPath, sinceParam, toContainers } from '../server/src/docker';
import { parseScan, parseSmart, sudoProblem } from '../server/src/disks';
import { cleanSnippet, cleanSnippets } from '../server/src/clean';
import { newLines } from '../web/src/components/Containers';
import { powerOnText } from '../web/src/components/Disks';
import { MAX_TABS, nextName, readTabs } from '../web/src/components/Terminal';
import type { ContainerInfo, LogLine } from '../shared/types';

const ID = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);

describe('docker: restart only', () => {
  it('lets through the list, logs and a restart', () => {
    expect(dockerRequestAllowed('GET', '/containers/json?all=1')).toBe(true);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&tail=500`)).toBe(true);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/logs?stdout=1&stderr=1&timestamps=1&tail=500&since=1762920000.123456789`)).toBe(true);
    expect(dockerRequestAllowed('POST', `/containers/${ID}/restart?t=10`)).toBe(true);
  });

  it('refuses every other write', () => {
    for (const action of ['start', 'stop', 'kill', 'pause', 'unpause', 'exec', 'update', 'rename', 'attach', 'wait', 'resize']) {
      expect(dockerRequestAllowed('POST', `/containers/${ID}/${action}`)).toBe(false);
    }
    expect(dockerRequestAllowed('POST', '/containers/create')).toBe(false);
    expect(dockerRequestAllowed('POST', '/containers/prune')).toBe(false);
    expect(dockerRequestAllowed('DELETE', `/containers/${ID}`)).toBe(false);
    expect(dockerRequestAllowed('DELETE', `/containers/${ID}?force=1`)).toBe(false);
    expect(dockerRequestAllowed('PUT', `/containers/${ID}/archive`)).toBe(false);
    expect(dockerRequestAllowed('POST', `/exec/${ID}/start`)).toBe(false);
    expect(dockerRequestAllowed('POST', '/images/create?fromImage=x')).toBe(false);
    expect(dockerRequestAllowed('POST', '/build')).toBe(false);
    // A restart is a POST, never a GET or anything else.
    expect(dockerRequestAllowed('GET', `/containers/${ID}/restart`)).toBe(false);
    expect(dockerRequestAllowed('DELETE', `/containers/${ID}/restart`)).toBe(false);
  });

  it('refuses reads it has no use for, and tricks with the path', () => {
    expect(dockerRequestAllowed('GET', `/containers/${ID}/attach/ws?stdin=1`)).toBe(false);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/json`)).toBe(false);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/archive?path=/etc`)).toBe(false);
    expect(dockerRequestAllowed('GET', '/info')).toBe(false);
    expect(dockerRequestAllowed('POST', `/containers/${ID}/restart/../stop`)).toBe(false);
    expect(dockerRequestAllowed('POST', `/containers/${ID}/../create`)).toBe(false);
    expect(dockerRequestAllowed('POST', `/containers/${ID}%2F..%2Fcreate/restart`)).toBe(false);
    expect(dockerRequestAllowed('POST', `/v1.45/containers/${ID}/restart`)).toBe(false);
    expect(dockerRequestAllowed('POST', '/containers/launchpad/restart')).toBe(false);
    expect(dockerRequestAllowed('POST', `/containers/${ID}/restart?t=10&signal=KILL`)).toBe(false);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/logs?tail=10&follow=1`)).toBe(false);
    expect(dockerRequestAllowed('GET', `/containers/${ID}/logs?tail=10#x`)).toBe(false);
  });

  const list: ContainerInfo[] = [
    { id: ID, name: 'grafana', image: 'grafana', state: 'running', status: 'Up 2 days', self: false },
    { id: OTHER, name: 'launchpad', image: 'ghcr.io/syaddie/launchpad', state: 'running', status: 'Up 3 hours', self: true },
  ];

  it('restarts only a container in the list, and not Launchpad itself', () => {
    expect(restartPath(ID, list)).toBe(`/containers/${ID}/restart?t=10`);
    expect(dockerRequestAllowed('POST', restartPath(ID, list))).toBe(true);
    expect(() => restartPath(OTHER, list)).toThrow('Launchpad itself');
    expect(() => restartPath('c'.repeat(64), list)).toThrow('no such container');
    for (const bad of ['grafana', ID.slice(0, 12), ID + '/../create', '', null, 42, ID.toUpperCase()]) expect(() => restartPath(bad, list)).toThrow('isn’t a container id');
  });

  it('knows its own container', () => {
    expect(isOwnContainer(OTHER, OTHER)).toBe(true);
    expect(isOwnContainer(ID, OTHER)).toBe(false);
    // Without the mount to go by, the hostname Docker gives a container.
    expect(isOwnContainer(ID, null, ID.slice(0, 12))).toBe(true);
    expect(isOwnContainer(ID, null, 'myserver')).toBe(false);
    expect(toContainers([{ Id: OTHER, Names: ['/launchpad'], State: 'running' }], (id) => id === OTHER)[0]).toMatchObject({ id: OTHER, name: 'launchpad', self: true });
  });
});

/** A frame of Docker's log stream: stdout (1) or stderr (2), its length, then the text. */
const frame = (stream: 1 | 2, text: string) => {
  const body = Buffer.from(text);
  const head = Buffer.alloc(8);
  head[0] = stream;
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('docker: logs', () => {
  it('splits stdout and stderr frames into lines with timestamps', () => {
    const buf = Buffer.concat([
      frame(1, '2026-11-12T03:04:05.123456789Z listening on :8080\n'),
      frame(2, '2026-11-12T03:04:06.5Z \x1b[31mwarn\x1b[0m disk slow\n'),
      frame(1, '2026-11-12T03:04:07.000000001Z half a '),
      frame(1, 'line\n'),
    ]);
    expect(parseDockerLogs(buf)).toEqual<LogLine[]>([
      { at: '2026-11-12T03:04:05.123456789Z', stream: 'out', text: 'listening on :8080' },
      { at: '2026-11-12T03:04:06.500000000Z', stream: 'err', text: 'warn disk slow' },
      { at: '2026-11-12T03:04:07.000000001Z', stream: 'out', text: 'half a line' },
    ]);
  });

  it('reads a container with a terminal, which sends plain text', () => {
    const buf = Buffer.from('2026-11-12T03:04:05Z one\r\n2026-11-12T03:04:06Z 10%\r50%\r100%\r\n');
    expect(parseDockerLogs(buf)).toEqual<LogLine[]>([
      { at: '2026-11-12T03:04:05.000000000Z', stream: 'out', text: 'one' },
      { at: '2026-11-12T03:04:06.000000000Z', stream: 'out', text: '100%' },
    ]);
    expect(parseDockerLogs(Buffer.alloc(0))).toEqual([]);
  });

  it('asks Docker for lines since one it has', () => {
    expect(sinceParam('2026-11-12T03:04:05.123456789Z')).toBe(`${Date.UTC(2026, 10, 12, 3, 4, 5) / 1000}.123456789`);
    for (const bad of ['2026-11-12T03:04:05Z', 'yesterday', 12, undefined, '2026-11-12T03:04:05.1Z&follow=1']) expect(sinceParam(bad)).toBeNull();
  });

  it('adds only new lines when following', () => {
    const at = (s: number) => `2026-11-12T03:04:0${s}.000000000Z`;
    const have: LogLine[] = [
      { at: at(1), stream: 'out', text: 'a' },
      { at: at(2), stream: 'out', text: 'b' },
    ];
    const got: LogLine[] = [
      { at: at(2), stream: 'out', text: 'b' },
      { at: at(2), stream: 'err', text: 'b too' },
      { at: at(3), stream: 'out', text: 'c' },
    ];
    expect(newLines(have, got).map((l) => l.text)).toEqual(['b too', 'c']);
    expect(newLines([], got)).toBe(got);
  });
});

// Trimmed from real `smartctl -j -a` output (smartmontools 7.4).
const SATA_SSD = {
  smartctl: { version: [7, 4], exit_status: 0 },
  device: { name: '/dev/sda', type: 'sat', protocol: 'ATA' },
  model_name: 'Samsung SSD 870 EVO 1TB',
  serial_number: 'S6PNNX0T123456',
  user_capacity: { blocks: 1953525168, bytes: 1000204886016 },
  rotation_rate: 0,
  smart_status: { passed: true },
  ata_smart_attributes: {
    table: [
      { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, when_failed: '', raw: { value: 0, string: '0' } },
      { id: 9, name: 'Power_On_Hours', value: 97, worst: 97, thresh: 0, when_failed: '', raw: { value: 10512, string: '10512' } },
      { id: 194, name: 'Temperature_Celsius', value: 66, worst: 50, thresh: 0, when_failed: '', raw: { value: 34, string: '34 (Min/Max 18/50)' } },
      { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, when_failed: '', raw: { value: 0, string: '0' } },
      { id: 198, name: 'Offline_Uncorrectable', value: 100, worst: 100, thresh: 0, when_failed: '', raw: { value: 0, string: '0' } },
    ],
  },
  power_on_time: { hours: 10512 },
  temperature: { current: 34 },
};

const OLD_HDD = {
  smartctl: { exit_status: 8 },
  device: { name: '/dev/sdb', type: 'sat', protocol: 'ATA' },
  model_name: 'WDC WD40EFRX-68N32N0',
  user_capacity: { bytes: 4000787030016 },
  rotation_rate: 5400,
  smart_status: { passed: false },
  ata_smart_attributes: {
    table: [
      { id: 1, name: 'Raw_Read_Error_Rate', value: 1, worst: 1, thresh: 51, when_failed: 'now', raw: { value: 4211 } },
      { id: 5, name: 'Reallocated_Sector_Ct', value: 180, worst: 180, thresh: 140, when_failed: '', raw: { value: 312 } },
      { id: 197, name: 'Current_Pending_Sector', value: 200, worst: 200, thresh: 0, when_failed: '', raw: { value: 1 } },
      { id: 198, name: 'Offline_Uncorrectable', value: 200, worst: 200, thresh: 0, when_failed: 'past', raw: { value: 0 } },
    ],
  },
  power_on_time: { hours: 52000 },
  temperature: { current: 57 },
};

const NVME = {
  smartctl: { exit_status: 0 },
  device: { name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' },
  model_name: 'WD Blue SN570 1TB',
  nvme_total_capacity: 1000204886016,
  smart_status: { passed: true },
  nvme_smart_health_information_log: {
    critical_warning: 0,
    temperature: 41,
    available_spare: 100,
    available_spare_threshold: 10,
    percentage_used: 84,
    data_units_written: 52812345,
    power_on_hours: 8760,
    media_errors: 0,
    num_err_log_entries: 2,
  },
  temperature: { current: 41 },
  power_on_time: { hours: 8760 },
};

describe('disks: SMART', () => {
  it('reads a healthy SATA SSD', () => {
    expect(parseSmart(SATA_SSD)).toEqual({
      name: '/dev/sda',
      model: 'Samsung SSD 870 EVO 1TB',
      serial: 'S6PNNX0T123456',
      capacityBytes: 1000204886016,
      kind: 'ssd',
      passed: true,
      tempC: 34,
      powerOnHours: 10512,
      reallocated: 0,
      pending: 0,
      uncorrectable: 0,
      percentUsed: null,
      mediaErrors: null,
      availableSpare: null,
      level: 'good',
      problems: [],
      error: null,
    });
  });

  it('flags a failing hard disk, with what’s wrong', () => {
    const d = parseSmart(OLD_HDD);
    expect(d.kind).toBe('hdd');
    expect(d.level).toBe('bad');
    expect(d.reallocated).toBe(312);
    expect(d.problems).toEqual([
      'SMART says this disk is failing. Back it up and replace it.',
      'Raw Read Error Rate is below the maker’s limit.',
      '312 sectors reallocated.',
      '1 sector waiting to be reallocated.',
      'Offline Uncorrectable fell below the maker’s limit once.',
      'Running hot at 57 °C.',
    ]);
    // Exit status 8 says the disk is failing; that's not a failure to read it.
    expect(d.error).toBeNull();
  });

  it('reads NVMe wear, spare and media errors', () => {
    const d = parseSmart(NVME);
    expect(d).toMatchObject({ kind: 'nvme', tempC: 41, powerOnHours: 8760, percentUsed: 84, mediaErrors: 0, availableSpare: 100, reallocated: null, level: 'warn' });
    expect(d.problems).toEqual(['84% of its rated write endurance is used.']);
    const log = NVME.nvme_smart_health_information_log;
    expect(parseSmart({ ...NVME, nvme_smart_health_information_log: { ...log, critical_warning: 4, available_spare: 5, media_errors: 3, percentage_used: 101 } }).problems).toEqual([
      'The drive reports a critical warning.',
      'Spare blocks are down to 5%, below the drive’s limit of 10%.',
      'It’s past its rated write endurance.',
      '3 media errors logged.',
    ]);
    expect(parseSmart({ ...NVME, temperature: { current: 74 } }).problems).toContain('Running hot at 74 °C.');
  });

  it('says when smartctl couldn’t open a disk', () => {
    const d = parseSmart({ smartctl: { exit_status: 2, messages: [{ string: '/dev/sdc: Unknown USB bridge [0x1234:0x5678]', severity: 'error' }] } }, '/dev/sdc');
    expect(d).toMatchObject({ name: '/dev/sdc', level: 'unknown', error: '/dev/sdc: Unknown USB bridge [0x1234:0x5678]' });
    expect(parseSmart({}, '/dev/sdd').level).toBe('unknown');
  });

  it('finds the disks, keeping odd names out of the command line', () => {
    const scan = {
      devices: [
        { name: '/dev/sda', info_name: '/dev/sda [SAT]', type: 'sat', protocol: 'ATA' },
        { name: '/dev/nvme0', info_name: '/dev/nvme0', type: 'nvme', protocol: 'NVMe' },
        { name: '/dev/bus/0', type: 'megaraid,0' },
        { name: '/dev/sda', type: 'sat' },
        { name: '/dev/sdb; reboot', type: 'sat' },
        { name: '/etc/shadow', type: 'sat' },
        { name: '/dev/sdc', type: "sat' -s off '" },
      ],
    };
    expect(parseScan(scan)).toEqual([
      { name: '/dev/sda', type: 'sat' },
      { name: '/dev/nvme0', type: 'nvme' },
      { name: '/dev/bus/0', type: 'megaraid,0' },
    ]);
    expect(parseScan(null)).toEqual([]);
  });

  it('tells a missing sudoers rule from a missing smartctl', () => {
    expect(sudoProblem('sudo: a password is required\n')?.status).toBe('no-sudo');
    expect(sudoProblem('Sorry, user syaddy is not allowed to execute \'/usr/sbin/smartctl --scan -j\' as root on box.\n')?.status).toBe('no-sudo');
    expect(sudoProblem('sudo: /usr/sbin/smartctl: command not found\n')?.status).toBe('no-smartctl');
    // sudo-rs, Ubuntu's sudo from 25.10.
    expect(sudoProblem('sudo: interactive authentication is required\n')?.status).toBe('no-sudo');
    expect(sudoProblem("sudo: I'm sorry syaddy. I'm afraid I can't do that\n")?.status).toBe('no-sudo');
    expect(sudoProblem("sudo: '/usr/sbin/smartctl': command not found\n")?.status).toBe('no-smartctl');
    expect(sudoProblem('')).toBeNull();
  });

  it('writes power-on time in plain words', () => {
    expect([5, 100, 2000, 10512, 52000].map(powerOnText)).toEqual(['5 h', '4 days', '3 months', '1.2 years', '5.9 years']);
  });
});

describe('terminal snippets', () => {
  it('keeps a name and a command', () => {
    expect(cleanSnippet({ name: '  Disk usage ', command: 'df -h\r\n' }, 'x1')).toEqual({ id: 'x1', name: 'Disk usage', command: 'df -h' });
    expect(cleanSnippet({ name: 'Two lines', command: 'cd /srv\r\nls -la' }, 'x2')?.command).toBe('cd /srv\nls -la');
    expect(cleanSnippet({ name: '', command: 'ls' }, 'x')).toBeNull();
    expect(cleanSnippet({ name: 'x', command: '   ' }, 'x')).toBeNull();
    expect(cleanSnippet({ name: 'x' }, 'x')).toBeNull();
    expect(cleanSnippet({ name: 'n'.repeat(200), command: 'c'.repeat(5000) }, 'x')).toMatchObject({ name: 'n'.repeat(80), command: 'c'.repeat(4000) });
  });

  it('drops snippets without an id of their own', () => {
    expect(cleanSnippets([{ id: 'a', name: 'A', command: 'a' }, { id: 'a', name: 'Again', command: 'b' }, { id: 'b/../c', name: 'B', command: 'b' }, { name: 'C', command: 'c' }, null]).map((s) => s.id)).toEqual(['a']);
    expect(cleanSnippets('nope')).toEqual([]);
  });
});

describe('terminal tabs', () => {
  it('names a new tab with the lowest free number', () => {
    expect(nextName([])).toBe('Shell 1');
    expect(nextName([{ name: 'Shell 1' }, { name: 'Shell 3' }])).toBe('Shell 2');
    expect(nextName([{ name: 'logs' }])).toBe('Shell 1');
  });

  it('picks up the tabs saved in this browser tab, or the one shell from before tabs', () => {
    const saved = JSON.stringify({ tabs: [{ key: 'k1', name: 'build', session: 's1' }, { key: 'k2', name: 'Shell 2', session: null }], active: 'k2' });
    expect(readTabs(saved, 'old')).toEqual({ tabs: [{ key: 'k1', name: 'build', session: 's1' }, { key: 'k2', name: 'Shell 2', session: null }], active: 'k2' });
    expect(readTabs(JSON.stringify({ tabs: [{ key: 'k1', name: 'a', session: 5 }], active: 'gone' }), null)).toEqual({ tabs: [{ key: 'k1', name: 'a', session: null }], active: 'k1' });
    const fresh = readTabs(null, 'old-session');
    expect(fresh.tabs).toEqual([{ key: fresh.active, name: 'Shell 1', session: 'old-session' }]);
    expect(readTabs('{broken', null).tabs[0].session).toBeNull();
    const many = JSON.stringify({ tabs: Array.from({ length: 20 }, (_, i) => ({ key: `k${i}`, name: `t${i}`, session: null })), active: 'k0' });
    expect(readTabs(many, null).tabs).toHaveLength(MAX_TABS);
  });
});
