# ADR 0001: Ship `calderyn-mcp` as a separate Vercel project

**Status:** Accepted — 2026-05-25
**Spec:** `docs/superpowers/specs/2026-05-25-mcp-server-design.md`

## Context

We need to expose calderyn's per-shop operational data (alerts, audit, campaigns,
SKUs, guardrails, integrations) over the Model Context Protocol so external
agents (Claude.ai connectors, custom agents) can ground themselves in a
merchant's calderyn state. The first version is read-only; write tools are
designed-for but not implemented.

Three placement options were on the table:

1. **Inline in the Remix app** as additional routes.
2. **Supabase Edge Function**.
3. **Separate Vercel project** sharing the same Supabase backend.

## Decision

**Option 3.** A new repo `calderyn-mcp` deployed as a sibling Vercel project,
talking to the same Supabase project via service-role key.

We also commit to:

- **Type and mapper duplication** between `shopify-app` and `calderyn-mcp` for v1.
  Both files (`src/types.ts`, `src/data/mappers.ts`) carry a header comment
  pointing at the source-of-truth in `shopify-app`. Promotion to a shared
  `@calderyn/types` package happens when **a third consumer appears** OR
  **the types remain stable for 60 days** without churn.
- **Service-role + mandatory `shopId` closure** as the data-access posture.
  The reader factory `calderynReader(shopId)` is the only module that holds
  a Supabase client and a `shop_id` at once; tool handlers cannot bypass
  scoping. RLS as a defense-in-depth layer is deferred to v2.
- **Mutation guardrails live in exactly one place.** `calderyn-mcp` will
  **not** reimplement 2FA, daily budget caps, cooldowns, business hours, or
  idempotency. Because `calderyn-mcp` is a separate repo and cannot import
  `shopify-app` source directly, the v2 implementation choice is deferred:
  - (a) `shopify-app` exposes an internal authenticated HTTP endpoint that
    `calderyn-mcp` calls to execute actions; guardrails stay co-located with
    `calderynClient(shop).actions.execute`.
  - (b) Guardrail logic is factored out into a shared `@calderyn/actions`
    package consumed by both repos.
  v1 commits only to the rule. The (a) vs (b) decision is taken when the
  write-tools workstream begins.

## Consequences

**Positive.**

- No bundle bloat in the Remix admin app; the MCP server scales independently.
- Hono streaming gives clean Streamable HTTP transport without forcing Remix.
- Promotes the Supabase project to true source-of-truth — `shopify-app` is
  no longer the only consumer.

**Negative.**

- Two repos to keep in sync for shared shapes. Mitigated by the duplication
  policy above + drift-detector tests in `calderyn-mcp` mappers.
- Two Vercel projects to deploy and observe. Acceptable; Vercel logs and
  project URLs cover v1 observability.
- The write-tools choice (a) vs (b) is deferred, which is a known unknown.

## Alternatives considered

- **Inline in Remix.** Rejected: MCP streaming and Remix loader/action
  patterns are mismatched; adding `@modelcontextprotocol/sdk` to the admin
  bundle is wrong, and Shopify admin auth would have to be bypassed
  per-request anyway.
- **Supabase Edge Function.** Rejected: cold-start variance hurts streaming;
  Deno runtime constrains library choice; logging/observability is weaker
  than Vercel Fluid Compute for this use case.
