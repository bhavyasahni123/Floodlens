import { config } from '../config';

export type PlaceSuggestion = {
  label: string;
  /** Secondary line, e.g. district and state. */
  detail: string;
  lat: number;
  lon: number;
};

export class GeocodingError extends Error {
  constructor(message: string, readonly rateLimited = false) {
    super(message);
  }
}

const CACHE_TTL_MS = 60 * 60e3;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: PlaceSuggestion[] }>();

function cached(key: string): PlaceSuggestion[] | null {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_TTL_MS) return null;
  return hit.value;
}

function remember(key: string, value: PlaceSuggestion[]) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: Date.now(), value });
}

// Nominatim's usage policy allows at most 1 request per second.
let nominatimChain: Promise<unknown> = Promise.resolve();
function throttledNominatim<T>(task: () => Promise<T>): Promise<T> {
  const run = nominatimChain.then(task);
  nominatimChain = run.catch(() => undefined).then(() => new Promise((r) => setTimeout(r, 1100)));
  return run;
}

type NominatimPlace = { lat: string; lon: string; display_name: string; name?: string };

async function nominatimSearch(query: string, limit: number): Promise<PlaceSuggestion[]> {
  const [west, south, east, north] = config.city.bbox;
  const url = new URL('/search', config.providers.nominatimUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('countrycodes', 'in');
  // Bias (not restrict) results towards the configured city.
  url.searchParams.set('viewbox', `${west},${north},${east},${south}`);
  const response = await throttledNominatim(() =>
    fetch(url, { headers: { 'User-Agent': config.providers.userAgent }, signal: AbortSignal.timeout(15000) }),
  );
  if (response.status === 429) throw new GeocodingError('Place search is rate-limited. Wait a moment and retry.', true);
  if (!response.ok) throw new GeocodingError('The place search service is temporarily unavailable.');
  const places = (await response.json()) as NominatimPlace[];
  return places.map((p) => {
    const parts = p.display_name.split(',').map((s) => s.trim());
    return { label: p.name || parts[0], detail: parts.slice(1, 4).join(', '), lat: Number(p.lat), lon: Number(p.lon) };
  });
}

type PhotonResponse = {
  features: {
    geometry: { coordinates: [number, number] };
    properties: { name?: string; street?: string; housenumber?: string; district?: string; city?: string; county?: string; state?: string };
  }[];
};

async function photonSearch(query: string, limit: number): Promise<PlaceSuggestion[]> {
  const url = new URL('/api/', config.providers.photonUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('lang', 'en');
  url.searchParams.set('lat', String(config.city.center.lat));
  url.searchParams.set('lon', String(config.city.center.lon));
  const response = await fetch(url, {
    headers: { 'User-Agent': config.providers.userAgent },
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 429) throw new GeocodingError('Place search is rate-limited. Wait a moment and retry.', true);
  if (!response.ok) throw new GeocodingError('The suggestion service is temporarily unavailable.');
  const data = (await response.json()) as PhotonResponse;
  return data.features
    .filter((f) => f.properties.name || f.properties.street)
    .map((f) => {
      const p = f.properties;
      const label = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ');
      const detail = [p.street !== label ? p.street : undefined, p.district, p.city ?? p.county, p.state]
        .filter(Boolean)
        .join(', ');
      return { label, detail, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
    });
}

/**
 * Type-ahead suggestions. Photon is designed for search-as-you-type; Nominatim's
 * policy forbids autocomplete, so it is only used as a fallback when Photon fails.
 */
export async function suggestPlaces(query: string): Promise<{ provider: string; results: PlaceSuggestion[] }> {
  const key = `s:${query.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return { provider: 'cache', results: hit };
  try {
    const results = await photonSearch(query, 6);
    remember(key, results);
    return { provider: 'Photon (komoot)', results };
  } catch (photonError) {
    const results = await nominatimSearch(query, 5).catch(() => {
      throw photonError;
    });
    remember(key, results);
    return { provider: 'Nominatim', results };
  }
}

/** Single best match for a free-text place (used when the client sends text instead of coordinates). */
export async function geocodeOne(query: string): Promise<PlaceSuggestion | null> {
  const key = `g:${query.toLowerCase()}`;
  const hit = cached(key);
  if (hit) return hit[0] ?? null;
  const results = await nominatimSearch(query, 1);
  remember(key, results);
  return results[0] ?? null;
}
