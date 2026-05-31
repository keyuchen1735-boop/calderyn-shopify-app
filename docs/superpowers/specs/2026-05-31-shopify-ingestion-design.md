# Design: Shopify Real-Data Ingestion (Slice 1 of the data pipeline)

**Date:** 2026-05-31
**Status:** Approved for implementation planning
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY` (`ajgrmnvzxfxxlwrxcgnu`)

---

## 1. Context

The admin app reads six Supabase objects (`v_alerts_view`, `v_audit_view`,
`v_campaigns_flat`, `v_skus_flat`, `guardrail_config`, `shop_integrations`).
Those views are the **tail end** of a pipeline whose middle does not exist for
live shops:

| View read by app | Backed by | Written today |
|---|---|---|
| `v_skus_flat` | `sku_dim`, `inventory_level_fact`, `location_dim`, `order_line_fact`, `order_fact` | nobody (seed only) |
| `v_campaigns_flat` | `ad_campaign_dim`, `ad_spend_fact` | nobody (seed only) |
| `v_alerts_view` | `alerts`, `alert_context` | nobody — the detectors |
| `v_audit_view` | `action_audit` | this app (`actions.execute`) |

The `raw_meta_poll` / `raw_google_poll` / `raw_quickbooks_poll` / `raw_shopify_webhook`
landing tables are all empty (0 rows); existing demo data is seeded, not ingested.
A freshly provisioned merchant therefore sees empty dashboards.

The full pipeline (4 sources × connect → ingest → transform → detect) is too
large for one spec. It is decomposed into slices; **this spec covers Slice 1**:

- **Slice 1 (this doc):** Shopify → SKU/inventory/order facts → `reorder_timing` detector.
- Slice 2: Meta Ads (OAuth + poller → `v_campaigns_flat`).
- Slice 3: Google Ads.
- Slice 4: QuickBooks (COGS / margin).
- Slice 5: remaining detector suite (incl. the cross-source `sku_stockout_vs_spend`).

**Decision (confirmed):** the pipeline runs **inside this Remix app** on Vercel
(functions + cron), reusing the existing Shopify OAuth/session/webhook plumbing.

## 2. Goal & success criteria

On a fresh live shop, after install and one cron cycle:

1. `location_dim`, `sku_dim`, `inventory_level_fact`, `order_fact`,
   `order_line_fact` populate from the merchant's real catalog and last 30 days
   of orders (no seed data).
2. `v_skus_flat` returns real `on_hand` / `velocity` / `days_of_cover`.
3. Any SKU with `velocity ≥ min_velocity` and `days_of_cover < days_of_cover_lt`
   produces a real `reorder_timing` row in `alerts` (+ `alert_context`), visible
   on the alerts page.
4. Re-running ingestion is idempotent (no duplicate facts, no duplicate
   same-day alerts).
5. Every failed shop/record is recorded in `ingestion_dlq` and surfaced in the
   cron response — never silently dropped.

## 3. Non-goals

- Meta / Google / QuickBooks ingestion (later slices).
- The other 11 detectors, including the spend-coupled `sku_stockout_vs_spend`.
- LLM-generated narratives or ranking (templated/deterministic here; LLM is a
  later enhancement).
- Backfilling order history beyond ~30 days (velocity window is 30d).
- RLS hardening (tracked separately; see §11).

## 4. Detector choice

`reorder_timing` is the only `DetectorId` (see `app/lib/types.ts`) that is pure
Shopify — it needs only inventory + velocity, both derivable from Shopify data.
The existing `alert_thresholds` row is for `sku_stockout_vs_spend`
(`{"min_spend_usd": 1000}`), which requires Meta/Google spend and is deferred to
Slice 5. This slice seeds a new threshold row:

```json
detector_id = "reorder_timing"
threshold_json = { "days_of_cover_lt": 14, "min_velocity": 0.1, "horizon_days": 14 }
```

The detector reads its threshold from `alert_thresholds` per shop, falling back
to these defaults in code when no row exists.

## 5. Architecture

One pattern: webhooks land raw, cron jobs do the work. Background Admin API
access uses `unauthenticated.admin(shop)` (offline session already stored in
`shopify_sessions` by `@shopify/shopify-app-remix`), so cron can call Shopify
without an inbound request.

```
install ──afterAuth──> provisionShop (exists)
                   └─> upsert shop_integrations(kind=shopify, sync_status=pending)

[cron] ingest-backfill   pending shops ─Admin GraphQL─> location_dim, sku_dim,
                                                        inventory_level_fact,
                                                        order_fact / order_line_fact
                                                        → sync_status=ready, last_sync_at

webhooks (inventory_levels/update, products/update — exist; orders/create — new)
                   └─land─> raw_shopify_webhook (processed_at = NULL)

[cron] ingest-transform  drain processed_at IS NULL ──> upsert facts ──> set processed_at
                                                       (failure → ingestion_dlq)

[cron] detect-reorder    read v_skus_flat ──> upsert alerts + alert_context
                                            └─> resolve recovered SKUs
```

### 5.1 Cron deployment

Logical jobs: `backfill`, `transform`, `detect`. To run on any Vercel plan
(Hobby cron limits), ship **one** route `app/routes/cron.ingest.tsx` that runs
the three phases in sequence; the schedule lives in `vercel.json` `crons`.
Splitting into three schedules on Pro is a config-only change later.

Cron auth: the route requires `Authorization: Bearer <CRON_SECRET>` (new env
var, added to `.env.example`); requests without it return 401.

### 5.2 Module layout — `app/lib/ingest/` (all `.server.ts`)

| Module | Responsibility | Depends on |
|---|---|---|
| `shopify-admin.server.ts` | Paginated Admin GraphQL: locations; products+variants+inventory; 30d orders | `unauthenticated.admin` |
| `mappers.server.ts` | **Pure** Shopify payload → fact row shapes | — |
| `backfill.server.ts` | Orchestrate one shop's backfill in bounded batches | admin, mappers, supabase |
| `transform.server.ts` | Per-topic `raw_shopify_webhook` → fact upserts | mappers, supabase |
| `detectors/reorder-timing.server.ts` | **Pure** scoring + alert write | supabase |
| `dlq.server.ts` | Write `ingestion_dlq` rows | supabase |

`mappers.server.ts` and the scoring half of the detector are pure functions and
carry the unit-test weight (§9).

## 6. Backfill (Admin GraphQL)

`removeRest: true` is set in `shopify.server.ts`, so all calls are GraphQL.
Scopes already cover this: `read_products, read_inventory, read_orders,
read_locations` (see `.env.example` `SCOPES`).

Order of operations per shop (bounded page sizes; resume across cron ticks if a
shop is large):

1. **Locations** → `location_dim` (`external_id` = location GID, `name`,
   `active`).
2. **Products + variants** → `sku_dim` (`external_id` = variant GID,
   `product_id`, `inventory_item_id`, `sku`, `title`,
   `unit_cost_cents` from `variant.inventoryItem.unitCost.amount`,
   `currency`, `tags` = `[]`).
3. **Inventory levels** (per variant's `inventoryItem.inventoryLevels`) →
   `inventory_level_fact` (`available`, `observed_at = now()`,
   `source_version` = level `updatedAt` epoch ms).
4. **Orders, last 30 days** (`query: "created_at:>=<iso>"`) with line items →
   `order_fact` + `order_line_fact`; map each line's variant GID → `sku_id`.

On success: `shop_integrations.sync_status = 'ready'`, `last_sync_at = now()`.
On failure: §8.

The 30-day order backfill alone is enough to populate velocity, so Slice 1
proves out even before the `orders/create` webhook fires.

## 7. Transform (webhooks → facts)

Webhook handlers continue to only **land** rows in `raw_shopify_webhook` (keeps
the handler well under Shopify's response budget). A new
`orders/create` subscription + handler (`app/routes/webhooks.orders.create.tsx`,
mirroring the existing handlers) is added so velocity stays fresh; the
subscription is declared in the Shopify app TOML config.

`ingest-transform` drains `raw_shopify_webhook WHERE processed_at IS NULL`
(oldest first), dispatches by `topic`:

- `inventory_levels/update` → append `inventory_level_fact`
- `products/update` → upsert `sku_dim`
- `orders/create` → upsert `order_fact` + `order_line_fact`

then stamps `processed_at = now()`. A malformed/failed row goes to
`ingestion_dlq` and is still stamped (so it is not retried forever); the DLQ row
is the retry surface.

### 7.1 Idempotency

| Table | Key | Conflict behavior |
|---|---|---|
| `location_dim` | `(shop_id, external_id)` | update name/active |
| `sku_dim` | `(shop_id, external_id)` | update mutable fields, bump `updated_at` |
| `order_fact` | `(shop_id, external_id)` | update on newer `source_version` only |
| `order_line_fact` | `(shop_id, external_line_id)` | update qty/price |
| `inventory_level_fact` | **append-only**, dedup `(sku_id, location_id, source_version)` | skip duplicate replays |

`inventory_level_fact` is append-only because `v_skus_flat` reads the latest row
per `(sku_id, location_id)` via `DISTINCT ON … observed_at DESC`; appends give
free history and dodge update races. `source_version` (Shopify `updatedAt`
epoch) guards against applying an older event after a newer one.

Natural-key uniqueness assumed on `sku_dim`/`location_dim`/`order_fact`/
`order_line_fact`; the plan verifies each constraint exists and adds it via a
Supabase migration if missing (§10).

## 8. Error handling (rule 12)

- Per **shop** failure in backfill: write `ingestion_dlq`
  (`connector='shopify'`, `job_kind='backfill'`, `error_kind`, `error_message`,
  `payload`), set `shop_integrations.sync_status='error'` + `sync_error`, then
  continue to the next shop.
- Per **record** failure in transform: `ingestion_dlq`
  (`job_kind='transform:<topic>'`, raw row id + payload), stamp `processed_at`,
  continue.
- The cron route returns JSON counts (`shopsProcessed`, `factsWritten`,
  `alertsUpserted`, `alertsResolved`, `dlqCount`) and logs them. A non-zero
  `dlqCount` is visible, never swallowed.

## 9. Detector: `reorder_timing`

Input: `v_skus_flat` rows for the shop (already exposes `on_hand`, `velocity`,
`days_of_cover`) + threshold (§4) + recent average sell price per SKU
(from `order_line_fact.price_cents / quantity`).

For each SKU with `velocity ≥ min_velocity` and
`days_of_cover < days_of_cover_lt`:

- **severity** (`alert_severity` enum): `days_of_cover < 3` → `critical`,
  `< 7` → `high`, else `medium`.
- **dollar_impact** (NUMERIC, **dollars** — the DB stores dollars and
  `rowToAlert` multiplies by 100 for the UI):
  `unmet_units × avg_sell_price`, where
  `unmet_units = max(0, horizon_days − days_of_cover) × velocity` and
  `avg_sell_price` falls back to `0` when no recent line items exist (yields a
  low-impact, still-valid alert).
- **claude_rank** (INT): rank position after sorting the shop's breaching SKUs
  by `dollar_impact` desc (1 = highest impact). Deterministic, no LLM.
- **claude_narrative**: templated, e.g.
  *"{title} has {days_of_cover} days of cover at {velocity}/day and will stock
  out around {stockout_date}. Reorder now to avoid ~${dollar_impact} in lost
  sales over the next {horizon_days} days."*
- **entity_ref** (JSONB): `{ "sku": <sku|external_id>, "title": <title>,
  "sku_id": <uuid> }` — `v_alerts_view` extracts `entity_ref->>'sku'` and
  `->>'title'`.
- **alert_context.evidence** (JSONB): `{ on_hand, velocity, days_of_cover,
  avg_sell_price_cents, horizon_days, threshold }`.
- **day_bucket**: today (UTC date).

### 9.1 Dedup & lifecycle

- Upsert key: `(shop_id, detector_id, entity_ref->>'sku', day_bucket)`.
  Same-day re-runs update `last_seen_at`, `dollar_impact`, `claude_rank`,
  `claude_narrative`; a new day creates a new row (history).
- **Recovery:** any open `reorder_timing` alert whose SKU is no longer breaching
  is set `status='resolved'`, `resolved_at=now()`.
- Status values come from the `alert_status` enum
  (`open|acknowledged|resolved|snoozed|dismissed`); `v_alerts_view` already folds
  `snoozed→open` and `dismissed→resolved` for the UI.

## 10. Schema changes (Supabase migrations) — carve-out from CLAUDE.md

CLAUDE.md states "all schema changes go through `prisma migrate dev`." That rule
governs the **Prisma-managed** schema, which in this repo is only
`shopify_sessions` (see `prisma/schema.prisma` header comment). The analytics
tables in this spec are **Supabase-managed**. Therefore these migrations are
applied via **Supabase migration tooling** (CLI / dashboard migration), not
Prisma, and this deviation is documented here per rule 7.

Migrations required:

1. `ALTER TABLE raw_shopify_webhook ADD COLUMN processed_at timestamptz NULL;`
   plus a partial index `WHERE processed_at IS NULL` for fast draining.
2. A unique index on `alerts` over the dedup key
   `(shop_id, detector_id, (entity_ref->>'sku'), day_bucket)` to enable
   idempotent `ON CONFLICT` upserts (scoped/partial to keep other detectors
   unaffected if needed).
3. Seed `alert_thresholds` row for `reorder_timing` (§4) — per shop, or a single
   default row the detector reads with code-side fallback.
4. Verify-and-add (only if absent) natural-key unique constraints named in §7.1.

No `prisma/schema.prisma` change → no Prisma migration, no codegen impact.

## 11. Security note (surfaced, not auto-fixed)

A Supabase advisor flags `public.mcp_tokens` with **RLS disabled** — out of
scope for this slice but worth tracking. Remediation
(`ALTER TABLE public.mcp_tokens ENABLE ROW LEVEL SECURITY;` + policies) is a
decision for the owner and must not be auto-applied. All ingestion writes use the
service-role key (bypasses RLS), so this slice neither depends on nor changes RLS
posture.

## 12. Testing (rule 9 — behavior, not coverage theater)

- **`mappers.server.ts`** — feed recorded Shopify GraphQL/webhook JSON, assert
  exact fact row shapes (GID parsing, cents conversion, `source_version`).
- **Detector scoring** — synthetic `v_skus_flat` inputs assert
  severity/`dollar_impact`/`claude_rank`/narrative and the breach/recovery
  boundary at the threshold edges.
- **Transform dispatch** — recorded `raw_shopify_webhook` payloads per topic →
  asserted upserts and `processed_at` stamping, including a malformed row →
  `ingestion_dlq`.
- **Idempotency** — applying the same backfill/transform twice yields identical
  row counts and one alert per SKU per day.

The plan confirms the test runner (Vitest if present; if absent it is flagged as
a new dev dependency per CLAUDE.md's no-silent-deps rule before adding).

## 13. Open items deferred to the plan

- Exact Admin GraphQL query text + page sizes / cursor resume strategy.
- One-vs-three cron route split and `vercel.json` `crons` schedule cadence.
- Whether `sku_velocity` / `stockout_forecast` are materialized now or left to
  the view (Slice 1 reads `v_skus_flat` directly; materialization can wait).
- `orders/create` webhook subscription wiring in the Shopify app TOML config.

## 14. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm run typecheck` →
`npm run lint` → `npm run build`, all green with evidence, before any commit.
GraphQL codegen runs if any `.graphql`/Admin query file is added.
