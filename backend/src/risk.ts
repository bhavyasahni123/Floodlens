/**
 * FloodLens route risk heuristic (v2). See backend/RISK_MODEL.md.
 *
 * A transparent, rule-based score from 0–100. It is NOT a probability of
 * flooding and has not been statistically validated. Same inputs → same output.
 */
import { pointToPolylineMeters, type LatLon } from './geo';
import type { HazardFeature, Severity } from './hotspots';
import { alertCoversRoute, isActive, type OfficialAlert } from './providers/alerts';
import type { RainIntensity } from './providers/rainfall';
import type { CommunityReport, ReportCluster } from './reports/clustering';
import type { SourceStatus } from './sourceCache';

export const MODEL_VERSION = 'floodlens-heuristic-v2';
export type TravelMode = 'driving' | 'walking' | 'cycling';
export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH';

export const WEIGHTS = {
  base: 5,
  severity: { HIGH: 55, MODERATE: 30, LOW: 12 } as Record<Severity, number>,
  /** Contribution at the buffer edge relative to a direct pass. */
  edgeFactor: 0.5,
  historicalCap: 65,
  rain: {
    NONE: { factor: 1, points: 0 },
    LIGHT: { factor: 1.15, points: 3 },
    MODERATE: { factor: 1.4, points: 8 },
    HEAVY: { factor: 1.75, points: 15 },
  } as Record<RainIntensity, { factor: number; points: number }>,
  historicalWithRainCap: 75,
  /** Added when a live input could not be checked, so missing data never lowers the score. */
  uncertainty: { rainfall: 3, alerts: 2 },
  alert: { flood: 20, weather: 10, additional: 5, cap: 25 },
  community: {
    clusterDistanceM: 150,
    reportDistanceM: 100,
    corroboratedCluster: 12,
    singleReport: 4,
    singleReportCap: 8,
    cap: 20,
  },
  levels: { moderate: 35, high: 65 },
};

export function levelFor(score: number): RiskLevel {
  if (score >= WEIGHTS.levels.high) return 'HIGH';
  if (score >= WEIGHTS.levels.moderate) return 'MODERATE';
  return 'LOW';
}

export type RiskInputs = {
  route: LatLon[];
  mode: TravelMode;
  nowMs: number;
  hotspots: HazardFeature[] | null;
  rainfall: { status: SourceStatus; intensity: RainIntensity | null; areas?: string[] };
  alerts: { status: SourceStatus; items: OfficialAlert[] };
  community: { available: boolean; reports: CommunityReport[]; clusters: ReportCluster[] };
};

export type NearbyHotspot = {
  id: string;
  name: string;
  severity: Severity;
  infrastructureType: string;
  zone: string;
  distanceMeters: number;
  bufferRadiusMeters: number;
  description: string;
  contribution: number;
};

export type RiskFactor = { kind: 'BASE' | 'HISTORICAL' | 'RAINFALL' | 'ALERT' | 'COMMUNITY' | 'UNCERTAINTY'; points: number; label: string };

export type RiskAssessment =
  | {
      status: 'ASSESSED';
      modelVersion: string;
      score: number;
      level: RiskLevel;
      reason: string;
      factors: RiskFactor[];
      intersectedHotspots: NearbyHotspot[];
      inputs: Record<'historical' | 'rainfall' | 'alerts' | 'community', string>;
      limitations: string[];
      modeNote: string | null;
      disclaimer: string;
    }
  | { status: 'NOT_ASSESSED'; modelVersion: string; reason: string; limitations: string[]; disclaimer: string };

const DISCLAIMER =
  'Informational estimate only — not a guarantee of safety or a flood probability. Never drive, cycle or walk into flood water.';

const MODE_NOTES: Record<TravelMode, string | null> = {
  driving: null,
  walking:
    'Hotspot data describes road waterlogging for vehicles. Pedestrians can be endangered by shallower water, hidden open drains, currents and electrical hazards; this score is not validated for walking.',
  cycling:
    'Hotspot data describes road waterlogging for vehicles. Cyclists can lose control or fall into hidden drains in shallow water; this score is not validated for cycling.',
};

const SEVERITY_WORD: Record<Severity, string> = { HIGH: 'high', MODERATE: 'moderate', LOW: 'low' };

export function assessRoute(input: RiskInputs): RiskAssessment {
  const limitations: string[] = [];
  if (!input.hotspots) {
    return {
      status: 'NOT_ASSESSED',
      modelVersion: MODEL_VERSION,
      reason: 'Historical hotspot data could not be loaded, so a risk score cannot be computed responsibly.',
      limitations: ['Historical hotspot dataset unavailable.'],
      disclaimer: DISCLAIMER,
    };
  }
  if (input.route.length < 2) {
    return {
      status: 'NOT_ASSESSED',
      modelVersion: MODEL_VERSION,
      reason: 'Route geometry is too short to assess.',
      limitations: [],
      disclaimer: DISCLAIMER,
    };
  }

  const factors: RiskFactor[] = [{ kind: 'BASE', points: WEIGHTS.base, label: 'Baseline: unmapped hazards can exist on any route' }];

  // 1. Historical susceptibility — segment distance, proximity-weighted, diminishing returns.
  const nearby: NearbyHotspot[] = [];
  for (const f of input.hotspots) {
    const [lon, lat] = f.geometry.coordinates;
    const buffer = f.properties.bufferRadiusMeters > 0 ? f.properties.bufferRadiusMeters : 200;
    const d = pointToPolylineMeters([lat, lon], input.route);
    if (d > buffer) continue;
    const weight = WEIGHTS.severity[f.properties.severity] ?? WEIGHTS.severity.LOW;
    const contribution = weight * (1 - (1 - WEIGHTS.edgeFactor) * (d / buffer));
    nearby.push({
      id: f.id,
      name: f.properties.name,
      severity: f.properties.severity,
      infrastructureType: f.properties.infrastructureType,
      zone: f.properties.zone,
      distanceMeters: Math.round(d),
      bufferRadiusMeters: buffer,
      description: f.properties.description,
      contribution: Math.round(contribution * 10) / 10,
    });
  }
  nearby.sort((a, b) => b.contribution - a.contribution || a.id.localeCompare(b.id));
  let historical = nearby.reduce((sum, h, i) => sum + h.contribution * (i === 0 ? 1 : i === 1 ? 0.5 : 0.25), 0);
  historical = Math.min(WEIGHTS.historicalCap, historical);

  // 2. Rainfall — scales historical susceptibility and adds a small direct term.
  let rainClass: RainIntensity = 'NONE';
  let rainState: string;
  const rainUsable = input.rainfall.status !== 'UNAVAILABLE' && input.rainfall.intensity !== null;
  if (rainUsable && input.rainfall.status === 'LIVE') {
    rainClass = input.rainfall.intensity!;
    rainState = 'LIVE';
  } else if (rainUsable) {
    // Stale data may understate current rain: never use less than LIGHT.
    rainClass = input.rainfall.intensity === 'NONE' ? 'LIGHT' : input.rainfall.intensity!;
    rainState = 'STALE';
    limitations.push('Rainfall data is stale; at least light rain was assumed.');
  } else {
    rainState = 'UNAVAILABLE';
    limitations.push('Live rainfall unavailable — an uncertainty margin was added instead of assuming dry conditions.');
  }
  const rain = WEIGHTS.rain[rainClass];
  const historicalAdjusted = Math.min(WEIGHTS.historicalWithRainCap, historical * rain.factor);
  if (historicalAdjusted > 0) {
    factors.push({
      kind: 'HISTORICAL',
      points: round(historicalAdjusted),
      label: `${nearby.length} historical hotspot(s) within buffer${rain.factor > 1 ? ` (×${rain.factor} for ${rainClass.toLowerCase()} rain)` : ''}`,
    });
  }
  if (rain.points > 0) {
    factors.push({ kind: 'RAINFALL', points: rain.points, label: `${cap(rainClass)} rainfall estimated or forecast nearby` });
  }
  if (rainState === 'UNAVAILABLE') {
    factors.push({ kind: 'UNCERTAINTY', points: WEIGHTS.uncertainty.rainfall, label: 'Rainfall could not be checked' });
  }

  // 3. Official alerts — active, flood-relevant, covering the route.
  let alertPoints = 0;
  let topAlert: OfficialAlert | null = null;
  if (input.alerts.status === 'UNAVAILABLE') {
    limitations.push('Official alerts could not be checked.');
    factors.push({ kind: 'UNCERTAINTY', points: WEIGHTS.uncertainty.alerts, label: 'Official alerts could not be checked' });
  } else {
    if (input.alerts.status === 'STALE') limitations.push('Official alert data is stale.');
    const covering = input.alerts.items
      .filter((a) => a.floodRelevant && isActive(a, input.nowMs) && alertCoversRoute(a, input.route))
      .map((a) => ({ a, pts: /flood|inundat|cloudburst/i.test(a.event) ? WEIGHTS.alert.flood : WEIGHTS.alert.weather }))
      .sort((x, y) => y.pts - x.pts || x.a.id.localeCompare(y.a.id));
    if (covering.length > 0) {
      topAlert = covering[0].a;
      alertPoints = Math.min(WEIGHTS.alert.cap, covering[0].pts + (covering.length - 1) * WEIGHTS.alert.additional);
      factors.push({ kind: 'ALERT', points: alertPoints, label: `${covering.length} active official alert(s) cover this route` });
    }
  }

  // 4. Community reports — a cluster counts once regardless of size; unverified
  //    single reports are weak evidence; clusters without established
  //    independence are treated as a single report.
  let communityPoints = 0;
  let corroboratedNear = 0;
  if (!input.community.available) {
    limitations.push('Community reports unavailable (database not reachable).');
  } else {
    const clustered = new Set(input.community.clusters.flatMap((c) => c.reportIds));
    let clusterPts = 0;
    let singlePts = 0;
    for (const c of input.community.clusters) {
      if (pointToPolylineMeters(c.centroid, input.route) > WEIGHTS.community.clusterDistanceM) continue;
      if (c.independenceEstablished) {
        clusterPts += WEIGHTS.community.corroboratedCluster;
        corroboratedNear++;
      } else singlePts += WEIGHTS.community.singleReport;
    }
    for (const r of input.community.reports) {
      if (clustered.has(r.id)) continue;
      if (pointToPolylineMeters([r.lat, r.lon], input.route) <= WEIGHTS.community.reportDistanceM) {
        singlePts += WEIGHTS.community.singleReport;
      }
    }
    communityPoints = Math.min(WEIGHTS.community.cap, clusterPts + Math.min(WEIGHTS.community.singleReportCap, singlePts));
    if (communityPoints > 0) {
      factors.push({ kind: 'COMMUNITY', points: communityPoints, label: 'Recent unverified community reports near this route' });
    }
  }

  const raw = factors.reduce((s, f) => s + f.points, 0);
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // Short reason from the largest non-base factor, using actual inputs.
  const ranked = factors.filter((f) => f.kind !== 'BASE' && f.kind !== 'UNCERTAINTY').sort((a, b) => b.points - a.points);
  let reason = 'No mapped hotspots, active official alerts or recent reports near this route. This does not mean it is flood-free.';
  const top = ranked[0]?.kind;
  if (top === 'HISTORICAL' && nearby[0]) {
    const h = nearby[0];
    const more = nearby.length > 1 ? ` and ${nearby.length - 1} other hotspot(s)` : '';
    reason = `Passes ${h.distanceMeters} m from ${h.name}, a historically waterlogging-prone ${h.infrastructureType.toLowerCase()} (${SEVERITY_WORD[h.severity]} susceptibility)${more}.`;
  } else if (top === 'ALERT' && topAlert) {
    reason = `Inside the area of an active official ${topAlert.event.toLowerCase()} alert from ${topAlert.issuer}.`;
  } else if (top === 'COMMUNITY') {
    reason = corroboratedNear > 0
      ? 'Corroborated (unverified) community reports of waterlogging near this route.'
      : 'Recent unverified community report(s) of waterlogging near this route.';
  } else if (top === 'RAINFALL') {
    reason = `${cap(rainClass)} rainfall estimated or forecast near this route; no mapped hotspots on it.`;
  }

  return {
    status: 'ASSESSED',
    modelVersion: MODEL_VERSION,
    score,
    level: levelFor(score),
    reason,
    factors,
    intersectedHotspots: nearby,
    inputs: {
      historical: 'USED (approximate, unverified compilation)',
      rainfall: rainState === 'LIVE' ? `LIVE (${rainClass})` : rainState,
      alerts: input.alerts.status,
      community: input.community.available ? 'USED' : 'UNAVAILABLE',
    },
    limitations,
    modeNote: MODE_NOTES[input.mode],
    disclaimer: DISCLAIMER,
  };
}

const round = (n: number) => Math.round(n * 10) / 10;
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
