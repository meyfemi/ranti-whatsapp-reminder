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
import type { Group, MemberRow, PendingInteraction } from '../db/schema.js';
import type { Logger } from '../logger.js';
import type { ParsedCommand } from '../parser/schema.js';
import { ParserUnavailableError, type Parser, type ParserMentionedUser } from '../parser/types.js';
import { describeWhen, sanitizeText } from '../reminders/format.js';
import type { ReminderService } from '../reminders/service.js';
import type { ActorContext } from '../reminders/types.js';
import type { Clock } from '../scheduler/clock.js';
import { toIsoLocal } from '../scheduler/scheduler.js';
import { createdConfirmation, helpText, introText, UNAVAILABLE_TEXT, UNDO_MINUTES } from './texts.js';

export interface BotOptions {
  platform: string;
  botName: string;
  defaultTimezone: string;
}

const CLARIFY_MINUTES = 10;

export type UndoPayload = { op: 'create'; reminderId: number };
export type ClarifyPayload = { question: string; originalText: string };

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

    const [undo, clarify] = await Promise.all([
      findActiveInteraction(this.db, group.id, member.id, 'undo', now),
      findActiveInteraction(this.db, group.id, member.id, 'clarify', now),
    ]);

    const text = msg.text.trim();
    if (isUndo(text)) {
      // Unmentioned "undo" replies are only answered when there is something to undo.
      if (!msg.mentionsBot && !undo) return;
      return this.handleUndo(msg, actor, undo);
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
      default:
        return this.reply(msg, "Sorry, I can't do that yet.");
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
    const nextEvent = occurrences.length
      ? new Date(Math.min(...occurrences.map((o) => o.fireAt.getTime() + o.offsetMinutes * 60_000)))
      : null;
    const subjectName = subject?.lastKnownDisplayName ?? (subject ? 'them' : null);
    await this.reply(msg, createdConfirmation(reminder, nextEvent, subjectName));
  }

  private async handleUndo(msg: IncomingMessage, actor: ActorContext, undo: PendingInteraction | undefined): Promise<void> {
    if (!undo) return this.reply(msg, `There's nothing to undo (undo works for ${UNDO_MINUTES} minutes after a change).`);
    await deleteInteraction(this.db, undo.id);
    const payload = undo.payload as UndoPayload;
    if (payload.op === 'create') {
      const r = await this.reminders.cancel(actor, payload.reminderId, { bypassPermissions: true });
      return this.reply(msg, r.ok ? `Undone: removed #${r.value.shortId} ${sanitizeText(r.value.title)}.` : r.error);
    }
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
