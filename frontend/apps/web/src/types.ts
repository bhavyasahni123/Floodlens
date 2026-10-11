export type LatLon = [number, number];
export type TravelMode = 'driving' | 'walking' | 'cycling';
export type Preference = 'Fastest' | 'Balanced' | 'Lower Risk';
export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH';
export type SourceStatus = 'LIVE' | 'STALE' | 'UNAVAILABLE';

export type Place = { lat: number; lon: number; label: string; fromGeolocation?: boolean };

export type PlaceSuggestion = { label: string; detail: string; lat: number; lon: number };

export type NearbyHotspot = {
  id: string;
  name: string;
  severity: RiskLevel;
  infrastructureType: string;
  distanceMeters: number;
};

export type RiskAssessment =
  | {
      status: 'ASSESSED';
      modelVersion: string;
      score: number;
      level: RiskLevel;
      reason: string;
      factors: { kind: string; points: number; label: string }[];
      intersectedHotspots: NearbyHotspot[];
      inputs: Record<string, string>;
      limitations: string[];
      modeNote: string | null;
      disclaimer: string;
    }
  | { status: 'NOT_ASSESSED'; modelVersion: string; reason: string; limitations: string[]; disclaimer: string };

export type DirectionStep = {
  instruction: string;
  distanceM: number;
  durationS: number;
  location: LatLon;
  type: string;
  modifier: string | null;
  hazards: string[];
};

export type RouteCandidate = {
  steps: DirectionStep[];
  id: string;
  route: LatLon[];
  distanceKm: number;
  durationMinutes: number;
  risk: RiskAssessment;
  preferences: Preference[];
};

export type RouteResponse = {
  success: true;
  assessedAt: string;
  routeRequest: { origin: string; destination: string; mode: Preference; travelMode: TravelMode };
  originCoordinates: LatLon;
  destinationCoordinates: LatLon;
  provider: { name: string; url: string };
  coverage: { inCoverage: boolean; area: string };
  candidates: RouteCandidate[];
  preferences: { fastest: string; balanced: string | null; lowerRisk: string | null };
  selectedId: string;
  notes: string[];
  recommendation: { routeId: string; message: string } | null;
};

export type HazardFeature = {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    name: string;
    infrastructureType: string;
    zone: string;
    severity: RiskLevel;
    bufferRadiusMeters: number;
    description: string;
    dataSource: string;
    provenance?: { status: string; coordinatePrecision: string; claimedAttribution: string; attributionVerified: boolean };
  };
};

export type SourceInfo = { name: string; url: string; license: string; nature: string; note: string };

export type SourceEnvelope<T> = {
  status: SourceStatus;
  data: T | null;
  retrievedAt: string | null;
  lastAttemptAt: string | null;
  error?: string;
  source: SourceInfo;
};

export type RainPoint = { time: string; mm: number; kind: 'ESTIMATED_PAST' | 'FORECAST' };
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
    intensity: 'NONE' | 'LIGHT' | 'MODERATE' | 'HEAVY';
  };
};
export type RainfallData = { model: string; units: string; samples: RainSample[] };

export type RiverData = {
  river: string;
  label: string;
  lat: number;
  lon: number;
  units: string;
  days: { date: string; dischargeM3s: number; kind: 'MODELLED_PAST' | 'FORECAST' }[];
  todayM3s: number | null;
  forecastPeakM3s: number | null;
  trend: 'RISING' | 'FALLING' | 'STEADY' | 'UNKNOWN';
};

export type OfficialAlert = {
  id: string;
  event: string;
  headline: string;
  areaDescription: string;
  issuer: string;
  severity: string;
  certainty: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  centroid: LatLon;
  areaSqKm: number | null;
  approxRadiusKm: number | null;
  floodRelevant: boolean;
  sourceUrl: string;
};
export type AlertsData = { alerts: OfficialAlert[]; nationalCount: number };

export type ReportPolicy = {
  expiryHours: number;
  clusterRadiusMeters: number;
  clusterWindowHours: number;
  clusterMinReports: number;
};

export type Intelligence = {
  generatedAt: string;
  rainfall: SourceEnvelope<RainfallData>;
  river: SourceEnvelope<RiverData>;
  alerts: SourceEnvelope<AlertsData>;
  hotspots: { status: 'AVAILABLE' | 'UNAVAILABLE'; count?: number; metadata?: { provenance?: { summary: string } } };
  community:
    | { status: 'AVAILABLE'; policy: ReportPolicy; activeCount: number; clusterCount: number; serverTime: string }
    | { status: 'UNAVAILABLE'; reason: string; policy: ReportPolicy };
};

export type CommunityReport = {
  id: string;
  lat: number;
  lon: number;
  description: string;
  locationLabel: string | null;
  submittedAt: string;
  expiresAt: string;
  verification: 'UNVERIFIED';
  clusterId: string | null;
};

export type ReportCluster = {
  id: string;
  label: string;
  reportIds: string[];
  reportCount: number;
  distinctSources: number;
  independenceEstablished: boolean;
  centroid: LatLon;
  firstSubmittedAt: string;
  lastSubmittedAt: string;
};

export type ReportsResponse =
  | { available: true; policy: ReportPolicy; serverTime: string; reports: CommunityReport[]; clusters: ReportCluster[] }
  | { available: false; reason: string; policy: ReportPolicy; reports: []; clusters: [] };

export type LayerKey = 'alerts' | 'hotspots' | 'community' | 'rainfall' | 'river';
