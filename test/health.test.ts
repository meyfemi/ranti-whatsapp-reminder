import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { startHealthServer } from '../src/ops/health.js';

const handle = createDb(process.env.TEST_DATABASE_URL!);
afterAll(() => handle.close());

describe('health server', () => {
  it('reports readiness from the database and the chat connection', async () => {
    let status = 'waiting_for_pairing';
    const server = await startHealthServer(0, { pool: handle.pool, connectionStatus: () => status });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/livez`)).status).toBe(200);
      const notReady = await fetch(`${base}/healthz`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toEqual({ ok: false, database: 'ok', chat: 'waiting_for_pairing' });
      status = 'open';
      const ready = await fetch(`${base}/healthz`);
      expect(ready.status).toBe(200);
      expect(await ready.json()).toEqual({ ok: true, database: 'ok', chat: 'open' });
      expect((await fetch(`${base}/nope`)).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
