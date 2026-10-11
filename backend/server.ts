import { createApp, defaultDeps } from './src/app';
import { config } from './src/config';
import { createPgStore, migrate, type ReportStore } from './src/reports/store';

async function main() {
  let store: ReportStore | null = null;
  if (config.databaseUrl) {
    try {
      await migrate(config.databaseUrl);
      store = createPgStore(config.databaseUrl);
      console.log('PostgreSQL connected; community reports enabled.');
    } catch (error) {
      // The rest of FloodLens still works; reports report themselves as unavailable.
      console.error('PostgreSQL unavailable — community reports disabled:', error instanceof Error ? error.message : error);
    }
  } else {
    console.warn('DATABASE_URL is not set — community reports are disabled. See backend/README.md.');
  }

  const app = createApp(defaultDeps(store));
  app.listen(config.port, () => {
    console.log(`FloodLens backend running at http://localhost:${config.port}`);
  });
}

void main();
