# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Essential Commands

Commands marked with **(CI)** run in the `Test` workflow on every pull request.

- `pnpm dev` - Start development server (includes Astro type checking and Cloudflare Workers emulation)
- `pnpm peers check` - Check for unmet or missing peer dependency issues (CI)
- `pnpm format` - Format all files with Prettier
- `pnpm format:check` - Verify Prettier formatting without writing (CI)
- `pnpm check` - Generate Cloudflare types, then run TypeScript and Astro diagnostics. Use this composed form, not a bare `astro check`: on a fresh clone the generated `worker-configuration.d.ts` does not exist yet, so a bare run fails with "Cannot find name 'Env'" (CI)
- `pnpm email-worker:check` - Type-check the email queue consumer worker (CI)
- `pnpm test:run` - Run the unit and integration tests once (CI)
- `pnpm build` - Build production (Cloudflare types generation, then the Astro build) (CI)
- `pnpm preview` - Preview production build locally with Wrangler
- `pnpm icons` - Regenerate the favicon PNGs and the apple-touch icon in `public/` from the square source `public/icon.png`

### Database Operations

- `pnpm db:generate` - Generate Drizzle migrations from schema changes
- `pnpm db:migrate:local` - Apply migrations to local D1 database
- `pnpm db:migrate:prod` - Apply migrations to production D1 database
- `pnpm db:backup` - Write a SQL dump of the production D1 database to `drizzle/backup.sql`; reads `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_DATABASE_ID`, and `CLOUDFLARE_TOKEN` from the process environment, not `.dev.vars`
- `pnpm db:studio:local` - Open Drizzle Studio for local database inspection
- `pnpm db:init:local` - Initialize local D1 database
- `pnpm db:init:prod` - Create production D1 database

### Email Development

- `pnpm preview-email` - Start React Email preview server for template development

### Authentication Schema

- `pnpm better-auth:schema` - Generate Better Auth schema using config

## Architecture Overview

### Multi-Framework Hybrid Architecture

This is an Astro application with React components for interactivity and email templates. The architecture follows a hybrid approach:

- **Frontend**: Astro pages with server-side rendering + React islands for client-side interactivity
- **API Layer**: Hono-based REST API mounted at `/api/v1/*` with modular route organization
- **Database**: Drizzle ORM with Cloudflare D1 (serverless SQLite)
- **Authentication**: Better Auth with JWT tokens and refresh token plugin
- **Email**: React Email templates sent through the Cloudflare Email Service binding
- **Deployment**: Cloudflare Workers with static assets

## Better Auth Integration

### Important Rules

- **ALWAYS use `auth.api.*` methods** for all Better Auth interactions (both client-side and server-side)
- **NEVER use `fetch()`** to call Better Auth endpoints
- **NEVER use `auth.handler()`** - use the API methods instead
- Use `asResponse: true` when you need to access response headers or cookies
- For verification/redirect endpoints, check both `response.ok` and `response.status === 302`

### Examples

```typescript
// ✅ CORRECT - Use auth.api methods
const auth = createAuth(env);

// Without response headers (simple success/error checking)
const {status} = await auth.api.sendVerificationEmail({
  body: {
    email,
    callbackURL: "/discover"
  }
});

// With response headers (to access cookies)
const response = await auth.api.signUpEmail({
  body: {email, password, name},
  asResponse: true
});
if (response.ok) {
  const cookies = response.headers.getSetCookie();
  // Forward cookies...
}

// Handle redirects (e.g., email verification)
const response = await auth.api.verifyEmail({
  query: {token, callbackURL},
  asResponse: true
});
if (response.ok || response.status === 302) {
  // Verification successful
}

// ❌ WRONG - Don't use fetch
const response = await fetch(`${baseURL}/api/auth/...`);

// ❌ WRONG - Don't use handler
const response = await auth.handler(request);
```

### Request Flow Architecture

#### Web Pages (Astro SSR)

1. Astro middleware handles authentication state and i18n routing
2. Pages render server-side with user context available via `locals.user`
3. React components hydrate for interactive features
4. Language detection/routing handled by middleware with cookie preference

#### API Requests (Hono)

1. All API requests route through `/api/[...path].ts`
2. Hono app with v1 namespace: `/api/v1/*`
3. Middleware chain: D1 → Auth → Env → Response Time
4. JWT-based authentication for API endpoints
5. Routes organized by domain: `/auth`, `/account`

**IMPORTANT**: Hono API endpoints are designed for external/mobile clients only and require JWT authentication. **Do NOT use these endpoints within Astro views or components.** For server-side data access in views, use direct database queries via Drizzle ORM or server-side actions instead.

### Database Schema Architecture

The database follows Better Auth's expected schema with extensions:

- `user` - Core user data with email verification status
- `session` - Better Auth sessions for web authentication
- `account` - OAuth accounts and password data
- `verification` - Email verification tokens
- `jwks` - JSON Web Key Sets for JWT signing

### Authentication Architecture

Dual authentication system:

- **Web Authentication**: Session-based via Better Auth (cookies)
- **API Authentication**: JWT + Refresh token system for mobile/API clients
- **Middleware Integration**: Both systems share user context through Astro locals

#### Mobile Authentication API

Mobile apps use the Hono API (`/api/v1/auth/*`) instead of calling Better Auth endpoints directly. This provides API stability and protection from upstream changes.

**Architecture Decision:**

- ✅ Mobile → `/api/v1/auth/*` (Hono) → `auth.api.*` (Better Auth internally)
- ❌ Mobile → `/api/auth/*` (Better Auth directly) - Not allowed

**Available Endpoints:**

The machine-readable contract for the whole `/api/v1` surface, including request and response shapes and the unified `{error}` error body, is served at **`GET /api/v1/openapi.json`**. Its set of registered routes is cross-checked against the running router in CI, so a documented method/path pair cannot silently drift out of the document; the request and response shapes are hand-maintained beside the handlers that produce them. `GET /api/v1/routes` lists every registered route at run time. Two endpoint notes the document captures but prose would flatten:

- **POST `/api/v1/auth/sign-in`** - Exchange credentials for JWT tokens
  - Headers: `Authorization: Basic <base64(email:password)>`
  - Returns: `{user: {id, email, name, image}, accessToken, refreshToken, tokenType: "Bearer"}`
- **POST `/api/v1/auth/refresh-access`** and **POST `/api/v1/auth/revoke-access`** - Both require a `{refreshToken}` body, returning `{accessToken, refreshToken, tokenType}` and `{success: true}` respectively

**Locale Handling for Mobile:**

All email-sending endpoints (`sign-up`, `send-verification-email`, `forgot-password`) extract locale from the `Accept-Language` header:

```text
Mobile App → Headers: Accept-Language: ja
          → getLanguageFromHeaders() extracts "ja"
          → createAuth(env, "ja")
          → Email sent in Japanese
```

Mobile clients should always send `Accept-Language` header with their device's preferred language to receive localized emails.

**Example (React Native):**

```typescript
import * as Localization from "expo-localization";

fetch("/api/v1/auth/sign-up", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Accept-Language": Localization.locale // "ja-JP" or "en-US"
  },
  body: JSON.stringify({email, password, name})
});
```

### Internationalization Architecture

Type-safe i18n with locale-aware routing:

- Supported locales: `en` (default), `ja`
- URL structure: `/{locale}/page` (e.g., `/ja/dashboard`)
- Language detection: Cookie preference → Accept-Language header → default
- Translations stored as JSON with TypeScript inference for type safety

### Email System Architecture

React Email templates delivered asynchronously through Cloudflare Queues:

- **Production**: a real `BETTER_AUTH_BASE_URL` makes `queueEmail()` enqueue to the `EMAIL_QUEUE` binding; `workers/indigo-email-queue-consumer` renders the template and sends via the Cloudflare Email Service binding (the sender domain must be onboarded for Email Sending in the dashboard)
- **Development and CI**: `BETTER_AUTH_BASE_URL` containing `localhost` or `127.0.0.1` makes `queueEmail()` log the message to the console instead of queueing — no email is ever sent and no Email Sending setup is needed
- Template organization in `src/components/email/` with shared BaseLayout
- Preview server available via `pnpm preview-email`

## Key Configuration Files

### Environment Configuration

- **Local secrets**: `.dev.vars` (copy from `.dev.vars.example`)
- **Production secrets**: Set via `pnpm wrangler secret put VARIABLE_NAME`
- **Public vars**: Configured in `wrangler.jsonc` under `vars` section
- **Optional trusted origins**: `BETTER_AUTH_TRUSTED_ORIGINS` is a comma-separated list appended after `BETTER_AUTH_BASE_URL`
- **Optional dev server hosts**: `ASTRO_DEV_ALLOWED_HOSTS` is a comma-separated list read from `process.env` in `astro.config.mjs` and passed to `vite.server.allowedHosts` (dev-time only, not a Worker binding). A tunnel hostname usually has to be named here and in `BETTER_AUTH_TRUSTED_ORIGINS` — this var so the dev server answers it, and the trusted origins so auth accepts the origin
- **Schema validation**: none — `astro.config.mjs` declares no `env` key; the environment declarations are the generated `Env` from `wrangler types` (driven by `wrangler.jsonc`) plus the handwritten secret entries in `src/env.d.ts` — `wrangler types` never generates secrets, so each one declared for runtime access must be added there by hand

### Database Configuration

- **Schema**: `src/db/schema.ts` - Drizzle schema definitions
- **Migrations**: Generated in `drizzle/migrations/` via `pnpm db:generate`
- **Connection**: Uses Cloudflare D1 binding `DB` configured in `wrangler.jsonc`
- **Local DB**: Auto-discovered in `.wrangler/` directory by Drizzle Kit

### Authentication Configuration

- **Web Auth**: `src/lib/auth.ts` - Runtime Better Auth instance
- **Schema Gen**: `src/lib/auth-config.ts` - Config for CLI schema generation
- **Plugins**: Custom refresh access token plugin in `src/plugins/better-auth/`
- **Password hashing**: `src/lib/password.ts` - PBKDF2-SHA256 through Web Crypto; new accounts store a `$pbkdf2$…` hash. A project already generated from this template that carries live credential accounts needs the legacy delegation branch in `verifyPassword` before adopting this change

## Development Patterns

### Adding New API Endpoints

1. Create route file in `src/lib/hono/routes/`
2. Import and mount in `src/pages/api/[...path].ts`
3. Authentication handled automatically by middleware
4. Database available via `c.get("db")`
5. Register the new route in `src/lib/hono/routes/openapi.ts`, which serves `GET /api/v1/openapi.json`. `tests/integration/openapi.test.ts` cross-checks the document's path set against what `GET /api/v1/routes` reports in both directions, so an unregistered route turns the test suite red

### Database Schema Changes

1. Update `src/db/schema.ts`
2. Run `pnpm db:generate` to create migration
3. Apply with `pnpm db:migrate:local`
4. For production: `pnpm db:migrate:prod`

### Adding New Languages

1. Add locale to `src/i18n/constants.ts` locales array
2. Create translation file in `src/translations/{locale}.json`
3. Import in `constants.ts` translations object
4. Language detection and routing handled automatically

### Email Template Development

1. Create React component in `src/components/email/`
2. Use BaseLayout for consistent styling
3. Test with `pnpm preview-email`
4. Send via `queueEmail(to, template, env, options)` from `src/lib/email.ts`: outside local development it puts a message on the `EMAIL_QUEUE` binding for `workers/indigo-email-queue-consumer` to render and send, while a `BETTER_AUTH_BASE_URL` containing `localhost` or `127.0.0.1` makes it log the message to the console instead (see Email System Architecture)

### Component Development

- **Astro components**: For page layouts and static content
- **React components**: For interactive UI elements (forms, dropdowns, etc.) and email templates
- **UI Primitives**: Shadcn-style components in `src/components/ui/`

### Error Handling & Display Guidelines

The application uses a unified error display system for consistent user feedback.

**Available Components:**

- **Astro:**
  - `ErrorMessage.astro` - Displays all errors at the top of forms
  - `SuccessMessage.astro` - Success confirmations with icons
- **React:**
  - `ErrorMessage.tsx` - React version for client components

**Error Display Pattern:**

**ALL errors display at the top of forms using ErrorMessage. No inline field errors.**

```astro
<!-- Astro Components -->import ErrorMessage from
"@/components/ErrorMessage.astro"; import SuccessMessage from
"@/components/SuccessMessage.astro";
<form>
  <!-- Show ANY error at top - server, validation, or field errors -->
  <ErrorMessage message={errors.server || errors.email || errors.password} />

  <!-- Form fields without inline errors -->
  <Input type="email" name="email" required />
  <Input type="password" name="password" required />

  <Button type="submit">Submit</Button>
</form>
<!-- Success message -->
<SuccessMessage message={successMessage} />
```

```tsx
// React Components
import {ErrorMessage} from "@/components/ErrorMessage";
import {toast} from "sonner";

<form>
  {/* All errors at top */}
  <ErrorMessage message={errors.server || errors.name || errors.description} />

  {/* Fields */}
  <Input name="name" required />

  {/* Toast for success (transient feedback) */}
  <Button onClick={() => toast.success("Saved!")}>Save</Button>
</form>;
```

**Design Principles:**

- **One error location**: Top of form only, never inline
- **Combine errors**: Use `||` to show first available error
- **Lucide icons**: AlertCircle for errors, CheckCircle for success
- **Design tokens**: `text-destructive`, `bg-destructive/10`, etc.
- **Auto-hide**: Components hide when no message
- **Dark mode**: Built-in via design tokens

**Toast Notifications** - For transient, non-blocking feedback:

- Success confirmations (`toast.success()`)
- Background operations (`toast.info()`)
- Non-critical errors (`toast.error()`)
- Icons auto-configured with Lucide

**Migration Notes:**

- Remove all inline field error displays
- Consolidate errors at top with `errors.field1 || errors.field2`
- Remove `FormError` component usage (deprecated)
- Keep ARIA attributes for accessibility (optional)

### Adding New Components

When tasking with redesigning or creating components, always check whether we
have the component locally first. If not, and it is a standard Shadcn UI
primitive or block, install it with `pnpm add-component <name>`. That drives
the upstream `shadcn` CLI against the registry config in the root
`components.json`, which resolves its aliases and writes straight into
`src/components/ui/`.

`pnpm add-component` also handles blocks, so run it for those the same way.

**Registry output needs a post-add fix before it compiles here.** The
registry's current Tailwind 4 output imports `cn` from the `cn` package and
Radix primitives from the unified `radix-ui` package, and the CLI adds both
to `package.json` when a generated file needs them. This repository follows
the older contract: `cn` comes from `@/lib/utils` and each primitive comes
from its matching `@radix-ui/react-*` package (already in `package.json`).
So after every `pnpm add-component` run: rewrite the
`cn`/`radix-ui` imports to `@/lib/utils` and the matching `@radix-ui/react-*`
package, remove the `cn` and `radix-ui` entries the CLI appended to
`package.json`, and run `pnpm install` to prune them. Do not keep the `cn`
or `radix-ui` packages to make a generated file resolve — that is a
dependency-swap decision for its own PR.

A bare import swap is not enough for the namespace usages the unified output
emits — `Slot.Root`, `Dialog.Root`, `Dialog.Trigger` — because the individual
packages expose parts as separate named exports, not as statics on the main
component. Adapt those usages to the tree's idioms: `@radix-ui/react-slot`'s
`Slot` is used directly (as in `button.tsx`), while multi-part primitives use
the `import * as DialogPrimitive from "@radix-ui/react-dialog"` form with
`DialogPrimitive.Root`/`Trigger` (as in `dialog.tsx` and `dropdown-menu.tsx`).

Use BrowserMCP to preview both the old and new designs. If you get connection
errors, ask the developer to ensure the browser extension is installed and is
running against localhost:4321. Use that as base URL for your attempts. You
might need to navigate to the page you're redesigning first to see how it looks
like.

### Button Component Usage Guidelines

**Rule**: Choose the right button approach based on functionality requirements:

- **Static navigation links** → Use `buttonVariants()` with compile-time class generation

  ```astro
  ---
  import {buttonVariants} from "@/components/ui/button";
  const buttonClasses = buttonVariants({variant: "outline", size: "sm"});
  ---

  <a href="/path" class={buttonClasses}>
    Link Text
  </a>
  ```

- **Interactive functionality** → Keep React Button components with `client:load`

  ```astro
  <!-- Form submissions, click handlers, state management -->
  <Button type="submit" onClick={handler} client:load>
    Submit
  </Button>
  ```

**Examples of compile-time candidates**: `<Button asChild>` wrapping simple `<a>` tags
**Examples of React components**: Form buttons, click handlers, state management, disabled states

## Important Constraints

### Cloudflare Workers Limitations

- Node.js built-ins are available: `wrangler.jsonc` declares `compatibility_flags: ["nodejs_compat"]`, and code on request paths relies on it (e.g. `Buffer.from(...)` in `src/plugins/better-auth/refresh-access/index.ts`)
- React 19 requires `react-dom/server.edge` in production (configured in Astro config)

### Better Auth Configuration

- `src/lib/auth-config.ts` used only for schema generation (no D1 access)
- Runtime auth instances created per-request in `src/lib/auth.ts`
- JWKS stored in database, not filesystem

### Database Development

- Local D1 database auto-created on first `pnpm dev`
- Schema changes require explicit migration generation and application
- Drizzle Studio connects to local `.wrangler/` database file

### Development vs Production

- Email: logged to the console while `BETTER_AUTH_BASE_URL` is a localhost address (dev and CI) vs queued to Cloudflare Queues and sent via the Cloudflare Email Service binding (prod)
- Database: Local D1 file vs remote Cloudflare D1
- Secrets: `.dev.vars` file vs Wrangler secrets
- Assets: Dev server vs Cloudflare Workers static assets

## Theming

This project uses TailwindCSS for styling.
The shadcn theme is defined in `src/styles.css`.

The `skills/indigo-theming/SKILL.md` guide covers everything beyond those two lines: the `styles.css` sections and semantic tokens, changing or adding palettes, renaming the shipped ones, border radius, typography, using tokens in components, theme switching, and the CSS file setup for new projects. Follow it for any theming work.

## Repository Skills

Procedural guides live in `skills/` as `SKILL.md` files. They are named in no other document, so check them before improvising a procedure:

- `skills/astro-upgrade/SKILL.md` - Upgrading Astro across a major: branch and baseline rules, the guide → pin → migrate → validate loop, troubleshooting
- `skills/indigo-email/SKILL.md` - The email queue architecture, queuing emails, the available templates, adding a new one, Cloudflare Email Service and queue setup, local development with the full queue
- `skills/indigo-i18n/SKILL.md` - Translation file structure, using translations in pages and React components, locale-aware URLs, adding keys or a new language
- `skills/indigo-testing/SKILL.md` - The test directory layout, running tests, how the Workers test server works, auth helpers, selector strategy, common patterns
- `skills/indigo-theming/SKILL.md` - The theming system described in the Theming section above, in full
