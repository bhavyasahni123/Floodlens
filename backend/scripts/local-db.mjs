// Starts a real PostgreSQL server for local development without a system install,
// using the embedded-postgres dev dependency. Data persists in backend/.pgdata.
// Usage: npm run db:local   (keep this terminal open; Ctrl+C to stop)
import EmbeddedPostgres from 'embedded-postgres';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', '.pgdata');
const port = Number(process.env.LOCAL_PG_PORT || 5433);
const password = process.env.LOCAL_PG_PASSWORD || 'floodlens_local';

const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password, port, persistent: true });
if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
await pg.start();
try {
  await pg.createDatabase('floodlens');
} catch {
  // Already exists.
}
console.log(`\nLocal PostgreSQL running on port ${port}. Put this in backend/.env:\n`);
console.log(`DATABASE_URL=postgres://postgres:${password}@localhost:${port}/floodlens\n`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
