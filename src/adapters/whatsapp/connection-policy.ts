import { DisconnectReason } from 'baileys';

export type DisconnectAction =
  | { kind: 'reconnect'; immediate: boolean }
  | { kind: 'stop'; reason: 'logged_out' | 'replaced' | 'forbidden' | 'bad_session'; message: string };

/** Decides what to do after the socket closes, from the Boom status code Baileys reports. */
export function disconnectAction(statusCode: number | undefined): DisconnectAction {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return {
        kind: 'stop',
        reason: 'logged_out',
        message: 'WhatsApp logged this device out. Re-pair the bot (scan a new QR code or use a pairing code).',
      };
    case DisconnectReason.connectionReplaced:
      return {
        kind: 'stop',
        reason: 'replaced',
        message: 'Another instance connected with the same WhatsApp session. Make sure only one bot process runs.',
      };
    case DisconnectReason.forbidden:
      return {
        kind: 'stop',
        reason: 'forbidden',
        message: 'WhatsApp refused the connection (403). The number may be restricted or banned.',
      };
    case DisconnectReason.multideviceMismatch:
      return { kind: 'stop', reason: 'bad_session', message: 'Multi-device mismatch. Re-pair the bot.' };
    case DisconnectReason.restartRequired:
      return { kind: 'reconnect', immediate: true };
    default:
      return { kind: 'reconnect', immediate: false };
  }
}

/** Exponential backoff with jitter: 1s, 2s, 4s ... capped at 5 minutes. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(300_000, 1000 * 2 ** Math.max(0, attempt));
  return Math.round(base / 2 + (base / 2) * random());
}
