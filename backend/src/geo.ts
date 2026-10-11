/** Geospatial helpers. All coordinates are [lat, lon] in WGS84 degrees. */
export type LatLon = [number, number];

const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(a: LatLon, b: LatLon): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest distance from point p to segment a–b. Uses a local equirectangular
 * projection centred on p, which is accurate to well under 1% for the short
 * (sub-10 km) segments found in route geometry. Unlike vertex-only checks, a
 * hazard beside a long straight segment is measured correctly.
 */
export function pointToSegmentMeters(p: LatLon, a: LatLon, b: LatLon): number {
  const cosLat = Math.cos(toRad(p[0]));
  const project = (q: LatLon) => [
    toRad(q[1] - p[1]) * cosLat * EARTH_RADIUS_M,
    toRad(q[0] - p[0]) * EARTH_RADIUS_M,
  ];
  const [ax, ay] = project(a);
  const [bx, by] = project(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  let t = lengthSq === 0 ? 0 : -(ax * dx + ay * dy) / lengthSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** Minimum distance from a point to any segment of a polyline. */
export function pointToPolylineMeters(p: LatLon, line: LatLon[]): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return haversineMeters(p, line[0]);
  let min = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = pointToSegmentMeters(p, line[i], line[i + 1]);
    if (d < min) min = d;
  }
  return min;
}

/**
 * Fraction (0–1) of points sampled along `a` that lie within `toleranceM`
 * of polyline `b`. Used to detect duplicate route alternatives.
 */
export function overlapFraction(a: LatLon[], b: LatLon[], toleranceM = 30, samples = 40): number {
  if (a.length === 0 || b.length === 0) return 0;
  const step = Math.max(1, Math.floor(a.length / samples));
  let checked = 0;
  let near = 0;
  for (let i = 0; i < a.length; i += step) {
    checked++;
    if (pointToPolylineMeters(a[i], b) <= toleranceM) near++;
  }
  return near / checked;
}
