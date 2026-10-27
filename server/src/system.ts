// Health of the machine Launchpad runs on, for the Server view. CPU, memory,
// load and uptime come from the kernel and describe the whole host even inside
// Docker. Network traffic needs the host's /proc mounted at HOST_PROC (otherwise
// only the container's own traffic is visible), and the container list needs
// DOCKER_HOST pointing at a Docker socket or a read-only socket proxy.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config } from './config';
import type { ContainerInfo, ServerStats } from '../../shared/types';

const SAMPLE_EVERY = 5_000;
const KEEP = 60;

interface NetCounters { rx: number; tx: number }

/** /proc/net/dev → bytes received and sent per interface. */
export function parseNetDev(text: string): Map<string, NetCounters> {
  const out = new Map<string, NetCounters>();
  for (const line of text.split('\n').slice(2)) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m) continue;
    const f = m[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) out.set(m[1], { rx: f[0], tx: f[8] });
  }
  return out;
}

/** Interfaces worth showing: no loopback or Docker plumbing. */
export function isPhysical(name: string): boolean {
  return !/^(lo|docker\d*|veth|br-|virbr|ifb|tun|tap|wg|tailscale|zt|cni|flannel|cali)/.test(name);
}

function netDevPath(): { file: string; host: boolean } {
  const hostProc = config.hostProc;
  // PID 1 of the host's /proc is in the host's network namespace.
  if (hostProc && hostProc !== '/proc' && fs.existsSync(path.join(hostProc, '1/net/dev'))) return { file: path.join(hostProc, '1/net/dev'), host: true };
  return { file: '/proc/net/dev', host: false };
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function readTemp(): number | null {
  // Prefer the CPU package sensor; fall back to the first thermal zone with a sane reading.
  const zones = '/sys/class/thermal';
  let best: { score: number; c: number } | null = null;
  try {
    for (const z of fs.readdirSync(zones).filter((d) => d.startsWith('thermal_zone'))) {
      const type = fs.readFileSync(path.join(zones, z, 'type'), 'utf8').trim();
      const c = Number(fs.readFileSync(path.join(zones, z, 'temp'), 'utf8')) / 1000;
      if (!Number.isFinite(c) || c <= 0 || c > 130) continue;
      const score = /x86_pkg|cpu|soc|k10temp|coretemp/i.test(type) ? 2 : 1;
      if (!best || score > best.score) best = { score, c };
    }
  } catch {
    // No thermal zones visible (VMs, some containers).
  }
  return best ? Math.round(best.c) : null;
}

const samples: { at: number; cpuPct: number; net: Map<string, { rxBps: number; txBps: number }> }[] = [];
let lastCpu = cpuTimes();
let lastNet: { at: number; counters: Map<string, NetCounters> } | null = null;
let netHost = false;

function sample() {
  const now = Date.now();
  const cpu = cpuTimes();
  const dTotal = cpu.total - lastCpu.total;
  const cpuPct = dTotal > 0 ? Math.round((1 - (cpu.idle - lastCpu.idle) / dTotal) * 1000) / 10 : 0;
  lastCpu = cpu;

  const net = new Map<string, { rxBps: number; txBps: number }>();
  try {
    const src = netDevPath();
    netHost = src.host;
    const counters = parseNetDev(fs.readFileSync(src.file, 'utf8'));
    if (lastNet) {
      const secs = (now - lastNet.at) / 1000;
      for (const [name, c] of counters) {
        const p = lastNet.counters.get(name);
        // Counters reset when an interface restarts; skip that sample.
        if (p && c.rx >= p.rx && c.tx >= p.tx) net.set(name, { rxBps: (c.rx - p.rx) / secs, txBps: (c.tx - p.tx) / secs });
      }
    }
    lastNet = { at: now, counters };
  } catch {
    lastNet = null;
  }

  samples.push({ at: now, cpuPct, net });
  if (samples.length > KEEP) samples.shift();
}

let started = false;
export function startSampler(): void {
  if (started) return;
  started = true;
  sample();
  setInterval(sample, SAMPLE_EVERY).unref();
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirBytes(p) : fs.statSync(p).size;
    }
  } catch {
    // Missing folder: nothing stored yet.
  }
  return total;
}

function fileBytes(...files: string[]): number {
  return files.reduce((a, f) => {
    try {
      return a + fs.statSync(f).size;
    } catch {
      return a;
    }
  }, 0);
}

/** The interface with the most traffic over the samples we have, preferring real NICs. */
function busiest(names: string[]): string {
  const sum = (n: string) => samples.reduce((a, s) => a + (s.net.get(n)?.rxBps ?? 0) + (s.net.get(n)?.txBps ?? 0), 0);
  return [...names].sort((a, b) => sum(b) - sum(a))[0] ?? '';
}

// ---------- Docker ----------

/** GET a Docker Engine API path over DOCKER_HOST (unix:///var/run/docker.sock or tcp://host:2375). */
function docker<T>(apiPath: string): Promise<T> {
  const target = config.dockerHost;
  const opts: http.RequestOptions = { path: apiPath, method: 'GET', timeout: 4000, headers: { Host: 'docker' } };
  if (target.startsWith('unix://')) opts.socketPath = target.slice('unix://'.length);
  else {
    const u = new URL(target.replace(/^tcp:\/\//, 'http://'));
    opts.host = u.hostname;
    opts.port = Number(u.port || 2375);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 400) return reject(new Error(`Docker answered ${res.statusCode}`));
        try {
          resolve(JSON.parse(body) as T);
        } catch {
          reject(new Error('Docker sent something that isn’t JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker didn’t answer in time')));
    req.on('error', reject);
    req.end();
  });
}

interface DockerContainer { Names?: string[]; Image?: string; State?: string; Status?: string }

export function toContainers(list: DockerContainer[]): ContainerInfo[] {
  return list
    .map((c) => ({
      name: (c.Names?.[0] ?? '').replace(/^\//, ''),
      image: c.Image ?? '',
      state: c.State ?? 'unknown',
      status: c.Status ?? '',
    }))
    .sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
}

async function containers(): Promise<{ list: ContainerInfo[] | null; error: string | null }> {
  if (!config.dockerHost) return { list: null, error: null };
  try {
    return { list: toContainers(await docker<DockerContainer[]>('/containers/json?all=1')), error: null };
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const down = ['ENOTFOUND', 'ECONNREFUSED', 'ENOENT', 'EAI_AGAIN'].includes(err.code ?? '');
    return { list: null, error: down ? `Docker isn’t reachable at ${config.dockerHost}. Is the docker-proxy service running?` : err.message };
  }
}

// ---------- stats ----------

export async function serverStats(iface: string | undefined, speed: ServerStats['speed']): Promise<ServerStats> {
  startSampler();
  const last = samples[samples.length - 1];
  let disk: ServerStats['disk'] = null;
  try {
    const s = fs.statfsSync(config.dataDir);
    const total = s.blocks * s.bsize;
    disk = { totalBytes: total, usedBytes: total - s.bavail * s.bsize };
  } catch {
    // statfs unsupported: leave the storage panel without totals.
  }

  const names = [...new Set(samples.flatMap((s) => [...s.net.keys()]))];
  const shown = names.filter(isPhysical);
  const ifaces = shown.length ? shown : names.filter((n) => n !== 'lo');
  const pick = iface && ifaces.includes(iface) ? iface : busiest(ifaces);

  const dbFile = path.join(config.dataDir, 'launchpad.db');
  const docker = await containers();
  return {
    at: new Date().toISOString(),
    hostname: os.hostname(),
    uptimeSec: Math.round(os.uptime()),
    load: os.loadavg().map((l) => Math.round(l * 100) / 100) as [number, number, number],
    cpu: { pct: last?.cpuPct ?? 0, cores: os.cpus().length, tempC: readTemp() },
    mem: { totalBytes: os.totalmem(), usedBytes: os.totalmem() - os.freemem() },
    disk,
    data: { photosBytes: dirBytes(path.join(config.dataDir, 'photos')), dbBytes: fileBytes(dbFile, dbFile + '-wal') },
    net: pick
      ? {
          iface: pick,
          ifaces,
          host: netHost,
          samples: samples.slice(1).map((s) => ({ at: new Date(s.at).toISOString(), rxBps: s.net.get(pick)?.rxBps ?? 0, txBps: s.net.get(pick)?.txBps ?? 0 })),
        }
      : lastNet
        ? { iface: '', ifaces: [], host: netHost, samples: [] }
        : null,
    containers: docker.list,
    containersError: docker.error,
    speed,
  };
}
