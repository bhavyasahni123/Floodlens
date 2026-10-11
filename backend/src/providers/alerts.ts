import { config } from '../config';
import { haversineMeters, type LatLon } from '../geo';
import { createSourceCache, fetchJson } from '../sourceCache';

export type OfficialAlert = {
  id: string;
  event: string;
  headline: string;
  areaDescription: string;
  issuer: string;
  severity: string;
  certainty: string;
  severityColor: string;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  /** Centroid of the official alert area, as published by SACHET. */
  centroid: LatLon;
  areaSqKm: number | null;
  /** Radius of a circle with the same area — an approximation of coverage, not the real polygon. */
  approxRadiusKm: number | null;
  floodRelevant: boolean;
  sourceUrl: string;
  language: string;
};

export type AlertsData = {
  /** Alerts relevant to the configured city (centroid nearby or area names the city). */
  alerts: OfficialAlert[];
  /** Total alerts in the national feed at retrieval time, for transparency. */
  nationalCount: number;
};

type SachetRecord = {
  identifier?: number | string;
  severity?: string;
  effective_start_time?: string;
  effective_end_time?: string;
  disaster_type?: string;
  area_description?: string;
  severity_level?: string;
  warning_message?: string;
  severity_color?: string;
  centroid?: string;
  alert_source?: string;
  area_covered?: string;
  actual_lang?: string;
};

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};
const ZONES: Record<string, string> = { IST: '+05:30', UTC: 'Z', GMT: 'Z' };

/** Parses SACHET's Java-style dates, e.g. "Sun Oct 11 12:27:00 IST 2026". Returns null if unsure. */
export function parseSachetDate(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\w+) (\d{4})$/.exec(value.trim());
  if (!m) return null;
  const [, mon, day, hh, mm, ss, zone, year] = m;
  const month = MONTHS[mon];
  const offset = ZONES[zone];
  if (!month || !offset) return null;
  const date = new Date(`${year}-${month}-${day.padStart(2, '0')}T${hh}:${mm}:${ss}${offset}`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

const FLOOD_TERMS = /flood|rain|cloudburst|inundat|waterlog|cyclone|thunderstorm|storm/i;

export function parseSachet(records: SachetRecord[]): AlertsData {
  const city = config.city;
  const center: LatLon = [city.center.lat, city.center.lon];
  const alerts: OfficialAlert[] = [];
  for (const r of records) {
    if (!r.centroid || r.identifier === undefined) continue;
    const [lonStr, latStr] = r.centroid.split(',');
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const area = r.area_description ?? '';
    const nearby = haversineMeters(center, [lat, lon]) <= city.alertRadiusKm * 1000;
    const namesCity = city.alertAreaKeywords.some((k) => area.toLowerCase().includes(k));
    if (!nearby && !namesCity) continue;
    const areaSqKm = Number(r.area_covered);
    const event = r.disaster_type ?? 'Alert';
    alerts.push({
      id: String(r.identifier),
      event,
      headline: r.warning_message ?? event,
      areaDescription: area,
      issuer: r.alert_source ?? 'Unknown issuer',
      severity: r.severity ?? 'UNKNOWN',
      certainty: r.severity_level ?? '',
      severityColor: r.severity_color ?? '',
      effectiveStart: parseSachetDate(r.effective_start_time),
      effectiveEnd: parseSachetDate(r.effective_end_time),
      centroid: [lat, lon],
      areaSqKm: Number.isFinite(areaSqKm) && areaSqKm > 0 ? areaSqKm : null,
      approxRadiusKm: Number.isFinite(areaSqKm) && areaSqKm > 0 ? Math.sqrt(areaSqKm / Math.PI) : null,
      floodRelevant: FLOOD_TERMS.test(event),
      sourceUrl: `https://sachet.ndma.gov.in/cap_public_website/FetchXMLFile?identifier=${encodeURIComponent(String(r.identifier))}`,
      language: r.actual_lang ?? '',
    });
  }
  return { alerts, nationalCount: records.length };
}

/** An alert is active if its end time is in the future (or unknown, which we treat conservatively as active). */
export function isActive(alert: OfficialAlert, nowMs: number): boolean {
  if (!alert.effectiveEnd) return true;
  return new Date(alert.effectiveEnd).getTime() > nowMs;
}

/** True if any route point lies inside the alert's equivalent-area circle. */
export function alertCoversRoute(alert: OfficialAlert, route: LatLon[]): boolean {
  if (alert.approxRadiusKm === null) return false;
  const radiusM = alert.approxRadiusKm * 1000;
  const step = Math.max(1, Math.floor(route.length / 50));
  for (let i = 0; i < route.length; i += step) {
    if (haversineMeters(route[i], alert.centroid) <= radiusM) return true;
  }
  return route.length > 0 && haversineMeters(route[route.length - 1], alert.centroid) <= radiusM;
}

async function loadAlerts(): Promise<AlertsData> {
  const records = await fetchJson<SachetRecord[]>(config.providers.sachetAlertsUrl, {
    headers: { 'User-Agent': config.providers.userAgent, Accept: 'application/json' },
    timeoutMs: 20000,
  });
  if (!Array.isArray(records)) throw new Error('Unexpected SACHET response format.');
  return parseSachet(records);
}

export const alertsSource = createSourceCache<AlertsData>({
  ttlMs: 10 * 60e3,
  maxStaleMs: 60 * 60e3,
  load: loadAlerts,
});

export const ALERTS_SOURCE_INFO = {
  name: 'NDMA SACHET — CAP Integrated Alert System',
  url: 'https://sachet.ndma.gov.in/',
  license: 'Public alerts published by Government of India agencies (feed marked public domain)',
  nature: 'OFFICIAL',
  note:
    'Alerts issued by IMD, SDMAs and other authorities. FloodLens shows the published area centroid and an equal-area circle; the official polygon is in the linked CAP file.',
};
