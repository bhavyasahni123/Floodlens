import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AlertsData } from '../src/providers/alerts';
import { RoutingError } from '../src/providers/routing';
import { alertFixture, live, rainfallFixture, routeFixture, startApp, STRAIGHT_ROUTE, testDeps, unavailable } from './helpers';

type App = Awaited<ReturnType<typeof startApp>>;
const ORIGIN = { lat: 28.6, lon: 77.2, label: 'Start' };
const DEST = { lat: 28.6, lon: 77.25, label: 'End' };

describe('API: health, hazards and intelligence', () => {
  let app: App;
  before(async () => (app = await startApp(testDeps())));
  after(() => app.close());

  it('GET /api/health reports database not configured', async () => {
    const body = await (await app.get('/api/health')).json();
    assert.equal(body.success, true);
    assert.equal(body.services.database, 'NOT_CONFIGURED');
  });

  it('GET /api/hazards keeps its contract', async () => {
    const body = await (await app.get('/api/hazards')).json();
    assert.equal(body.success, true);
    assert.equal(body.count, 1);
    assert.equal(body.features[0].type, 'Feature');
    assert.ok(body.metadata);
  });

  it('sets security headers and restricts CORS', async () => {
    const ok = await fetch(app.base + '/api/health', { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'http://localhost:5173');
    assert.ok(ok.headers.get('x-content-type-options'));
    const bad = await fetch(app.base + '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  it('GET /api/intelligence returns per-source status with source info', async () => {
    const body = await (await app.get('/api/intelligence')).json();
    assert.equal(body.rainfall.status, 'LIVE');
    assert.equal(body.rainfall.source.nature, 'MODELLED');
    assert.equal(body.river.status, 'LIVE');
    assert.equal(body.alerts.source.nature, 'OFFICIAL');
    assert.equal(body.community.status, 'UNAVAILABLE');
    assert.equal(body.community.policy.expiryHours, 3);
    assert.equal(body.community.policy.clusterRadiusMeters, 100);
  });

  it('unknown API paths return JSON 404', async () => {
    const res = await app.get('/api/nope');
    assert.equal(res.status, 404);
    assert.equal((await res.json()).success, false);
  });

  it('GET /api/geocode validates input length', async () => {
    assert.equal((await app.get('/api/geocode?q=ab')).status, 400);
    const body = await (await app.get('/api/geocode?q=india')).json();
    assert.equal(body.results[0].label, 'India Gate');
  });
});

describe('API: unavailable live sources', () => {
  let app: App;
  before(async () => {
    app = await startApp(
      testDeps({ getRainfall: async () => unavailable(), getRiver: async () => unavailable(), getAlerts: async () => unavailable() }),
    );
  });
  after(() => app.close());

  it('reports UNAVAILABLE without inventing values', async () => {
    for (const p of ['/api/rainfall', '/api/river', '/api/alerts']) {
      const body = await (await app.get(p)).json();
      assert.equal(body.status, 'UNAVAILABLE', p);
      assert.equal(body.data, null, p);
      assert.ok(body.error, p);
    }
  });

  it('still assesses routes, discloses the gaps and does not lower the score', async () => {
    const body = await (await app.post('/api/routes', { origin: ORIGIN, destination: DEST })).json();
    assert.equal(body.success, true);
    const risk = body.candidates[0].risk;
    assert.equal(risk.inputs.rainfall, 'UNAVAILABLE');
    assert.equal(risk.inputs.alerts, 'UNAVAILABLE');
    assert.ok(risk.limitations.length >= 2);
  });
});

describe('API: routes', () => {
  let app: App;
  let calls = 0;
  let mode: 'ok' | 'down' | 'none' | 'single' = 'ok';
  before(async () => {
    app = await startApp(
      testDeps({
        getAlerts: async () => live<AlertsData>({ alerts: [alertFixture({ centroid: [28.6009, 77.225], approxRadiusKm: 0.3 })], nationalCount: 1 }),
        getRainfall: async () => live(rainfallFixture('LIGHT')),
        fetchRoutes: async (o, d, m) => {
          calls++;
          if (mode === 'down') throw new RoutingError('The routing service did not respond. Please retry.', 'PROVIDER_UNAVAILABLE');
          if (mode === 'none') throw new RoutingError('No route was found.', 'NO_ROUTE');
          if (mode === 'single') return [routeFixture(STRAIGHT_ROUTE, 10), routeFixture([...STRAIGHT_ROUTE], 10)];
          return testDeps().fetchRoutes(o, d, m);
        },
      }),
    );
  });
  after(() => app.close());

  it('returns distinct candidates with preference picks', async () => {
    mode = 'ok';
    const res = await app.post('/api/routes', { origin: ORIGIN, destination: DEST, mode: 'Fastest' });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.candidates.length, 2);
    // Route A is faster but passes the hotspot and the alert; B is slower but clear.
    assert.equal(body.preferences.fastest, 'A');
    assert.equal(body.preferences.lowerRisk, 'B');
    assert.equal(body.selectedId, 'A');
    assert.ok(body.candidates[0].risk.score > body.candidates[1].risk.score);
    assert.match(body.recommendation.message, /lower assessed risk among available routes/);
    for (const c of body.candidates) {
      assert.ok(c.risk.score >= 0 && c.risk.score <= 100);
      assert.ok(['LOW', 'MODERATE', 'HIGH'].includes(c.risk.level));
      assert.ok(c.risk.reason.length > 0);
    }
    // Legacy fields still present.
    assert.equal(body.status, 'ROUTE_CALCULATED');
    assert.ok(Array.isArray(body.route) && body.alternatives.length === 2);
  });

  it('accepts the legacy "Risk-averse" preference and text locations', async () => {
    const body = await (await app.post('/api/routes', { origin: 'Connaught Place', destination: 'India Gate', mode: 'Risk-averse' })).json();
    assert.equal(body.routeRequest.mode, 'Lower Risk');
    assert.equal(body.selectedId, body.preferences.lowerRisk);
  });

  it('does not invent alternatives when the provider returns duplicates', async () => {
    mode = 'single';
    const body = await (await app.post('/api/routes', { origin: ORIGIN, destination: DEST })).json();
    assert.equal(body.candidates.length, 1);
    assert.equal(body.rawAlternativesReturned, 2);
    assert.match(body.notes.join(' '), /only one distinct route/);
  });

  it('reports provider failure as retryable 502 without a route', async () => {
    mode = 'down';
    const res = await app.post('/api/routes', { origin: ORIGIN, destination: DEST });
    const body = await res.json();
    assert.equal(res.status, 502);
    assert.equal(body.success, false);
    assert.equal(body.retryable, true);
    assert.equal(body.route, undefined);
  });

  it('reports no-route as 404', async () => {
    mode = 'none';
    const res = await app.post('/api/routes', { origin: ORIGIN, destination: DEST, travelMode: 'walking' });
    assert.equal(res.status, 404);
  });

  it('validates inputs', async () => {
    mode = 'ok';
    const before = calls;
    assert.equal((await app.post('/api/routes', { origin: '', destination: DEST })).status, 400);
    assert.equal((await app.post('/api/routes', { origin: { lat: 200, lon: 0 }, destination: DEST })).status, 400);
    assert.equal((await app.post('/api/routes', { origin: ORIGIN, destination: DEST, travelMode: 'boat' })).status, 400);
    assert.equal((await app.post('/api/routes', { origin: ORIGIN, destination: DEST, mode: 'Scenic' })).status, 400);
    assert.equal((await app.post('/api/routes', '{bad json')).status, 400);
    assert.equal(calls, before, 'invalid requests never reach the routing provider');
  });

  it('returns 404 when a text place cannot be found', async () => {
    const res = await app.post('/api/routes', { origin: 'nowhere', destination: DEST });
    assert.equal(res.status, 404);
  });

  it('flags routes outside the Delhi coverage area', async () => {
    const body = await (await app.post('/api/routes', { origin: { lat: 19.07, lon: 72.87 }, destination: DEST })).json();
    assert.equal(body.coverage.inCoverage, false);
    assert.match(body.candidates[0].risk.limitations[0], /covers Delhi/);
  });

  it('adds a travel-mode note for walking', async () => {
    const body = await (await app.post('/api/routes', { origin: ORIGIN, destination: DEST, travelMode: 'walking' })).json();
    assert.match(body.candidates[0].risk.modeNote, /not validated for walking/);
    assert.equal(body.routeRequest.travelMode, 'walking');
  });
});

describe('API: reports without a database', () => {
  let app: App;
  before(async () => (app = await startApp(testDeps())));
  after(() => app.close());

  it('GET reports says unavailable; POST returns 503', async () => {
    const list = await (await app.get('/api/reports')).json();
    assert.equal(list.available, false);
    const res = await app.post('/api/reports', { lat: 28.6, lon: 77.2, description: 'Flooded road here' });
    assert.equal(res.status, 503);
  });
});
