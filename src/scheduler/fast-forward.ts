import { and, asc, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { occurrences } from '../db/schema.js';
import type { Clock } from './clock.js';
import type { OccurrenceDispatcher } from './recovery.js';

/**
 * Moves a simulated clock forward to `target`, stopping at each pending occurrence on the way
 * so every reminder fires on time (as it would have in real life) instead of being "missed".
 */
export async function fastForward(
  db: Db,
  clock: Clock & { set(to: Date): void },
  dispatcher: OccurrenceDispatcher,
  target: Date,
  maxSteps = 1000,
): Promise<number> {
  let fired = 0;
  for (let i = 0; i < maxSteps; i++) {
    const [next] = await db
      .select()
      .from(occurrences)
      .where(and(eq(occurrences.status, 'pending'), lte(occurrences.fireAt, target)))
      .orderBy(asc(occurrences.fireAt))
      .limit(1);
    if (!next) break;
    if (next.fireAt.getTime() > clock.now().getTime()) clock.set(next.fireAt);
    await dispatcher.dispatch(next.id);
    fired++;
  }
  if (target.getTime() > clock.now().getTime()) clock.set(target);
  return fired;
}
