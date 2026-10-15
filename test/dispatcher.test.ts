import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { upsertMember } from '../src/db/repositories.js';
import { occurrences } from '../src/db/schema.js';
import { createTestEnv, makeActor, truncateAll } from './helpers.js';

const env = createTestEnv();
afterAll(() => env.handle.close());
beforeEach(async () => {
  await truncateAll(env.handle);
  env.adapter.sent = [];
  env.adapter.failNext = 0;
  env.adapter.sendDelayMs = 0;
  env.clock.set(new Date('2026-10-10T12:00:00Z'));
});

const occurrencesOf = (reminderId: number) =>
  env.handle.db.select().from(occurrences).where(eq(occurrences.reminderId, reminderId)).orderBy(occurrences.fireAt);

async function createMeeting() {
  const actor = await makeActor(env);
  const res = await env.service.create(actor, {
    title: 'General meeting',
    kind: 'event',
    startLocal: '2026-10-11T11:00:00',
    rrule: null,
    offsetsMinutes: [5, 0],
    subjectMemberId: null,
    messageStyle: null,
  });
  if (!res.ok) throw new Error(res.error);
  return res.value;
}

describe('Dispatcher', () => {
  it('stores and enqueues the next occurrence per offset on create', async () => {
    const { reminder, occurrences: occ } = await createMeeting();
    expect(occ.map((o) => o.fireAt.toISOString()).sort()).toEqual([
      '2026-10-11T09:55:00.000Z',
      '2026-10-11T10:00:00.000Z',
    ]);
    expect(env.queue.enqueued.map((e) => e.occurrenceId).sort()).toEqual(occ.map((o) => o.id).sort());
    expect((await occurrencesOf(reminder.id)).every((o) => o.status === 'pending')).toBe(true);
  });

  it('sends a one-off event at each offset and does not schedule more', async () => {
    const { reminder, occurrences: occ } = await createMeeting();
    const fiveMin = occ.find((o) => o.offsetMinutes === 5)!;
    const atTime = occ.find((o) => o.offsetMinutes === 0)!;

    env.clock.set(fiveMin.fireAt);
    expect(await env.dispatcher.dispatch(fiveMin.id)).toBe('sent');
    env.clock.set(atTime.fireAt);
    expect(await env.dispatcher.dispatch(atTime.id)).toBe('sent');

    expect(env.adapter.sent.map((s) => s.text)).toEqual([
      '⏰ Reminder: General meeting starts in 5 minutes (11:00).',
      '⏰ Reminder: General meeting is starting now (11:00).',
    ]);
    const rows = await occurrencesOf(reminder.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'sent' && r.attempts === 1)).toBe(true);
  });

  it('is idempotent: duplicate and concurrent dispatches post once', async () => {
    const { occurrences: occ } = await createMeeting();
    const o = occ[0]!;
    env.clock.set(o.fireAt);
    env.adapter.sendDelayMs = 200; // hold the row lock while the duplicates arrive
    const results = await Promise.all([
      env.dispatcher.dispatch(o.id),
      env.dispatcher.dispatch(o.id),
      env.dispatcher.dispatch(o.id),
    ]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(results.filter((r) => r === 'noop')).toHaveLength(2);
    expect(await env.dispatcher.dispatch(o.id)).toBe('noop');
    expect(env.adapter.sent).toHaveLength(1);
  });

  it('does not send early and re-enqueues instead', async () => {
    const { occurrences: occ } = await createMeeting();
    env.queue.enqueued.length = 0;
    expect(await env.dispatcher.dispatch(occ[0]!.id)).toBe('early');
    expect(env.adapter.sent).toHaveLength(0);
    expect(env.queue.enqueued).toHaveLength(1);
  });

  it('rolls back on send failure, retries, and marks failed after max attempts', async () => {
    const { occurrences: occ } = await createMeeting();
    const o = occ.find((x) => x.offsetMinutes === 0)!;
    env.clock.set(o.fireAt);
    env.adapter.failNext = 10;
    for (let i = 0; i < 3; i++) {
      await expect(env.dispatcher.dispatch(o.id)).rejects.toThrow('simulated send failure');
    }
    let [row] = await env.handle.db.select().from(occurrences).where(eq(occurrences.id, o.id));
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(3);
    expect(await env.dispatcher.dispatch(o.id)).toBe('failed');
    [row] = await env.handle.db.select().from(occurrences).where(eq(occurrences.id, o.id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toBe('simulated send failure');
  });

  it('succeeds on retry after a transient failure', async () => {
    const { occurrences: occ } = await createMeeting();
    const o = occ[0]!;
    env.clock.set(o.fireAt);
    env.adapter.failNext = 1;
    await expect(env.dispatcher.dispatch(o.id)).rejects.toThrow();
    expect(await env.dispatcher.dispatch(o.id)).toBe('sent');
    expect(env.adapter.sent).toHaveLength(1);
  });

  it('a recurring birthday mentions the subject and schedules next year', async () => {
    const actor = await makeActor(env);
    const john = await upsertMember(env.handle.db, actor.group.id, { userId: '2348011111111@s.whatsapp.net', displayName: 'John' });
    const res = await env.service.create(actor, {
      title: "John's birthday",
      kind: 'birthday',
      startLocal: '2026-10-12T09:00:00',
      rrule: 'FREQ=YEARLY',
      offsetsMinutes: [0],
      subjectMemberId: john.id,
      messageStyle: 'always wish him happy birthday',
    });
    if (!res.ok) throw new Error(res.error);
    const o = res.value.occurrences[0]!;
    env.clock.set(o.fireAt);
    expect(await env.dispatcher.dispatch(o.id)).toBe('sent');
    expect(env.adapter.sent[0]!.text).toContain('@2348011111111');
    expect(env.adapter.sent[0]!.text.toLowerCase()).toContain('birthday');
    expect(env.adapter.sent[0]!.mentionUserIds).toEqual(['2348011111111@s.whatsapp.net']);

    const rows = await occurrencesOf(res.value.reminder.id);
    expect(rows.map((r) => [r.status, r.fireAt.toISOString()])).toEqual([
      ['sent', '2026-10-12T08:00:00.000Z'],
      ['pending', '2027-10-12T08:00:00.000Z'],
    ]);
    // The next occurrence was enqueued too.
    expect(env.queue.enqueued.some((e) => e.occurrenceId === rows[1]!.id)).toBe(true);
  });

  it('skips occurrences of a cancelled reminder', async () => {
    const { reminder, occurrences: occ } = await createMeeting();
    await env.handle.pool.query('update reminders set active = false where id = $1', [reminder.id]);
    env.clock.set(occ[0]!.fireAt);
    expect(await env.dispatcher.dispatch(occ[0]!.id)).toBe('skipped');
    expect(env.adapter.sent).toHaveLength(0);
  });
});

describe('Recovery', () => {
  it('sends occurrences missed by under 6 hours with a "(slightly late)" note', async () => {
    const { occurrences: occ } = await createMeeting();
    env.clock.set(new Date(occ[1]!.fireAt.getTime() + 60 * 60_000)); // an hour after the last one
    const result = await env.recovery.runStartup();
    expect(result.due).toBe(2);
    expect(env.adapter.sent).toHaveLength(2);
    expect(env.adapter.sent.every((s) => s.text.endsWith('(slightly late)'))).toBe(true);
  });

  it('skips occurrences missed by over 6 hours and schedules the next from now', async () => {
    const actor = await makeActor(env);
    const res = await env.service.create(actor, {
      title: 'Pay dues',
      kind: 'generic',
      startLocal: '2026-11-07T09:00:00',
      rrule: 'FREQ=MONTHLY;BYDAY=1SA',
      offsetsMinutes: [0],
      subjectMemberId: null,
      messageStyle: null,
    });
    if (!res.ok) throw new Error(res.error);
    // Down from before 7 Nov until 2 Jan 06:00 local: 7 Nov is >6h late; 5 Dec is never stored.
    env.clock.set(new Date('2027-01-02T05:00:00Z'));
    await env.recovery.runStartup();
    expect(env.adapter.sent).toHaveLength(0);
    const rows = await occurrencesOf(res.value.reminder.id);
    expect(rows.map((r) => [r.status, r.fireAt.toISOString()])).toEqual([
      ['skipped', '2026-11-07T08:00:00.000Z'],
      ['pending', '2027-01-02T08:00:00.000Z'],
    ]);
  });

  it('startup re-enqueues future pending occurrences', async () => {
    await createMeeting();
    env.queue.enqueued.length = 0;
    env.queue.enqueuedDigests.length = 0;
    const { requeued } = await env.recovery.runStartup();
    expect(requeued).toBe(3); // two occurrences, plus the group's weekly digest (on by default)
    expect(env.queue.enqueued).toHaveLength(2);
    expect(env.queue.enqueuedDigests).toHaveLength(1);
  });

  it('delivers on time without a late note via the sweeper', async () => {
    const { occurrences: occ } = await createMeeting();
    env.clock.set(new Date(occ[0]!.fireAt.getTime() + 30_000));
    await env.recovery.sweepDue();
    expect(env.adapter.sent.map((s) => s.text)).toEqual(['⏰ Reminder: General meeting starts in 5 minutes (11:00).']);
  });
});

describe('occurrence revival', () => {
  it('revives a skipped occurrence but never a sent one', async () => {
    const { reminder, occurrences: occ } = await createMeeting();
    const o = occ.find((x) => x.offsetMinutes === 0)!;
    await env.scheduler.cancel(env.handle.db, reminder.id);
    const revived = await env.scheduler.scheduleInitial(env.handle.db, reminder);
    expect(revived.map((r) => r.id).sort()).toEqual(occ.map((r) => r.id).sort());

    env.clock.set(o.fireAt);
    expect(await env.dispatcher.dispatch(o.id)).toBe('sent');
    env.clock.set(new Date(o.fireAt.getTime() - 60 * 60_000)); // pretend we're before it again
    const again = await env.scheduler.scheduleInitial(env.handle.db, reminder);
    expect(again.find((r) => r.id === o.id)).toBeUndefined();
    expect(env.adapter.sent).toHaveLength(1);
  });
});
