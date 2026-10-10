import { describe, expect, it } from 'vitest';
import type { Reminder } from '../db/schema.js';
import { TEMPLATE_POOL_SIZES, TemplateGreeter } from './greetings.js';
import { buildReminderMessage } from './messages.js';

const reminder = (over: Partial<Reminder> = {}): Reminder => ({
  id: 1,
  groupId: 1,
  shortId: 1,
  title: 'General meeting',
  kind: 'event',
  startLocal: '2026-10-11 11:00:00',
  rrule: null,
  timezone: 'Africa/Lagos',
  offsetsMinutes: [5, 0],
  subjectMemberId: null,
  messageStyle: null,
  createdByMemberId: 1,
  active: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  cancelledAt: null,
  ...over,
});

const build = (r: Reminder, offsetMinutes: number, fireAt: string, extra: { subject?: string; late?: boolean } = {}) =>
  buildReminderMessage({
    reminder: r,
    offsetMinutes,
    fireAt: new Date(fireAt),
    subjectUserId: extra.subject ?? null,
    subjectDisplayName: null,
    late: extra.late ?? false,
    formatMention: (id) => `@${id.split('@')[0]}`,
    greeter: new TemplateGreeter(() => 0.5),
  });

describe('buildReminderMessage', () => {
  it('event lead and at-time messages', async () => {
    expect((await build(reminder(), 5, '2026-10-11T09:55:00Z')).text).toBe(
      '⏰ Reminder: General meeting starts in 5 minutes (11:00).',
    );
    expect((await build(reminder(), 0, '2026-10-11T10:00:00Z')).text).toBe(
      '⏰ Reminder: General meeting is starting now (11:00).',
    );
  });

  it('a day-ahead reminder shows the date', async () => {
    expect((await build(reminder(), 1440, '2026-10-10T10:00:00Z')).text).toBe(
      '⏰ Reminder: General meeting starts in 1 day (Sun 11 Oct, 11:00).',
    );
  });

  it('adds the late note', async () => {
    expect((await build(reminder(), 0, '2026-10-11T10:00:00Z', { late: true })).text).toMatch(/\(slightly late\)$/);
  });

  it('mentions only the subject, for birthdays and person-specific reminders', async () => {
    const bday = await build(reminder({ kind: 'birthday', title: "John's birthday" }), 0, '2026-10-12T08:00:00Z', {
      subject: '2348011111111@s.whatsapp.net',
    });
    expect(bday.text).toContain('@2348011111111');
    expect(bday.mentionUserIds).toEqual(['2348011111111@s.whatsapp.net']);

    const dentist = await build(reminder({ title: 'Dentist' }), 0, '2026-10-11T10:00:00Z', { subject: 'bola@s.whatsapp.net' });
    expect(dentist.text).toBe('⏰ Reminder for @bola: Dentist is starting now (11:00).');
    expect(dentist.mentionUserIds).toEqual(['bola@s.whatsapp.net']);
  });

  it('sanitises stored titles so they cannot mention people', async () => {
    const m = await build(reminder({ title: '@everyone party' }), 0, '2026-10-11T10:00:00Z');
    expect(m.text).toBe('⏰ Reminder: everyone party is starting now (11:00).');
    expect(m.mentionUserIds).toEqual([]);
  });

  it('greets the occasion when there is no subject member', async () => {
    const m = await build(reminder({ kind: 'birthday', title: "Grandma's birthday" }), 0, '2026-10-12T08:00:00Z');
    expect(m.text).toBe("🎂 Today: Grandma's birthday! Happy birthday! 🎉");
  });
});

describe('TemplateGreeter', () => {
  it('varies its messages and always includes the mention', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < TEMPLATE_POOL_SIZES.birthday; i++) {
      const g = new TemplateGreeter(() => i / TEMPLATE_POOL_SIZES.birthday);
      const text = await g.greet({ kind: 'birthday', subject: '@123', title: 'x', style: null });
      expect(text).toContain('@123');
      seen.add(text);
    }
    expect(seen.size).toBe(TEMPLATE_POOL_SIZES.birthday);
  });
});
