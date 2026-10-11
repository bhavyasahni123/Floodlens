/**
 * In-app turn-by-turn navigation maths. Pure functions, no browser APIs.
 * Coordinates are [lat, lon].
 */
import type { DirectionStep, LatLon, TravelMode } from '../types';

const R = 6371008.8;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: LatLon, b: LatLon): number {
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b in degrees (0 = north, clockwise). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export type RouteIndex = { points: LatLon[]; cumulative: number[]; total: number };

export function indexRoute(points: LatLon[]): RouteIndex {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative.push(cumulative[i - 1] + haversine(points[i - 1], points[i]));
  return { points, cumulative, total: cumulative[cumulative.length - 1] ?? 0 };
}

export type Projection = { alongM: number; offsetM: number; segment: number; snapped: LatLon };

/** Projects a point onto one segment using a local flat approximation (accurate at street scale). */
function projectSegment(p: LatLon, a: LatLon, b: LatLon) {
  const k = Math.cos(rad(p[0]));
  const ax = rad(a[1] - p[1]) * k * R, ay = rad(a[0] - p[0]) * R;
  const bx = rad(b[1] - p[1]) * k * R, by = rad(b[0] - p[0]) * R;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return { t, dist: Math.hypot(ax + t * dx, ay + t * dy) };
}

/**
 * Snaps a point to the route. `fromSegment` restricts the search to segments at
 * or after it (use the last known segment so progress never jumps backwards onto
 * an earlier, overlapping part of the road), but falls back to a full search.
 */
export function project(index: RouteIndex, p: LatLon, fromSegment = 0): Projection {
  const pts = index.points;
  if (pts.length === 1) return { alongM: 0, offsetM: haversine(p, pts[0]), segment: 0, snapped: pts[0] };
  const search = (start: number): Projection => {
    let best: Projection = { alongM: 0, offsetM: Infinity, segment: start, snapped: pts[start] };
    for (let i = start; i < pts.length - 1; i++) {
      const { t, dist } = projectSegment(p, pts[i], pts[i + 1]);
      if (dist < best.offsetM) {
        const seg = index.cumulative[i + 1] - index.cumulative[i];
        best = {
          alongM: index.cumulative[i] + t * seg,
          offsetM: dist,
          segment: i,
          snapped: [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])],
        };
      }
    }
    return best;
  };
  const near = search(Math.max(0, Math.min(fromSegment, pts.length - 2)));
  if (near.offsetM <= 60 || fromSegment === 0) return near;
  const full = search(0);
  return full.offsetM < near.offsetM ? full : near;
}

/** The point at a given distance along the route (used by the journey simulation). */
export function pointAt(index: RouteIndex, alongM: number): LatLon {
  const { points, cumulative } = index;
  if (alongM <= 0) return points[0];
  if (alongM >= index.total) return points[points.length - 1];
  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < alongM) i++;
  const seg = cumulative[i] - cumulative[i - 1] || 1;
  const t = (alongM - cumulative[i - 1]) / seg;
  return [points[i - 1][0] + t * (points[i][0] - points[i - 1][0]), points[i - 1][1] + t * (points[i][1] - points[i - 1][1])];
}

/** Distance along the route of each step's maneuver point, kept in route order. */
export function stepPositions(index: RouteIndex, steps: DirectionStep[]): number[] {
  let segment = 0;
  let last = 0;
  return steps.map((s, i) => {
    if (i === 0) return 0;
    if (i === steps.length - 1 && s.type === 'arrive') return index.total;
    const p = project(index, s.location, segment);
    segment = p.segment;
    last = Math.max(last, p.alongM);
    return last;
  });
}

export const OFF_ROUTE_BASE_M: Record<TravelMode, number> = { driving: 45, walking: 30, cycling: 35 };
export const ARRIVAL_RADIUS_M = 30;

export type Guidance = {
  alongM: number;
  offsetM: number;
  segment: number;
  snapped: LatLon;
  remainingM: number;
  /** Index of the next maneuver the user has not yet reached. */
  nextStep: number;
  distanceToNextM: number;
  offRoute: boolean;
  arrived: boolean;
};

export function guidance(
  index: RouteIndex,
  positions: number[],
  position: LatLon,
  accuracyM: number,
  mode: TravelMode,
  destination: LatLon,
  fromSegment = 0,
): Guidance {
  const p = project(index, position, fromSegment);
  // Small tolerance so a maneuver counts as passed once the user is right at it.
  let next = positions.findIndex((pos, i) => i > 0 && pos > p.alongM + 8);
  if (next === -1) next = positions.length - 1;
  const remainingM = Math.max(0, index.total - p.alongM);
  const threshold = OFF_ROUTE_BASE_M[mode] + Math.min(Math.max(accuracyM, 0), 50);
  const arrived = haversine(position, destination) <= ARRIVAL_RADIUS_M || (remainingM <= ARRIVAL_RADIUS_M && p.offsetM <= threshold);
  return {
    alongM: p.alongM,
    offsetM: p.offsetM,
    segment: p.segment,
    snapped: p.snapped,
    remainingM,
    nextStep: next,
    distanceToNextM: Math.max(0, (positions[next] ?? index.total) - p.alongM),
    offRoute: !arrived && p.offsetM > threshold,
    arrived,
  };
}

/** Navigation-style rounding: 1.2 km, 450 m, 80 m. */
export function formatDistance(m: number): string {
  if (m < 50) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  if (m < 1000) return `${Math.round(m / 50) * 50} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

/** Spoken form: "In 300 metres, turn left onto Ring Road". */
export function spokenInstruction(instruction: string, distanceM: number): string {
  if (distanceM < 40) return instruction;
  const d = distanceM >= 1000 ? `${(distanceM / 1000).toFixed(1)} kilometres` : `${Math.round(distanceM / 50) * 50} metres`;
  return `In ${d}, ${instruction.charAt(0).toLowerCase()}${instruction.slice(1)}`;
}
