import type { WAMessage } from 'baileys';
import { describe, expect, it } from 'vitest';
import { parseRaw, participantEventIds, toIncoming, type ParticipantInfo } from './extract.js';
import { isHandledChat, mentionToken, normalizeJid } from './jid.js';

const GROUP = '120363000000000001@g.us';
const BOT_PN = '2348099999999@s.whatsapp.net';
const BOT_LID = '55555555555555@lid';
const BOT_IDS = [BOT_PN, BOT_LID];
const ALICE_LID = '11111111111111@lid';
const ALICE_PN = '2348000000001@s.whatsapp.net';
const JOHN_LID = '22222222222222@lid';
const JOHN_PN = '2348011111111@s.whatsapp.net';

const participants: ParticipantInfo[] = [
  { id: ALICE_LID, phoneNumber: ALICE_PN, admin: 'admin' },
  { id: JOHN_LID, phoneNumber: JOHN_PN, admin: null },
  { id: BOT_LID, phoneNumber: BOT_PN, admin: null },
];

function msg(over: {
  text?: string;
  mentioned?: string[];
  quotedParticipant?: string;
  quotedMessage?: unknown;
  remoteJid?: string;
  participant?: string;
  participantAlt?: string;
  fromMe?: boolean;
  wrap?: 'ephemeral';
}): WAMessage {
  const extended = {
    text: over.text ?? 'hello',
    contextInfo: {
      mentionedJid: over.mentioned ?? [],
      ...(over.quotedParticipant ? { stanzaId: 'BOTMSG1', participant: over.quotedParticipant, quotedMessage: over.quotedMessage ?? { conversation: 'x' } } : {}),
    },
  };
  const message = over.wrap === 'ephemeral' ? { ephemeralMessage: { message: { extendedTextMessage: extended } } } : { extendedTextMessage: extended };
  return {
    key: {
      remoteJid: over.remoteJid ?? GROUP,
      fromMe: over.fromMe ?? false,
      id: 'MSG1',
      participant: over.participant ?? ALICE_LID,
      participantAlt: over.participantAlt ?? ALICE_PN,
    },
    message,
    pushName: 'Alice',
    messageTimestamp: 1_791_000_000,
  } as unknown as WAMessage;
}

describe('jid helpers', () => {
  it('normalises device suffixes and builds mention tokens', () => {
    expect(normalizeJid('2348099999999:12@s.whatsapp.net')).toBe(BOT_PN);
    expect(mentionToken(JOHN_LID)).toBe('@22222222222222');
  });
  it('only handles group chats', () => {
    expect(isHandledChat(GROUP)).toBe(true);
    expect(isHandledChat('status@broadcast')).toBe(false);
    expect(isHandledChat('12345@broadcast')).toBe(false);
    expect(isHandledChat('120363111@newsletter')).toBe(false);
    expect(isHandledChat(ALICE_PN)).toBe(false); // DMs are ignored entirely
  });
});

describe('parseRaw', () => {
  it('detects a mention of the bot by LID via contextInfo, and strips it from the text', () => {
    const raw = parseRaw(msg({ text: '@55555555555555 remind us at 5pm', mentioned: [BOT_LID] }), BOT_IDS)!;
    expect(raw.mentionsBot).toBe(true);
    expect(raw.text).toBe('remind us at 5pm');
    expect(raw.mentionedJids).toEqual([]);
    expect(raw.senderIds).toEqual([ALICE_LID, ALICE_PN]);
  });

  it('detects a mention of the bot by phone-number JID (with device suffix)', () => {
    const raw = parseRaw(msg({ text: '@2348099999999 help', mentioned: ['2348099999999:3@s.whatsapp.net'] }), BOT_IDS)!;
    expect(raw.mentionsBot).toBe(true);
    expect(raw.text).toBe('help');
  });

  it('does not treat the bot name typed as text as a mention', () => {
    expect(parseRaw(msg({ text: '@Ranti hello' }), BOT_IDS)).toBeNull();
  });

  it('ignores unmentioned chatter, own messages, DMs, status and newsletters', () => {
    expect(parseRaw(msg({ text: 'just chatting' }), BOT_IDS)).toBeNull();
    expect(parseRaw(msg({ mentioned: [BOT_LID], fromMe: true }), BOT_IDS)).toBeNull();
    expect(parseRaw(msg({ mentioned: [BOT_LID], remoteJid: ALICE_PN }), BOT_IDS)).toBeNull();
    expect(parseRaw(msg({ mentioned: [BOT_LID], remoteJid: 'status@broadcast' }), BOT_IDS)).toBeNull();
    expect(parseRaw(msg({ mentioned: [BOT_LID], remoteJid: '1203@newsletter' }), BOT_IDS)).toBeNull();
  });

  it('detects replies to the bot (quoted participant as LID or phone JID)', () => {
    const raw = parseRaw(msg({ text: 'undo', quotedParticipant: BOT_LID }), BOT_IDS)!;
    expect(raw.isReplyToBot).toBe(true);
    expect(raw.mentionsBot).toBe(false);
    expect(raw.quotedMessageId).toBe('BOTMSG1');
    expect(parseRaw(msg({ text: 'undo', quotedParticipant: BOT_PN }), BOT_IDS)!.isReplyToBot).toBe(true);
    expect(parseRaw(msg({ text: 'undo', quotedParticipant: JOHN_LID }), BOT_IDS)).toBeNull();
  });

  it("carries the quoted post when the bot is tagged under someone else's message", () => {
    const raw = parseRaw(
      msg({
        text: '@55555555555555',
        mentioned: [BOT_LID],
        quotedParticipant: JOHN_LID,
        quotedMessage: {
          extendedTextMessage: {
            text: 'Remind us to meet @2348000000001 by 7:30pm on Friday',
            contextInfo: { mentionedJid: [ALICE_PN] },
          },
        },
      }),
      BOT_IDS,
    )!;
    expect(raw.text).toBe('');
    expect(raw.quoted).toEqual({ text: 'Remind us to meet @2348000000001 by 7:30pm on Friday', senderId: JOHN_LID });
    expect(raw.mentionedJids).toEqual([ALICE_PN]);
    expect(toIncoming(raw, participants).quoted).toEqual({
      text: 'Remind us to meet @2348000000001 by 7:30pm on Friday',
      senderId: JOHN_LID,
      senderAltIds: [JOHN_PN],
      senderDisplayName: undefined,
    });
  });

  it("does not treat the bot's own message as a quoted post, nor a quote without a mention", () => {
    expect(parseRaw(msg({ text: '@55555555555555 4pm', mentioned: [BOT_LID], quotedParticipant: BOT_LID }), BOT_IDS)!.quoted).toBeUndefined();
    expect(parseRaw(msg({ text: 'nice', quotedParticipant: JOHN_LID }), BOT_IDS)).toBeNull();
  });

  it('unwraps ephemeral (disappearing) messages', () => {
    expect(parseRaw(msg({ mentioned: [BOT_LID], wrap: 'ephemeral' }), BOT_IDS)!.mentionsBot).toBe(true);
  });
});

describe('toIncoming', () => {
  it('fills admin status and LID/phone aliases for sender and mentioned users', () => {
    const raw = parseRaw(
      msg({ text: "@55555555555555 12 Oct is @22222222222222's birthday", mentioned: [BOT_LID, JOHN_LID] }),
      BOT_IDS,
    )!;
    const incoming = toIncoming(raw, participants);
    expect(incoming).toMatchObject({
      groupId: GROUP,
      senderId: ALICE_LID,
      senderAltIds: [ALICE_PN],
      senderDisplayName: 'Alice',
      isFromAdmin: true,
      text: "12 Oct is @22222222222222's birthday",
      mentionedUserIds: [JOHN_LID],
      mentionedUsers: [{ userId: JOHN_LID, altUserIds: [JOHN_PN] }],
    });
  });

  it('marks non-admins and tolerates unknown participants', () => {
    const raw = parseRaw(msg({ mentioned: [BOT_LID], participant: JOHN_PN, participantAlt: JOHN_LID }), BOT_IDS)!;
    expect(toIncoming(raw, participants).isFromAdmin).toBe(false);
    expect(toIncoming(raw, []).isFromAdmin).toBe(false);
  });
});

describe('participantEventIds', () => {
  it('accepts strings and participant objects', () => {
    expect(participantEventIds([BOT_PN, { id: BOT_LID, phoneNumber: BOT_PN }])).toEqual([BOT_PN, BOT_LID]);
  });
});
