import { DisconnectReason } from 'baileys';
import { describe, expect, it } from 'vitest';
import { backoffDelay, disconnectAction } from './connection-policy.js';

describe('disconnectAction', () => {
  it('stops on logout, replacement and 403', () => {
    expect(disconnectAction(DisconnectReason.loggedOut)).toMatchObject({ kind: 'stop', reason: 'logged_out' });
    expect(disconnectAction(DisconnectReason.connectionReplaced)).toMatchObject({ kind: 'stop', reason: 'replaced' });
    expect(disconnectAction(DisconnectReason.forbidden)).toMatchObject({ kind: 'stop', reason: 'forbidden' });
  });
  it('restarts immediately when Baileys asks for a restart (e.g. right after pairing)', () => {
    expect(disconnectAction(DisconnectReason.restartRequired)).toEqual({ kind: 'reconnect', immediate: true });
  });
  it('backs off on transient failures', () => {
    expect(disconnectAction(DisconnectReason.connectionLost)).toEqual({ kind: 'reconnect', immediate: false });
    expect(disconnectAction(undefined)).toEqual({ kind: 'reconnect', immediate: false });
  });
});

describe('backoffDelay', () => {
  it('grows exponentially and caps at 5 minutes', () => {
    expect(backoffDelay(0, () => 1)).toBe(1000);
    expect(backoffDelay(3, () => 1)).toBe(8000);
    expect(backoffDelay(3, () => 0)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(300_000);
  });
});
