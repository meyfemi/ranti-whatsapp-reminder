import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { getReminderByShortId, upsertGroup } from '../src/db/repositories.js';
import type { ParsedCommand } from '../src/parser/schema.js';
import { createTestEnv, makeBot, message, ScriptedParser, truncateAll } from './helpers.js';

const env = createTestEnv();
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

const meeting: ParsedCommand = {
  action: 'create',
  title: 'General meeting',
  kind: 'event',
  start_local: '2026-10-11T11:00:00',
  rrule: null,
  offsets_minutes: [5, 0],
  subject_user_id: null,
  message_style: null,
};
const lastText = () => env.adapter.sent.at(-1)?.text;

describe('Bot', () => {
  it('ignores messages that do not mention the bot, without calling the parser', async () => {
    await env.adapter.receive(message({ text: 'hello all', mentionsBot: false }));
    expect(parser.inputs).toHaveLength(0);
    expect(env.adapter.sent).toHaveLength(0);
  });

  it('ignores replies to the bot when the sender has nothing pending', async () => {
    await env.adapter.receive(message({ text: 'thanks!', mentionsBot: false, isReplyToBot: true }));
    expect(parser.inputs).toHaveLength(0);
    expect(env.adapter.sent).toHaveLength(0);
  });

  it('creates a reminder and echoes the exact confirmation', async () => {
    parser.queue.push(meeting);
    await env.adapter.receive(message({ text: 'remind everyone about the general meeting at 11am this Sunday...' }));
    expect(lastText()).toBe(
      'Got it: General meeting (#1), Sun 11 Oct, 11:00 (WAT). Reminders at 10:55 and 11:00. Reply "undo" within 5 minutes to cancel.',
    );
    expect(parser.inputs[0]!.timezone).toBe('Africa/Lagos');
    expect(parser.inputs[0]!.now.toISOString()).toBe('2026-10-07T09:00:00.000Z');
  });

  it('undo (as a reply, no mention) within 5 minutes cancels the reminder', async () => {
    parser.queue.push(meeting);
    await env.adapter.receive(message({ text: 'meeting...' }));
    env.clock.advance(4 * 60_000);
    await env.adapter.receive(message({ text: 'Undo', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toBe('Undone: removed #1 General meeting.');
    expect(parser.inputs).toHaveLength(1); // undo never goes to the LLM
    const { group } = await upsertGroup(env.handle.db, { platform: 'test', platformGroupId: 'group-1', defaultTimezone: 'x' });
    expect((await getReminderByShortId(env.handle.db, group.id, 1))!.active).toBe(false);
  });

  it('undo after the window has expired does nothing', async () => {
    parser.queue.push(meeting);
    await env.adapter.receive(message({ text: 'meeting...' }));
    env.clock.advance(6 * 60_000);
    await env.adapter.receive(message({ text: 'undo' }));
    expect(lastText()).toMatch(/nothing to undo/);
  });

  it("another member cannot undo someone else's reminder", async () => {
    parser.queue.push(meeting);
    await env.adapter.receive(message({ text: 'meeting...' }));
    await env.adapter.receive(message({ text: 'undo', senderId: 'bob@s.whatsapp.net', senderDisplayName: 'Bob' }));
    expect(lastText()).toMatch(/nothing to undo/);
  });

  it('asks a clarifying question, then uses the answer (a plain reply) with the original message', async () => {
    parser.queue.push({ action: 'clarify', question: 'What time is the meeting on Sunday?' });
    await env.adapter.receive(message({ text: 'remind us about the meeting this Sunday' }));
    expect(lastText()).toBe('What time is the meeting on Sunday?');

    parser.queue.push({ ...meeting, title: 'Meeting', start_local: '2026-10-11T16:00:00', offsets_minutes: [0] });
    await env.adapter.receive(message({ text: '4pm', mentionsBot: false, isReplyToBot: true }));
    expect(parser.inputs[1]!.pending).toEqual({
      question: 'What time is the meeting on Sunday?',
      originalText: 'remind us about the meeting this Sunday',
    });
    expect(lastText()).toMatch(/^Got it: Meeting \(#1\), Sun 11 Oct, 16:00 \(WAT\)/);

    // The clarify interaction is consumed: a further plain reply is ignored.
    await env.adapter.receive(message({ text: 'ok', mentionsBot: false, isReplyToBot: true }));
    expect(parser.inputs).toHaveLength(2);
  });

  it('links a birthday to the mentioned member (by alternate LID too) and names them', async () => {
    parser.queue.push({
      action: 'create',
      title: "John's birthday",
      kind: 'birthday',
      start_local: '2026-10-12T09:00:00',
      rrule: 'FREQ=YEARLY',
      offsets_minutes: [0],
      subject_user_id: '1122334455@lid',
      message_style: 'always wish him happy birthday',
    });
    await env.adapter.receive(
      message({
        text: "12 Oct is @2348011111111's birthday",
        mentionedUsers: [{ userId: '2348011111111@s.whatsapp.net', altUserIds: ['1122334455@lid'], displayName: 'John' }],
      }),
    );
    expect(lastText()).toBe(
      'Got it: John\'s birthday (#1), every year on 12 Oct at 09:00 (WAT). Next: Mon 12 Oct. I\'ll wish John a happy birthday here. Reply "undo" within 5 minutes to cancel.',
    );
    expect(parser.inputs[0]!.mentionedUsers[0]).toMatchObject({ id: '2348011111111@s.whatsapp.net', token: '@2348011111111' });
    // The echo itself never mentions anyone.
    expect(env.adapter.sent.at(-1)!.mentionUserIds).toEqual([]);
  });

  it('refuses a subject that was not mentioned', async () => {
    parser.queue.push({ ...meeting, subject_user_id: 'someone@s.whatsapp.net' });
    await env.adapter.receive(message({ text: 'x' }));
    expect(lastText()).toBe('Who is this reminder for? Please @mention them.');
  });

  it('replies politely to unsupported requests and sanitises the text', async () => {
    parser.queue.push({ action: 'unsupported', reason: 'I can only help with reminders, @everyone.' });
    await env.adapter.receive(message({ text: 'tell a joke' }));
    expect(lastText()).toBe('I can only help with reminders, everyone.');
  });

  it('reports parser outages', async () => {
    parser.queue.push('unavailable');
    await env.adapter.receive(message({ text: 'remind us...' }));
    expect(lastText()).toMatch(/can't process requests right now/);
  });

  it('a bare mention gets the help text', async () => {
    await env.adapter.receive(message({ text: '' }));
    expect(lastText()).toMatch(/^I post reminders in this group/);
    expect(parser.inputs).toHaveLength(0);
  });

  it("a bare mention under someone's post parses that post as the request", async () => {
    const post = { text: 'Reminde us to meet by 7:30pm on friday', senderId: 'john@s.whatsapp.net', senderAltIds: ['john@lid'], senderDisplayName: 'John' };
    parser.queue.push({ ...meeting, title: 'Meeting', start_local: '2026-10-09T19:30:00', offsets_minutes: [0] });
    await env.adapter.receive(message({ text: '', quoted: post }));
    expect(parser.inputs[0]!.text).toBe('');
    expect(parser.inputs[0]!.quoted).toEqual({ text: post.text, author: { id: 'john@s.whatsapp.net', name: 'John' } });
    expect(lastText()).toMatch(/^Got it: Meeting \(#1\), Fri 9 Oct, 19:30 \(WAT\)/);
    // The person who tagged the bot owns the undo window.
    await env.adapter.receive(message({ text: 'undo', mentionsBot: false, isReplyToBot: true }));
    expect(lastText()).toBe('Undone: removed #1 Meeting.');
  });

  it("links \"my birthday\" in a quoted post to the post's author, and keeps the post when clarifying", async () => {
    const post = { text: 'my birthday is on the 12th', senderId: 'john@s.whatsapp.net', senderAltIds: ['john@lid'], senderDisplayName: 'John' };
    parser.queue.push({ action: 'clarify', question: 'Which month is the birthday in?' });
    await env.adapter.receive(message({ text: 'save this', quoted: post }));
    parser.queue.push({
      action: 'create',
      title: "John's birthday",
      kind: 'birthday',
      start_local: '2026-10-12T06:00:00',
      rrule: 'FREQ=YEARLY',
      offsets_minutes: [0],
      subject_user_id: 'john@lid',
      message_style: null,
    });
    await env.adapter.receive(message({ text: 'October', mentionsBot: false, isReplyToBot: true }));
    expect(parser.inputs[1]!.pending!.originalText).toBe('save this');
    expect(parser.inputs[1]!.quoted).toEqual(parser.inputs[0]!.quoted);
    expect(lastText()).toMatch(/^Got it: John's birthday \(#1\)/);
    const { rows } = await env.handle.pool.query(
      'select m.platform_user_id from reminders r join members m on m.id = r.subject_member_id',
    );
    expect(rows[0].platform_user_id).toBe('john@s.whatsapp.net');
  });

  it('posts a concise intro when added to a group', async () => {
    await env.adapter.botAdded('group-new');
    const intro = env.adapter.sent.at(-1)!;
    expect(intro.groupId).toBe('group-new');
    expect(intro.text).toContain('Africa/Lagos (WAT)');
    expect(intro.text).toContain('cancel #2');
    expect(intro.text.split(/\s+/).length).toBeLessThanOrEqual(100);
    expect(intro.mentionUserIds).toEqual([]);
  });

  it('deactivates a group when the bot is removed, so its reminders are skipped not failed', async () => {
    parser.queue.push(meeting);
    await env.adapter.receive(message({ text: 'meeting...' }));
    const bot = makeBot(env, parser);
    await bot.handleRemovedFromGroup('group-1');
    const due = await env.handle.pool.query('select id, fire_at from occurrences order by fire_at limit 1');
    env.clock.set(due.rows[0].fire_at);
    expect(await env.dispatcher.dispatch(due.rows[0].id)).toBe('skipped');
    // Re-adding the bot reactivates the group and posts the intro again.
    await bot.handleAddedToGroup('group-1');
    const { rows } = await env.handle.pool.query("select active from groups where platform_group_id = 'group-1'");
    expect(rows[0].active).toBe(true);
  });
});
