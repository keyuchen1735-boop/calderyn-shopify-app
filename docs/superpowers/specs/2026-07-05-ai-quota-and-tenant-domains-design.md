# AI quota gate + tenant subdomain auto-registration — design

Date: 2026-07-05. Approved conversationally by John (showcase cost-protection plan). Two independent features, one worktree/branch each.

## Feature 1 — AI quota gate (`feat/ai-quota-gate`)

**Problem.** Showcase signups can spam the paid Anthropic endpoints (store designer, assistant, listing drafts). Existing per-minute `rateLimit()` buckets bound burst rate but not daily spend; one route (`dashboard.builder.generate.tsx`) has no limit at all. Target: worst case ~$1/day per account, enforced server-side.

**Approach.** Layer daily caps + cooldowns over the existing Postgres fixed-window limiter (`rate_limit_touch` RPC via `app/lib/rate-limit.server.ts`). No new tables or migrations; 86,400s windows align to midnight UTC. Fails open by design (consistent with the limiter; the Anthropic workspace spend limit is the hard backstop).

**New module** `app/lib/ai-quota.server.ts`:

- `checkAiQuota({ shopId, feature, trusted })` → `{ allowed } | { allowed:false, code, message }`.
- Features and limits (constants):

| feature | cooldown | daily (base) | daily (trusted) |
|---|---|---|---|
| `designer` (store generation) | 20s | 5 | 20 |
| `assistant` (chat, both surfaces) | 4s | 30 | 300 |
| `listing` (listing drafts) | 3s | 30 | 200 |

- Bucket keys: `ai:cd:<feature>:<shopId>` (cooldown, limit 1) and `ai:day:<feature>:<shopId>` (daily). Cooldown is checked first so hammering burns the cooldown, not the daily allowance.
- Trust tier: `trusted` = Shopify-embedded session (`userId === null`) or first-party account older than 7 days (`users.created_at`, surfaced on the dashboard session). Email verification is already a hard gate at the API door, so it is not a tier. Caveat: the shared demo account (created 2026-07-04) graduates to trusted 2026-07-11.

**Session change.** `DashboardSession` gains `accountCreatedAt: string | null`, read from the existing `user:users(...)` embed in `getSessionFromRequest` (no extra query; `null` for Shopify sessions).

**Enforcement points** (each after the existing per-minute limit, before the Anthropic call; 429 with the friendly message):

- `dashboard.api.store.tsx` `generate` case → `designer`
- `dashboard.builder.generate.tsx` → add missing per-minute limit (5/min, same as store route) + `designer`
- `dashboard.api.listing-draft.tsx` → `listing`
- `dashboard.api.assistant.tsx` → `assistant`
- `app.assistant.tsx` (embedded) → `assistant`, keyed by `resolveShopId(session.shop)` so both surfaces share one daily bucket; trusted.

Out of scope (noted follow-up): screener routes (`dashboard.api.campaigns.$id.{screen,regenerate,score}` + embedded twins) have no rate limiting today; they sit behind connected ad accounts so they are not showcase-exposed.

**Errors.** Reuse `jsonError(429, code, message)` envelope (codes `ai_cooldown`, `ai_daily_limit`); clients already surface `message` for the existing `rate_limited` code.

**Testing.** Co-located vitest unit test mocking `rateLimit` — verifies cooldown-before-daily ordering, tier cap selection, bucket key shapes, fail-open passthrough.

## Feature 2 — tenant subdomain auto-registration (`feat/tenant-domain-autoregister`)

**Problem.** Wildcard DNS (`*.calderyncompany.com`) already points at Vercel, but Vercel serves only hostnames added to the project, so every new shop needs the manual `vercel domains add <slug>.calderyncompany.com` step (docs/DOMAINS.md). New tenants' storefront URLs fail TLS until someone runs it.

**Approach.** New module `app/lib/storefront/vercel-domain.server.ts`: `registerTenantDomain(orgSlug)` POSTs `{ name: "<slug>.calderyncompany.com" }` to `https://api.vercel.com/v10/projects/{VERCEL_PROJECT_ID}/domains` (Bearer `VERCEL_TOKEN`, optional `?teamId=VERCEL_TEAM_ID`, 5s timeout). Returns boolean, never throws: "already exists/in use" responses count as success-or-benign, other failures log and return false. No-op with a warning when `VERCEL_TOKEN` is unset (local dev, CI).

**Call site.** Inside `provisionOwnedShop` (`app/lib/auth/tenant.server.ts`) after `seedShippedAutopilotFeatures` — best-effort, must never fail signup (same posture as `sendVerificationEmail(...).catch()`). Covers both signup routes and the demo script.

**Backfill.** `scripts/backfill-tenant-domains.mjs` registers domains for existing shops with `org_slug` set and no `uninstalled_at` (one-time, idempotent).

**Env.** `.env.example` gains `VERCEL_TOKEN`, `VERCEL_PROJECT_ID` (Vercel project `shopify-app`), `VERCEL_TEAM_ID` (optional). docs/DOMAINS.md updated: automatic at signup; manual command remains for one-offs.

**Dashboard visibility.** Studio payload gains `storefrontUrl` (`https://<org_slug>.calderyncompany.com` when the shop has an `org_slug`, else null); the Store screen's "open storefront" link prefers it over the relative `/storefront`. (`NewProductFlow`'s cosmetic client-derived slug display is a noted follow-up, not in scope.)

**Testing.** Unit test with mocked `fetch`: success, already-exists-as-benign, hard-failure logging, missing-token no-op.

## Parity

Both features are server-side in this repo, which is also the dashboard codebase. The assistant gate covers both the dashboard and embedded surfaces; the designer exists only on the dashboard by design. No `Mezoh/calderyn-waitlist` changes (no proxy/CSP change).
