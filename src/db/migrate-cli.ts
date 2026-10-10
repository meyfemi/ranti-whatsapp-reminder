import { createDb } from './client.js';
import { runMigrations } from './migrate.js';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
const handle = createDb(url, { max: 1 });
await runMigrations(handle.db);
await handle.close();
console.log('Migrations applied.');
