import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { Db } from './client.js';
import {
  groups,
  members,
  occurrences,
  pendingInteractions,
  reminders,
  type Group,
  type MemberRow,
  type NewReminder,
  type Occurrence,
  type PendingInteraction,
  type Reminder,
} from './schema.js';

/** A database handle or an open transaction. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// ---------------------------------------------------------------- groups

export async function upsertGroup(
  db: DbOrTx,
  input: { platform: string; platformGroupId: string; name?: string | undefined; defaultTimezone: string },
): Promise<{ group: Group; created: boolean }> {
  const inserted = await db
    .insert(groups)
    .values({
      platform: input.platform,
      platformGroupId: input.platformGroupId,
      name: input.name ?? null,
      timezone: input.defaultTimezone,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { group: inserted[0], created: true };
  const [existing] = await db
    .select()
    .from(groups)
    .where(and(eq(groups.platform, input.platform), eq(groups.platformGroupId, input.platformGroupId)));
  if (!existing) throw new Error('Group upsert raced and lost');
  if (input.name && input.name !== existing.name) {
    await db.update(groups).set({ name: input.name }).where(eq(groups.id, existing.id));
    existing.name = input.name;
  }
  return { group: existing, created: false };
}

export async function getGroup(db: DbOrTx, id: number): Promise<Group | undefined> {
  const [g] = await db.select().from(groups).where(eq(groups.id, id));
  return g;
}

export async function updateGroup(
  db: DbOrTx,
  id: number,
  patch: Partial<Pick<Group, 'timezone' | 'creationPolicy' | 'active' | 'name' | 'dateFormat'>>,
): Promise<void> {
  await db.update(groups).set(patch).where(eq(groups.id, id));
}

/** Atomically hands out the next per-group short ID. */
export async function allocateShortId(db: DbOrTx, groupId: number): Promise<number> {
  const [row] = await db
    .update(groups)
    .set({ nextShortId: sql`${groups.nextShortId} + 1` })
    .where(eq(groups.id, groupId))
    .returning({ allocated: sql<number>`${groups.nextShortId} - 1` });
  if (!row) throw new Error(`Group ${groupId} not found`);
  return Number(row.allocated);
}

// ---------------------------------------------------------------- members

/**
 * Finds a member by any of their known IDs (primary or alternate, e.g. LID vs phone-number JID)
 * and records new IDs/display names. Creates the member if unknown.
 */
export async function upsertMember(
  db: DbOrTx,
  groupId: number,
  input: { userId: string; altUserIds?: string[]; displayName?: string | undefined },
): Promise<MemberRow> {
  const ids = [...new Set([input.userId, ...(input.altUserIds ?? [])])];
  const found = await findMemberByAnyId(db, groupId, ids);
  if (found) {
    const mergedAlt = [...new Set([...found.altUserIds, ...ids])].filter((id) => id !== found.platformUserId);
    const nameChanged = input.displayName && input.displayName !== found.lastKnownDisplayName;
    const altChanged = mergedAlt.length !== found.altUserIds.length;
    if (nameChanged || altChanged) {
      const [updated] = await db
        .update(members)
        .set({
          altUserIds: mergedAlt,
          lastKnownDisplayName: input.displayName ?? found.lastKnownDisplayName,
        })
        .where(eq(members.id, found.id))
        .returning();
      return updated!;
    }
    return found;
  }
  const [created] = await db
    .insert(members)
    .values({
      groupId,
      platformUserId: input.userId,
      altUserIds: ids.filter((id) => id !== input.userId),
      lastKnownDisplayName: input.displayName ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  // Lost a race with a concurrent insert of the same user.
  const again = await findMemberByAnyId(db, groupId, ids);
  if (!again) throw new Error('Member upsert raced and lost');
  return again;
}

export async function findMemberByAnyId(db: DbOrTx, groupId: number, ids: string[]): Promise<MemberRow | undefined> {
  if (ids.length === 0) return undefined;
  const [m] = await db
    .select()
    .from(members)
    .where(
      and(
        eq(members.groupId, groupId),
        or(inArray(members.platformUserId, ids), sql`${members.altUserIds} && ${sql.param(ids)}::text[]`),
      ),
    )
    .limit(1);
  return m;
}

export async function listMembers(db: DbOrTx, groupId: number): Promise<MemberRow[]> {
  return db.select().from(members).where(eq(members.groupId, groupId)).orderBy(asc(members.id));
}

export async function getMember(db: DbOrTx, id: number): Promise<MemberRow | undefined> {
  const [m] = await db.select().from(members).where(eq(members.id, id));
  return m;
}

// ---------------------------------------------------------------- reminders

export async function insertReminder(db: DbOrTx, values: NewReminder): Promise<Reminder> {
  const [r] = await db.insert(reminders).values(values).returning();
  return r!;
}

export async function getReminder(db: DbOrTx, id: number): Promise<Reminder | undefined> {
  const [r] = await db.select().from(reminders).where(eq(reminders.id, id));
  return r;
}

export async function getReminderByShortId(db: DbOrTx, groupId: number, shortId: number): Promise<Reminder | undefined> {
  const [r] = await db
    .select()
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.shortId, shortId)));
  return r;
}

export async function listActiveReminders(db: DbOrTx, groupId: number): Promise<Reminder[]> {
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.active, true)))
    .orderBy(asc(reminders.shortId));
}

export async function countActiveReminders(db: DbOrTx, groupId: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reminders)
    .where(and(eq(reminders.groupId, groupId), eq(reminders.active, true)));
  return row?.n ?? 0;
}

export async function updateReminder(
  db: DbOrTx,
  id: number,
  patch: Partial<Omit<Reminder, 'id' | 'groupId' | 'shortId' | 'createdAt'>>,
): Promise<Reminder> {
  const [r] = await db
    .update(reminders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(reminders.id, id))
    .returning();
  if (!r) throw new Error(`Reminder ${id} not found`);
  return r;
}

// ---------------------------------------------------------------- occurrences

/**
 * Inserts a pending occurrence. If the same (reminder, fire time, offset) exists and was skipped
 * (e.g. an edit was undone), it is revived. Returns undefined if it already exists as pending,
 * sent or failed, so nothing that was already posted can be posted again.
 */
export async function insertOccurrence(
  db: DbOrTx,
  values: { reminderId: number; offsetMinutes: number; fireAt: Date },
): Promise<Occurrence | undefined> {
  const [o] = await db
    .insert(occurrences)
    .values(values)
    .onConflictDoUpdate({
      target: [occurrences.reminderId, occurrences.fireAt, occurrences.offsetMinutes],
      set: { status: 'pending', attempts: 0, lastError: null, sentAt: null },
      setWhere: sql`${occurrences.status} = 'skipped'`,
    })
    .returning();
  return o;
}

export async function getOccurrence(db: DbOrTx, id: number): Promise<Occurrence | undefined> {
  const [o] = await db.select().from(occurrences).where(eq(occurrences.id, id));
  return o;
}

export async function listPendingDue(db: DbOrTx, now: Date, limit = 500): Promise<Occurrence[]> {
  return db
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.status, 'pending'), lte(occurrences.fireAt, now)))
    .orderBy(asc(occurrences.fireAt))
    .limit(limit);
}

export async function listPendingFuture(db: DbOrTx, now: Date): Promise<Occurrence[]> {
  return db
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.status, 'pending'), gt(occurrences.fireAt, now)))
    .orderBy(asc(occurrences.fireAt));
}

export async function listPendingForReminder(db: DbOrTx, reminderId: number): Promise<Occurrence[]> {
  return db
    .select()
    .from(occurrences)
    .where(and(eq(occurrences.reminderId, reminderId), eq(occurrences.status, 'pending')))
    .orderBy(asc(occurrences.fireAt));
}

/** Marks every pending occurrence of a reminder as skipped (used on cancel/edit). */
export async function skipPendingForReminder(db: DbOrTx, reminderId: number): Promise<number> {
  const rows = await db
    .update(occurrences)
    .set({ status: 'skipped' })
    .where(and(eq(occurrences.reminderId, reminderId), eq(occurrences.status, 'pending')))
    .returning({ id: occurrences.id });
  return rows.length;
}

// ---------------------------------------------------------------- pending interactions

export async function createInteraction(
  db: DbOrTx,
  values: { groupId: number; memberId: number; kind: PendingInteraction['kind']; payload: unknown; expiresAt: Date },
): Promise<PendingInteraction> {
  // One open interaction of each kind per member per group: the newest wins.
  await db
    .delete(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.groupId, values.groupId),
        eq(pendingInteractions.memberId, values.memberId),
        eq(pendingInteractions.kind, values.kind),
      ),
    );
  const [row] = await db.insert(pendingInteractions).values(values).returning();
  return row!;
}

export async function findActiveInteraction(
  db: DbOrTx,
  groupId: number,
  memberId: number,
  kind: PendingInteraction['kind'],
  now: Date,
): Promise<PendingInteraction | undefined> {
  const [row] = await db
    .select()
    .from(pendingInteractions)
    .where(
      and(
        eq(pendingInteractions.groupId, groupId),
        eq(pendingInteractions.memberId, memberId),
        eq(pendingInteractions.kind, kind),
        gt(pendingInteractions.expiresAt, now),
      ),
    )
    .orderBy(sql`${pendingInteractions.createdAt} desc`)
    .limit(1);
  return row;
}

export async function deleteInteraction(db: DbOrTx, id: number): Promise<void> {
  await db.delete(pendingInteractions).where(eq(pendingInteractions.id, id));
}

export async function deleteExpiredInteractions(db: DbOrTx, now: Date): Promise<number> {
  const rows = await db
    .delete(pendingInteractions)
    .where(lte(pendingInteractions.expiresAt, now))
    .returning({ id: pendingInteractions.id });
  return rows.length;
}
