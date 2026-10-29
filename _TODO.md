# TODO

## New Project Checklist

- [ ] Create a KV namespace for sessions using `pnpm wrangler kv namespace create "SESSION"` and add the binding to `wrangler.jsonc`.
- [ ] Create a D1 database in Cloudflare and add its `binding`, `database_name`, and `database_id` to `wrangler.jsonc`.
- [ ] Run `pnpm db:init:local` to initialize the local database.
- [ ] Run `pnpm db:init:prod` to initialize the production database.
- [ ] Regenerate migrations using `pnpm db:generate`.
- [ ] Apply migrations to local database using `pnpm db:migrate:local`.
- [ ] Apply migrations to production database using `pnpm db:migrate:prod`.
- [ ] Ensure all bundled tests pass using `pnpm test`.
- [ ] Create the email queues using `pnpm queue:create`.
- [ ] Onboard the sender domain for Cloudflare Email Sending in the dashboard (Compute → Email Service → Email Sending → Onboard Domain; requires Workers Paid and Cloudflare DNS). Keep the binding's `allowed_sender_addresses` in `workers/indigo-email-queue-consumer/wrangler.jsonc` in sync with `SEND_EMAIL_FROM`.
- [ ] Deploy the email consumer worker using `pnpm email-worker:deploy` before the main app.
- [ ] Deploy the app from the Git-linked Workers project (build command `pnpm build`) before setting production secrets.
- [ ] Set `BETTER_AUTH_SECRET` secret using `pnpm wrangler secret put BETTER_AUTH_SECRET` for production.
- [ ] (Optional) Turn on require email verification on sign up.
- [ ] Update logo and landing page copy: replace the artwork in `public/`, then run `pnpm icons`, and replace `public/favicon.ico` by hand (the script does not regenerate it).
