# Campaign Sales Views and Profit Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Sales/Regular campaign classification and trustworthy 7/30/90-day attributed orders, profit, spend, and true ROAS to the native Campaigns page.

**Architecture:** Store editable classification on `ad_campaign_dim`, detect initial sale types in PostgreSQL on insert, and calculate selected-window performance through one security-invoker RPC. Extend the existing dashboard Campaigns API and view model, then add the wizard step and list controls without a background rollup or new dependency.

**Tech Stack:** PostgreSQL/Supabase migrations and RLS, Remix loaders/actions, React 18, TypeScript, Vitest, existing Calderyn `cd-*` components and CSS.

## Global Constraints

- Work only in the native dashboard; do not touch the frozen `app.*` embedded surface.
- Allowed metric windows are exactly `7`, `30`, and `90`; first visit defaults to `30`, then remembers the browser's last valid choice.
- Tabs are exactly `All`, `Sales`, and `Regular`; tabs filter table rows only, never the four account-wide cards.
- Account cards are Attributed orders, Attributed revenue, Profit, and True ROAS; Orders, Revenue, and Profit are sums, and True ROAS is total revenue divided by total spend.
- True ROAS is attributed net order revenue divided by ad spend; zero spend returns `null` and renders `—`.
- Profit is attributed revenue minus product COGS, carrier cost, estimated payment fees, and ad spend; QuickBooks cost wins, catalog cost is fallback, and missing inputs must visibly mark the value incomplete.
- Sale types are Black Friday, Cyber Monday, Holiday, Seasonal, General Sale, or a custom 1–80-character trimmed label.
- Merchant classification edits must survive later platform syncs.
- All dashboard reads and writes require `requireDashboardSession`; writes also require `requireSameOrigin`; tenant identity always comes from the session.
- Everything created through the wizard remains paused.
- No new top-level dependency, background rollup table, speculative refactor, or browser-visible implementation provenance.

---

### Task 1: Campaign classification and performance RPC

**Files:**
- Create: `supabase/migrations/20260719190000_campaign_sales_profit_metrics.sql`
- Create: `tests/engine/schema/migrations/20260719190000_campaign_sales_profit_metrics.sql`
- Create: `tests/engine/integration/test_campaign_sales_profit_metrics.py`

**Interfaces:**
- Produces columns `campaign_kind`, `sale_type`, and `classification_source` on `public.ad_campaign_dim`.
- Produces `public.campaign_performance(p_window_days integer)` returning the current shop's campaign identity, classification, and selected-window metrics.
- The RPC result columns consumed by Task 2 are `id`, `name`, `platform`, `status`, `daily_budget_cents`, `campaign_kind`, `sale_type`, `classification_source`, `orders`, `revenue_cents`, `spend_cents`, `profit_cents`, `true_roas`, `cost_complete`, and `cost_sources`.

- [ ] **Step 1: Write failing database behavior tests**

Using `pg_pool`, `seed_shop`, and `with_shop_context`, write real PostgreSQL tests that seed two shops and assert detector precedence, insert-trigger classification, a merchant override surviving an upsert, tenant isolation, 7/30/90 boundaries, distinct attributed orders, refund subtraction, QuickBooks/catalog COGS precedence, missing-cost completeness, and zero-spend null ROAS. Query the wished-for RPC directly:

```py
@pytest.mark.asyncio
async def test_campaign_performance_is_scoped_and_uses_ratio_of_sums(pg_pool, seed_shop):
    await seed_shop(SHOP_A)
    await seed_shop(SHOP_B)
    async with pg_pool.acquire() as conn:
        await seed_campaign_orders_costs_and_spend(conn)
        async with with_shop_context(conn, SHOP_A):
            rows = await conn.fetch("select * from campaign_performance(30)")
    assert [str(row["id"]) for row in rows] == [CAMPAIGN_A]
    assert rows[0]["orders"] == 2
    assert rows[0]["true_roas"] == Decimal("3.0000")
```

- [ ] **Step 2: Run the test and verify RED**

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/integration/test_campaign_sales_profit_metrics.py -q`

Expected: FAIL because the RPC and classification columns do not exist. If the local test database is not running, first run `tests/engine/scripts/test-db.sh up` and then rerun RED.

- [ ] **Step 3: Add the classification schema and detector**

The production and engine-test migrations must contain the same SQL. Add check-constrained columns, a `detect_campaign_sale_type(text) returns text` function, an insert trigger, and a backfill. Use this exact precedence: Cyber Monday; Black Friday/BFCM; Holiday; Seasonal; General Sale; otherwise null. Set `campaign_kind = 'sales'` exactly when the detector returns a non-null label. The trigger must leave rows with `classification_source = 'merchant'` untouched.

```sql
alter table public.ad_campaign_dim
  add column if not exists campaign_kind text not null default 'regular'
    check (campaign_kind in ('sales', 'regular')),
  add column if not exists sale_type text
    check (sale_type is null or char_length(btrim(sale_type)) between 1 and 80),
  add column if not exists classification_source text not null default 'detected'
    check (classification_source in ('detected', 'merchant'));
```

- [ ] **Step 4: Add the selected-window RPC**

Implement one SQL function using CTEs for `anchor_day`, `spend`, `attributed_orders`, effective QuickBooks/catalog COGS, refunds, carrier costs, and fees. It must:

```sql
if p_window_days not in (7, 30, 90) then
  raise exception 'unsupported campaign window: %', p_window_days
    using errcode = '22023';
end if;
```

Use `public.current_shop_id()` for scope and `security invoker`. Count distinct attributed paid orders. Revenue is attributed revenue less recorded refunds, floored at zero. Prefer the order-line cost snapshot when present; otherwise select the cost effective on the order date with `quickbooks` ahead of catalog sources. Mark `cost_complete = false` for any missing COGS or carrier cost. Compute `true_roas` with `nullif(total_spend, 0)`. Grant execute only to `authenticated` and `service_role`.

- [ ] **Step 5: Rebuild the local schema and verify database behavior**

Run: `tests/engine/scripts/test-db.sh schema`

Expected: schema applies without SQL errors.

Run: `TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test .venv/bin/python -m pytest tests/engine/integration/test_campaign_sales_profit_metrics.py -q`

Expected: all tests PASS.

Run: `npx prisma migrate diff --exit-code`

Expected: exit 0 because Prisma schema is unchanged.

- [ ] **Step 6: Commit Task 1**

```bash
git add supabase/migrations/20260719190000_campaign_sales_profit_metrics.sql tests/engine/schema/migrations/20260719190000_campaign_sales_profit_metrics.sql tests/engine/integration/test_campaign_sales_profit_metrics.py
git commit -m "campaigns/data: add sales classification and profit metrics"
```

### Task 2: Campaign API and classification write boundary

**Files:**
- Modify: `app/lib/types.ts`
- Modify: `app/lib/calderyn.server.ts`
- Modify: `app/routes/dashboard.api.campaigns._index.tsx`
- Modify: `app/routes/dashboard.api.campaigns.$id.tsx`
- Modify: `app/lib/dashboard/client.ts`
- Modify: `app/components/dashboard/view-models.ts`
- Modify: `app/lib/dashboard/__tests__/api-read-routes.test.ts`
- Modify: `app/lib/dashboard/__tests__/adapt-campaign.test.ts`
- Create: `app/routes/__tests__/dashboard-campaign-classification-action.test.ts`

**Interfaces:**
- Consumes the Task 1 RPC and classification columns.
- Produces `CampaignWindow = 7 | 30 | 90`, `CampaignKind = "sales" | "regular"`, and the metric/classification fields on `Campaign` and `CampaignVM`.
- Produces `updateCampaignClassification(id, input)` for Task 4.

- [ ] **Step 1: Write failing loader, adapter, and action tests**

Add cases that require `?window=30` to call `campaigns.list(30)`, reject `window=14` with 400, preserve `profit_cents: null`, and map all new fields through `adaptCampaign`. Action tests must assert same-origin enforcement, `sales` without a sale type returns 400, `regular` clears `sale_type`, updates are scoped by session shop id, and a missing row returns 404.

Use this canonical row in tests:

```ts
const campaign = {
  id: "c1", name: "BFCM", platform: "Meta", status: "active",
  daily_budget_cents: 5000, campaign_kind: "sales", sale_type: "Black Friday",
  classification_source: "detected", orders: 12, revenue_cents: 48000,
  spend_cents: 12000, profit_cents: 17000, true_roas: 4,
  cost_complete: true, cost_sources: ["quickbooks"],
};
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run app/lib/dashboard/__tests__/api-read-routes.test.ts app/lib/dashboard/__tests__/adapt-campaign.test.ts app/routes/__tests__/dashboard-campaign-classification-action.test.ts`

Expected: FAIL on missing types, window parsing, and action.

- [ ] **Step 3: Extend the DTO, repository client, and loader**

Add exact browser-safe fields:

```ts
export type CampaignWindow = 7 | 30 | 90;
export type CampaignKind = "sales" | "regular";

export interface CampaignMetrics {
  orders: number;
  revenue_cents: number;
  spend_cents: number;
  profit_cents: number | null;
  true_roas: number | null;
  cost_complete: boolean;
  cost_sources: string[];
}
```

Change `campaigns.list(window: CampaignWindow)` to call `supabase.rpc("campaign_performance", { p_window_days: window })`. In the route, accept omitted `window` as 30 and return `jsonError(400, "invalid_window")` for anything except 7, 30, or 90.

- [ ] **Step 4: Add the classification PATCH action**

Extend `dashboard.api.campaigns.$id.tsx` with `ActionFunctionArgs`. Accept only PATCH JSON shaped as:

```ts
type CampaignClassificationInput =
  | { campaignKind: "regular"; saleType?: never }
  | { campaignKind: "sales"; saleType: string };
```

Trim and validate a 1–80 character sale type for Sales, clear it for Regular, set `classification_source: "merchant"`, scope by both `id` and `session.shopId`, select the updated fields, and return 404 when no row is updated.

- [ ] **Step 5: Add client and view-model threading**

Update `fetchCampaigns(window)` to include the query string. Add `updateCampaignClassification`. Thread all metric and classification fields through `CampaignVM` and `adaptCampaign` without converting missing profit or ROAS to zero.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: all files PASS.

- [ ] **Step 7: Commit Task 2**

```bash
git add app/lib/types.ts app/lib/calderyn.server.ts app/routes/dashboard.api.campaigns._index.tsx app/routes/dashboard.api.campaigns.\$id.tsx app/lib/dashboard/client.ts app/components/dashboard/view-models.ts app/lib/dashboard/__tests__/api-read-routes.test.ts app/lib/dashboard/__tests__/adapt-campaign.test.ts app/routes/__tests__/dashboard-campaign-classification-action.test.ts
git commit -m "dashboard/campaigns: expose selected-window profit metrics"
```

### Task 3: Add campaign type to the creation flow

**Files:**
- Modify: `app/lib/ads/campaign-draft-types.ts`
- Modify: `app/lib/ads/__tests__/campaign-draft-state.test.ts`
- Modify: `app/components/dashboard/screens/CampaignWizard.tsx`
- Modify: `app/routes/dashboard.api.campaigns.first-run.tsx`
- Modify: `app/routes/__tests__/dashboard-campaigns-action-calibration.test.ts`

**Interfaces:**
- Consumes `CampaignKind` from Task 2.
- Produces wizard state fields `campaignKind` and `saleType` and sends `campaignKind` / `saleType` in the first-run POST.
- Legacy version-1 drafts without these fields parse as Regular.

- [ ] **Step 1: Write failing draft and action-parser tests**

Add table cases for legacy draft → Regular, Sales draft round-trip, Sales without sale type rejection, custom label trimming/80-character limit, and Regular with a supplied sale type normalizing to null. Add first-run parser cases for the same boundary rules.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npx vitest run app/lib/ads/__tests__/campaign-draft-state.test.ts app/routes/__tests__/dashboard-campaigns-action-calibration.test.ts`

Expected: FAIL because the state/parser fields do not exist.

- [ ] **Step 3: Extend persisted draft and first-run input**

Add:

```ts
campaignKind: "sales" | "regular";
saleType: string | null;
```

to `CampaignDraftState`. Parsing missing legacy values must return `regular`/`null`. Extend `ParsedFirstRun`, `inputRecord`, audit params, and the `ad_campaign_dim` upsert. A Sales create writes `classification_source: "merchant"`; a Regular create writes Regular/null/merchant.

- [ ] **Step 4: Add the dedicated wizard step**

Change the order to:

```ts
const STEP_ORDER = ["platform", "campaignType", "product", "creative", "review"] as const;
```

Add one reducer action that changes kind and sale type. Render two existing-style choice tiles; Sales reveals the six approved options and a bounded custom input. Continue is disabled until Sales has a valid type. Review displays `Regular campaign` or the chosen sale type. Preserve existing platform preflight and paused-creation behavior.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: both files PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add app/lib/ads/campaign-draft-types.ts app/lib/ads/__tests__/campaign-draft-state.test.ts app/components/dashboard/screens/CampaignWizard.tsx app/routes/dashboard.api.campaigns.first-run.tsx app/routes/__tests__/dashboard-campaigns-action-calibration.test.ts
git commit -m "dashboard/campaigns: choose sales type during creation"
```

### Task 4: Campaign metrics cards, filters, window memory, and edit control

**Files:**
- Create: `app/components/dashboard/screens/campaign-list-state.ts`
- Create: `app/components/dashboard/screens/__tests__/campaign-list-state.test.ts`
- Modify: `app/components/dashboard/screens/Campaigns.tsx`
- Modify: `app/components/dashboard/App.tsx`
- Modify: `app/lib/dashboard/boot.ts`
- Modify: `app/styles/dashboard.css`

**Interfaces:**
- Consumes Task 2's `CampaignVM`, `CampaignWindow`, `fetchCampaigns(window)`, and `updateCampaignClassification`.
- Produces pure helpers `filterCampaigns`, `summarizeCampaigns`, `readCampaignWindow`, and `writeCampaignWindow`.

- [ ] **Step 1: Write failing pure state tests**

Cover All/Sales/Regular membership, global summary remaining unchanged, ratio-of-sums ROAS, zero total spend → null, incomplete-profit propagation, invalid stored window → 30, and valid stored windows round-tripping.

```ts
expect(summarizeCampaigns(rows)).toEqual({
  orders: 15,
  revenueCents: 60000,
  profitCents: 21000,
  trueRoas: 3,
  costComplete: false,
});
```

- [ ] **Step 2: Run helper tests and verify RED**

Run: `npx vitest run app/components/dashboard/screens/__tests__/campaign-list-state.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure state helpers**

Use the literal storage key `calderyn:campaign-window`. Never read `window.localStorage` at module scope. Sum only non-null profit values while setting `costComplete = false` if any row is incomplete; return `profitCents = null` only when no row has a calculable profit.

- [ ] **Step 4: Thread the selected window into dashboard refresh**

Keep `Campaigns` as the owner of the window. When it changes, persist it and fetch the selected-window campaign DTOs through the existing dashboard client/refresh path. Do not add a second polling loop. Update the smallest existing boot/App interface necessary so normal dashboard refreshes continue using the selected window.

- [ ] **Step 5: Render cards, segmented tabs, columns, and classification editing**

Use existing `Card`, `Btn`, `CountMoney`, and `Tooltip` primitives. Render account cards before the filter row. The table retains Status, Score, and quick actions; replace Daily Budget with Attributed orders, Profit, True ROAS, and Spend. Render `Incomplete costs` on affected profit values and `—` for null ROAS. Add a compact row/detail edit control that calls Task 2's PATCH client and applies an optimistic classification patch only after success.

- [ ] **Step 6: Add surgical dashboard CSS**

Add only selectors needed by the new cards, segmented control, sale badge, and classification editor. Reuse existing tokens, focus styles, and reduced-motion behavior. Keep the existing `Pan` horizontal layout on narrow screens.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run: `npx vitest run app/components/dashboard/screens/__tests__/campaign-list-state.test.ts app/lib/dashboard/__tests__/adapt-campaign.test.ts app/lib/dashboard/__tests__/api-read-routes.test.ts`

Expected: all files PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add app/components/dashboard/screens/campaign-list-state.ts app/components/dashboard/screens/__tests__/campaign-list-state.test.ts app/components/dashboard/screens/Campaigns.tsx app/components/dashboard/App.tsx app/lib/dashboard/boot.ts app/styles/dashboard.css
git commit -m "dashboard/campaigns: add sales views and profit cards"
```

### Task 5: Full verification and PR readiness

**Files:**
- Modify only files required to fix failures introduced by Tasks 1–4.

**Interfaces:**
- Consumes the complete branch.
- Produces a review-clean, mergeable pull request; no production deployment is part of this task.

- [ ] **Step 1: Run focused feature tests together**

```bash
TEST_DATABASE_URL=postgres://postgres:test@localhost:5433/calderyn_test \
  .venv/bin/python -m pytest tests/engine/integration/test_campaign_sales_profit_metrics.py -q

npx vitest run \
  app/lib/ads/__tests__/campaign-draft-state.test.ts \
  app/routes/__tests__/dashboard-campaign-classification-action.test.ts \
  app/routes/__tests__/dashboard-campaigns-action-calibration.test.ts \
  app/components/dashboard/screens/__tests__/campaign-list-state.test.ts \
  app/lib/dashboard/__tests__/api-read-routes.test.ts \
  app/lib/dashboard/__tests__/adapt-campaign.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run repository gates in required order**

Run `npm run typecheck`, `npm run lint`, `npm run build`, and `npx prisma migrate diff --exit-code`.

Expected: every command exits 0. If the known full-suite dashboard-loader flake appears during later `npm test`, rerun that file in isolation and report both results; never hide a deterministic failure.

- [ ] **Step 3: Run patch sanity and graph update**

Run `git diff --check`, inspect `git diff --stat`, scan introduced lines for `console.log`, `.only`, TODO ownership, disabled lint, provenance, and browser-visible internal comments, then run `graphify update .` when the CLI/index is available.

Expected: clean diff, no forbidden markers, graph update exits 0 or is explicitly unavailable.

- [ ] **Step 4: Browser verification**

Run the native dashboard locally with `npx remix vite:dev`. Verify mixed All/Sales/Regular rows, 7/30/90 selection persistence, global cards staying unchanged across tabs, incomplete cost copy, classification edit persistence, and the five-step paused Sales creation flow. Record any unavailable external-account step honestly.

- [ ] **Step 5: Final review and PR**

Run the required whole-branch reviewer, fix all Critical/Important findings, push `feat/campaign-sales-profit-metrics`, open a PR against `main`, and wait for GitHub checks until the PR reports mergeable with no required check pending or failing.
