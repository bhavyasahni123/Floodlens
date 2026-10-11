import type { AddressInfo } from 'node:net';
import { createApp, type AppDeps } from '../src/app';
import { config } from '../src/config';
import type { HazardDataset, HazardFeature } from '../src/hotspots';
import type { AlertsData, OfficialAlert } from '../src/providers/alerts';
import type { RainfallData, RainIntensity } from '../src/providers/rainfall';
import type { RiverData } from '../src/providers/river';
import type { RawRoute } from '../src/providers/routing';
import type { SourceResult } from '../src/sourceCache';

export const NOW = Date.parse('2026-07-15T10:00:00Z');

export function live<T>(data: T): SourceResult<T> {
  return { status: 'LIVE', data, retrievedAt: new Date().toISOString(), lastAttemptAt: new Date().toISOString() };
}
export function unavailable<T>(error = 'fixture: source down'): SourceResult<T> {
  return { status: 'UNAVAILABLE', data: null, retrievedAt: null, lastAttemptAt: new Date().toISOString(), error };
}

export function hotspot(id: string, lat: number, lon: number, severity: 'HIGH' | 'MODERATE' | 'LOW', buffer = 200): HazardFeature {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: {
      name: `Fixture ${id}`,
      infrastructureType: 'Road Underpass',
      zone: 'Test',
      severity,
      bufferRadiusMeters: buffer,
      hazardType: 'HISTORICAL_SUSCEPTIBILITY',
      dataSource: 'test fixture',
      lastUpdated: 'n/a',
      description: 'fixture',
    },
  };
}

export const FIXTURE_DATASET: HazardDataset = {
  type: 'FeatureCollection',
  metadata: { datasetName: 'fixture', hazardType: 'HISTORICAL_SUSCEPTIBILITY', lastUpdated: 'n/a', disclaimer: 'fixture' },
  features: [hotspot('h-high', 28.6009, 77.225, 'HIGH')],
};

/** Straight east-west route ~4.9 km long; its only vertices are the two ends. */
export const STRAIGHT_ROUTE: [number, number][] = [
  [28.6, 77.2],
  [28.6, 77.25],
];
/** Parallel route ~1.1 km south — far from the fixture hotspot. */
export const SOUTH_ROUTE: [number, number][] = [
  [28.6, 77.2],
  [28.59, 77.2],
  [28.59, 77.25],
  [28.6, 77.25],
];

export function rainfallFixture(intensity: RainIntensity = 'NONE'): RainfallData {
  const rate = { NONE: 0, LIGHT: 1, MODERATE: 5, HEAVY: 12 }[intensity];
  return {
    model: 'fixture',
    units: 'mm',
    samples: config.city.rainfallSamples.map((s) => ({
      ...s,
      series: [{ time: new Date(NOW).toISOString(), mm: rate, kind: 'ESTIMATED_PAST' as const }],
      summary: {
        past3hMm: rate,
        past24hMm: rate,
        next3hMm: 0,
        next24hMm: 0,
        peakRecentMmPerHour: rate,
        peakNext3hMmPerHour: 0,
        intensity,
      },
    })),
  };
}

export function alertFixture(overrides: Partial<OfficialAlert> = {}): OfficialAlert {
  return {
    id: 'fixture-alert-1',
    event: 'Flood',
    headline: 'Fixture flood alert',
    areaDescription: 'New Delhi',
    issuer: 'Fixture SDMA',
    severity: 'WARNING',
    certainty: 'Likely',
    severityColor: 'orange',
    effectiveStart: new Date(NOW - 3600e3).toISOString(),
    effectiveEnd: new Date(NOW + 3600e3).toISOString(),
    centroid: [28.6, 77.225],
    areaSqKm: 50,
    approxRadiusKm: Math.sqrt(50 / Math.PI),
    floodRelevant: true,
    sourceUrl: 'https://example.invalid/cap',
    language: 'en',
    ...overrides,
  };
}

export const RIVER_FIXTURE: RiverData = {
  river: 'Yamuna',
  label: 'fixture cell',
  lat: 28.625,
  lon: 77.225,
  units: 'm³/s',
  days: [{ date: '2026-07-15', dischargeM3s: 400, kind: 'MODELLED_PAST' }],
  todayM3s: 400,
  forecastPeakM3s: null,
  trend: 'UNKNOWN',
};

export function routeFixture(coords: [number, number][], minutes: number): RawRoute {
  return { coords, distanceM: 5000, durationS: minutes * 60 };
}

export function testDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    store: null,
    hazards: FIXTURE_DATASET,
    getRainfall: async () => live(rainfallFixture('NONE')),
    getRiver: async () => live(RIVER_FIXTURE),
    getAlerts: async () => live<AlertsData>({ alerts: [], nationalCount: 0 }),
    fetchRoutes: async () => [routeFixture(STRAIGHT_ROUTE, 10), routeFixture(SOUTH_ROUTE, 12)],
    suggest: async () => ({ provider: 'fixture', results: [{ label: 'India Gate', detail: 'New Delhi', lat: 28.6129, lon: 77.2295 }] }),
    geocode: async (q) => (q === 'nowhere' ? null : { label: q, detail: 'Delhi', lat: 28.6, lon: 77.2 }),
    reportsPolicy: { ...config.reports },
    hashSecret: 'test-secret',
    corsOrigins: ['http://localhost:5173'],
    ...overrides,
  };
}

export async function startApp(deps: AppDeps) {
  const server = createApp(deps).listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    get: (p: string) => fetch(base + p),
    post: (p: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + p, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
