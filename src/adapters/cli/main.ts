// CLI simulator entrypoint: a fake WhatsApp group in your terminal, backed by the real database,
// scheduler and dispatcher. Time can be fast-forwarded with /advance.
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { OffsetClock } from '../../scheduler/clock.js';
import { CliAdapter } from './cli-adapter.js';
import { registerClockCommands } from './clock-commands.js';

const config = loadConfig({ LOG_LEVEL: 'warn', ...process.env, ADAPTER: 'cli' });
const logger = createLogger(config.LOG_LEVEL);
const clock = new OffsetClock();
const adapter = new CliAdapter({ botName: config.BOT_NAME, now: () => clock.now() });
if (!config.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. The CLI uses the real parser, so it needs an API key (see .env.example).');
  process.exit(1);
}
const app = await createApp({ config, logger, adapter, clock, queueMode: 'manual', sweepIntervalMs: 2000, platform: 'cli' });

const showClock = registerClockCommands(adapter, {
  db: app.handle.db,
  clock,
  dispatcher: app.dispatcher,
  timezone: config.DEFAULT_TIMEZONE,
  isShifted: () => clock.isShifted,
});

await app.start();
process.stdout.write(showClock());
await adapter.start();
await app.stop();
