import type { Logger } from '../logger.js';

export type AlertOwner = (text: string) => Promise<void>;

/**
 * Notifies the operator when the bot needs attention (e.g. WhatsApp logged it out).
 * With ALERT_WEBHOOK_URL set, POSTs {"text": "..."} as JSON (works with Slack/Discord-style
 * webhooks or a small relay to Telegram/email). Without it, alerts are only logged.
 */
export function createAlerter(webhookUrl: string | undefined, logger: Logger): AlertOwner {
  return async (text: string) => {
    logger.error({ alert: text }, 'Owner alert');
    if (!webhookUrl) return;
    try {
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) logger.error({ status: res.status }, 'Alert webhook returned an error');
    } catch (err) {
      logger.error({ err }, 'Alert webhook failed');
    }
  };
}
