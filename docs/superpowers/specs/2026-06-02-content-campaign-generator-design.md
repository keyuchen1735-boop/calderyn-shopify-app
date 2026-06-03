# Design: AI Content Campaign Generator (Slice 1 -- Brand Memory + Generation + Review Queue, no publishing)

**Date:** 2026-06-02
**Status:** Draft -- awaiting user review
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY`
**Session:** #3 (campaign generator) in the multi-session build

> Encoding note: this document is intentionally ASCII-only (no em dashes, arrows,
> or section signs) so it renders identically in every editor and stays
> trustworthy as the source of truth.

---

## 1. Context

Feature #3 lets a merchant auto-generate marketing campaigns from a remembered
brand identity and publish them to Instagram, TikTok, YouTube, and Facebook with
a one-click human approval before anything goes live. The full feature is large
and crosses four external platform-review gates, so it is decomposed into slices
(Sec 13). **This spec is Slice 1 only: the gate-free foundation** -- a brand
memory store, AI generation of copy + images, and a draft/review queue. It ships
value on its own: a merchant generates on-brand campaign assets, reviews them,
and copies/downloads them. No social publishing in this slice.

Research backing the design choices below (auth gates per platform, brand-memory
modeling, image/video provider survey, human-in-the-loop norms) was gathered in
the brainstorming session on 2026-06-02 and summarized in the conversation; the
gate findings drive the slicing in Sec 13.

## 2. Goal & success criteria

1. A merchant can edit a **brand memory** (voice, audience, visual style,
   products, guardrails, examples) at `/app/brand`, seeded on first visit from
   their Shopify shop + products. Edits create a new immutable **version**; one
   version is active per shop.
2. At `/app/studio` a merchant picks a goal, one or more products, and target
   platforms, and the app generates **per-platform** ad copy (structured) plus an
   image conditioned on the product's real Shopify photos.
3. Generated content lands in a **review queue** (`pending_review`) with
   per-asset **risk flags**; the merchant edits, regenerates, approves, or
   rejects each asset. A campaign reaches `approved` only when every asset is
   handled.
4. Approved assets can be **copied/downloaded** (Slice 1 has no publish step).
5. Generation **never originates facts**: price/claims come from brand memory and
   Shopify; any claim the model uses that is not in `guardrails.claims_allowed`
   is flagged and **blocks approval** without an explicit override.
6. Everything is readable through **`calderynClient(shop).content.*`** (DTOs
   shaped at the boundary, no raw Supabase rows), so session #8's assistant can
   later answer "what campaigns are pending review?".
7. Generation cost is controlled by **prompt-caching** the brand-memory block and
   capping variants per run.

## 3. Non-goals

- **Publishing to any platform.** The `Channel` interface + Meta/TikTok/YouTube
  adapters and the approve-then-post flow are Slices 2-4 (Sec 13).
- **Video generation.** Slideshow assembly is Slice 5; generative video later.
- **The learning loop.** Reading back engagement to tune generation is Slice 6,
  and it reads session #2's shared `ad_insight_fact` -- #3 builds no engagement
  schema of its own.
- **A new top-level "campaign" concept that collides with ad campaigns.** The
  existing `Campaign` type is the ad campaign (Meta/Google, `roas_7d`); this
  slice introduces `ContentCampaign` / `ContentAsset` and routes under
  `/app/studio`, never `/app/campaigns` (Sec 4).
- **MCP write tools.** Slice 1 exposes read DTOs only; the MCP tool addition is
  deferred until there is more for the assistant to read.

## 4. Cross-session ownership & coordination (binding)

This slice runs alongside #2 (ad-spend analytics), #4 (constant analysis /
action brain), and #8 (in-app assistant). To avoid collisions:

| Concern | Owner | Contract |
|---|---|---|
| `app/lib/content/*`, `/app/studio`, `/app/brand` | **#3 (this)** | New namespace; no other session writes here. |
| New types (`BrandMemory`, `ContentCampaign`, `ContentAsset`, `Platform`, ...) | **#3 (this)** | Live in **`app/lib/content/types.ts`**. #3 does **not** touch `app/lib/types.ts` (#2 adds analytics types there; #4 owns `DetectorId`/`ActionKind`). |
| Engagement / post-performance data | **#2** | #2 owns `ad_insight_fact` engagement columns; **#3 reads** it in Slice 6, **never writes** it. No #3 engagement schema. |
| `shops` base table | **shop-provisioning** (2026-05-30 spec) | Pre-existing foundation. **#3 does NOT create or alter `shops`** -- it only adds foreign keys to `shops(id)`. If `shops` is absent at implementation that is a shop-provisioning prerequisite to resolve, never a #3 migration. (Removes the #2/#3 "add-if-absent" collision.) |
| Multi-row / versioned writes | **#3 (this)** | Done via Supabase **Postgres functions (RPC)** -- the Supabase analog of `prisma.$transaction`, because supabase-js has no multi-statement transaction (Sec 6.2, 10, 12.1). |
| Migration timestamps | **#3 claims `20260602110000`+** | #2 claimed `...090000`-`093000`; #4 from `...100000`+. #3 starts at `...110000` to stay clear of both. |
| New top-level deps (`@anthropic-ai/sdk`, image-provider SDK) | **#3 (this)** | Flagged per CLAUDE.md (Sec 11). |
| Naming: "campaign" | shared | "Campaign" = ad campaign (existing). #3 always says **ContentCampaign** / studio. |

### 4.1 Database ownership (binding)

- **Tooling:** all three #3 tables are **Supabase-managed** (migrations under
  `supabase/migrations/`). Prisma owns **only** `shopify_sessions`; there is no
  Prisma model for #3 tables and no Prisma codegen.
- **Sole write path:** #3 tables are read/written **only** through
  `app/lib/content/content-client.server.ts`, which uses the server-side
  service-role client (`app/lib/supabase.server.ts`). No route queries these
  tables directly; no client bundle ever imports them.
- **Shop scoping in place of RLS:** the service role bypasses RLS, so **every**
  query MUST filter by `shop_id` (taken from `authenticate.admin`). This is the
  enforced isolation invariant and is asserted in the client tests.
- **`shops` is a dependency, not ours:** #3 references `shops(id)` by foreign key
  only; ownership is shop-provisioning's (Sec 4 table). #3 ships no `shops`
  migration.

## 5. Architecture

Mirrors the established server-module pattern (DTO client at the boundary, pure
mappers/scorers carry the test weight, secrets server-side only). No inbound
Shopify request is needed for generation beyond the authenticated admin loader.

```
/app/brand     --client.content.brand.get/update--> brand_memory (versioned jsonb)
                                                     seeded from Shopify shop + products

/app/studio    pick goal + products + platforms
   -> generate.server.ts
        load active brand_memory  -> serialize.server.ts -> cached prompt prefix
        Claude (structured output, N per-platform variants) -> copy {hook,body,hashtags,cta,claims_used}
        image.server.ts: product photos (Shopify) -> on-brand image + deterministic text overlay
        screen.server.ts: banned words/claims, claims_used not in claims_allowed, missing disclaimer -> risk_flags
   -> write content_campaign(pending_review) + content_asset rows

/app/studio/$id  review queue: per-platform cards, edit / regenerate / approve / reject
                 campaign -> approved when all assets handled; copy/download (no publish)
```

### 5.1 Module layout

`app/lib/content/` (all generation/IO modules are `.server.ts`):

| Module | Responsibility | Pure / testable |
|---|---|---|
| `types.ts` | `BrandMemory`, `ContentCampaign`, `ContentAsset`, `Platform`, `AssetStatus`, `RiskFlag` | n/a (types) |
| `brand-memory.server.ts` | read/write brand memory, versioning, seed-from-Shopify | seam-tested |
| `serialize.server.ts` | **Pure:** brand memory JSON -> deterministic prompt block (sorted keys, stable order) | pure |
| `platform-specs.ts` | **Pure:** per-platform copy rules (max length, hashtag norms, tone, CTA) | pure |
| `generate.server.ts` | Claude structured-output call (injected client); map response -> `ContentAsset` copy; enforce per-platform length | seam-tested (injected fake) |
| `image.server.ts` | image-provider call (injected client) conditioned on Shopify product photos; deterministic text overlay | seam-tested |
| `screen.server.ts` | **Pure:** risk-screen an asset -> `RiskFlag[]` | pure |
| `content-client.server.ts` | DTO assembly for `calderynClient(shop).content.*` | seam-tested |

The Claude integration follows the `claude-api` skill: latest model
(Opus 4.8 / `claude-opus-4-8`), prompt caching of the brand-memory prefix,
`ANTHROPIC_API_KEY` from `process.env` server-side only.

## 6. Brand memory

### 6.1 Model

`brand_memory.content` (jsonb) sections, consumed by the model:

- `identity` -- name, tagline, mission, category, positioning.
- `voice` -- tone[], formality (1-5), person, emoji policy, signature phrases,
  `style_examples[]` (3-8 real "good post" exemplars; few-shot beats adjectives).
- `audience` -- personas with pains/desires/platforms.
- `visual` -- palette (hex+role), fonts, logo asset refs, imagery rules,
  aspect defaults.
- `products` -- name, sku, hero benefits, price, proof points, Shopify photo
  refs, `claims_allowed[]`.
- `guardrails` -- `banned_words[]`, `banned_claims[]`, `required_disclaimers[]`,
  `regulated_category` (bool).
- `examples` -- good/bad posts with reasons.

### 6.2 Versioning (transactional) & seeding

A brand-memory save is a **read-modify-write across rows** (compute next version,
insert it, flip the active flag) and must be atomic and race-safe. supabase-js
has no multi-statement transaction, so this runs as a **Postgres function**
`brand_memory_save(p_shop_id, p_content jsonb)` invoked via RPC -- the Supabase
analog of `prisma.$transaction`. In one transaction it:

1. Takes a per-shop lock `pg_advisory_xact_lock(hashtext(p_shop_id))`, so
   concurrent saves to the same shop **serialize** instead of racing on the
   version number or the active flag.
2. Computes `next_version = coalesce(max(version), 0) + 1` for that shop.
3. Sets the current active row `is_active = false`.
4. Inserts the new row `(version = next_version, is_active = true)` and returns it.

Doing step 3 before step 4 keeps the **one-active-per-shop** invariant true at
every statement boundary, backstopped by the partial unique index
`UNIQUE (shop_id) WHERE is_active` and the `UNIQUE (shop_id, version)` constraint
(Sec 12.1). Old versions are **never updated or deleted** -- they are immutable,
so every asset's `brand_memory_version` reference stays reproducible.

Brand memory has **no separate "draft" state** (distinct from
`content_campaign.status`'s `draft`): every save is a new active version
(editing == saving the next version). On first visit the editor is **pre-filled**
from Shopify (shop name -> `identity`; product titles/prices/images ->
`products`) but **no row is written until the merchant's first save**, which
creates `version = 1`.

### 6.3 Serialization (cache safety)

`serialize.server.ts` is **pure and deterministic** (sorted keys, stable section
order, no interpolated timestamps). The output is placed in the Claude `system`
block with `cache_control` ephemeral; per-request volatile inputs (platform,
goal, product focus, variant count) go **after** the cache breakpoint so the
expensive prefix stays cached. Determinism is unit-tested because a silent
nondeterministic dump would invalidate the cache on every call.

## 7. Generation

### 7.1 Copy (`generate.server.ts`)

- One Claude call per generation run producing **N variants per selected
  platform** via **structured output** (json schema):
  `{ platform, hook, body, hashtags[], cta, claims_used[] }`.
- `platform-specs.ts` injects each platform's rules (IG ~2200 char / <=30
  hashtags; TikTok hook-first native voice; YouTube Shorts title+desc; Facebook
  longer CTA). Length is enforced in code; over-length variants are rejected and
  regenerated, never stored malformed.
- The model is told to use **only** facts present in the serialized brand memory.
  `claims_used[]` is cross-checked in code against `products.claims_allowed`
  (Sec 9). The model is not trusted to self-police.

### 7.2 Image (`image.server.ts`)

- Generate an on-brand image **conditioned on the product's real Shopify photos**
  (reference-image conditioning) so product likeness is preserved -- the model
  does not invent the product.
- **Text in the image** (price, CTA, offer) is rendered by a **deterministic
  overlay** (server-side compositing), not by the image model, so exact copy and
  prices are legally correct and reproducible.
- Provider client is injected; the concrete provider (e.g. a brand-kit-aware or
  multi-reference image API) is a plan-level decision (Sec 13 open items). Output
  stored to object storage; `content_asset.media_url` records it.

## 8. Review queue & UX

`/app/studio/$id` (Polaris):

- **Per-platform cards:** editable copy fields, image preview, **risk-flag
  badges**, "regenerate this part", and approve / reject per asset.
- **Provenance:** each asset shows the `brand_memory_version` and product photos
  it was generated from.
- **Campaign approval:** enabled only when every asset is approved or rejected.
  The approve action **re-validates server-side** in the same request that every
  asset is handled and has no blocking risk flag before flipping
  `content_campaign.status -> approved` (the UI's enable/disable is a convenience,
  not the guarantee). Assets then offer **copy-to-clipboard** and **download**
  (Slice 1 has no publish action; publish buttons arrive in Slice 2).
- **Empty/edge states:** no active brand memory -> prompt to set it up first;
  provider failure -> asset shows `failed` + reason + retry (Sec 10).

## 9. Risk screen (`screen.server.ts`, pure)

Given an asset + active brand memory, returns `RiskFlag[]`:

- `banned_word` -- copy contains a `guardrails.banned_words` entry.
- `banned_claim` -- copy matches a `guardrails.banned_claims` pattern.
- `unverified_claim` -- a `claims_used` entry not in the product's
  `claims_allowed`.
- `missing_disclaimer` -- a `required_disclaimers` entry is absent.

`unverified_claim`, `banned_claim`, and `banned_word` are **blocking**: the asset
cannot be approved while present unless the merchant sets an explicit override
(recorded on the asset for audit). `missing_disclaimer` is blocking for
`regulated_category` shops, warning otherwise.

## 10. Error handling

- Provider (Claude or image) failure -> `content_asset.status = 'failed'` with a
  stored reason; surfaced in the UI; per-asset retry. Never silent.
- Structured-output parse/length failure -> reject + regenerate that variant;
  malformed copy is never persisted.
- Cost guard: variant count per run is capped; brand-memory prefix is cached;
  `usage.cache_read_input_tokens` is logged to confirm caching works.
- A failed run leaves a `content_campaign` in `draft`/`generating` with the
  failed assets visible, not a half-written `pending_review`.
- **Transactional write:** the campaign row and all its asset rows are inserted
  in one transaction via the Postgres function `create_content_campaign(payload
  jsonb)` (Sec 12.1) -- a run never leaves a campaign without its assets or
  assets without a campaign. The transition to `pending_review` happens only
  after all assets are persisted.

## 11. New dependencies & env

- **`@anthropic-ai/sdk`** (copy generation) and one **image-provider SDK/client**
  -- new top-level deps, flagged per CLAUDE.md (justified: core to the feature;
  no lighter alternative for first-party generation).
- New env vars (server-only; add to `.env.example`): `ANTHROPIC_API_KEY` and the
  image-provider key. Never referenced in client bundles.
- An object-storage destination for generated images (Supabase Storage is the
  default candidate; confirmed at plan time).

## 12. Schema changes (Supabase migrations -- CLAUDE.md carve-out)

App-data tables are **Supabase-managed**, not Prisma-managed
(`prisma/schema.prisma` covers only `shopify_sessions`), so they ship via
Supabase migration tooling. No Prisma change -> no Prisma codegen. All three
tables carry `shop_id` with a **foreign key to `shops(id)`** (owned by
shop-provisioning, Sec 4) and `ON DELETE CASCADE` from parent to child within #3
(`content_asset.campaign_id -> content_campaign.id`).

**Transactional integrity:** multi-row and versioned writes go through Postgres
functions (RPC), not multiple supabase-js calls -- this is the project's
substitute for `prisma.$transaction` on Supabase-managed tables (migration 4).

### 12.1 New migrations (claimed timestamps, Sec 4)

1. `20260602110000_brand_memory.sql` -- `brand_memory`
   (`id, shop_id FK shops(id), version int, is_active bool, content jsonb,
   created_at`), `UNIQUE (shop_id, version)`, and the partial unique index
   `CREATE UNIQUE INDEX ... ON brand_memory (shop_id) WHERE is_active` enforcing
   one active version per shop.
2. `20260602111000_content_campaign.sql` -- `content_campaign`
   (`id, shop_id FK shops(id), goal, product_refs jsonb, brand_memory_version
   int, status text, created_at`).
3. `20260602112000_content_asset.sql` -- `content_asset`
   (`id, campaign_id FK content_campaign(id) ON DELETE CASCADE, platform text,
   kind text, copy jsonb, media_url text, status text, risk_flags jsonb,
   override jsonb null, created_at`), index on `campaign_id`.
4. `20260602113000_content_rpc.sql` -- the transactional Postgres functions
   `brand_memory_save(p_shop_id, p_content jsonb)` (Sec 6.2: advisory lock ->
   next version -> deactivate old -> insert active, returns the new row) and
   `create_content_campaign(payload jsonb)` (Sec 10: insert campaign + all
   assets, set `pending_review`, in one transaction).

Status enums (`content_campaign.status`:
`draft|generating|pending_review|approved`; `content_asset.status`:
`pending_review|approved|rejected|failed`; `platform`:
`instagram|facebook|tiktok|youtube`) implemented as text + check constraints, or
Postgres enums -- decided at plan time. **Preflight:** the plan must verify
`shops(id)` exists (assumed from prior slices) and add it if absent within the
claimed block.

## 13. Roadmap (later slices, each its own spec -> plan -> build)

| Slice | What | Gate |
|---|---|---|
| **1 (this)** | Brand memory + generation + review queue + copy/download | none |
| 2 | Platform-agnostic `Channel` interface + scheduler + approve-then-post + **Meta (FB/IG) adapter**; start Meta App Review | Meta review |
| 3 | TikTok adapter (audit submitted in parallel at Slice 2 start) | TikTok audit |
| 4 | YouTube adapter (OAuth + resumable upload + compliance audit) | 2 Google reviews |
| 5 | Video generation (slideshow/template assembly first; generative video tier later) | none |
| 6 | Learning loop: read #2's `ad_insight_fact` engagement back into generation | none |

Sequencing note: the Meta/TikTok/YouTube approval paperwork starts the day Slice
2 begins, so the multi-week external reviews run while code is written. Those
calendar gates -- not the code -- are the dominant risk.

## 14. Open items deferred to the plan

- Concrete image provider (brand-kit-aware vs multi-reference) and the overlay
  compositing approach/library.
- Object-storage choice (Supabase Storage vs other) and signed-URL handling.
- Status modeling: Postgres enums vs text+check.
- Exact Claude structured-output schema and the per-platform spec constants.
- Variant-count cap and default model effort level.
- Whether `/app/brand` and `/app/studio` get a shared NavMenu group.

## 15. Testing (behavior, not coverage theater)

- **`serialize`** -- same brand memory -> byte-identical output across runs
  (cache safety); section ordering stable; no timestamp leakage.
- **`generate`** (injected fake Claude client) -- structured response -> correct
  `ContentAsset` copy; per-platform length enforcement; over-length rejected;
  `claims_used` cross-check populates `unverified_claim`.
- **`screen`** -- banned word/claim/disclaimer + unverified-claim detection;
  blocking vs warning by `regulated_category`.
- **`brand-memory` versioning (transactional)** -- `brand_memory_save` creates a
  monotonic next version; **exactly one active row per shop** after a save; old
  versions remain immutable; **two interleaved saves do not produce duplicate
  versions or two active rows** (advisory-lock serialization); no row is written
  before first save. Seed-from-Shopify shape.
- **`create_content_campaign` atomicity** -- campaign + N assets land together or
  not at all; a forced asset-insert failure rolls back the campaign (no orphan
  `pending_review`).
- **Shop scoping** -- client queries always filter by `shop_id`; a query for shop
  A never returns shop B's rows (asserted against the sole write-path client).
- **DTO shaping** -- `content.*` returns DTOs; assert no raw Supabase columns
  leak.
- **image** -- overlay compositing is deterministic for given inputs (provider
  call faked). Live generation needs real provider keys -> not unit-tested.

Test runner is **Vitest** (already present).

## 16. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm test` -> `npm run
typecheck` -> `npm run lint` -> `npm run build`, all green with evidence, before
any commit. `npx prisma validate` is **not** required (no Prisma schema change).
No `.graphql`/Admin query added -> no GraphQL codegen. New top-level deps flagged
in the commit message (Sec 11).
