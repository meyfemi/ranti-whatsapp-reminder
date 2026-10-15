import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { occurrences } from '../db/schema.js';
import type { Clock } from './clock.js';
import type { OccurrenceDispatcher } from './recovery.js';

/** Anything with due work of its own that fast-forward should stop for (the weekly digest). */
export interface FastForwardDigests {
  listDue(upTo: Date, limit?: number): Promise<{ id: number; fireAt: Date }[]>;
  send(runId: number): Promise<unknown>;
}

/**
 * Moves a simulated clock forward to `target`, stopping at each pending occurrence (and digest
 * run) on the way so everything fires on time, as it would have in real life, instead of being "missed".
 */
export async function fastForward(
  db: Db,
  clock: Clock & { set(to: Date): void },
  dispatcher: OccurrenceDispatcher,
  target: Date,
  opts: { digests?: FastForwardDigests; maxSteps?: number } = {},
): Promise<number> {
  let fired = 0;
  for (let i = 0; i < (opts.maxSteps ?? 1000); i++) {
    const [next] = await db
      .select()
      .from(occurrences)
      .where(and(eq(occurrences.status, 'pending'), lte(occurrences.fireAt, target)))
      .orderBy(asc(occurrences.fireAt))
      .limit(1);
    const [digest] = (await opts.digests?.listDue(target, 1)) ?? [];
    if (!next && !digest) break;
    const useDigest = !!digest && (!next || digest.fireAt.getTime() < next.fireAt.getTime());
    const at = useDigest ? digest!.fireAt : next!.fireAt;
    if (at.getTime() > clock.now().getTime()) clock.set(at);
    if (useDigest) await opts.digests!.send(digest!.id);
    else await dispatcher.dispatch(next!.id);
    fired++;
  }
  if (target.getTime() > clock.now().getTime()) clock.set(target);
  return fired;
}
