import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';

export type Severity = 'HIGH' | 'MODERATE' | 'LOW';

export type HazardFeature = {
  type: 'Feature';
  id: string;
  geometry: { type: 'Point'; coordinates: [number, number] }; // [lon, lat]
  properties: {
    name: string;
    infrastructureType: string;
    zone: string;
    severity: Severity;
    bufferRadiusMeters: number;
    hazardType: string;
    dataSource: string;
    lastUpdated: string;
    description: string;
    provenance?: {
      status: string;
      coordinatePrecision: string;
      claimedAttribution: string;
      attributionVerified: boolean;
      severityBasis: string;
      lastVerified: string | null;
      geocodeCrossCheck?: Record<string, unknown>;
    };
  };
};

export type HazardDataset = {
  type: 'FeatureCollection';
  metadata: Record<string, unknown> & {
    datasetName: string;
    hazardType: string;
    lastUpdated: string;
    disclaimer: string;
  };
  features: HazardFeature[];
};

/**
 * Locate the data directory both when running from source (tsx: backend/src)
 * and from the compiled build (node: backend/dist/src).
 */
function resolveDataFile(fileName: string): string | null {
  if (process.env.HOTSPOTS_PATH) return process.env.HOTSPOTS_PATH;
  const candidates = [
    path.resolve(__dirname, '..', 'data', fileName),
    path.resolve(__dirname, '..', '..', 'data', fileName),
    path.resolve(process.cwd(), 'data', fileName),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

export function loadHotspots(): { dataset: HazardDataset | null; error?: string } {
  const file = resolveDataFile(config.city.hotspotFile);
  if (!file) return { dataset: null, error: `Hotspot file ${config.city.hotspotFile} not found.` };
  try {
    const dataset = JSON.parse(fs.readFileSync(file, 'utf-8')) as HazardDataset;
    if (!Array.isArray(dataset.features)) throw new Error('Dataset has no features array.');
    return { dataset };
  } catch (error) {
    return { dataset: null, error: error instanceof Error ? error.message : String(error) };
  }
}
