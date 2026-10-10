import type { ChatAdapter } from './adapters/types.js';
import type { Config } from './config.js';
import { createDb, type DbHandle } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { Dispatcher } from './dispatcher/dispatcher.js';
import { TemplateGreeter, type Greeter } from './dispatcher/greetings.js';
import type { Logger } from './logger.js';
import { ReminderService } from './reminders/service.js';
import { systemClock, type Clock } from './scheduler/clock.js';
import { ManualQueue, PgBossQueue, type JobQueue } from './scheduler/queue.js';
import { Recovery } from './scheduler/recovery.js';
import { Scheduler } from './scheduler/scheduler.js';

export interface AppOptions {
  config: Config;
  logger: Logger;
  adapter: ChatAdapter;
  clock?: Clock;
  /** "pgboss" for production; "manual" when time is simulated (sweeper-only delivery). */
  queueMode?: 'pgboss' | 'manual';
  sweepIntervalMs?: number;
  greeter?: Greeter;
}

export interface App {
  handle: DbHandle;
  clock: Clock;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  recovery: Recovery;
  reminders: ReminderService;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Composition root: wires the database, scheduler, dispatcher and services around an adapter. */
export async function createApp(opts: AppOptions): Promise<App> {
  const { config, logger, adapter } = opts;
  const clock = opts.clock ?? systemClock;
  const handle = createDb(config.DATABASE_URL);
  await runMigrations(handle.db);

  const pgboss = opts.queueMode === 'manual' ? undefined : new PgBossQueue(config.DATABASE_URL, logger);
  const queue: JobQueue = pgboss ?? new ManualQueue();
  const scheduler = new Scheduler(queue, clock, logger);
  const greeter = opts.greeter ?? new TemplateGreeter();
  const dispatcher = new Dispatcher(handle.db, adapter, scheduler, greeter, clock, logger);
  const recovery = new Recovery(handle.db, scheduler, dispatcher, clock, logger);
  const reminders = new ReminderService(handle.db, scheduler, clock, logger, {
    maxActivePerGroup: config.MAX_ACTIVE_REMINDERS_PER_GROUP,
  });

  return {
    handle,
    clock,
    scheduler,
    dispatcher,
    recovery,
    reminders,
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
      await handle.close();
    },
  };
}
