import { afterAll, describe, expect, it } from 'vitest';
import { PgBossQueue } from '../src/scheduler/queue.js';
import { silentLogger } from './helpers.js';

describe('PgBossQueue (real pg-boss)', () => {
  const queue = new PgBossQueue(process.env.TEST_DATABASE_URL!, silentLogger);
  afterAll(() => queue.stop());

  it('delivers a job at its startAfter time and dedupes by occurrence', async () => {
    const received: { id: number; at: number }[] = [];
    await queue.start(async (id) => {
      received.push({ id, at: Date.now() });
    });
    const fireAt = new Date(Date.now() + 2000);
    const enqueuedAt = Date.now();
    await queue.enqueue(42, fireAt);
    await queue.enqueue(42, fireAt); // duplicate: deduped by singletonKey
    await queue.enqueue(43, new Date(Date.now() + 500));

    const deadline = Date.now() + 12_000;
    while (received.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 1500)); // give a duplicate the chance to show up

    expect(received.map((r) => r.id).sort()).toEqual([42, 43]);
    const job42 = received.find((r) => r.id === 42)!;
    expect(job42.at - enqueuedAt).toBeGreaterThanOrEqual(1500);
  }, 20_000);
});
