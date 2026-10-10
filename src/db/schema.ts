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
export const interactionKind = pgEnum('interaction_kind', ['clarify', 'undo', 'choose']);

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
