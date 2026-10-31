import type {EmailQueueMessage} from "@app/lib/email-queue";
import {renderEmailTemplate} from "./render-template";
import {
  classifyEmailSendError,
  isEmailAddress,
  parseFromAddress,
  sendEmailWithCloudflare
} from "./send-email";

export interface Env {
  /**
   * Cloudflare Email Service binding. The domain of SEND_EMAIL_FROM must be
   * onboarded for Email Sending in the Cloudflare dashboard before this
   * worker can send (see docs/email-cf-migration.md).
   */
  EMAIL: SendEmail;
  SEND_EMAIL_FROM: string;
}

function retryWithBackoff(message: Message<EmailQueueMessage>): void {
  message.retry({delaySeconds: 30 * Math.pow(2, message.attempts)});
}

export default {
  async queue(batch: MessageBatch<EmailQueueMessage>, env: Env): Promise<void> {
    const from = parseFromAddress(env.SEND_EMAIL_FROM);

    if (!isEmailAddress(from.email)) {
      // The binding would reject a malformed sender as E_VALIDATION_ERROR,
      // which acks (drops) the message. The fault is in the configuration,
      // not the messages, so retry them into the DLQ for a replay once
      // SEND_EMAIL_FROM is fixed.
      console.error(
        `❌ SEND_EMAIL_FROM is not a valid address (${JSON.stringify(env.SEND_EMAIL_FROM)}), retrying the batch`
      );
      batch.messages.forEach(retryWithBackoff);
      return;
    }

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
          from
        );

        message.ack();
        console.log(`✅ Email sent successfully to ${to}`);
      } catch (error) {
        if (classifyEmailSendError(error) === "ack") {
          // Permanent failure of this message: bad payload or a suppressed
          // or disallowed recipient. Retrying or replaying identical bytes
          // cannot succeed, so keep the retry budget and DLQ for errors
          // that can clear.
          console.error(
            `⛔ Permanent send failure for ${to} (template: ${template.type}), not retrying:`,
            error
          );
          message.ack();
          continue;
        }

        console.error(`❌ Failed to process email for ${to}:`, error);
        retryWithBackoff(message);
      }
    }
  }
};
