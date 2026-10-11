/**
 * Turn-by-turn instructions from OSRM route steps. OSRM returns maneuver
 * codes, not text, so instructions are composed here (English only).
 */
import { pointToPolylineMeters, type LatLon } from './geo';

export type OsrmStep = {
  distance: number;
  duration: number;
  name?: string;
  ref?: string;
  rotary_name?: string;
  mode?: string;
  geometry?: { coordinates: [number, number][] };
  maneuver: {
    type: string;
    modifier?: string;
    location: [number, number]; // [lon, lat]
    bearing_after?: number;
    exit?: number;
  };
};

export type DirectionStep = {
  instruction: string;
  distanceM: number;
  durationS: number;
  location: LatLon;
  type: string;
  modifier: string | null;
  /** Historical hotspots this step passes within their buffer (names). */
  hazards: string[];
};

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

function compass(bearing: number | undefined): string {
  if (bearing === undefined) return '';
  return COMPASS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function roadName(step: OsrmStep): string {
  const name = step.name?.trim();
  const ref = step.ref?.trim();
  if (name && ref) return `${name} (${ref})`;
  return name || ref || '';
}

export function instructionFor(step: OsrmStep, isLast: boolean): string {
  const m = step.maneuver;
  const mod = m.modifier ?? '';
  const road = roadName(step);
  const onto = road ? ` onto ${road}` : '';
  const on = road ? ` on ${road}` : '';
  const turnWord = mod === 'uturn' ? 'Make a U-turn' : mod === 'straight' ? 'Go straight' : `Turn ${mod}`;

  switch (m.type) {
    case 'depart':
      return `Head ${compass(m.bearing_after) || 'out'}${on}`;
    case 'arrive':
      if (mod === 'left' || mod === 'right') return `Arrive at your destination on the ${mod}`;
      return 'Arrive at your destination';
    case 'turn':
      return `${turnWord}${onto}`;
    case 'end of road':
      return `At the end of the road, ${turnWord.toLowerCase()}${onto}`;
    case 'new name':
      return `Continue${onto}`;
    case 'continue':
      return mod && mod !== 'straight' ? `Continue ${mod}${on}` : `Continue${on}`;
    case 'merge':
      return `Merge${mod ? ` ${mod}` : ''}${onto}`;
    case 'on ramp':
      return `Take the ramp${mod ? ` on the ${mod.replace('slight ', '')}` : ''}${onto}`;
    case 'off ramp':
      return `Take the exit${mod ? ` on the ${mod.replace('slight ', '')}` : ''}${onto}`;
    case 'fork':
      return `Keep ${mod.replace('slight ', '') || 'straight'} at the fork${onto}`;
    case 'roundabout':
    case 'rotary': {
      const circle = step.rotary_name ? `${step.rotary_name} roundabout` : 'the roundabout';
      return m.exit ? `At ${circle}, take the ${ordinal(m.exit)} exit${onto}` : `Enter ${circle}${onto}`;
    }
    case 'roundabout turn':
      return `At the roundabout, ${turnWord.toLowerCase()}${onto}`;
    case 'exit roundabout':
    case 'exit rotary':
      return `Exit the roundabout${onto}`;
    default:
      return isLast ? 'Arrive at your destination' : `Continue${on}`;
  }
}

/**
 * Builds directions and attaches each nearby historical hotspot to the step
 * whose geometry passes closest to it, so warnings appear where they apply.
 */
export function buildDirections(
  steps: OsrmStep[],
  hotspots: { name: string; point: LatLon }[] = [],
): DirectionStep[] {
  const out: DirectionStep[] = steps.map((s, i) => ({
    instruction: instructionFor(s, i === steps.length - 1),
    distanceM: Math.round(s.distance),
    durationS: Math.round(s.duration),
    location: [s.maneuver.location[1], s.maneuver.location[0]],
    type: s.maneuver.type,
    modifier: s.maneuver.modifier ?? null,
    hazards: [],
  }));
  for (const h of hotspots) {
    let best = -1;
    let bestD = Infinity;
    steps.forEach((s, i) => {
      const line: LatLon[] = (s.geometry?.coordinates ?? []).map(([lon, lat]) => [lat, lon]);
      const d = line.length ? pointToPolylineMeters(h.point, line) : Infinity;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best >= 0 && !out[best].hazards.includes(h.name)) out[best].hazards.push(h.name);
  }
  return out;
}
