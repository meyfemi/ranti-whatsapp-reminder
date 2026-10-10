import { and, eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { occurrences, reminders } from '../src/db/schema.js';
import type { ParsedCommand } from '../src/parser/schema.js';
import { createTestEnv, makeBot, message, ScriptedParser, truncateAll } from './helpers.js';

const env = createTestEnv({ maxActive: 4 });
const parser = new ScriptedParser();
makeBot(env, parser);
afterAll(() => env.handle.close());

beforeEach(async () => {
  await truncateAll(env.handle);
  env.adapter.sent = [];
  parser.queue = [];
  parser.inputs = [];
  env.clock.set(new Date('2026-10-07T09:00:00Z')); // Wed 7 Oct, 10:00 WAT
});

const lastText = () => env.adapter.sent.at(-1)?.text;
const ALICE = {};
const BOB = { senderId: 'bob@s.whatsapp.net', senderDisplayName: 'Bob' };
const ADMIN = { senderId: 'ade@s.whatsapp.net', senderDisplayName: 'Ade', isFromAdmin: true };

async function say(command: ParsedCommand, who: object = ALICE, text = 'cmd') {
  parser.queue.push(command);
  await env.adapter.receive(message({ text, ...who }));
  return lastText();
}

const create = (title: string, over: Partial<Extract<ParsedCommand, { action: 'create' }>> = {}): ParsedCommand => ({
  action: 'create',
  title,
  kind: 'event',
  start_local: '2026-10-11T11:00:00',
  rrule: null,
  offsets_minutes: [0],
  subject_user_id: null,
  message_style: null,
  ...over,
});
const cancel = (short_id: number | null, description: string | null = null): ParsedCommand => ({
  action: 'cancel',
  target: { short_id, description },
});
const edit = (short_id: number, changes: Partial<Extract<ParsedCommand, { action: 'edit' }>['changes']>): ParsedCommand => ({
  action: 'edit',
  target: { short_id, description: null },
  changes: { title: null, start_local: null, rrule: null, make_one_off: false, offsets_minutes: null, message_style: null, ...changes },
});

async function pendingFireTimes(shortId: number) {
  const rows = await env.handle.db
    .select({ fireAt: occurrences.fireAt })
    .from(occurrences)
    .innerJoin(reminders, eq(reminders.id, occurrences.reminderId))
    .where(and(eq(reminders.shortId, shortId), eq(occurrences.status, 'pending')))
    .orderBy(occurrences.fireAt);
  return rows.map((r) => r.fireAt.toISOString());
}

describe('list', () => {
  it('shows an empty state', async () => {
    expect(await say({ action: 'list' })).toMatch(/^No active reminders yet/);
  });

  it('lists active reminders with short IDs and next dates for recurring ones', async () => {
    await say(create('General meeting'));
    await say(create('Pay dues', { kind: 'generic', start_local: '2026-11-07T09:00:00', rrule: 'FREQ=MONTHLY;BYDAY=1SA' }));
    await say(create('Old thing'));
    await say(cancel(3));
    expect(await say({ action: 'list' })).toBe(
      [
        '📋 Reminders (2):',
        '#1 General meeting: Sun 11 Oct, 11:00 (WAT)',
        '#2 Pay dues: every first Saturday of the month at 09:00 (WAT) · next Sat 7 Nov',
        'Cancel with "@Ranti cancel #<number>".',
      ].join('\n'),
    );
  });
});

describe('cancel', () => {
  it('lets the creator cancel and undo the cancel', async () => {
    await say(create('General meeting', { offsets_minutes: [5, 0] }));
    expect(await say(cancel(1))).toBe('Cancelled #1 General meeting. Reply "undo" within 5 minutes to restore it.');
    expect(await pendingFireTimes(1)).toEqual([]);
    await env.adapter.receive(message({ text: 'undo', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toBe('Undone: #1 General meeting is back on.');
    expect(await pendingFireTimes(1)).toEqual(['2026-10-11T09:55:00.000Z', '2026-10-11T10:00:00.000Z']);
  });

  it("stops other members from cancelling someone else's reminder, but allows admins", async () => {
    await say(create('General meeting'));
    expect(await say(cancel(1), BOB)).toBe('Only the person who set this reminder or a group admin can change it.');
    expect(await say(cancel(1), ADMIN)).toMatch(/^Cancelled #1/);
  });

  it('asks which one when a description is ambiguous, then accepts a plain numeric reply', async () => {
    await say(create("John's birthday", { kind: 'birthday', rrule: 'FREQ=YEARLY', start_local: '2026-10-12T09:00:00' }));
    await say(create("Mary's birthday", { kind: 'birthday', rrule: 'FREQ=YEARLY', start_local: '2027-03-03T09:00:00' }));
    expect(await say(cancel(null, 'the birthday reminder'))).toBe(
      "Which one do you mean: #1 John's birthday, #2 Mary's birthday? Reply with the number.",
    );
    await env.adapter.receive(message({ text: '#9', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toMatch(/isn't one of the options/);
    await env.adapter.receive(message({ text: '2', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toMatch(/^Cancelled #2 Mary's birthday/);
    expect(parser.inputs).toHaveLength(3); // the numeric replies never hit the LLM
  });

  it('reports unknown reminders', async () => {
    expect(await say(cancel(7))).toBe("I couldn't find an active reminder #7.");
  });
});

describe('edit', () => {
  it('moves a meeting, reschedules it, and undo restores the original', async () => {
    await say(create('General meeting', { offsets_minutes: [5, 0] }));
    expect(await say(edit(1, { start_local: '2026-10-11T12:00:00' }))).toBe(
      'Updated: General meeting (#1), Sun 11 Oct, 12:00 (WAT). Reminders at 11:55 and 12:00. Reply "undo" within 5 minutes to revert.',
    );
    expect(await pendingFireTimes(1)).toEqual(['2026-10-11T10:55:00.000Z', '2026-10-11T11:00:00.000Z']);
    await env.adapter.receive(message({ text: 'undo', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toBe('Undone: #1 is back to Sun 11 Oct, 11:00 (WAT).');
    expect(await pendingFireTimes(1)).toEqual(['2026-10-11T09:55:00.000Z', '2026-10-11T10:00:00.000Z']);
  });

  it('changes offsets and can make a recurring reminder one-off', async () => {
    await say(create('Choir practice', { rrule: 'FREQ=WEEKLY' }));
    expect(await say(edit(1, { offsets_minutes: [30, 0] }))).toMatch(/Reminders 30 minutes before and at the time\./);
    expect(await say(edit(1, { make_one_off: true }))).toMatch(/^Updated: Choir practice \(#1\), Sun 11 Oct, 11:00 \(WAT\)/);
  });

  it('rejects moving a reminder into the past and leaves it unchanged', async () => {
    await say(create('General meeting'));
    expect(await say(edit(1, { start_local: '2026-10-01T12:00:00' }))).toBe('That time has already passed.');
    expect(await pendingFireTimes(1)).toEqual(['2026-10-11T10:00:00.000Z']);
  });

  it('enforces permissions', async () => {
    await say(create('General meeting'));
    expect(await say(edit(1, { title: 'Hijacked' }), BOB)).toMatch(/^Only the person who set this reminder/);
  });
});

describe('settings', () => {
  it('changing the timezone keeps local times and reschedules', async () => {
    await say(create('General meeting'));
    expect(await say({ action: 'set_timezone', timezone: 'Europe/London' })).toBe(
      'Timezone set to Europe/London (BST). Existing reminders keep their local times.',
    );
    // 11:00 BST = 10:00Z (was 11:00 WAT = 10:00Z by coincidence), so use a December reminder to see the change:
    await say(create('Carol service', { start_local: '2026-12-20T18:00:00' }));
    expect(await pendingFireTimes(2)).toEqual(['2026-12-20T18:00:00.000Z']);
    await say({ action: 'set_timezone', timezone: 'Africa/Lagos' });
    expect(await pendingFireTimes(2)).toEqual(['2026-12-20T17:00:00.000Z']);
    expect(await say({ action: 'list' })).toContain('#2 Carol service: Sun 20 Dec, 18:00 (WAT)');
  });

  it('only admins can change the creation policy, which then blocks non-admins', async () => {
    expect(await say({ action: 'set_policy', policy: 'admins' }, BOB)).toBe('Only group admins can change who can set reminders.');
    expect(await say({ action: 'set_policy', policy: 'admins' }, ADMIN)).toBe('OK: only group admins can set reminders now.');
    expect(await say(create('Party'), BOB)).toBe('Only group admins can set reminders in this group.');
    expect(await say({ action: 'set_timezone', timezone: 'Europe/London' }, BOB)).toMatch(/^Only group admins/);
    expect(await say(create('Party'), ADMIN)).toMatch(/^Got it: Party/);
  });

  it('caps active reminders per group', async () => {
    for (let i = 1; i <= 4; i++) await say(create(`Event ${i}`));
    expect(await say(create('One too many'))).toMatch(/limit is 4/);
    // The rejected create did not consume a short ID.
    await say(cancel(1));
    expect(await say(create('Fits now'))).toMatch(/^Got it: Fits now \(#5\)/);
  });
});
