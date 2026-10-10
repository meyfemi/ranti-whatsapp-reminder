import {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidDecode,
  jidNormalizedUser,
} from 'baileys';

/** Strips device suffixes ("123:7@s.whatsapp.net" → "123@s.whatsapp.net"); keeps @lid / @s.whatsapp.net. */
export function normalizeJid(jid: string | null | undefined): string | undefined {
  if (!jid) return undefined;
  const n = jidNormalizedUser(jid);
  return n || undefined;
}

/** The user part of a JID ("2348012345678@s.whatsapp.net" → "2348012345678"). */
export function jidUser(jid: string): string {
  return jidDecode(jid)?.user ?? jid.split('@')[0]!.split(':')[0]!;
}

/** Text token that renders as a mention of this JID. */
export function mentionToken(jid: string): string {
  return `@${jidUser(jid)}`;
}

/** Only real group chats are handled; DMs, broadcast lists, status updates and newsletters are ignored. */
export function isHandledChat(jid: string | null | undefined): jid is string {
  if (!jid) return false;
  if (isJidStatusBroadcast(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)) return false;
  return !!isJidGroup(jid);
}

export function uniqueIds(ids: (string | null | undefined)[]): string[] {
  return [...new Set(ids.map((id) => normalizeJid(id)).filter((id): id is string => !!id))];
}
