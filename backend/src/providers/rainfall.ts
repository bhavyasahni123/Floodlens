import { config } from '../config';
import { haversineMeters, type LatLon } from '../geo';
import { createSourceCache, fetchJson } from '../sourceCache';

export type RainIntensity = 'NONE' | 'LIGHT' | 'MODERATE' | 'HEAVY';

/**
 * Hourly-rate classes (mm/h) following common meteorological convention
 * (light < 2.5, moderate 2.5–7.6, heavy > 7.6). A trace below 0.5 mm/h is NONE.
 */
export function classifyRate(mmPerHour: number): RainIntensity {
  if (mmPerHour >= 7.6) return 'HEAVY';
  if (mmPerHour >= 2.5) return 'MODERATE';
  if (mmPerHour >= 0.5) return 'LIGHT';
  return 'NONE';
}

export type RainPoint = {
  /** End of the hour the value covers (Open-Meteo hourly precipitation is the preceding-hour sum). */
  time: string;
  mm: number;
  kind: 'ESTIMATED_PAST' | 'FORECAST';
};

export type RainSample = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  series: RainPoint[];
  summary: {
    past3hMm: number;
    past24hMm: number;
    next3hMm: number;
    next24hMm: number;
    peakRecentMmPerHour: number;
    peakNext3hMmPerHour: number;
    intensity: RainIntensity;
  };
};

export type RainfallData = {
  model: string;
  units: 'mm';
  samples: RainSample[];
};

type OpenMeteoLocation = {
  latitude: number;
  longitude: number;
  hourly?: { time: number[]; precipitation: (number | null)[] };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function parseOpenMeteo(raw: OpenMeteoLocation | OpenMeteoLocation[], nowMs: number): RainfallData {
  const locations = Array.isArray(raw) ? raw : [raw];
  const samples = config.city.rainfallSamples;
  if (locations.length !== samples.length) {
    throw new Error(`Expected ${samples.length} rainfall locations, got ${locations.length}.`);
  }
  return {
    model: 'Open-Meteo best-match numerical weather models',
    units: 'mm',
    samples: locations.map((loc, i) => {
      const times = loc.hourly?.time ?? [];
      const values = loc.hourly?.precipitation ?? [];
      const series: RainPoint[] = [];
      times.forEach((t, j) => {
        const v = values[j];
        // Missing hours are skipped rather than filled with zeros.
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        const ms = t * 1000;
        if (ms < nowMs - 24 * 3600e3 || ms > nowMs + 24 * 3600e3) return;
        series.push({ time: new Date(ms).toISOString(), mm: v, kind: ms <= nowMs ? 'ESTIMATED_PAST' : 'FORECAST' });
      });
      if (series.length === 0) throw new Error('Rainfall response contained no usable hourly values.');
      const past = series.filter((p) => p.kind === 'ESTIMATED_PAST');
      const future = series.filter((p) => p.kind === 'FORECAST');
      const sum = (pts: RainPoint[]) => round1(pts.reduce((s, p) => s + p.mm, 0));
      const max = (pts: RainPoint[]) => pts.reduce((m, p) => Math.max(m, p.mm), 0);
      const recent = past.slice(-3);
      const next = future.slice(0, 3);
      const peakRecent = max(recent);
      const peakNext = max(next);
      return {
        ...samples[i],
        series,
        summary: {
          past3hMm: sum(recent),
          past24hMm: sum(past),
          next3hMm: sum(next),
          next24hMm: sum(future),
          peakRecentMmPerHour: peakRecent,
          peakNext3hMmPerHour: peakNext,
          intensity: classifyRate(Math.max(peakRecent, peakNext)),
        },
      };
    }),
  };
}

async function loadRainfall(): Promise<RainfallData> {
  const samples = config.city.rainfallSamples;
  const url = new URL(config.providers.openMeteoForecastUrl);
  url.searchParams.set('latitude', samples.map((s) => s.lat).join(','));
  url.searchParams.set('longitude', samples.map((s) => s.lon).join(','));
  url.searchParams.set('hourly', 'precipitation');
  url.searchParams.set('past_days', '1');
  url.searchParams.set('forecast_days', '2');
  url.searchParams.set('timeformat', 'unixtime');
  const raw = await fetchJson<OpenMeteoLocation | OpenMeteoLocation[]>(url, {
    headers: { 'User-Agent': config.providers.userAgent },
  });
  return parseOpenMeteo(raw, Date.now());
}

export const rainfallSource = createSourceCache<RainfallData>({
  ttlMs: 15 * 60e3,
  maxStaleMs: 2 * 3600e3,
  load: loadRainfall,
});

export const RAINFALL_SOURCE_INFO = {
  name: 'Open-Meteo Forecast API',
  url: 'https://open-meteo.com/',
  license: 'CC BY 4.0 — attribution required; free for non-commercial use',
  nature: 'MODELLED',
  note:
    'Past-hour values are model estimates, not rain-gauge observations. No free machine-readable gauge feed for Delhi was found.',
};

/** Worst rainfall intensity among the samples nearest to the given route points. */
export function intensityForRoute(data: RainfallData, points: LatLon[]): { intensity: RainIntensity; sampleNames: string[] } {
  const order: RainIntensity[] = ['NONE', 'LIGHT', 'MODERATE', 'HEAVY'];
  const used = new Set<RainSample>();
  for (const p of points) {
    let best: RainSample | null = null;
    let bestD = Infinity;
    for (const s of data.samples) {
      const d = haversineMeters(p, [s.lat, s.lon]);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (best) used.add(best);
  }
  let worst: RainIntensity = 'NONE';
  for (const s of used) {
    if (order.indexOf(s.summary.intensity) > order.indexOf(worst)) worst = s.summary.intensity;
  }
  return { intensity: worst, sampleNames: [...used].map((s) => s.name) };
}
