import type { ChatAdapter } from './adapters/types.js';
import { Bot } from './bot/bot.js';
import type { Config } from './config.js';
import { createDb, type DbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { TemplateGreeter, type Greeter } from './dispatcher/greetings.js';
import { LlmGreeter } from './dispatcher/llm-greeter.js';
import { AnthropicParser } from './parser/anthropic-parser.js';
import type { Parser } from './parser/types.js';
import type { Logger } from './logger.js';
import { ReminderService } from './reminders/service.js';
import { systemClock, type Clock } from './scheduler/clock.js';
import { ManualQueue, PgBossQueue, type JobQueue } from './scheduler/queue.js';
import { Recovery } from './scheduler/recovery.js';
import { Scheduler } from './scheduler/scheduler.js';

export interface AppOptions {
  config: Config;
  logger: Logger;
  /** The chat adapter, or a factory for adapters that need the database (WhatsApp auth state). */
  adapter: ChatAdapter | ((handle: DbHandle) => ChatAdapter);
  clock?: Clock;
  /** "pgboss" for production; "manual" when time is simulated (sweeper-only delivery). */
  queueMode?: 'pgboss' | 'manual';
  sweepIntervalMs?: number;
  greeter?: Greeter;
  parser?: Parser;
  /** Platform name stored on groups, e.g. "whatsapp" or "cli". */
  platform: string;
}

export interface App {
  handle: DbHandle;
  adapter: ChatAdapter;
  clock: Clock;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  recovery: Recovery;
  reminders: ReminderService;
  bot: Bot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Composition root: wires the database, scheduler, dispatcher and services around an adapter. */
export async function createApp(opts: AppOptions): Promise<App> {
  const { config, logger } = opts;
  const clock = opts.clock ?? systemClock;
  const handle = createDb(config.DATABASE_URL);
  await runMigrations(handle.db);
  const adapter = typeof opts.adapter === 'function' ? opts.adapter(handle) : opts.adapter;

  const pgboss = opts.queueMode === 'manual' ? undefined : new PgBossQueue(config.DATABASE_URL, logger);
  const queue: JobQueue = pgboss ?? new ManualQueue();
  const scheduler = new Scheduler(queue, clock, logger);
  const greeter =
    opts.greeter ??
    (config.LLM_GREETINGS
      ? new LlmGreeter(config.PARSER_MODEL, logger, { apiKey: config.ANTHROPIC_API_KEY })
      : new TemplateGreeter());
  const dispatcher = new Dispatcher(handle.db, adapter, scheduler, greeter, clock, logger);
  const recovery = new Recovery(handle.db, scheduler, dispatcher, clock, logger);
  const reminders = new ReminderService(handle.db, scheduler, clock, logger, {
    maxActivePerGroup: config.MAX_ACTIVE_REMINDERS_PER_GROUP,
  });
  const parser =
    opts.parser ??
    new AnthropicParser({ apiKey: config.ANTHROPIC_API_KEY, model: config.PARSER_MODEL, botName: config.BOT_NAME, logger });
  const bot = new Bot(handle.db, adapter, parser, reminders, clock, logger, {
    platform: opts.platform,
    botName: config.BOT_NAME,
    defaultTimezone: config.DEFAULT_TIMEZONE,
  });
  bot.attach();

  return {
    handle,
    adapter,
    clock,
    scheduler,
    dispatcher,
    recovery,
    reminders,
    bot,
    async start() {
      if (pgboss) {
        await pgboss.start(async (occurrenceId) => {
          await dispatcher.dispatch(occurrenceId);
        });
      }
      await recovery.runStartup();
      recovery.startSweeper(opts.sweepIntervalMs ?? 60_000);
    },
    async stop() {
      recovery.stopSweeper();
      await pgboss?.stop();
      await adapter.stop?.();
      await handle.close();
    },
  };
}
