/**
 * Community report tests against a real PostgreSQL server (embedded-postgres).
 * Set TEST_DATABASE_URL to use an existing server instead (the
 * community_reports table in it will be truncated).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { Pool } from 'pg';
import type { AlertsData } from '../src/providers/alerts';
import { createPgStore, migrate, type ReportStore } from '../src/reports/store';
import { alertFixture, live, startApp, testDeps } from './helpers';

type App = Awaited<ReturnType<typeof startApp>>;
type Embedded = { initialise(): Promise<void>; start(): Promise<void>; stop(): Promise<void>; createDatabase(n: string): Promise<void> };

let embedded: Embedded | null = null;
let url = process.env.TEST_DATABASE_URL ?? '';
let pool: Pool;
let store: ReportStore;
let app: App;

const SPOT = { lat: 28.6315, lon: 77.2167 };
const NEAR = { lat: 28.6315 + 50 / 111195, lon: 77.2167 }; // ~50 m north
const FAR = { lat: 28.6315 + 300 / 111195, lon: 77.2167 }; // ~300 m north

async function insertAt(lat: number, lon: number, hoursAgo: number, source = 'seed') {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO community_reports (latitude, longitude, description, submitted_at, source_hash)
     VALUES ($1, $2, 'seeded report', now() - ($3::double precision * interval '1 hour'), $4) RETURNING id`,
    [lat, lon, hoursAgo, source],
  );
  return rows[0].id;
}

const post = (body: unknown, ip = '10.0.0.1') => app.post('/api/reports', body, { 'X-Forwarded-For': ip });

before(async () => {
  if (!url) {
    const { default: EmbeddedPostgres } = (await import('embedded-postgres')) as unknown as { default: new (o: object) => Embedded };
    const dataDir = path.resolve(__dirname, '..', '.pgtest');
    fs.rmSync(dataDir, { recursive: true, force: true });
    embedded = new EmbeddedPostgres({
      databaseDir: dataDir,
      user: 'postgres',
      password: 'test',
      port: 54331,
      persistent: false,
      onLog: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase('floodlens_test');
    url = 'postgres://postgres:test@localhost:54331/floodlens_test';
  }
  await migrate(url);
  await migrate(url); // idempotent
  pool = new Pool({ connectionString: url });
  store = createPgStore(url);
  app = await startApp(
    testDeps({
      store,
      trustProxy: true,
      reportsPolicy: { ...testDeps().reportsPolicy, submitLimitPerWindow: 1000 },
      getAlerts: async () => live<AlertsData>({ alerts: [alertFixture({ effectiveStart: new Date(Date.now() - 10 * 3600e3).toISOString(), effectiveEnd: new Date(Date.now() + 3600e3).toISOString() })], nationalCount: 1 }),
    }),
  );
});

after(async () => {
  await app?.close();
  await store?.close();
  await pool?.end();
  await embedded?.stop();
});

beforeEach(async () => {
  await pool.query('TRUNCATE community_reports RESTART IDENTITY');
});

describe('report submission', () => {
  it('accepts a valid guest report with a server-assigned timestamp', async () => {
    const fakeTime = '2001-01-01T00:00:00Z';
    const res = await post({ ...SPOT, description: 'Knee-deep water under the underpass', submittedAt: fakeTime, verification: 'VERIFIED' });
    assert.equal(res.status, 201);
    const { report } = await res.json();
    assert.equal(report.verification, 'UNVERIFIED');
    assert.notEqual(report.submittedAt, new Date(fakeTime).toISOString());
    assert.ok(Math.abs(Date.parse(report.submittedAt) - Date.now()) < 60e3, 'timestamp comes from the server clock');
    assert.equal(Date.parse(report.expiresAt) - Date.parse(report.submittedAt), 3 * 3600e3);
    assert.equal(report.sourceHash, undefined, 'submitter hash is never exposed');
    const { rows } = await pool.query('SELECT source_hash FROM community_reports');
    assert.equal(rows.length, 1);
    assert.ok(rows[0].source_hash && !rows[0].source_hash.includes('10.0.0.1'), 'raw IP is not stored');
  });

  it('rejects invalid coordinates and locations outside Delhi', async () => {
    for (const bad of [{ lat: 'x', lon: 77 }, { lat: 95, lon: 77 }, { lat: 28.6 }, { lat: 19.07, lon: 72.87 }]) {
      assert.equal((await post({ ...bad, description: 'Flooded road' })).status, 400, JSON.stringify(bad));
    }
  });

  it('rejects empty and oversized descriptions', async () => {
    assert.equal((await post({ ...SPOT, description: '' })).status, 400);
    assert.equal((await post({ ...SPOT, description: '   \u0000\u0001  ' })).status, 400);
    assert.equal((await post({ ...SPOT, description: 'x'.repeat(501) })).status, 400);
    assert.equal((await post({ ...SPOT })).status, 400);
  });

  it('rejects oversized request bodies', async () => {
    const res = await post({ ...SPOT, description: 'ok report', padding: 'y'.repeat(20000) });
    assert.equal(res.status, 413);
  });

  it('stores SQL injection attempts as inert text', async () => {
    const payload = "x'); DROP TABLE community_reports; --";
    const res = await post({ ...SPOT, description: payload, locationLabel: "'; DELETE FROM community_reports; --" });
    assert.equal(res.status, 201);
    const { rows } = await pool.query('SELECT description FROM community_reports');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].description, payload);
  });
});

describe('expiry and clustering with PostgreSQL', () => {
  it('clusters two active reports within 100 m and 2 hours', async () => {
    await insertAt(SPOT.lat, SPOT.lon, 1, 'a');
    await insertAt(NEAR.lat, NEAR.lon, 0.2, 'b');
    const body = await (await app.get('/api/reports')).json();
    assert.equal(body.available, true);
    assert.equal(body.reports.length, 2);
    assert.equal(body.clusters.length, 1);
    assert.equal(body.clusters[0].label, 'Corroborated Community Reports');
    assert.equal(body.clusters[0].reportCount, 2);
    assert.equal(body.clusters[0].independenceEstablished, true);
    assert.ok(body.reports.every((r: { clusterId: string }) => r.clusterId === body.clusters[0].id));
  });

  it('does not cluster reports outside the spatial threshold', async () => {
    await insertAt(SPOT.lat, SPOT.lon, 0.5, 'a');
    await insertAt(FAR.lat, FAR.lon, 0.4, 'b');
    const body = await (await app.get('/api/reports')).json();
    assert.equal(body.clusters.length, 0);
  });

  it('does not cluster reports outside the 2-hour window', async () => {
    await insertAt(SPOT.lat, SPOT.lon, 2.8, 'a');
    await insertAt(NEAR.lat, NEAR.lon, 0.1, 'b');
    const body = await (await app.get('/api/reports')).json();
    assert.equal(body.reports.length, 2);
    assert.equal(body.clusters.length, 0);
  });

  it('hides reports older than 3 hours but keeps them in PostgreSQL', async () => {
    const oldId = await insertAt(SPOT.lat, SPOT.lon, 3.1);
    await insertAt(FAR.lat, FAR.lon, 0.5);
    const body = await (await app.get('/api/reports')).json();
    assert.deepEqual(body.reports.map((r: { id: string }) => r.id).includes(oldId), false);
    assert.equal(body.reports.length, 1);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM community_reports');
    assert.equal(rows[0].n, 2, 'expired rows are retained');
  });

  it('a cluster stops qualifying when one of its two reports expires', async () => {
    const id = await insertAt(SPOT.lat, SPOT.lon, 2.0, 'a');
    await insertAt(NEAR.lat, NEAR.lon, 0.5, 'b');
    let body = await (await app.get('/api/reports')).json();
    assert.equal(body.clusters.length, 1);
    // Age the older report past the 3-hour expiry.
    await pool.query("UPDATE community_reports SET submitted_at = now() - interval '3 hours 5 minutes' WHERE id = $1", [id]);
    body = await (await app.get('/api/reports')).json();
    assert.equal(body.reports.length, 1);
    assert.equal(body.clusters.length, 0);
  });

  it('expired reports do not affect route risk; official alerts are unaffected by report expiry', async () => {
    const route = { origin: { lat: 28.6, lon: 77.2 }, destination: { lat: 28.6, lon: 77.25 } };
    const baseline = await (await app.post('/api/routes', route)).json();
    // Expired cluster right on route A.
    await insertAt(28.6, 77.21, 3.5, 'a');
    await insertAt(28.6, 77.2101, 3.4, 'b');
    const withExpired = await (await app.post('/api/routes', route)).json();
    assert.equal(withExpired.candidates[0].risk.score, baseline.candidates[0].risk.score);
    // The fixture alert began 10 hours ago and is still applied.
    assert.ok(withExpired.candidates[0].risk.factors.some((f: { kind: string }) => f.kind === 'ALERT'));
    // Active cluster on route A raises its score.
    await insertAt(28.6, 77.21, 0.3, 'a');
    await insertAt(28.6, 77.2101, 0.2, 'b');
    const withActive = await (await app.post('/api/routes', route)).json();
    assert.ok(withActive.candidates[0].risk.score > baseline.candidates[0].risk.score);
  });

  it('reports the database as connected in health', async () => {
    const body = await (await app.get('/api/health')).json();
    assert.equal(body.services.database, 'CONNECTED');
  });
});

describe('report rate limiting', () => {
  it('blocks submissions beyond the configured limit per IP', async () => {
    const limited = await startApp(
      testDeps({ store, trustProxy: true, reportsPolicy: { ...testDeps().reportsPolicy, submitLimitPerWindow: 2 } }),
    );
    try {
      const send = (ip: string) => limited.post('/api/reports', { ...SPOT, description: 'Flooded road' }, { 'X-Forwarded-For': ip });
      assert.equal((await send('10.9.9.9')).status, 201);
      assert.equal((await send('10.9.9.9')).status, 201);
      const third = await send('10.9.9.9');
      assert.equal(third.status, 429);
      assert.equal((await third.json()).success, false);
      assert.equal((await send('10.8.8.8')).status, 201, 'other clients are unaffected');
    } finally {
      await limited.close();
    }
  });
});
