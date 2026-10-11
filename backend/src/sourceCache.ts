export type SourceStatus = 'LIVE' | 'STALE' | 'UNAVAILABLE';

export type SourceResult<T> = {
  status: SourceStatus;
  data: T | null;
  /** When FloodLens last successfully retrieved this data (not the observation time). */
  retrievedAt: string | null;
  /** When FloodLens last attempted a refresh. */
  lastAttemptAt: string | null;
  error?: string;
};

type Options<T> = {
  /** Data younger than this is served without refetching. */
  ttlMs: number;
  /** After a failed refresh, older data is served as STALE until this age, then dropped. */
  maxStaleMs: number;
  load: () => Promise<T>;
  now?: () => number;
};

/**
 * Wraps an external source. A failed refresh is never reported as LIVE: it
 * yields STALE (with the age of the old data) or UNAVAILABLE.
 */
export function createSourceCache<T>({ ttlMs, maxStaleMs, load, now = Date.now }: Options<T>) {
  let value: T | null = null;
  let retrievedAtMs: number | null = null;
  let lastAttemptMs: number | null = null;
  let lastError: string | undefined;
  let inflight: Promise<void> | null = null;

  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

  async function refresh() {
    lastAttemptMs = now();
    try {
      value = await load();
      retrievedAtMs = now();
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }

  async function get(): Promise<SourceResult<T>> {
    const fresh = retrievedAtMs !== null && now() - retrievedAtMs < ttlMs;
    if (!fresh) {
      inflight ??= refresh().finally(() => {
        inflight = null;
      });
      await inflight;
    }
    const age = retrievedAtMs === null ? Infinity : now() - retrievedAtMs;
    const base = { retrievedAt: iso(retrievedAtMs), lastAttemptAt: iso(lastAttemptMs) };
    if (value !== null && age < ttlMs) return { status: 'LIVE', data: value, ...base };
    if (value !== null && age < maxStaleMs) {
      return { status: 'STALE', data: value, ...base, error: lastError };
    }
    return {
      status: 'UNAVAILABLE',
      data: null,
      ...base,
      error: lastError ?? 'No data has been retrieved yet.',
    };
  }

  function reset() {
    value = null;
    retrievedAtMs = null;
    lastAttemptMs = null;
    lastError = undefined;
  }

  return { get, reset };
}

export async function fetchJson<T>(url: string | URL, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 15000, ...rest } = init;
  const response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${new URL(String(url)).host}`);
  }
  return (await response.json()) as T;
}
