import crypto from 'node:crypto';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config';
import { buildDirections } from './directions';
import type { LatLon } from './geo';
import { loadHotspots, type HazardDataset } from './hotspots';
import { ALERTS_SOURCE_INFO, alertsSource, type AlertsData } from './providers/alerts';
import { GeocodingError, geocodeOne, suggestPlaces, type PlaceSuggestion } from './providers/geocoding';
import { intensityForRoute, RAINFALL_SOURCE_INFO, rainfallSource, type RainfallData } from './providers/rainfall';
import { RIVER_SOURCE_INFO, riverSource, type RiverData } from './providers/river';
import { dedupeRoutes, fetchOsrmRoutes, ROUTING_PROVIDERS, RoutingError, type RawRoute } from './providers/routing';
import { clusterReports, filterActive, type CommunityReport, type ReportCluster } from './reports/clustering';
import type { ReportStore } from './reports/store';
import { assessRoute, MODEL_VERSION, WEIGHTS, type TravelMode } from './risk';
import { PREFERENCES, pickPreferences, preferenceNotes, recommendation, type Candidate, type Preference } from './routePlanner';
import type { SourceResult } from './sourceCache';

export type AppDeps = {
  store: ReportStore | null;
  hazards: HazardDataset | null;
  getRainfall: () => Promise<SourceResult<RainfallData>>;
  getRiver: () => Promise<SourceResult<RiverData>>;
  getAlerts: () => Promise<SourceResult<AlertsData>>;
  fetchRoutes: (origin: LatLon, destination: LatLon, mode: TravelMode) => Promise<RawRoute[]>;
  suggest: (q: string) => Promise<{ provider: string; results: PlaceSuggestion[] }>;
  geocode: (q: string) => Promise<PlaceSuggestion | null>;
  reportsPolicy: typeof config.reports;
  hashSecret: string;
  corsOrigins: string[];
  trustProxy?: boolean;
  /** Requests per minute per IP for routing and place search (default 60). */
  generalLimitPerMinute?: number;
};

export function defaultDeps(store: ReportStore | null): AppDeps {
  const { dataset, error } = loadHotspots();
  if (error) console.error('Hotspot dataset failed to load:', error);
  return {
    store,
    hazards: dataset,
    getRainfall: rainfallSource.get,
    getRiver: riverSource.get,
    getAlerts: alertsSource.get,
    fetchRoutes: fetchOsrmRoutes,
    suggest: suggestPlaces,
    geocode: geocodeOne,
    reportsPolicy: config.reports,
    hashSecret: config.reportHashSecret,
    corsOrigins: config.corsOrigins,
  };
}

const TRAVEL_MODES: TravelMode[] = ['driving', 'walking', 'cycling'];
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function fail(res: Response, status: number, message: string, extra: Record<string, unknown> = {}) {
  res.status(status).json({ success: false, message, ...extra });
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function inCityArea([lat, lon]: LatLon, marginDeg = 0): boolean {
  const [w, s, e, n] = config.city.bbox;
  return lat >= s - marginDeg && lat <= n + marginDeg && lon >= w - marginDeg && lon <= e + marginDeg;
}

type LocationInput = { coords: LatLon; label: string } | { text: string } | { error: string };

function parseLocationInput(value: unknown, name: string): LocationInput {
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return { error: `${name} is required.` };
    if (text.length > 200) return { error: `${name} is too long.` };
    return { text };
  }
  if (value && typeof value === 'object') {
    const { lat, lon, label } = value as Record<string, unknown>;
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { error: `${name} has invalid coordinates.` };
    }
    const cleanLabel = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    return { coords: [lat, lon], label: cleanLabel };
  }
  return { error: `${name} is required.` };
}

function publicReport(r: CommunityReport, expiryHours: number, clusterId: string | null) {
  return {
    id: r.id,
    lat: r.lat,
    lon: r.lon,
    description: r.description,
    locationLabel: r.locationLabel,
    submittedAt: r.submittedAt,
    expiresAt: new Date(new Date(r.submittedAt).getTime() + expiryHours * 3600e3).toISOString(),
    verification: 'UNVERIFIED' as const,
    clusterId,
  };
}

function sourceEnvelope<T>(result: SourceResult<T>, info: object) {
  return { ...result, source: info };
}

export function createApp(deps: AppDeps) {
  const app = express();
  if (deps.trustProxy) app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || deps.corsOrigins.includes(origin)),
      methods: ['GET', 'POST'],
    }),
  );
  app.use(express.json({ limit: '10kb' }));

  const limiterMessage = (message: string) => ({ success: false, message });
  const generalLimiter = rateLimit({
    windowMs: 60e3,
    limit: deps.generalLimitPerMinute ?? 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limiterMessage('Too many requests. Please wait a minute and retry.'),
  });
  const reportLimiter = rateLimit({
    windowMs: deps.reportsPolicy.submitWindowMinutes * 60e3,
    limit: deps.reportsPolicy.submitLimitPerWindow,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: limiterMessage('Report limit reached. Please wait before submitting another report.'),
  });

  // Community data shared by routes, intelligence and reports endpoints.
  async function loadCommunity(): Promise<
    { available: true; reports: CommunityReport[]; clusters: ReportCluster[]; nowMs: number } | { available: false; reason: string }
  > {
    if (!deps.store) return { available: false, reason: 'Database is not configured (DATABASE_URL is not set).' };
    try {
      const { reports, nowMs } = await deps.store.listActive(deps.reportsPolicy.expiryHours);
      // Re-apply the policy in code as well, so the rule holds even if the query changes.
      const active = filterActive(reports, nowMs, deps.reportsPolicy);
      const clusters = clusterReports(active, {
        radiusMeters: deps.reportsPolicy.clusterRadiusMeters,
        windowHours: deps.reportsPolicy.clusterWindowHours,
        minReports: deps.reportsPolicy.clusterMinReports,
      });
      return { available: true, reports: active, clusters, nowMs };
    } catch (error) {
      console.error('Loading community reports failed:', error instanceof Error ? error.message : error);
      return { available: false, reason: 'The report database could not be reached.' };
    }
  }

  const policy = () => ({
    expiryHours: deps.reportsPolicy.expiryHours,
    clusterRadiusMeters: deps.reportsPolicy.clusterRadiusMeters,
    clusterWindowHours: deps.reportsPolicy.clusterWindowHours,
    clusterMinReports: deps.reportsPolicy.clusterMinReports,
  });

  app.get('/api/health', async (_req, res) => {
    let database = 'NOT_CONFIGURED';
    if (deps.store) {
      database = await deps.store.ping().then(() => 'CONNECTED', () => 'UNREACHABLE');
    }
    res.json({
      success: true,
      message: 'FloodLens backend is running',
      city: config.city.name,
      services: { database, hotspots: deps.hazards ? deps.hazards.features.length : 'UNAVAILABLE' },
    });
  });

  app.get('/api/hazards', (_req, res) => {
    if (!deps.hazards) return fail(res, 503, 'Historical hotspot data is unavailable.');
    res.json({
      success: true,
      metadata: deps.hazards.metadata,
      count: deps.hazards.features.length,
      features: deps.hazards.features,
    });
  });

  app.get('/api/geocode', generalLimiter, async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q.length < 3) return fail(res, 400, 'Type at least 3 characters to search.');
    if (q.length > 200) return fail(res, 400, 'Search text is too long.');
    try {
      const { provider, results } = await deps.suggest(q);
      res.json({ success: true, provider, results });
    } catch (error) {
      const rateLimited = error instanceof GeocodingError && error.rateLimited;
      fail(res, rateLimited ? 429 : 502, error instanceof Error ? error.message : 'Place search failed.');
    }
  });

  app.get('/api/rainfall', async (_req, res) => {
    res.json({ success: true, ...sourceEnvelope(await deps.getRainfall(), RAINFALL_SOURCE_INFO) });
  });
  app.get('/api/river', async (_req, res) => {
    res.json({ success: true, ...sourceEnvelope(await deps.getRiver(), RIVER_SOURCE_INFO) });
  });
  app.get('/api/alerts', async (_req, res) => {
    res.json({ success: true, ...sourceEnvelope(await deps.getAlerts(), ALERTS_SOURCE_INFO) });
  });

  /** Everything the Monsoon & Flood Risk panel needs, each source with its own status and timestamps. */
  app.get('/api/intelligence', async (_req, res) => {
    const [rainfall, river, alerts, community] = await Promise.all([
      deps.getRainfall(),
      deps.getRiver(),
      deps.getAlerts(),
      loadCommunity(),
    ]);
    res.json({
      success: true,
      generatedAt: new Date().toISOString(),
      city: config.city.name,
      rainfall: sourceEnvelope(rainfall, RAINFALL_SOURCE_INFO),
      river: sourceEnvelope(river, RIVER_SOURCE_INFO),
      alerts: sourceEnvelope(alerts, ALERTS_SOURCE_INFO),
      hotspots: deps.hazards
        ? { status: 'AVAILABLE', count: deps.hazards.features.length, metadata: deps.hazards.metadata }
        : { status: 'UNAVAILABLE' },
      community: community.available
        ? {
            status: 'AVAILABLE',
            policy: policy(),
            activeCount: community.reports.length,
            clusterCount: community.clusters.length,
            serverTime: new Date(community.nowMs).toISOString(),
          }
        : { status: 'UNAVAILABLE', reason: community.reason, policy: policy() },
    });
  });

  app.post('/api/routes', generalLimiter, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const originIn = parseLocationInput(body.origin, 'Origin');
    const destIn = parseLocationInput(body.destination, 'Destination');
    if ('error' in originIn) return fail(res, 400, originIn.error);
    if ('error' in destIn) return fail(res, 400, destIn.error);

    const travelMode = (body.travelMode ?? 'driving') as TravelMode;
    if (!TRAVEL_MODES.includes(travelMode)) return fail(res, 400, 'Travel mode must be driving, walking or cycling.');
    // "Risk-averse" is accepted as a legacy alias of "Lower Risk".
    const rawPref = body.mode === 'Risk-averse' ? 'Lower Risk' : (body.mode ?? 'Balanced');
    if (!PREFERENCES.includes(rawPref as Preference)) return fail(res, 400, 'Preference must be Fastest, Balanced or Lower Risk.');
    const preference = rawPref as Preference;

    let origin: { coords: LatLon; label: string };
    let destination: { coords: LatLon; label: string };
    try {
      const resolve = async (input: Exclude<LocationInput, { error: string }>) => {
        if ('coords' in input) return input;
        const place = await deps.geocode(input.text);
        return place ? { coords: [place.lat, place.lon] as LatLon, label: [place.label, place.detail].filter(Boolean).join(', ') } : null;
      };
      const [o, d] = await Promise.all([resolve(originIn), resolve(destIn)]);
      if (!o || !d) return fail(res, 404, 'Could not find one or both places. Try a more specific address.', { retryable: false });
      origin = o;
      destination = d;
    } catch (error) {
      return fail(res, 502, error instanceof Error ? error.message : 'Place search failed.', { retryable: true });
    }

    let raw: RawRoute[];
    try {
      raw = await deps.fetchRoutes(origin.coords, destination.coords, travelMode);
    } catch (error) {
      if (error instanceof RoutingError && error.code === 'NO_ROUTE') {
        return fail(res, 404, error.message, { retryable: false });
      }
      console.error('Routing failed:', error instanceof Error ? error.message : error);
      return fail(res, 502, error instanceof RoutingError ? error.message : 'The routing service failed. Please retry.', { retryable: true });
    }
    const distinct = dedupeRoutes(raw);
    if (distinct.length === 0) return fail(res, 404, 'The routing service returned no usable route.', { retryable: true });

    const [rainfall, alerts, community] = await Promise.all([deps.getRainfall(), deps.getAlerts(), loadCommunity()]);
    const nowMs = Date.now();

    const hotspotPoint = new Map((deps.hazards?.features ?? []).map((f) => [f.id, [f.geometry.coordinates[1], f.geometry.coordinates[0]] as LatLon]));
    const candidates: (Candidate & { steps: ReturnType<typeof buildDirections> })[] = distinct.map((r, i) => {
      const samplePoints: LatLon[] = [r.coords[0], r.coords[Math.floor(r.coords.length / 2)], r.coords[r.coords.length - 1]];
      const rain = rainfall.data ? intensityForRoute(rainfall.data, samplePoints) : null;
      const risk = assessRoute({
        route: r.coords,
        mode: travelMode,
        nowMs,
        hotspots: deps.hazards ? deps.hazards.features : null,
        rainfall: { status: rainfall.status, intensity: rain?.intensity ?? null, areas: rain?.sampleNames },
        alerts: { status: alerts.status, items: alerts.data?.alerts ?? [] },
        community: community.available
          ? { available: true, reports: community.reports, clusters: community.clusters }
          : { available: false, reports: [], clusters: [] },
      });
      const nearby = risk.status === 'ASSESSED' ? risk.intersectedHotspots : [];
      const steps = buildDirections(
        r.steps ?? [],
        nearby.flatMap((h) => (hotspotPoint.has(h.id) ? [{ name: h.name, point: hotspotPoint.get(h.id)! }] : [])),
      );
      return {
        id: String.fromCharCode(65 + i),
        steps,
        route: r.coords,
        distanceKm: Number((r.distanceM / 1000).toFixed(2)),
        durationMinutes: Math.max(1, Math.round(r.durationS / 60)),
        risk,
      };
    });

    const inCoverage = inCityArea(origin.coords, 0.05) && inCityArea(destination.coords, 0.05);
    if (!inCoverage) {
      for (const c of candidates) {
        if (c.risk.status === 'ASSESSED') {
          c.risk.limitations.unshift(`Hotspot data covers ${config.city.name} only; parts of this route are outside it.`);
        }
      }
    }

    const picks = pickPreferences(candidates);
    const selectedId =
      (preference === 'Fastest' ? picks.fastest : preference === 'Balanced' ? picks.balanced : picks.lowerRisk) ?? picks.fastest;
    const selected = candidates.find((c) => c.id === selectedId)!;
    const notes = preferenceNotes(candidates, picks);
    if (preference !== 'Fastest' && picks.lowerRisk === null) {
      notes.push(`${preference} could not be applied; showing the fastest route.`);
    }

    res.json({
      success: true,
      message: 'Route calculated successfully.',
      assessedAt: new Date(nowMs).toISOString(),
      routeRequest: { origin: origin.label, destination: destination.label, mode: preference, travelMode },
      originCoordinates: origin.coords,
      destinationCoordinates: destination.coords,
      provider: { name: ROUTING_PROVIDERS[travelMode].name, url: ROUTING_PROVIDERS[travelMode].url },
      coverage: { inCoverage, area: config.city.name },
      candidates: candidates.map((c) => ({
        ...c,
        preferences: [
          c.id === picks.fastest ? 'Fastest' : null,
          c.id === picks.balanced ? 'Balanced' : null,
          c.id === picks.lowerRisk ? 'Lower Risk' : null,
        ].filter(Boolean),
      })),
      preferences: picks,
      selectedId,
      notes,
      recommendation: recommendation(candidates, picks, selectedId),
      rawAlternativesReturned: raw.length,
      // Legacy fields describing the selected route (kept for API compatibility).
      status: 'ROUTE_CALCULATED',
      route: selected.route,
      distanceKm: selected.distanceKm,
      durationMinutes: selected.durationMinutes,
      risk: selected.risk,
      alternativesEvaluated: candidates.length,
      alternatives: candidates.map((c) => ({
        routeIndex: c.id.charCodeAt(0) - 65,
        distanceKm: c.distanceKm,
        durationMinutes: c.durationMinutes,
        riskLevel: c.risk.status === 'ASSESSED' ? c.risk.level : null,
        riskScore: c.risk.status === 'ASSESSED' ? c.risk.score : null,
        isSelected: c.id === selectedId,
      })),
    });
  });

  app.get('/api/risk-model', (_req, res) => {
    res.json({ success: true, modelVersion: MODEL_VERSION, weights: WEIGHTS, documentation: 'backend/RISK_MODEL.md' });
  });

  app.get('/api/reports', async (_req, res) => {
    const community = await loadCommunity();
    if (!community.available) {
      return res.json({ success: true, available: false, reason: community.reason, policy: policy(), reports: [], clusters: [] });
    }
    const clusterOf = new Map<string, string>();
    community.clusters.forEach((c) => c.reportIds.forEach((id) => clusterOf.set(id, c.id)));
    res.json({
      success: true,
      available: true,
      policy: policy(),
      serverTime: new Date(community.nowMs).toISOString(),
      reports: community.reports.map((r) => publicReport(r, deps.reportsPolicy.expiryHours, clusterOf.get(r.id) ?? null)),
      clusters: community.clusters,
    });
  });

  app.post('/api/reports', reportLimiter, async (req: Request, res: Response) => {
    if (!deps.store) return fail(res, 503, 'Community reports are unavailable: the database is not configured.');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const { lat, lon } = body;
    if (!isFiniteNumber(lat) || !isFiniteNumber(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return fail(res, 400, 'A valid map location (latitude and longitude) is required.');
    }
    if (!inCityArea([lat, lon], 0.15)) {
      return fail(res, 400, `Reports are currently accepted for ${config.city.name} only.`);
    }
    if (typeof body.description !== 'string') return fail(res, 400, 'Description is required.');
    const description = body.description.replace(CONTROL_CHARS, '').replace(/[ \t]+/g, ' ').trim();
    const { descriptionMin, descriptionMax } = deps.reportsPolicy;
    if (description.length < descriptionMin || description.length > descriptionMax) {
      return fail(res, 400, `Description must be between ${descriptionMin} and ${descriptionMax} characters.`);
    }
    let locationLabel: string | null = null;
    if (typeof body.locationLabel === 'string' && body.locationLabel.trim()) {
      locationLabel = body.locationLabel.replace(CONTROL_CHARS, '').trim().slice(0, 200);
    }
    // Any client-supplied timestamp is ignored: the database assigns submitted_at.
    const ip = req.ip ?? '';
    const sourceHash = ip ? crypto.createHmac('sha256', deps.hashSecret).update(ip).digest('hex').slice(0, 16) : null;
    try {
      const saved = await deps.store.insert({ lat, lon, description, locationLabel, sourceHash });
      res.status(201).json({
        success: true,
        message: 'Report submitted. It is shown as unverified and leaves the active map after ' +
          `${deps.reportsPolicy.expiryHours} hours.`,
        report: publicReport(saved, deps.reportsPolicy.expiryHours, null),
      });
    } catch (error) {
      console.error('Saving report failed:', error instanceof Error ? error.message : error);
      fail(res, 503, 'Could not save the report right now. Please try again later.');
    }
  });

  app.use('/api', (_req, res) => fail(res, 404, 'API endpoint not found.'));

  // Malformed JSON or oversized bodies → clean 4xx instead of an HTML stack trace.
  app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.too.large') return fail(res, 413, 'Request body is too large.');
    if (err.type === 'entity.parse.failed') return fail(res, 400, 'Request body must be valid JSON.');
    console.error('Unhandled error:', err.message);
    fail(res, err.status && err.status < 500 ? err.status : 500, 'Internal server error.');
  });

  return app;
}
