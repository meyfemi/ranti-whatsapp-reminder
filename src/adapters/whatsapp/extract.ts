import { getContentType, normalizeMessageContent, toNumber, type proto, type WAMessage } from 'baileys';
import type { IncomingMessage, MentionedUser, QuotedMessage } from '../types.js';
import { isHandledChat, jidUser, normalizeJid, uniqueIds } from './jid.js';

export interface ParticipantInfo {
  id: string;
  lid?: string | null;
  phoneNumber?: string | null;
  admin?: 'admin' | 'superadmin' | null;
  notify?: string | null;
}

/** Everything we can learn from the message alone, before fetching group metadata. */
export interface RawIncoming {
  messageId: string;
  groupId: string;
  senderIds: string[];
  pushName?: string;
  text: string;
  mentionedJids: string[];
  quotedMessageId?: string;
  isReplyToBot: boolean;
  /** Text and author of the quoted post, when it isn't the bot's. */
  quoted?: { text: string; senderId: string };
  mentionsBot: boolean;
  timestamp: Date;
}

function textAndContext(message: proto.IMessage | null | undefined): { text: string; context?: proto.IContextInfo | null } {
  const content = normalizeMessageContent(message);
  if (!content) return { text: '' };
  const type = getContentType(content);
  if (type === 'conversation') return { text: content.conversation ?? '' };
  const inner = type ? (content[type] as { text?: string | null; caption?: string | null; contextInfo?: proto.IContextInfo | null }) : undefined;
  if (!inner || typeof inner !== 'object') return { text: '' };
  return { text: inner.text ?? inner.caption ?? '', context: inner.contextInfo };
}

/**
 * Stage 1: decides from the raw message alone whether the bot should look at it at all.
 * Returns null for anything that is not a group text message that mentions or replies to the bot,
 * so ordinary group chatter is dropped before any further work (and never reaches the LLM).
 */
export function parseRaw(msg: WAMessage, botIds: string[]): RawIncoming | null {
  if (msg.key.fromMe) return null;
  const groupId = msg.key.remoteJid;
  if (!isHandledChat(groupId)) return null;
  if (!msg.message) return null;

  const { text, context } = textAndContext(msg.message);
  if (!text.trim()) return null;

  const bots = new Set(botIds);
  const mentioned = uniqueIds(context?.mentionedJid ?? []);
  const mentionsBot = mentioned.some((j) => bots.has(j));
  const quotedParticipant = normalizeJid(context?.participant);
  const isReplyToBot = !!context?.stanzaId && !!quotedParticipant && bots.has(quotedParticipant);
  if (!mentionsBot && !isReplyToBot) return null;

  // Tagging the bot under someone's post ("Remind us to meet at 7:30pm Friday") hands it that post.
  let quoted: RawIncoming['quoted'];
  if (!isReplyToBot && quotedParticipant && context?.quotedMessage) {
    const q = textAndContext(context.quotedMessage);
    if (q.text.trim()) {
      quoted = { text: stripBot(q.text, botIds), senderId: quotedParticipant };
      mentioned.push(...uniqueIds(q.context?.mentionedJid ?? []).filter((j) => !mentioned.includes(j)));
    }
  }

  const senderIds = uniqueIds([msg.key.participant, msg.key.participantAlt]);
  if (senderIds.length === 0) return null;

  return {
    messageId: msg.key.id ?? '',
    groupId,
    senderIds,
    pushName: msg.pushName ?? undefined,
    text: stripBot(text, botIds),
    mentionedJids: mentioned.filter((j) => !bots.has(j)),
    quotedMessageId: context?.stanzaId ?? undefined,
    isReplyToBot,
    quoted,
    mentionsBot,
    timestamp: new Date(toNumber(msg.messageTimestamp) * 1000 || Date.now()),
  };
}

/** Removes "@<bot>" tokens for every bot identity (phone number and LID). Keeps line breaks (pasted lists). */
function stripBot(text: string, botIds: string[]): string {
  let stripped = text;
  for (const id of botIds) stripped = stripped.replaceAll(`@${jidUser(id)}`, ' ');
  return collapseSpaces(stripped);
}

/** Collapses spaces within each line and drops blank lines, keeping the line structure. */
export function collapseSpaces(text: string): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function participantIds(p: ParticipantInfo): string[] {
  return uniqueIds([p.id, p.lid, p.phoneNumber]);
}

/** Finds the participant record for any of the given IDs (LID or phone-number JID). */
export function findParticipant(participants: ParticipantInfo[], ids: string[]): ParticipantInfo | undefined {
  const wanted = new Set(ids);
  return participants.find((p) => participantIds(p).some((id) => wanted.has(id)));
}

/** Stage 2: completes the message with admin status and LID/phone-number aliases from group metadata. */
export function toIncoming(raw: RawIncoming, participants: ParticipantInfo[]): IncomingMessage {
  const sender = findParticipant(participants, raw.senderIds);
  const [senderId, ...rest] = raw.senderIds;
  const senderAltIds = uniqueIds([...rest, ...(sender ? participantIds(sender) : [])]).filter((id) => id !== senderId);

  const mentionedUsers: MentionedUser[] = raw.mentionedJids.map((jid) => {
    const p = findParticipant(participants, [jid]);
    return {
      userId: jid,
      altUserIds: p ? participantIds(p).filter((id) => id !== jid) : [],
      displayName: p?.notify ?? undefined,
    };
  });

  let quoted: QuotedMessage | undefined;
  if (raw.quoted) {
    const author = findParticipant(participants, [raw.quoted.senderId]);
    quoted = {
      text: raw.quoted.text,
      senderId: raw.quoted.senderId,
      senderAltIds: author ? participantIds(author).filter((id) => id !== raw.quoted!.senderId) : [],
      senderDisplayName: author?.notify ?? undefined,
    };
  }

  return {
    messageId: raw.messageId,
    groupId: raw.groupId,
    senderId: senderId!,
    senderAltIds,
    senderDisplayName: raw.pushName ?? sender?.notify ?? jidUser(senderId!),
    text: raw.text,
    mentionedUserIds: mentionedUsers.map((m) => m.userId),
    mentionedUsers,
    quotedMessageId: raw.quotedMessageId,
    isReplyToBot: raw.isReplyToBot,
    quoted,
    mentionsBot: raw.mentionsBot,
    isFromAdmin: sender?.admin === 'admin' || sender?.admin === 'superadmin',
    timestamp: raw.timestamp,
  };
}

/** Normalises group-participants.update entries, which may be JID strings or participant objects. */
export function participantEventIds(participants: unknown[]): string[] {
  return uniqueIds(
    participants.flatMap((p) => {
      if (typeof p === 'string') return [p];
      if (p && typeof p === 'object') {
        const o = p as ParticipantInfo;
        return [o.id, o.lid, o.phoneNumber];
      }
      return [];
    }),
  );
}
