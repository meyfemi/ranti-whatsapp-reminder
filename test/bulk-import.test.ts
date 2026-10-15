import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MentionedUser } from '../src/adapters/types.js';
import { upsertGroup, upsertMember } from '../src/db/repositories.js';
import { pendingInteractions, reminders } from '../src/db/schema.js';
import type { ParsedCommand } from '../src/parser/schema.js';
import type { ImportEntry } from '../src/reminders/bulk.js';
import { fastForward } from '../src/scheduler/fast-forward.js';
import { createTestEnv, makeBot, message, ScriptedParser, truncateAll, type TestEnv } from './helpers.js';

const env = createTestEnv();
const parser = new ScriptedParser();
makeBot(env, parser);
// A second bot with a small reminder cap and import limit.
const small = createTestEnv({ maxActive: 3 });
const smallParser = new ScriptedParser();
makeBot(small, smallParser, { maxBulkEntries: 3 });
afterAll(async () => {
  await env.handle.close();
  await small.handle.close();
});

beforeEach(async () => {
  await truncateAll(env.handle);
  for (const e of [env, small]) {
    e.adapter.sent = [];
    e.clock.set(new Date('2026-10-07T09:00:00Z')); // Wed 7 Oct, 10:00 WAT
  }
  for (const p of [parser, smallParser]) {
    p.queue = [];
    p.inputs = [];
  }
});

const ADA: MentionedUser = { userId: '55443322110099@lid', altUserIds: ['2348044444444@s.whatsapp.net'], displayName: 'Ada' };
const BOB = { senderId: 'bob@s.whatsapp.net', senderDisplayName: 'Bob' };
const ADMIN = { senderId: 'ade@s.whatsapp.net', senderDisplayName: 'Ade', isFromAdmin: true };

type Entry = Extract<ParsedCommand, { action: 'bulk_add_birthdays' }>['entries'][number];
const line = (raw_line: string, name_text: string | null, month: number, day: number, extra: Partial<Entry> = {}): Entry => ({
  raw_line, name_text, mention_user_id: null, month, day, year: null, ...extra,
});
const bulk = (entries: Entry[], unparsed: string[] = []): ParsedCommand => ({ action: 'bulk_add_birthdays', entries, unparsed });

const EXAMPLE = bulk(
  [
    line('John - 12 Oct', 'John', 10, 12),
    line('@55443322110099 3 March', null, 3, 3, { mention_user_id: ADA.userId }),
    line('Tunde 21/07', 'Tunde', 7, 21),
    line('Mama Bisi – 5th of June', 'Mama Bisi', 6, 5),
    line('Chidi: 29 Feb', 'Chidi', 2, 29),
    line('Grace 12-10-1990', 'Grace', 10, 12, { year: 1990 }),
  ],
  ['Uncle T sometime in May'],
);

const texts = (e: TestEnv = env) => e.adapter.sent.map((s) => s.text);
const lastText = (e: TestEnv = env) => e.adapter.sent.at(-1)?.text;

async function groupId(e: TestEnv = env) {
  return (await upsertGroup(e.handle.db, { platform: 'test', platformGroupId: 'group-1', defaultTimezone: 'Africa/Lagos' })).group.id;
}
async function knownMember(userId: string, name: string, e: TestEnv = env) {
  return upsertMember(e.handle.db, await groupId(e), { userId, displayName: name });
}
async function paste(command: ParsedCommand, over: Partial<Parameters<typeof message>[0]> = {}, e = env, p = parser) {
  p.queue.push(command);
  await e.adapter.receive(message({ text: 'add these birthdays:\n...', mentionedUsers: [ADA], ...over }));
}
/** A reply to the bot's preview (no mention), as on WhatsApp. */
async function replyWith(text: string, over: Partial<Parameters<typeof message>[0]> = {}, e = env) {
  await e.adapter.receive(message({ text, mentionsBot: false, isReplyToBot: true, ...over }));
}
async function savedBirthdays(e: TestEnv = env) {
  return e.handle.db.select().from(reminders).where(eq(reminders.kind, 'birthday')).orderBy(reminders.shortId);
}

describe('bulk birthday import', () => {
  it('previews first (no mentions), then saves on "yes" and wishes each person on the day', async () => {
    const john = await knownMember('john@s.whatsapp.net', 'John');
    await paste(EXAMPLE);
    expect(env.adapter.sent).toHaveLength(1);
    expect(env.adapter.sent[0]!.mentionUserIds).toEqual([]);
    expect(lastText()).toBe(
      [
        'I found 6 birthdays:',
        '1. John (matched to member John) – 12 Oct',
        '2. Ada (tagged) – 3 Mar',
        '3. Tunde – 21 Jul',
        '4. Mama Bisi – 5 Jun',
        '5. Chidi – 29 Feb (wished on 28 Feb in non-leap years)',
        '6. Grace – 12 Oct 1990',
        '',
        '⚠️ Couldn\'t read: "Uncle T sometime in May"',
        '',
        'Reply "yes" to save 6, or "no" to cancel. You can also reply "remove 3" or "fix 2: 4 March". (Reply to this message.)',
      ].join('\n'),
    );
    expect(await savedBirthdays()).toHaveLength(0); // nothing saved yet

    await replyWith('yes');
    expect(lastText()).toBe("Saved 6 birthdays. I'll wish each person at 06:00 on their day.");
    expect(parser.inputs).toHaveLength(1); // the reply never went to the LLM

    const saved = await savedBirthdays();
    expect(saved.map((r) => [r.title, r.subjectMemberId !== null, r.subjectName, r.birthYear, r.rrule, r.startLocal])).toEqual([
      ["John's birthday", true, 'John', null, 'FREQ=YEARLY', '2026-10-12 06:00:00'],
      ["Ada's birthday", true, 'Ada', null, 'FREQ=YEARLY', '2027-03-03 06:00:00'],
      ["Tunde's birthday", false, 'Tunde', null, 'FREQ=YEARLY', '2027-07-21 06:00:00'],
      ["Mama Bisi's birthday", false, 'Mama Bisi', null, 'FREQ=YEARLY', '2027-06-05 06:00:00'],
      ["Chidi's birthday", false, 'Chidi', null, 'FREQ=YEARLY', '2024-02-29 06:00:00'],
      ["Grace's birthday", false, 'Grace', 1990, 'FREQ=YEARLY', '2026-10-12 06:00:00'],
    ]);
    expect(saved[0]!.subjectMemberId).toBe(john.id);

    // Mon 12 Oct 06:00 WAT: John is tagged, Grace (name only) is wished by name, no age.
    env.adapter.sent = [];
    await fastForward(env.handle.db, env.clock, env.dispatcher, new Date('2026-10-12T05:00:00Z'));
    expect(env.adapter.sent).toEqual([
      { groupId: 'group-1', text: expect.stringContaining('Happy birthday @john!'), mentionUserIds: ['john@s.whatsapp.net'] },
      { groupId: 'group-1', text: expect.stringContaining('Happy birthday Grace!'), mentionUserIds: [] },
    ]);
    expect(env.adapter.sent[1]!.text).not.toMatch(/1990|36/);
  });

  it('only the person who pasted the list can confirm or edit it', async () => {
    await paste(EXAMPLE);
    await replyWith('yes', BOB);
    await replyWith('remove 1', BOB);
    expect(env.adapter.sent).toHaveLength(1); // Bob's replies are ignored
    expect(await savedBirthdays()).toHaveLength(0);
  });

  it('"remove N" and "fix N: …" re-post the updated preview; bad edits keep it', async () => {
    await paste(bulk([line('John - 12 Oct', 'John', 10, 12), line('Tunde 21/07', 'Tunde', 7, 21), line('Sola 1 Sep', 'Sola', 9, 1)]));
    await replyWith('remove 2');
    expect(lastText()).toContain('I found 2 birthdays:\n1. John – 12 Oct\n2. Sola – 1 Sep');
    await replyWith('fix 2: 4 March');
    expect(lastText()).toContain('2. Sola – 4 Mar');
    await replyWith('fix 2: 31 April');
    expect(lastText()).toMatch(/isn't a real date/);
    await replyWith('fix 9: 4 March');
    expect(lastText()).toBe("There's no number 9 in the list. Pick between 1 and 2.");
    await replyWith('thanks');
    expect(lastText()).toMatch(/^Reply "yes" to save the birthdays/);
    await replyWith('yes');
    expect((await savedBirthdays()).map((r) => [r.title, r.startLocal])).toEqual([
      ["John's birthday", '2026-10-12 06:00:00'],
      ["Sola's birthday", '2027-03-04 06:00:00'],
    ]);
  });

  it('"no" cancels; an expired preview is ignored', async () => {
    await paste(EXAMPLE);
    await replyWith('no');
    expect(lastText()).toBe("OK, I didn't save any of them.");
    await paste(EXAMPLE);
    env.clock.advance(31 * 60_000);
    const before = env.adapter.sent.length;
    await replyWith('yes');
    expect(env.adapter.sent).toHaveLength(before);
    expect(await savedBirthdays()).toHaveLength(0);
  });

  it('skips birthdays already saved and duplicates within the list', async () => {
    await paste(bulk([line('@55443322110099 3 March', null, 3, 3, { mention_user_id: ADA.userId })]));
    await replyWith('yes');
    await paste(bulk([line('@55443322110099 3 March', null, 3, 3, { mention_user_id: ADA.userId }), line('Tayo 1 Sep', 'Tayo', 9, 1), line('Tayo - 1st September', 'Tayo', 9, 1)]));
    expect(lastText()).toContain('I found 1 birthday:\n1. Tayo – 1 Sep');
    expect(lastText()).toContain('ℹ️ Already saved: Ada (skipped)');
    expect(lastText()).toContain('ℹ️ Listed twice: Tayo (kept once)');
    await paste(bulk([line('@55443322110099 3 March', null, 3, 3, { mention_user_id: ADA.userId })]));
    expect(lastText()).toBe('All of those birthdays are already saved.');
  });

  it('respects the group cap: says how many fit and lets them save the first N', async () => {
    const three = bulk([line('A 1 Jan', 'Aa', 1, 1), line('B 2 Jan', 'Bb', 1, 2), line('C 3 Jan', 'Cc', 1, 3)]);
    smallParser.queue.push({ action: 'create', title: 'Meeting', kind: 'event', start_local: '2026-10-11T11:00:00', rrule: null, offsets_minutes: [0], subject_user_id: null, message_style: null });
    await small.adapter.receive(message({ text: 'meeting' }));
    await paste(three, {}, small, smallParser);
    expect(lastText(small)).toContain('⚠️ This group can only have 2 more reminders (the limit is 3).');
    await replyWith('yes', {}, small);
    expect(lastText(small)).toBe('Only 2 more reminders fit in this group (the limit is 3). Reply "save 2" to save the first 2, or "remove N" to drop some.');
    await replyWith('save 2', {}, small);
    expect(lastText(small)).toBe("Saved 2 birthdays. I'll wish each person at 06:00 on their day.");
    expect((await savedBirthdays(small)).map((r) => r.title)).toEqual(["Aa's birthday", "Bb's birthday"]);
  });

  it('turns back lists over the limit, before calling the parser when it can', async () => {
    await small.adapter.receive(message({ text: `add these birthdays:\n${['A 1 Jan', 'B 2 Jan', 'C 3 Jan', 'D 4 Jan', 'E 5 Jan'].join('\n')}` }));
    expect(smallParser.inputs).toHaveLength(0);
    expect(lastText(small)).toMatch(/more than 3 birthdays in one go/);
    await paste(bulk([line('A 1 Jan', 'Aa', 1, 1), line('B 2 Jan', 'Bb', 1, 2)], ['x', 'y']), {}, small, smallParser);
    expect(lastText(small)).toMatch(/more than 3 birthdays in one go/);
  });

  it('splits a long preview into numbered parts', async () => {
    const names = Array.from({ length: 40 }, (_, i) => `Person ${String(i + 1).padStart(2, '0')} With A Long Family Name`);
    await paste(bulk(names.map((n, i) => line(`${n} ${(i % 28) + 1} Jan`, n, 1, (i % 28) + 1))));
    const parts = texts();
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((t, i) => expect(t.startsWith(`(${i + 1}/${parts.length})`)).toBe(true));
    await replyWith('yes');
    expect(lastText()).toBe("Saved 40 birthdays. I'll wish each person at 06:00 on their day.");
  });

  it('saves all or nothing', async () => {
    const actor = { group: (await upsertGroup(env.handle.db, { platform: 'test', platformGroupId: 'group-1', defaultTimezone: 'Africa/Lagos' })).group, member: await knownMember('alice@s.whatsapp.net', 'Alice'), isAdmin: false };
    const good: ImportEntry = { line: '', name: 'Good', memberId: null, linkedBy: null, month: 1, day: 1, year: null };
    const broken: ImportEntry = { ...good, name: 'Broken', memberId: 999_999 }; // no such member: the insert fails
    await expect(env.service.importBirthdays(actor, [good, broken])).rejects.toThrow();
    expect(await savedBirthdays()).toHaveLength(0);
  });

  it('respects the creation policy', async () => {
    const gid = await groupId();
    await env.handle.pool.query(`update groups set creation_policy = 'admins' where id = $1`, [gid]);
    await paste(EXAMPLE);
    expect(lastText()).toBe('Only group admins can set reminders in this group.');
    await paste(EXAMPLE, ADMIN);
    expect(lastText()).toMatch(/^I found 6 birthdays/);
  });

  it('reads numeric dates with the group date format, which only admins can change', async () => {
    parser.queue.push({ action: 'set_date_format', format: 'MDY' });
    await env.adapter.receive(message({ text: 'we use month first' }));
    expect(lastText()).toBe('Only group admins can change the date format.');
    parser.queue.push({ action: 'set_date_format', format: 'MDY' });
    await env.adapter.receive(message({ text: 'we use month first', ...ADMIN }));
    expect(lastText()).toBe("OK: I'll read numeric dates month first, so 03/04 is 4 Mar.");
    await paste(bulk([line('Ada 03/04', 'Ada', 4, 3)]));
    expect(lastText()).toContain('1. Ada (matched to member Ada) – 4 Mar');
    expect(parser.inputs.at(-1)!.dateFormat).toBe('MDY');
  });
});

describe('linking name-only birthdays', () => {
  async function importTunde() {
    await paste(bulk([line('Tunde 21/07', 'Tunde', 7, 21), line('John - 12 Oct', 'John', 10, 12)]));
    await replyWith('yes');
  }
  const TUNDE: MentionedUser = { userId: 'tunde@s.whatsapp.net', altUserIds: [], displayName: 'Tunde' };

  it('"link Tunde to @Tunde" attaches the member, by the creator or an admin only', async () => {
    await importTunde();
    const link: ParsedCommand = { action: 'link_birthday', target: { short_id: null, description: 'Tunde' }, user_id: TUNDE.userId };
    parser.queue.push(link);
    await env.adapter.receive(message({ text: 'link Tunde to @tunde', mentionedUsers: [TUNDE], ...BOB }));
    expect(lastText()).toBe('Only the person who set this reminder or a group admin can change it.');
    parser.queue.push(link);
    await env.adapter.receive(message({ text: 'link Tunde to @tunde', mentionedUsers: [TUNDE] }));
    expect(lastText()).toBe("Linked: Tunde's birthday (#1) will tag Tunde on the day.");

    env.adapter.sent = [];
    await fastForward(env.handle.db, env.clock, env.dispatcher, new Date('2027-07-21T05:00:00Z'));
    expect(env.adapter.sent.at(-1)).toMatchObject({ text: expect.stringContaining('@tunde'), mentionUserIds: ['tunde@s.whatsapp.net'] });
  });

  it('asks once when someone adds their own birthday that is saved by name, and links on "yes"', async () => {
    await importTunde();
    const mine: ParsedCommand = {
      action: 'create', title: "John's birthday", kind: 'birthday', start_local: '2026-10-12T06:00:00', rrule: 'FREQ=YEARLY',
      offsets_minutes: [0], subject_user_id: 'john@s.whatsapp.net', message_style: null,
    };
    const JOHN = { senderId: 'john@s.whatsapp.net', senderDisplayName: 'John Okafor' };
    parser.queue.push(mine);
    await env.adapter.receive(message({ text: 'my birthday is 12 Oct', ...JOHN }));
    expect(lastText()).toBe(`I already have John's birthday (#2) on that date. Is that you? Reply "yes" to link it to you, or "no" to save a new one.`);
    await replyWith('yes', JOHN);
    expect(lastText()).toBe("Linked: John's birthday (#2) is yours now. I'll tag you on the day.");
    const saved = await savedBirthdays();
    expect(saved).toHaveLength(2);
    expect(saved[1]!.subjectMemberId).not.toBeNull();
    expect(await env.handle.db.select().from(pendingInteractions).where(eq(pendingInteractions.kind, 'confirm_link'))).toHaveLength(0);
  });

  it('"no" creates a separate birthday instead', async () => {
    await importTunde();
    parser.queue.push({
      action: 'create', title: "John's birthday", kind: 'birthday', start_local: '2026-10-12T06:00:00', rrule: 'FREQ=YEARLY',
      offsets_minutes: [0], subject_user_id: 'john@s.whatsapp.net', message_style: null,
    });
    const JOHN = { senderId: 'john@s.whatsapp.net', senderDisplayName: 'John' };
    await env.adapter.receive(message({ text: 'my birthday is 12 Oct', ...JOHN }));
    await replyWith('no', JOHN);
    expect(lastText()).toMatch(/^Got it: John's birthday \(#3\)/);
    expect(await savedBirthdays()).toHaveLength(3);
  });
});
