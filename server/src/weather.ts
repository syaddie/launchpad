// Singapore weather from data.gov.sg (Meteorological Service Singapore): the
// 2-hour forecast for one area, plus the air temperature at the station nearest it.
// Extras for the weather details: PSI for the nearest region, the UV index,
// rain at the nearest rain gauge over the last hour and the 4-day outlook.
import { config } from './config';
import { ymd } from '../../shared/dates';
import type { AirQuality, OutlookDay, Rain, UvIndex, Weather } from '../../shared/types';

const BASE = 'https://api-open.data.gov.sg/v2/real-time/api';

interface LatLon { latitude: number; longitude: number }

interface ForecastJson {
  data?: {
    area_metadata?: { name: string; label_location: LatLon }[];
    items?: { timestamp: string; valid_period?: { end: string }; forecasts?: { area: string; forecast: string }[] }[];
  };
}

interface TemperatureJson {
  data?: {
    stations?: { id: string; name: string; location: LatLon }[];
    readings?: { timestamp: string; data?: { stationId: string; value: number }[] }[];
  };
}

interface PsiJson {
  data?: {
    regionMetadata?: { name: string; labelLocation: LatLon }[];
    items?: { timestamp: string; readings?: Record<string, Record<string, number>> }[];
  };
}

interface UvJson {
  data?: { records?: { timestamp: string; index?: { hour: string; value: number }[] }[] };
}

/** Same shape as TemperatureJson; with ?date= the readings run newest first, every 5 minutes. */
type RainfallJson = TemperatureJson;

interface OutlookJson {
  data?: {
    records?: {
      forecasts?: { timestamp: string; forecast?: { text?: string; summary?: string }; temperature?: { low: number; high: number } }[];
    }[];
  };
}

/** Rough distance, fine for ranking stations within Singapore. */
function dist(a: LatLon, b: LatLon): number {
  const dx = (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dx, a.latitude - b.latitude);
}

/** The forecast for `area` (or City when it isn't listed) and the nearest station's temperature. */
export function pickWeather(f: ForecastJson, t: TemperatureJson, area: string): { areas: string[]; now: Weather } {
  const meta = f.data?.area_metadata ?? [];
  const item = f.data?.items?.[0];
  const forecasts = item?.forecasts ?? [];
  const fc = forecasts.find((x) => x.area === area) ?? forecasts.find((x) => x.area === 'City') ?? forecasts[0];
  if (!item || !fc) throw new Error('No forecast in the response');
  const place = meta.find((m) => m.name === fc.area)?.label_location;

  let tempC: number | null = null;
  let station: string | null = null;
  const reading = t.data?.readings?.[0];
  if (place && reading?.data?.length) {
    const values = new Map(reading.data.map((r) => [r.stationId, r.value]));
    const nearest = (t.data?.stations ?? [])
      .filter((s) => typeof values.get(s.id) === 'number')
      .sort((a, b) => dist(a.location, place) - dist(b.location, place))[0];
    if (nearest) {
      tempC = values.get(nearest.id)!;
      station = nearest.name;
    }
  }

  return {
    areas: meta.map((m) => m.name),
    now: {
      area: fc.area,
      forecast: fc.forecast,
      validUntil: item.valid_period?.end ?? null,
      tempC,
      station,
      observedAt: reading?.timestamp ?? null,
      issuedAt: item.timestamp,
    },
  };
}

function nearest<T extends { location: LatLon }>(list: T[], place: LatLon): T | undefined {
  return [...list].sort((a, b) => dist(a.location, place) - dist(b.location, place))[0];
}

/** 24-hour PSI and PM2.5 for the region nearest `place`. */
export function pickAir(j: PsiJson, place: LatLon): AirQuality | null {
  const item = j.data?.items?.[0];
  const psi = item?.readings?.psi_twenty_four_hourly;
  const pm = item?.readings?.pm25_twenty_four_hourly;
  if (!item || !psi) return null;
  const regions = (j.data?.regionMetadata ?? []).filter((r) => typeof psi[r.name] === 'number').map((r) => ({ ...r, location: r.labelLocation }));
  const region = nearest(regions, place)?.name ?? (typeof psi.national === 'number' ? 'national' : '');
  if (!region) return null;
  return { region, psi: psi[region], pm25: pm?.[region] ?? 0, at: item.timestamp };
}

/** The latest hourly UV index and today's peak. */
export function pickUv(j: UvJson): UvIndex | null {
  const rec = j.data?.records?.[0];
  const index = rec?.index ?? [];
  if (!index.length) return null;
  const latest = [...index].sort((a, b) => Date.parse(b.hour) - Date.parse(a.hour))[0];
  const peak = index.reduce((a, b) => (b.value > a.value ? b : a));
  return { value: latest.value, at: latest.hour, peak: peak.value, peakAt: peak.hour };
}

/** 5-minute rain totals for the last hour at the gauge nearest `place`. */
export function pickRain(j: RainfallJson, place: LatLon, now = new Date()): Rain | null {
  const readings = [...(j.data?.readings ?? [])].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const latest = readings[readings.length - 1];
  if (!latest?.data?.length) return null;
  const reporting = new Set(latest.data.map((d) => d.stationId));
  const station = nearest((j.data?.stations ?? []).filter((s) => reporting.has(s.id)), place);
  if (!station) return null;
  const since = Math.min(now.getTime(), Date.parse(latest.timestamp)) - 60 * 60_000;
  const steps = readings
    .filter((r) => Date.parse(r.timestamp) > since)
    .map((r) => ({ at: r.timestamp, mm: r.data?.find((d) => d.stationId === station.id)?.value ?? 0 }));
  const mmLastHour = Math.round(steps.reduce((a, s) => a + s.mm, 0) * 10) / 10;
  return { station: station.name, steps, mmLastHour, raining: (steps[steps.length - 1]?.mm ?? 0) > 0 };
}

export function pickOutlook(j: OutlookJson): OutlookDay[] {
  return (j.data?.records?.[0]?.forecasts ?? []).flatMap((f) =>
    f.temperature && f.forecast?.text
      ? [{ date: ymd(new Date(f.timestamp)), forecast: f.forecast.text, low: f.temperature.low, high: f.temperature.high }]
      : [],
  );
}

async function get<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.dataGovKey) headers['x-api-key'] = config.dataGovKey;
  const res = await fetch(`${BASE}/${path}`, { headers, signal: AbortSignal.timeout(15_000) });
  if (res.status === 429) throw new Error('data.gov.sg rate limit reached');
  if (!res.ok) throw new Error(`data.gov.sg ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchWeather(area: string) {
  const [f, t] = await Promise.all([get<ForecastJson>('two-hr-forecast'), get<TemperatureJson>('air-temperature').catch(() => ({}))]);
  // The extras go one at a time so a burst can't trip the rate limit; each one may fail on its own.
  const none = () => null;
  const psi = await get<PsiJson>('psi').catch(none);
  const uv = await get<UvJson>('uv').catch(none);
  // With today's date the first page holds the last two hours of 5-minute readings.
  const rain = await get<RainfallJson>(`rainfall?date=${ymd(new Date())}`).catch(none);
  const outlook = await get<OutlookJson>('four-day-outlook').catch(none);
  const w = pickWeather(f, t, area);
  const place = f.data?.area_metadata?.find((m) => m.name === w.now.area)?.label_location;
  w.now.air = psi && place ? pickAir(psi, place) : null;
  w.now.uv = uv ? pickUv(uv) : null;
  w.now.rain = rain && place ? pickRain(rain, place) : null;
  w.now.outlook = outlook ? pickOutlook(outlook) : [];
  return w;
}
