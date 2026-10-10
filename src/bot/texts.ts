import { DateTime } from 'luxon';
import type { Reminder } from '../db/schema.js';
import { describeOffsets, describeWhen, formatDay, sanitizeText, tzAbbrev } from '../reminders/format.js';
import { toIsoLocal } from '../scheduler/scheduler.js';

export const UNDO_MINUTES = 5;

function tzLabel(timezone: string, now: Date): string {
  return `${timezone} (${tzAbbrev(DateTime.fromJSDate(now).setZone(timezone))})`;
}

/** Posted when the bot is added to a group. Kept under ~100 words. */
export function introText(botName: string, timezone: string, now: Date): string {
  const at = `@${botName}`;
  return [
    `👋 Hi everyone, I'm ${botName}! I post reminders in this group. Mention me to set one:`,
    `• ${at} meeting at 11am this Sunday, send a 5 min reminder`,
    `• ${at} 12 Oct is @John's birthday`,
    `• ${at} every first Saturday remind us to pay dues at 9am`,
    `• ${at} what reminders do we have?`,
    `Cancel with "${at} cancel #2". Times are in ${tzLabel(timezone, now)}; change it with "${at} set timezone to Europe/London".`,
  ].join('\n');
}

export function helpText(botName: string, timezone: string, now: Date): string {
  const at = `@${botName}`;
  return [
    `I post reminders in this group. Mention me with what you need:`,
    `• Create: "${at} remind us about choir practice Saturday 4pm, 30 min before too"`,
    `• Birthdays: "${at} 12 Oct is @John's birthday"`,
    `• Repeat: "${at} every Monday at 6am remind us to send reports"`,
    `• List: "${at} what reminders do we have?"`,
    `• Change: "${at} move #3 to 5pm" · Cancel: "${at} cancel #3"`,
    `• Reply "undo" to my confirmation within ${UNDO_MINUTES} minutes to undo it.`,
    `Admins: "${at} only admins can set reminders". Timezone: ${tzLabel(timezone, now)}; change with "${at} set timezone to Europe/London".`,
  ].join('\n');
}

type Schedulable = Pick<Reminder, 'startLocal' | 'rrule' | 'timezone' | 'offsetsMinutes' | 'title' | 'shortId' | 'kind'>;

function scheduleDetails(r: Schedulable, nextEvent: Date | null): string {
  const sched = { startLocal: toIsoLocal(r.startLocal), rrule: r.rrule, timezone: r.timezone, offsetsMinutes: r.offsetsMinutes };
  const parts = [`${sanitizeText(r.title)} (#${r.shortId}), ${describeWhen(sched)}.`];
  if (r.rrule && nextEvent) parts.push(`Next: ${formatDay(DateTime.fromJSDate(nextEvent).setZone(r.timezone))}.`);
  const onlyAtTime = r.offsetsMinutes.length === 1 && r.offsetsMinutes[0] === 0;
  if (!onlyAtTime || !r.rrule) {
    if (!(r.kind === 'birthday' || r.kind === 'anniversary') || !onlyAtTime) parts.push(describeOffsets(sched));
  }
  return parts.join(' ');
}

export function createdConfirmation(r: Schedulable, nextEvent: Date | null, subjectName: string | null): string {
  const greeting =
    r.kind === 'birthday'
      ? ` I'll wish ${subjectName ? sanitizeText(subjectName, 40) : 'them'} a happy birthday here.`
      : r.kind === 'anniversary'
        ? ` I'll post anniversary wishes here.`
        : '';
  return `Got it: ${scheduleDetails(r, nextEvent)}${greeting} Reply "undo" within ${UNDO_MINUTES} minutes to cancel.`;
}

export function editedConfirmation(r: Schedulable, nextEvent: Date | null): string {
  return `Updated: ${scheduleDetails(r, nextEvent)} Reply "undo" within ${UNDO_MINUTES} minutes to revert.`;
}

export function cancelledConfirmation(r: Pick<Reminder, 'title' | 'shortId'>): string {
  return `Cancelled #${r.shortId} ${sanitizeText(r.title)}. Reply "undo" within ${UNDO_MINUTES} minutes to restore it.`;
}

export const UNAVAILABLE_TEXT = "Sorry, I can't process requests right now. Please try again in a few minutes.";
