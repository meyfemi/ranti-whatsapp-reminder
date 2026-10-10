import { DateTime } from 'luxon';
import type { Reminder } from '../db/schema.js';
import { formatDuration, formatTime, sanitizeText } from '../reminders/format.js';
import type { Greeter } from './greetings.js';

export interface OutgoingReminder {
  text: string;
  mentionUserIds: string[];
}

export interface BuildMessageInput {
  reminder: Reminder;
  offsetMinutes: number;
  fireAt: Date;
  /** Platform user ID of the subject member, if any. */
  subjectUserId: string | null;
  subjectDisplayName: string | null;
  late: boolean;
  formatMention: (userId: string) => string;
  greeter: Greeter;
}

/** Builds the text of a due reminder. Only ever mentions the reminder's subject. */
export async function buildReminderMessage(input: BuildMessageInput): Promise<OutgoingReminder> {
  const { reminder: r, offsetMinutes } = input;
  const title = sanitizeText(r.title);
  const eventLocal = DateTime.fromJSDate(input.fireAt).setZone(r.timezone).plus({ minutes: offsetMinutes });
  const mentionUserIds = input.subjectUserId ? [input.subjectUserId] : [];
  const subjectToken = input.subjectUserId ? input.formatMention(input.subjectUserId) : null;
  const lateNote = input.late ? ' (slightly late)' : '';

  let text: string;
  if ((r.kind === 'birthday' || r.kind === 'anniversary') && offsetMinutes === 0) {
    text = await input.greeter.greet({
      kind: r.kind,
      subject: subjectToken,
      title,
      style: r.messageStyle ? sanitizeText(r.messageStyle, 200) : null,
    });
  } else if (r.kind === 'birthday' || r.kind === 'anniversary') {
    const when = describeLead(offsetMinutes, eventLocal);
    const who = subjectToken ? ` (${subjectToken})` : '';
    text = `📅 Heads up: ${title}${who} is ${when}.`;
  } else if (offsetMinutes === 0) {
    text =
      r.kind === 'event'
        ? `⏰ Reminder: ${title} is starting now (${formatTime(eventLocal)}).`
        : `⏰ Reminder: ${title}.`;
  } else {
    text = `⏰ Reminder: ${title} starts in ${formatDuration(offsetMinutes)} (${describeClock(offsetMinutes, eventLocal)}).`;
  }

  // Defence in depth: never mention anyone other than the subject.
  if (subjectToken && !text.includes(subjectToken)) mentionUserIds.length = 0;
  return { text: `${text}${lateNote}`, mentionUserIds };
}

function describeClock(offsetMinutes: number, eventLocal: DateTime): string {
  return offsetMinutes >= 1440 ? `${eventLocal.setLocale('en-GB').toFormat('ccc d LLL')}, ${formatTime(eventLocal)}` : formatTime(eventLocal);
}

function describeLead(offsetMinutes: number, eventLocal: DateTime): string {
  if (offsetMinutes % 1440 === 0 && offsetMinutes >= 1440) {
    const days = offsetMinutes / 1440;
    return days === 1 ? 'tomorrow' : `in ${days} days (${eventLocal.setLocale('en-GB').toFormat('ccc d LLL')})`;
  }
  return `in ${formatDuration(offsetMinutes)}`;
}
