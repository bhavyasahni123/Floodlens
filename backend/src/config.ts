import 'dotenv/config';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.trim() ? raw.trim() : fallback;
}

/**
 * City configuration. FloodLens is Delhi-first; adding a city means adding an
 * entry here plus a hotspot dataset, without touching the route or risk engine.
 */
export type CityConfig = {
  id: string;
  name: string;
  center: { lat: number; lon: number };
  /** [west, south, east, north] — used to bias place search and filter alerts. */
  bbox: [number, number, number, number];
  hotspotFile: string;
  /** Points sampled for rainfall; routes use the nearest sample(s). */
  rainfallSamples: { id: string; name: string; lat: number; lon: number }[];
  /** GloFAS model grid cell that carries the main river channel near the city. */
  riverCell: { river: string; label: string; lat: number; lon: number } | null;
  /** Official alerts whose area centroid lies within this radius are shown. */
  alertRadiusKm: number;
  /** Words that, if present in an alert's area description, mark it as relevant. */
  alertAreaKeywords: string[];
};

export const DELHI: CityConfig = {
  id: 'delhi',
  name: 'Delhi (NCT)',
  center: { lat: 28.6139, lon: 77.209 },
  bbox: [76.84, 28.4, 77.35, 28.89],
  hotspotFile: 'delhi_waterlogging_hotspots.json',
  rainfallSamples: [
    { id: 'central', name: 'Central Delhi', lat: 28.6139, lon: 77.209 },
    { id: 'north', name: 'North Delhi', lat: 28.73, lon: 77.17 },
    { id: 'south', name: 'South Delhi', lat: 28.52, lon: 77.22 },
    { id: 'east', name: 'East Delhi', lat: 28.63, lon: 77.3 },
    { id: 'west', name: 'West Delhi', lat: 28.62, lon: 77.05 },
  ],
  // Verified 2026-10-11 by scanning the Open-Meteo flood API grid: this cell
  // reports ~380 m³/s while neighbouring cells report <20 m³/s, so it is the
  // model's representation of the Yamuna main stem near central Delhi. The
  // 0.05° grid is offset from the real channel; it is not a gauge location.
  riverCell: {
    river: 'Yamuna',
    label: 'Yamuna main stem near central Delhi (GloFAS model grid cell)',
    lat: 28.625,
    lon: 77.225,
  },
  alertRadiusKm: 60,
  alertAreaKeywords: ['delhi', 'new delhi', 'shahdara', 'najafgarh'],
};

export const config = {
  port: num('PORT', 5000),
  corsOrigins: str('CORS_ORIGINS', 'http://localhost:5173,http://localhost:4173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  /** Secret used to hash submitter IPs for independence checks. Never the raw IP. */
  reportHashSecret: str('REPORT_HASH_SECRET', 'floodlens-dev-only-secret'),
  reports: {
    expiryHours: num('REPORT_EXPIRY_HOURS', 3),
    clusterRadiusMeters: num('CLUSTER_RADIUS_METERS', 100),
    clusterWindowHours: num('CLUSTER_WINDOW_HOURS', 2),
    clusterMinReports: num('CLUSTER_MIN_REPORTS', 2),
    descriptionMin: 5,
    descriptionMax: 500,
    submitLimitPerWindow: num('REPORT_RATE_LIMIT', 5),
    submitWindowMinutes: num('REPORT_RATE_WINDOW_MINUTES', 10),
  },
  providers: {
    nominatimUrl: str('NOMINATIM_URL', 'https://nominatim.openstreetmap.org'),
    photonUrl: str('PHOTON_URL', 'https://photon.komoot.io'),
    osrmDrivingUrl: str('OSRM_DRIVING_URL', 'https://router.project-osrm.org/route/v1/driving'),
    osrmWalkingUrl: str('OSRM_WALKING_URL', 'https://routing.openstreetmap.de/routed-foot/route/v1/foot'),
    osrmCyclingUrl: str('OSRM_CYCLING_URL', 'https://routing.openstreetmap.de/routed-bike/route/v1/bike'),
    openMeteoForecastUrl: str('OPEN_METEO_FORECAST_URL', 'https://api.open-meteo.com/v1/forecast'),
    openMeteoFloodUrl: str('OPEN_METEO_FLOOD_URL', 'https://flood-api.open-meteo.com/v1/flood'),
    sachetAlertsUrl: str(
      'SACHET_ALERTS_URL',
      'https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails',
    ),
    userAgent: str('HTTP_USER_AGENT', 'FloodLensPrototype/1.0 (hackathon prototype)'),
  },
  city: DELHI,
};
