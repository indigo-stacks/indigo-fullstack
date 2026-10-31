# Migrating Email Sending from Plunk to Cloudflare Email Service

Research and migration plan. Sources: Cloudflare Email Service docs
([send emails](https://developers.cloudflare.com/email-service/get-started/send-emails/),
[Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/),
[send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/),
[domains](https://developers.cloudflare.com/email-service/configuration/domains/),
[limits](https://developers.cloudflare.com/email-service/platform/limits/),
[pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
[local dev](https://developers.cloudflare.com/email-service/observability/local-development/sending/),
[event subscriptions](https://developers.cloudflare.com/email-service/reference/event-subscriptions/)),
verified against this repo on 2026-07-18.

## TL;DR

The queue architecture stays exactly as it is. Only the last hop changes:
the email consumer worker replaces its Plunk HTTP call with the Cloudflare
`send_email` binding (`env.EMAIL.send(...)`). No new secrets, no API keys —
the binding authenticates via the Cloudflare account itself. What _is_ needed:
onboard `indigostack.org` for Email Sending in the dashboard (one-time DNS
setup), have the Workers Paid plan, and rework the worker's error/retry logic
around Cloudflare's typed error codes.

## Current architecture (as-is)

```
User Request → Main App → queueEmail() → CF Queue (EMAIL_QUEUE)
                                              │
                                              ▼
                            indigo-email-queue-consumer worker
                            renders React Email template
                                              │
                                              ▼
                                    Plunk API (HTTP) ✉️
```

- `src/lib/email.ts` — `queueEmail()`: locals dev logs to console; prod sends
  `EmailQueueMessage` to the `EMAIL_QUEUE` queue producer binding.
- `workers/indigo-email-queue-consumer/src/index.ts` — queue consumer:
  renders the template, calls `sendEmailWithPlunk()`, `ack()` on success,
  `retry({delaySeconds: 30 * 2^attempts})` on any failure; DLQ
  `indigo-email-queue-dlq` after `max_retries: 3`.
- `workers/indigo-email-queue-consumer/src/send-email.ts` — the only Plunk
  code in the repo: `POST https://next-api.useplunk.com/v1/send` with
  `PLUNK_API_KEY`, parses `SEND_EMAIL_FROM` (`"Name <addr>"`) into
  `{name, email}`, sends HTML-only body with `subscribed: false`.
- `SEND_EMAIL_FROM` var is `"Indigo Stack <noreply@indigostack.org>"` in both
  wrangler configs; `PLUNK_API_KEY` is a wrangler secret on the worker only
  (not in `.dev.vars.example` or `src/env.d.ts`).
- Tests (`tests/unit/email-worker-render.test.ts`,
  `tests/unit/utils/email.test.ts`,
  `tests/unit/email-worker-manifest.test.ts`) cover rendering and manifest
  versions — none reference Plunk. `pnpm email-worker:check` type-checks the
  worker with `@cloudflare/workers-types@5.20261015.1`.

## Target architecture (to-be)

```
User Request → Main App → queueEmail() → CF Queue (EMAIL_QUEUE)
                                              │
                                              ▼
                            indigo-email-queue-consumer worker
                            renders React Email template
                                              │
                                              ▼
                              env.EMAIL.send() → Cloudflare Email Service ✉️
```

Decision: **keep the queue + consumer worker** and swap only the send
transport. Calling the binding directly from the main app was rejected — it
would lose the async delivery, retry/DLQ semantics, and CPU isolation that the
queue system exists to provide.

## Prerequisites (manual, before deploying any code)

Everything in this section is dashboard/console work in the Cloudflare
account. None of it is code, and none of it can be done by a deploy — do it
before the worker cutover ships. Only `indigostack.org` (the domain in
`SEND_EMAIL_FROM`) needs onboarding.

### 0. Check plan and DNS (read-only)

1. **Workers Paid plan.** Sending to arbitrary recipients requires it
   (verified destination addresses are free on all plans, but our recipients
   are arbitrary sign-ups). Check under _Workers & Pages_ → _Plans_. Email
   Routing works on Free, Email Sending to arbitrary recipients does not.
2. **Cloudflare DNS.** Email Service only works for zones on Cloudflare DNS.
   Verify `indigostack.org` is an active zone in this account: dashboard →
   _DNS_ → _Records_, or `dig NS indigostack.org +short` and look for
   `*.ns.cloudflare.com`.
3. **No API token needed** for the binding path — the Workers binding
   authenticates as the account. Tokens only matter for the REST API
   alternative, which we are not using.

### 1. Onboard the sending domain

1. Dashboard → **Compute** → **Email Service** → **Email Sending**
   (<https://dash.cloudflare.com/?to=/:account/email-service/sending>).
2. Select **Onboard Domain**.
3. Choose `indigostack.org` from the account's zones.
4. Review the DNS records Cloudflare will add (see table below), then select
   **Done**.
5. Wait for propagation — usually 5–15 minutes on Cloudflare DNS, up to 24 h
   worst case.

> **⚠️ Onboard Email Sending only.** Email Sending and Email Routing are
> separate onboardings with separate DNS. Sending records live on the
> `cf-bounce` subdomain and cannot conflict with existing mail. Do **not**
> onboard Email Routing unless we actually want inbound routing: it replaces
> the **root-domain MX records**, which would break any existing mail flow on
> `indigostack.org`.

Records Cloudflare creates for Email Sending (all on the `cf-bounce`
subdomain, so they never touch the root domain's existing MX/SPF):

| Record | Name                                   | Purpose                                                                 |
| ------ | -------------------------------------- | ----------------------------------------------------------------------- |
| MX ×3  | `cf-bounce.indigostack.org`            | Route bounce emails back to Cloudflare (`route1/2/3.mx.cloudflare.net`) |
| TXT    | `cf-bounce.indigostack.org`            | SPF: `v=spf1 include:_spf.mx.cloudflare.net ~all`                       |
| TXT    | `cf-bounce._domainkey.indigostack.org` | DKIM public key (selector managed by Cloudflare)                        |
| TXT    | `_dmarc.indigostack.org`               | DMARC policy (see step 2)                                               |

### 2. Review the DMARC record

The onboarding flow adds a DMARC record on `_dmarc.indigostack.org`; the docs'
example shows `p=reject`, but Cloudflare recommends `p=none` (monitor only)
for new sending setups before moving to `p=quarantine`/`p=reject`.

- After onboarding, check the applied policy: `dig TXT _dmarc.indigostack.org
+short`.
- If it is not `p=none`, edit the TXT record to
  `v=DMARC1; p=none;` for launch, and plan to tighten it once reports confirm
  legitimate mail passes alignment. (The `cf-bounce` sending records stay
  Cloudflare-managed/locked, but DMARC on `_dmarc` is editable.)

### 3. Verify onboarding succeeded

Dashboard check: **Compute** → **Email Service** → **Email Sending** →
select the domain → **Settings**. The **DNS records** section lists the four
record groups above; each shows **Locked** or **Unlocked** — both mean the
record is configured correctly (Locked just means Email Service manages it).
Email Sending records on `cf-bounce` stay locked for the life of the domain
config — do not try to unlock or edit them.

DNS check from a terminal:

```bash
dig TXT cf-bounce.indigostack.org +short | grep spf   # SPF
dig TXT cf-bounce._domainkey.indigostack.org +short   # DKIM
dig TXT _dmarc.indigostack.org +short                 # DMARC policy
dig MX cf-bounce.indigostack.org +short               # bounce routing
```

If records show as missing right after onboarding, wait 5–15 minutes and
re-check; that is normal propagation, not a failure.

### 4. Review domain settings (Email Sending → domain → Settings)

| Setting                         | Default            | Keep/Change                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Drop suppressed recipients**  | Off                | Keep **off** for launch. With single-recipient transactional sends, off means a suppressed recipient surfaces as an `E_RECIPIENT_SUPPRESSED` throw, which the worker's ack-and-log policy records per message. On would silently drop instead. |
| **Email preview**               | On for new domains | Keep **on** — stores sent message content in the Activity log for ~7 days, useful for verifying rendered templates in production.                                                                                                              |
| **DMARC** (record, not setting) | per onboarding     | Set `p=none` initially (step 2).                                                                                                                                                                                                               |

### 5. Sender address check

The `from` address must belong to an onboarded sending domain. Our
`SEND_EMAIL_FROM` is `Indigo Stack <noreply@indigostack.org>` — already on
`indigostack.org`, nothing to change. If this ever changes to another domain,
that domain needs its own onboarding first.

### Done when

- [ ] Workers Paid plan confirmed on the account
- [ ] `indigostack.org` zone active on Cloudflare DNS in this account
- [ ] Domain onboarded under **Email Sending** (not Email Routing)
- [ ] All four `cf-bounce`/`_dmarc` record groups show in Settings as
      Locked/Unlocked (both = healthy)
- [ ] DMARC verified as `p=none`
- [ ] Settings reviewed: Drop suppressed recipients off, Email preview on

No account-level API token or secret is required for the binding path.

## Code changes

### 1. `workers/indigo-email-queue-consumer/wrangler.jsonc`

Add the binding (no restriction attributes needed; optionally restrict senders
with `allowed_sender_addresses: ["noreply@indigostack.org"]` as a hardening
step):

```jsonc
{
  // …existing config…
  "send_email": [{"name": "EMAIL"}]
}
```

Do **not** set `"remote": true` — that makes `wrangler dev` send real emails.
The default local simulation logs the email and writes the content to local
files, which matches our dev posture.

### 2. `workers/indigo-email-queue-consumer/src/index.ts`

- `Env`: drop `PLUNK_API_KEY: string`, add `EMAIL: SendEmail` (type exists in
  the pinned `@cloudflare/workers-types@5.20261015.1`; if the structured
  builder isn't in those types, define the interfaces locally or bump the
  package alongside the root — the manifest test requires ranges to match).
- Swap `sendEmailWithPlunk(...)` for the binding call (see 3).

### 3. Replace `src/send-email.ts` with a binding-based sender

```ts
interface SendEmailFrom {
  name: string;
  email: string;
}

export async function sendEmailWithCloudflare(
  email: SendEmail,
  to: string,
  subject: string,
  html: string,
  text?: string,
  sendEmailFrom?: string
): Promise<{messageId: string}> {
  const from = parseFrom(sendEmailFrom); // same "Name <addr>" parsing as today
  const result = await email.send({
    to,
    from, // {email, name} — display name is preserved
    subject,
    html,
    ...(text ? {text} : {})
  });
  return result; // {messageId}
}
```

The structured builder supports `to/from/cc/bcc/replyTo/attachments/headers`,
but our queue messages only ever carry a single `to` — no template changes
needed. Attachments are not used anywhere (good: binary attachment content
can't be serialized by the local simulator).

### 4. `src/render-template.ts` (recommended, small)

Return `{html, text}` instead of a bare HTML string, rendering the text part
with `render(node, {plainText: true})`. Today only HTML is sent; a plain-text
alternative improves deliverability and costs one render pass. Can be a
follow-up if we want the smallest possible diff.

### 5. Error handling & retry policy (behavior change, important)

Plunk failures were opaque strings, so the consumer retried _everything_.
Cloudflare errors carry a `.code`, which lets us stop burning retries on
permanent failures:

| Code                                                                                                  | Meaning               | Action                                                           |
| ----------------------------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| `E_RATE_LIMIT_EXCEEDED`                                                                               | Rate limit hit        | **retry** (existing backoff fits)                                |
| `E_INTERNAL_SERVER_ERROR`                                                                             | Service hiccup        | **retry**                                                        |
| `E_DELIVERY_FAILED`                                                                                   | SMTP delivery failure | **retry** (may be transient)                                     |
| `E_DAILY_LIMIT_EXCEEDED`                                                                              | Daily quota reached   | **retry** → DLQ; replay after the quota resets                   |
| `E_VALIDATION_ERROR`, `E_FIELD_MISSING`, `E_HEADER_*`, `E_CONTENT_TOO_LARGE`, `E_TOO_MANY_RECIPIENTS` | Bad payload           | **ack + log** — retrying identical bytes can't succeed           |
| `E_SENDER_NOT_VERIFIED`, `E_SENDER_DOMAIN_NOT_AVAILABLE`, `E_ACCOUNT_SUSPENDED`                       | Config/account        | **retry** → DLQ; replay after the dashboard fix                  |
| `E_RECIPIENT_SUPPRESSED`                                                                              | CF suppression list   | **ack + log** — correct outcome for a bounced/complained address |

Only errors caused by the message itself are acked. Config, account, and
quota errors hit every message alike and clear once the cause is fixed, so
acking them would drop every email sent during the outage (for example, all
verification mails while the domain onboarding is incomplete). Retrying them
instead parks them in the DLQ, where they can be replayed.

Implement as a `NON_RETRYABLE` code set; `ack()` for those, keep the current
`retry({delaySeconds: 30 * 2^attempts})` + DLQ for the rest. `attempts`
starts at 1, so the delays are 60 s / 120 s / 240 s and a message reaches the
DLQ about 7 minutes after its first failure (`max_retries: 3`).

### 6. What gets deleted at cutover

- `send-email.ts` Plunk implementation (replaced).
- `PLUNK_API_KEY` worker secret: `npx wrangler secret delete PLUNK_API_KEY
--config workers/indigo-email-queue-consumer/wrangler.jsonc`.
- No root-app changes: `queueEmail()`, `email-queue.ts`, templates,
  `EMAIL_QUEUE` producer binding, `.dev.vars.example`, and `src/env.d.ts` are
  untouched.

## Compatibility check

- Worker `compatibility_date: 2026-09-03`. The structured `EmailMessageBuilder`
  API is recent; docs say "set compatibility_date to today". Verify the
  structured builder works at this date during implementation; if not, bump
  the worker's compatibility date as part of the PR.
- `@cloudflare/workers-types@5.20261015.1` should include the `SendEmail`
  structured types; `pnpm email-worker:check` will confirm.

## Limits (verified against our usage)

| Limit                | Value                                       | Our exposure                                      |
| -------------------- | ------------------------------------------- | ------------------------------------------------- |
| Recipients per email | 50 combined                                 | 1 — fine                                          |
| Message size         | 5 MiB                                       | Templates only — fine                             |
| Subject length       | 998 chars                                   | Fine                                              |
| Custom headers       | 20 allowlisted / 16 KB                      | None sent                                         |
| Daily sending quota  | Starts conservative, scales with reputation | Transactional volume is low; monitor after launch |

New accounts start with a conservative daily quota that scales with
deliverability. The suppression list is Cloudflare-managed (hard bounces and
spam complaints add entries); "Drop suppressed recipients" is off by default —
with single-recipient transactional sends, an `E_RECIPIENT_SUPPRESSED` throw
surfaces per message, which our ack-and-log policy handles.

## Pricing

Workers Paid: **3,000 emails/month included, then $0.35 per 1,000**. Sent
emails that hard-bounce still count; API-rejected or suppressed sends don't.
For this project's transactional volume this is effectively free after the
plan cost. Compare against current Plunk spend at review time.

## Observability changes

- `wrangler tail indigo-email-queue-consumer` still works as before.
- **Quirk:** sends via the `send_email` binding show as _dropped_ in the
  Email Routing summary even when delivered — use **Email Sending metrics and
  the activity log** (dashboard / GraphQL Analytics) for outbound truth.
- DLQ and queue metrics monitoring unchanged.

## Optional phase 2 (not in this migration)

- **Event subscriptions** (`message.delivered` / `deferred` / `bounced` /
  `failed` / `rejected`) publish per-sending-domain lifecycle events to a
  queue — would let us track delivery outcomes per user. Requires a new queue
  - consumer or HTTP pull consumer; defer until we need delivery analytics.
- **MTA-STS** configuration for the sending domain.

## Docs to update after the code migration

- `AGENTS.md` — Email System Architecture section says "Plunk API exclusively";
  rewrite for CF Email Service, and the Local-dev bullet (console-logging rule
  stays the same).
- `skills/indigo-email/SKILL.md` — architecture diagram, "Initial Setup"
  (remove the `PLUNK_API_KEY` secret step, add domain onboarding),
  Troubleshooting table, and the architecture line in the description.
- `README.md` if it mentions Plunk (grep after migration).

## Rollout checklist

1. ⬜ Confirm Workers Paid plan + Cloudflare DNS on `indigostack.org`
2. ⬜ Onboard domain for Email Sending; verify DNS records applied; set DMARC `p=none`
3. ⬜ Add `send_email` binding to worker wrangler.jsonc
4. ⬜ Replace Plunk sender with `env.EMAIL.send()`; update `Env`
5. ⬜ Add error-code-aware retry policy (non-retryable set)
6. ⬜ (Recommended) add plain-text part via `render(..., {plainText: true})`
7. ⬜ `pnpm email-worker:check`, `pnpm test:run`, `pnpm build`
8. ⬜ Deploy worker (`pnpm email-worker:deploy`) **before** anything that sends
9. ⬜ Send a real verification email end-to-end; check activity log + inbox
10. ⬜ Delete `PLUNK_API_KEY` secret; cancel Plunk once confirmed
11. ⬜ Update `AGENTS.md` + `skills/indigo-email/SKILL.md`

## Local development (unchanged posture)

- `queueEmail()` still short-circuits to console logging when
  `BETTER_AUTH_BASE_URL` is localhost — the binding is never reached.
- `pnpm email-worker:dev` (full local queue): `wrangler dev` simulates the
  binding — email content is logged and written to local files
  (`/tmp/miniflare-*/files/...`), nothing is sent. Slightly _better_ than
  today: the rendered output is inspectable.
- Opt-in only, per-developer: `"remote": true` on the binding makes local dev
  send real email through the production service. Not enabled in the repo.

## Open decisions

1. **DMARC policy at onboarding** — confirm the flow's applied policy; set
   `p=none` initially per docs' new-setup guidance.
2. **Binding hardening** — add `allowed_sender_addresses:
["noreply@indigostack.org"]`? Cheap blast-radius guard; recommend yes.
3. **Plain-text part** — in this PR or a follow-up? (Recommend this PR; ~20
   lines.)
4. **`E_DAILY_LIMIT_EXCEEDED`** — ack-and-log vs. retry-and-DLQ. Decided:
   retry-and-DLQ, like the other config/account errors. Acking would drop
   every email sent until the quota resets; the DLQ keeps them for a replay.
