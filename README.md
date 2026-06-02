# Calderyn — Shopify Embedded App

Ad-spend and inventory autopilot for Shopify merchants. Watches ad spend (Meta Ads, with stubs for Google Ads) and Shopify inventory, surfaces ranked alerts when spend flows toward unprofitable or out-of-stock SKUs, and lets merchants execute guardrailed corrective actions (pause/resume campaigns, budget edits, inventory reallocation) with a full audit log and undo.

Shopify embedded app built on the official Remix template — boots through the Shopify CLI, authenticates via OAuth + App Bridge token exchange, and renders inside Shopify admin using Polaris.

## Stack

- **Remix** (Vite) + React 18 + TypeScript (ESM, `"type": "module"`)
- **Shopify:** `@shopify/shopify-app-remix` (OAuth, embedded session-token exchange, webhooks), App Bridge React, Polaris v12
- **Deployment:** Vercel (`vercel.json`, `@vercel/remix`). Vercel Cron runs the ingest pipeline daily at 06:00 UTC.

## Data architecture

There are **two separate data stores** — this is intentional and the most important thing to understand about the codebase:

| Store | What it holds | How it's managed |
|---|---|---|
| **Supabase Postgres** | All Calderyn app data — alerts, audit log, campaigns, SKUs, guardrail config, integrations, shops | Migrations under `supabase/migrations/`, applied via Supabase tooling (not Prisma). Accessed server-side via `app/lib/supabase.server.ts` and `app/lib/calderyn.server.ts`. |
| **Prisma + Postgres (Supabase)** | Shopify session storage only — table `shopify_sessions` | `prisma/schema.prisma` defines one `Session` model. `@shopify/shopify-app-session-storage-prisma` reads/writes it. Prisma does NOT manage app-data tables. |

Supabase rows never reach the client — DTOs are shaped at the loader/action boundary in `calderynClient(shop)` (`app/lib/calderyn.server.ts`).

## Prerequisites

- Node 18+ (20+ recommended)
- A Shopify Partner account and a development store
- The Shopify CLI: `npm install -g @shopify/cli @shopify/app`

## First-time setup

```bash
npm install
cp .env.example .env
# Fill in all values in .env (see .env.example for descriptions)
npx prisma generate
```

Link the project to a Shopify app (the CLI walks you through creating one if needed):

```bash
npm run config:link
```

This writes your `client_id` into `shopify.app.toml` and creates a `.shopify/` directory.

> App-data tables (alerts, audit, campaigns, etc.) live in Supabase. See `docs/DEPLOYMENT.md` for how to apply those migrations before first run.

## Run (dev)

```bash
npm run dev
```

The Shopify CLI will:

1. Start a Cloudflare tunnel to expose your localhost
2. Update the app URL + redirect URLs on Shopify's side
3. Boot Remix at `http://localhost:3000`
4. Print an install link — open it in your dev store

On first load inside the admin, OAuth runs, a session row lands in `shopify_sessions`, and the embedded app renders. On install, `afterAuth` in `app/shopify.server.ts` provisions the shop in Supabase and enqueues a data backfill.

## Deploy

```bash
npm run deploy
```

Pushes the app config to Shopify (scopes, webhooks, redirect URLs). The Remix server is hosted on Vercel — deploy via `vercel --prod` or let Vercel auto-deploy from the main branch.

> **Pending manual steps** (Supabase migrations, provider env vars/keys) are tracked in [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Check it before and after deploying.

## Environment variables

Copy `.env.example` and fill in every value. Key variables:

| Variable | Purpose |
|---|---|
| `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` | Shopify app credentials |
| `SCOPES` | OAuth scopes |
| `SHOPIFY_APP_URL` | Public app URL |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase project (server-only; service role bypasses RLS) |
| `DATABASE_URL` | Postgres connection string for Prisma session storage (Supabase session pooler URL) |
| `INTEGRATION_ENCRYPTION_KEY` | AES-256-GCM key (64 hex chars) for encrypting stored OAuth tokens |
| `MCP_TOKEN_PEPPER` | HMAC pepper for hashing MCP bearer tokens |
| `CRON_SECRET` | Shared secret for authenticating Vercel Cron requests to `/cron/ingest` |
| `META_APP_ID` / `META_APP_SECRET` | Meta developer app credentials for the Marketing API integration |

See `.env.example` for descriptions and placeholder values.

## Routes

All `/app/*` routes are protected by `authenticate.admin(request)` (called in the `app.tsx` parent loader).

| Path | File | Notes |
|---|---|---|
| `/` | `routes/_index.tsx` | Public landing; redirects into `/app` if a shop is present |
| `/auth/*` | `routes/auth.$.tsx` | OAuth callback handled by `shopifyApp.authenticate` |
| `/auth/login` | `routes/auth.login.tsx` | Manual shop-domain entry for re-auth |
| `/auth/meta/*` | `routes/auth.meta.$.tsx` | Meta Ads OAuth handshake |
| `/healthz` | `routes/healthz.tsx` | Health check endpoint |
| `/app` | `routes/app.tsx` | Embedded layout (Polaris + App Bridge, NavMenu) |
| `/app` (index) | `routes/app._index.tsx` | Dashboard |
| `/app/onboarding` | `routes/app.onboarding.tsx` | Onboarding flow |
| `/app/alerts` | `routes/app.alerts._index.tsx` | Alert list with severity + status filters |
| `/app/alerts/:id` | `routes/app.alerts.$id.tsx` | Alert detail — evidence, action modals, undo |
| `/app/audit` | `routes/app.audit.tsx` | Action audit log with undo |
| `/app/campaigns` | `routes/app.campaigns.tsx` | Pause / Resume / Edit-budget controls |
| `/app/skus` | `routes/app.skus.tsx` | SKU inventory across locations |
| `/app/settings` | `routes/app.settings.tsx` | Guardrails, integrations, notifications, uninstall |
| `/app/mcp` | `routes/app.mcp.tsx` | Mint per-shop MCP bearer tokens |
| `/cron/ingest` | `routes/cron.ingest.tsx` | Ingest pipeline entry point (Vercel Cron, auth via `CRON_SECRET`) |
| `/webhooks/app/uninstalled` | `routes/webhooks.app.uninstalled.tsx` | Clears session, soft-marks shop uninstalled |
| `/webhooks/gdpr` | `routes/webhooks.gdpr.tsx` | GDPR compliance (data request, redact) |
| `/webhooks/products/update` | `routes/webhooks.products.update.tsx` | Product webhook |
| `/webhooks/inventory_levels/update` | `routes/webhooks.inventory_levels.update.tsx` | Inventory level webhook |
| `/webhooks/orders/create` | `routes/webhooks.orders.create.tsx` | Orders webhook |

NavMenu links: Dashboard, Alerts, Audit log, Campaigns, SKUs, Settings.

## Integrations

| Integration | Status |
|---|---|
| **Meta Ads** | Fully wired. OAuth handshake (`app/lib/meta/oauth.server.ts`), live list/pause/resume/budget via the Marketing API (`app/lib/meta/campaigns.server.ts`). OAuth tokens stored encrypted (AES-256-GCM, `app/lib/crypto.server.ts`). |
| **Shopify inventory** | Fully wired. `inventoryAdjustQuantities` Admin GraphQL mutation in `app/lib/shopify/inventory.server.ts`. |
| **Google Ads** | UI stub only — OAuth not wired (`startOAuth` throws `OAUTH_NOT_WIRED`). |
| **QuickBooks** | UI stub only — OAuth not wired (`startOAuth` throws `OAUTH_NOT_WIRED`). |

## Guardrails

Per-shop guardrail config (budget cap, per-action dollar cap, cooldown, business hours) is stored in Supabase and surfaced in Settings and on alert detail pages. Enforcement inside the action gateway is in progress — guardrails are not yet blocking execution.

## Ingest pipeline

`app/lib/ingest/` contains the backfill, webhook-to-facts transform, DLQ, and the `reorder-timing` detector. The pipeline is driven by `app/routes/cron.ingest.tsx`, invoked by Vercel Cron daily at 06:00 UTC, authenticated by `CRON_SECRET`. On app install, `afterAuth` provisions the shop and enqueues a backfill.

## MCP server

Merchants mint per-shop read-only bearer tokens at `/app/mcp`. These tokens authenticate requests to the external [`calderyn-mcp`](../calderyn-mcp) server at `https://calderyn-mcp.vercel.app/mcp`, which exposes alerts, audit log, campaigns, SKUs, guardrails, and integrations to MCP clients (Claude.ai connectors, custom agents). Token hashing uses `MCP_TOKEN_PEPPER` (`app/lib/mcp_tokens.server.ts`). See `docs/adr/0001-mcp-server-split.md` for the split rationale.

## File map

```
calderyn-shopify-app/
├── shopify.app.calderynextension.toml  ← Shopify CLI app config (scopes, webhooks, redirects)
├── vercel.json                          ← Vercel build config + Cron schedule
├── package.json
├── vite.config.ts
├── tsconfig.json
├── prisma/
│   └── schema.prisma                    ← Session table only (shopify_sessions)
├── supabase/
│   └── migrations/                      ← App-data migrations (alerts, audit, campaigns, etc.)
├── app/
│   ├── shopify.server.ts                ← shopifyApp() init — auth, session storage, afterAuth, webhooks
│   ├── db.server.ts                     ← Prisma singleton (session storage only)
│   ├── entry.server.tsx
│   ├── root.tsx
│   ├── routes.ts
│   ├── lib/
│   │   ├── supabase.server.ts           ← Supabase service-role client
│   │   ├── calderyn.server.ts           ← Typed DTO client — calderynClient(shop)
│   │   ├── crypto.server.ts             ← AES-256-GCM encrypt/decrypt for OAuth tokens
│   │   ├── mcp_tokens.server.ts         ← MCP bearer token mint + verify
│   │   ├── types.ts                     ← Shared TypeScript types
│   │   ├── format.ts                    ← Money / time helpers
│   │   ├── labels.ts
│   │   ├── meta/                        ← Meta Ads integration (oauth, client, campaigns)
│   │   ├── shopify/                     ← Shopify Admin API helpers (inventory)
│   │   └── ingest/                      ← Ingest pipeline (backfill, transform, DLQ, detectors)
│   └── routes/                          ← Auth + webhook + cron + app routes (see table above)
└── docs/
    ├── DEPLOYMENT.md                    ← Manual deploy checklist
    └── adr/                             ← Architecture Decision Records
```

## Testing

```bash
npm test
```

Runs the Vitest suite (unit tests under `app/**/__tests__`).

## Further reading

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) — manual deploy steps, Supabase migration instructions, env var checklist
- [docs/adr/0001-mcp-server-split.md](docs/adr/0001-mcp-server-split.md) — why the MCP server is a separate deployment
