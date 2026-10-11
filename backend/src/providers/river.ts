import { config } from '../config';
import { createSourceCache, fetchJson } from '../sourceCache';

export type RiverDay = {
  date: string;
  dischargeM3s: number;
  kind: 'MODELLED_PAST' | 'FORECAST';
};

export type RiverData = {
  river: string;
  label: string;
  lat: number;
  lon: number;
  units: 'm³/s';
  days: RiverDay[];
  todayM3s: number | null;
  forecastPeakM3s: number | null;
  trend: 'RISING' | 'FALLING' | 'STEADY' | 'UNKNOWN';
};

type FloodApiResponse = {
  latitude: number;
  longitude: number;
  daily?: { time: string[]; river_discharge: (number | null)[] };
};

export function parseFloodApi(raw: FloodApiResponse, today: string): RiverData {
  const cell = config.city.riverCell;
  if (!cell) throw new Error('No river cell configured for this city.');
  const times = raw.daily?.time ?? [];
  const values = raw.daily?.river_discharge ?? [];
  const days: RiverDay[] = [];
  times.forEach((date, i) => {
    const v = values[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return;
    days.push({ date, dischargeM3s: v, kind: date <= today ? 'MODELLED_PAST' : 'FORECAST' });
  });
  if (days.length === 0) throw new Error('River response contained no usable values.');
  const todayM3s = days.find((d) => d.date === today)?.dischargeM3s ?? null;
  const forecast = days.filter((d) => d.kind === 'FORECAST');
  const forecastPeakM3s = forecast.length ? Math.max(...forecast.map((d) => d.dischargeM3s)) : null;
  let trend: RiverData['trend'] = 'UNKNOWN';
  if (todayM3s !== null && forecastPeakM3s !== null && todayM3s > 0) {
    const forecastLow = Math.min(...forecast.map((d) => d.dischargeM3s));
    if (forecastPeakM3s > todayM3s * 1.15) trend = 'RISING';
    else if (forecastLow < todayM3s * 0.85) trend = 'FALLING';
    else trend = 'STEADY';
  }
  return { ...cell, units: 'm³/s', days, todayM3s, forecastPeakM3s, trend };
}

async function loadRiver(): Promise<RiverData> {
  const cell = config.city.riverCell;
  if (!cell) throw new Error('No river cell configured for this city.');
  const url = new URL(config.providers.openMeteoFloodUrl);
  url.searchParams.set('latitude', String(cell.lat));
  url.searchParams.set('longitude', String(cell.lon));
  url.searchParams.set('daily', 'river_discharge');
  url.searchParams.set('past_days', '7');
  url.searchParams.set('forecast_days', '7');
  const raw = await fetchJson<FloodApiResponse>(url, { headers: { 'User-Agent': config.providers.userAgent } });
  // GloFAS daily values are in UTC days.
  return parseFloodApi(raw, new Date().toISOString().slice(0, 10));
}

export const riverSource = createSourceCache<RiverData>({
  ttlMs: 3 * 3600e3,
  maxStaleMs: 24 * 3600e3,
  load: loadRiver,
});

export const RIVER_SOURCE_INFO = {
  name: 'Open-Meteo Flood API (Copernicus GloFAS v4)',
  url: 'https://open-meteo.com/en/docs/flood-api',
  license: 'CC BY 4.0 (Open-Meteo); GloFAS data © Copernicus Emergency Management Service',
  nature: 'MODELLED',
  note:
    'Modelled daily river discharge on a ~5 km grid — not a gauge reading and not a water level. It cannot be compared with the official Old Railway Bridge warning/danger levels (in metres). Official CWC gauge data has no documented public API, so it is not integrated.',
};
