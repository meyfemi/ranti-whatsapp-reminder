import { DateTime } from 'luxon';
import type { Db } from '../../db/client.js';
import { parseDuration, type Clock } from '../../scheduler/clock.js';
import { fastForward } from '../../scheduler/fast-forward.js';
import type { FastForwardDigests } from '../../scheduler/fast-forward.js';
import type { OccurrenceDispatcher } from '../../scheduler/recovery.js';
import type { CliAdapter } from './cli-adapter.js';

export interface SimulatedClock extends Clock {
  set(to: Date): void;
}

/** Registers /clock, /advance and /settime: the simulator's fake clock. */
export function registerClockCommands(
  adapter: CliAdapter,
  deps: {
    db: Db;
    clock: SimulatedClock;
    dispatcher: OccurrenceDispatcher;
    digests?: FastForwardDigests;
    timezone: string;
    out?: NodeJS.WritableStream;
    isShifted?: () => boolean;
  },
): () => string {
  const out = deps.out ?? process.stdout;
  const showClock = () => {
    const now = DateTime.fromJSDate(deps.clock.now()).setZone(deps.timezone);
    return `🕒 ${now.toFormat('ccc d LLL yyyy HH:mm:ss')} (${deps.timezone})${deps.isShifted?.() ? ' [simulated]' : ''}\n`;
  };
  adapter.registerCommand('clock', 'show the simulated time', () => {
    out.write(showClock());
  });
  adapter.registerCommand('advance', 'fast-forward time, e.g. /advance 2h or /advance 1d6h', async (args) => {
    const ms = parseDuration(args.join(''));
    if (!ms) return void out.write('Usage: /advance 90s | 5m | 2h | 3d | 1w (combinable: 1d2h)\n');
    const fired = await fastForward(deps.db, deps.clock, deps.dispatcher, new Date(deps.clock.now().getTime() + ms), { digests: deps.digests });
    out.write(`${showClock()}${fired} reminder(s) fired.\n`);
  });
  adapter.registerCommand('settime', 'jump to a local time, e.g. /settime 2026-10-12T08:59', async (args) => {
    const target = DateTime.fromISO(args.join('T'), { zone: deps.timezone });
    if (!target.isValid) return void out.write('Usage: /settime 2026-10-12T08:59\n');
    const fired = await fastForward(deps.db, deps.clock, deps.dispatcher, target.toJSDate(), { digests: deps.digests });
    out.write(`${showClock()}${fired} reminder(s) fired.\n`);
  });
  return showClock;
}
