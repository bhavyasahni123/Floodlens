import type {
  HazardFeature,
  Intelligence,
  Place,
  PlaceSuggestion,
  Preference,
  ReportsResponse,
  RouteResponse,
  TravelMode,
} from './types';

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') || 'http://localhost:5000';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(API_BASE + path, {
      ...init,
      headers: init.body ? { 'Content-Type': 'application/json', ...init.headers } : init.headers,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the FloodLens server. Check your connection and that the backend is running.', 0, true);
  }
  const body = (await response.json().catch(() => null)) as ({ success?: boolean; message?: string; retryable?: boolean } & T) | null;
  if (!response.ok || !body || body.success === false) {
    const retryable = body?.retryable ?? (response.status >= 500 || response.status === 429);
    throw new ApiError(body?.message || `Request failed (HTTP ${response.status}).`, response.status, retryable);
  }
  return body;
}

export function searchPlaces(q: string, signal?: AbortSignal) {
  return request<{ provider: string; results: PlaceSuggestion[] }>(`/api/geocode?q=${encodeURIComponent(q)}`, { signal });
}

export function planRoutes(
  args: { origin: Place; destination: Place; travelMode: TravelMode; preference: Preference },
  signal?: AbortSignal,
) {
  return request<RouteResponse>('/api/routes', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      origin: { lat: args.origin.lat, lon: args.origin.lon, label: args.origin.label },
      destination: { lat: args.destination.lat, lon: args.destination.lon, label: args.destination.label },
      travelMode: args.travelMode,
      mode: args.preference,
    }),
  });
}

export const getIntelligence = () => request<Intelligence>('/api/intelligence');
export const getHazards = () => request<{ features: HazardFeature[]; metadata: Record<string, unknown> }>('/api/hazards');
export const getReports = () => request<ReportsResponse>('/api/reports');

export function submitReport(body: { lat: number; lon: number; description: string; locationLabel?: string }) {
  return request<{ message: string }>('/api/reports', { method: 'POST', body: JSON.stringify(body) });
}
