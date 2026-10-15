import type { ParsedCommand } from './schema.js';

export interface ParserMentionedUser {
  id: string;
  altIds?: string[];
  name?: string;
  /** How the mention appears in the message text, e.g. "@2348012345678". */
  token: string;
}

export interface ParserReminderSummary {
  shortId: number;
  title: string;
  kind: string;
  when: string;
}

export interface ParserInput {
  text: string;
  sender: { id: string; name: string };
  timezone: string;
  /** How the group writes numeric dates (default DMY). */
  dateFormat?: 'DMY' | 'MDY';
  now: Date;
  mentionedUsers: ParserMentionedUser[];
  activeReminders?: ParserReminderSummary[];
  /** Someone's post the sender replied to while mentioning the bot; it usually holds the reminder. */
  quoted?: { text: string; author: { id: string; name: string } };
  /** The clarifying question this message is probably answering. */
  pending?: { question: string; originalText: string };
}

export interface Parser {
  parseCommand(input: ParserInput): Promise<ParsedCommand>;
}

/** Thrown when the LLM can't be reached; the bot replies with a "try again later" message. */
export class ParserUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ParserUnavailableError';
  }
}
