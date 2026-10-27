// Singapore weather from data.gov.sg (Meteorological Service Singapore): the
// 2-hour forecast for one area, plus the air temperature at the station nearest it.
import { config } from './config';
import type { Weather } from '../../shared/types';

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
  return pickWeather(f, t, area);
}
