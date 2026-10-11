/**
 * TEST-ONLY server for browser end-to-end tests. Runs the real FloodLens app
 * (real hotspot dataset, real risk engine, real PostgreSQL via embedded-postgres)
 * with FIXTURE external providers so the journey is reproducible offline.
 * Never use this as the production server.
 *
 * Usage: npx tsx test/e2e-server.ts   (listens on E2E_PORT, default 5099)
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApp } from '../src/app';
import { loadHotspots } from '../src/hotspots';
import type { AlertsData } from '../src/providers/alerts';
import type { RainfallData } from '../src/providers/rainfall';
import { RoutingError } from '../src/providers/routing';
import type { OsrmStep } from '../src/directions';
import { createPgStore, migrate } from '../src/reports/store';
import { alertFixture, live, RIVER_FIXTURE, testDeps } from './helpers';

const PORT = Number(process.env.E2E_PORT || 5099);
const PG_PORT = 54332;

// Route A passes the Minto Bridge hotspot; route B detours west of it.
const ROUTE_A: [number, number][] = [[28.6315, 77.2167], [28.6416, 77.2215], [28.6675, 77.2283]];
const ROUTE_B: [number, number][] = [[28.6315, 77.2167], [28.64, 77.205], [28.66, 77.21], [28.6675, 77.2283]];

type Pt = [number, number];
/** Fixture OSRM steps: one per route segment, plus depart/arrive. */
function fixtureSteps(route: Pt[], names: string[]): OsrmStep[] {
  const steps: OsrmStep[] = route.slice(0, -1).map((p, i) => ({
    distance: 1500 + i * 400,
    duration: 200 + i * 60,
    name: names[i] ?? '',
    maneuver: i === 0 ? { type: 'depart', location: [p[1], p[0]], bearing_after: 20 } : { type: 'turn', modifier: i % 2 ? 'right' : 'left', location: [p[1], p[0]] },
    geometry: { coordinates: [[p[1], p[0]], [route[i + 1][1], route[i + 1][0]]] },
  }));
  const end = route[route.length - 1];
  steps.push({ distance: 0, duration: 0, name: '', maneuver: { type: 'arrive', modifier: 'left', location: [end[1], end[0]] }, geometry: { coordinates: [[end[1], end[0]], [end[1], end[0]]] } });
  return steps;
}

function fixtureRainfall(): RainfallData {
  const now = Date.now();
  const hour = 3600e3;
  const base = Math.floor(now / hour) * hour;
  const values = [0, 0, 0.4, 1.2, 3.1, 2.2, 0.8, 0.3, 0, 0, 0.5, 1.8, 2.6, 1.1, 0.4, 0, 0, 0, 0.2, 0.6, 1.4, 0.9, 0.2, 0];
  const series = values.map((mm, i) => {
    const t = base + (i - 11) * hour;
    return { time: new Date(t).toISOString(), mm, kind: t <= now ? ('ESTIMATED_PAST' as const) : ('FORECAST' as const) };
  });
  return {
    model: 'E2E FIXTURE (not real weather)',
    units: 'mm',
    samples: ['central', 'north', 'south', 'east', 'west'].map((id, i) => ({
      id,
      name: ['Central Delhi', 'North Delhi', 'South Delhi', 'East Delhi', 'West Delhi'][i],
      lat: [28.6139, 28.73, 28.52, 28.63, 28.62][i],
      lon: [77.209, 77.17, 77.22, 77.3, 77.05][i],
      series,
      summary: { past3hMm: 1.5, past24hMm: 8.4, next3hMm: 4.4, next24hMm: 9.1, peakRecentMmPerHour: 1.2, peakNext3hMmPerHour: 2.6, intensity: 'MODERATE' as const },
    })),
  };
}

async function main() {
  const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as unknown as {
    default: new (o: object) => { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };
  };
  // Throwaway cluster: clear leftovers from a previous run that was killed.
  const dataDir = path.resolve(__dirname, '..', '.pge2e');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'e2e',
    port: PG_PORT,
    persistent: false,
    onLog: () => {},
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('floodlens_e2e');
  const url = `postgres://postgres:e2e@localhost:${PG_PORT}/floodlens_e2e`;
  await migrate(url);

  let routingFails = false;
  const deps = testDeps({
    store: createPgStore(url),
    hazards: loadHotspots().dataset,
    corsOrigins: ['http://localhost:4173', 'http://localhost:5173'],
    // One browser runs the whole journey from one IP; lift the per-minute limit for the test only.
    generalLimitPerMinute: 10000,
    getRainfall: async () => live(fixtureRainfall()),
    getRiver: async () => live(RIVER_FIXTURE),
    getAlerts: async () =>
      live<AlertsData>({
        alerts: [
          alertFixture({
            id: 'e2e-alert',
            event: 'Heavy Rain',
            headline: 'E2E FIXTURE: heavy rain likely over Central Delhi',
            areaDescription: 'Central Delhi',
            issuer: 'IMD (fixture)',
            centroid: [28.655, 77.235],
            areaSqKm: 3,
            approxRadiusKm: Math.sqrt(3 / Math.PI),
            effectiveStart: new Date(Date.now() - 3600e3).toISOString(),
            effectiveEnd: new Date(Date.now() + 3 * 3600e3).toISOString(),
          }),
        ],
        nationalCount: 12,
      }),
    fetchRoutes: async () => {
      if (routingFails) throw new RoutingError('The routing service did not respond. Please retry.', 'PROVIDER_UNAVAILABLE');
      return [
        { coords: ROUTE_A, distanceM: 5200, durationS: 600, steps: fixtureSteps(ROUTE_A, ['Minto Road', 'Bhavbhuti Marg']) },
        { coords: ROUTE_B, distanceM: 6400, durationS: 780, steps: fixtureSteps(ROUTE_B, ['Panchkuian Road', 'Rani Jhansi Road', 'Lothian Road']) },
      ];
    },
    suggest: async (q) => ({
      provider: 'fixture',
      results: /kashm/i.test(q)
        ? [{ label: 'Kashmere Gate ISBT', detail: 'Lothian Road, Delhi', lat: 28.6675, lon: 77.2283 }]
        : [{ label: 'Minto Road', detail: 'New Delhi', lat: 28.6375, lon: 77.2236 }],
    }),
  });

  const outer = express();
  outer.post('/__test/routing', express.json(), (req, res) => {
    routingFails = Boolean((req.body as { fail?: boolean }).fail);
    res.json({ routingFails });
  });
  // Graceful stop used by the test runner: a forced kill would orphan the PostgreSQL process.
  outer.post('/__test/shutdown', (_req, res) => {
    res.json({ stopping: true });
    void shutdown();
  });
  outer.use(createApp(deps));
  const server = outer.listen(PORT, () => console.log(`E2E fixture server on http://localhost:${PORT}`));

  async function shutdown() {
    server.close();
    await pg.stop().catch(() => {});
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
