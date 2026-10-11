import type { Place, Preference, TravelMode } from '../types';

/** Stored only in this browser. Never synced, never sent to the server. */
export const STORAGE_KEY = 'floodlens.recentRoutes.v1';
export const MAX_RECENT = 8;

export type RecentRoute = {
  origin: Place;
  destination: Place;
  travelMode: TravelMode;
  preference: Preference;
  savedAt: string;
};

const MODES: TravelMode[] = ['driving', 'walking', 'cycling'];
const PREFS: Preference[] = ['Fastest', 'Balanced', 'Lower Risk'];

function validPlace(v: unknown): v is Place {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.lat === 'number' && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 &&
    typeof p.lon === 'number' && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180 &&
    typeof p.label === 'string' && p.label.length > 0 && p.label.length <= 300
  );
}

function validRecent(v: unknown): v is RecentRoute {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    validPlace(r.origin) &&
    validPlace(r.destination) &&
    MODES.includes(r.travelMode as TravelMode) &&
    PREFS.includes(r.preference as Preference) &&
    typeof r.savedAt === 'string' &&
    !Number.isNaN(Date.parse(r.savedAt))
  );
}

/** Parses stored JSON, silently dropping malformed or outdated entries. */
export function parseRecent(raw: string | null): RecentRoute[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(validRecent).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/** A device location is stored only to ~100 m precision and labelled as approximate. */
function storable(p: Place): Place {
  if (!p.fromGeolocation) return { lat: p.lat, lon: p.lon, label: p.label };
  return { lat: Math.round(p.lat * 1000) / 1000, lon: Math.round(p.lon * 1000) / 1000, label: 'My location (approx.)' };
}

const same = (a: Place, b: Place) => a.label === b.label && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lon - b.lon) < 1e-4;

export function addRecent(list: RecentRoute[], entry: Omit<RecentRoute, 'savedAt'>, now = new Date()): RecentRoute[] {
  const item: RecentRoute = {
    origin: storable(entry.origin),
    destination: storable(entry.destination),
    travelMode: entry.travelMode,
    preference: entry.preference,
    savedAt: now.toISOString(),
  };
  const rest = list.filter((r) => !(same(r.origin, item.origin) && same(r.destination, item.destination) && r.travelMode === item.travelMode));
  return [item, ...rest].slice(0, MAX_RECENT);
}

export function loadRecent(): RecentRoute[] {
  try {
    return parseRecent(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveRecent(list: RecentRoute[]): void {
  try {
    if (list.length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // Storage may be unavailable (private mode); history simply isn't kept.
  }
}
