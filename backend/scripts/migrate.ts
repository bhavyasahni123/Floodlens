import { config } from '../src/config';
import { migrate } from '../src/reports/store';

if (!config.databaseUrl) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
migrate(config.databaseUrl)
  .then(() => console.log('Schema applied: community_reports is ready.'))
  .catch((error) => {
    console.error('Migration failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
