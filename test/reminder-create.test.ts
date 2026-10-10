import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { updateGroup } from '../src/db/repositories.js';
import type { CreateReminderInput } from '../src/reminders/types.js';
import { createTestEnv, makeActor, truncateAll } from './helpers.js';

const env = createTestEnv({ maxActive: 3 });
afterAll(() => env.handle.close());
beforeEach(async () => {
  await truncateAll(env.handle);
  env.clock.set(new Date('2026-10-10T12:00:00Z'));
});

const meeting = (over: Partial<CreateReminderInput> = {}): CreateReminderInput => ({
  title: 'General meeting',
  kind: 'event',
  startLocal: '2026-10-11T11:00:00',
  rrule: null,
  offsetsMinutes: [5, 0],
  subjectMemberId: null,
  messageStyle: null,
  ...over,
});

describe('ReminderService.create', () => {
  it('assigns per-group incrementing short IDs', async () => {
    const a = await makeActor(env);
    const b = await makeActor(env, { groupId: 'group-2' });
    const ids = [];
    for (const actor of [a, a, b]) {
      const r = await env.service.create(actor, meeting());
      if (!r.ok) throw new Error(r.error);
      ids.push(r.value.reminder.shortId);
    }
    expect(ids).toEqual([1, 2, 1]);
  });

  it('stores the group timezone on the reminder', async () => {
    const actor = await makeActor(env, { timezone: 'Europe/London' });
    const r = await env.service.create(actor, meeting());
    expect(r.ok && r.value.reminder.timezone).toBe('Europe/London');
    expect(r.ok && r.value.occurrences.map((o) => o.fireAt.toISOString()).sort()).toEqual([
      '2026-10-11T09:55:00.000Z',
      '2026-10-11T10:00:00.000Z',
    ]);
  });

  it('rejects times in the past', async () => {
    const actor = await makeActor(env);
    const r = await env.service.create(actor, meeting({ startLocal: '2026-10-09T11:00:00' }));
    expect(r).toEqual({ ok: false, error: 'That time has already passed.' });
  });

  it('rejects when every offset has already passed', async () => {
    const actor = await makeActor(env);
    env.clock.set(new Date('2026-10-11T09:57:00Z')); // 10:57 local
    const r = await env.service.create(actor, meeting({ offsetsMinutes: [5] }));
    expect(r).toEqual({ ok: false, error: 'All of those reminder times have already passed.' });
    // ...and nothing was persisted (short ID not consumed).
    const again = await env.service.create(actor, meeting({ offsetsMinutes: [0] }));
    expect(again.ok && again.value.reminder.shortId).toBe(1);
  });

  it('enforces the per-group cap', async () => {
    const actor = await makeActor(env);
    for (let i = 0; i < 3; i++) expect((await env.service.create(actor, meeting())).ok).toBe(true);
    const r = await env.service.create(actor, meeting());
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/limit is 3/);
  });

  it('respects the admins-only creation policy', async () => {
    const member = await makeActor(env);
    await updateGroup(env.handle.db, member.group.id, { creationPolicy: 'admins' });
    const group = { ...member.group, creationPolicy: 'admins' as const };
    expect((await env.service.create({ ...member, group }, meeting())).ok).toBe(false);
    expect((await env.service.create({ ...member, group, isAdmin: true }, meeting())).ok).toBe(true);
  });

  it('sanitises the title and rejects invalid recurrence', async () => {
    const actor = await makeActor(env);
    const r = await env.service.create(actor, meeting({ title: '  @everyone   party​ ' }));
    expect(r.ok && r.value.reminder.title).toBe('everyone party');
    const bad = await env.service.create(actor, meeting({ rrule: 'FREQ=HOURLY' }));
    expect(bad.ok).toBe(false);
  });
});
