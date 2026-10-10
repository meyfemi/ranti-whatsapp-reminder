import { describe, expect, it } from 'vitest';
import { OutboundLimiter, randomDelay, SlidingWindow } from './rate-limit.js';

describe('SlidingWindow', () => {
  it('allows `limit` events per window', () => {
    const w = new SlidingWindow(2, 60_000);
    expect(w.tryRecord(0)).toBe(true);
    expect(w.tryRecord(1000)).toBe(true);
    expect(w.tryRecord(2000)).toBe(false);
    expect(w.waitTime(2000)).toBe(58_000);
    expect(w.tryRecord(60_001)).toBe(true);
  });
});

describe('OutboundLimiter', () => {
  function fakeTime() {
    let t = 0;
    const sleeps: number[] = [];
    return {
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      sleeps,
      at: () => t,
    };
  }

  it('waits for the per-group budget and preserves order', async () => {
    const time = fakeTime();
    const limiter = new OutboundLimiter({ globalPerMinute: 100, groupPerMinute: 2, now: time.now, sleep: time.sleep });
    const sentAt: [string, number][] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((label) => limiter.schedule('g1', async () => void sentAt.push([label, time.at()]))),
    );
    expect(sentAt).toEqual([
      ['a', 0],
      ['b', 0],
      ['c', 60_000],
    ]);
  });

  it('applies the global budget across groups', async () => {
    const time = fakeTime();
    const limiter = new OutboundLimiter({ globalPerMinute: 2, groupPerMinute: 10, now: time.now, sleep: time.sleep });
    const sentAt: number[] = [];
    await Promise.all(['g1', 'g2', 'g3'].map((g) => limiter.schedule(g, async () => void sentAt.push(time.at()))));
    expect(sentAt).toEqual([0, 0, 60_000]);
  });

  it('keeps going after a failed send', async () => {
    const time = fakeTime();
    const limiter = new OutboundLimiter({ globalPerMinute: 10, groupPerMinute: 10, now: time.now, sleep: time.sleep });
    await expect(limiter.schedule('g', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(limiter.schedule('g', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('randomDelay', () => {
  it('stays within bounds', () => {
    expect(randomDelay(1000, 4000, () => 0)).toBe(1000);
    expect(randomDelay(1000, 4000, () => 0.999999)).toBe(4000);
  });
});
