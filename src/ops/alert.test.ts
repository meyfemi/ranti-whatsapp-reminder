import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createAlerter } from './alert.js';

describe('createAlerter', () => {
  it('POSTs the alert as JSON to the webhook', async () => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        received.push(body);
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    await createAlerter(`http://127.0.0.1:${port}/hook`, pino({ level: 'silent' }))('logged out');
    server.close();
    expect(received).toEqual(['{"text":"logged out"}']);
  });

  it('is a no-op (log only) without a webhook and never throws', async () => {
    await expect(createAlerter(undefined, pino({ level: 'silent' }))('x')).resolves.toBeUndefined();
    await expect(createAlerter('http://127.0.0.1:1/nope', pino({ level: 'silent' }))('x')).resolves.toBeUndefined();
  });
});
