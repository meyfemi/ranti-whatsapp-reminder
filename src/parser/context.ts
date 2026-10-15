import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DateTime } from 'luxon';
import type { ParserInput } from './types.js';

const PROMPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'system-prompt.md');

export function loadSystemPrompt(botName: string): string {
  return readFileSync(PROMPT_PATH, 'utf8').replaceAll('{{BOT_NAME}}', botName);
}

/** The per-message user turn: a JSON context block followed by the raw message. */
export function buildUserContent(input: ParserInput): string {
  const now = DateTime.fromJSDate(input.now).setZone(input.timezone).setLocale('en-GB');
  const context = {
    now_local: now.toFormat("cccc yyyy-MM-dd'T'HH:mm"),
    timezone: input.timezone,
    sender: input.sender,
    mentioned_users: input.mentionedUsers.map((u) => ({ id: u.id, token: u.token, name: u.name ?? null })),
    active_reminders: (input.activeReminders ?? []).map((r) => ({
      short_id: r.shortId,
      title: r.title,
      kind: r.kind,
      schedule: r.when,
    })),
    ...(input.pending
      ? { pending_question: { question: input.pending.question, original_message: input.pending.originalText } }
      : {}),
  };
  const quoted = input.quoted
    ? `<quoted_message author_id="${input.quoted.author.id}" author_name="${input.quoted.author.name.replace(/["<>]/g, '')}">\n${input.quoted.text}\n</quoted_message>\n\n`
    : '';
  return `<context>\n${JSON.stringify(context, null, 2)}\n</context>\n\n${quoted}<message>\n${input.text}\n</message>`;
}

/** IDs a `subject_user_id` may legitimately take: mentioned users (all known IDs), the sender and the quoted post's author. */
export function allowedSubjectIds(input: ParserInput): string[] {
  return [
    input.sender.id,
    ...input.mentionedUsers.flatMap((u) => [u.id, ...(u.altIds ?? [])]),
    ...(input.quoted ? [input.quoted.author.id] : []),
  ];
}
