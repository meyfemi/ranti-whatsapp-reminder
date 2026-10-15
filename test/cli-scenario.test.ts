import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CliAdapter } from '../src/adapters/cli/cli-adapter.js';
import { registerClockCommands } from '../src/adapters/cli/clock-commands.js';
import { Bot } from '../src/bot/bot.js';
import { DigestService } from '../src/digest/service.js';
import { Dispatcher } from '../src/dispatcher/dispatcher.js';
import { TemplateGreeter } from '../src/dispatcher/greetings.js';
import type { ParsedCommand } from '../src/parser/schema.js';
import { ReminderService } from '../src/reminders/service.js';
import { FakeClock } from '../src/scheduler/clock.js';
import { ManualQueue } from '../src/scheduler/queue.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import { createDb } from '../src/db/client.js';
import { ScriptedParser, silentLogger, truncateAll } from './helpers.js';

/** The CLI simulator end to end: real adapter, bot, scheduler and dispatcher; scripted parser; fake clock. */
const handle = createDb(process.env.TEST_DATABASE_URL!, { max: 3 });
const clock = new FakeClock(new Date('2026-10-07T09:00:00Z')); // Wed 7 Oct, 10:00 WAT
const out = new PassThrough();
let printed = '';
out.on('data', (d) => (printed += String(d)));
const cli = new CliAdapter({ botName: 'Ranti', output: out, now: () => clock.now() });
const queue = new ManualQueue();
const scheduler = new Scheduler(queue, clock, silentLogger);
const dispatcher = new Dispatcher(handle.db, cli, scheduler, new TemplateGreeter(() => 0), clock, silentLogger);
const service = new ReminderService(handle.db, scheduler, clock, silentLogger, { maxActivePerGroup: 50 });
const digests = new DigestService(handle.db, cli, queue, clock, silentLogger, { botName: 'Ranti', random: () => 0 });
const parser = new ScriptedParser();
new Bot(handle.db, cli, parser, service, digests, clock, silentLogger, { platform: 'cli', botName: 'Ranti', defaultTimezone: 'Africa/Lagos' }).attach();
registerClockCommands(cli, { db: handle.db, clock, dispatcher, digests, timezone: 'Africa/Lagos', out });
afterAll(() => handle.close());
beforeEach(() => truncateAll(handle));

const run = async (...lines: string[]) => {
  printed = '';
  for (const l of lines) await cli.handleLine(l);
  return printed;
};

const entry = (raw_line: string, name_text: string | null, month: number, day: number, mention_user_id: string | null = null) => ({
  raw_line, name_text, mention_user_id, month, day, year: null,
});

describe('CLI scenario: bulk birthday import', () => {
  it('paste a list, edit it, confirm, fast-forward and see the wishes', async () => {
    const list: ParsedCommand = {
      action: 'bulk_add_birthdays',
      entries: [entry('@john 12 Oct', null, 10, 12, 'cli:john'), entry('Tunde 13/10', 'Tunde', 10, 13), entry('Sola 3 March', 'Sola', 3, 3)],
      unparsed: ['Uncle T sometime in May'],
    };
    parser.queue.push(list);
    const preview = await run('/paste', '@Ranti add these birthdays:', '@john 12 Oct', 'Tunde 13/10', 'Sola 3 March', 'Uncle T sometime in May', '/end');
    expect(parser.inputs.at(-1)!.text).toBe('add these birthdays:\n@john 12 Oct\nTunde 13/10\nSola 3 March\nUncle T sometime in May');
    expect(preview).toContain('1. john (tagged) – 12 Oct\n2. Tunde – 13 Oct\n3. Sola – 3 Mar');
    expect(preview).not.toContain('(mentions:');

    expect(await run('/reply remove 3')).toContain('I found 2 birthdays:');
    expect(await run('/reply fix 2: 14 Oct')).toContain('2. Tunde – 14 Oct');
    expect(await run('/reply yes')).toContain("Saved 2 birthdays. I'll wish each person at 06:00 on their day.");

    const day1 = await run('/settime 2026-10-12T06:01');
    expect(day1).toContain('🎂 Happy birthday @john!');
    expect(day1).toContain('(mentions: cli:john)');
    expect(day1).toContain('1 reminder(s) fired.');

    const day3 = await run('/advance 2d');
    expect(day3).toContain('🎂 Happy birthday Tunde!');
    expect(day3.split('\n').find((l) => l.includes('Tunde'))).not.toContain('(mentions:');
  });
});

describe('CLI scenario: weekly digest', () => {
  const create = (title: string, start_local: string, over: Partial<Extract<ParsedCommand, { action: 'create' }>> = {}): ParsedCommand => ({
    action: 'create', title, kind: 'event', start_local, rrule: null, offsets_minutes: [0], subject_user_id: null, message_style: null, ...over,
  });
  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it('create reminders, turn on the digest, fast-forward: one digest per week', async () => {
    clock.set(new Date('2026-10-07T09:00:00Z')); // Wed 7 Oct, 10:00 WAT
    parser.queue.push(
      create('Choir practice', '2026-10-08T18:00:00', { rrule: 'FREQ=WEEKLY;BYDAY=TH' }),
      create("Ada's birthday", '2026-10-14T06:00:00', { kind: 'birthday', rrule: 'FREQ=YEARLY' }),
      create('Wedding', '2026-10-17T14:00:00'),
      { action: 'set_digest', enabled: 'on', weekday: null, time: null, empty_weeks: null },
    );
    await run('@Ranti choir every Thursday 6pm', "@Ranti 14 Oct is Ada's birthday", '@Ranti wedding 17 Oct 2pm');
    expect(await run('@Ranti turn on the weekly digest')).toContain('Weekly digest is on: Mondays at 08:00 (Africa/Lagos). Next one: Mon 12 Oct.');

    const firstWeek = await run('/settime 2026-10-12T08:00');
    expect(count(firstWeek, '📅 This week')).toBe(1);
    expect(firstWeek).toContain(
      ['📅 This week in family (12–18 Oct)', '', "Wed 14 – 🎂 Ada's birthday", 'Thu 15 – Choir practice, 18:00', 'Sat 17 – Wedding, 14:00', '', 'Have a great week!'].join('\n'),
    );

    const secondWeek = await run('/advance 7d');
    expect(count(secondWeek, '📅 This week')).toBe(1);
    expect(secondWeek).toContain('📅 This week in family (19–25 Oct)\n\nThu 22 – Choir practice, 18:00');
    // The reminders themselves still fired on the way.
    expect(secondWeek).toContain("🎂 Today: Ada's birthday!");
  });
});
