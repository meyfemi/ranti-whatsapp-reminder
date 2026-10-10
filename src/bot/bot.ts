import type { ChatAdapter, IncomingMessage } from '../adapters/types.js';
import type { Db } from '../db/client.js';
import {
  createInteraction,
  deleteInteraction,
  findActiveInteraction,
  getMember,
  listActiveReminders,
  updateGroup,
  upsertGroup,
  upsertMember,
} from '../db/repositories.js';
import type { Group, MemberRow, PendingInteraction, Reminder } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { ParsedCommand, ReminderTarget } from '../parser/schema.js';
import { ParserUnavailableError, type Parser, type ParserMentionedUser } from '../parser/types.js';
import { describeWhen, formatDay, sanitizeText, tzAbbrev } from '../reminders/format.js';
import { resolveTarget } from '../reminders/target.js';
import type { ReminderChanges, ReminderService, ReminderSnapshot } from '../reminders/service.js';
import type { ActorContext } from '../reminders/types.js';
import type { Clock } from '../scheduler/clock.js';
import { toIsoLocal } from '../scheduler/scheduler.js';
import { DateTime } from 'luxon';
import {
  cancelledConfirmation,
  createdConfirmation,
  editedConfirmation,
  helpText,
  introText,
  listText,
  UNAVAILABLE_TEXT,
  UNDO_MINUTES,
} from './texts.js';

export interface BotOptions {
  platform: string;
  botName: string;
  defaultTimezone: string;
}

const CLARIFY_MINUTES = 10;

export type UndoPayload =
  | { op: 'create'; reminderId: number }
  | { op: 'cancel'; reminderId: number }
  | { op: 'edit'; reminderId: number; before: ReminderSnapshot };
export type ClarifyPayload = { question: string; originalText: string };
export type ChoosePayload =
  | { op: 'cancel'; candidates: number[] }
  | { op: 'edit'; candidates: number[]; changes: ReminderChanges };

const isUndo = (text: string) => /^undo[.!]*$/i.test(text.trim());

/**
 * Turns incoming group messages into actions. Only messages that @mention the bot, or replies to
 * the bot from someone with an open interaction (undo window / clarifying question), are handled;
 * everything else is ignored without calling the LLM.
 */
export class Bot {
  constructor(
    private readonly db: Db,
    private readonly adapter: ChatAdapter,
    private readonly parser: Parser,
    private readonly reminders: ReminderService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly opts: BotOptions,
  ) {}

  attach(): void {
    this.adapter.onMessage((msg) => this.handleMessage(msg));
    this.adapter.onBotAddedToGroup((groupId) => this.handleAddedToGroup(groupId));
    this.adapter.onBotRemovedFromGroup?.((groupId) => this.handleRemovedFromGroup(groupId));
  }

  /** Marks the group inactive so its reminders are skipped instead of failing to send. */
  async handleRemovedFromGroup(platformGroupId: string): Promise<void> {
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId,
      defaultTimezone: this.opts.defaultTimezone,
    });
    await updateGroup(this.db, group.id, { active: false });
    this.logger.info({ groupId: group.id }, 'Bot removed from group; group deactivated');
  }

  async handleAddedToGroup(platformGroupId: string): Promise<void> {
    const name = await this.adapter.getGroupName?.(platformGroupId).catch(() => undefined);
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId,
      name,
      defaultTimezone: this.opts.defaultTimezone,
    });
    if (!group.active) await updateGroup(this.db, group.id, { active: true });
    await this.adapter.sendText(platformGroupId, introText(this.opts.botName, group.timezone, this.clock.now()));
  }

  async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.mentionsBot && !msg.isReplyToBot) return;
    try {
      await this.process(msg);
    } catch (err) {
      this.logger.error({ err, groupId: msg.groupId }, 'Failed to handle message');
      await this.reply(msg, 'Sorry, something went wrong. Please try again.').catch(() => undefined);
    }
  }

  private async process(msg: IncomingMessage): Promise<void> {
    const now = this.clock.now();
    const { group } = await upsertGroup(this.db, {
      platform: this.opts.platform,
      platformGroupId: msg.groupId,
      defaultTimezone: this.opts.defaultTimezone,
    });
    const member = await upsertMember(this.db, group.id, {
      userId: msg.senderId,
      altUserIds: msg.senderAltIds,
      displayName: msg.senderDisplayName,
    });
    const actor: ActorContext = { group, member, isAdmin: msg.isFromAdmin };

    const [undo, clarify, choose] = await Promise.all([
      findActiveInteraction(this.db, group.id, member.id, 'undo', now),
      findActiveInteraction(this.db, group.id, member.id, 'clarify', now),
      findActiveInteraction(this.db, group.id, member.id, 'choose', now),
    ]);

    const text = msg.text.trim();
    if (isUndo(text)) {
      // Unmentioned "undo" replies are only answered when there is something to undo.
      if (!msg.mentionsBot && !undo) return;
      return this.handleUndo(msg, actor, undo);
    }
    if (choose) {
      const picked = /^#?\s*(\d+)[.!]?$/.exec(text);
      if (picked) return this.handleChoice(msg, actor, choose, Number(picked[1]));
      if (/^(no|none|never ?mind|nevermind|stop)[.!]*$/i.test(text)) {
        await deleteInteraction(this.db, choose.id);
        return this.reply(msg, 'OK, nothing changed.');
      }
    }
    // Otherwise, a reply without a mention is only handled as the answer to an open question.
    if (!msg.mentionsBot && !clarify) return;
    if (!text) return this.reply(msg, helpText(this.opts.botName, group.timezone, now));

    const mentioned = await this.upsertMentioned(group, msg);
    const active = await listActiveReminders(this.db, group.id);
    let command: ParsedCommand;
    try {
      command = await this.parser.parseCommand({
        text,
        sender: { id: member.platformUserId, name: msg.senderDisplayName },
        timezone: group.timezone,
        now,
        mentionedUsers: mentioned.map(({ user }) => user),
        activeReminders: active.map((r) => ({
          shortId: r.shortId,
          title: r.title,
          kind: r.kind,
          when: describeWhen({ ...r, startLocal: toIsoLocal(r.startLocal) }),
        })),
        pending: clarify ? (clarify.payload as ClarifyPayload) : undefined,
      });
    } catch (err) {
      if (err instanceof ParserUnavailableError) return this.reply(msg, UNAVAILABLE_TEXT);
      throw err;
    }
    this.logger.debug({ action: command.action, groupId: group.id }, 'Parsed command');

    if (clarify && command.action !== 'clarify') await deleteInteraction(this.db, clarify.id);
    await this.execute(msg, actor, command, { text, clarify, mentioned });
  }

  private async execute(
    msg: IncomingMessage,
    actor: ActorContext,
    command: ParsedCommand,
    ctx: { text: string; clarify: PendingInteraction | undefined; mentioned: { member: MemberRow; ids: string[] }[] },
  ): Promise<void> {
    const now = this.clock.now();
    switch (command.action) {
      case 'create':
        return this.handleCreate(msg, actor, command, ctx.mentioned);
      case 'clarify': {
        const previous = ctx.clarify?.payload as ClarifyPayload | undefined;
        const originalText = previous ? `${previous.originalText}\n(then they said: ${ctx.text})` : ctx.text;
        await createInteraction(this.db, {
          groupId: actor.group.id,
          memberId: actor.member.id,
          kind: 'clarify',
          payload: { question: command.question, originalText } satisfies ClarifyPayload,
          expiresAt: new Date(now.getTime() + CLARIFY_MINUTES * 60_000),
        });
        return this.reply(msg, sanitizeText(command.question, 300));
      }
      case 'help':
        return this.reply(msg, helpText(this.opts.botName, actor.group.timezone, now));
      case 'unsupported':
        return this.reply(msg, sanitizeText(command.reason, 300));
      case 'list':
        return this.reply(msg, listText(await this.reminders.list(actor.group.id), this.opts.botName));
      case 'cancel':
        return this.withTarget(msg, actor, command.target, { op: 'cancel' }, (r) => this.doCancel(msg, actor, r));
      case 'edit': {
        const changes: ReminderChanges = {
          title: command.changes.title,
          startLocal: command.changes.start_local,
          rrule: command.changes.rrule,
          makeOneOff: command.changes.make_one_off,
          offsetsMinutes: command.changes.offsets_minutes,
          messageStyle: command.changes.message_style,
        };
        return this.withTarget(msg, actor, command.target, { op: 'edit', changes }, (r) =>
          this.doEdit(msg, actor, r, changes),
        );
      }
      case 'set_timezone': {
        const res = await this.reminders.setTimezone(actor, command.timezone);
        if (!res.ok) return this.reply(msg, res.error);
        const abbrev = tzAbbrev(DateTime.fromJSDate(now).setZone(command.timezone));
        const kept = res.value.rescheduled ? ' Existing reminders keep their local times.' : '';
        return this.reply(msg, `Timezone set to ${command.timezone} (${abbrev}).${kept}`);
      }
      case 'set_policy': {
        const res = await this.reminders.setPolicy(actor, command.policy);
        if (!res.ok) return this.reply(msg, res.error);
        return this.reply(
          msg,
          command.policy === 'admins' ? 'OK: only group admins can set reminders now.' : 'OK: anyone in the group can set reminders now.',
        );
      }
    }
  }

  private async handleCreate(
    msg: IncomingMessage,
    actor: ActorContext,
    command: Extract<ParsedCommand, { action: 'create' }>,
    mentioned: { member: MemberRow; ids: string[] }[],
  ): Promise<void> {
    let subject: MemberRow | undefined;
    if (command.subject_user_id) {
      const id = command.subject_user_id;
      subject =
        mentioned.find((m) => m.ids.includes(id))?.member ??
        (id === actor.member.platformUserId || actor.member.altUserIds.includes(id) ? actor.member : undefined);
      if (!subject) return this.reply(msg, 'Who is this reminder for? Please @mention them.');
    }
    const result = await this.reminders.create(actor, {
      title: command.title,
      kind: command.kind,
      startLocal: command.start_local,
      rrule: command.rrule,
      offsetsMinutes: command.offsets_minutes,
      subjectMemberId: subject?.id ?? null,
      messageStyle: command.message_style,
    });
    if (!result.ok) return this.reply(msg, result.error);

    const { reminder, occurrences } = result.value;
    await this.openUndoWindow(actor, { op: 'create', reminderId: reminder.id });
    const nextEvent = nextEventOf(occurrences);
    const subjectName = subject?.lastKnownDisplayName ?? (subject ? 'them' : null);
    await this.reply(msg, createdConfirmation(reminder, nextEvent, subjectName));
  }

  private async handleUndo(msg: IncomingMessage, actor: ActorContext, undo: PendingInteraction | undefined): Promise<void> {
    if (!undo) return this.reply(msg, `There's nothing to undo (undo works for ${UNDO_MINUTES} minutes after a change).`);
    await deleteInteraction(this.db, undo.id);
    const payload = undo.payload as UndoPayload;
    switch (payload.op) {
      case 'create': {
        const r = await this.reminders.cancel(actor, payload.reminderId, { bypassPermissions: true });
        return this.reply(msg, r.ok ? `Undone: removed #${r.value.shortId} ${sanitizeText(r.value.title)}.` : r.error);
      }
      case 'cancel': {
        const r = await this.reminders.reactivate(actor, payload.reminderId);
        return this.reply(msg, r.ok ? `Undone: #${r.value.reminder.shortId} ${sanitizeText(r.value.reminder.title)} is back on.` : r.error);
      }
      case 'edit': {
        const r = await this.reminders.restore(actor, payload.reminderId, payload.before);
        if (!r.ok) return this.reply(msg, r.error);
        const next = nextEventOf(r.value.occurrences);
        const when = describeWhen({ ...r.value.reminder, startLocal: toIsoLocal(r.value.reminder.startLocal) });
        const nextText = r.value.reminder.rrule && next ? ` Next: ${formatDay(DateTime.fromJSDate(next).setZone(r.value.reminder.timezone))}.` : '';
        return this.reply(msg, `Undone: #${r.value.reminder.shortId} is back to ${when}.${nextText}`);
      }
    }
  }

  /** Resolves a cancel/edit target; asks "which one?" when it is ambiguous. */
  private async withTarget(
    msg: IncomingMessage,
    actor: ActorContext,
    target: ReminderTarget,
    pending: { op: 'cancel' } | { op: 'edit'; changes: ReminderChanges },
    run: (r: Reminder) => Promise<void>,
  ): Promise<void> {
    const active = (await this.reminders.list(actor.group.id)).map((l) => l.reminder);
    const resolution = resolveTarget(active, target);
    if (resolution.kind === 'none') return this.reply(msg, resolution.message);
    if (resolution.kind === 'found') return run(resolution.reminder);
    await createInteraction(this.db, {
      groupId: actor.group.id,
      memberId: actor.member.id,
      kind: 'choose',
      payload: { ...pending, candidates: resolution.candidates.map((c) => c.id) } satisfies ChoosePayload,
      expiresAt: new Date(this.clock.now().getTime() + CLARIFY_MINUTES * 60_000),
    });
    const options = resolution.candidates.map((c) => `#${c.shortId} ${sanitizeText(c.title)}`).join(', ');
    return this.reply(msg, `Which one do you mean: ${options}? Reply with the number.`);
  }

  private async handleChoice(msg: IncomingMessage, actor: ActorContext, choose: PendingInteraction, shortId: number) {
    const payload = choose.payload as ChoosePayload;
    const active = (await this.reminders.list(actor.group.id)).map((l) => l.reminder);
    const picked = active.find((r) => r.shortId === shortId && payload.candidates.includes(r.id));
    if (!picked) return this.reply(msg, `#${shortId} isn't one of the options. Reply with one of the numbers I listed.`);
    await deleteInteraction(this.db, choose.id);
    return payload.op === 'cancel' ? this.doCancel(msg, actor, picked) : this.doEdit(msg, actor, picked, payload.changes);
  }

  private async doCancel(msg: IncomingMessage, actor: ActorContext, reminder: Reminder): Promise<void> {
    const res = await this.reminders.cancel(actor, reminder.id);
    if (!res.ok) return this.reply(msg, res.error);
    await this.openUndoWindow(actor, { op: 'cancel', reminderId: reminder.id });
    return this.reply(msg, cancelledConfirmation(res.value));
  }

  private async doEdit(msg: IncomingMessage, actor: ActorContext, reminder: Reminder, changes: ReminderChanges) {
    const res = await this.reminders.edit(actor, reminder.id, changes);
    if (!res.ok) return this.reply(msg, res.error);
    await this.openUndoWindow(actor, { op: 'edit', reminderId: reminder.id, before: res.value.before });
    return this.reply(msg, editedConfirmation(res.value.reminder, nextEventOf(res.value.occurrences)));
  }

  private async openUndoWindow(actor: ActorContext, payload: UndoPayload): Promise<void> {
    await createInteraction(this.db, {
      groupId: actor.group.id,
      memberId: actor.member.id,
      kind: 'undo',
      payload,
      expiresAt: new Date(this.clock.now().getTime() + UNDO_MINUTES * 60_000),
    });
  }

  /** Records mentioned users as members and builds the parser's view of them. */
  private async upsertMentioned(
    group: Group,
    msg: IncomingMessage,
  ): Promise<{ member: MemberRow; ids: string[]; user: ParserMentionedUser }[]> {
    const out = [];
    for (const m of msg.mentionedUsers) {
      const member = await upsertMember(this.db, group.id, {
        userId: m.userId,
        altUserIds: m.altUserIds,
        displayName: m.displayName,
      });
      const ids = [member.platformUserId, ...member.altUserIds, m.userId, ...m.altUserIds];
      out.push({
        member,
        ids: [...new Set(ids)],
        user: {
          id: m.userId,
          altIds: [...new Set(ids)].filter((id) => id !== m.userId),
          name: member.lastKnownDisplayName ?? m.displayName,
          token: this.adapter.formatMention(m.userId),
        },
      });
    }
    return out;
  }

  private async reply(msg: IncomingMessage, text: string): Promise<void> {
    await this.adapter.sendText(msg.groupId, text);
  }

  /** Exposed for tests. */
  async memberById(id: number): Promise<MemberRow | undefined> {
    return getMember(this.db, id);
  }
}

function nextEventOf(occurrences: { fireAt: Date; offsetMinutes: number }[]): Date | null {
  if (occurrences.length === 0) return null;
  return new Date(Math.min(...occurrences.map((o) => o.fireAt.getTime() + o.offsetMinutes * 60_000)));
}
