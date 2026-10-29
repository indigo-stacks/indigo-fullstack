import type {EmailQueueMessage} from "@app/lib/email-queue";
import {renderEmailTemplate} from "./render-template";
import {classifyEmailSendError, sendEmailWithCloudflare} from "./send-email";

export interface Env {
  /**
   * Cloudflare Email Service binding. The domain of SEND_EMAIL_FROM must be
   * onboarded for Email Sending in the Cloudflare dashboard before this
   * worker can send (see docs/email-cf-migration.md).
   */
  EMAIL: SendEmail;
  SEND_EMAIL_FROM: string;
}

export default {
  async queue(batch: MessageBatch<EmailQueueMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const {to, subject, template, locale, queuedAt} = message.body;

      try {
        console.log(
          `Processing email for ${to} (template: ${template.type}, locale: ${locale}, queued: ${queuedAt})`
        );

        const {html, text} = await renderEmailTemplate(template, locale);
        await sendEmailWithCloudflare(
          env.EMAIL,
          {to, subject, html, text},
          env.SEND_EMAIL_FROM
        );

        message.ack();
        console.log(`✅ Email sent successfully to ${to}`);
      } catch (error) {
        if (classifyEmailSendError(error) === "ack") {
          // Permanent failure: bad payload, suppressed recipient, account or
          // domain problem, or exhausted daily quota. Retrying identical
          // bytes cannot succeed, so keep the retry budget and DLQ for
          // genuinely transient errors.
          console.error(
            `⛔ Permanent send failure for ${to} (template: ${template.type}), not retrying:`,
            error
          );
          message.ack();
          continue;
        }

        console.error(`❌ Failed to process email for ${to}:`, error);
        const retryDelay = 30 * Math.pow(2, message.attempts);
        message.retry({delaySeconds: retryDelay});
      }
    }
  }
};
