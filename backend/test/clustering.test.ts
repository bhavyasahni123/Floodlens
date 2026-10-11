import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clusterReports, filterActive, type CommunityReport } from '../src/reports/clustering';

const OPTS = { radiusMeters: 100, windowHours: 2, minReports: 2 };
const T0 = Date.parse('2026-07-15T10:00:00Z');
const H = 3600e3;
// ~0.0009° latitude ≈ 100 m.
const METER_LAT = 1 / 111195;

function r(id: string, northMeters: number, minutesAfter: number, source: string | null = `ip-${id}`): CommunityReport {
  return {
    id,
    lat: 28.6 + northMeters * METER_LAT,
    lon: 77.2,
    description: 'Road flooded',
    locationLabel: null,
    submittedAt: new Date(T0 + minutesAfter * 60e3).toISOString(),
    sourceHash: source,
  };
}

describe('community report clustering', () => {
  it('clusters two reports within 100 m and 2 hours', () => {
    const clusters = clusterReports([r('1', 0, 0), r('2', 80, 60)], OPTS);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].label, 'Corroborated Community Reports');
    assert.equal(clusters[0].verification, 'UNVERIFIED');
    assert.deepEqual(clusters[0].reportIds, ['1', '2']);
    assert.equal(clusters[0].reportCount, 2);
    assert.equal(clusters[0].firstSubmittedAt, new Date(T0).toISOString());
    assert.equal(clusters[0].lastSubmittedAt, new Date(T0 + 60 * 60e3).toISOString());
  });

  it('does not cluster reports more than 100 m apart', () => {
    assert.equal(clusterReports([r('1', 0, 0), r('2', 120, 10)], OPTS).length, 0);
  });

  it('does not cluster reports more than 2 hours apart', () => {
    assert.equal(clusterReports([r('1', 0, 0), r('2', 10, 121)], OPTS).length, 0);
  });

  it('does not chain: every member is within the radius of the seed', () => {
    // A–B 90 m, B–C 90 m, A–C 180 m. B (2 neighbours) seeds; all three join.
    const clusters = clusterReports([r('A', 0, 0), r('B', 90, 5), r('C', 180, 10)], OPTS);
    assert.equal(clusters.length, 1);
    assert.deepEqual(clusters[0].reportIds, ['A', 'B', 'C']);
    // A–B 90 m, C 180 m away with no other partner → only A,B cluster when B is absent? Check a pair that only chains:
    const chainOnly = clusterReports([r('A', 0, 0), r('C', 180, 10)], OPTS);
    assert.equal(chainOnly.length, 0);
  });

  it('never counts the same database row twice', () => {
    const dup = r('1', 0, 0);
    const clusters = clusterReports([dup, { ...dup }], OPTS);
    assert.equal(clusters.length, 0, 'a duplicated row alone must not form a cluster');
  });

  it('is deterministic regardless of input order', () => {
    const reports = [r('1', 0, 0), r('2', 50, 20), r('3', 95, 40), r('4', 300, 10), r('5', 330, 15)];
    const a = clusterReports(reports, OPTS);
    const b = clusterReports([...reports].reverse(), OPTS);
    assert.deepEqual(a, b);
    assert.equal(a.length, 2);
    assert.equal(new Set(a.flatMap((c) => c.reportIds)).size, a.reduce((s, c) => s + c.reportCount, 0));
  });

  it('reports source independence honestly', () => {
    const same = clusterReports([r('1', 0, 0, 'ipX'), r('2', 10, 5, 'ipX')], OPTS)[0];
    assert.equal(same.distinctSources, 1);
    assert.equal(same.independenceEstablished, false);
    const diff = clusterReports([r('1', 0, 0, 'ipX'), r('2', 10, 5, 'ipY')], OPTS)[0];
    assert.equal(diff.independenceEstablished, true);
    const unknown = clusterReports([r('1', 0, 0, null), r('2', 10, 5, null)], OPTS)[0];
    assert.equal(unknown.independenceEstablished, false);
  });

  it('honours configurable thresholds', () => {
    const reports = [r('1', 0, 0), r('2', 150, 0)];
    assert.equal(clusterReports(reports, OPTS).length, 0);
    assert.equal(clusterReports(reports, { ...OPTS, radiusMeters: 200 }).length, 1);
    assert.equal(clusterReports(reports, { ...OPTS, radiusMeters: 200, minReports: 3 }).length, 0);
  });
});

describe('community report expiry', () => {
  it('keeps reports younger than 3 hours and drops older or future-dated ones', () => {
    const now = T0 + 4 * H;
    const reports = [r('old', 0, 0), r('edge', 0, 60), r('fresh', 0, 200), r('future', 0, 300)];
    const active = filterActive(reports, now, { expiryHours: 3 });
    assert.deepEqual(active.map((x) => x.id), ['fresh']);
  });

  it('a cluster stops qualifying once one of its two reports expires', () => {
    const a = r('1', 0, 0);
    const b = r('2', 40, 90); // 1.5 h later
    const before = filterActive([a, b], T0 + 2 * H, { expiryHours: 3 });
    assert.equal(clusterReports(before, OPTS).length, 1);
    const after = filterActive([a, b], T0 + 3 * H + 60e3, { expiryHours: 3 });
    assert.deepEqual(after.map((x) => x.id), ['2']);
    assert.equal(clusterReports(after, OPTS).length, 0);
  });
});
