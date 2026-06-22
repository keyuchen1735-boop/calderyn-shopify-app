# Product-Economics Remediation — Phase 3 Implementation Plan (`reallocate_spend_sku` executor)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `reallocate_to_winner` and `cut_ads` strategic moves *executable* on product-economics alerts. When the losing SKU is served by a dedicated, mutable Meta campaign **and** a qualifying winner SKU+campaign exists, the Fix-it panel shows a real "Move ad budget to **<winner>**" button that shifts daily budget loser→winner through the existing reallocation executor (audit + undo + retry already built). When no dedicated mutable campaign exists, the move stays advisory ("exclude this SKU inside Advantage+") — never a dead button (rule 12). "Cut ads" reuses the shipped `pause_campaign` / `reduce_campaign_budget` campaign executor.

**Architecture:** Keep `rankMoves` (`app/lib/remediation/rank.ts`) **pure** — it never queries the DB. A new thin **async enrichment** step (`enrichRemediation`, server-side, in `calderyn.server.ts`) runs after the pure `rankMoves`, reads one row from a new view `v_sku_remediation_inputs`, and fills the winner/campaign **target** + flips `executor` from `null` to `"reallocate_spend_sku"` (or `"pause_campaign"`/`"reduce_campaign_budget"` for cut_ads) only when eligible. The view exposes, per SKU: contribution-at-zero-ad-spend, 30-day returns, the dedicated mutable campaign for that SKU (if one exists), and the ranked catalog winner (highest-margin SKU with stock headroom + a scalable campaign). The `reallocate_spend_sku` executor is a SKU-scoped gateway (`alert-action.server.ts` style) that resolves the loser+winner dedicated campaigns and delegates to the **already-shipped** `executeReallocation` (`reallocate.server.ts`), so the composite two-leg budget shift, the one append-only `action_audit` row, undo, and the retry drain all come for free — Phase 3 adds the SKU→campaign resolution layer in front of it, nothing else.

**Tech Stack:** TypeScript (strict, ESM), Vitest, Remix loaders/actions, Supabase Postgres views (raw SQL migrations under `supabase/migrations/`, `security_invoker = on`), Meta Graph adapter (`makeMetaActionAdapter`), React + bespoke `cd-*` CSS (dashboard) / Shopify Polaris (embedded app).

---

## Scope & deliberate simplifications (read first)

Phase 3 is the third vertical slice of the 4-phase spec (`docs/superpowers/specs/2026-06-20-product-economics-remediation-design.md`). It assumes **Phase 1** (pure engine + advisory panel, `app/lib/remediation/*`) and **Phase 2** (`discontinue_sku` executor; widens `StrategicMove.executor` to add `"discontinue_sku"`) have landed. Deliberate trims vs the spec, stated not hidden (rule 12):

- **Async enrichment, not async ranking.** `rankMoves` stays pure and fully unit-testable. The DB read lives in a separate `enrichRemediation(plan, alert, sb)` that only *fills targets / flips executors*; the ranking decision is unchanged. This keeps the Phase 1 backbone tests green and isolates I/O to one thin server function. (See "Architecture seam" below.)
- **Meta-only budget shift.** `reallocate_spend_sku` resolves dedicated campaigns and shifts budget only when **both** loser and winner dedicated campaigns are on `meta` (the only platform with a SKU-concentratable dedicated-campaign signal in the seed/data model). Cross-platform SKU shifts are out of scope — the loser→winner pair must share the `meta` platform, otherwise advisory fallback. (`executeReallocation` itself supports cross-platform; we constrain the *resolution* layer.)
- **No per-SKU control inside shared Advantage+/PMax.** When the loser's spend lives in a catalog-wide campaign (`Advantage+ Shopping`, `Performance Max — All Products`), there is no per-SKU lever — the move stays `executor: null` with `ineligibleReason: "served by a shared campaign — exclude this SKU inside Advantage+ instead"`. Advisory only, never a button.
- **"Dedicated campaign" is inferred, not keyed.** There is **no** structured SKU→campaign key in the schema (the spec's central constraint — confirmed: `v_alerts_view` resolves `campaign_id` from `entity_ref ->> 'campaign_id'`, and product-economics alerts carry only `sku_id`; `ad_campaign_dim` has no product/sku column). The view derives dedication from `attribution_fact` (order→campaign) ⋈ `order_line_fact` (order→sku): a campaign is *dedicated* to a SKU when that SKU's orders account for ≥ `DEDICATION_SHARE` (0.70) of the campaign's attributed revenue over the window, AND the campaign is `active` with a non-null `daily_budget_cents` (*mutable*). This heuristic is the seam; tighten the threshold later if needed.
- **No autopilot wiring.** Autopilot consuming `plan.recommended` for `reallocate_spend_sku` is **Phase 4**. Phase 3 ships the manual buttons on both surfaces only.

Detectors in scope for the *reallocate/cut_ads* executors: the two ad-driven ones (`negative_unit_economics`, `ad_tax_overload`) — the only detectors where `rankMoves` emits `reallocate_to_winner` / `cut_ads`. The other three product-economics detectors keep Phase 1/2 behavior.

## Architecture seam (decision — read before coding)

The spec asks us to choose between (a) the detector writes campaign/winner refs into `alert.evidence` at build time (keeps `rankMoves` pure, but couples the detector SQL to the remediation feature and bloats evidence) or (b) `attachRemediation`/a new enrichment step becomes async and queries the view.

**Decision: (b) — keep `rankMoves` pure; add a thin async `enrichRemediation`.** Rationale:

- The pure ranking is the tested backbone (Phase 1's `rank.test.ts`); making it async would force every unit test to mock a DB and would leak Supabase into a file that must stay client-importable. Rejected.
- The detector-writes-evidence path (a) would require editing the 5 detector SQL builders to JOIN the new attribution/winner logic at *alert-build* time, computing winner rankings for alerts that may never be opened, and would re-shape `alert.evidence` (which the EvidencePanel renders) with internal campaign uuids. It also can't react to live budget/grade changes between alert-build and open. Rejected.
- **Chosen:** `rowToAlert` stays synchronous and calls Phase 1's pure `attachRemediation` (plan + synopsis from evidence). A *separate, opt-in* async `enrichRemediation(alert, sb)` is called only on the **detail** read paths (dashboard + embedded loaders), where one extra indexed view read is cheap and the data is fresh. It mutates only `move.executor`, `move.target`, and `move.ineligibleReason` for the `reallocate_to_winner` / `cut_ads` moves. Lists (which never render buttons) skip it.

**Ripple to Phase 4 (must adopt):** autopilot reads `plan.recommended` + the enriched `target` to execute. Because enrichment is a discrete server function, Phase 4's `v_autopilot_candidates` / `autopilot.server.ts` calls the **same** `enrichRemediation` before acting — no second SKU→campaign resolver. Phase 4 must NOT re-derive the winner; it consumes the enriched `target`.

## Cross-phase `executor` union (locked — additive only)

`StrategicMove.executor` widens monotonically across phases. Do **not** remove prior values:

```ts
// Phase 1: "snooze_alert" | null
// Phase 2 added:  "discontinue_sku"
// Phase 3 adds:   "reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget"
executor:
  | "snooze_alert"
  | "discontinue_sku"
  | "reallocate_spend_sku"
  | "pause_campaign"
  | "reduce_campaign_budget"
  | null;
```

`target` shape (spelled identically in `types.ts`, the view-mapper, the gateway, and both panels):

```ts
target?: {
  skuId?: string;          // loser sku_dim uuid
  loserCampaignId?: string;  // ad_campaign_dim uuid (the dedicated mutable loser campaign)
  winnerSkuId?: string;      // catalog winner sku_dim uuid
  winnerCampaignId?: string; // ad_campaign_dim uuid (the winner's dedicated mutable campaign)
  winnerLabel?: string;      // human winner name for the button ("Hydration Bottle")
  amountCents?: number;      // daily-budget cents to shift loser→winner
};
```

## File structure

| File | Responsibility | Task |
|---|---|---|
| `supabase/migrations/20260620121000_v_sku_remediation_inputs.sql` | New view: per-SKU contribution + returns + dedicated mutable campaign + ranked catalog winner | 1 |
| `app/lib/remediation/types.ts` | Widen `MoveKind.executor` union; add `target` to `StrategicMove`; add `RemediationEnrichment` types | 2 |
| `app/lib/remediation/enrich.server.ts` | `enrichRemediation(alert, sb)` — read view, fill target/executor/ineligibleReason | 3, 4 |
| `app/lib/remediation/__tests__/enrich.test.ts` | Eligibility tests (dedicated present/absent, winner present/absent, shared→advisory) | 3, 4 |
| `app/lib/types.ts` | Add `"reallocate_spend_sku"` to `ActionKind` | 5 |
| `app/lib/labels.ts` | `ACTION_LABELS` / `ACTION_VERBS` entries; add `reallocate_spend_sku` to `DETECTOR_TO_ACTIONS` for the 2 ad-driven detectors | 5 |
| `app/lib/actions/reallocate-sku.server.ts` | SKU-scoped gateway: resolve loser+winner campaigns → delegate to `executeReallocation` | 6 |
| `app/lib/actions/__tests__/reallocate-sku.test.ts` | Gateway tests (eligible shift, advisory-reject, dollar cap, not-open) | 6 |
| `app/routes/dashboard.api.alerts.$id.action.tsx` | Accept `reallocate_spend_sku`; route to the new gateway | 7 |
| `app/routes/app.alerts.$id.tsx` | Embedded action handler `reallocate_spend_sku` intent + call `enrichRemediation` in loader; render the button | 8 |
| `app/components/dashboard/screens/Alerts.tsx` | Dashboard Fix-it panel: enriched buttons + advisory rows | 9 |
| `app/components/dashboard/DashboardApp.tsx` | `executeAction` branch for `reallocate_spend_sku` → `executeAlertAction` | 9 |
| `app/lib/dashboard/client.ts` | Dashboard loader calls `enrichRemediation`; `adaptAlert` passes enriched plan | 9 |

---

## Task 1: New view `v_sku_remediation_inputs`

Exposes everything `enrichRemediation` needs in ONE indexed read per SKU. No SKU→campaign key exists, so dedication is inferred from attribution-revenue concentration.

**Files:**
- Create: `supabase/migrations/20260620121000_v_sku_remediation_inputs.sql`

- [ ] **Step 1: Write the migration**

```sql
-- v_sku_remediation_inputs: per-SKU inputs for the product-economics remediation
-- engine's Phase 3 enrichment (naming the winner + detecting a dedicated mutable
-- campaign). One row per SKU that has a remediation-relevant signal.
--
-- There is NO structured SKU -> campaign key in this schema. A campaign's
-- dedication to a SKU is INFERRED: over the trailing 30-day window (same anchor
-- as v_skus_flat.velocity), join attribution_fact (order -> campaign) to
-- order_line_fact (order -> sku); a campaign is "dedicated" to a SKU when that
-- SKU's attributed revenue is >= 70% of the campaign's total attributed revenue
-- AND the campaign is active with a non-null daily_budget_cents ("mutable").
-- When the loser's spend lives in a catalog-wide campaign, no row qualifies and
-- the enrichment falls back to advisory (rule 12: never a dead button).
--
-- Columns:
--   sku_id, shop_id, sku, title
--   contribution_per_unit_cents : price - COGS - ship - returns, at ZERO ad
--     spend (the ditch-vs-tune gate's "structurally dead" basis), NULL when COGS
--     or price are unavailable (caller treats NULL as "margin source unavailable").
--   return_30d_cents            : returned revenue over the 30-day window.
--   dedicated_campaign_id       : ad_campaign_dim uuid of the dedicated mutable
--     campaign for this SKU, else NULL.
--   dedicated_campaign_platform : its platform (gateway constrains to 'meta').
--   dedicated_campaign_budget_cents : its current daily budget.
--   winner_rank                 : dense rank (1 = best) of this SKU as a catalog
--     winner: positive contribution_per_unit, stock headroom (days_of_cover >=
--     14), and a dedicated mutable campaign of its own. Higher-margin first.
--   security_invoker like every view in this schema; the app scopes reads with
--   an explicit .eq('shop_id', ...).
--
-- DEPENDENCY: references v_skus_flat (on_hand, velocity, days_of_cover,
-- ship_pnl_cents), v_sku_sales_30d (units_30d), v_sku_returns_30d
-- (returned_revenue_30d_cents), cogs_fact (unit_cost_cents), sku_dim, order_fact,
-- order_line_fact, attribution_fact, ad_campaign_dim. All exist on a current DB.

create or replace view public.v_sku_remediation_inputs
  with (security_invoker = on)
as
with max_order_day as (
  select shop_id, max(created_at_source) as anchor_ts
  from public.order_fact
  group by shop_id
),
-- Current unit cost: latest open-ended cogs_fact row per SKU.
unit_cost as (
  select distinct on (shop_id, sku_id)
         shop_id, sku_id, unit_cost_cents
  from public.cogs_fact
  where effective_to is null
  order by shop_id, sku_id, effective_from desc
),
-- Average sale price per unit over the window (gross line revenue / units).
unit_price as (
  select ol.shop_id,
         ol.sku_id,
         (sum(ol.total_cents)::numeric / nullif(sum(ol.quantity), 0)) as price_cents
  from public.order_line_fact ol
  join public.order_fact o on o.id = ol.order_id and o.shop_id = ol.shop_id
  join max_order_day m on m.shop_id = ol.shop_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and ol.sku_id is not null
  group by ol.shop_id, ol.sku_id
),
-- Per-unit ship cost from v_skus_flat.ship_pnl_cents is a P&L, not a cost; use
-- the 30-day returned revenue per unit sold as the returns drag instead.
returns_per_unit as (
  select r.shop_id,
         r.sku_id,
         (r.returned_revenue_30d_cents::numeric / nullif(r.units_sold_30d, 0)) as return_per_unit_cents
  from public.v_sku_returns_30d r
),
-- Each campaign's total attributed revenue + its single most-concentrated SKU
-- over the window, with that SKU's revenue share.
campaign_sku_rev as (
  select a.shop_id,
         a.campaign_id,
         ol.sku_id,
         sum(a.attributed_revenue_cents)::numeric as sku_rev
  from public.attribution_fact a
  join public.order_line_fact ol on ol.order_id = a.order_id and ol.shop_id = a.shop_id
  join public.order_fact o on o.id = a.order_id and o.shop_id = a.shop_id
  join max_order_day m on m.shop_id = a.shop_id
  where o.created_at_source > (m.anchor_ts - interval '30 days')
    and o.created_at_source <= m.anchor_ts
    and a.campaign_id is not null
    and ol.sku_id is not null
  group by a.shop_id, a.campaign_id, ol.sku_id
),
campaign_total_rev as (
  select shop_id, campaign_id, sum(sku_rev) as total_rev
  from campaign_sku_rev
  group by shop_id, campaign_id
),
-- A SKU's dedicated mutable campaign: the campaign where this SKU is >= 70% of
-- attributed revenue, the campaign is active + daily-budgeted. If a SKU is the
-- dominant SKU of more than one such campaign, take the highest-budget one.
dedicated as (
  select distinct on (csr.shop_id, csr.sku_id)
         csr.shop_id,
         csr.sku_id,
         c.id            as dedicated_campaign_id,
         c.platform      as dedicated_campaign_platform,
         c.daily_budget_cents as dedicated_campaign_budget_cents
  from campaign_sku_rev csr
  join campaign_total_rev ctr
    on ctr.shop_id = csr.shop_id and ctr.campaign_id = csr.campaign_id
  join public.ad_campaign_dim c
    on c.id = csr.campaign_id and c.shop_id = csr.shop_id
  where ctr.total_rev > 0
    and csr.sku_rev / ctr.total_rev >= 0.70
    and c.status = 'active'
    and c.daily_budget_cents is not null
  order by csr.shop_id, csr.sku_id, c.daily_budget_cents desc
),
base as (
  select sk.id   as sku_id,
         sk.shop_id,
         sk.sku,
         sk.title,
         f.days_of_cover,
         round(
           up.price_cents
           - coalesce(uc.unit_cost_cents, 0)
           - coalesce(rpu.return_per_unit_cents, 0)
         )::bigint as contribution_per_unit_cents_raw,
         (up.price_cents is not null and uc.unit_cost_cents is not null) as margin_known,
         coalesce(ret.returned_revenue_30d_cents, 0)::bigint as return_30d_cents,
         d.dedicated_campaign_id,
         d.dedicated_campaign_platform,
         d.dedicated_campaign_budget_cents
  from public.sku_dim sk
  join public.v_skus_flat f on f.id = sk.id and f.shop_id = sk.shop_id
  left join unit_price up        on up.sku_id = sk.id and up.shop_id = sk.shop_id
  left join unit_cost uc         on uc.sku_id = sk.id and uc.shop_id = sk.shop_id
  left join returns_per_unit rpu on rpu.sku_id = sk.id and rpu.shop_id = sk.shop_id
  left join public.v_sku_returns_30d ret on ret.sku_id = sk.id and ret.shop_id = sk.shop_id
  left join dedicated d          on d.sku_id = sk.id and d.shop_id = sk.shop_id
)
select
  b.sku_id,
  b.shop_id,
  b.sku,
  b.title,
  case when b.margin_known then b.contribution_per_unit_cents_raw else null end
    as contribution_per_unit_cents,
  b.return_30d_cents,
  b.dedicated_campaign_id,
  b.dedicated_campaign_platform,
  b.dedicated_campaign_budget_cents,
  -- Catalog-winner ranking: positive contribution, >=14 days of cover (stock
  -- headroom to absorb scaled spend), and its own dedicated mutable campaign.
  -- Higher contribution_per_unit ranks first. NULL for non-qualifying SKUs.
  case
    when b.margin_known
     and b.contribution_per_unit_cents_raw > 0
     and b.days_of_cover >= 14
     and b.dedicated_campaign_id is not null
    then dense_rank() over (
      partition by b.shop_id
      order by b.contribution_per_unit_cents_raw desc
    )
    else null
  end as winner_rank
from base b;

alter view public.v_sku_remediation_inputs set (security_invoker = on);
```

- [ ] **Step 2: Validate the SQL parses (repo convention for view migrations is raw SQL — no Prisma model)**

Run: `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script >/dev/null 2>&1 || true` (Prisma owns no views; this is a no-op sanity check). Then validate the view body against the live/branch DB the way sibling view migrations are validated:

Run: apply the migration to a Supabase branch and re-select:
`supabase db push --linked --include-all` *(or, in this repo's flow, apply via the Supabase MCP `apply_migration` to a dev branch)*, then `select * from public.v_sku_remediation_inputs limit 1;` via `execute_sql`.
Expected: migration applies clean; the select returns the column set above (no error). If `cogs_fact` / `attribution_fact` column names differ on the target DB, fix the view, not the callers.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260620121000_v_sku_remediation_inputs.sql
git commit -m "supabase: v_sku_remediation_inputs (contribution + returns + dedicated campaign + winner rank)"
```

---

## Task 2: Widen `StrategicMove` — `executor` union + `target`

**Files:**
- Modify: `app/lib/remediation/types.ts` (`MoveKind` executor union ~line 25; `StrategicMove` ~line 19-28)

- [ ] **Step 1: Widen the `executor` field and add `target`**

In `app/lib/remediation/types.ts`, replace the `executor` field on `StrategicMove` and add `target` + `ineligibleReason`. The new `StrategicMove` becomes:

```typescript
export interface StrategicMove {
  kind: MoveKind;
  /** Projected 30-day dollars recovered/gained, in cents. Drives the ranking. */
  dollarImpactCents: number;
  /** Live executor for this move, or null = advisory (rule 12: a null executor
   *  renders as a guidance row, never a dead button). Widened additively across
   *  phases — never remove a prior value:
   *    P1: "snooze_alert"
   *    P2: "discontinue_sku"
   *    P3: "reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget"
   */
  executor:
    | "snooze_alert"
    | "discontinue_sku"
    | "reallocate_spend_sku"
    | "pause_campaign"
    | "reduce_campaign_budget"
    | null;
  /** Why this move is advisory instead of executable, when known. Surfaced in
   *  the panel (rule 12), e.g. "served by a shared campaign". */
  ineligibleReason?: string;
  /** Concrete refs the executor needs, filled by enrichRemediation (Phase 3).
   *  Absent on advisory moves and on plans that were never enriched. */
  target?: {
    skuId?: string;
    loserCampaignId?: string;
    winnerSkuId?: string;
    winnerCampaignId?: string;
    winnerLabel?: string;
    amountCents?: number;
  };
  /** Short human label for the move (UI). */
  label: string;
}
```

> NOTE for the implementer: Phase 2 already added `"discontinue_sku"` to this union and may have added `ineligibleReason`/`target`. If so, this step is a no-op for those members — only ADD `"reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget"` and the new `target` keys (`loserCampaignId`, `winnerCampaignId`, `winnerLabel`, `amountCents`). Do not regress Phase 2's members.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. `rank.ts`'s `move()` helper sets `executor: kind === "snooze" ? "snooze_alert" : null` — still type-valid against the widened union (it only ever produces `"snooze_alert" | null` pre-enrichment).

- [ ] **Step 3: Commit**

```bash
git add app/lib/remediation/types.ts
git commit -m "remediation/types: widen executor union (reallocate_spend_sku, cut-ads kinds) + target refs"
```

---

## Task 3: `enrichRemediation` — eligible reallocate path

The async enrichment. Reads ONE `v_sku_remediation_inputs` row for the loser SKU, finds the top catalog winner, and — only when both have a dedicated mutable `meta` campaign — flips the `reallocate_to_winner` move to executable with a named winner + amount. Everything else stays advisory.

**Files:**
- Create: `app/lib/remediation/enrich.server.ts`
- Test: `app/lib/remediation/__tests__/enrich.test.ts`

- [ ] **Step 1: Write failing tests for the eligible path + the backbone eligibility matrix**

```typescript
// app/lib/remediation/__tests__/enrich.test.ts
import { describe, it, expect, vi } from "vitest";
import { enrichRemediation } from "../enrich.server";
import type { Alert } from "../../types";
import type { RemediationPlan } from "../types";
import type { SupabaseClient } from "@supabase/supabase-js";

const LOSER_SKU = "sku-loser-uuid";
const WINNER_SKU = "sku-winner-uuid";
const LOSER_CAMP = "camp-loser-uuid";
const WINNER_CAMP = "camp-winner-uuid";

function plan(over: Partial<RemediationPlan> = {}): RemediationPlan {
  return {
    moves: [
      { kind: "reallocate_to_winner", dollarImpactCents: 530449, executor: null, label: "Move ad budget to a higher-margin product" },
      { kind: "cut_ads", dollarImpactCents: 530449, executor: null, label: "Cut the ad spend driving the loss" },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "reallocate_to_winner",
    structurallyDead: false,
    ...over,
  };
}

function alert(over: Partial<Alert> = {}): Alert {
  return {
    id: "a1",
    detector_id: "negative_unit_economics",
    severity: "high",
    status: "open",
    dollar_impact: 530449,
    claude_rank: 1,
    created_at: "2026-06-20T00:00:00Z",
    title: "Summit Logo Tee — M",
    narrative: "",
    campaign: null,
    campaign_id: null,
    campaign_external_id: null,
    sku: "SUMMIT-TEE-M",
    evidence: { sku_id: LOSER_SKU, gross_unit_margin_usd: 23, cac_per_unit_usd: 170 },
    ...over,
  } as Alert;
}

// Fake supabase: returns the loser row, then the winner-pool rows, per .from() table.
function fakeSb(rows: { loser?: Record<string, unknown> | null; winners?: Record<string, unknown>[] }) {
  function builder() {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.order = vi.fn(() => chain);
    chain.limit = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: rows.loser ?? null, error: null }));
    // winner pool fetch resolves the awaited builder to { data, error }
    chain.then = (res: (v: { data: unknown; error: null }) => void) =>
      res({ data: rows.winners ?? [], error: null });
    return chain;
  }
  return { from: vi.fn(() => builder()) } as unknown as SupabaseClient;
}

describe("enrichRemediation — reallocate eligibility", () => {
  it("dedicated loser campaign + qualifying winner → reallocate_spend_sku button with named winner + amount", async () => {
    const sb = fakeSb({
      loser: {
        sku_id: LOSER_SKU, contribution_per_unit_cents: 2300,
        dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta",
        dedicated_campaign_budget_cents: 45000,
      },
      winners: [
        { sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1,
          dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "meta",
          dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 },
      ],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBe("reallocate_spend_sku");
    expect(realloc.target?.loserCampaignId).toBe(LOSER_CAMP);
    expect(realloc.target?.winnerCampaignId).toBe(WINNER_CAMP);
    expect(realloc.target?.winnerLabel).toBe("Hydration Bottle");
    expect(realloc.target?.amountCents).toBeGreaterThan(0);
    expect(realloc.target?.amountCents).toBeLessThan(45000); // must leave source above zero
    expect(realloc.ineligibleReason).toBeUndefined();
  });

  it("no dedicated loser campaign (shared Advantage+) → advisory, ineligibleReason set, NOT a button", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: null, dedicated_campaign_platform: null, dedicated_campaign_budget_cents: null },
      winners: [{ sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1, dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 }],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/shared campaign|Advantage/i);
  });

  it("dedicated loser campaign but NO qualifying winner → reallocate stays advisory", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [], // no winner_rank rows
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/no qualifying winner/i);
  });

  it("winner on a different platform than the loser → advisory (Meta-only shift)", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [{ sku_id: WINNER_SKU, title: "Hydration Bottle", winner_rank: 1, dedicated_campaign_id: WINNER_CAMP, dedicated_campaign_platform: "google", dedicated_campaign_budget_cents: 7000, contribution_per_unit_cents: 1800 }],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const realloc = out.moves.find((m) => m.kind === "reallocate_to_winner")!;
    expect(realloc.executor).toBeNull();
    expect(realloc.ineligibleReason).toMatch(/same platform|Meta/i);
  });

  it("leaves a plan with no reallocate move untouched (e.g. structurally dead → discontinue)", async () => {
    const sb = fakeSb({ loser: null, winners: [] });
    const dead = plan({ moves: [{ kind: "discontinue", dollarImpactCents: 5000, executor: "discontinue_sku", label: "Stop reordering this product" }, { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" }], recommended: "discontinue", structurallyDead: true });
    const out = await enrichRemediation(alert(), dead, sb, "shop-1");
    expect(out.moves.find((m) => m.kind === "discontinue")?.executor).toBe("discontinue_sku");
  });

  it("alert with no sku_id on evidence → returns the plan unchanged (no DB read possible)", async () => {
    const sb = fakeSb({ loser: null, winners: [] });
    const out = await enrichRemediation(alert({ evidence: {} }), plan(), sb, "shop-1");
    expect(out.moves.find((m) => m.kind === "reallocate_to_winner")?.executor).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/remediation/__tests__/enrich.test.ts`
Expected: FAIL — "Failed to resolve import ../enrich.server" / `enrichRemediation is not a function`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/remediation/enrich.server.ts
// Async enrichment for the product-economics remediation plan (Phase 3). The
// ranking decision (rank.ts) stays PURE; this fills the winner/campaign target
// and flips reallocate_to_winner / cut_ads from advisory (null executor) to
// executable — but ONLY when eligible (rule 12: never a dead button). Reads one
// row from v_sku_remediation_inputs for the loser SKU plus the catalog winner
// pool. Server-only: imports Supabase types.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Alert } from "../types";
import type { RemediationPlan, StrategicMove } from "./types";

interface SkuRemediationRow {
  sku_id: string;
  title?: string | null;
  contribution_per_unit_cents: number | null;
  dedicated_campaign_id: string | null;
  dedicated_campaign_platform: string | null;
  dedicated_campaign_budget_cents: number | null;
  winner_rank?: number | null;
}

// Fraction of the loser's dedicated-campaign daily budget to shift to the
// winner. Must leave the source above zero (executeReallocation rejects
// amount >= source budget); 0.5 is well clear and matches the autopilot cut feel.
const SHIFT_FRACTION = 0.5;

/**
 * Enrich a remediation plan with live SKU->campaign resolution. Returns a NEW
 * plan (does not mutate the input). A missing sku_id, missing view row, no
 * dedicated campaign, no qualifying winner, or a cross-platform winner all leave
 * the reallocate move advisory with an ineligibleReason. Best-effort: any DB
 * error logs and returns the plan unchanged (the advisory plan still renders).
 */
export async function enrichRemediation(
  alert: Alert,
  plan: RemediationPlan,
  sb: SupabaseClient,
  shopId: string,
): Promise<RemediationPlan> {
  const reallocIdx = plan.moves.findIndex((m) => m.kind === "reallocate_to_winner");
  if (reallocIdx < 0) return plan; // nothing to enrich (e.g. discontinue/fix_returns plan)

  const skuId = typeof alert.evidence?.sku_id === "string" ? alert.evidence.sku_id : null;

  const setAdvisory = (reason: string): RemediationPlan => withMove(plan, reallocIdx, (m) => ({
    ...m,
    executor: null,
    ineligibleReason: reason,
  }));

  if (!skuId) return setAdvisory("served by a shared campaign — exclude this SKU inside Advantage+ instead");

  try {
    const { data: loser, error: lErr } = await sb
      .from("v_sku_remediation_inputs")
      .select(
        "sku_id, contribution_per_unit_cents, dedicated_campaign_id, dedicated_campaign_platform, dedicated_campaign_budget_cents",
      )
      .eq("shop_id", shopId)
      .eq("sku_id", skuId)
      .maybeSingle();
    if (lErr) throw lErr;

    const loserRow = loser as SkuRemediationRow | null;
    if (!loserRow?.dedicated_campaign_id || loserRow.dedicated_campaign_budget_cents == null) {
      return setAdvisory("served by a shared campaign — exclude this SKU inside Advantage+ instead");
    }
    if (loserRow.dedicated_campaign_platform !== "meta") {
      return setAdvisory("budget shift is Meta-only — adjust this campaign in its platform");
    }

    // Top catalog winner with its own dedicated mutable campaign, excluding the
    // loser SKU. winner_rank ascends (1 = best); take the first.
    const { data: winners, error: wErr } = await sb
      .from("v_sku_remediation_inputs")
      .select("sku_id, title, winner_rank, dedicated_campaign_id, dedicated_campaign_platform, dedicated_campaign_budget_cents")
      .eq("shop_id", shopId)
      .not("winner_rank", "is", null)
      .order("winner_rank", { ascending: true })
      .limit(5);
    if (wErr) throw wErr;

    const winner = ((winners ?? []) as SkuRemediationRow[]).find(
      (w) => w.sku_id !== skuId && w.dedicated_campaign_id,
    );
    if (!winner) return setAdvisory("no qualifying winner — no higher-margin product with stock headroom and a scalable campaign");
    if (winner.dedicated_campaign_platform !== "meta") {
      return setAdvisory("winner runs on a different platform — budget shift must stay on Meta");
    }

    const amountCents = Math.max(1, Math.floor(loserRow.dedicated_campaign_budget_cents * SHIFT_FRACTION));

    return withMove(plan, reallocIdx, (m) => ({
      ...m,
      executor: "reallocate_spend_sku",
      ineligibleReason: undefined,
      label: `Move ad budget to ${winner.title ?? "your top product"}`,
      target: {
        skuId,
        loserCampaignId: loserRow.dedicated_campaign_id!,
        winnerSkuId: winner.sku_id,
        winnerCampaignId: winner.dedicated_campaign_id!,
        winnerLabel: winner.title ?? undefined,
        amountCents,
      },
    }));
  } catch (err) {
    console.error(`[remediation] enrich failed for alert ${alert.id} (advisory fallback)`, err);
    return setAdvisory("couldn't resolve the campaign — review manually");
  }
}

function withMove(
  plan: RemediationPlan,
  idx: number,
  fn: (m: StrategicMove) => StrategicMove,
): RemediationPlan {
  const moves = plan.moves.map((m, i) => (i === idx ? fn(m) : m));
  return { ...plan, moves };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/remediation/__tests__/enrich.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/remediation/enrich.server.ts app/lib/remediation/__tests__/enrich.test.ts
git commit -m "remediation/enrich: async winner+campaign resolution (reallocate eligibility, advisory fallbacks)"
```

---

## Task 4: `enrichRemediation` — cut_ads executable path

`cut_ads` is the simpler lever: when the loser has a dedicated mutable campaign (even without a winner), the move becomes executable as `reduce_campaign_budget` (or `pause_campaign` when the campaign budget is below the reduce floor). This reuses the shipped campaign executor — no new mutation.

**Files:**
- Modify: `app/lib/remediation/enrich.server.ts` (extend the eligible branch)
- Modify: `app/lib/remediation/__tests__/enrich.test.ts` (append)

- [ ] **Step 1: Append failing tests**

```typescript
// append to app/lib/remediation/__tests__/enrich.test.ts
describe("enrichRemediation — cut_ads", () => {
  it("dedicated loser campaign → cut_ads becomes reduce_campaign_budget with loserCampaignId, even with no winner", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: LOSER_CAMP, dedicated_campaign_platform: "meta", dedicated_campaign_budget_cents: 45000 },
      winners: [],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    const cut = out.moves.find((m) => m.kind === "cut_ads")!;
    expect(cut.executor).toBe("reduce_campaign_budget");
    expect(cut.target?.loserCampaignId).toBe(LOSER_CAMP);
  });

  it("no dedicated loser campaign → cut_ads stays advisory too", async () => {
    const sb = fakeSb({
      loser: { sku_id: LOSER_SKU, contribution_per_unit_cents: 2300, dedicated_campaign_id: null, dedicated_campaign_platform: null, dedicated_campaign_budget_cents: null },
      winners: [],
    });
    const out = await enrichRemediation(alert(), plan(), sb, "shop-1");
    expect(out.moves.find((m) => m.kind === "cut_ads")?.executor).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm the cut_ads tests fail** (the Task 3 impl only touches `reallocate_to_winner`)

Run: `npx vitest run app/lib/remediation/__tests__/enrich.test.ts -t cut_ads`
Expected: FAIL — `cut.executor` is still `null`.

- [ ] **Step 3: Extend the implementation to enrich `cut_ads`**

In `enrich.server.ts`, after computing `loserRow` (and before the reallocate winner lookup), add a helper that enriches the `cut_ads` move whenever the loser campaign is dedicated+mutable+meta. Add a `cutIdx` lookup near `reallocIdx`:

```typescript
  const cutIdx = plan.moves.findIndex((m) => m.kind === "cut_ads");
```

Then, in the eligible branch (right after the `loserRow.dedicated_campaign_platform !== "meta"` guard passes), enrich `cut_ads` before returning. Replace the two `return withMove(...)` / `return setAdvisory(...)` tail so the function threads BOTH moves. Concretely, compute the cut_ads patch once and apply it alongside the reallocate result:

```typescript
    // cut_ads: executable whenever the loser has a dedicated mutable Meta
    // campaign. Below the reduce floor (where a 30% cut would underspend), pause
    // outright; otherwise reduce. Reuses the shipped campaign executor.
    const REDUCE_FLOOR_CENTS = 1000; // below this, reduce is pointless → pause
    const cutKind: StrategicMove["executor"] =
      loserRow.dedicated_campaign_budget_cents < REDUCE_FLOOR_CENTS
        ? "pause_campaign"
        : "reduce_campaign_budget";

    let enriched = plan;
    if (cutIdx >= 0) {
      enriched = withMove(enriched, cutIdx, (m) => ({
        ...m,
        executor: cutKind,
        ineligibleReason: undefined,
        target: { skuId, loserCampaignId: loserRow.dedicated_campaign_id! },
      }));
    }
    // ... then run the winner lookup against `enriched` and patch reallocIdx on it.
```

Adjust the reallocate branch to operate on `enriched` (not `plan`): change the winner-eligible `return withMove(plan, reallocIdx, ...)` to `return withMove(enriched, reallocIdx, ...)`, and the winner-ineligible `setAdvisory(...)` to patch `enriched` (keep cut_ads executable while reallocate falls back). Easiest: make `setAdvisory` close over a `base` plan param:

```typescript
  const advisory = (base: RemediationPlan, reason: string) =>
    withMove(base, reallocIdx, (m) => ({ ...m, executor: null, ineligibleReason: reason }));
```

so the no-winner case returns `advisory(enriched, "no qualifying winner — ...")` (cut_ads stays executable, reallocate advisory). The no-dedicated-campaign and missing-sku cases return `advisory(plan, ...)` with cut_ads left advisory (its loser campaign is unknown too).

- [ ] **Step 4: Run all enrich tests to verify they pass**

Run: `npx vitest run app/lib/remediation/__tests__/enrich.test.ts`
Expected: PASS (8 tests). If a reallocate test regressed because the base plan changed from `plan` to `enriched`, fix `enrich.server.ts` — do not weaken the tests.

- [ ] **Step 5: Commit**

```bash
git add app/lib/remediation/enrich.server.ts app/lib/remediation/__tests__/enrich.test.ts
git commit -m "remediation/enrich: make cut_ads executable via the shipped campaign executor"
```

---

## Task 5: `ActionKind` + labels + detector allow-list

**Files:**
- Modify: `app/lib/types.ts` (`ActionKind` union ~line 7-18)
- Modify: `app/lib/labels.ts` (`ACTION_LABELS` ~line 42, `ACTION_VERBS` ~line 56, `DETECTOR_TO_ACTIONS` ~line 304)

- [ ] **Step 1: Add `reallocate_spend_sku` to `ActionKind`**

In `app/lib/types.ts`, add the member to the `ActionKind` union (after `reallocate_budget`):

```typescript
  | "reallocate_budget"
  | "reallocate_spend_sku"
```

- [ ] **Step 2: Add labels + verb**

In `app/lib/labels.ts`, add to `ACTION_LABELS` (after `reallocate_budget`):

```typescript
  reallocate_spend_sku: "Move ad budget to a winner",
```

and to `ACTION_VERBS`:

```typescript
  reallocate_spend_sku: "Moved ad budget to a winner",
```

(Both records are keyed by the full `ActionKind`, so the new member must appear in each or `tsc` fails — this is the type-completeness guard working.)

- [ ] **Step 3: Allow the action on the two ad-driven product-economics detectors**

In `DETECTOR_TO_ACTIONS`, add `reallocate_spend_sku` to the two detectors `rankMoves` ever recommends reallocate for (the gateway's `DETECTOR_TO_ACTIONS` allow-check, `alert-action.server.ts:60`, gates execution):

```typescript
  ad_tax_overload: ["reallocate_budget", "reallocate_spend_sku", "reduce_campaign_budget", "pause_campaign", "discontinue_sku", "snooze_alert"],
  negative_unit_economics: ["reallocate_spend_sku", "pause_campaign", "reduce_campaign_budget", "discontinue_sku", "snooze_alert"],
```

> **Note (additive — preserves Phase 2's discontinue_sku authorization; do not drop it.)** Phase 2 deliberately authorized `discontinue_sku` for all 5 product-economics detectors. These arrays must keep `discontinue_sku` before `snooze_alert`; removing it regresses the discontinue gateway (403 on a structurally-dead alert's Discontinue button).

(`pause_campaign` / `reduce_campaign_budget` are already allowed for both — cut_ads reuses them.)

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. Any `Record<ActionKind, ...>` that newly errors (e.g. `CD_ACTION_ICON`, dashboard `client.ts` ACTION_LABELS mirror) must gain a `reallocate_spend_sku` entry — fix those, do not cast.

- [ ] **Step 5: Commit**

```bash
git add app/lib/types.ts app/lib/labels.ts
git commit -m "types/labels: add reallocate_spend_sku action kind + detector allow-list"
```

---

## Task 6: `reallocate_spend_sku` gateway — SKU-scoped, delegates to `executeReallocation`

The new gateway mirrors `executeInventoryAlertAction`'s contract (load alert → reject if not `open` → `DETECTOR_TO_ACTIONS` allow-check → dollar cap → derive inputs FROM THE ALERT, never the body). It re-runs `enrichRemediation` server-side to re-resolve the loser+winner campaigns (do not trust client-supplied campaign ids — rule: derive from the trusted record), then delegates to the shipped `executeReallocation`, which already writes the one audit row (`action_kind: "reallocate_budget"`), supports undo, and parks `retrying`.

**Files:**
- Create: `app/lib/actions/reallocate-sku.server.ts`
- Test: `app/lib/actions/__tests__/reallocate-sku.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/actions/__tests__/reallocate-sku.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeReallocateSpendSku } from "../reallocate-sku.server";
import { CalderynError } from "../../calderyn.server";

const executeReallocation = vi.fn();
vi.mock("../reallocate.server", () => ({
  executeReallocation: (...a: unknown[]) => executeReallocation(...a),
}));
const enrichRemediation = vi.fn();
vi.mock("../../remediation/enrich.server", () => ({
  enrichRemediation: (...a: unknown[]) => enrichRemediation(...a),
}));
const acknowledgeAlert = vi.fn(async () => true);
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));

const LOSER_CAMP = "camp-loser";
const WINNER_CAMP = "camp-winner";

function eligiblePlan() {
  return {
    moves: [
      {
        kind: "reallocate_to_winner",
        dollarImpactCents: 530449,
        executor: "reallocate_spend_sku",
        label: "Move ad budget to Hydration Bottle",
        target: { loserCampaignId: LOSER_CAMP, winnerCampaignId: WINNER_CAMP, winnerLabel: "Hydration Bottle", amountCents: 22500 },
      },
      { kind: "snooze", dollarImpactCents: 0, executor: "snooze_alert", label: "Snooze" },
    ],
    recommended: "reallocate_to_winner",
    structurallyDead: false,
  };
}

const baseAlert = {
  id: "al-1", detector_id: "negative_unit_economics", severity: "high", status: "open",
  dollar_impact: 50000, claude_rank: 1, created_at: "2026-06-20T00:00:00Z",
  title: "Summit Tee", narrative: "", campaign: null, campaign_id: null,
  campaign_external_id: null, sku: "SUMMIT-TEE-M", evidence: { sku_id: "sku-loser" },
};

const alertsGet = vi.fn(async () => baseAlert);
const guardrailsGet = vi.fn(async () => ({ dollar_cap_cents: 100000 }));
const client = { alerts: { get: alertsGet }, guardrails: { get: guardrailsGet } } as never;
const SB = { mocked: true } as never;

function run(over: Record<string, unknown> = {}) {
  return executeReallocateSpendSku({
    client, sb: SB, shopId: "shop-1", alertId: "al-1", idempotencyKey: "idem-1", ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  enrichRemediation.mockResolvedValue(eligiblePlan());
  executeReallocation.mockResolvedValue({ id: "aud-1", outcome: "succeeded" });
});

describe("executeReallocateSpendSku", () => {
  it("delegates to executeReallocation with the server-resolved loser→winner pair + amount", async () => {
    const res = await run();
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        alertId: "al-1",
        sourceCampaignId: LOSER_CAMP,
        destCampaignId: WINNER_CAMP,
        amountCents: 22500,
        idempotencyKey: "idem-1",
      }),
      SB,
    );
    expect(res.outcome).toBe("succeeded");
  });

  it("rejects when the alert is not open (409)", async () => {
    alertsGet.mockResolvedValueOnce({ ...baseAlert, status: "resolved" });
    await expect(run()).rejects.toMatchObject({ status: 409 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("rejects when the enriched plan has no executable reallocate (advisory) (422)", async () => {
    enrichRemediation.mockResolvedValueOnce({
      moves: [{ kind: "reallocate_to_winner", dollarImpactCents: 1, executor: null, ineligibleReason: "served by a shared campaign", label: "x" }],
      recommended: null, structurallyDead: false,
    });
    await expect(run()).rejects.toMatchObject({ status: 422 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("rejects when dollar impact exceeds the per-action cap (403)", async () => {
    guardrailsGet.mockResolvedValueOnce({ dollar_cap_cents: 100 }); // alert impact 50000 > cap
    await expect(run()).rejects.toMatchObject({ status: 403 });
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("acknowledges the alert on success", async () => {
    await run();
    expect(acknowledgeAlert).toHaveBeenCalledWith(SB, "shop-1", "al-1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/actions/__tests__/reallocate-sku.test.ts`
Expected: FAIL — cannot resolve `../reallocate-sku.server`.

- [ ] **Step 3: Write the implementation**

```typescript
// app/lib/actions/reallocate-sku.server.ts
// SKU-scoped gateway for reallocate_spend_sku: the product-economics analogue of
// executeInventoryAlertAction. The loser->winner campaign pair and the shift
// amount are RE-DERIVED server-side from the trusted alert + enrichRemediation
// (never the request body), then handed to the shipped composite executor
// executeReallocation, which owns the two-leg budget shift, the single
// append-only action_audit row (action_kind "reallocate_budget"), undo, and the
// retry drain. This file adds only the SKU->campaign resolution + the alert
// gateway checks (open, allow-list, dollar cap, acknowledge).

import type { SupabaseClient } from "@supabase/supabase-js";
import { CalderynError } from "../calderyn.server";
import { DETECTOR_TO_ACTIONS } from "../labels";
import { fmtMoney } from "../format";
import { acknowledgeAlert } from "../alerts.server";
import { rankMoves, toNumericEvidence } from "../remediation/rank";
import { enrichRemediation } from "../remediation/enrich.server";
import { executeReallocation } from "./reallocate.server";
import type { Alert, GuardrailConfig } from "../types";

export interface ReallocateSkuClient {
  alerts: { get(id: string, signal?: AbortSignal): Promise<Alert> };
  guardrails: { get(signal?: AbortSignal): Promise<GuardrailConfig> };
}

export async function executeReallocateSpendSku(opts: {
  client: ReallocateSkuClient;
  sb: SupabaseClient;
  shopId: string;
  alertId: string;
  idempotencyKey: string;
  actor?: string;
  triggerReason?: string;
  signal?: AbortSignal;
}): Promise<{ auditId: string; outcome: string; acknowledged: boolean }> {
  const { client, sb, shopId, alertId, idempotencyKey, actor, triggerReason, signal } = opts;

  const alert = await client.alerts.get(alertId, signal);

  if (alert.status !== "open") {
    throw new CalderynError({
      code: "alert_not_open",
      status: 409,
      message: `This alert is ${alert.status}; actions only apply to open alerts.`,
    });
  }

  const allowed = DETECTOR_TO_ACTIONS[alert.detector_id] ?? ["snooze_alert"];
  if (!allowed.includes("reallocate_spend_sku")) {
    throw new CalderynError({
      code: "action_not_allowed",
      status: 403,
      message: `"reallocate_spend_sku" is not a permitted action for this alert.`,
    });
  }

  const guardrails = await client.guardrails.get(signal);
  if (alert.dollar_impact > guardrails.dollar_cap_cents) {
    throw new CalderynError({
      code: "guardrail_dollar_cap",
      status: 403,
      message: `This action's impact (${fmtMoney(alert.dollar_impact)}) exceeds the per-action cap of ${fmtMoney(guardrails.dollar_cap_cents)}.`,
    });
  }

  // Re-derive the campaign pair from the trusted alert, not the request body.
  const plan = await enrichRemediation(
    alert,
    rankMoves({
      detectorId: alert.detector_id,
      dollarImpactCents: alert.dollar_impact,
      evidence: toNumericEvidence(alert.evidence ?? {}),
    }),
    sb,
    shopId,
  );
  const move = plan.moves.find((m) => m.kind === "reallocate_to_winner");
  const t = move?.target;
  if (
    move?.executor !== "reallocate_spend_sku" ||
    !t?.loserCampaignId ||
    !t.winnerCampaignId ||
    !t.amountCents
  ) {
    throw new CalderynError({
      code: "reallocate_not_eligible",
      status: 422,
      message:
        move?.ineligibleReason ??
        "This product has no dedicated campaign or qualifying winner to reallocate between.",
    });
  }

  const audit = await executeReallocation(
    shopId,
    {
      alertId,
      sourceCampaignId: t.loserCampaignId,
      destCampaignId: t.winnerCampaignId,
      amountCents: t.amountCents,
      idempotencyKey,
      actor: actor ?? "merchant",
      triggerReason: triggerReason ?? null,
    },
    sb,
  );

  // executeReallocation already acknowledges on success (insertAuditWithIdempotency);
  // re-assert here so the gateway's return reflects it consistently with the
  // inventory gateway (best-effort, never fails the executed action).
  let acknowledged = false;
  if (audit.outcome === "succeeded") {
    acknowledged = await acknowledgeAlert(sb, shopId, alertId);
  }

  return { auditId: audit.id, outcome: audit.outcome, acknowledged };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/actions/__tests__/reallocate-sku.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/reallocate-sku.server.ts app/lib/actions/__tests__/reallocate-sku.test.ts
git commit -m "actions/reallocate-sku: SKU-scoped gateway delegating to executeReallocation"
```

---

## Task 7: Dashboard action route — accept `reallocate_spend_sku`

The dashboard alert-action endpoint currently handles only `reallocate_inventory | snooze_alert`. Add `reallocate_spend_sku` and route it to the new gateway (no `admin` client needed — it's a Meta budget shift, not a Shopify mutation).

**Files:**
- Modify: `app/routes/dashboard.api.alerts.$id.action.tsx` (~lines 13-55)

- [ ] **Step 1: Branch the route on action kind**

Replace the single-gateway body with a switch. Keep the inventory gateway for its kinds; add the reallocate gateway. The `KINDS` guard and dispatch become:

```typescript
import {
  executeInventoryAlertAction,
  type InventoryAlertActionKind,
} from "~/lib/actions/alert-action.server";
import { executeReallocateSpendSku } from "~/lib/actions/reallocate-sku.server";

const INVENTORY_KINDS: InventoryAlertActionKind[] = ["reallocate_inventory", "snooze_alert"];
const KINDS = [...INVENTORY_KINDS, "reallocate_spend_sku"] as const;
```

In the action body, after validating `kind` against `KINDS`:

```typescript
  const kind = body.type as (typeof KINDS)[number];
  // ... idempotency + KINDS.includes(kind) checks unchanged ...

  return dashboardJson(async () => {
    if (kind === "reallocate_spend_sku") {
      const { auditId, outcome, acknowledged } = await executeReallocateSpendSku({
        client,
        sb: getSupabase(),
        shopId: session.shopId,
        alertId,
        idempotencyKey,
        actor: "merchant:web-dashboard",
        signal: request.signal,
      });
      return { audit_id: auditId, outcome, acknowledged };
    }
    const { admin } = await unauthenticated.admin(session.shopDomain);
    const { auditId, outcome, acknowledged } = await executeInventoryAlertAction({
      client, admin, sb: getSupabase(), shopId: session.shopId, alertId,
      kind: kind as InventoryAlertActionKind, idempotencyKey, signal: request.signal,
    });
    return { audit_id: auditId, outcome, acknowledged };
  });
```

(The reallocate path skips `unauthenticated.admin` — it needs no Shopify Admin client. `calderynClient(session.shopDomain)` already provides the `alerts`/`guardrails` slice the gateway needs.)

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/dashboard.api.alerts.$id.action.tsx`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/routes/dashboard.api.alerts.$id.action.tsx
git commit -m "dashboard.api.alerts.action: route reallocate_spend_sku to the SKU gateway"
```

---

## Task 8: Embedded app — enrich loader + execute intent + render button

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (loader; action `reallocate_spend_sku` intent; "Recommended actions" Card ~lines 524-573)

- [ ] **Step 1: Enrich the plan in the loader**

In the embedded detail loader, after the alert is fetched and (per the Phase 1 contract) `attachRemediation` has populated `alert.remediation`, call the async enrichment so the panel can render a real button:

```typescript
import { enrichRemediation } from "~/lib/remediation/enrich.server";
// ... in the loader, after resolving `alert` and `shopId`:
if (alert.remediation) {
  alert.remediation = await enrichRemediation(alert, alert.remediation, getSupabase(), shopId);
}
```

- [ ] **Step 2: Add the `reallocate_spend_sku` action intent**

In the route `action`, alongside the existing campaign-kind branch (which calls `executeAction` with `ExecutableKind`), add a branch that routes `reallocate_spend_sku` to the gateway. Place it before the legacy `client.actions.execute` fallthrough:

```typescript
    if (kind === "reallocate_spend_sku") {
      const shopId = await resolveShopId(session.shop);
      const { outcome } = await executeReallocateSpendSku({
        client,
        sb: getSupabase(),
        shopId,
        alertId,
        idempotencyKey,
        actor: "merchant",
      });
      return json<ActionPayload>({
        ok: outcome === "succeeded",
        toast: {
          message:
            outcome === "succeeded"
              ? "Moved ad budget to your top product — logged to action history"
              : outcome === "retrying"
                ? "Couldn't reach Meta — queued, will retry automatically"
                : "Action recorded as failed — check the audit log",
          isError: outcome === "failed",
        },
      });
    }
```

(Import `executeReallocateSpendSku` from `~/lib/actions/reallocate-sku.server` at the top of the file.)

- [ ] **Step 3: Render executable + advisory remediation moves in the Card**

Inside the "Recommended actions" `Card`, after the `{fmtMoney(alert.dollar_impact)}` block, render the remediation moves when a plan is present. Executable moves (`executor !== null` and not `snooze_alert`) submit the intent; advisory moves render as guidance with their `ineligibleReason`:

```tsx
                {alert.remediation && (
                  <BlockStack gap="200">
                    {alert.rec_detail && (
                      <Text as="p" variant="bodyMd">{alert.rec_detail}</Text>
                    )}
                    {alert.remediation.moves
                      .filter((m) => m.kind !== "snooze")
                      .map((m) => {
                        const rec = m.kind === alert.remediation!.recommended;
                        const executable =
                          m.executor === "reallocate_spend_sku" ||
                          m.executor === "reduce_campaign_budget" ||
                          m.executor === "pause_campaign" ||
                          m.executor === "discontinue_sku";
                        if (executable) {
                          return (
                            <fetcher.Form method="post" key={m.kind}>
                              <input type="hidden" name="intent" value={m.executor!} />
                              <input type="hidden" name="idempotency_key" value={idemKey} />
                              <InlineStack gap="200" blockAlign="center">
                                <Button submit variant={rec ? "primary" : "secondary"} loading={isSubmitting}>
                                  {m.label}
                                </Button>
                                {rec && <Badge tone="success">Recommended</Badge>}
                              </InlineStack>
                            </fetcher.Form>
                          );
                        }
                        return (
                          <InlineStack key={m.kind} gap="150" blockAlign="center" wrap={false}>
                            {rec && <Badge tone="success">Recommended</Badge>}
                            <Text as="span" variant="bodyMd">{m.label}</Text>
                            {m.ineligibleReason && (
                              <Text as="span" variant="bodyXs" tone="subdued">— {m.ineligibleReason}</Text>
                            )}
                          </InlineStack>
                        );
                      })}
                  </BlockStack>
                )}
```

(`Button`, `Badge`, `InlineStack`, `BlockStack`, `Text` are already imported in this file — confirmed. `idemKey` / `fetcher` / `isSubmitting` already exist in the existing action plumbing; reuse them. The `intent` value is the move's `executor`, which the action already keys off for campaign kinds and now `reallocate_spend_sku`.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/routes/app.alerts.$id.tsx`
Expected: exit 0.

- [ ] **Step 5: Manual verification (no component harness in this repo)**

Run the embedded app against seed data; open the Summit Logo Tee `negative_unit_economics` alert.
Expected: a primary **"Move ad budget to Hydration Bottle"** button tagged Recommended, a secondary cut-ads button, and Snooze. For a SKU whose spend lives in `Performance Max — All Products`, the reallocate row shows as advisory text "— served by a shared campaign — exclude this SKU inside Advantage+ instead" with no button.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.alerts.$id.tsx
git commit -m "app.alerts.\$id: enrich plan in loader, execute reallocate_spend_sku, render named-winner button"
```

---

## Task 9: Dashboard — enrich loader, render buttons, dispatch the action

**Files:**
- Modify: `app/lib/dashboard/client.ts` (the dashboard alert-detail loader/`getAlert`; `adaptAlert` already passes `remediation` per Phase 1)
- Modify: `app/components/dashboard/screens/Alerts.tsx` (Fix-it Card ~lines 244-282)
- Modify: `app/components/dashboard/DashboardApp.tsx` (`executeAction` ~lines 232-364)

- [ ] **Step 1: Enrich the plan on the dashboard detail read**

In the dashboard server module that builds the single-alert DTO (the loader behind `getAlert` / the alert-detail dashboard API), after `attachRemediation` has set `alert.remediation`, call `enrichRemediation` exactly as the embedded loader does, before `adaptAlert`:

```typescript
import { enrichRemediation } from "~/lib/remediation/enrich.server";
// after fetching the raw Alert for the detail view, with shopId + sb in scope:
if (raw.remediation) {
  raw.remediation = await enrichRemediation(raw, raw.remediation, sb, shopId);
}
```

(Lists must NOT enrich — only the detail read path, per the architecture seam. The dashboard alert list already renders no Fix-it buttons.)

- [ ] **Step 2: Render enriched moves in the dashboard Fix-it Card**

In `Alerts.tsx`, replace the `alert.actions.map(...)` block (lines ~256-273) with a branch on `alert.remediation`. Executable moves are buttons calling `run(move.executor)`; advisory moves are guidance rows showing `ineligibleReason`:

```tsx
            {alert.remediation ? (
              <div className="flex flex-col gap-2 mt-1">
                {alert.remediation.moves.map((m) => {
                  const rec = m.kind === alert.remediation!.recommended;
                  const executable = m.executor !== null;
                  if (executable) {
                    return (
                      <button
                        key={m.kind}
                        disabled={resolved || busy}
                        aria-busy={busy && attempted === m.executor}
                        className={"cd-action-btn" + (rec ? " rec" : "")}
                        onClick={() => run(m.executor as ActionKind)}
                      >
                        <CDIcon name={CD_ACTION_ICON[m.executor as string] || "bolt"} size={16} strokeWidth={1.9} />
                        <span className="flex-1 text-left">{m.label}</span>
                        {rec && <span className="cd-rec-tag">Recommended</span>}
                      </button>
                    );
                  }
                  return (
                    <div key={m.kind} className={"cd-move-row" + (rec ? " rec" : "")}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--border)" }}>
                      <CDIcon name={CD_ACTION_ICON[m.kind] || "bolt"} size={16} strokeWidth={1.9} />
                      <span className="flex-1 text-left">{m.label}</span>
                      {rec && <span className="cd-rec-tag">Recommended</span>}
                      {m.ineligibleReason && <span className="cd-caption">{m.ineligibleReason}</span>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col gap-2 mt-1">
                {alert.actions.map((kind) => {
                  const rec = kind === alert.recommended;
                  return (
                    <button key={kind} disabled={resolved || busy} aria-busy={busy && attempted === kind}
                      className={"cd-action-btn" + (rec ? " rec" : "")} onClick={() => run(kind as ActionKind)}>
                      <CDIcon name={CD_ACTION_ICON[kind] || "bolt"} size={16} strokeWidth={1.9} />
                      <span className="flex-1 text-left">{ACTION_LABELS[kind] || kind}</span>
                      {rec && <span className="cd-rec-tag">Recommended</span>}
                    </button>
                  );
                })}
              </div>
            )}
```

(`CD_ACTION_ICON` is string-indexed, so `CD_ACTION_ICON[m.executor as string]` is safe; it falls back to `"bolt"`. Add a `reallocate_spend_sku` entry to `CD_ACTION_ICON` in `icons.tsx` — `"trendingUp"` if registered, else leave the `"bolt"` fallback. Phase 1 added `cut_ads` / `reallocate_to_winner` move-kind icons already.)

- [ ] **Step 3: Dispatch `reallocate_spend_sku` in `executeAction`**

In `DashboardApp.tsx` `executeAction`, add a branch routing `reallocate_spend_sku` to the alert-action endpoint (the gateway derives everything server-side from the alert — the client sends no campaign ids). Place it beside the `reallocate_inventory` branch:

```typescript
      if (kind === "reallocate_spend_sku") {
        try {
          const { acknowledged } = await client.executeAlertAction(alert.id, { type: kind });
          markResolved();
          client.fetchAudit().then((au) => setAudit(au)).catch(() => {});
          toast(
            `${label} — done. Logged to action history.` +
              (acknowledged ? "" : " Alert couldn't be acknowledged."),
            "check",
          );
        } catch (err) {
          const msg = err instanceof DashboardApiError ? err.message : "Action failed.";
          toast(msg, "warn", "critical");
        }
        return;
      }
```

(`executeAlertAction` already POSTs `{ type, idempotency_key }` to `/dashboard/api/alerts/:id/action` — Task 7 made that route accept `reallocate_spend_sku`. The `cut_ads` executor kinds (`pause_campaign`/`reduce_campaign_budget`) route through the campaign branch — but a SKU alert has no `alert.campaign_id`, so the dashboard branch needs the loser campaign id from the enriched move.)

**Resolved (post-merge correction — rule 12, no stale TODO):** this scope note originally deferred dashboard `cut_ads` on SKU alerts to a follow-up. It was actually completed in the PR #183 merge, so there is **no `TODO(phase3-followup)` in the code** and dashboard/embedded are at parity. As shipped: `enrichRemediation` sets `m.target.loserCampaignId` (+ budget) and flips the `cut_ads` executor to `pause_campaign`/`reduce_campaign_budget` whenever the SKU has a dedicated mutable Meta campaign (else it stays correctly advisory — never a dead button); `screens/Alerts.tsx` renders it as an executable button passing `{ campaignId: m.target.loserCampaignId, loserBudgetCents }`; `DashboardApp.tsx` consumes it via `const campId = opts?.campaignId ?? alert.campaign_id` → `executeCampaignAction(campId, …)`; the contract is documented in `context.ts`. No guard/TODO is added.

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc --noEmit && npx eslint app/components/dashboard/screens/Alerts.tsx app/components/dashboard/DashboardApp.tsx app/lib/dashboard/client.ts`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

Run the dashboard against seed; open the Summit Tee `negative_unit_economics` alert.
Expected: "Move ad budget to Hydration Bottle" as a working primary button (Recommended), advisory rows show their `ineligibleReason`, Snooze still works. A shared-campaign SKU shows the reallocate row as advisory text, no button.

- [ ] **Step 6: Commit**

```bash
git add app/lib/dashboard/client.ts app/components/dashboard/screens/Alerts.tsx app/components/dashboard/DashboardApp.tsx app/components/dashboard/icons.tsx
git commit -m "dashboard: enrich plan on detail read, render named-winner button, dispatch reallocate_spend_sku"
```

---

## Task 10: Full gate + final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Phase 3 + Phase 1 test suite**

Run: `npx vitest run app/lib/remediation app/lib/actions/__tests__/reallocate-sku.test.ts app/lib/actions/__tests__/reallocate.test.ts`
Expected: PASS (Phase 1 rank/synopsis tests + new enrich + reallocate-sku + existing reallocate tests all green — proves the widened union didn't regress Phase 1/budget-reallocation).

- [ ] **Step 2: Run the repo pre-commit gate (per CLAUDE.md)**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: each exits 0. For the new migration, validate per Task 1 Step 2 (`prisma migrate diff --exit-code` is N/A — Prisma owns no views; the view is validated by applying it to a Supabase dev branch and re-selecting). Fix root causes; do not `--no-verify`, disable lint, or narrow types.

- [ ] **Step 3: Patch sanity**

Run: `git diff --check` and `git log --oneline -12`
Expected: no whitespace errors; no stray `console.log` (the one in `enrich.server.ts` is an intentional rule-12 failure surface, not a debug log), `.only`, or commented-out blocks in the diff.

- [ ] **Step 4: `/code-review` the branch and resolve blockers**

Run the `/code-review` slash command on the working tree; resolve every blocker, downgrade nits with a one-line justification.

---

## Self-review (against the spec)

- **Spec §"Phases" item 3 ("`reallocate_spend_sku` executor … gated on both SKUs having dedicated mutable campaigns; advisory fallback otherwise; reuse pause/reduce for plain cut ads"):** Task 6 gateway (gated, delegates to `executeReallocation`) + Task 3/4 enrichment (advisory fallback + cut_ads via `reduce_campaign_budget`/`pause_campaign`). ✓
- **Spec §"Key feasibility constraint (SKU → campaign)" ("only executable when served by a dedicated, mutable campaign … fall back to advisory, never a button it can't honor"):** Task 1 view infers dedication from attribution-revenue concentration (no clean key exists — confirmed in `v_alerts_view`/`ad_campaign_dim`); Task 3 sets `ineligibleReason` and leaves `executor: null` for shared campaigns. ✓ (rule 12)
- **Spec §"The deterministic ranking" `reallocate_to_winner` row ("loser has a dedicated mutable campaign AND a qualifying winner (stock headroom + scalable campaign)"):** Task 1 `winner_rank` requires positive contribution + `days_of_cover >= 14` + own dedicated campaign; Task 3 picks the top winner, advisory when none. ✓
- **Spec §"Worked example" (Summit Tee → cut/reallocate, named winner + $ impact):** Task 3/8/9 render "Move ad budget to **Hydration Bottle**" with `amountCents`. ✓
- **Spec §"Architecture (Approach A)" (one decision read by all consumers; engine pure):** `rankMoves` stays pure; `enrichRemediation` is the single shared async resolver both surfaces (and Phase 4 autopilot) call. ✓
- **Spec §"Failure visibility" (no dedicated campaign / no winner / write fails):** advisory `ineligibleReason` (Task 3), `executeReallocation` compensation + `retrying` reused (Task 6), enrich best-effort catch. ✓
- **Spec §"Components" (`v_sku_remediation_inputs` = contribution + returns + dedicated campaign + winner ranking; executors through existing audit/undo):** Task 1 view has all four; Task 6 delegates to `executeReallocation` → existing one-row audit + undo (`undo.server.ts` `reallocate_budget` branch) + retry drain. ✓
- **Spec §"Dashboard parity":** Task 8 (embedded Polaris) + Task 9 (dashboard `cd-*`), same enriched plan, translated not copied. The dashboard `cut_ads` gap was finished in the PR #183 merge (no follow-up TODO remains) — dashboard and embedded are at full parity. ✓
- **Cross-phase contract:** `StrategicMove.executor` widened additively to `"snooze_alert" | "discontinue_sku" | "reallocate_spend_sku" | "pause_campaign" | "reduce_campaign_budget" | null` (Task 2, Phase 2's `discontinue_sku` preserved). `reallocate_spend_sku` added to `ActionKind` (Task 5). `target` shape `{ skuId, loserCampaignId, winnerSkuId, winnerCampaignId, winnerLabel, amountCents }` spelled identically in `types.ts` (Task 2), `enrich.server.ts` (Task 3), the gateway (Task 6), and both panels (Tasks 8–9). ✓
- **Type consistency check:** `reallocate_spend_sku` appears identically in `ActionKind` (`types.ts`), `ACTION_LABELS`/`ACTION_VERBS`/`DETECTOR_TO_ACTIONS` (`labels.ts`), `StrategicMove.executor` (`remediation/types.ts`), the gateway, the routes, and `executeAction` dispatch. `executeReallocation` is called with the locked `ReallocateInput` shape (`sourceCampaignId`/`destCampaignId`/`amountCents`/`idempotencyKey`), unchanged from `reallocate.server.ts`. ✓
- **No placeholders:** every code/SQL step is complete; the `rankMoves` eligibility backbone is exercised through `enrichRemediation`'s six-case matrix (Task 3) + cut_ads (Task 4). ✓
- **Deferred (stated in Scope):** autopilot consuming `reallocate_spend_sku` → Phase 4; per-SKU control inside shared Advantage+/PMax → advisory only; cross-platform SKU shift → advisory. (Dashboard cut_ads on `campaign_id`-less SKU alerts was originally deferred here but completed in the PR #183 merge — see the resolved scope note in Task 7.) ✓
