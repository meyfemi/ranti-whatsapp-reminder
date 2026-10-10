import { WhatsAppAdapter } from './adapters/whatsapp/whatsapp-adapter.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createAlerter } from './ops/alert.js';
import { startHealthServer } from './ops/health.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);

if (config.ADAPTER === 'cli') {
  logger.error('ADAPTER=cli: run "pnpm cli" for the local simulator.');
  process.exit(1);
}
if (!config.ANTHROPIC_API_KEY) logger.warn('ANTHROPIC_API_KEY is not set; the parser will fail until it is.');

const alertOwner = createAlerter(config.ALERT_WEBHOOK_URL, logger);
let whatsapp: WhatsAppAdapter | undefined;

const app = await createApp({
  config,
  logger,
  platform: 'whatsapp',
  adapter: (handle) =>
    (whatsapp = new WhatsAppAdapter({
      pool: handle.pool,
      sessionName: config.WA_SESSION_NAME,
      logger,
      alertOwner,
      pairingPhone: config.WA_PAIRING_PHONE,
      globalPerMinute: config.RATE_LIMIT_GLOBAL_PER_MINUTE,
      groupPerMinute: config.RATE_LIMIT_GROUP_PER_MINUTE,
      inboundPerGroupPerMinute: config.INBOUND_PER_GROUP_PER_MINUTE,
      replyDelayMinMs: config.REPLY_DELAY_MIN_MS,
      replyDelayMaxMs: config.REPLY_DELAY_MAX_MS,
    })),
});

const health = await startHealthServer(config.HEALTH_PORT, {
  pool: app.handle.pool,
  connectionStatus: () => whatsapp?.connectionStatus ?? 'starting',
});
logger.info({ port: config.HEALTH_PORT }, 'Health endpoint listening (/livez, /healthz)');

let shuttingDown = false;
async function shutdown(signal: string, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Shutting down');
  health.close();
  await app.stop().catch((err) => logger.error({ err }, 'Error during shutdown'));
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

try {
  logger.info('Connecting to WhatsApp...');
  await app.adapter.start();
  await app.start();
  logger.info({ status: whatsapp?.connectionStatus }, 'Ranti is running');
} catch (err) {
  logger.fatal({ err }, 'Startup failed');
  await shutdown('startup-failure', 1);
}
