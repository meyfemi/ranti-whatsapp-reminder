/** Source of "now". Injected everywhere so the CLI and tests can use a fake clock. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A controllable clock for the CLI simulator and tests. */
export class FakeClock implements Clock {
  private current: number;
  constructor(start: Date = new Date()) {
    this.current = start.getTime();
  }
  now(): Date {
    return new Date(this.current);
  }
  set(to: Date): void {
    this.current = to.getTime();
  }
  advance(ms: number): Date {
    this.current += ms;
    return this.now();
  }
}

/** Parses durations like "90s", "5m", "2h", "3d", "1w" or combinations like "1d2h". */
export function parseDuration(input: string): number | null {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };
  const re = /(\d+)\s*([smhdw])/gi;
  let total = 0;
  let consumed = '';
  for (const m of input.matchAll(re)) {
    total += Number(m[1]) * units[m[2]!.toLowerCase()]!;
    consumed += m[0];
  }
  return consumed.replace(/\s/g, '') === input.replace(/\s/g, '') && total > 0 ? total : null;
}

/** Real time plus an adjustable offset: keeps ticking, but can be fast-forwarded (CLI simulator). */
export class OffsetClock implements Clock {
  private offsetMs = 0;
  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }
  advance(ms: number): Date {
    this.offsetMs += ms;
    return this.now();
  }
  set(to: Date): void {
    this.offsetMs = to.getTime() - Date.now();
  }
  get isShifted(): boolean {
    return this.offsetMs !== 0;
  }
}
