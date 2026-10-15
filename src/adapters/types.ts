/**
 * Platform-agnostic chat adapter. Nothing outside src/adapters/whatsapp may import Baileys;
 * everything else talks to a ChatAdapter.
 */

export interface Member {
  /** Stable platform user ID (on WhatsApp: a phone-number JID or a LID). */
  userId: string;
  /** Other IDs that refer to the same person (e.g. the LID for a phone-number JID). */
  altUserIds: string[];
  displayName?: string;
  isAdmin: boolean;
}

export interface MentionedUser {
  userId: string;
  altUserIds: string[];
  displayName?: string;
}

/** Someone else's post that a message replies to (never one of the bot's own messages). */
export interface QuotedMessage {
  text: string;
  senderId: string;
  senderAltIds: string[];
  senderDisplayName?: string;
}

export interface IncomingMessage {
  /** Platform message ID. */
  messageId: string;
  groupId: string;
  senderId: string;
  /** Other IDs for the sender (e.g. LID <-> phone-number JID). */
  senderAltIds: string[];
  senderDisplayName: string;
  /** Message text with the bot mention stripped. */
  text: string;
  /** Users mentioned in the message or in the post it quotes, excluding the bot. */
  mentionedUserIds: string[];
  mentionedUsers: MentionedUser[];
  /** ID of the message being replied to, if this is a reply. */
  quotedMessageId?: string;
  /** True when the quoted message was sent by the bot. */
  isReplyToBot: boolean;
  /** The quoted post, when this replies to someone other than the bot (e.g. "@bot" under "meet at 7pm Friday"). */
  quoted?: QuotedMessage;
  /** True when the bot was @mentioned. */
  mentionsBot: boolean;
  isFromAdmin: boolean;
  timestamp: Date;
}

export interface ChatAdapter {
  start(): Promise<void>;
  stop?(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => Promise<void>): void;
  onBotAddedToGroup(handler: (groupId: string) => Promise<void>): void;
  /** Optional: the bot was removed from a group (its reminders stop firing there). */
  onBotRemovedFromGroup?(handler: (groupId: string) => Promise<void>): void;
  sendText(groupId: string, text: string, mentionUserIds?: string[]): Promise<void>;
  getGroupMembers(groupId: string): Promise<Member[]>;
  /**
   * The text token that renders as a mention of userId on this platform
   * (e.g. "@2348012345678" on WhatsApp). Text passed to sendText must contain
   * this token for every ID in mentionUserIds.
   */
  formatMention(userId: string): string;
  /** Human-readable group name, if known. */
  getGroupName?(groupId: string): Promise<string | undefined>;
}
