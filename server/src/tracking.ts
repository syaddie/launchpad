// Live package status. SingPost is queried directly; everything else goes
// through 17TRACK when SEVENTEEN_TRACK_API_KEY is set.
import { config } from './config';
import { store } from './store';
import type { Package, Stage, TrackingEvent } from '../../shared/types';

export interface TrackResult {
  stage: Stage;
  exception: boolean;
  statusText: string;
  timeline: TrackingEvent[];
  deliveredAt: string | null;
}

export class TrackingUnavailable extends Error {}

const DELIVERED = /\bdelivered\b|successfully delivered|has been collected|collected by (the )?(recipient|addressee|customer)|picked up by (the )?(recipient|customer)/i;
const NOT_DELIVERED = /not (been )?delivered|undeliver|unable to deliver|could not be delivered|delivery (was )?unsuccessful|attempted/i;
const OUT = /out for delivery|on (its|the) way to you|with (our )?(delivery|courier)|delivery in progress|scheduled for delivery today/i;
const EXCEPTION = /unsuccessful|failed|attempted|unable to deliver|not delivered|undeliver|exception|return(ed|ing)? to sender|address (issue|incomplete)|on hold|held at|customs (hold|delay)/i;
const INFO = /information received|order information|label (was )?created|shipment information|awaiting (item|parcel|pickup)|pre-?advice|but not your item yet/i;

/** Map one event description to a stage. Unrecognised scans count as "in transit". */
export function classify(text: string): { stage: Stage; exception: boolean } {
  if (DELIVERED.test(text) && !NOT_DELIVERED.test(text)) return { stage: 3, exception: false };
  if (EXCEPTION.test(text)) return { stage: 2, exception: true };
  if (OUT.test(text)) return { stage: 2, exception: false };
  if (INFO.test(text)) return { stage: 0, exception: false };
  return { stage: 1, exception: false };
}

/** Summarise a newest-first timeline. */
export function summarise(timeline: TrackingEvent[]): TrackResult {
  if (!timeline.length) {
    return { stage: 0, exception: false, statusText: 'Info received · waiting for first scan', timeline, deliveredAt: null };
  }
  const latest = classify(timeline[0].event);
  // The furthest stage any event reached, so an odd late "in transit" scan doesn't move the bar backwards.
  const reached = Math.max(0, ...timeline.map((e) => classify(e.event)).filter((c) => !c.exception).map((c) => c.stage));
  const stage = (latest.exception ? Math.min(Math.max(reached, 1), 2) : Math.max(reached, latest.stage)) as Stage;
  return {
    stage,
    exception: latest.exception,
    statusText: timeline[0].event,
    timeline,
    deliveredAt: stage === 3 ? timeline[0].at : null,
  };
}

// ---------- SingPost ----------

const isSingpostDelivered = (code: string) =>
  (code.length === 3 && /^D.C$|^R.C$/.test(code)) || code === 'IDBC' || code === 'FD';

/** SingPost dates are local Singapore time without an offset. */
const sgIso = (s: string) => (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}+08:00`);

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

export function parseSingpost(json: any): TrackResult | null {
  if (!json?.ok) return null;
  const item = Array.isArray(json.items) ? json.items.find((i: any) => i.trackingNumberFound !== 'false') : json;
  const raw: any[] = item?.events || [];
  const events = raw
    .filter((e) => e?.statusDescription && e.statusDescription !== '-')
    .map((e) => ({
      at: new Date(sgIso(e.date)).toISOString(),
      location: e.location && e.location !== '-' ? titleCase(e.location) : '',
      event: String(e.statusDescription).trim(),
      code: String(e.eventDescription || e.aceStatusCode || '').trim().toUpperCase(),
    }))
    .sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!events.length) return null;
  const res = summarise(events.map(({ at, location, event }) => ({ at, location, event })));
  if (isSingpostDelivered(events[0].code)) {
    return { ...res, stage: 3, exception: false, deliveredAt: events[0].at };
  }
  return res;
}

async function trackSingpost(number: string): Promise<TrackResult | null> {
  const res = await fetch('https://www.singpost.com/api/services/track-events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://www.singpost.com',
      Referer: 'https://www.singpost.com/track-items',
      'User-Agent': 'Mozilla/5.0 (Launchpad personal dashboard)',
    },
    body: JSON.stringify({ trackingNumber: number }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`SingPost returned ${res.status}`);
  return parseSingpost(await res.json());
}

// ---------- 17TRACK ----------

const ST = 'https://api.17track.net/track/v2.2';

async function st(path: string, body: unknown): Promise<any> {
  const res = await fetch(ST + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', '17token': config.seventeenTrackKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const json = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || json.code !== 0) throw new Error(`17TRACK error: ${json?.data?.errors?.[0]?.message || json.code || res.status}`);
  return json.data;
}

const ST_STAGE: Record<string, { stage: Stage; exception: boolean }> = {
  NotFound: { stage: 0, exception: false },
  InfoReceived: { stage: 0, exception: false },
  InTransit: { stage: 1, exception: false },
  Expired: { stage: 1, exception: true },
  AvailableForPickup: { stage: 2, exception: false },
  OutForDelivery: { stage: 2, exception: false },
  DeliveryFailure: { stage: 2, exception: true },
  Delivered: { stage: 3, exception: false },
  Exception: { stage: 1, exception: true },
};

export function parse17(info: any): TrackResult | null {
  const providers: any[] = info?.tracking?.providers || [];
  const timeline: TrackingEvent[] = providers
    .flatMap((p) => p.events || [])
    .map((e: any) => ({ at: e.time_utc || e.time_iso, location: e.location || '', event: e.description || '' }))
    .filter((e: TrackingEvent) => e.at && e.event)
    .map((e: TrackingEvent) => ({ ...e, at: new Date(e.at).toISOString() }))
    .sort((a: TrackingEvent, b: TrackingEvent) => (a.at < b.at ? 1 : -1));
  const status = ST_STAGE[info?.latest_status?.status as string];
  const base = summarise(timeline);
  if (!status) return base;
  return {
    ...base,
    stage: status.stage,
    exception: status.exception,
    deliveredAt: status.stage === 3 ? timeline[0]?.at || new Date().toISOString() : null,
  };
}

async function track17(number: string): Promise<TrackResult | null> {
  const registered = store.registered17();
  if (!registered.includes(number)) {
    const data = await st('/register', [{ number }]);
    const rejected = data?.rejected?.[0];
    // -18019901: already registered. Anything else is a real failure.
    if (rejected && rejected.error?.code !== -18019901) throw new Error(`17TRACK: ${rejected.error?.message || 'rejected'}`);
    store.setRegistered17([...registered, number]);
  }
  const data = await st('/gettrackinfo', [{ number }]);
  const accepted = data?.accepted?.[0];
  if (!accepted) return null;
  return parse17(accepted.track_info);
}

export const canTrack = (carrier: string) => carrier === 'SingPost' || !!config.seventeenTrackKey;

export async function track(pkg: Pick<Package, 'carrier' | 'number'>): Promise<TrackResult | null> {
  if (pkg.carrier === 'SingPost') {
    const r = await trackSingpost(pkg.number);
    if (r || !config.seventeenTrackKey) return r;
  }
  if (config.seventeenTrackKey) return track17(pkg.number);
  throw new TrackingUnavailable(`Live status for ${pkg.carrier} needs a 17TRACK API key.`);
}
