import { haversineMeters } from '../geo';

export type CommunityReport = {
  id: string;
  lat: number;
  lon: number;
  description: string;
  locationLabel: string | null;
  /** Server-assigned (database) timestamp, ISO 8601 UTC. */
  submittedAt: string;
  /** Keyed hash of the submitter's network address; null if unknown. Never the raw address. */
  sourceHash: string | null;
};

export type ReportCluster = {
  id: string;
  label: 'Corroborated Community Reports';
  verification: 'UNVERIFIED';
  reportIds: string[];
  reportCount: number;
  /** Distinct submitter hashes. 1 means the reports may all come from one device/network. */
  distinctSources: number;
  independenceEstablished: boolean;
  centroid: [number, number];
  firstSubmittedAt: string;
  lastSubmittedAt: string;
};

export type ClusterOptions = {
  radiusMeters: number;
  windowHours: number;
  minReports: number;
};

export type ExpiryOptions = { expiryHours: number };

const ms = (iso: string) => new Date(iso).getTime();

/** Numeric-aware id comparison so "10" sorts after "9" (database ids are bigserial). */
function compareIds(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Reports submitted within the expiry period before `nowMs`. Future-dated rows are excluded. */
export function filterActive<T extends { submittedAt: string }>(reports: T[], nowMs: number, { expiryHours }: ExpiryOptions): T[] {
  const cutoff = nowMs - expiryHours * 3600e3;
  return reports.filter((r) => {
    const t = ms(r.submittedAt);
    return t > cutoff && t <= nowMs;
  });
}

/**
 * Seed-based clustering without chaining. Every member is within `radiusMeters`
 * and `windowHours` of the cluster's seed report, and each report belongs to
 * at most one cluster. Seeds are chosen by most neighbours, then earliest
 * submission, then lowest id — so output is deterministic for the same input.
 *
 * The caller must pass only active (non-expired) reports.
 */
export function clusterReports(reports: CommunityReport[], opts: ClusterOptions): ReportCluster[] {
  const windowMs = opts.windowHours * 3600e3;
  const sorted = [...reports].sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt) || compareIds(a.id, b.id));
  // Defensive de-duplication: the same database row must never count twice.
  const unique = sorted.filter((r, i) => i === 0 || r.id !== sorted[i - 1].id);
  const neighbours = unique.map((a) =>
    unique.filter(
      (b) =>
        b !== a &&
        Math.abs(ms(a.submittedAt) - ms(b.submittedAt)) <= windowMs &&
        haversineMeters([a.lat, a.lon], [b.lat, b.lon]) <= opts.radiusMeters,
    ),
  );
  const seedOrder = unique
    .map((r, i) => ({ r, i }))
    .sort((x, y) => neighbours[y.i].length - neighbours[x.i].length || x.i - y.i);

  const assigned = new Set<string>();
  const clusters: ReportCluster[] = [];
  for (const { r: seed, i } of seedOrder) {
    if (assigned.has(seed.id)) continue;
    const members = [seed, ...neighbours[i].filter((n) => !assigned.has(n.id))];
    if (members.length < opts.minReports) continue;
    members.sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt) || compareIds(a.id, b.id));
    members.forEach((m) => assigned.add(m.id));
    const sources = new Set(members.map((m) => m.sourceHash ?? `unknown-${m.id}`));
    const knownSources = new Set(members.map((m) => m.sourceHash).filter(Boolean));
    clusters.push({
      id: `cluster-${members[0].id}`,
      label: 'Corroborated Community Reports',
      verification: 'UNVERIFIED',
      reportIds: members.map((m) => m.id),
      reportCount: members.length,
      distinctSources: sources.size,
      // Independence is only claimed when at least two known, different submitters exist.
      independenceEstablished: knownSources.size >= 2,
      centroid: [
        members.reduce((s, m) => s + m.lat, 0) / members.length,
        members.reduce((s, m) => s + m.lon, 0) / members.length,
      ],
      firstSubmittedAt: members[0].submittedAt,
      lastSubmittedAt: members[members.length - 1].submittedAt,
    });
  }
  return clusters.sort((a, b) => ms(a.firstSubmittedAt) - ms(b.firstSubmittedAt) || compareIds(a.reportIds[0], b.reportIds[0]));
}
