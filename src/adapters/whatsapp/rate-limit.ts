/** Sliding-window counter: at most `limit` events per `windowMs`. */
export class SlidingWindow {
  private events: number[] = [];
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0]! <= cutoff) this.events.shift();
  }

  /** Milliseconds until one more event is allowed (0 = now). */
  waitTime(now: number): number {
    this.prune(now);
    if (this.events.length < this.limit) return 0;
    return this.events[0]! + this.windowMs - now;
  }

  record(now: number): void {
    this.events.push(now);
  }

  tryRecord(now: number): boolean {
    if (this.waitTime(now) > 0) return false;
    this.record(now);
    return true;
  }
}

export interface OutboundLimiterOptions {
  globalPerMinute: number;
  groupPerMinute: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Paces outgoing messages: waits (rather than drops) until both the global and the per-group
 * budgets allow another message. Calls are serialised so ordering is preserved.
 */
export class OutboundLimiter {
  private readonly global: SlidingWindow;
  private readonly groups = new Map<string, SlidingWindow>();
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OutboundLimiterOptions) {
    this.global = new SlidingWindow(opts.globalPerMinute, 60_000);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private groupWindow(groupId: string): SlidingWindow {
    let w = this.groups.get(groupId);
    if (!w) this.groups.set(groupId, (w = new SlidingWindow(this.opts.groupPerMinute, 60_000)));
    return w;
  }

  /** Runs `send` once the budgets allow it. */
  schedule<T>(groupId: string, send: () => Promise<T>): Promise<T> {
    const run = async () => {
      const group = this.groupWindow(groupId);
      for (;;) {
        const wait = Math.max(this.global.waitTime(this.now()), group.waitTime(this.now()));
        if (wait <= 0) break;
        await this.sleep(wait);
      }
      this.global.record(this.now());
      group.record(this.now());
      return send();
    };
    const result = this.chain.then(run, run);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function randomDelay(minMs: number, maxMs: number, random: () => number = Math.random): number {
  return Math.round(minMs + (maxMs - minMs) * random());
}
