# Spec — Ad Creative Pre-Screen, Increment B: real account-history calibration

**Date:** 2026-06-09 · **Module:** `app/lib/screener/` · **Branch:** `feat/screener-real-calibration` (off `origin/main`)

## Goal

`history.server.ts:loadCalibrationInputs` currently leaves CTR/CPM/engagement/CVR/ad-count
null, so the scorecard's predicted CTR, hold rate, and **Estimated ROAS** run on category
fallbacks (`DEFAULT_*`) rather than the shop's real numbers. Confidence can never reach
`high`. This increment wires the real Supabase facts so the score is grounded, not a vibe.

## Current state (verified against prod `ajgrmnvzxfxxlwrxcgnu`, 2026-06-09)

- `ctr`, `cpmCents`, `engagementRate`, `skuCvr` are hard-coded `null` → `DEFAULT_*` fallbacks.
- `historyAdCount` is a 3-name proxy (`topAdNames.length`), so confidence caps at `medium`.
- **Bug:** the SKU price lookup queries `sku_dim.price_cents`, **which does not exist**
  (`sku_dim` has only `unit_cost_cents`). So `skuPriceCents` is **always null today** and
  Estimated ROAS has silently used `DEFAULT_AOV_CENTS`. Fixed here.
- Real data exists to calibrate from (test shop): `ad_spend_fact` 482 rows,
  `ad_engagement_fact` 124, `order_line_fact` 5,449, `attribution_fact` 1,731, `sku_dim` 28.

## Design

One function changes: `loadCalibrationInputs`. `shapeCalibrationInputs` stays **pure and
untouched** (it already applies documented fallbacks for any field left null). All reads are
shop-scoped (`.eq("shop_id", shopId)`) and wrapped so a read failure or empty account →
`null` → fallback (never throws; cold-start safe). Window for account metrics = **last 30 days**.

| Field | Source (shop-scoped) | Formula | `null` when |
|---|---|---|---|
| `accountBaselineCtr` | `ad_spend_fact`, 30d | Σclicks / Σimpressions | 0 impressions |
| `accountBaselineCpmCents` | `ad_spend_fact`, 30d | Σspend_cents / Σimpressions × 1000 | 0 impressions |
| `accountEngagementRate` | `ad_engagement_fact`, 30d | Σ(reactions+comments+shares+saves) / Σimpressions | 0 impressions |
| `skuCvr` | `ad_spend_fact`, 30d | Σconversions / Σclicks (account baseline) | 0 clicks |
| `skuPriceCents` 🐛 | `sku_dim`→`order_line_fact` | avg `price_cents` for that `sku_id`, 30d then all-time fallback | no order lines |
| `historyAdCount` | `ad_engagement_fact`, all-time | count(distinct `ad_external_id`), capped | (0) |
| `breakEvenRoas`, `topAdNames` | unchanged | already real | — |

### Decisions

1. **CVR = account `conversions / clicks`**, not a per-SKU attribution join. The per-SKU path
   (`order_line_fact`→`attribution_fact`→`ad_spend_fact`) is sparse and conceptually muddy —
   clicks are campaign-scoped, not SKU-scoped. The account baseline is robust and always-on,
   and feeds the mapped SKU's revenue math as a sensible default. (`ad_spend_fact.conversions`
   already exists, so no join needed.)
2. **Price = avg of real `order_line_fact.price_cents`** for the SKU (what it actually sold
   for), 30d window with all-time fallback — `sku_dim` carries no retail price.
3. **`historyAdCount` = all-time distinct ads**, so an established account can reach `high`
   confidence even if recent 30d activity is thin (the whole point of this increment).

## Module changes (`history.server.ts` only)

Row-math extracted into **pure, fixture-testable** helpers (mirrors `shapeCalibrationInputs`):

- `aggregateSpend(rows) → { ctr, cpmCents, cvr }` — guards zero denominators → `null`.
- `aggregateEngagement(rows, sinceISO) → { engagementRate, topAdNames, historyAdCount }` —
  one all-time `ad_engagement_fact` fetch (ordered `day` desc, capped); engagement rate over
  rows within `sinceISO`, distinct-ad count over all rows, top-3 names by engagement.
- `avgPriceCents(lines) → number | null`.

`loadCalibrationInputs` becomes thin glue: run the fetches, hand rows to the pure helpers,
assemble `RawHistory`, call `shapeCalibrationInputs`. `breakEvenRoas` query unchanged.

## Testing

- **Pure-helper unit tests** with fixture rows: CTR/CPM/CVR math; engagement rate + distinct
  count + top-name ranking; price averaging; every zero-denominator → `null`.
- **Integration tests** for `loadCalibrationInputs`: extend the shared Supabase chain mock
  (`app/lib/__tests__/_supabase_chain_mock.ts`) with `gte`/`lte`/`limit` (purely additive —
  it already wraps `order`), queue responses, assert (a) the correct table/column/filter calls
  via `getRecorded`, and (b) real rows → populated `CalibrationInputs`, empty → all fallbacks,
  and a populated account reaches `confidence: "high"` through `calibrate`.
- No live network/Supabase calls in tests.

## Out of scope

Plan 4 (image/video gen), Increment A (Meta push), any schema/migration change (reads only),
per-SKU attribution CVR.

## Verification gate

`npx vitest run` · `npm run typecheck` · `npm run lint` (0 warnings on touched files) ·
`npm run build` — all green, evidence shown, before any commit (per CLAUDE.md pre-commit gate).
