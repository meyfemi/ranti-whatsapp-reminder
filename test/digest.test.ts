import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertGroup } from '../src/db/repositories.js';
import { digestRuns } from '../src/db/schema.js';
import { DigestService } from '../src/digest/service.js';
import type { ParsedCommand } from '../src/parser/schema.js';
import { createTestEnv, makeBot, message, ScriptedParser, silentLogger, truncateAll } from './helpers.js';

const env = createTestEnv();
const parser = new ScriptedParser();
makeBot(env, parser);
afterAll(() => env.handle.close());

beforeEach(async () => {
  await truncateAll(env.handle);
  env.adapter.sent = [];
  env.adapter.failNext = 0;
  env.queue.enqueuedDigests.length = 0;
  parser.queue = [];
  parser.inputs = [];
  env.clock.set(new Date('2026-10-07T09:00:00Z')); // Wed 7 Oct, 10:00 WAT
});

const ADMIN = { senderId: 'ade@s.whatsapp.net', senderDisplayName: 'Ade', isFromAdmin: true };
const BOB = { senderId: 'bob@s.whatsapp.net', senderDisplayName: 'Bob' };
const lastText = () => env.adapter.sent.at(-1)?.text;
const digestPosts = () => env.adapter.sent.filter((m) => m.text.startsWith('📅 This week') || m.text.startsWith('📅 Nothing scheduled'));

async function say(command: ParsedCommand, who: object = ADMIN) {
  parser.queue.push(command);
  await env.adapter.receive(message({ text: 'cmd', ...who }));
  return lastText();
}
const setDigest = (over: Partial<Extract<ParsedCommand, { action: 'set_digest' }>> = {}): ParsedCommand => ({
  action: 'set_digest', enabled: null, weekday: null, time: null, empty_weeks: null, ...over,
});
const create = (title: string, start_local: string, over: Partial<Extract<ParsedCommand, { action: 'create' }>> = {}): ParsedCommand => ({
  action: 'create', title, kind: 'event', start_local, rrule: null, offsets_minutes: [0], subject_user_id: null, message_style: null, ...over,
});
async function runs() {
  return env.handle.db.select().from(digestRuns).orderBy(digestRuns.id);
}
async function pendingRun() {
  const pending = (await runs()).filter((r) => r.status === 'pending');
  expect(pending).toHaveLength(1);
  return pending[0]!;
}

describe('digest settings', () => {
  it('only admins can change the digest; anyone can ask what is coming up', async () => {
    expect(await say(setDigest({ enabled: 'on' }), BOB)).toBe('Only group admins can change the weekly digest.');
    expect(await runs()).toHaveLength(0);
    await say(create('Choir practice', '2026-10-09T18:00:00'), BOB);
    expect(await say({ action: 'show_upcoming' }, BOB)).toBe(
      ['📅 Coming up (7–13 Oct)', '', 'Fri 9 – Choir practice, 18:00'].join('\n'),
    );
  });

  it('turning it on schedules the next Monday 08:00 and echoes the schedule', async () => {
    expect(await say(setDigest({ enabled: 'on' }))).toBe('Weekly digest is on: Mondays at 08:00 (Africa/Lagos). Next one: Mon 12 Oct.');
    const run = await pendingRun();
    expect(run.fireAt.toISOString()).toBe('2026-10-12T07:00:00.000Z'); // jitter 0 in tests
    expect(run.weekKey).toBe('2026-W42');
    expect(env.queue.enqueuedDigests.map((d) => d.runId)).toEqual([run.id]);
  });

  it('changing the day or time reschedules the pending run (and turns it on)', async () => {
    expect(await say(setDigest({ weekday: 'SU', time: '19:00' }))).toBe(
      'Weekly digest is on: Sundays at 19:00 (Africa/Lagos). Next one: Sun 11 Oct.',
    );
    const first = await pendingRun();
    await say(setDigest({ time: '07:30' }));
    const second = await pendingRun();
    expect(second.id).not.toBe(first.id);
    expect(second.fireAt.toISOString()).toBe('2026-10-11T06:30:00.000Z');
  });

  it('turning it off drops the pending run', async () => {
    await say(setDigest({ enabled: 'on' }));
    expect(await say(setDigest({ enabled: 'off' }))).toBe('Weekly digest is off. Turn it back on with "@Ranti turn on the weekly digest".');
    expect(await runs()).toHaveLength(0);
  });

  it('a timezone change moves the pending run to the same local time in the new zone', async () => {
    await say(setDigest({ enabled: 'on' }));
    await say({ action: 'set_timezone', timezone: 'Europe/London' });
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-12T07:00:00.000Z'); // 08:00 BST
    await say(setDigest({ weekday: 'MO' })); // still Mondays
    await say({ action: 'set_timezone', timezone: 'America/New_York' });
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-12T12:00:00.000Z'); // 08:00 EDT
  });

  it('spreads sends over 0-15 minutes after the slot', async () => {
    const jittery = new DigestService(env.handle.db, env.adapter, env.queue, env.clock, silentLogger, { botName: 'Ranti', random: () => 0.5 });
    const { group } = await upsertGroup(env.handle.db, { platform: 'test', platformGroupId: 'group-1', defaultTimezone: 'Africa/Lagos' });
    const actor = { group, member: { id: 0 } as never, isAdmin: true };
    await jittery.configure(actor, { enabled: true, weekday: null, time: null });
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-12T07:07:30.000Z');
  });
});

describe('sending', () => {
  async function setUpWeek() {
    await say(create('Choir practice', '2026-10-15T18:00:00'));
    await say(create("Ada's birthday", '2026-10-14T06:00:00', { kind: 'birthday', rrule: 'FREQ=YEARLY' }));
    await say(setDigest({ enabled: 'on' }));
    env.adapter.sent = [];
    return pendingRun();
  }

  it('duplicate jobs and the sweeper post exactly one digest, then next week is scheduled', async () => {
    const run = await setUpWeek();
    env.clock.set(run.fireAt);
    env.adapter.sendDelayMs = 50;
    const outcomes = await Promise.all([env.digests.send(run.id), env.digests.send(run.id), env.digests.sweepDue()]);
    env.adapter.sendDelayMs = 0;
    expect(digestPosts()).toHaveLength(1);
    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(digestPosts()[0]!.text).toBe(
      ['📅 This week (12–18 Oct)', '', "Wed 14 – 🎂 Ada's birthday", 'Thu 15 – Choir practice, 18:00', '', 'Have a great week!'].join('\n'),
    );
    expect(digestPosts()[0]!.mentionUserIds).toEqual([]);
    expect(await env.digests.send(run.id)).toBe('noop');
    const next = await pendingRun();
    expect(next.fireAt.toISOString()).toBe('2026-10-19T07:00:00.000Z');
    expect((await runs()).find((r) => r.id === run.id)!.status).toBe('sent');
  });

  it('missed run under 6 hours late: sent on startup', async () => {
    const run = await setUpWeek();
    env.clock.set(new Date(run.fireAt.getTime() + 2 * 3_600_000));
    await env.recovery.runStartup();
    expect(digestPosts()).toHaveLength(1);
  });

  it('missed run over 6 hours late: skipped, and the next one scheduled', async () => {
    const run = await setUpWeek();
    env.clock.set(new Date(run.fireAt.getTime() + 7 * 3_600_000));
    await env.recovery.runStartup();
    expect(digestPosts()).toHaveLength(0);
    expect((await runs()).find((r) => r.id === run.id)!.status).toBe('skipped');
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-19T07:00:00.000Z');
  });

  it('startup gives an enabled group a run if it has none', async () => {
    await say(setDigest({ enabled: 'on' }));
    await env.handle.db.delete(digestRuns);
    await env.recovery.runStartup();
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-12T07:00:00.000Z');
  });

  it('an empty week posts nothing by default, or a short note if asked', async () => {
    await say(setDigest({ enabled: 'on' }));
    env.adapter.sent = [];
    let run = await pendingRun();
    env.clock.set(run.fireAt);
    expect(await env.digests.send(run.id)).toBe('empty');
    expect(env.adapter.sent).toHaveLength(0);

    expect(await say(setDigest({ empty_weeks: 'post' }))).toBe(
      "Weekly digest is on: Mondays at 08:00 (Africa/Lagos). Next one: Mon 19 Oct. In a week with nothing on, I'll say so.",
    );
    run = await pendingRun();
    env.clock.set(run.fireAt);
    await env.digests.send(run.id);
    expect(lastText()).toBe('📅 Nothing scheduled this week (19–25 Oct).');
  });

  it('a failed send is retried, then the week is given up and the next one scheduled', async () => {
    const run = await setUpWeek();
    env.clock.set(run.fireAt);
    env.adapter.failNext = 1;
    await expect(env.digests.send(run.id)).rejects.toThrow('simulated send failure');
    expect((await runs()).find((r) => r.id === run.id)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(await env.digests.send(run.id)).toBe('sent');

    await say(create('Picnic', '2026-10-24T12:00:00')); // so next week has something to send
    const next = await pendingRun();
    env.clock.set(next.fireAt);
    env.adapter.failNext = 4;
    for (let i = 0; i < 3; i++) await expect(env.digests.send(next.id)).rejects.toThrow();
    expect(await env.digests.send(next.id)).toBe('failed');
    expect((await pendingRun()).fireAt.toISOString()).toBe('2026-10-26T07:00:00.000Z');
  });

  it('is skipped once the bot has left the group', async () => {
    const run = await setUpWeek();
    const { group } = await upsertGroup(env.handle.db, { platform: 'test', platformGroupId: 'group-1', defaultTimezone: 'Africa/Lagos' });
    await env.handle.pool.query('update groups set active = false where id = $1', [group.id]);
    env.adapter.sent = [];
    env.clock.set(run.fireAt);
    expect(await env.digests.send(run.id)).toBe('skipped');
    expect(env.adapter.sent).toHaveLength(0);
  });
});
