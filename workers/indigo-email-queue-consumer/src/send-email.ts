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
 * Error codes thrown by the Email Sending binding that no retry or replay can
 * fix, because the fault is in this message: a bad payload or a suppressed or
 * disallowed recipient.
 *
 * Account, domain, and quota errors (E_SENDER_NOT_VERIFIED,
 * E_SENDER_DOMAIN_NOT_AVAILABLE, E_ACCOUNT_SUSPENDED, E_DAILY_LIMIT_EXCEEDED)
 * are deliberately absent. They hit every message alike and clear once the
 * dashboard or quota is fixed, so they retry into the dead letter queue,
 * where the messages wait for a replay instead of being dropped.
 */
const NON_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_CONTENT_TOO_LARGE",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY"
]);

/**
 * Decide what the queue consumer should do with a send error:
 * "ack" — the message itself is undeliverable, log it and give up;
 * "retry" — transient, account-wide, or unknown, worth another attempt and
 * a dead letter queue entry if the retries run out.
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
