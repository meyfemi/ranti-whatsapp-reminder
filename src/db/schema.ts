import { sql } from 'drizzle-orm';
import { boolean, integer, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const creationPolicy = pgEnum('creation_policy', ['anyone', 'admins']);

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
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
    platformUserId: text('platform_user_id').notNull(),
    lastKnownDisplayName: text('last_known_display_name'),
  },
  (t) => [uniqueIndex('members_group_user_uq').on(t.groupId, t.platformUserId)],
);
