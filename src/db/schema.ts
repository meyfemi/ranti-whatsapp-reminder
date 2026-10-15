import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const creationPolicy = pgEnum('creation_policy', ['anyone', 'admins']);
export const reminderKind = pgEnum('reminder_kind', ['birthday', 'anniversary', 'event', 'generic']);
export const occurrenceStatus = pgEnum('occurrence_status', ['pending', 'sent', 'failed', 'skipped']);
export const interactionKind = pgEnum('interaction_kind', ['clarify', 'undo', 'choose', 'bulk_import', 'confirm_link']);
/** How numeric dates such as 03/04 are read: day first (DMY) or month first (MDY). */
export const dateFormat = pgEnum('date_format', ['DMY', 'MDY']);

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`);

export const groups = pgTable(
  'groups',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    platform: text('platform').notNull(),
    platformGroupId: text('platform_group_id').notNull(),
    name: text('name'),
    timezone: text('timezone').notNull().default('Africa/Lagos'),
    creationPolicy: creationPolicy('creation_policy').notNull().default('anyone'),
    dateFormat: dateFormat('date_format').notNull().default('DMY'),
    /** Weekly digest: off unless an admin turns it on. */
    digestEnabled: boolean('digest_enabled').notNull().default(false),
    /** ISO weekday the digest goes out on: 1 = Monday ... 7 = Sunday. */
    digestWeekday: integer('digest_weekday').notNull().default(1),
    /** Local time ("HH:mm", group timezone) the digest goes out at. */
    digestTime: text('digest_time').notNull().default('08:00'),
    /** Post "nothing scheduled" for an empty week instead of staying quiet. */
    digestPostEmpty: boolean('digest_post_empty').notNull().default(false),
    active: boolean('active').notNull().default(true),
    /** Next per-group short ID to hand out to a reminder. */
    nextShortId: integer('next_short_id').notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('groups_platform_group_uq').on(t.platform, t.platformGroupId)],
);

export const members = pgTable(
  'members',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** The stable platform ID (WhatsApp: phone-number JID or LID, whichever the platform gave first). */
    platformUserId: text('platform_user_id').notNull(),
    /** Other IDs known for the same person (e.g. the LID for a phone-number JID). */
    altUserIds: text('alt_user_ids').array().notNull().default(sql`'{}'::text[]`),
    lastKnownDisplayName: text('last_known_display_name'),
  },
  (t) => [
    uniqueIndex('members_group_user_uq').on(t.groupId, t.platformUserId),
    index('members_alt_ids_idx').using('gin', t.altUserIds),
  ],
);

export const reminders = pgTable(
  'reminders',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    shortId: integer('short_id').notNull(),
    title: text('title').notNull(),
    kind: reminderKind('kind').notNull(),
    /** Local date-time in `timezone` (no offset). */
    startLocal: timestamp('start_local', { withTimezone: false, mode: 'string' }).notNull(),
    rrule: text('rrule'),
    timezone: text('timezone').notNull(),
    offsetsMinutes: integer('offsets_minutes').array().notNull().default(sql`'{0}'::int[]`),
    subjectMemberId: integer('subject_member_id').references(() => members.id, { onDelete: 'set null' }),
    /** Name of the person when they aren't linked to a member (e.g. from a pasted birthday list). */
    subjectName: text('subject_name'),
    /** Birth year if given. Stored only; ages are never announced. */
    birthYear: integer('birth_year'),
    messageStyle: text('message_style'),
    createdByMemberId: integer('created_by_member_id')
      .notNull()
      .references(() => members.id),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('reminders_group_short_id_uq').on(t.groupId, t.shortId),
    index('reminders_group_active_idx').on(t.groupId, t.active),
  ],
);

export const occurrences = pgTable(
  'occurrences',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    reminderId: integer('reminder_id')
      .notNull()
      .references(() => reminders.id, { onDelete: 'cascade' }),
    offsetMinutes: integer('offset_minutes').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: occurrenceStatus('status').notNull().default('pending'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('occurrences_reminder_fire_offset_uq').on(t.reminderId, t.fireAt, t.offsetMinutes),
    index('occurrences_status_fire_at_idx').on(t.status, t.fireAt),
  ],
);

/**
 * One weekly digest per group per ISO week. Like occurrences, a run is claimed (pending -> sent)
 * in a transaction before sending, and only the next run per group is ever pending.
 */
export const digestRuns = pgTable(
  'digest_runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    /** ISO week of the slot in the group timezone, e.g. "2026-W43": at most one digest per week. */
    weekKey: text('week_key').notNull(),
    /** The configured send time, local to the group (before jitter). */
    slotLocal: timestamp('slot_local', { withTimezone: false, mode: 'string' }).notNull(),
    /** Slot time in UTC plus a random 0-15 minute spread. */
    fireAt: timestamp('fire_at', { withTimezone: true }).notNull(),
    status: occurrenceStatus('status').notNull().default('pending'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('digest_runs_group_week_uq').on(t.groupId, t.weekKey),
    index('digest_runs_status_fire_at_idx').on(t.status, t.fireAt),
  ],
);

export const pendingInteractions = pgTable(
  'pending_interactions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    groupId: integer('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    memberId: integer('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    kind: interactionKind('kind').notNull(),
    payload: jsonb('payload').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('pending_interactions_lookup_idx').on(t.groupId, t.memberId, t.expiresAt)],
);

export type Group = typeof groups.$inferSelect;
export type MemberRow = typeof members.$inferSelect;
export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type Occurrence = typeof occurrences.$inferSelect;
export type PendingInteraction = typeof pendingInteractions.$inferSelect;
export type DigestRun = typeof digestRuns.$inferSelect;

// ---------------------------------------------------------------- WhatsApp (Baileys) auth state
// Values are JSON produced with Baileys' BufferJSON replacer, stored as text.

export const waAuthCreds = pgTable('wa_auth_creds', {
  session: text('session').primaryKey(),
  creds: text('creds').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
});

export const waAuthKeys = pgTable(
  'wa_auth_keys',
  {
    session: text('session').notNull(),
    type: text('type').notNull(),
    keyId: text('key_id').notNull(),
    value: text('value').notNull(),
  },
  (t) => [uniqueIndex('wa_auth_keys_pk').on(t.session, t.type, t.keyId)],
);
