import { config } from '../config';
import { overlapFraction, type LatLon } from '../geo';
import type { OsrmStep } from '../directions';
import type { TravelMode } from '../risk';

export type RawRoute = { coords: LatLon[]; distanceM: number; durationS: number; steps?: OsrmStep[] };

export class RoutingError extends Error {
  constructor(
    message: string,
    readonly code: 'PROVIDER_UNAVAILABLE' | 'NO_ROUTE',
  ) {
    super(message);
  }
}

/**
 * Only servers that genuinely implement each profile are used. The public
 * router.project-osrm.org demo serves car routing only (it silently ignores
 * the foot profile — verified 2026-10-11), so walking and cycling use the
 * FOSSGIS servers at routing.openstreetmap.de.
 */
export const ROUTING_PROVIDERS: Record<TravelMode, { name: string; url: string; base: () => string }> = {
  driving: { name: 'OSRM public demo server (car)', url: 'https://project-osrm.org/', base: () => config.providers.osrmDrivingUrl },
  walking: { name: 'FOSSGIS OSRM (foot)', url: 'https://routing.openstreetmap.de/', base: () => config.providers.osrmWalkingUrl },
  cycling: { name: 'FOSSGIS OSRM (bike)', url: 'https://routing.openstreetmap.de/', base: () => config.providers.osrmCyclingUrl },
};

type OsrmResponse = {
  code: string;
  message?: string;
  routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] }; legs?: { steps?: OsrmStep[] }[] }[];
};

export async function fetchOsrmRoutes(origin: LatLon, destination: LatLon, mode: TravelMode): Promise<RawRoute[]> {
  const coords = `${origin[1]},${origin[0]};${destination[1]},${destination[0]}`;
  const url = `${ROUTING_PROVIDERS[mode].base()}/${coords}?alternatives=3&overview=full&geometries=geojson&steps=true`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': config.providers.userAgent },
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new RoutingError('The routing service did not respond. Please retry.', 'PROVIDER_UNAVAILABLE');
  }
  if (response.status === 400) {
    // OSRM uses 400 with code NoRoute / NoSegment when no route can be built.
    const body = (await response.json().catch(() => null)) as OsrmResponse | null;
    if (body && /NoRoute|NoSegment/.test(body.code)) {
      throw new RoutingError('No route was found between these points for this travel mode.', 'NO_ROUTE');
    }
  }
  if (!response.ok) {
    throw new RoutingError(`The routing service is temporarily unavailable (HTTP ${response.status}). Please retry.`, 'PROVIDER_UNAVAILABLE');
  }
  const data = (await response.json()) as OsrmResponse;
  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new RoutingError('No route was found between these points for this travel mode.', 'NO_ROUTE');
  }
  return data.routes
    .filter((r) => r.geometry?.coordinates?.length >= 2)
    .map((r) => ({
      coords: r.geometry.coordinates.map(([lon, lat]) => [lat, lon] as LatLon),
      distanceM: r.distance,
      durationS: r.duration,
      steps: (r.legs ?? []).flatMap((leg) => leg.steps ?? []),
    }));
}

/** Removes alternatives that are effectively the same road path as an earlier route. */
export function dedupeRoutes(routes: RawRoute[]): RawRoute[] {
  const kept: RawRoute[] = [];
  for (const r of routes) {
    const duplicate = kept.some((k) => {
      const lengthClose = Math.abs(k.distanceM - r.distanceM) <= Math.max(k.distanceM, r.distanceM) * 0.05;
      return lengthClose && overlapFraction(r.coords, k.coords) >= 0.9 && overlapFraction(k.coords, r.coords) >= 0.9;
    });
    if (!duplicate) kept.push(r);
  }
  return kept;
}
