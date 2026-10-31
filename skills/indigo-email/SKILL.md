---
name: indigo-email
description: This skill should be used when the user asks to "send an email", "add an email template", "set up the email queue", "queue an email", "add a new email type", "migrate from sendEmail to queueEmail", "set up Cloudflare Email Service", "onboard an email sending domain", "set up Cloudflare Queues for email", "debug email delivery", or works with email in Indigo stack projects.
---

# Email Queue System

Indigo stack projects use an asynchronous email queue powered by Cloudflare Queues. Email rendering and delivery happen in a dedicated worker with its own CPU budget — they never block user requests.

## Architecture

```
User Request → Main App → queueEmail() → Cloudflare Queue → Email Worker → CF Email Service binding
                                    (instant)            (async)
```

The email worker: renders the React Email template (HTML + plain-text alternative), sends via the Cloudflare Email Service `send_email` binding, acks failures caused by the message itself immediately (bad payload, suppressed or disallowed recipient), retries all other failures (exponential backoff: 60s / 120s / 240s, max 3 retries), and the queue moves messages that run out of retries to the dead letter queue. Domain, account, and daily-quota errors take the retry path on purpose, so the messages wait in the DLQ for a replay after the fix instead of being dropped.

In local development, `queueEmail()` logs to console instead of queuing — no queue setup needed locally.

## Queuing Emails

Import `queueEmail` from `@/lib/email`:

```typescript
import {queueEmail} from "@/lib/email";

// Basic
await queueEmail(
  "user@example.com",
  {type: "welcome", props: {name: "John"}},
  env
);

// With locale
await queueEmail(
  "user@example.com",
  {type: "email-verification", props: {name: "John", url: verificationUrl}},
  env,
  {locale: "ja"}
);

// With custom subject
await queueEmail(to, {type: "custom", props: {html: "<p>…</p>"}}, env, {
  subject: "Custom Subject"
});
```

Always pass `locale` from the user object or request headers so emails arrive in the user's language.

## Available Templates

All templates support `en` and `ja` locales:

| Type                 | Required props                                   |
| -------------------- | ------------------------------------------------ |
| `email-verification` | `name: string, url: string`                      |
| `password-reset`     | `name: string, resetLink: string`                |
| `account-deleted`    | `name: string`                                   |
| `welcome`            | `name: string`                                   |
| `custom`             | `html: string, title?: string, preview?: string` |

## Adding a New Template

1. Create a React Email component in `src/components/email/`.
2. Add the template type and props to the `EmailTemplate` union in `src/lib/email-queue.ts`.
3. Add a `case` to the worker's switch statement in `workers/indigo-email-queue-consumer/src/index.ts`.
4. Add translation strings for the subject line to `src/translations/en.json` and `src/translations/ja.json`.
5. Test with `pnpm preview-email`.

## Initial Setup

Run once per deployment environment:

```bash
# 1. Create queues (primary + dead letter)
pnpm queue:create

# 2. Install worker deps
cd workers/indigo-email-queue-consumer && pnpm install && cd ../..

# 3. Regenerate Cloudflare types (adds EMAIL_QUEUE binding)
pnpm cf-types

# 4. Onboard the sending domain (dashboard, one-time):
#    Compute → Email Service → Email Sending → Onboard Domain.
#    Cloudflare adds SPF/DKIM + bounce MX records on the cf-bounce
#    subdomain and a DMARC record at _dmarc on the root domain.
#    Requires Workers Paid + Cloudflare DNS.
#    See docs/email-cf-migration.md for the full runbook.

# 5. Deploy worker (before main app)
pnpm email-worker:deploy
```

No email API key or secret is needed — the `send_email` binding
authenticates as the Cloudflare account.

## Configuration

### Main app `wrangler.jsonc`

```jsonc
{
  "queues": {
    "producers": [{"binding": "EMAIL_QUEUE", "queue": "indigo-email-queue"}]
  },
  "vars": {
    "SEND_EMAIL_FROM": "Your App <noreply@yourdomain.com>"
  },
  // The consumer sends through env.EMAIL. Without this binding every send
  // fails and retries into the DLQ. Keep allowed_sender_addresses in sync
  // with the address in SEND_EMAIL_FROM.
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["noreply@yourdomain.com"]
    }
  ]
}
```

### Worker `workers/indigo-email-queue-consumer/wrangler.jsonc`

```jsonc
{
  "name": "indigo-email-queue-consumer",
  "queues": {
    "consumers": [
      {
        "queue": "indigo-email-queue",
        "max_batch_size": 10,
        "max_batch_timeout": 30,
        "max_retries": 3,
        "dead_letter_queue": "indigo-email-queue-dlq"
      }
    ]
  },
  "vars": {
    "SEND_EMAIL_FROM": "Your App <noreply@yourdomain.com>"
  },
  // The consumer sends through env.EMAIL. Without this binding every send
  // fails and retries into the DLQ. Keep allowed_sender_addresses in sync
  // with the address in SEND_EMAIL_FROM.
  "send_email": [
    {
      "name": "EMAIL",
      "allowed_sender_addresses": ["noreply@yourdomain.com"]
    }
  ]
}
```

## Local Development with Full Queue

To test the actual queue flow locally, run both servers:

```bash
# Terminal 1
pnpm dev

# Terminal 2
pnpm email-worker:dev
```

Without Terminal 2, `queueEmail()` still works — it just logs to console.

## Monitoring

```bash
# Stream live worker logs
wrangler tail indigo-email-queue-consumer

# Inspect dead letter queue
wrangler queues consumer view indigo-email-queue-dlq
```

Queue metrics (messages in queue, throughput, latency, failures) are visible in the Cloudflare dashboard under **Workers & Pages → Queues → indigo-email-queue**.

## Migrating from `sendEmail()`

Replace synchronous sends with queued sends — the worker handles rendering:

```typescript
// Before
import {sendEmail} from "@/lib/email";
import {render} from "@react-email/render";
import WelcomeEmail from "@/components/email/WelcomeEmail";

await sendEmail(to, "Welcome!", await render(WelcomeEmail({name})), env);

// After
import {queueEmail} from "@/lib/email";

await queueEmail(to, {type: "welcome", props: {name}}, env, {locale: "en"});
```

Remove all `render()` calls — that work moves to the worker.

## Troubleshooting

| Problem                         | Check                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker deploy fails             | `send_email` binding present in `workers/indigo-email-queue-consumer/wrangler.jsonc`?                                                                           |
| `E_SENDER_NOT_VERIFIED` errors  | Sender domain onboarded for Email Sending? `SEND_EMAIL_FROM` domain matches onboarding?                                                                         |
| Emails queued but not delivered | Worker deployed? Sender domain onboarded? Run `wrangler tail`; check Email Sending activity log                                                                 |
| Messages accumulating in DLQ    | Worker logs for error details; bad-payload and suppressed-recipient failures are acked and logged; transient, domain, account, and quota failures reach the DLQ |
| Main app hitting CPU limits     | Verify `queueEmail()` used everywhere, not `sendEmail()`                                                                                                        |
