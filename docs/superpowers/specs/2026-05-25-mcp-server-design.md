# Design: `calderyn-mcp` — Hosted MCP Server for Calderyn

**Date:** 2026-05-25
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (token UI + ADR only) + new sibling repo `calderyn-mcp`

---

## 1. Goal

Expose calderyn's shop-scoped operational data (alerts, audit log, campaigns, SKUs, guardrails, integrations) over the Model Context Protocol so external agents — Claude.ai connectors, custom agents, future calderyn-built agents — can ground themselves on a merchant's calderyn state.

**v1 is read-only.** The action surface (`pause_campaign`, `reduce_budget`, `undo`, etc.) and its scope/guardrail integration are designed-for in the auth model but not implemented in this spec.

A future Shopify admin block will consume the same data through the same tools, sliced by Shopify resource GID. v1 designs for that with non-breaking optional parameters; it does not build the admin block.

## 2. Non-goals

- Action/write tools
- OAuth 2.1 authorization server
- Shopify admin UI extension
- Rate limiting, per-request audit log, multi-region routing
- Caching layer
- End-to-end tests against live Supabase
- Surfacing raw Shopify Admin API data (Shopify's own MCP covers that)

## 3. Topology

A new repo `calderyn-mcp` deployed as a sibling Vercel project to `shopify-app`, talking to the same Supabase project.

```
[Agent / Claude.ai] --HTTPS+Bearer--> [calderyn-mcp on Vercel] --service-role--> [Supabase Postgres]
                                                                     ^
                                                                     |
                                       [calderyn on Vercel] ---------+
                                          (token UI writes to mcp_tokens)
```

### 3.1 Stack
- Node 20, ESM, TypeScript strict.
- **Hono** as the HTTP framework. First-class streaming for the MCP Streamable HTTP transport; deploys natively on Vercel Functions. No second Remix install.
- `@modelcontextprotocol/sdk` for the MCP server primitives.
- `@supabase/supabase-js`, pointed at the same project as calderyn.
- Vercel Fluid Compute, region pinned to the Supabase region for latency. Function timeout left at the platform default (300s) — enough headroom for any streaming MCP session.

### 3.2 Repo layout

```
calderyn-mcp/
├── api/
│   └── [[...slug]].ts     # Vercel entry; mounts the Hono app
├── src/
│   ├── server.ts          # Hono app, /mcp handler, /healthz
│   ├── mcp/
│   │   ├── server.ts      # createMcpServer() — registers tools + resources
│   │   ├── tools.ts       # tool definitions (read-only v1)
│   │   └── resources.ts   # resource definitions
│   ├── data/
│   │   ├── supabase.ts    # client factory (singleton per Fluid instance)
│   │   ├── calderyn.ts    # calderynReader(shopId) — read queries
│   │   └── mappers.ts     # row → domain type, mirrored from calderyn
│   ├── auth/
│   │   ├── token.ts       # bearer token middleware → {shop_id, scopes}
│   │   └── oauth.ts       # placeholder, v2
│   ├── types.ts           # mirrored domain types
│   └── errors.ts          # CalderynError + MCP error mapping
├── package.json
├── tsconfig.json
├── vercel.json
├── vitest.config.ts
├── CLAUDE.md              # per-repo pre-commit gate
└── README.md
```

### 3.3 Type duplication call

`src/types.ts` and `src/data/mappers.ts` are **copied** from `shopify-app/app/lib/types.ts` and the `rowTo*` functions in `shopify-app/app/lib/calderyn.server.ts` (lines ~67–125). Both files carry a header comment pointing at the source.

Trigger condition for promotion to a shared `@calderyn/types` package: a third consumer appears, OR the types remain stable for 60 days without churn. Documented in the ADR (§9).

## 4. Auth

### 4.1 Token format

`mcp_live_<32 random base32 chars>`. Stripe-style prefix simplifies secret scanning. `live` slot leaves room for `mcp_test_*` if a sandbox tier ever ships.

### 4.2 Table: `mcp_tokens` (Supabase)

```sql
create table mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references shops(id) on delete cascade,
  name text not null,
  token_hash text not null unique,    -- HMAC-SHA256(raw, MCP_TOKEN_PEPPER)
  token_prefix text not null,         -- e.g. "mcp_live_abc1"
  scopes jsonb not null default '["read"]'::jsonb,
  created_by_user text,               -- shopify user id of creator
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  last_user_agent text,
  revoked_at timestamptz
);
create index on mcp_tokens (shop_id) where revoked_at is null;
```

Hashed at rest; raw token shown to the merchant exactly once at creation. Pepper lives in MCP server env, not in DB.

### 4.3 Middleware (`src/auth/token.ts`)

1. Read `Authorization: Bearer <token>` — 401 if missing/malformed.
2. `hash = hmac_sha256(token, MCP_TOKEN_PEPPER)`.
3. `select shop_id, scopes, revoked_at from mcp_tokens where token_hash = $1`. Not found or revoked → 401.
4. Attach `{shop_id, scopes}` to request context.
5. Fire-and-forget update of `last_used_at` (debounced: only write if existing value is older than 60s) and `last_user_agent` (truncated to 64 chars) when it changes.

There is no code path through the MCP server that reads Supabase without first establishing `shop_id` via this middleware.

### 4.4 Token-management UI in calderyn

New route `app/routes/app.mcp.tsx`:

- Polaris table: name, prefix (`mcp_live_abc1…`), scopes, last used, created, created-by, **Revoke** button (sets `revoked_at`).
- "Generate token" button opens a modal that collects a name. Action handler inserts the row and returns the raw token to a follow-up modal view with copy-to-clipboard and a "this will not be shown again" notice.
- Loader and action use the existing supabase client from `app/lib/supabase.server.ts`. No Prisma touch — `mcp_tokens` is Supabase-owned, consistent with the rest of the schema.

### 4.5 Forward-compat for OAuth 2.1

Middleware switches on token format:

- `mcp_live_*` → bearer path described above.
- Opaque token → introspection path against a future authorization server (lives in calderyn-mcp, v2).

Both resolve to the same `{shop_id, scopes}` context, so tool handlers do not know which auth was used. v2 also adds `/.well-known/oauth-authorization-server` for Claude.ai connector discovery.

### 4.6 What's not in v1

- Rate limiting. Read-only + per-shop scoping limits the abuse surface; Vercel's platform-level DDoS is sufficient. Add a per-token cap (e.g. 100 req/min via Vercel KV) when real traffic warrants.
- Per-request audit log. Vercel runtime logs cover v1.

## 5. MCP surface

The MCP exposes calderyn's calculated state, not raw Shopify data.

### 5.1 Resources

| URI | Returns | Default scope |
|---|---|---|
| `calderyn://alerts` | Open alerts | `status=open`, limit 50, ordered by `claude_rank` |
| `calderyn://alerts/{id}` | Single alert with full evidence | — |
| `calderyn://audit` | Recent audit entries | limit 50, newest first |
| `calderyn://campaigns` | All campaigns | — |
| `calderyn://skus` | All SKUs | — |
| `calderyn://guardrails` | Guardrail config + today's usage | singleton |
| `calderyn://integrations` | Connection status of Meta / Google / QuickBooks | — |

All resources are `mimeType: "application/json"`.

### 5.2 Tools

All tools return `structuredContent` with a typed output schema mirroring `app/lib/types.ts`.

| Tool | Inputs | Output |
|---|---|---|
| `list_alerts` | `status?`, `severity?`, `detector_id?`, `limit?` (≤200, default 50) | `{ alerts: Alert[] }` |
| `get_alert` | `id: string` | `{ alert: Alert }` |
| `list_audit` | `limit?`, `since?` (ISO), `detector_id?` | `{ entries: AuditEntry[] }` |
| `list_campaigns` | `status?: "active" \| "paused"` | `{ campaigns: Campaign[] }` |
| `list_skus` | `sku_id?`, `low_cover_only?: boolean` | `{ skus: SKU[] }` |
| `get_guardrails` | — | `{ guardrails: GuardrailConfig }` |
| `list_integrations` | — | `{ integrations: Integration[] }` |

**`limit` is hard-capped at 200** to keep agent context manageable. Default 50.

Each tool ships with a multi-sentence description that tells the agent when to call it (vs. another tool) and how to interpret the output. These are first-class deliverables, not afterthoughts — they're the difference between an agent that uses the MCP usefully and one that flounders.

### 5.3 Forward-compat for admin-block context

v2 will add an optional `shopify_resource_gid?: string` filter to `list_alerts`, `list_audit`, and `list_skus`. Adding an optional field to an MCP tool's input schema is non-breaking. The param is **not** added in v1 — unused parameters are clutter.

### 5.4 Forward-compat for write tools (v2)

Future mutation tools follow:

```
execute_action(kind, params, idempotency_key, dry_run?)
undo_action(audit_id, idempotency_key)
acknowledge_alert(id)
snooze_alert(id, until)
```

Gated by token scope (`write:safe`, `write:money`). The v1 token table's `scopes` column already supports this; no schema migration needed.

**Hard architectural rule:** mutation guardrails — 2FA, daily budget caps, cooldowns, business hours, idempotency — live in **exactly one place**. `calderyn-mcp` will not reimplement them.

`calderyn-mcp` is a separate repository and cannot import calderyn source directly, so the v2 implementation choice is deferred:

- **(a)** calderyn exposes an internal authenticated HTTP endpoint that the MCP calls to execute actions; guardrails stay co-located with the existing `calderynClient(shop).actions.execute`.
- **(b)** guardrail logic is factored out of calderyn into a shared `@calderyn/actions` package consumed by both repos.

v1 commits only to the rule — "MCP will not reimplement guardrails" — and defers the (a) vs (b) choice until the write-tools workstream begins.

### 5.5 Explicitly not exposed in v1

- Action execution paths (`alerts.action`, `audit.undo`, `actions.execute`)
- `integrations.startOAuth` / `disconnect`
- `onboarding.*`
- `internal.forwardWebhook`
- Raw Shopify Admin API

## 6. Data access

### 6.1 Tables / views read

Identical to calderyn — no new database objects:
- `v_alerts_view`
- `v_audit_view`
- `v_campaigns_flat`
- `v_skus_flat`
- `guardrail_config`
- `shop_integrations`

### 6.2 Posture

Supabase service-role key, with shop scoping enforced in code by closing the reader over `shopId`:

```ts
// src/data/calderyn.ts
export function calderynReader(shopId: string) {
  return {
    alerts: { list, get },
    audit: { list },
    campaigns: { list },
    skus: { list },
    guardrails: { get },
    integrations: { list },
  };
}
```

Tool handlers receive `shopId` from the token middleware and call `calderynReader(shopId).…`. The raw supabase client is not exported from the data layer — no other path exists from a tool handler to Supabase. Auditing cross-tenant leak risk reduces to reviewing `src/data/calderyn.ts`.

RLS as a defense-in-depth layer is deferred to v2; adding policies retroactively risks breaking calderyn and is a separate workstream.

### 6.3 No `resolveShopId`

Calderyn's `calderynClient(shop)` resolves a shop domain to a UUID. The MCP skips this — the token row already has `shop_id`. One fewer lookup per request.

### 6.4 Output shape

`rowTo*` mappers are copied from calderyn into `src/data/mappers.ts`. Tests (§8) act as a drift detector if calderyn's view shapes change.

### 6.5 Connection management

One `createClient()` per Vercel Fluid Compute instance, reused across concurrent invocations. No per-request client construction.

### 6.6 No caching in v1

Direct Supabase reads on every tool call. Sub-100ms latencies on these views; typical session calls 5–20 tools. Vercel runtime cache with `shop_id` in the key + tag-based invalidation is the v2 path if needed.

## 7. Errors & observability

### 7.1 Error taxonomy

| Class | When | HTTP | MCP response |
|---|---|---|---|
| Auth | Missing/invalid/revoked token | 401 | Transport-level 401 (OAuth challenge in v2; plain JSON in v1) |
| Tool error | `ALERT_NOT_FOUND`, bad filter, etc. | 200 | `isError: true`, text content `{ code, message }` |
| Server error | Supabase down, unhandled exception | 500 | MCP transport-level error; client retry is safe (read-only) |

`CalderynError.code` is the public contract for tool errors. The agent sees `ALERT_NOT_FOUND`; it does not see inner Supabase diagnostics. Those go to logs only.

### 7.2 Logging

Vercel runtime logs only. One structured line per request at completion:

```
{ ts, request_id, shop_id, tool, duration_ms, ok, error_code? }
```

`request_id` is UUID v7, included in every error response so a merchant report yields a greppable string. `shop_id` is the UUID, not the domain. **No PII in logs** — no alert titles, SKU names, or campaign names.

### 7.3 Healthcheck

`GET /healthz` → `{ ok: true, ts }` if Supabase is reachable (one `select 1`), `503` otherwise. Mirrors `shopify-app/app/routes/healthz.tsx`.

### 7.4 Deferred to v2

- Per-request audit-log table
- Alerting / paging
- Per-tool metrics dashboard

## 8. Testing

Calderyn has no test suite today, so `calderyn-mcp` sets the bar. Keep it light.

### 8.1 Setup

- **Vitest**, ESM-native. One `vitest.config.ts` at repo root. `*.test.ts` collocated with source.
- No supabase mocking library — hand-rolled `vi.fn()` fakes are clearer for a data layer this thin.

### 8.2 Test categories (priority order)

1. **Row mappers** — pure functions, highest ROI. Happy path, null/missing fields, type coercion. Acts as a drift detector against calderyn.
2. **Token middleware** — missing header, malformed header, valid + active, valid + revoked, valid + unknown hash, prefix lookup, debounce logic. Fake supabase client returning canned rows.
3. **Tool handlers** — one test per tool: input-schema rejection, reader called with correctly transformed filters, output matches declared schema. Reader is faked; not end-to-end.
4. **MCP server registration** — boot the server, call `tools/list` and `resources/list` via the in-process MCP client, assert catalog count/names/descriptions. Catches "tool renamed in code but forgotten in registration".
5. **Manual integration** — `npx @modelcontextprotocol/inspector` against a preview URL with a real test token. Documented in README, not in CI.

### 8.3 Out of scope for v1

- E2E against live Supabase
- Load tests
- Multi-tenant isolation fuzz tests (architecturally impossible to leak — no input parameter overrides shop scope. Add when write tools land.)

### 8.4 Pre-commit gate for `calderyn-mcp`

Mirrors calderyn's philosophy, in this order:

1. `npm run typecheck` → exit 0
2. `npm run lint` (`--max-warnings=0` for new code) → exit 0
3. `npm run test` (vitest run) → exit 0

Vercel handles the build at deploy time — no local `build` step.

This goes into `calderyn-mcp/CLAUDE.md` so future agent work in that repo respects it.

## 9. Coordination & changes in `shopify-app`

Minimal:

1. **`app/routes/app.mcp.tsx`** — Polaris token-management page (§4.4).
2. **`docs/adr/0001-mcp-server-split.md`** — captures:
   - Decision to ship MCP as a separate Vercel project rather than inline.
   - "Duplicate domain types and mappers with sync comment" choice + promotion trigger (third consumer OR 60-day stability).
   - "Service role + mandatory `shopId` closure" data-access posture.
   - Hard architectural rule: mutation guardrails live in exactly one place; `calderyn-mcp` will not reimplement them. The (a) internal endpoint vs (b) shared `@calderyn/actions` package choice is deferred to the v2 write-tools workstream.

No changes to `shopify.server.ts`, no webhook changes, no Prisma schema changes.

## 10. Rollout

1. Apply the `mcp_tokens` migration to staging Supabase.
2. Ship the token UI in calderyn. Merchants can mint tokens before any server validates them — harmless because no client knows the MCP URL yet. Lets the UI be QA'd in isolation.
3. Deploy `calderyn-mcp` to a preview URL. Manual smoke with `@modelcontextprotocol/inspector` + a real token.
4. Promote to production behind a stable domain (e.g. `mcp.calderyn.app`).
5. Document the connection flow in calderyn's `README.md` and inline on the token page.

## 11. Definition of done (v1)

- A merchant opens calderyn → MCP page → mints a token → pastes into a custom MCP client → calls `list_alerts` and gets their shop's alerts, only their shop's alerts.
- The same merchant cannot get another shop's data even by guessing alert IDs (architecturally impossible: reader closes over `shopId`).
- Token revocation takes effect on the next request.
- `calderyn-mcp/CLAUDE.md` exists with the per-repo pre-commit gate.
- ADR committed in `shopify-app/docs/adr/`.

## 12. Open questions resolved during brainstorming

- **MCP client:** hosted multi-tenant HTTP MCP.
- **Scope:** read-only v1, write-ready interface for v2.
- **Extension role:** MCP only in v1; tool/resource shapes future-proofed for the admin block (no params added yet).
- **Auth:** per-shop bearer token v1, OAuth 2.1 layered later.
- **Topology:** separate `calderyn-mcp` Vercel project (vs. inline in Remix or Supabase Edge Function).
- **Type sharing:** duplicate + sync comment in v1; promote to package on third consumer or 60-day stability.
- **Token table location:** Supabase (not Prisma) — consistent with calderyn's "Supabase is source of truth, Prisma is client" split.
- **ADR location:** `shopify-app/docs/adr/` — the decision is from calderyn's perspective.
- **Token UI vs MCP shipping order:** UI first, MCP second. No risk because raw tokens are useless without the MCP URL.
