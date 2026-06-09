# Design: Native Claude.ai Connector for Calderyn (MCP foundation + OAuth 2.1)

**Date:** 2026-06-08
**Status:** Approved for implementation planning
**Repos affected:** `shopify-app` (this repo) + `calderyn-mcp` (sibling, rebuilt from the 2026-05-25 spec)
**Supersedes / extends:** [`2026-05-25-mcp-server-design.md`](2026-05-25-mcp-server-design.md) — that spec described v1 (bearer-token) and stubbed v2 (OAuth). This doc combines both into a single "Piece A + Piece B" delivery and locks the v2 choices the original spec deferred. Write-tool surface ("Piece C") remains a separate workstream.

---

## 1. Goal

A merchant should be able to:

1. Open Claude.ai → **Add connector** → paste `https://calderyn-mcp.vercel.app/mcp`.
2. See a Polaris-styled **"Allow Claude.ai to read your Calderyn data?"** screen on `app.calderyncompany.com`.
3. Click **Allow** → start asking Claude questions about their store (alerts, audit, campaigns, SKUs, guardrails, integrations) immediately. No copy-pasted tokens.

The current bearer-token page at `/app/mcp` stays as an escape hatch for custom (non-Claude) MCP clients.

## 2. Non-goals

- **Write tools** (`pause_campaign`, `reduce_budget`, `acknowledge_alert`, etc.). These are Piece C, which gets its own spec covering 2FA-over-MCP, the action-routing decision the original spec deferred, scope-gated tokens, and an undo path. This spec only forward-compats for them.
- **OAuth as the only auth.** The `mcp_live_*` bearer flow stays. Both auth modes resolve to the same `{shop_id, scopes}` context — tool handlers never know which one produced it.
- **Rate limiting, per-request audit log, multi-region routing, caching.** Same deferral as the original spec.
- **Recovering the lost source.** Cleaner to rebuild from the spec than to reverse-engineer the Vercel function bundle. The deployed `calderyn-mcp.vercel.app` Vercel project keeps its current URL/alias; we push fresh source on top.

## 3. Background — what exists today

- **Token UI** at [`app/routes/app.mcp.tsx`](../../../app/routes/app.mcp.tsx): Polaris page to mint and revoke `mcp_live_*` bearer tokens.
- **Token CRUD** at [`app/lib/mcp_tokens.server.ts`](../../../app/lib/mcp_tokens.server.ts): HMAC-SHA256(token, `MCP_TOKEN_PEPPER`) hashed at rest.
- **`mcp_tokens` table** in Supabase, RLS-enabled deny-all (service-role only) per the 2026-06-04 hardening migration.
- **`calderyn-mcp.vercel.app`** is a live Vercel project (Hono preset, deployed 2026-05-26 via `vercel deploy` from a local directory that no longer exists on any machine we have access to). `/healthz` returns 200, `/mcp` returns 401 as expected. **No Git source exists.**
- **No nav link** to `/app/mcp` — discoverable only by typing the URL.

## 4. Topology

```
                 ┌───────────────────────┐
                 │   Claude.ai client    │
                 └──┬──────────────┬─────┘
        Bearer (1)  │              │  Browser pop-up (OAuth)
                    ▼              ▼
   ┌──────────────────────┐   ┌──────────────────────────────────┐
   │  calderyn-mcp        │   │  shopify-app (this repo)         │
   │  (rebuilt)           │   │                                  │
   │  Hono + MCP SDK      │   │  /oauth/authorize  (consent UI)  │
   │                      │   │  /oauth/register   (DCR)         │
   │  /mcp                │   │  /oauth/token      (code → token)│
   │  /healthz            │   │  /.well-known/                   │
   │  /.well-known/       │   │     oauth-authorization-server   │
   │     oauth-protected- │   │  /app/mcp     (bearer + manage)  │
   │     resource         │   │                                  │
   └──────────┬───────────┘   └──────────────┬───────────────────┘
              │                              │
              │       service-role           │
              └──────────────┬───────────────┘
                             ▼
                     ┌───────────────┐
                     │  Supabase     │
                     │  mcp_tokens   │  ← extended
                     │  mcp_oauth_clients  ← NEW
                     │  mcp_oauth_codes    ← NEW
                     │  shops, v_*_views   ← unchanged
                     └───────────────┘
```

Authoritative shop identity lives in `shopify-app`'s Shopify session. OAuth endpoints that need to know "who is this merchant?" all live there. `calderyn-mcp` only needs to resolve a bearer/access token → `shop_id` via the existing introspection middleware, which already does this for bearer tokens and will work for OAuth tokens unchanged (same table, same column).

### 4.1 Why three OAuth endpoints in shopify-app, one in calderyn-mcp

- `/oauth/authorize` **must** be in shopify-app — it's the only place the Shopify offline session lives, and we need that session to bind the OAuth code to a `shop_id` securely.
- `/oauth/register` (DCR) and `/oauth/token` are pure database operations against Supabase. They could live in either repo; putting them with `/oauth/authorize` in shopify-app keeps all four OAuth surfaces together, simpler ops, one repo to redeploy when OAuth logic changes.
- `/.well-known/oauth-protected-resource` (RFC 9728) **must** be in calderyn-mcp — Claude.ai fetches it from the resource origin. It's a 5-line static JSON that points at shopify-app for the authorization server metadata.

### 4.2 Why rebuild calderyn-mcp instead of recovering

The 2026-05-25 spec describes the v1 server in enough detail to rebuild faithfully (~600 lines of source across the listed files). Recovering would require pulling the bundled 700KB Vercel function output and reverse-mapping it back to source — slower, riskier, and produces uglier code than starting from the spec. The Vercel project keeps its URL and aliases; only the deployment changes.

## 5. Merchant flow (plain English)

**First connect:**

1. Merchant opens Claude.ai (Pro/Team/Enterprise — free Claude can't add connectors).
2. Connector picker → **Add connector** → name "Calderyn", URL `https://calderyn-mcp.vercel.app/mcp`.
3. Claude.ai fetches the resource → 401 with discovery hint → fetches well-known docs → dynamically registers itself.
4. Claude.ai opens a browser tab to `https://app.calderyncompany.com/oauth/authorize?…`.
5. **Branch A** — merchant URL has a known Shopify session in this browser: skip straight to the consent screen.
   **Branch B** — no session: small Polaris page asks **"Which shop?"** → enter `myshop.myshopify.com` → standard Shopify OAuth → callback → consent screen.
6. Consent screen shows: shop name, scopes requested ("Read alerts, campaigns, SKUs, audit, guardrails, integrations"), Calderyn branding, **Allow** / **Deny**.
7. **Allow** → 302 back to `https://claude.ai/api/mcp/auth_callback?code=…&state=…`.
8. Claude.ai exchanges the code for an access token (90-day lifetime) + refresh token. Done.

**Subsequent use:**

- Claude.ai sends `Authorization: Bearer <access_token>` on every `/mcp` request. Same middleware as the bearer path. Calls `update last_used_at` debounced.
- 90 days later, access token expires → Claude.ai uses refresh token at `/oauth/token` → gets new pair (refresh rotates on use). Silent to merchant.

**Revoke from the merchant side:**

- `/app/mcp` page lists connected Claude.ai workspaces with a **Disconnect** button. Disconnect sets `revoked_at` on the access + refresh tokens. Next request 401s.

## 6. Auth: OAuth 2.1 details

### 6.1 Specs followed

- [RFC 6749](https://datatracker.ietf.org/doc/html/rfc6749) Authorization Code Grant — only this grant.
- [RFC 7636](https://datatracker.ietf.org/doc/html/rfc7636) PKCE — required, `code_challenge_method=S256` only.
- [RFC 7591](https://datatracker.ietf.org/doc/html/rfc7591) Dynamic Client Registration — open registration, public clients (no client secret).
- [RFC 8414](https://datatracker.ietf.org/doc/html/rfc8414) Authorization Server Metadata.
- [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728) OAuth Protected Resource Metadata.
- [MCP Authorization](https://modelcontextprotocol.io/specification/draft/basic/authorization) — Anthropic's MCP auth profile (PKCE, opaque tokens, DCR).

### 6.2 Discovery

`calderyn-mcp` serves at `https://calderyn-mcp.vercel.app/.well-known/oauth-protected-resource`:

```json
{
  "resource": "https://calderyn-mcp.vercel.app/mcp",
  "authorization_servers": ["https://app.calderyncompany.com"],
  "scopes_supported": ["read"],
  "bearer_methods_supported": ["header"]
}
```

`shopify-app` serves at `https://app.calderyncompany.com/.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://app.calderyncompany.com",
  "authorization_endpoint": "https://app.calderyncompany.com/oauth/authorize",
  "token_endpoint": "https://app.calderyncompany.com/oauth/token",
  "registration_endpoint": "https://app.calderyncompany.com/oauth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["read"]
}
```

### 6.3 Endpoints

| Endpoint | Method | Where | Purpose |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | calderyn-mcp | Resource metadata (RFC 9728). |
| `/.well-known/oauth-authorization-server` | GET | shopify-app | AS metadata (RFC 8414). |
| `/oauth/register` | POST | shopify-app | DCR (RFC 7591). Returns `client_id`. |
| `/oauth/authorize` | GET | shopify-app | Polaris consent UI. Validates params, kicks off Shopify OAuth if no session, issues code on Allow. |
| `/oauth/token` | POST | shopify-app | Exchanges code (+verifier) for access+refresh tokens; refresh-token rotation. |
| `/mcp` | POST | calderyn-mcp | MCP Streamable HTTP. Existing introspection middleware untouched. |
| `/healthz` | GET | calderyn-mcp | Mirrors current behavior. |

### 6.4 PKCE

`code_challenge_method` is hard-validated as `S256`; `plain` is rejected. `code_challenge` is stored on the `mcp_oauth_codes` row at authorize-time. At token-exchange, server recomputes `BASE64URL(SHA256(verifier))` and constant-time-compares. Mismatch → 400 `invalid_grant`.

### 6.5 Token lifetimes & rotation

| Token | Lifetime | Rotation | Storage |
|---|---|---|---|
| Authorization code | 60s | Single-use (`consumed_at` flips on first exchange) | `mcp_oauth_codes` |
| Access token | 90 days | Not rotated; `expires_at` checked on every `/mcp` request | `mcp_tokens` (auth_type='oauth') |
| Refresh token | 1 year | **Rotates on use** — old refresh hash deleted, new one issued | `mcp_tokens.refresh_hash` |

Refresh rotation prevents replay of stolen refresh tokens. If a stolen refresh token is used after the legit client rotated, both will fail on the next attempt; that's the detection signal.

### 6.6 Scopes (v1)

Only `read`. The `mcp_tokens.scopes` JSON column already supports a list — Piece C adds `write:safe` and `write:money` without a migration.

### 6.7 Public clients only

`token_endpoint_auth_method: "none"`. No client secrets — Claude.ai is a public client. PKCE is the security boundary.

### 6.8 Backward compatibility

Existing `mcp_live_*` tokens keep working. The introspection middleware in `calderyn-mcp` already does `SELECT shop_id, scopes FROM mcp_tokens WHERE token_hash=$1` — that query matches both kinds. The only additional check we add: `revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`. Bearer tokens have `expires_at = NULL`, so the predicate degenerates to today's behavior.

## 7. Schema changes (Supabase)

All three tables: RLS on, no policy (service-role only). Mirrors the 2026-06-04 hardening posture.

### 7.1 New: `mcp_oauth_clients`

```sql
create table mcp_oauth_clients (
  client_id                   text primary key,            -- 'cal_client_' + 16 random base32
  client_name                 text not null,               -- from DCR payload
  redirect_uris               jsonb not null,              -- array, validated against at /authorize and /token
  token_endpoint_auth_method  text not null default 'none',
  software_id                 text,                        -- DCR optional
  software_version            text,
  created_at                  timestamptz not null default now(),
  last_used_at                timestamptz
);

alter table mcp_oauth_clients enable row level security;
revoke all on table mcp_oauth_clients from anon, authenticated;
```

### 7.2 New: `mcp_oauth_codes`

```sql
create table mcp_oauth_codes (
  code_hash         text primary key,                       -- sha256(code)
  client_id         text not null references mcp_oauth_clients(client_id) on delete cascade,
  shop_id           uuid not null references shops(id) on delete cascade,
  redirect_uri      text not null,                          -- bound at issue, verified at exchange
  code_challenge    text not null,                          -- PKCE S256
  scopes            jsonb not null default '["read"]'::jsonb,
  state_hint        text,                                   -- for logging; never returned to client
  expires_at        timestamptz not null,                   -- now() + 60s
  consumed_at       timestamptz,                            -- one-time use
  created_at        timestamptz not null default now()
);
create index mcp_oauth_codes_cleanup_idx on mcp_oauth_codes (expires_at);

alter table mcp_oauth_codes enable row level security;
revoke all on table mcp_oauth_codes from anon, authenticated;
```

Expired/consumed codes are reaped by a daily Vercel cron in shopify-app (`/api/cron/mcp-oauth-cleanup`).

### 7.3 Extend: `mcp_tokens`

```sql
alter table mcp_tokens
  add column auth_type    text not null default 'bearer'  check (auth_type in ('bearer','oauth')),
  add column client_id    text references mcp_oauth_clients(client_id) on delete set null,
  add column expires_at   timestamptz,                    -- null = no expiry (bearer)
  add column refresh_hash text;                           -- null for bearer; for oauth, hmac(refresh_token, MCP_TOKEN_PEPPER)

create unique index mcp_tokens_refresh_hash_uq on mcp_tokens (refresh_hash) where refresh_hash is not null;
create index mcp_tokens_oauth_lookup_idx on mcp_tokens (client_id, shop_id) where auth_type = 'oauth' and revoked_at is null;
```

Existing rows: `auth_type='bearer'`, all new columns NULL. Behavior unchanged.

## 8. UI changes (shopify-app)

### 8.1 New: `app/routes/oauth.authorize.tsx` (public, non-embedded)

- **Loader** validates `client_id`, `redirect_uri ∈ client.redirect_uris`, `response_type=code`, `code_challenge`, `code_challenge_method=S256`. Invalid → 400 with `error=invalid_request` and no redirect (per spec, malformed `redirect_uri` must not be redirected to).
- **Branch A** (no `?shop=...`): render Polaris `Page` with a `shop` text input. Submit posts to `/auth?shop={shop}&return_to={current_url}` — same Shopify OAuth handler the embedded app already uses, with a custom return URL.
- **Branch B** (Shopify offline session for `shop` already exists in this browser): jump directly to the consent screen below.
- **Consent screen** — Polaris `Page`, Calderyn branding:
  - Header: "Connect Claude.ai to **{shop_name}**"
  - Body: "Claude.ai is asking for read-only access to your Calderyn data: alerts, audit log, campaigns, SKUs, guardrails, and integration status."
  - Two buttons: **Allow** (primary), **Deny** (secondary).
  - Footnote: "You can disconnect this anytime from Settings → Claude connections."
- **Action** (Allow): generate `code = "calc_" + 32 random base32`, insert `mcp_oauth_codes` row with hash, redirect to `{redirect_uri}?code={code}&state={state}`.
- **Action** (Deny): redirect to `{redirect_uri}?error=access_denied&state={state}`.

### 8.2 New: `app/routes/oauth.token.tsx` (POST, public)

- Validates `grant_type ∈ {authorization_code, refresh_token}`.
- For `authorization_code`: load row by `code_hash`, check `expires_at`, `consumed_at is null`, `redirect_uri` matches, recompute PKCE challenge from `code_verifier`. On success: flip `consumed_at`, mint access + refresh tokens, insert `mcp_tokens` row, return `application/json` with `access_token`, `refresh_token`, `expires_in: 7776000`, `token_type: "Bearer"`, `scope: "read"`.
- For `refresh_token`: look up by `refresh_hash`, mint new pair, delete old `refresh_hash` (rotation), update `expires_at` on the same row.

### 8.3 New: `app/routes/oauth.register.tsx` (POST, public)

- Validates the DCR payload: `client_name`, `redirect_uris` (array, all HTTPS, all valid URIs), optional `software_id`, `software_version`. Caps at 5 redirect URIs to prevent abuse.
- Generates `client_id`, inserts row, returns `{client_id, client_name, redirect_uris, token_endpoint_auth_method: "none"}`. No `client_secret` (public client).
- Anonymous endpoint, but it's database-write so it gets a basic Vercel KV rate limit: 10 registrations per IP per hour.

### 8.4 New: `app/routes/[.]well-known.oauth-authorization-server.tsx`

Returns the static JSON in §6.2. Remix file naming convention for dotted paths: `[.]well-known.oauth-authorization-server.tsx`.

### 8.5 Revised: `app/routes/app.mcp.tsx`

Top of page becomes two-column:

```
┌────────────────────────────────────┬───────────────────────────────────┐
│  Connect via Claude.ai (Recommended)│  Connect via bearer token         │
│                                    │                                   │
│  In Claude.ai → Add connector →    │  Generate a token below and paste │
│  paste this URL:                   │  it into your custom MCP client.  │
│  [ calderyn-mcp.vercel.app/mcp ]   │  Read-only.                        │
│  [Copy URL]                        │                                   │
└────────────────────────────────────┴───────────────────────────────────┘
```

Below, two cards:

1. **Connected Claude.ai workspaces** — rows where `auth_type='oauth'`. Columns: client name, connected at, last used, **Disconnect** (revokes the access + refresh tokens for that row).
2. **Bearer tokens** — existing list, unchanged.

### 8.6 Nav link

Wire `/app/mcp` into the app nav as **Claude connections**. Today it's invisible.

## 9. Errors & observability

### 9.1 Error mapping

| Where | Failure | HTTP | Response shape |
|---|---|---|---|
| `/oauth/authorize` | bad client_id / redirect_uri | 400 | HTML error page, no redirect |
| `/oauth/authorize` | other invalid params | 302 → redirect_uri with `?error=invalid_request` |
| `/oauth/authorize` | merchant clicks Deny | 302 → redirect_uri with `?error=access_denied` |
| `/oauth/token` | expired code, consumed code, PKCE mismatch, wrong redirect_uri | 400 | `{error: "invalid_grant"}` |
| `/oauth/token` | unknown grant_type | 400 | `{error: "unsupported_grant_type"}` |
| `/oauth/register` | malformed payload | 400 | `{error: "invalid_client_metadata"}` |
| `/mcp` | expired / revoked / unknown token | 401 | `WWW-Authenticate: Bearer error="invalid_token"` |

### 9.2 Logging

Vercel runtime logs only. Structured line per OAuth event:

```
{ ts, request_id, endpoint, client_id?, shop_id?, ok, error_code? }
```

No PII. No raw codes, tokens, or PKCE verifiers ever logged — only their hashes.

### 9.3 What stays as-is

`/mcp` request logging, `/healthz`, tool-error mapping — all unchanged from the original spec.

## 10. Testing

Mirror the original spec's bar: Vitest, hand-rolled fakes.

| Layer | Focus | Lives in |
|---|---|---|
| PKCE math | `S256` happy path, mismatched verifier, malformed challenge | shopify-app |
| Authorize loader | param validation, redirect_uri whitelist, malformed → 400 | shopify-app |
| Authorize action | code insertion, hash matches, expiration set | shopify-app |
| Token endpoint | code single-use, expired code rejection, PKCE verify, refresh rotation, refresh replay | shopify-app |
| DCR | URI validation, rate limit, client persistence | shopify-app |
| MCP introspection | OAuth token accepted, expired OAuth token rejected, bearer still works (regression) | calderyn-mcp |
| Manual integration | `npx @modelcontextprotocol/inspector` against preview URLs with a real Claude.ai connector | both — documented in README |

## 11. Rollout

1. Apply the three migrations to staging Supabase (this repo is testing-on-prod per memory; "staging" = prod-with-test-shop).
2. Push the new shopify-app routes behind feature flag `MCP_OAUTH_ENABLED` (env-gated default OFF). Verify the well-known doc returns valid JSON and the `/oauth/authorize` page renders without errors.
3. Rebuild `calderyn-mcp` source from the original spec + add the well-known resource doc + the `expires_at` check in middleware. Push to the existing Vercel project (URL/alias unchanged).
4. Manually walk the flow end-to-end with `@modelcontextprotocol/inspector` and a real Claude.ai Pro account.
5. Flip `MCP_OAUTH_ENABLED=true` in prod. Add the two-column banner + the connected-workspaces card to `/app/mcp`. Wire nav link.
6. Update README + the `/app/mcp` page copy with the new connect flow.

Bearer tokens continue to work throughout; no merchant action required during rollout.

## 12. Forward-compat for Piece C (write tools)

This spec does not implement write tools, but the design must not paint Piece C into a corner:

- **Scopes column on `mcp_tokens`** already supports a list. Piece C adds `write:safe`, `write:money` without migration. The consent screen will need a scopes section.
- **`mcp_oauth_clients`** has no scope cap — Piece C can request expanded scopes per DCR if needed.
- **Action routing decision (a) vs (b)** from the original spec remains open. Piece C resolves it.
- **2FA-over-MCP** — Piece C will introduce a "pending action" pattern: the MCP server returns `{pending: true, confirm_url: "..."}`, merchant clicks the URL inside their admin to approve, the action then runs through the existing `calderynClient(shop).actions.execute` guardrail. None of that pattern conflicts with what this spec ships.

## 13. Definition of done

- A Claude.ai Pro user adds the connector URL, sees the Calderyn consent screen on `app.calderyncompany.com`, clicks Allow, and starts asking Claude questions about their shop.
- The bearer-token flow at `/app/mcp` still works for at least one custom MCP client (manually verified with `@modelcontextprotocol/inspector`).
- Disconnecting from `/app/mcp` makes the next Claude request return 401.
- An expired access token is silently refreshed by Claude.ai using the refresh token; merchant sees no break.
- A revoked refresh token cannot be used twice (rotation invariant).
- Nav link to `/app/mcp` is visible in the app nav as **Claude connections**.
- ADR `docs/adr/0002-mcp-oauth-2-1.md` committed documenting: rebuild-not-recover, OAuth endpoints in shopify-app, public-client + DCR, refresh rotation, scopes-list forward-compat for Piece C.

## 14. Open questions resolved

| Question | Resolution |
|---|---|
| Recover lost `calderyn-mcp` source or rebuild from spec? | Rebuild. Faster, cleaner, original spec is detailed enough. |
| Where does the OAuth authorize endpoint live? | shopify-app — that's where Shopify session lives. |
| Static client config or DCR? | DCR. Required for the polished "Add connector" Claude.ai UX. |
| Public client or confidential? | Public. PKCE is the boundary. No client secrets. |
| Refresh tokens? | Yes, with rotation. |
| Bearer-token flow's fate? | Keep. Power-user escape hatch. |
| Token table — extend or new? | Extend `mcp_tokens` with `auth_type`, `client_id`, `expires_at`, `refresh_hash`. Same introspection path for both auth modes. |
| Shop-identity binding | At `/oauth/authorize`, via existing Shopify OAuth. `?shop=` shortcut if present, otherwise small "which shop?" form. |
| Code lifetime | 60 seconds. Standard. |
| Access token lifetime | 90 days. Long enough that refresh is rare, short enough that compromise has a ceiling. |
| Refresh token lifetime | 1 year, rotating. |
| Scopes in v1 | `read` only. List shape future-proof for Piece C. |
| Nav discoverability | Add `/app/mcp` to nav as "Claude connections". |
| Write tools in this spec? | No. Piece C, separate spec. |

## 15. Coordination

Files touched in this repo:

- `app/routes/oauth.authorize.tsx` (new)
- `app/routes/oauth.token.tsx` (new)
- `app/routes/oauth.register.tsx` (new)
- `app/routes/[.]well-known.oauth-authorization-server.tsx` (new)
- `app/routes/app.mcp.tsx` (revise)
- `app/lib/mcp_oauth.server.ts` (new — code/token/refresh CRUD)
- `app/lib/mcp_tokens.server.ts` (extend for new columns)
- `app/lib/nav.ts` or wherever the nav is defined (add link)
- `supabase/migrations/20260608120000_mcp_oauth_clients.sql` (new)
- `supabase/migrations/20260608120100_mcp_oauth_codes.sql` (new)
- `supabase/migrations/20260608120200_mcp_tokens_oauth_columns.sql` (new)
- `docs/adr/0002-mcp-oauth-2-1.md` (new)
- `.env.example` (add `MCP_OAUTH_ENABLED`)

Files touched in `calderyn-mcp`:

- Entire repo, rebuilt from the 2026-05-25 spec.
- One addition beyond the original spec: `app/.well-known/oauth-protected-resource` route returning the JSON in §6.2.
- One addition to introspection middleware: `expires_at` check.
