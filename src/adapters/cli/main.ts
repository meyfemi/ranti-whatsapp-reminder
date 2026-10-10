// Milestone 1: an echo bot over the CLI simulator. Replaced by the full app wiring later.
import { loadConfig } from '../../config.js';
import { CliAdapter } from './cli-adapter.js';

const config = loadConfig({ ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? 'unused' });
const adapter = new CliAdapter({ botName: config.BOT_NAME });
adapter.onMessage(async (msg) => {
  if (!msg.mentionsBot && !msg.isReplyToBot) return;
  await adapter.sendText(msg.groupId, `You said: ${msg.text}`);
});
await adapter.start();
