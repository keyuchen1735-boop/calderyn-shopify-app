# Calderyn — Shopify Embedded App

Ad-and-inventory autopilot for Shopify merchants. Watches ad spend across Meta and Google Ads, watches inventory across Shopify locations, and surfaces alerts when spend is flowing toward unprofitable or out-of-stock SKUs. Executes corrective actions through a guardrailed action gateway with full audit and undo.

This is a real **Shopify embedded app** built on the official Remix template — it boots through the Shopify CLI, authenticates via OAuth + App Bridge token exchange, and renders inside Shopify admin using Polaris.

## What's inside

- **Remix** (Vite) + React 18
- **Shopify App Bridge** + **Polaris** (Polaris v12 — the chrome, NavMenu, modals, toasts, data tables are all native)
- **`@shopify/shopify-app-remix`** for OAuth, embedded session token exchange, and webhook handlers
- **Prisma + SQLite** for session storage (dev default; swap to Postgres for prod)
- TypeScript
- All Calderyn business logic, fixtures (12 detectors, 6 action kinds, 9 campaigns, 5 SKUs), and state mutators

State is held in a client singleton (`app/lib/store.ts`) using `useSyncExternalStore` — this lets the prototype demonstrate every action flow end-to-end with no backing detection engine. Replace with Remix loaders/actions when wiring to a real Postgres + worker.

## Prerequisites

- Node 18+ (20+ recommended)
- A Shopify Partner account
- A development store
- The Shopify CLI: `npm install -g @shopify/cli @shopify/app`

## First-time setup

```bash
cd shopify-app
npm install
cp .env.example .env
npx prisma migrate dev --name init
```

Link the project to a Shopify app (the CLI walks you through creating a new one if needed):

```bash
npm run config:link
```

This writes your `client_id` into `shopify.app.toml` and creates a `.shopify/` directory.

## Run

```bash
npm run dev
```

The Shopify CLI will:

1. Start a Cloudflare tunnel to expose your localhost
2. Update the app URL + redirect URLs on Shopify's side
3. Boot Remix at `http://localhost:3000`
4. Print an install link — open it in your dev store

The first time the app loads inside the admin, OAuth runs, a session row lands in `dev.sqlite`, and the embedded app renders inside the Shopify Polaris frame.

## Deploy

```bash
npm run deploy
```

Pushes the app config to Shopify so the new scopes, webhook subscriptions, and redirect URLs land in production. Host the built Remix app behind any Node-compatible runtime (Fly, Cloudflare, Render, Vercel-Node).

## Routes

All app routes are protected by `authenticate.admin(request)` (called via the `app.tsx` parent loader):

| Path | File | Notes |
|---|---|---|
| `/` | `routes/_index.tsx` | Public landing; redirects into `/app` if a shop is present |
| `/auth/*` | `routes/auth.$.tsx` | OAuth callback handled by `shopifyApp.authenticate` |
| `/auth/login` | `routes/auth.login.tsx` | Manual shop-domain entry for re-auth |
| `/webhooks/app/uninstalled` | `routes/webhooks.app.uninstalled.tsx` | Clears sessions on uninstall |
| `/webhooks/gdpr` | `routes/webhooks.gdpr.tsx` | GDPR compliance webhooks |
| `/app` | `routes/app.tsx` → `_index.tsx` | Embedded layout (Polaris + App Bridge); dashboard |
| `/app/onboarding` | `routes/app.onboarding.tsx` | 7-step onboarding flow |
| `/app/alerts` | `routes/app.alerts._index.tsx` | All 12 alerts with severity + status filters |
| `/app/alerts/:id` | `routes/app.alerts.$id.tsx` | Detail with Claude narrative, evidence, action modals, `E`/`S` shortcuts |
| `/app/audit` | `routes/app.audit.tsx` | Action audit log with Undo |
| `/app/campaigns` | `routes/app.campaigns.tsx` | Pause / Resume / Edit-budget controls |
| `/app/skus` | `routes/app.skus.tsx` | SKU inventory across 3 locations |
| `/app/settings` | `routes/app.settings.tsx` | Guardrails, integrations, notifications, privacy, uninstall |

## Where to extend

- **Wire detection to a real engine:** the prototype state singleton at `app/lib/store.ts` is the seam. Replace `executeAction` / `undoAction` with Remix `<Form>` posts to `action` functions that hit your action gateway, and replace `useAppState` selectors with `useLoaderData` from a Remix `loader` that reads from Postgres.
- **Add Shopify Admin API calls:** the `admin` object returned by `authenticate.admin(request)` exposes the GraphQL client. Use it for inventory transfers (`inventoryAdjustQuantities` mutation) when wiring `reallocate_inventory`.
- **Add Meta / Google OAuth:** the current Connect buttons set a flag in the client store. Replace with redirects to `/auth/meta` / `/auth/google` routes that perform the real OAuth handshake against each provider's `accounts.*` endpoint and write encrypted credentials to a Postgres `integration_credentials` table.
- **Persist Calderyn data:** add detector_results, action_audit, integration_credentials, guardrail_config tables to `prisma/schema.prisma` and migrate.

## File map

```
shopify-app/
├── shopify.app.toml              ← Shopify CLI app config (scopes, webhooks, redirects)
├── shopify.web.toml              ← web role for the Remix server
├── package.json                  ← deps + Shopify CLI scripts
├── vite.config.ts
├── tsconfig.json
├── env.d.ts
├── prisma/
│   └── schema.prisma             ← Session table for Shopify OAuth tokens
├── app/
│   ├── shopify.server.ts         ← shopifyApp() init — auth, sessionStorage, webhooks
│   ├── entry.server.tsx          ← Streaming SSR with addDocumentResponseHeaders
│   ├── root.tsx
│   ├── routes.ts                 ← flatRoutes()
│   ├── db.server.ts              ← Prisma singleton
│   ├── components/
│   │   └── ToastBridge.tsx       ← Forwards store toasts → App Bridge
│   ├── lib/
│   │   ├── types.ts
│   │   ├── fixtures.ts           ← 12 alerts, 9 campaigns, 5 SKUs, integrations
│   │   ├── format.ts             ← money / time helpers
│   │   └── store.ts              ← In-memory client store (replace with loaders/actions for prod)
│   └── routes/                   ← Auth + webhook + app routes (see above)
```

## Notes

- The Calderyn business state is **client-side only**. A page refresh resets it. This is intentional for the demo — the auth flow, embedded host, App Bridge, OAuth callbacks, and webhook subscriptions are all real Shopify infrastructure; only the detector results and audit log are mocked.
- The 2FA modal flow was removed by design iteration — Execute commits immediately.
- Guardrail checks display as advisory cues; they never block execution in the prototype.
