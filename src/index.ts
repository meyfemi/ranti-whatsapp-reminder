import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const handle = createDb(config.DATABASE_URL);
await runMigrations(handle.db);
logger.info({ adapter: config.ADAPTER }, 'Ranti skeleton started; migrations applied');
await handle.close();
