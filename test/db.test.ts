import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { groups } from '../src/db/schema.js';

const handle = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => handle.close());

describe('database', () => {
  it('has migrated tables with defaults', async () => {
    const [g] = await handle.db
      .insert(groups)
      .values({ platform: 'test', platformGroupId: `g-${Date.now()}` })
      .returning();
    expect(g!.timezone).toBe('Africa/Lagos');
    expect(g!.creationPolicy).toBe('anyone');
  });
});
