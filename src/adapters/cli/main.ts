// CLI simulator entrypoint: a fake WhatsApp group in your terminal, backed by the real database,
// scheduler and dispatcher. Time can be fast-forwarded with /advance.
import { DateTime } from 'luxon';
import { createApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { upsertGroup, upsertMember } from '../../db/repositories.js';
import { createLogger } from '../../logger.js';
import { OffsetClock, parseDuration } from '../../scheduler/clock.js';
import { fastForward } from '../../scheduler/fast-forward.js';
import { CliAdapter } from './cli-adapter.js';

const config = loadConfig({ LOG_LEVEL: 'warn', ...process.env, ADAPTER: 'cli' });
const logger = createLogger(config.LOG_LEVEL);
const clock = new OffsetClock();
const adapter = new CliAdapter({ botName: config.BOT_NAME, now: () => clock.now() });
const app = await createApp({ config, logger, adapter, clock, queueMode: 'manual', sweepIntervalMs: 2000 });

const showClock = () => {
  const now = DateTime.fromJSDate(clock.now()).setZone(config.DEFAULT_TIMEZONE);
  return `🕒 ${now.toFormat('ccc d LLL yyyy HH:mm:ss')} (${config.DEFAULT_TIMEZONE})${clock.isShifted ? ' [simulated]' : ''}\n`;
};

adapter.registerCommand('clock', 'show the simulated time', () => {
  process.stdout.write(showClock());
});
adapter.registerCommand('advance', 'fast-forward time, e.g. /advance 2h or /advance 1d6h', async (args) => {
  const ms = parseDuration(args.join(''));
  if (!ms) return void process.stdout.write('Usage: /advance 90s | 5m | 2h | 3d | 1w (combinable: 1d2h)\n');
  const fired = await fastForward(app.handle.db, clock, app.dispatcher, new Date(clock.now().getTime() + ms));
  process.stdout.write(`${showClock()}${fired} reminder(s) fired.\n`);
});
adapter.registerCommand('settime', 'jump to a local time, e.g. /settime 2026-10-12T08:59', async (args) => {
  const target = DateTime.fromISO(args.join('T'), { zone: config.DEFAULT_TIMEZONE });
  if (!target.isValid) return void process.stdout.write('Usage: /settime 2026-10-12T08:59\n');
  const fired = await fastForward(app.handle.db, clock, app.dispatcher, target.toJSDate());
  process.stdout.write(`${showClock()}${fired} reminder(s) fired.\n`);
});

// Milestone 2: a hard-coded command to exercise the scheduler. Replaced by the parser in milestone 3.
adapter.onMessage(async (msg) => {
  if (!msg.mentionsBot) return;
  const { group } = await upsertGroup(app.handle.db, {
    platform: 'cli',
    platformGroupId: msg.groupId,
    defaultTimezone: config.DEFAULT_TIMEZONE,
  });
  const member = await upsertMember(app.handle.db, group.id, { userId: msg.senderId, displayName: msg.senderDisplayName });
  if (!/^test\b/i.test(msg.text)) {
    await adapter.sendText(msg.groupId, 'Milestone 2 build: try "@ranti test" to schedule a meeting in 10 minutes with a 5-minute reminder.');
    return;
  }
  const start = DateTime.fromJSDate(clock.now()).setZone(group.timezone).plus({ minutes: 10 }).startOf('minute');
  const res = await app.reminders.create(
    { group, member, isAdmin: msg.isFromAdmin },
    {
      title: 'Test meeting',
      kind: 'event',
      startLocal: start.toFormat("yyyy-MM-dd'T'HH:mm:ss"),
      rrule: null,
      offsetsMinutes: [5, 0],
      subjectMemberId: null,
      messageStyle: null,
    },
  );
  await adapter.sendText(
    msg.groupId,
    res.ok ? `Scheduled #${res.value.reminder.shortId} Test meeting at ${start.toFormat('HH:mm')} with a 5-minute reminder.` : res.error,
  );
});

await app.start();
process.stdout.write(showClock());
await adapter.start();
await app.stop();
