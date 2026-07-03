# Spec — Sign-in: first-class Shopify OAuth + full data port + auth-surface polish

**Date:** 2026-07-03
**Owner:** Eric
**Base:** main *after* PR #277 (`fix/native-signin-logout`) merges — this feature edits the same routes.
**Branch:** `feat/signin-shopify-port` (isolated worktree per CLAUDE.md).

## Goal

A merchant can sign in to the Calderyn dashboard directly with Shopify OAuth, port their
store data over (now including customers), and stop depending on Shopify. All sign-in
surfaces look like the dashboard. The sign-in fields/pages get a security sweep before merge.

## What already exists (reused, not rebuilt)

- `AuthShell` + `cd-auth-*` design system (`app/components/auth/AuthCard.tsx`,
  `app/styles/dashboard.css` §auth). Already used by `/login`, `/signup`, `/reset`,
  reset-confirm, verify, verify-needed.
- Shopify OAuth for the dashboard: `/dashboard/login` (authorize redirect + store-domain
  form) → `/dashboard/auth/callback` (HMAC + state checks, session mint, `return_to`).
- Import pipeline: `/dashboard/settings/import` (`ImportShopify` screen) →
  `dashboard.api.import` → `cron.import` drain → `backfillShop` (locations, products/
  variants, inventory, 12 mo orders via the embedded install's offline token) →
  `promoteShopFromMirror` → report.

## Design

### 1. `/login`: promote Shopify to a provider button
Replace the "Sign in with Shopify" foot link with a `cd-auth-*` provider button
("Continue with Shopify") beside the Google button, linking to `/dashboard/login`.
Sub-copy sells the port: e.g. "Brings your store data with you."

### 2. `/dashboard/login`: rebuild with AuthShell
Replace the two raw-HTML string pages (`loginFormPage`, `loginInfoPage`) with React
components on `AuthShell`: the store-domain form (same validation, `?shop=` GET flow,
`return_to` carry) and the error/info state. Kills the off-brand purple and the last
non-dashboard sign-in surface. `?shop=` fast path (302 to authorize) unchanged.

### 3. Callback: steer first-time Shopify sign-ins to the import screen
In `dashboard.auth.callback`, after session mint: explicit validated `return_to` wins;
otherwise, if the shop has no completed import (`latestImport` state ≠ `done`), redirect
to `/dashboard/settings/import`; else `/dashboard`. The merchant clicks Import explicitly
on the existing screen — no auto-start.

### 4. Callback: friendly "app not installed" page
The raw JSON `403 app_not_installed` becomes a redirect to a styled AuthShell state on
`/dashboard/login` explaining that importing runs on the Calderyn app's store connection,
with the install path. **Constraint kept:** the data pull uses the offline token minted at
embedded-app install; the dashboard's light OAuth proves shop ownership only. No
install/provisioning duplication in the dashboard flow.

### 5. Customer import (new pipeline stage)
- **Scope:** add `read_customers` to `SCOPES`. Existing installs re-authorize on next
  OAuth round-trip (Shopify prompts automatically).
- **External prerequisite (not code):** protected-customer-data access must be requested
  and approved in the Partner Dashboard before Shopify returns customer PII to a public
  app. Until approved, the customer stage reports itself as blocked — visibly, not
  silently (rule 12).
- **Fetch:** `fetchCustomers` in `app/lib/ingest/shopify-admin.server.ts` (paginated like
  `fetchProducts`): email, phone, default address, marketing consent.
- **Destination:** `buyer_dim` keyed `(shop_id, email_normalized)` + `buyer_address`
  (default shipping) + consent child table. **Hard invariant respected:** buyer PII lives
  only in the buyer tables, never in warehouse facts. No schema change to `buyer_dim`;
  Shopify customer id is not stored (email is the durable identity).
- **Skips surfaced:** customers without an email can't key into `buyer_dim` — they are
  counted and shown in the import report, not dropped silently.
- **Report:** customers move from "not included" to an imported count (with skipped
  count); theme/store design remains the only "not included" item.

### 6. Security sweep (last step, before merge)
Run the security review on the branch plus a targeted pass over sign-in fields/pages:
rate limits (per-IP + per-account), CSRF origin checks on all auth POSTs, `return_to`
open-redirect validation, state-cookie handling, cookie flags (`__Host-`, HttpOnly,
SameSite), account-enumeration responses, `autocomplete` attributes, and no new PII in
logs. Findings fixed on the branch before the pre-commit gate.

## Out of scope
- MCP-connector login (`oauth.login`) and embedded-admin login (`auth.login`) stay Polaris.
- Full offboarding/cutover wizard (declined; existing `dashboard.api.cutover` untouched).
- `dashboard.connect` consent-page layout (not a sign-in surface).
- Theme/store-design port (not portable).

## Testing
Follow existing vitest route-module patterns:
- `/login` renders the Shopify provider button; `/dashboard/login` form renders via
  AuthShell (no HTML-string paths left) with unchanged validation behavior.
- Callback steering: no-import → import screen; completed import → `/dashboard`;
  explicit `return_to` wins; not-installed → friendly page (no raw JSON).
- Customer ingest: mapper unit tests (email normalization, no-email skip counting);
  promote report includes customers imported/skipped; blocked-stage visibility when
  protected-data access is absent.
- Existing auth/OAuth security tests keep passing (state, HMAC, rate limits).

## Dashboard parity
These routes are the dashboard (CLAUDE.md). The embedded Shopify app surface is
deliberately unchanged. Parity satisfied by construction.

## Rollout notes
- `SCOPES` change requires `shopify app deploy` / env update in Vercel and merchant
  re-auth; harmless if protected-data approval lags — the stage reports blocked.
- No cutover of PR #277 behavior: signin stays native-first; Shopify OAuth remains an
  explicit user action.
