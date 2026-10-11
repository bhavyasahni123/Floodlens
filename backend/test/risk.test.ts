import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { haversineMeters, pointToPolylineMeters, pointToSegmentMeters } from '../src/geo';
import { loadHotspots } from '../src/hotspots';
import type { CommunityReport, ReportCluster } from '../src/reports/clustering';
import { assessRoute, levelFor, WEIGHTS, type RiskInputs } from '../src/risk';
import { alertFixture, hotspot, NOW, SOUTH_ROUTE, STRAIGHT_ROUTE } from './helpers';

function inputs(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    route: STRAIGHT_ROUTE,
    mode: 'driving',
    nowMs: NOW,
    hotspots: [],
    rainfall: { status: 'LIVE', intensity: 'NONE' },
    alerts: { status: 'LIVE', items: [] },
    community: { available: true, reports: [], clusters: [] },
    ...overrides,
  };
}

function scoreOf(i: RiskInputs): number {
  const r = assessRoute(i);
  assert.equal(r.status, 'ASSESSED');
  return r.score;
}

describe('geospatial distance', () => {
  it('haversine matches a known distance (CP to India Gate ≈ 2.3 km)', () => {
    const d = haversineMeters([28.6315, 77.2167], [28.6129, 77.2295]);
    assert.ok(d > 2300 && d < 2500, `got ${d}`);
  });

  it('measures distance to the middle of a long segment, not just its vertices', () => {
    const p: [number, number] = [28.6009, 77.225]; // ~100 m north of segment midpoint
    const toVertices = Math.min(...STRAIGHT_ROUTE.map((v) => haversineMeters(p, v)));
    const toSegment = pointToSegmentMeters(p, STRAIGHT_ROUTE[0], STRAIGHT_ROUTE[1]);
    assert.ok(toVertices > 2000, `vertex distance ${toVertices}`);
    assert.ok(Math.abs(toSegment - 100) < 3, `segment distance ${toSegment}`);
  });

  it('clamps to the nearest endpoint beyond the segment', () => {
    const p: [number, number] = [28.6, 77.26];
    assert.ok(Math.abs(pointToPolylineMeters(p, STRAIGHT_ROUTE) - haversineMeters(p, [28.6, 77.25])) < 2);
  });
});

describe('risk scoring', () => {
  const near = hotspot('near', 28.6009, 77.225, 'HIGH', 200);

  it('flags a hotspot beside a sparse route segment', () => {
    const r = assessRoute(inputs({ hotspots: [near] }));
    assert.equal(r.status, 'ASSESSED');
    if (r.status !== 'ASSESSED') return;
    assert.equal(r.intersectedHotspots.length, 1);
    assert.equal(r.intersectedHotspots[0].distanceMeters, 100);
    assert.match(r.reason, /Passes 100 m from Fixture near/);
  });

  it('ignores a hotspot outside its buffer', () => {
    const far = hotspot('far', 28.6009, 77.225, 'HIGH', 80); // 100 m away, 80 m buffer
    const r = assessRoute(inputs({ hotspots: [far] }));
    assert.ok(r.status === 'ASSESSED' && r.intersectedHotspots.length === 0);
    assert.equal(scoreOf(inputs({ hotspots: [far] })), WEIGHTS.base);
  });

  it('weights severity HIGH > MODERATE > LOW and closer > farther', () => {
    const at = (sev: 'HIGH' | 'MODERATE' | 'LOW') => scoreOf(inputs({ hotspots: [hotspot('x', 28.6, 77.225, sev)] }));
    assert.ok(at('HIGH') > at('MODERATE') && at('MODERATE') > at('LOW'));
    const close = scoreOf(inputs({ hotspots: [hotspot('c', 28.6, 77.225, 'HIGH', 200)] }));
    const edge = scoreOf(inputs({ hotspots: [hotspot('e', 28.6017, 77.225, 'HIGH', 200)] }));
    assert.ok(close > edge);
  });

  it('keeps scores within 0–100 even with extreme inputs', () => {
    const many = Array.from({ length: 30 }, (_, i) => hotspot(`m${i}`, 28.6, 77.2 + i * 0.001, 'HIGH'));
    const clusters: ReportCluster[] = Array.from({ length: 5 }, (_, i) => cluster(`c${i}`, [28.6, 77.21 + i * 0.005], true));
    const s = scoreOf(
      inputs({
        hotspots: many,
        rainfall: { status: 'LIVE', intensity: 'HEAVY' },
        alerts: { status: 'LIVE', items: [alertFixture(), alertFixture({ id: 'b' }), alertFixture({ id: 'c' })] },
        community: { available: true, reports: [], clusters },
      }),
    );
    assert.ok(s >= 0 && s <= 100, `score ${s}`);
  });

  it('uses documented category boundaries', () => {
    assert.equal(levelFor(34), 'LOW');
    assert.equal(levelFor(35), 'MODERATE');
    assert.equal(levelFor(64), 'MODERATE');
    assert.equal(levelFor(65), 'HIGH');
  });

  it('is reproducible for identical inputs', () => {
    const i = inputs({ hotspots: [near], rainfall: { status: 'LIVE', intensity: 'MODERATE' } });
    assert.deepEqual(assessRoute(i), assessRoute(i));
  });

  it('increases with rainfall intensity', () => {
    const s = (intensity: 'NONE' | 'LIGHT' | 'MODERATE' | 'HEAVY') =>
      scoreOf(inputs({ hotspots: [near], rainfall: { status: 'LIVE', intensity } }));
    assert.ok(s('NONE') < s('LIGHT') && s('LIGHT') < s('MODERATE') && s('MODERATE') < s('HEAVY'));
  });

  it('never lowers the score when rainfall or alerts are missing', () => {
    for (const hs of [[], [near]]) {
      const known = scoreOf(inputs({ hotspots: hs }));
      const noRain = scoreOf(inputs({ hotspots: hs, rainfall: { status: 'UNAVAILABLE', intensity: null } }));
      const noAlerts = scoreOf(inputs({ hotspots: hs, alerts: { status: 'UNAVAILABLE', items: [] } }));
      assert.ok(noRain >= known, `rain missing ${noRain} < ${known}`);
      assert.ok(noAlerts >= known, `alerts missing ${noAlerts} < ${known}`);
    }
    const r = assessRoute(inputs({ rainfall: { status: 'UNAVAILABLE', intensity: null } }));
    assert.ok(r.status === 'ASSESSED' && r.limitations.some((l) => /rainfall unavailable/i.test(l)));
  });

  it('treats stale "no rain" data as at least light rain', () => {
    const fresh = scoreOf(inputs({ hotspots: [near], rainfall: { status: 'LIVE', intensity: 'NONE' } }));
    const stale = scoreOf(inputs({ hotspots: [near], rainfall: { status: 'STALE', intensity: 'NONE' } }));
    const light = scoreOf(inputs({ hotspots: [near], rainfall: { status: 'LIVE', intensity: 'LIGHT' } }));
    assert.ok(stale > fresh);
    assert.equal(stale, light);
  });

  it('refuses to score without the historical dataset', () => {
    assert.equal(assessRoute(inputs({ hotspots: null })).status, 'NOT_ASSESSED');
  });

  it('adds points for an active official flood alert covering the route only', () => {
    const base = scoreOf(inputs());
    const covered = assessRoute(inputs({ alerts: { status: 'LIVE', items: [alertFixture()] } }));
    assert.ok(covered.status === 'ASSESSED' && covered.score === base + WEIGHTS.alert.flood);
    assert.match(covered.status === 'ASSESSED' ? covered.reason : '', /official flood alert/);
    const expired = alertFixture({ effectiveEnd: new Date(NOW - 1000).toISOString() });
    assert.equal(scoreOf(inputs({ alerts: { status: 'LIVE', items: [expired] } })), base);
    const elsewhere = alertFixture({ centroid: [26.9, 75.8] });
    assert.equal(scoreOf(inputs({ alerts: { status: 'LIVE', items: [elsewhere] } })), base);
    const notFlood = alertFixture({ event: 'Heat Wave', floodRelevant: false });
    assert.equal(scoreOf(inputs({ alerts: { status: 'LIVE', items: [notFlood] } })), base);
  });

  it('counts a cluster once regardless of how many reports it contains', () => {
    const small = cluster('a', [28.6, 77.225], true, 2);
    const big = cluster('b', [28.6, 77.225], true, 9);
    assert.equal(
      scoreOf(inputs({ community: { available: true, reports: [], clusters: [small] } })),
      scoreOf(inputs({ community: { available: true, reports: [], clusters: [big] } })),
    );
  });

  it('caps duplicate unclustered reports and weights them below corroborated clusters', () => {
    const reports = Array.from({ length: 10 }, (_, i) => report(String(i), 28.6, 77.21 + i * 0.002));
    const many = scoreOf(inputs({ community: { available: true, reports, clusters: [] } }));
    assert.equal(many, WEIGHTS.base + WEIGHTS.community.singleReportCap);
    const one = scoreOf(inputs({ community: { available: true, reports: [reports[0]], clusters: [] } }));
    const corroborated = scoreOf(inputs({ community: { available: true, reports: [], clusters: [cluster('c', [28.6, 77.225], true)] } }));
    assert.ok(corroborated > one);
  });

  it('treats a cluster without established independence as a single report', () => {
    const sameSource = scoreOf(inputs({ community: { available: true, reports: [], clusters: [cluster('s', [28.6, 77.225], false)] } }));
    assert.equal(sameSource, WEIGHTS.base + WEIGHTS.community.singleReport);
  });

  it('ignores community reports far from the route (expired ones are filtered upstream)', () => {
    const far = report('far', 28.62, 77.225);
    assert.equal(scoreOf(inputs({ community: { available: true, reports: [far], clusters: [] } })), WEIGHTS.base);
  });

  it('adds a travel-mode limitation for walking and cycling', () => {
    const walk = assessRoute(inputs({ mode: 'walking' }));
    const drive = assessRoute(inputs({ mode: 'driving' }));
    assert.ok(walk.status === 'ASSESSED' && /not validated for walking/.test(walk.modeNote ?? ''));
    assert.ok(drive.status === 'ASSESSED' && drive.modeNote === null);
  });

  it('never claims a route is safe', () => {
    const r = assessRoute(inputs({ route: SOUTH_ROUTE }));
    assert.ok(r.status === 'ASSESSED');
    assert.doesNotMatch(JSON.stringify(r), /\bsafe route\b|guaranteed safe|completely safe/i);
    assert.match(r.reason, /does not mean it is flood-free/);
  });

  it('scores the real Delhi dataset: CP→India Gate path avoids hotspots', () => {
    const { dataset } = loadHotspots();
    assert.ok(dataset && dataset.features.length === 22);
    const route: [number, number][] = [
      [28.6315, 77.2167],
      [28.6129, 77.2295],
    ];
    const r = assessRoute(inputs({ route, hotspots: dataset!.features }));
    assert.ok(r.status === 'ASSESSED' && r.level === 'LOW');
  });
});

function report(id: string, lat: number, lon: number): CommunityReport {
  return { id, lat, lon, description: 'water', locationLabel: null, submittedAt: new Date(NOW).toISOString(), sourceHash: `src-${id}` };
}

function cluster(id: string, centroid: [number, number], independent: boolean, count = 2): ReportCluster {
  return {
    id,
    label: 'Corroborated Community Reports',
    verification: 'UNVERIFIED',
    reportIds: Array.from({ length: count }, (_, i) => `${id}-${i}`),
    reportCount: count,
    distinctSources: independent ? count : 1,
    independenceEstablished: independent,
    centroid,
    firstSubmittedAt: new Date(NOW).toISOString(),
    lastSubmittedAt: new Date(NOW).toISOString(),
  };
}
