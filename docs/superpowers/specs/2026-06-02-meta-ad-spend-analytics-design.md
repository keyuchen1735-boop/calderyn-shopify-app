# Design: Meta Ad-Spend Analytics (Slice 2 -- vertical slice: ingest -> grade -> surface)

**Date:** 2026-06-02
**Status:** Draft -- awaiting user review
**Repo affected:** `shopify-app` (this repo) + Supabase project `Calderyn-SHOPIFY` (`ajgrmnvzxfxxlwrxcgnu`) + the external `calderyn-mcp` deploy (one tool addition)
**Session:** #2 (ad-spend analytics) in the multi-session build

> Encoding note: this document is intentionally ASCII-only (no em dashes, arrows,
> or section signs) so it renders identically in every editor and stays
> trustworthy as the source of truth.

---

## 1. Context

The app judges ad performance internally (`roas_7d`, `contribution_margin` on
`Campaign`) but **never shows it and never computes it from real data**:

- When a shop connects Meta, the Campaigns loader live-fetches campaigns and
  **hardcodes `roas_7d`, `contribution_margin`, `spend_7d` to `0`**
  (`app/routes/app.campaigns.tsx:64-67`).
- The dashboard "True ROAS (7d)" tile is a literal `"-"`
  (`app/routes/app._index.tsx:132`).
- The only non-zero ROAS/margin numbers anywhere are **seed rows** in
  `v_campaigns_flat`. `ad_spend_fact` (the time-series table that view aggregates)
  is populated by **no poller** -- Meta ingestion ("Slice 2" of the original
  ingestion design, sec 1 of `2026-05-31-shopify-ingestion-design.md`) was never
  built. The Meta work that exists (`2026-06-01-meta-campaign-actions-design.md`)
  is **actions only** (pause/resume) and explicitly live-fetches.
- **Engagement metrics (likes/comments/shares/saves) are not in the data model
  at all.**

So "ad-spend analytics" is two stacked layers: a **data layer** (a Meta Insights
poller writing time-series spend/ROAS/engagement) and a **surface layer** (the
analytics dashboard). This spec builds both, **Meta-only**, as one vertical slice.

## 2. Goal & success criteria

After a merchant connects Meta and the initial backfill completes (see note on
"completes" below):

1. `ad_spend_fact` (campaign-level, daily) and the new `ad_insight_fact`
   (ad-level, daily, incl. engagement) populate from the merchant's real Meta
   Insights -- a 90-day backfill on connect, then daily increments.
   **"Completes" = the resumable backfill has drained, which may take multiple
   cron ticks for a large account (Sec 6); it is not assumed to finish in one
   cron cycle.**
2. `v_campaigns_flat` returns **real** `roas_7d` / `spend_7d` (no seed), fixing
   the Campaigns-page zeros and the dashboard "True ROAS" tile.
3. A new **Analytics** page shows: account summary (blended margin, break-even
   ROAS, account ROAS, total spend, total engagement), a spend/ROAS **trend chart
   with a 30/90-day toggle**, and a per-campaign list with a **grade
   (winning / okay / poor)**, engagement, the linked recommendation, and a
   deep-link to act.
4. Each campaign's **grade is auto-determined**: blended gross margin is computed
   from real Shopify data (selling price vs unit cost) -> break-even ROAS =
   `1 / margin`; the campaign's ROAS is graded against it. A **manual margin
   override** in settings takes precedence when set.
5. The **"next step"** shown per campaign is **#4's existing alert**
   (`campaign_below_breakeven` / `negative_unit_economics`: narrative,
   `dollar_impact`, `claude_rank`) -- not a parallel recommender -- with a button
   that deep-links to the existing pause / edit-budget controls.
6. Everything new is readable through **`calderynClient(shop).analytics.*`**
   (DTOs shaped at the boundary, no raw Supabase rows) **and** a new read-only
   **MCP `analytics` tool**, so session #8's in-app assistant can answer
   analytics questions.
7. Engagement is captured at **ad level** in a **shared** table so session #3's
   campaign generator can read back how its posts performed.
8. Re-running ingestion is idempotent (no duplicate facts, stable counts);
   per-shop/record failures land in `ingestion_dlq` and are surfaced in the cron
   response, never swallowed.

## 3. Non-goals

- **Google Ads** (later slice). Meta only.
- **True campaign->SKU attribution.** Margin is **blended store-level**, not
  per-campaign COGS. (A manual override exists for merchants who know their real
  number.) Per-campaign attribution is explicitly out of scope.
- **Building #4's detectors.** We *consume* `campaign_below_breakeven` /
  `negative_unit_economics` alerts; #4 owns producing them. We provide the shared
  break-even module they import.
- **The one-click "shift budget to winner" action** (a new `ActionKind`) --
  deferred. The surface deep-links to the existing pause/edit-budget controls.
- **Meta App Review.** Development-mode access against the merchant's own ad
  account is sufficient to build/test (per the actions spec sec 3).
- **Multi-currency / FX normalization.** Amounts are in the ad account currency
  (Sec 6.2); a shop whose ad account and store currencies differ is out of scope.
- **LLM narratives/ranking** for the grade -- the grade is deterministic; the
  narrative/ranking come from #4's alerts.

## 4. Cross-session ownership & coordination (binding)

This slice runs alongside #3 (campaign generator), #4 (constant analysis /
action brain), and #8 (in-app assistant). To avoid collisions:

| Concern | Owner | Contract |
|---|---|---|
| Engagement schema (`ad_dim`, `ad_insight_fact` engagement columns) | **#2 (this)** | Shared; **#3 reads** post performance from it; **#4 must not write** it. |
| "What should I do" recommendations | **#4** | #2 **renders** #4's alerts; #2 builds **no** rival recommender. |
| Break-even / margin math (`app/lib/analytics/breakeven.ts`) | **#2 (this)** | Pure module; **#4 imports it** for `campaign_below_breakeven` -- does not reimplement. So grade and alert never disagree. |
| `app/lib/types.ts` additions | **#2 adds** `Engagement`, `CampaignGrade`, `CampaignInsight`, `AdInsight`, `AnalyticsSummary`, `TrendPoint` | #2 does **not** touch `DetectorId` / `ActionKind`. |
| Migration timestamps | **#2 claims `20260602090000`-`20260602093000`** | **#4 numbers from `20260602100000`+.** |
| Data surface seam | **#2 adds** `client.analytics.*` + MCP `analytics` tool | DTOs shaped at boundary; no raw rows leaked. |
| `cron.ingest.tsx` phase list | shared route | #2 adds a **Meta phase**; coordinate the one-line wiring with whoever last edited the route. |

## 5. Architecture

Mirrors the established ingestion pattern (`2026-05-31` spec sec 5): webhooks/poll
-> raw/fact tables in Supabase, cron does the work, pure mappers/scorers carry the
test weight. Background Meta access uses the **encrypted offline token** in
`integration_credentials` via `metaClientForShop(shop)` (the cron analog of
`unauthenticated.admin` -- no inbound request needed).

```
connect Meta --(actions spec)--> integration_credentials(meta_ads, encrypted token, ad_account_id)

[cron] meta-backfill   shops with meta_ads creds --Insights(time_increment=1, 90d)-->
                         campaign level -> ad_spend_fact
                         ad level       -> ad_dim, ad_insight_fact (incl engagement)
                         -> shop_integrations(meta_ads).last_sync_at

[cron] meta-poll       daily incremental (yesterday + today) --Insights--> same upserts

views:  v_campaign_insights_daily (campaign x day grain)   <- ad_spend_fact
        v_ad_insights_daily        (ad x day grain)         <- ad_insight_fact
        v_campaigns_flat           (now real roas_7d/spend_7d, fixed 7d) <- ad_spend_fact

surface: app.analytics.tsx --client.analytics.*(window)--> filter day_bucket >= today-window,
                                                            roll up -> summary + trend
                                                            + per-campaign grade + engagement
                                                            + linked #4 alert
         MCP analytics tool --same views/DTOs--> #8 assistant
```

### 5.1 Module layout

`app/lib/meta/insights/` (all `.server.ts`):

| Module | Responsibility | Pure / testable |
|---|---|---|
| `insights-client.server.ts` | Paginated Meta Insights `GET` (injected HTTP client, mirrors `meta/campaigns.server.ts`) | injected fake |
| `mappers.server.ts` | **Pure** Insights JSON -> `ad_spend_fact` / `ad_insight_fact` rows, incl. `actions[]`->engagement-column mapping, cents conversion, ROAS source-field selection | pure |
| `backfill.server.ts` | Orchestrate one shop's 90-day backfill in bounded pages, resumable | seam-tested |
| `poller.server.ts` | Daily incremental poll (yesterday/today) per shop | seam-tested |

`app/lib/analytics/`:

| Module | Responsibility | Pure / testable |
|---|---|---|
| `breakeven.ts` | **Pure, shared with #4:** blended margin (price vs unit cost) -> break-even ROAS; manual override precedence; cost-coverage rules (Sec 7.1) | pure |
| `classify.ts` | **Pure:** ROAS vs break-even -> `winning` / `okay` / `poor` | pure |

DTO assembly + windowing live in `calderynClient(shop).analytics.*` (in
`app/lib/calderyn.server.ts`), reading the daily-grain views and rolling up.

Reuses existing `app/lib/ingest/dlq.server.ts` for failures.

## 6. Meta Insights ingestion

Insights call (per shop, using the stored ad account id):
`GET /act_<id>/insights?level=campaign&time_increment=1&time_range={...}`
and `level=ad` for the ad-level pass.

### 6.1 Fields & ROAS source

- Performance: `spend`, `impressions`, `inline_link_clicks` (stored as
  `link_clicks` -- **not** the broader `clicks`, which counts all clicks incl.
  non-link; we standardize on link clicks), `actions`, `action_values`.
- ROAS = `purchase_value_cents / spend_cents`, where `purchase_value` is read
  from `action_values[]` with a **single, deduped** source:
  **prefer `action_type == "omni_purchase"` (the superset across pixel/app/
  offline); fall back to `"purchase"` only when `omni_purchase` is absent; never
  sum both.** `purchases` count uses the same rule against `actions[]`. The mapper
  encodes this selection and is unit-tested on both shapes.

### 6.2 Attribution, currency, time

- **Attribution:** request with `use_unified_attribution_setting=true` so the
  numbers match what the merchant sees in Ads Manager (the account's configured
  attribution window). `action_report_time=conversion` (attribute a conversion to
  the day it happened, matching revenue timing).
- **Currency:** Meta returns money in the **ad account currency** as decimal
  major units; the mapper multiplies by 100 to cents and stores the `currency`
  code on the fact row. v1 assumes the ad account currency is the reporting
  currency (multi-currency/FX is a non-goal, Sec 3).
- **Time:** `day_bucket` is the Insights row date (account timezone as returned).
  Backfill window = 90 days (covers the 30/90 toggle); the daily poll re-pulls
  yesterday + today so late-attributed conversions correct in place via upsert.

### 6.3 Engagement (ad level)

Parsed from `actions[]` by `action_type` (missing types store `0`):

| Column | `action_type` |
|---|---|
| `reactions` | `post_reaction` |
| `comments` | `comment` |
| `shares` | `post` |
| `saves` | `onsite_conversion.post_save` |
| `post_engagement` | `post_engagement` |

### 6.4 Batching, failures, idempotency

Bounded page sizes; a large shop resumes across cron ticks (the backfill records
its cursor/last-completed date per shop so the next tick continues, not restarts).
Per-shop failure -> `ingestion_dlq(connector='meta', job_kind='backfill'|'poll',
...)` + `shop_integrations(meta_ads).sync_error`; continue to the next shop. Cron
returns JSON counts (`shopsProcessed`, `factsWritten`, `adsWritten`, `dlqCount`).

| Table | Key | Conflict behavior |
|---|---|---|
| `ad_campaign_dim` | `(shop_id, external_id)` | update name/status/budget |
| `ad_dim` | `(shop_id, external_id)` | update name, adset/campaign refs |
| `ad_spend_fact` | `(shop_id, campaign_external_id, day_bucket)` | update metrics |
| `ad_insight_fact` | `(shop_id, ad_external_id, day_bucket)` | update metrics + engagement |

Re-running backfill yields identical row counts and updates-in-place -- no dupes.

## 7. Break-even, margin & grade

### 7.1 Blended margin -> break-even ROAS (`breakeven.ts`, shared with #4)

Computed over the active window from `order_line_fact.price_cents` x
`sku_dim.unit_cost_cents`:

- `blended_cogs_ratio = sum(unit_cost_cents * qty) / sum(price_cents * qty)`
  **over only the lines whose SKU has a known `unit_cost_cents`.**
- `blended_margin = 1 - blended_cogs_ratio`.
- `break_even_roas = 1 / blended_margin` (margin > 0).

**Data-quality rules (explicit, to avoid a misleading margin):**

- A missing/null `unit_cost_cents` means that line is **excluded** from the
  computation. It is **never treated as zero cost** (zero cost would inflate
  margin toward 100% and make every campaign look profitable).
- Compute **cost coverage** = `sum(price_cents*qty for lines with known cost) /
  sum(price_cents*qty for all lines)`. If coverage `< 0.70` (a named constant),
  the computed margin is flagged **low-confidence**: the Analytics summary shows a
  warning and prompts the merchant to set a manual override, and the grade falls
  back to the manual override if set, else a configurable **default margin**
  (e.g. `0.40`) rather than a low-confidence computed value.
- **Precedence:** manual override (if set) > computed margin (if coverage OK) >
  default margin (with warning).

This function is the **single source of truth**; #4's `campaign_below_breakeven`
imports it so its alert threshold and our display grade always match.

### 7.2 Grade (`classify.ts`, pure)

Internal type is `"winning" | "okay" | "poor"` (UI renders the labels
**Winning / Okay / Poor**). Given a campaign's window ROAS `r` and break-even `B`:

- `r >= 1.2*B` -> **winning**
- `0.95*B <= r < 1.2*B` -> **okay**
- `r < 0.95*B` -> **poor** (losing money)

Buffer factors (`1.2`, `0.95`) are named constants documented in the module.
The grade is **descriptive display only**; the *actionable* ranked advice is the
linked #4 alert.

## 8. Surface -- `app/routes/app.analytics.tsx`

Polaris page; charts via **`@shopify/polaris-viz`** (new dependency, Sec 11).

- **Summary row** (StatCards): blended margin % (with a low-confidence warning
  badge when coverage `< 0.70`), break-even ROAS, account ROAS (window), total
  spend (window), total engagement.
- **Trend chart** (`LineChart`): spend and ROAS per day, **30/90 toggle**
  (Polaris segmented control; window in the URL search param so the loader
  refetches and re-rolls up).
- **Per-campaign list** (cards or `DataTable`): name | status | window spend |
  window ROAS vs break-even | **grade badge** | engagement summary
  (reactions/comments/shares/saves) | **linked #4 alert** (narrative +
  `dollar_impact`) as the next step | **"Take action" button** deep-linking to
  `/app/campaigns` (existing pause / edit-budget controls). Expandable row ->
  ad-level engagement breakdown (top ads by engagement) from
  `v_ad_insights_daily`.
- **Wiring fixes that fall out:** the dashboard "True ROAS" tile reads
  `client.analytics.summary`; the Campaigns loader enriches live rows with
  ingested `roas_7d`/`spend_7d` (join on Meta campaign id) instead of `0`.

Empty/edge states: Meta not connected -> connect prompt; connected but
pre-first-sync -> "syncing" state; low/zero cost coverage -> "set your margin"
prompt (override).

## 9. DTOs & exposure (`client.analytics.*` + MCP)

New types in `app/lib/types.ts` (additive; Sec 4):

```ts
type CampaignGrade = "winning" | "okay" | "poor";
interface Engagement { reactions: number; comments: number; shares: number; saves: number; post_engagement: number; }
interface CampaignInsight {
  campaign_id: string; name: string; status: "active" | "paused";
  spend_cents: number; impressions: number; link_clicks: number;
  purchases: number; purchase_value_cents: number; roas: number;
  break_even_roas: number; grade: CampaignGrade;
  engagement: Engagement; linked_alert_ids: string[];
}
interface AdInsight { ad_id: string; campaign_id: string; name: string; spend_cents: number; roas: number; engagement: Engagement; }
interface TrendPoint { day_bucket: string; spend_cents: number; roas: number; }
// total_engagement = sum(reactions + comments + shares + saves) across the window.
// margin_confidence flags low cost-coverage (Sec 7.1).
interface AnalyticsSummary { window_days: 30 | 90; blended_margin_pct: number; margin_confidence: "ok" | "low" | "override" | "default"; break_even_roas: number; account_roas: number; total_spend_cents: number; total_engagement: number; }
```

`calderynClient(shop)` gains an `analytics` namespace (DTO-shaped, no raw rows;
windowing done here by filtering `day_bucket` and rolling up the daily views):

- `analytics.summary(window)` -> `AnalyticsSummary`
- `analytics.trend(window)` -> `TrendPoint[]` (account-level daily series for the chart)
- `analytics.campaigns(window)` -> `CampaignInsight[]`
- `analytics.ads(campaignId, window)` -> `AdInsight[]`
- `analytics.settings.get()` / `analytics.settings.update({ marginOverride })`

`linked_alert_ids` is computed by matching open alerts to the campaign (reusing
the existing name-match in `app.campaigns.tsx`), so the surface renders #4's
alert without a rival engine.

**MCP:** the external `calderyn-mcp` server adds a read-only `analytics` tool
(`analytics_summary`, `analytics_campaigns`) reading the **same views**; this
repo updates the MCP token scope/banner copy (`app/routes/app.mcp.tsx`) to list
analytics in the granted read-only surface. The heavy lifting (views + DTOs)
lives here and is reused.

## 10. Schema changes (Supabase migrations -- CLAUDE.md carve-out)

Per the ingestion spec sec 10, these analytics tables are **Supabase-managed**,
not Prisma-managed (`prisma/schema.prisma` covers only `shopify_sessions`), so
they ship via Supabase migration tooling. No Prisma change -> no codegen.

### 10.0 Base-object preflight (verify-and-add)

The local migration history is sparse (only `mcp_tokens`,
`raw_shopify_webhook_processed_at`, `integration_credentials`); the analytics
**base** objects this slice builds on exist remotely/in seed but are not all in
local migrations. The implementation plan **must verify each of the following
exists with the assumed shape, and add it via a claimed migration if absent**
before writing the new tables:

- `shops` (id) and `shop_integrations` with `kind` (incl. `meta_ads`),
  `sync_status`, `last_sync_at`, `sync_error`.
- `integration_credentials` (from the actions spec) with the encrypted Meta token
  + `external_account_id` (ad account id).
- `ad_campaign_dim` and `ad_spend_fact` (currently seed-backing `v_campaigns_flat`)
  -- including that `ad_spend_fact` has campaign-level daily grain with
  `purchase_value_cents`, `purchases`, and a `currency` column.
- `sku_dim.unit_cost_cents`, `order_line_fact.price_cents` + `quantity` (used by
  `breakeven.ts`).
- Any enums referenced (e.g. `integration_kind`, `sync_status` values).

If any are missing remotely, the plan adds them in a preflight migration numbered
within the claimed `20260602090000`-`093000` block.

### 10.1 New migrations (claimed timestamps; Sec 4)

1. `20260602090000_ad_insights.sql` -- create `ad_dim`
   (`shop_id, external_id, campaign_external_id, adset_external_id, name`) and
   `ad_insight_fact` (`shop_id, ad_external_id, day_bucket, spend_cents,
   impressions, link_clicks, purchases, purchase_value_cents, currency,
   reactions, comments, shares, saves, post_engagement`) + unique key + indexes
   (Sec 6.4).
2. `20260602091000_ad_spend_fact.sql` -- verify-and-add on `ad_spend_fact`:
   campaign-level daily grain with `purchase_value_cents`, `purchases`,
   `currency`; add unique `(shop_id, campaign_external_id, day_bucket)`. (Adds
   only what is absent -- the table exists for seed data.)
3. `20260602092000_analytics_views.sql` -- `v_campaign_insights_daily`
   (campaign x day), `v_ad_insights_daily` (ad x day), and **redefine
   `v_campaigns_flat`** to compute real `roas_7d`/`spend_7d_cents` from
   `ad_spend_fact` over a fixed trailing 7 days. (Windowing for 30/90 is done in
   the client against the daily views, not by parameterizing a view.)
4. `20260602093000_analytics_settings.sql` -- `analytics_settings`
   (`shop_id PK, blended_margin_override numeric NULL, updated_at`).

## 11. New dependency & env

- **`@shopify/polaris-viz`** (+ peer `@shopify/polaris-viz-core` if required) --
  Shopify's official charting library; on-brand with Polaris, accessible. New
  top-level dependency, flagged per CLAUDE.md (pulls d3; bundle size increase
  accepted for the chart surface). No other new top-level deps.
- No new env vars (Meta creds + encryption key already added by the actions
  spec sec 11). Cron auth reuses `CRON_SECRET`.

## 12. Testing (behavior, not coverage theater)

- **`insights/mappers`** -- recorded Meta Insights JSON (campaign + ad level) ->
  exact fact rows: id parsing, `spend`->cents, currency capture, ROAS
  source-field selection (`omni_purchase` preferred, `purchase` fallback, never
  both), `inline_link_clicks`->`link_clicks`, and `actions[]`->engagement-column
  mapping (reactions/comments/shares/saves/post_engagement), missing types -> `0`.
- **`breakeven`** -- synthetic price/cost: margin math; **missing cost excluded
  (not zeroed)**; cost-coverage threshold flips to low-confidence; precedence
  (override > computed > default); zero/negative-margin guards.
- **`classify`** -- ROAS vs break-even boundary cases exactly at `0.95*B` and
  `1.2*B`.
- **DTO shaping** -- daily view rows -> windowed `CampaignInsight` /
  `AnalyticsSummary`; assert correct rollup and that no raw Supabase columns leak.
- **Idempotency** -- apply the same backfill twice -> identical `ad_spend_fact` /
  `ad_insight_fact` counts.

Cannot be unit-tested (needs the Meta dev app, no App Review): the live Insights
pull against a real ad account. Test runner is **Vitest** (already present).

## 13. Open items deferred to the plan

- Exact Insights field list / pagination cursor strategy and page sizes, and the
  per-shop resume cursor shape.
- Whether the Meta poller is a phase inside `cron.ingest.tsx` or a sibling
  `cron.ingest.meta.tsx` with its own `vercel.json` schedule (config-only).
- Whether daily-grain rollups stay views (default) or get materialized if the
  client-side rollup is too heavy at 90 days.
- Exact `polaris-viz` chart components/props and the 30/90 URL-param plumbing.
- Final values for the named constants: cost-coverage threshold (`0.70`), default
  margin (`0.40`), grade buffers (`1.2`, `0.95`).

## 14. Pre-commit gate

Per CLAUDE.md: `/code-review`, patch sanity, then `npm test` -> `npm run
typecheck` -> `npm run lint` -> `npm run build`, all green with evidence, before
any commit. `npx prisma validate` is **not** required (no Prisma schema change).
No `.graphql`/Admin query added -> no GraphQL codegen.
