# HANDOFF — Claude.ai connector: explicit in-app consent (closes OAuth pre-seed High)

**Branch:** `feat/connector-explicit-consent` (worktree `../calderyn-connector-explicit-consent`), based on `fix/security-hardening` @ `2101ade`.
**Status:** scaffolded, not yet implemented. Build the flow below test-first, then verify the one live-integration risk noted at the end.

## Why this exists

The MCP OAuth connector (Claude.ai → Calderyn data) had a **High**: `/oauth/authorize` pre-seeds OAuth
state keyed by `shop_domain` alone, before merchant auth. Any party can write a pending row for any shop;
the victim's next authenticated `/app` visit auto-routes them to consent for the **attacker's** client, and
approving issues a code to the attacker's `redirect_uri`.

A partial fix is already committed on the base branch (`a7037be` — POST now revalidates
`response_type`/`code_challenge_method`/`scope`/`code_challenge`). The remaining work is the **binding**:
the pending state must not be consumable by `shop` alone.

### Why the obvious carriers don't work (already investigated)

- `shopify.server.ts:35` sets `unstable_newEmbeddedAuthStrategy: true` → **token-exchange** auth.
  There is **no classic OAuth `state` round-trip** to inject a `txn` into and read back. (This killed the
  first-choice "ride OAuth state" design.)
- The signed pending **cookie** (`mcp_oauth.server.ts:232`, `SameSite=None`) is **fragile in the embedded
  admin iframe** across Vercel domain aliases — which is exactly why the insecure shop-keyed DB row exists.

### Chosen design (most robust): explicit in-app initiation

No silent `/app` auto-route, no shop-only DB row. The merchant explicitly approves **inside the embedded
admin**, where `authenticate.admin` establishes the shop server-side. The unguessable carrier is the
**signed pending JWT** (`signPendingOauth`/`verifyPendingOauth`, already implemented) passed in the
**deep-link URL** into the embedded app — URL params survive the token-exchange even when the cookie dies.

```
Claude.ai → /oauth/authorize?{client_id,redirect_uri,code_challenge,scope,state,shop?}
  authorize: validate client + redirect_uri + grant shape (already enforced),
             mint signed pending JWT (ctx = the OAuth request), render an interstitial:
             "Open Calderyn in your Shopify admin to approve" + deep link → app.connect?t=<jwt>
  Merchant opens admin → app.connect (embedded, authenticate.admin → session.shop):
             verify <jwt> → ctx; show client_name + destinationHost + scopes; Allow / Deny
  On Allow:  shop_id = resolveShopId(session.shop); issueAuthCode(ctx + shop_id) → redirect to ctx.redirect_uri?code=&state=
Attacker's shop-only pre-seed: no valid signed token in the victim's URL → nothing to consume.
```

The approving shop comes from the **authenticated session**, not the token — a merchant only ever consents
for their **own** shop. (Do NOT bind issuance to a `shop` field inside the token.)

## File-by-file plan (test-first)

1. **`app/routes/app.connect.tsx`** *(new)* — embedded + authenticated consent.
   - `loader`: `FLAG_ON()` gate (`MCP_OAUTH_ENABLED`); `authenticate.admin(request)`; read `t` from URL;
     `verifyPendingOauth(t)` → ctx (redirect to `/app` on failure); `getClient(ctx.client_id)`;
     return `{ token, client_name, destinationHost: new URL(ctx.redirect_uri).host, scopes }`.
   - `action`: `authenticate.admin` → `session.shop`; `verifyPendingOauth(t)`; on `deny` →
     `{ redirect_url: ...?error=access_denied&state }`; on `allow` →
     `shop_id = resolveShopId(session.shop)`, `issueAuthCode({client_id, shop_id, redirect_uri,
     code_challenge, scopes, state})`, `{ redirect_url: ...?code=&state= }`. Reuse the existing
     top-window-navigation pattern from the old `oauth.consent.tsx` default export (useFetcher → JSON
     `redirect_url` → `window.top.location.href`).
2. **`app/routes/oauth.authorize.tsx`** — keep validation; **drop** `setPendingOauth` DB write, the
   `/auth/login` auto-route, and the `PENDING_COOKIE` set. After validation, `signPendingOauth(ctx)` and
   render an interstitial Page with a button linking to the embedded connect route carrying `?t=<jwt>`
   (use `SHOPIFY_APP_URL`; if you can build a reliable `admin.shopify.com/store/<handle>/apps/...` deep
   link from `?shop=`, prefer it — see `app/lib/admin-deeplink.server.ts`). Keep the `TODO(security)`
   removed once this lands.
3. **`app/routes/app._index.tsx`** — **remove** the entire pending-OAuth handoff block (the
   `getPendingOauth(session.shop)` pickup, the cookie pickup, and `handoff()`/`signConsentAuth`).
4. **`app/routes/oauth.consent.tsx`** — **delete** (replaced by `app.connect`). Remove
   `app/routes/__tests__/oauth-consent.test.ts`.
5. **`app/lib/mcp_oauth.server.ts`** — retire now-unused exports: `setPendingOauth`, `getPendingOauth`,
   `deletePendingOauth`, `PendingOauthRow`, `signConsentAuth`/`verifyConsentAuth`/`ConsentAuthPayload`,
   and the `PENDING_COOKIE_*` consts. KEEP `signPendingOauth`/`verifyPendingOauth` (the carrier) and the
   PKCE/code helpers. Confirm no stragglers: `grep -rn "setPendingOauth\|getPendingOauth\|signConsentAuth\|PENDING_COOKIE" app/`.
6. **Tests**
   - `app/routes/__tests__/oauth-authorize.test.ts` — rewrite: valid request renders the interstitial and
     does NOT write any DB pending state / set a cookie; the grant-shape 400 cases stay.
   - `app/routes/__tests__/app-index-loader.test.ts` — drop the handoff expectations.
   - `app/routes/__tests__/app-connect.test.ts` *(new)* — loader renders consent for a valid token +
     authenticated shop; action issues a code on `allow` (assert `issueAuthCode` called with
     `session.shop`'s `shop_id`); `deny` returns the error `redirect_url`; invalid/expired token → 400 /
     redirect. Mock `~/lib/mcp_oauth.server`, `~/lib/supabase.server`, and `authenticate.admin`.
   - `app/lib/__tests__/mcp_oauth_pkce.test.ts` — still uses `signPendingOauth`; keep green.

## Dashboard parity (MANDATORY — do not skip silently)

The connector consent is surface-agnostic (it grants Claude.ai access to Calderyn data). A merchant who
lives in the **dashboard** (`dashboard.*` routes, own session via `requireDashboardSession`) needs an
equivalent "Connect Claude" approval that verifies the same signed token and calls `issueAuthCode` for the
dashboard session's shop. Implement a `dashboard.connect` route mirroring `app.connect`'s contract against
the dashboard's own auth/UI primitives. If you ship the embedded side first, leave a TODO and say so.

## The one risk to verify LIVE (cannot be unit-tested)

Claude.ai opens OAuth in a **popup** expecting the final `code` redirect in *that popup* (`window.opener`).
This design approves in the **embedded admin** (a different window). Confirm end-to-end against a real
Claude.ai connector whether completing via a **full-page** top-window redirect to `claude.ai/cb?code=…`
from the admin is accepted, or whether an intermediate "return to Claude" hop is needed. Use the
`chrome-devtools` MCP to drive a real run before declaring done.

## Gate before commit (repo pre-commit gate)

`npm run typecheck` → 0; `npm run lint` (touched, `--max-warnings=0`) → 0; `npm run build` → 0;
`npx vitest run` → green; `/code-review` clean. Auto-commit per repo policy once green; do not push/PR
without an explicit request.
