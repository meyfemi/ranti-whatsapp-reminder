import { pino } from 'pino';
import type { ChatAdapter, IncomingMessage, Member } from '../src/adapters/types.js';
import { createDb, type DbHandle } from '../src/db/client.js';
import { upsertGroup, upsertMember } from '../src/db/repositories.js';
import type { Group, MemberRow } from '../src/db/schema.js';
import { Dispatcher, type DispatcherOptions } from '../src/dispatcher/dispatcher.js';
import { TemplateGreeter, type Greeter } from '../src/dispatcher/greetings.js';
import type { ActorContext } from '../src/reminders/types.js';
import { ReminderService } from '../src/reminders/service.js';
import { FakeClock } from '../src/scheduler/clock.js';
import { ManualQueue } from '../src/scheduler/queue.js';
import { Recovery } from '../src/scheduler/recovery.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

export const silentLogger = pino({ level: 'silent' });

export interface SentMessage {
  groupId: string;
  text: string;
  mentionUserIds: string[];
}

/** A ChatAdapter test double that records what would have been sent. */
export class RecordingAdapter implements ChatAdapter {
  sent: SentMessage[] = [];
  failNext = 0;
  sendDelayMs = 0;
  members = new Map<string, Member[]>();
  private messageHandler?: (msg: IncomingMessage) => Promise<void>;
  private addedHandler?: (groupId: string) => Promise<void>;

  async start(): Promise<void> {}
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void {
    this.messageHandler = handler;
  }
  onBotAddedToGroup(handler: (groupId: string) => Promise<void>): void {
    this.addedHandler = handler;
  }
  async sendText(groupId: string, text: string, mentionUserIds: string[] = []): Promise<void> {
    if (this.sendDelayMs) await new Promise((r) => setTimeout(r, this.sendDelayMs));
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated send failure');
    }
    this.sent.push({ groupId, text, mentionUserIds });
  }
  async getGroupMembers(groupId: string): Promise<Member[]> {
    return this.members.get(groupId) ?? [];
  }
  formatMention(userId: string): string {
    return `@${userId.split('@')[0]}`;
  }
  async receive(msg: IncomingMessage): Promise<void> {
    await this.messageHandler?.(msg);
  }
  async botAdded(groupId: string): Promise<void> {
    await this.addedHandler?.(groupId);
  }
}

export async function truncateAll(handle: DbHandle): Promise<void> {
  await handle.pool.query(
    'truncate groups, members, reminders, occurrences, pending_interactions restart identity cascade',
  );
}

export interface TestEnv {
  handle: DbHandle;
  clock: FakeClock;
  queue: ManualQueue;
  adapter: RecordingAdapter;
  scheduler: Scheduler;
  dispatcher: Dispatcher;
  recovery: Recovery;
  service: ReminderService;
  greeter: Greeter;
}

export function createTestEnv(
  opts: { now?: string; dispatcher?: DispatcherOptions; maxActive?: number; greeter?: Greeter } = {},
): TestEnv {
  const handle = createDb(process.env.TEST_DATABASE_URL!, { max: 5 });
  const clock = new FakeClock(new Date(opts.now ?? '2026-10-10T12:00:00Z'));
  const queue = new ManualQueue();
  const adapter = new RecordingAdapter();
  const scheduler = new Scheduler(queue, clock, silentLogger);
  const greeter = opts.greeter ?? new TemplateGreeter(() => 0);
  const dispatcher = new Dispatcher(handle.db, adapter, scheduler, greeter, clock, silentLogger, opts.dispatcher);
  const recovery = new Recovery(handle.db, scheduler, dispatcher, clock, silentLogger);
  const service = new ReminderService(handle.db, scheduler, clock, silentLogger, {
    maxActivePerGroup: opts.maxActive ?? 50,
  });
  return { handle, clock, queue, adapter, scheduler, dispatcher, recovery, service, greeter };
}

export async function makeActor(
  env: TestEnv,
  opts: { groupId?: string; userId?: string; name?: string; isAdmin?: boolean; timezone?: string } = {},
): Promise<ActorContext & { group: Group; member: MemberRow }> {
  const { group } = await upsertGroup(env.handle.db, {
    platform: 'test',
    platformGroupId: opts.groupId ?? 'group-1',
    name: 'Family',
    defaultTimezone: opts.timezone ?? 'Africa/Lagos',
  });
  const member = await upsertMember(env.handle.db, group.id, {
    userId: opts.userId ?? 'alice@s.whatsapp.net',
    displayName: opts.name ?? 'Alice',
  });
  return { group, member, isAdmin: opts.isAdmin ?? false };
}
