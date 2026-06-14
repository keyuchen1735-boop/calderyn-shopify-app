# Connector sign-in: shop auth button instead of "type in store domain"

**Date:** 2026-06-13
**Branch:** `feat/connector-shop-auth` (worktree)
**Scope:** the custom Claude.ai MCP connector sign-in, on **both** surfaces — embedded
(`/oauth/authorize` + new `/oauth/login`) and dashboard (`/dashboard/login` cold path). Leave
the embedded general login `/auth/login` untouched.

## Problem

When a merchant adds the Claude.ai MCP connector, Claude opens our OAuth authorize
endpoint (`/oauth/authorize`, served from `app.calderyncompany.com`). That interstitial
asks them to **type their `*.myshopify.com` domain into a `TextField`** whenever we don't
already have a `?shop=` hint (`app/routes/oauth.authorize.tsx:188-209`). Claude never
sends `?shop=`, so real connector users always hit the raw field. We want a **button-first**
experience instead.

## Constraint that shapes the design

Shopify OAuth cannot begin without `{store}.myshopify.com`; a button can't make that
requirement vanish. But the whole problem reduces to **"get the shop handle, then build
the admin deep link."** The existing known-shop button already deep-links to
`https://admin.shopify.com/store/<handle>/apps/<apiKey>/app/connect?t=<jwt>`, and Shopify
admin preserves that URL (with the `?t=` token) through *its own* login — prod-verified
(memory 2219). So once we know the shop, auth + token-carry are already solved.

The remembered-shop cookie must live on the **authorize origin** (`app.calderyncompany.com`).
The dashboard's `__Host-dash_shop` cookie is on a *different* host (`calderyncompany.com`,
the proxied apex) and is unreadable here. `__Host-` cookies are host-locked.

**Security invariant (must preserve):** `/oauth/authorize` writes **no `Set-Cookie`** — the
"no consumable pre-seed state" rule from PR #107 (`oauth-authorize.test.ts:110-121`). So the
authorize loader only **reads** the remembered-shop cookie. The cookie is **written** only on
the deliberate `/oauth/login` submit, where the merchant types their own shop — the same
trust level as `dashboard.login` writing `__Host-dash_shop`.

## Flow

```
Claude.ai ──▶ /oauth/authorize  (interstitial, app.calderyncompany.com popup)
                │  knownShop = ?shop hint ?? read(__Host-cala_shop cookie)   [READ ONLY]
                │
                ├─ known ─▶ [ Continue to <store> ] ── one click ─▶ admin deep link ?t= ─▶ /app/connect (consent)
                │
                └─ unknown ─▶ [ Log in with Shopify ] ─▶ /oauth/login?t=
                                  └─ enter shop ─▶ Set-Cookie __Host-cala_shop
                                                 ─▶ 302 admin deep link ?t= ─▶ /app/connect (consent)
```

Second connect onward (same browser): the cookie is set → `knownShop` resolves → one click.
The cold path never reappears. Claude-only users (no `?shop=` hint) hit the cold path exactly
once.

## Components

### 1. `app/lib/connect-deeplink.ts` (isomorphic, pure)
Lifted out of `oauth.authorize.tsx` so `/oauth/login` can reuse it.
- `SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i`
- `buildAppConnectUrl({ shop, apiKey, appUrl, token }) → string` — valid shop + apiKey →
  `https://admin.shopify.com/store/<handle>/apps/<apiKey>/app/connect?t=<enc>`; otherwise
  `${appUrl}/app/connect?t=<enc>`. Token URL-encoded.

### 2. `app/lib/connect-deeplink.server.ts` (server-only cookie helpers)
Mirrors `dashboard.login.tsx`'s `__Host-dash_shop` helpers, host-scoped to the authorize origin.
- `SHOP_HINT_COOKIE = "__Host-cala_shop"`, `MAX_AGE = 90 days`.
- `readShopHintCookie(request) → string | null` — returns the cookie value only if it passes
  `SHOP_RE` (rejects injected/non-myshopify values); null otherwise.
- `shopHintCookieHeader(shop) → string` — `__Host-cala_shop=<shop>; Max-Age=...; Path=/;
  HttpOnly; Secure; SameSite=Lax`. (Lax is sent on the cross-site **top-level** popup GET to
  `/oauth/authorize`; the connector opens in a popup window, not an iframe.)

### 3. `app/routes/oauth.authorize.tsx` — button-first interstitial
- Loader: `knownShop = validated ?shop hint ?? readShopHintCookie(request)`. **No `Set-Cookie`.**
  Precedence mirrors `dashboard.login` (explicit hint first, then remembered cookie).
- Component: **known** → existing `Continue to <store>` button (unchanged). **unknown** →
  remove the `TextField` + `Continue`; render one primary button **"Log in with Shopify"**
  linking to `/oauth/login?t=<token>`. The "Prefer the web dashboard?" secondary link stays.
- Uses `buildAppConnectUrl` from the shared helper.

### 4. `app/routes/oauth.login.tsx` (NEW) — the connector's "Shopify login page"
- Flag-gated on `MCP_OAUTH_ENABLED` (404 when off), like the other `/oauth/*` routes.
- Loader: verify `?t=` via `verifyPendingOauth`; invalid/missing → redirect to `${appUrl}/app`
  (no form for a bogus token). Valid → render a clean Polaris "Log in with Shopify" page
  (styled like `auth.login.tsx`) with a single shop field + the token in a hidden field.
- Action (POST): re-verify `?t=`/token (invalid → 400). Validate shop against `SHOP_RE`
  (invalid → re-render with error, **no** `Set-Cookie`, **no** redirect). Valid →
  `Set-Cookie: shopHintCookieHeader(shop)` + 302 to `buildAppConnectUrl(...)`.

### 5. `app/routes/dashboard.login.tsx` — dashboard mirror (in scope)

Per CLAUDE.md, `app/routes/dashboard.*` *is* the dashboard code; mirror here using the
dashboard's own primitives (`cd-card`/`cd-btn`, `dashboard.css`) — **not** Polaris.

Connector flow on the web surface: interstitial "Prefer the web dashboard?" →
`/dashboard/connect?t=` → (no session) → `/dashboard/login?return_to=/dashboard/connect?t=`.

- **Warm path already exists — unchanged:** `/dashboard/login` auto-redirects to Shopify
  authorize when it has a shop (`__Host-dash_shop` cookie or `?shop=`) — the one-click
  equivalent.
- **Cold path (the mirror):** today `/dashboard/login` with no shop + no cookie renders a
  dead-end info page (`loginInfoPage`: "Open Calderyn from your Shopify admin"). Replace that
  *non-errored, no-shop* case with a **shop-entry login form** (the dashboard's "Log in with
  Shopify" page) styled with `cd-card`/`cd-btn`. The form is `method=GET action=/dashboard/login`
  with a `shop` field + a hidden `return_to`, so it re-enters the **existing** loader `?shop=`
  branch — which already validates the shop, sets `__Host-dash_shop`, and 302s to Shopify
  authorize carrying `return_to`. **No new server logic** — the dead end becomes a real entry.
  The `errored` case keeps its friendly retry page.

Result: both surfaces match — remembered shop → one click; no cache → a branded shop-entry
login page instead of a raw inline field (embedded) / a dead end (dashboard).

## Testing (TDD: red → green)

**Unit — `connect-deeplink.ts`:** valid shop → admin deep link w/ handle+apiKey; no/invalid
shop → `${appUrl}/app/connect`; token URL-encoded.

**Unit — `connect-deeplink.server.ts`:** `shopHintCookieHeader` contains `__Host-cala_shop`,
`Secure`, `HttpOnly`, `SameSite=Lax`, `Path=/`; `readShopHintCookie` returns a valid cookie
shop, null when absent, null on malformed/non-myshopify (injection guard).

**Loader — extend `oauth-authorize.test.ts`:**
- NEW: `Cookie: __Host-cala_shop=myshop.myshopify.com`, no `?shop=` → `j.shop ===
  "myshop.myshopify.com"`.
- NEW: both hint + cookie present → hint wins.
- NEW: malformed cookie value → `j.shop` null.
- REGRESSION (must still pass): no cookie/no shop → `j.shop` null **and response `Set-Cookie`
  is null** (invariant preserved).

**Route — NEW `__tests__/oauth-login.test.ts`:** 404 when flag off; loader invalid `t` → 302
to `/app`; loader valid `t` (mock `verifyPendingOauth`) → 200; action valid shop+`t` → 302 to
`https://admin.shopify.com/store/myshop/apps/<apiKey>/app/connect?t=…` **and** `Set-Cookie
__Host-cala_shop=myshop.myshopify.com`; action invalid shop → no redirect, no `Set-Cookie`;
action invalid `t` → 400.

**Render smoke (if testing-library harness present, per `onboarding-ui.test.ts`):** interstitial
no-shop branch renders the "Log in with Shopify" link to `/oauth/login` and **no** shop
`TextField`.

**Dashboard mirror — extend `dashboard-login-returnto.test.ts`:**
- NEW: no `?shop=`, no `__Host-dash_shop` cookie, no `error` → 200 HTML containing a shop-entry
  `<form>` (the new login page), **not** the "Open Calderyn from your Shopify admin" dead end.
- NEW: that form carries the validated `return_to` (via `safeDashboardReturnTo`) in a hidden
  field so the `/dashboard/connect?t=` destination survives.
- REGRESSION (must still pass): `?shop=` valid → 302 to Shopify authorize + `Set-Cookie
  __Host-dash_shop`; `__Host-dash_shop` cookie present (no `?shop=`) → auto-302; `?error` →
  the retry page.

## Out of scope / non-goals
- No `shopify.server.ts` `afterAuth` or managed `/auth/login` changes (fragile cross-domain
  cookie per existing comments).
- No "Sign in with Shop" (shop.app) — returns consumer identity, not the store.
- No changes to the embedded general login `/auth/login` (the connector cold path is the only
  login surface touched; the dashboard mirror reuses the existing `/dashboard/login` loader).

## Pre-commit gate (CLAUDE.md)
`/code-review` → patch sanity → `npm run typecheck` → `npm run lint` (`--max-warnings=0` on
touched files) → `npm run build` → `npm test`. No `.graphql`/schema/migration changes expected,
so codegen/prisma steps N/A.
