// The disks' SMART health for the Server view. smartctl needs root, so it runs over
// the same SSH connection as the terminal, through a sudoers rule that allows just
// smartctl (docs/setup.md, step 10). SMART changes slowly: the result is kept for
// 30 minutes, and the view's refresh button reads it again.
import { shellConfigured, runCommand, shellQuote } from './shell';
import type { DiskHealth, DisksReport } from '../../shared/types';

const SMARTCTL = '/usr/sbin/smartctl';
export const DISKS_EVERY = 30 * 60_000;

/** smartctl's JSON, which differs by disk type and version; every field is checked as it's read. */
type Json = any;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The disks `smartctl --scan -j` found, with the type to read each as (sat, nvme, scsi…). */
export function parseScan(json: Json): { name: string; type: string }[] {
  const list: Json[] = Array.isArray(json?.devices) ? json.devices : [];
  const seen = new Set<string>();
  return list.flatMap((d) => {
    const name = str(d?.name);
    const type = str(d?.type) ?? 'auto';
    // Only plain device paths and types go into the command line.
    if (!name || !/^\/dev\/[A-Za-z0-9_/-]+$/.test(name) || !/^[A-Za-z0-9,_+-]+$/.test(type) || seen.has(name)) return [];
    seen.add(name);
    return [{ name, type }];
  });
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** One disk from `smartctl -j -a`: the numbers worth showing, and what's worrying about them. */
export function parseSmart(json: Json, name = str(json?.device?.name) ?? '?'): DiskHealth {
  const log = json?.nvme_smart_health_information_log;
  const nvme = !!log || json?.device?.type === 'nvme' || json?.device?.protocol === 'NVMe';
  const rotation = num(json?.rotation_rate);
  const attrs: Json[] = Array.isArray(json?.ata_smart_attributes?.table) ? json.ata_smart_attributes.table : [];
  const raw = (id: number) => num(attrs.find((a) => a?.id === id)?.raw?.value);

  const d: DiskHealth = {
    name,
    model: str(json?.model_name) ?? str(json?.scsi_model_name),
    serial: str(json?.serial_number),
    capacityBytes: num(json?.user_capacity?.bytes) ?? num(json?.nvme_total_capacity),
    kind: nvme ? 'nvme' : rotation === 0 ? 'ssd' : rotation ? 'hdd' : 'unknown',
    passed: typeof json?.smart_status?.passed === 'boolean' ? json.smart_status.passed : null,
    tempC: num(json?.temperature?.current) ?? num(log?.temperature),
    powerOnHours: num(json?.power_on_time?.hours) ?? num(log?.power_on_hours),
    reallocated: nvme ? null : raw(5),
    pending: nvme ? null : raw(197),
    uncorrectable: nvme ? null : raw(198),
    percentUsed: num(log?.percentage_used),
    mediaErrors: num(log?.media_errors),
    availableSpare: num(log?.available_spare),
    level: 'good',
    problems: [],
    error: null,
  };

  const bad: string[] = [];
  const warn: string[] = [];
  if (d.passed === false) bad.push('SMART says this disk is failing. Back it up and replace it.');
  if (num(log?.critical_warning)) bad.push('The drive reports a critical warning.');
  const spareMin = num(log?.available_spare_threshold);
  if (d.availableSpare !== null && spareMin !== null && d.availableSpare < spareMin) bad.push(`Spare blocks are down to ${d.availableSpare}%, below the drive’s limit of ${spareMin}%.`);
  if (d.percentUsed !== null && d.percentUsed >= 100) bad.push('It’s past its rated write endurance.');
  else if (d.percentUsed !== null && d.percentUsed >= 80) warn.push(`${d.percentUsed}% of its rated write endurance is used.`);
  if (d.mediaErrors) warn.push(`${plural(d.mediaErrors, 'media error')} logged.`);
  if (d.reallocated) warn.push(`${plural(d.reallocated, 'sector')} reallocated.`);
  if (d.pending) warn.push(`${plural(d.pending, 'sector')} waiting to be reallocated.`);
  if (d.uncorrectable) warn.push(`${plural(d.uncorrectable, 'sector')} that couldn’t be read.`);
  for (const a of attrs) {
    const label = String(a?.name ?? `attribute ${a?.id}`).replace(/_/g, ' ');
    if (a?.when_failed === 'now') bad.push(`${label} is below the maker’s limit.`);
    else if (a?.when_failed === 'past') warn.push(`${label} fell below the maker’s limit once.`);
  }
  if (d.tempC !== null && d.tempC >= (nvme ? 70 : 55)) warn.push(`Running hot at ${d.tempC} °C.`);

  d.problems = [...bad, ...warn];
  d.level = bad.length ? 'bad' : warn.length ? 'warn' : d.passed === null && d.tempC === null && d.powerOnHours === null ? 'unknown' : 'good';

  // smartctl's own complaint when it couldn't read the disk at all (bit 1 of its exit status: the device didn't open).
  const exit = num(json?.smartctl?.exit_status) ?? 0;
  if (exit & 3) {
    const msgs: Json[] = Array.isArray(json?.smartctl?.messages) ? json.smartctl.messages : [];
    d.error = msgs.map((m) => str(m?.string)).filter(Boolean).join(' ') || 'smartctl couldn’t read this disk.';
    d.level = 'unknown';
  }
  return d;
}

/** What went wrong running smartctl through sudo, as the status the page explains. */
export function sudoProblem(stderr: string): { status: DisksReport['status']; message: string } | null {
  if (/command not found/i.test(stderr)) return { status: 'no-smartctl', message: 'smartctl isn’t installed on the server.' };
  // Classic sudo's wording, then sudo-rs's (Ubuntu's sudo from 25.10).
  if (/password is required|not allowed to (execute|run)|may not run sudo|not in the sudoers|terminal is required|interactive authentication is required|afraid I can.t do that/i.test(stderr)) {
    return { status: 'no-sudo', message: 'The sudoers rule for smartctl isn’t there yet, so sudo asked for a password.' };
  }
  return null;
}

const json = (text: string): Json => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

async function readDisks(): Promise<DisksReport> {
  const at = new Date().toISOString();
  if (!shellConfigured()) return { at, status: 'no-ssh', message: 'Disk health reads SMART over the terminal’s SSH connection, which is off.', disks: [] };
  let scan: Awaited<ReturnType<typeof runCommand>>;
  try {
    scan = await runCommand(`sudo -n ${SMARTCTL} --scan -j`);
  } catch (e) {
    return { at, status: 'error', message: (e as Error).message, disks: [] };
  }
  const problem = sudoProblem(scan.stderr);
  if (problem) return { at, ...problem, disks: [] };
  const devices = parseScan(json(scan.stdout));
  if (!devices.length) {
    return { at, status: 'error', message: scan.stderr.trim() || (json(scan.stdout) ? 'smartctl found no disks. Disks behind a RAID card or some USB enclosures don’t show up.' : 'smartctl’s answer wasn’t JSON. It needs smartmontools 7.0 or later.'), disks: [] };
  }
  const disks: DiskHealth[] = [];
  for (const dev of devices) {
    try {
      const r = await runCommand(`sudo -n ${SMARTCTL} -j -a -d ${shellQuote(dev.type)} ${shellQuote(dev.name)}`);
      const p = sudoProblem(r.stderr);
      if (p) return { at, ...p, disks: [] };
      const j = json(r.stdout);
      disks.push(j ? parseSmart(j, dev.name) : { ...parseSmart({}, dev.name), level: 'unknown', error: r.stderr.trim() || 'smartctl’s answer wasn’t JSON.' });
    } catch (e) {
      disks.push({ ...parseSmart({}, dev.name), level: 'unknown', error: (e as Error).message });
    }
  }
  return { at, status: 'ok', message: null, disks };
}

let cached: DisksReport | null = null;
let reading: Promise<DisksReport> | null = null;

/** The disks' health, read again when it's over 30 minutes old or when asked (`force`). */
export function diskHealth(force = false): Promise<DisksReport> {
  if (!force && cached?.at && Date.now() - Date.parse(cached.at) < DISKS_EVERY) return Promise.resolve(cached);
  reading ??= readDisks()
    .then((r) => (cached = r))
    .finally(() => (reading = null));
  return reading;
}
