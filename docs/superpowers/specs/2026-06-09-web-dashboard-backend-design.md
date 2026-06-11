# Web Dashboard Backend — Design

**Date:** 2026-06-09
**Status:** Approved (Approach A)
**Scope:** Backend only — no UI. JSON API + auth + live-sync plumbing for a merchant-facing dashboard at `calderyncompany.com/dashboard`.

## Goal

Merchants log in at `calderyncompany.com/dashboard` with their Shopify identity and see/act on the same live data as the embedded Shopify admin app. Any change made in the Shopify app is visible on the web dashboard, and any action taken on the web dashboard (pause campaign, edit guardrail, resolve alert) takes effect in the Shopify app — because both surfaces share one database and one set of server-side action functions.

## Architecture

The backend lives in **this repo (`calderyn-shopify-app`)**, deployed to Vercel at `app.calderyncompany.com`. The public URL is provided by **Vercel rewrites in the `calderyn-waitlist` repo** (which serves `calderyncompany.com`):

```
calderyncompany.com/dashboard/:path*  →  app.calderyncompany.com/dashboard/:path*
```

Rationale: this repo already holds the Shopify OAuth client credentials, Supabase service access, and the entire action pipeline (`app/lib/actions/*`, `app/lib/calderyn.server.ts`). Building the dashboard API here means zero duplicated business logic and automatic two-way sync. The waitlist repo's "no service-role key" policy stays intact — it only gains rewrite rules.

A new route family `app/routes/dashboard.*` is added. These routes are **JSON-only** (plus the OAuth redirect pages), never load Polaris/App Bridge, and authenticate via a session cookie instead of the embedded token-exchange strategy.

## Components

### 1. Standalone Shopify OAuth login (`dashboard.login`, `dashboard.auth.callback`)

- `GET /dashboard/login?shop=<shop>.myshopify.com` — validates the shop domain shape, generates a `state` nonce (stored in a short-lived signed cookie), and redirects to `https://<shop>/admin/oauth/authorize` with the existing `client_id`, the app's current scopes, and redirect URI `https://app.calderyncompany.com/dashboard/auth/callback`.
- `GET /dashboard/auth/callback` — verifies the Shopify HMAC on the query string, verifies `state`, exchanges the code for an access token (which is **discarded** — we don't need offline tokens; the embedded app already manages those; the exchange only proves the requester controls the shop).
- The callback then requires the shop to exist in the Supabase `shops` table (i.e., the app is installed). Unknown shop → `403` JSON `{ error: "app_not_installed" }` so the UI can show "install Calderyn first."
- On success: create a row in a new `dashboard_sessions` table and set the session cookie, then redirect to `/dashboard`.
- `POST /dashboard/api/logout` — deletes the session row, clears the cookie.
- The new redirect URL is added to `shopify.app.calderynextension.toml` `[auth].redirect_urls` and pushed via `shopify app deploy`.

### 2. Session model (`app/lib/dashboard/session.server.ts` + migration)

New table `dashboard_sessions`:

| column | type | notes |
|---|---|---|
| `id` | uuid pk | random |
| `token_hash` | text unique | SHA-256 of the opaque cookie token |
| `shop_id` | uuid fk → shops | the merchant |
| `shop_domain` | text | denormalized for logging |
| `created_at` / `expires_at` / `last_seen_at` | timestamptz | 30-day expiry, sliding `last_seen_at` |
| `revoked_at` | timestamptz null | set on logout / uninstall |

Cookie: `__Host-calderyn_dash` with `SameSite=Lax; Secure; HttpOnly; Path=/`, always set on the apex origin via the proxied `auth/finish` endpoint (see the handoff note below) so the browser treats it as first-party for `calderyncompany.com`. The cookie value is a 256-bit random opaque token; only its hash is stored. `requireDashboardSession(request)` is the single guard used by every API route: looks up hash, checks expiry/revocation, returns `{ shopId, shopDomain }` or throws `401` JSON.

**Revocation on uninstall:** the existing `webhooks/app/uninstalled` handler additionally marks all `dashboard_sessions` for that shop revoked.

**Note on cookies through the rewrite (simplified during planning):** Vercel rewrites from `calderyncompany.com/dashboard/*` keep the browser on `calderyncompany.com`, so Set-Cookie from the proxied function is first-party for the apex domain. We register the **apex** URL `https://calderyncompany.com/dashboard/auth/callback` as the Shopify redirect URI — the rewrite proxies it to the app, so the whole OAuth round-trip (login → Shopify → callback) happens on the apex origin. State cookie and session cookie both live on the apex; no cross-host handoff is needed. The public origin is configured via a `DASHBOARD_PUBLIC_URL` env var (set to the app's own URL in dev).

### 3. JSON API (`app/routes/dashboard.api.*`)

All require the session; all responses `application/json`; all scoped to the session's `shop_id`. Read endpoints delegate to the same query helpers the embedded app's loaders use (`calderyn.server.ts`, `analytics-view.ts`); write endpoints delegate to `app/lib/actions/*` so audit logging, Meta API calls, undo, and alert resolution behave identically.

| Route | Method | Backed by |
|---|---|---|
| `/dashboard/api/me` | GET | session → shop profile, onboarding status |
| `/dashboard/api/overview` | GET | shop stats + ROAS series (same queries as `app._index`) |
| `/dashboard/api/campaigns` | GET | campaign list + grades |
| `/dashboard/api/campaigns/:id` | GET | campaign detail |
| `/dashboard/api/campaigns/:id/action` | POST `{type: pause\|resume\|set_budget, …}` | `actions/execute.server.ts` |
| `/dashboard/api/alerts` | GET | alert list (filterable) |
| `/dashboard/api/alerts/:id` | GET | alert detail (read-only in v1 — the embedded app has no alert-resolve write path to reuse; alert state changes flow through detectors/actions) |
| `/dashboard/api/skus` | GET | SKU/inventory list |
| `/dashboard/api/guardrails` | GET / PUT | `actions/guardrails.server.ts` |
| `/dashboard/api/audit` | GET | action audit (paginated) + POST undo via `actions/undo.server.ts` |
| `/dashboard/api/integrations` | GET | connected ad platforms status |
| `/dashboard/api/realtime-token` | GET | see Live sync |
| `/dashboard/api/logout` | POST | session revocation |

Error contract: `{ error: string, message?: string }` with proper status codes (`401` no session, `403` wrong shop / not installed, `422` validation, `429` rate limited).

### 4. Live sync

- **Shopify app → web dashboard:** both read the same tables; the app's webhooks/crons already keep them current. For push updates, `GET /dashboard/api/realtime-token` mints a short-lived (1 h) Supabase JWT carrying `shop_id` as a claim; RLS policies on `campaigns`, `alerts`, `action_audit`, `skus` allow `SELECT` for that claim so the future UI can open a Supabase Realtime subscription scoped to its own rows. (Requires enabling Realtime on those tables + the RLS policies in the migration.)
- **Web dashboard → Shopify app:** writes go through the identical action functions, so the embedded app sees them on next load; no extra work.
- **Fallback:** plain polling of the GET endpoints works without Realtime; the token endpoint is additive.

### 5. CSRF, rate limiting, headers

- State-changing routes require `Origin`/`Referer` header allow-list (`calderyncompany.com`, `app.calderyncompany.com`) on top of `SameSite=Lax`.
- Login + callback rate-limited per IP (hashed, reusing the waitlist's SHA-256 IP pattern) — 10/min.
- `Cache-Control: no-store` on all API responses.

### 6. Waitlist repo changes (`calderyn-waitlist`)

- `vercel.json`: add `rewrites` for `/dashboard` and `/dashboard/:path*` to `https://app.calderyncompany.com/dashboard/$1`; extend CSP `connect-src` to include the Supabase Realtime origin (`wss://ajgrmnvzxfxxlwrxcgnu.supabase.co`) for the future UI.
- No other code in that repo.

## Error handling

- OAuth callback failures (bad HMAC, stale state, Shopify error param) → redirect to `/dashboard/login?error=…` with no session.
- Action endpoint failures surface the action pipeline's own error/retry semantics (a failed Meta call returns `502` with the audit row id; the existing `cron/action-retry` picks it up).
- Expired/revoked session → `401` everywhere; the UI is expected to bounce to login.

## Testing

- Unit: HMAC verification, state cookie round-trip, opaque-token hash/verify, handoff-code single-use, `requireDashboardSession` expiry/revocation paths.
- Integration (vitest, seeded Supabase shop): full login → API read → campaign action → audit row assertion; cross-surface check that a guardrail PUT via dashboard API is what the embedded app loader reads back.
- Manual: end-to-end OAuth against a dev store, cookie behavior through the production rewrite.

## Out of scope

- Any UI/frontend.
- New data or analytics not already in the embedded app.
- Multi-user/staff accounts per shop (session = shop, not person, for v1).
- Billing or plan gating.
