// Internet speed test against Cloudflare's speed test endpoints (the ones
// speed.cloudflare.com uses; no account or key). One run moves about 100 MB
// down and 32 MB up, over 4 parallel connections so a fast line is filled.
import type { SpeedTest } from '../../shared/types';

const BASE = 'https://speed.cloudflare.com';
const STREAMS = 4;
const DOWN_BYTES = 25_000_000;
const UP_BYTES = 8_000_000;
const PINGS = 8;

/** Median round trip and mean jitter (average change between consecutive pings), in ms. */
export function latencyStats(rtts: number[]): { pingMs: number; jitterMs: number } {
  if (!rtts.length) return { pingMs: 0, jitterMs: 0 };
  const sorted = [...rtts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  let jitter = 0;
  for (let i = 1; i < rtts.length; i++) jitter += Math.abs(rtts[i] - rtts[i - 1]);
  return { pingMs: Math.round(median * 10) / 10, jitterMs: Math.round((rtts.length > 1 ? jitter / (rtts.length - 1) : 0) * 10) / 10 };
}

export const mbps = (bytes: number, ms: number) => (ms > 0 ? Math.round(((bytes * 8) / (ms / 1000) / 1e6) * 10) / 10 : 0);

async function ping(): Promise<number> {
  const t = performance.now();
  const res = await fetch(`${BASE}/__down?bytes=0`, { signal: AbortSignal.timeout(5000) });
  await res.arrayBuffer();
  return performance.now() - t;
}

async function download(): Promise<number> {
  const res = await fetch(`${BASE}/__down?bytes=${DOWN_BYTES}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok || !res.body) throw new Error(`Download test returned ${res.status}`);
  let n = 0;
  for await (const chunk of res.body) n += (chunk as Uint8Array).byteLength;
  return n;
}

async function upload(body: Uint8Array): Promise<number> {
  const res = await fetch(`${BASE}/__up`, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/octet-stream' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`Upload test returned ${res.status}`);
  await res.arrayBuffer();
  return body.byteLength;
}

async function timed(run: () => Promise<number>): Promise<number> {
  const t = performance.now();
  const bytes = (await Promise.all(Array.from({ length: STREAMS }, run))).reduce((a, b) => a + b, 0);
  return mbps(bytes, performance.now() - t);
}

export async function runSpeedTest(): Promise<SpeedTest> {
  const at = new Date().toISOString();
  // The first ping opens the connection; leave it out of the latency.
  await ping();
  const rtts: number[] = [];
  for (let i = 0; i < PINGS; i++) rtts.push(await ping());
  const downMbps = await timed(download);
  const blob = new Uint8Array(UP_BYTES);
  const upMbps = await timed(() => upload(blob));
  return { at, downMbps, upMbps, ...latencyStats(rtts) };
}
