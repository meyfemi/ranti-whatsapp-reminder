import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string = process.env.LOG_LEVEL ?? 'info'): Logger {
  return pino({ level, base: { app: 'ranti' } });
}
