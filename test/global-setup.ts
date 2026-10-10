import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

export const DEFAULT_TEST_DB = 'postgres://ranti:ranti@localhost:5433/ranti_test';

export default async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DB;
  process.env.TEST_DATABASE_URL = url;
  const handle = createDb(url, { max: 1 });
  try {
    await handle.pool.query('select 1');
  } catch (err) {
    await handle.close();
    throw new Error(
      `Cannot reach the test database at ${url}. Start it with "docker compose up -d". (${(err as Error).message})`,
    );
  }
  // Start every run from a clean schema so migrations are exercised too.
  await handle.pool.query('drop schema if exists public cascade; drop schema if exists drizzle cascade; drop schema if exists pgboss cascade; create schema public;');
  await runMigrations(handle.db);
  await handle.close();
}
