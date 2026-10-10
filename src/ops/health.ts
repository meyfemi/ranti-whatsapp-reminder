import { createServer, type Server } from 'node:http';
import type pg from 'pg';

export interface HealthDeps {
  pool: pg.Pool;
  /** Current chat connection status, e.g. "open", "reconnecting", "waiting_for_pairing". */
  connectionStatus: () => string;
}

export interface HealthReport {
  ok: boolean;
  database: 'ok' | 'error';
  chat: string;
}

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  let database: HealthReport['database'] = 'ok';
  try {
    await deps.pool.query('select 1');
  } catch {
    database = 'error';
  }
  const chat = deps.connectionStatus();
  return { ok: database === 'ok' && chat === 'open', database, chat };
}

/**
 * GET /livez  → 200 while the process is up (use for liveness; never restarts a bot waiting to be paired).
 * GET /healthz → 200 when the database is reachable and WhatsApp is connected, else 503 (readiness/alerting).
 */
export function startHealthServer(port: number, deps: HealthDeps): Promise<Server> {
  const server = createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (req.url === '/livez') return send(200, { ok: true });
    if (req.url === '/healthz' || req.url === '/health') {
      checkHealth(deps)
        .then((report) => send(report.ok ? 200 : 503, report))
        .catch(() => send(503, { ok: false }));
      return;
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
