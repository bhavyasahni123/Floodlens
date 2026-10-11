import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import type { CommunityReport } from './clustering';

export type NewReport = {
  lat: number;
  lon: number;
  description: string;
  locationLabel: string | null;
  sourceHash: string | null;
};

export interface ReportStore {
  insert(report: NewReport): Promise<CommunityReport>;
  /** Active reports per the expiry policy, plus the database clock used to filter them. */
  listActive(expiryHours: number): Promise<{ reports: CommunityReport[]; nowMs: number }>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

type Row = {
  id: string;
  latitude: number;
  longitude: number;
  description: string;
  location_label: string | null;
  submitted_at: Date;
  source_hash: string | null;
};

const toReport = (r: Row): CommunityReport => ({
  id: String(r.id),
  lat: r.latitude,
  lon: r.longitude,
  description: r.description,
  locationLabel: r.location_label,
  submittedAt: r.submitted_at.toISOString(),
  sourceHash: r.source_hash,
});

export function schemaSql(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'db', 'schema.sql'),
    path.resolve(__dirname, '..', '..', '..', 'db', 'schema.sql'),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error('db/schema.sql not found.');
  return fs.readFileSync(file, 'utf-8');
}

export function createPgStore(connectionString: string): ReportStore {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  // A dropped idle connection must not crash the server.
  pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));
  const COLUMNS = 'id, latitude, longitude, description, location_label, submitted_at, source_hash';

  return {
    async insert(report) {
      const { rows } = await pool.query<Row>(
        `INSERT INTO community_reports (latitude, longitude, description, location_label, source_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${COLUMNS}`,
        [report.lat, report.lon, report.description, report.locationLabel, report.sourceHash],
      );
      return toReport(rows[0]);
    },
    async listActive(expiryHours) {
      const { rows } = await pool.query<Row & { db_now: Date }>(
        `SELECT ${COLUMNS}, now() AS db_now FROM community_reports
         WHERE submitted_at > now() - ($1::double precision * interval '1 hour')
           AND submitted_at <= now()
         ORDER BY submitted_at ASC, id ASC
         LIMIT 2000`,
        [expiryHours],
      );
      let nowMs = Date.now();
      if (rows.length > 0) nowMs = rows[0].db_now.getTime();
      else {
        const clock = await pool.query<{ db_now: Date }>('SELECT now() AS db_now');
        nowMs = clock.rows[0].db_now.getTime();
      }
      return { reports: rows.map(toReport), nowMs };
    },
    async ping() {
      await pool.query('SELECT 1');
    },
    async close() {
      await pool.end();
    },
  };
}

export async function migrate(connectionString: string): Promise<void> {
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(schemaSql());
  } finally {
    await pool.end();
  }
}
