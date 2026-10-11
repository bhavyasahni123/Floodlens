import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config';
import { isActive, parseSachet, parseSachetDate } from '../src/providers/alerts';
import { classifyRate, intensityForRoute, parseOpenMeteo } from '../src/providers/rainfall';
import { parseFloodApi } from '../src/providers/river';
import { dedupeRoutes } from '../src/providers/routing';
import { createSourceCache } from '../src/sourceCache';
import { NOW, routeFixture, SOUTH_ROUTE, STRAIGHT_ROUTE } from './helpers';

describe('source cache freshness', () => {
  it('reports LIVE, then STALE after a failed refresh, then UNAVAILABLE', async () => {
    let clock = 0;
    let fail = false;
    const cache = createSourceCache({
      ttlMs: 1000,
      maxStaleMs: 5000,
      now: () => clock,
      load: async () => {
        if (fail) throw new Error('upstream down');
        return { v: clock };
      },
    });
    const first = await cache.get();
    assert.equal(first.status, 'LIVE');
    fail = true;
    clock = 2000;
    const stale = await cache.get();
    assert.equal(stale.status, 'STALE');
    assert.deepEqual(stale.data, { v: 0 });
    assert.equal(stale.retrievedAt, new Date(0).toISOString(), 'age of the old data is disclosed');
    assert.equal(stale.error, 'upstream down');
    clock = 6000;
    const gone = await cache.get();
    assert.equal(gone.status, 'UNAVAILABLE');
    assert.equal(gone.data, null);
  });

  it('never reports a failed first fetch as successful', async () => {
    const cache = createSourceCache({ ttlMs: 1000, maxStaleMs: 5000, load: async () => { throw new Error('boom'); } });
    const r = await cache.get();
    assert.equal(r.status, 'UNAVAILABLE');
    assert.equal(r.retrievedAt, null);
  });
});

describe('Open-Meteo rainfall parsing', () => {
  const hour = 3600;
  const t0 = NOW / 1000;
  const loc = (values: (number | null)[]) => ({
    latitude: 28.6,
    longitude: 77.2,
    hourly: { time: values.map((_, i) => t0 + (i - 3) * hour), precipitation: values },
  });

  it('separates estimated past hours from forecast hours and summarises them', () => {
    const raw = config.city.rainfallSamples.map(() => loc([1, 2, 3, 4, 8, 0.2]));
    const data = parseOpenMeteo(raw, NOW);
    const s = data.samples[0];
    assert.deepEqual(s.series.map((p) => p.kind), ['ESTIMATED_PAST', 'ESTIMATED_PAST', 'ESTIMATED_PAST', 'ESTIMATED_PAST', 'FORECAST', 'FORECAST']);
    assert.equal(s.summary.past3hMm, 9);
    assert.equal(s.summary.next3hMm, 8.2);
    assert.equal(s.summary.intensity, 'HEAVY');
  });

  it('skips missing values instead of inventing zeros', () => {
    const raw = config.city.rainfallSamples.map(() => loc([null, 1, null, 2, null]));
    const s = parseOpenMeteo(raw, NOW).samples[0];
    assert.equal(s.series.length, 2);
  });

  it('rejects a response with the wrong number of locations', () => {
    assert.throws(() => parseOpenMeteo([loc([1])], NOW));
  });

  it('classifies hourly rates', () => {
    assert.equal(classifyRate(0.2), 'NONE');
    assert.equal(classifyRate(1), 'LIGHT');
    assert.equal(classifyRate(5), 'MODERATE');
    assert.equal(classifyRate(10), 'HEAVY');
  });

  it('uses the worst intensity among samples nearest the route', () => {
    const values = config.city.rainfallSamples.map((s) => loc(s.id === 'east' ? [0, 0, 0, 9] : [0, 0, 0, 0]));
    const data = parseOpenMeteo(values, NOW);
    assert.equal(intensityForRoute(data, [[28.63, 77.3]]).intensity, 'HEAVY');
    assert.equal(intensityForRoute(data, [[28.52, 77.22]]).intensity, 'NONE');
  });
});

describe('GloFAS river parsing', () => {
  it('labels past as modelled, future as forecast, and detects a rising trend', () => {
    const data = parseFloodApi(
      { latitude: 28.625, longitude: 77.225, daily: { time: ['2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17'], river_discharge: [380, 400, 450, 520] } },
      '2026-07-15',
    );
    assert.equal(data.todayM3s, 400);
    assert.equal(data.forecastPeakM3s, 520);
    assert.equal(data.trend, 'RISING');
    assert.deepEqual(data.days.map((d) => d.kind), ['MODELLED_PAST', 'MODELLED_PAST', 'FORECAST', 'FORECAST']);
  });

  it('throws on an empty response rather than reporting zero discharge', () => {
    assert.throws(() => parseFloodApi({ latitude: 0, longitude: 0, daily: { time: ['2026-07-15'], river_discharge: [null] } }, '2026-07-15'));
  });
});

describe('SACHET official alerts parsing', () => {
  it('parses IST timestamps', () => {
    assert.equal(parseSachetDate('Sun Oct 11 12:27:00 IST 2026'), '2026-10-11T06:57:00.000Z');
    assert.equal(parseSachetDate('garbage'), null);
  });

  it('keeps only alerts near or naming Delhi and flags flood relevance', () => {
    const records = [
      { identifier: 1, disaster_type: 'Heavy Rain', area_description: 'South Delhi', centroid: '77.2,28.5', area_covered: '250', effective_end_time: 'Sun Oct 11 15:27:00 IST 2026', alert_source: 'IMD New Delhi' },
      { identifier: 2, disaster_type: 'Thunderstorms with Hail', area_description: 'Kangra', centroid: '76.53,32.34', area_covered: '29739' },
      { identifier: 3, disaster_type: 'Heat Wave', area_description: 'Gurugram', centroid: '77.03,28.46', area_covered: '1200' },
      { identifier: 4, disaster_type: 'Flood', area_description: 'bad centroid', centroid: 'x,y' },
    ];
    const data = parseSachet(records);
    assert.equal(data.nationalCount, 4);
    assert.deepEqual(data.alerts.map((a) => a.id), ['1', '3']);
    assert.equal(data.alerts[0].floodRelevant, true);
    assert.equal(data.alerts[1].floodRelevant, false);
    assert.equal(data.alerts[0].centroid[0], 28.5);
    assert.match(data.alerts[0].sourceUrl, /identifier=1$/);
    assert.ok(Math.abs(data.alerts[0].approxRadiusKm! - Math.sqrt(250 / Math.PI)) < 1e-9);
  });

  it('treats alerts past their end time as inactive', () => {
    const [a] = parseSachet([{ identifier: 1, disaster_type: 'Flood', area_description: 'Delhi', centroid: '77.2,28.6', effective_end_time: 'Sun Oct 11 15:27:00 IST 2026' }]).alerts;
    assert.equal(isActive(a, Date.parse('2026-10-11T09:00:00Z')), true);
    assert.equal(isActive(a, Date.parse('2026-10-11T10:00:00Z')), false);
  });
});

describe('route alternatives', () => {
  it('removes duplicate geometry but keeps genuinely different routes', () => {
    const a = routeFixture(STRAIGHT_ROUTE, 10);
    const aCopy = routeFixture([...STRAIGHT_ROUTE], 10.2);
    const b = routeFixture(SOUTH_ROUTE, 12);
    assert.equal(dedupeRoutes([a, aCopy, b]).length, 2);
  });
});
