/**
 * Send emails through the Cloudflare Email Service `send_email` binding.
 *
 * No API key is involved: the binding authenticates as the Cloudflare
 * account, and the sender address (SEND_EMAIL_FROM) must belong to a domain
 * onboarded for Email Sending in the dashboard
 * (Compute → Email Service → Email Sending → Onboard Domain).
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

/**
 * Error codes thrown by the Email Sending binding that retrying cannot fix.
 * Payload problems, suppressed recipients, and account/domain issues are
 * permanent for this message, and an exhausted daily quota will not clear
 * within the queue's 30s/60s/120s retry backoff — acking keeps the retry
 * budget and the dead letter queue meaningful for genuinely transient
 * failures.
 */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  "E_DAILY_LIMIT_EXCEEDED"
]);

/**
 * Decide what the queue consumer should do with a send error:
 * "ack" — permanent failure, log it and give up;
 * "retry" — transient (or unknown), worth another attempt.
 */
export function classifyEmailSendError(error: unknown): "ack" | "retry" {
  const code = (error as {code?: unknown} | null)?.code;
  return typeof code === "string" && NON_RETRYABLE_CODES.has(code)
    ? "ack"
    : "retry";
}

/** Parse "Name <addr>" into the binding's {email, name} shape. */
export function parseFromAddress(from?: string): EmailAddress {
  const value = from || "Indigo Stack <noreply@indigo.example>";
  const match = value.match(/^(.+?)\s*<(.+?)>$/);

  return match
    ? {name: match[1].trim(), email: match[2].trim()}
    : {name: "Indigo Stack", email: value};
}

export async function sendEmailWithCloudflare(
  email: SendEmail,
  message: OutgoingEmail,
  sendEmailFrom?: string
): Promise<EmailSendResult> {
  return email.send({
    to: message.to,
    from: parseFromAddress(sendEmailFrom),
    subject: message.subject,
    html: message.html,
    ...(message.text ? {text: message.text} : {})
  });
}
