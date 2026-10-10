import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from '../types.js';
import { CliAdapter } from './cli-adapter.js';

function setup() {
  const out = new PassThrough();
  let printed = '';
  out.on('data', (d) => (printed += String(d)));
  const adapter = new CliAdapter({ botName: 'Ranti', output: out });
  const received: IncomingMessage[] = [];
  adapter.onMessage(async (m) => {
    received.push(m);
  });
  return { adapter, received, printed: () => printed };
}

describe('CliAdapter', () => {
  it('detects and strips the bot mention and resolves user mentions', async () => {
    const { adapter, received } = setup();
    await adapter.handleLine("@Ranti remember 12 Oct is @john's birthday");
    expect(received).toHaveLength(1);
    const m = received[0]!;
    expect(m.mentionsBot).toBe(true);
    expect(m.text).toBe("remember 12 Oct is @john's birthday");
    expect(m.mentionedUserIds).toEqual(['cli:john']);
    expect(m.senderId).toBe('cli:alice');
    expect(m.isFromAdmin).toBe(true);
  });

  it('switches users and marks replies to the bot', async () => {
    const { adapter, received } = setup();
    await adapter.sendText('cli-group:family', 'hello');
    await adapter.handleLine('/as bola');
    await adapter.handleLine('/reply undo');
    const m = received[0]!;
    expect(m.senderId).toBe('cli:bola');
    expect(m.isFromAdmin).toBe(false);
    expect(m.isReplyToBot).toBe(true);
    expect(m.mentionsBot).toBe(false);
    expect(m.quotedMessageId).toBeDefined();
  });

  it('delivers unmentioned chatter with mentionsBot=false', async () => {
    const { adapter, received } = setup();
    await adapter.handleLine('just chatting');
    expect(received[0]!.mentionsBot).toBe(false);
  });

  it('runs registered commands', async () => {
    const { adapter } = setup();
    let got: string[] = [];
    adapter.registerCommand('advance', 'advance clock', (args) => {
      got = args;
    });
    await adapter.handleLine('/advance 2h');
    expect(got).toEqual(['2h']);
  });
});
