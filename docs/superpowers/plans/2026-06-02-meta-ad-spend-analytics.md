# Meta Ad-Spend Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Meta ad-spend analytics vertical slice -- a Meta Insights poller that writes real time-series spend/ROAS/engagement to Supabase, a deterministic break-even grade, and an Analytics page surfacing it -- exposed through `calderynClient(shop).analytics.*` and MCP.

**Architecture:** Mirror the existing Shopify ingestion pattern (`app/lib/ingest/*`): cron pulls Meta Insights via the encrypted offline token, pure mappers shape fact rows, idempotent upserts into new Supabase tables, failures to `ingestion_dlq`. Pure `breakeven.ts` (shared with session #4) + `classify.ts` produce the grade. `calderynClient.analytics.*` reads daily-grain views and rolls them up into DTOs for the Polaris + polaris-viz surface and the external MCP server.

**Tech Stack:** Remix (Vite) + TypeScript (strict, ESM), `@supabase/supabase-js` (service role), Shopify Polaris + `@shopify/polaris-viz` (new dep), Vitest. Source spec: `docs/superpowers/specs/2026-06-02-meta-ad-spend-analytics-design.md`.

---

## File map (what each new/changed file is responsible for)

**New -- pure modules (heaviest test weight):**
- `app/lib/analytics/classify.ts` -- ROAS vs break-even -> grade.
- `app/lib/analytics/breakeven.ts` -- blended margin -> break-even ROAS, coverage rules (shared with #4).
- `app/lib/analytics/rollup.ts` -- pure daily-row -> windowed DTO rollups.
- `app/lib/meta/insights/mappers.server.ts` -- Insights JSON -> fact rows.

**New -- ingestion (seam-tested with fakes):**
- `app/lib/meta/insights/insights-client.server.ts` -- paginated Insights GET.
- `app/lib/meta/insights/backfill.server.ts` -- per-shop 90-day backfill, single-pass (cron bounds shops/tick).
- `app/lib/meta/insights/poller.server.ts` -- daily incremental poll.

**New -- surface:**
- `app/routes/app.analytics.tsx` -- Analytics page.

**New -- migrations (Supabase):**
- `supabase/migrations/20260602090000_ad_insights.sql`
- `supabase/migrations/20260602091000_ad_spend_fact.sql`
- `supabase/migrations/20260602092000_analytics_views.sql`
- `supabase/migrations/20260602093000_analytics_settings.sql`

**Modified:**
- `app/lib/types.ts` -- additive DTO types.
- `app/lib/ingest/dlq.server.ts` -- parameterize `connector`.
- `app/lib/calderyn.server.ts` -- add `analytics` namespace + module-private loaders.
- `app/routes/cron.ingest.tsx` -- add Meta phase.
- `app/routes/app.tsx` -- nav link.
- `app/routes/app._index.tsx` -- real "True ROAS" tile.
- `app/routes/app.campaigns.tsx` -- enrich live rows with ingested ROAS/spend.
- `app/routes/app.mcp.tsx` -- scope/banner copy mentions analytics.
- `package.json` -- `@shopify/polaris-viz`.

---

## Task 0: Remote schema introspection (do this first -- it de-risks Tasks 5 + 11)

The local migration history is sparse; `ad_campaign_dim`, `ad_spend_fact`, `shops`, `shop_integrations`, `sku_dim`, `order_line_fact`, `order_fact`, `ingestion_dlq` exist remotely (seed) but their exact columns are not all in repo. Confirm the real shapes before writing SQL/queries that assume them.

**Files:** none (investigation only).

- [ ] **Step 1: Introspect the columns this slice depends on**

Use the **supabase MCP** (project `ajgrmnvzxfxxlwrxcgnu`) to run:

```sql
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('ad_campaign_dim','ad_spend_fact','shop_integrations','shops',
                     'sku_dim','order_line_fact','ingestion_dlq')
order by table_name, ordinal_position;
```

Also capture the enum labels:

```sql
select t.typname, e.enumlabel
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typname in ('integration_kind','sync_status')
order by t.typname, e.enumsortorder;
```

- [ ] **Step 2: Record findings inline in this plan**

Write the actual `ad_spend_fact` column names under this task (especially: is the campaign key `campaign_external_id`, `campaign_id`, or an FK to `ad_campaign_dim.id`? does `spend_7d_cents`/`roas_7d` live on the table or only in `v_campaigns_flat`?). **Every later task that says "assumed column" must be reconciled to what you find here.** If `ad_spend_fact` already has a daily grain + the needed columns, Task 5 migration #2 becomes a no-op except the unique index.

No commit (no file change).

---

## Task 1: Additive DTO types

**Files:**
- Modify: `app/lib/types.ts` (append; do not touch `DetectorId`/`ActionKind`)

- [ ] **Step 1: Append the analytics types**

Add to the end of `app/lib/types.ts`:

```ts
// --- Ad-spend analytics (session #2). Additive only. ---
export type CampaignGrade = "winning" | "okay" | "poor";

export interface Engagement {
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  post_engagement: number;
}

export interface CampaignInsight {
  campaign_id: string; // Meta campaign external id
  name: string;
  status: "active" | "paused";
  spend_cents: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value_cents: number;
  roas: number;
  break_even_roas: number;
  grade: CampaignGrade;
  engagement: Engagement;
  linked_alert_ids: string[];
}

export interface AdInsight {
  ad_id: string;
  campaign_id: string;
  name: string;
  spend_cents: number;
  roas: number;
  engagement: Engagement;
}

export interface TrendPoint {
  day_bucket: string; // ISO date
  spend_cents: number;
  roas: number;
}

export type MarginConfidence = "ok" | "low" | "override" | "default";

export interface AnalyticsSummary {
  window_days: 7 | 30 | 90;
  blended_margin_pct: number; // 0..1
  margin_confidence: MarginConfidence;
  break_even_roas: number;
  account_roas: number;
  total_spend_cents: number;
  total_engagement: number; // sum(reactions+comments+shares+saves) over window
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0 (types compile; no consumers yet).

- [ ] **Step 3: Commit**

```bash
git add app/lib/types.ts
git commit -m "feat(types): analytics DTOs (CampaignInsight/AdInsight/AnalyticsSummary)"
```

---

## Task 2: `classify.ts` (pure grade)

**Files:**
- Create: `app/lib/analytics/classify.ts`
- Test: `app/lib/analytics/__tests__/classify.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/analytics/__tests__/classify.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { gradeCampaign, GRADE_WIN_FACTOR, GRADE_OK_FACTOR } from "../classify";

describe("gradeCampaign", () => {
  const B = 2.0; // break-even ROAS

  it("grades comfortably-above as winning", () => {
    expect(gradeCampaign(2.5, B)).toBe("winning"); // 2.5 >= 1.2*2.0 = 2.4
  });

  it("grades exactly at the winning boundary as winning", () => {
    expect(gradeCampaign(GRADE_WIN_FACTOR * B, B)).toBe("winning");
  });

  it("grades just below winning as okay", () => {
    expect(gradeCampaign(2.39, B)).toBe("okay");
  });

  it("grades exactly at the okay boundary as okay", () => {
    expect(gradeCampaign(GRADE_OK_FACTOR * B, B)).toBe("okay"); // 1.9
  });

  it("grades just below break-even buffer as poor", () => {
    expect(gradeCampaign(1.89, B)).toBe("poor");
  });

  it("treats a non-positive break-even as poor unless roas is positive", () => {
    expect(gradeCampaign(0, 0)).toBe("poor");
    expect(gradeCampaign(1, 0)).toBe("winning");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/analytics/__tests__/classify.test.ts`
Expected: FAIL ("Cannot find module '../classify'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/analytics/classify.ts`:

```ts
import type { CampaignGrade } from "~/lib/types";

/** A campaign is "winning" once ROAS clears break-even by this factor. */
export const GRADE_WIN_FACTOR = 1.2;
/** Below this fraction of break-even it is "poor"; between, "okay". */
export const GRADE_OK_FACTOR = 0.95;

export function gradeCampaign(roas: number, breakEvenRoas: number): CampaignGrade {
  if (breakEvenRoas <= 0) return roas > 0 ? "winning" : "poor";
  if (roas >= GRADE_WIN_FACTOR * breakEvenRoas) return "winning";
  if (roas >= GRADE_OK_FACTOR * breakEvenRoas) return "okay";
  return "poor";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/analytics/__tests__/classify.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/analytics/classify.ts app/lib/analytics/__tests__/classify.test.ts
git commit -m "feat(analytics): pure campaign grade (winning/okay/poor)"
```

---

## Task 3: `breakeven.ts` (pure margin -> break-even, shared with #4)

**Files:**
- Create: `app/lib/analytics/breakeven.ts`
- Test: `app/lib/analytics/__tests__/breakeven.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/analytics/__tests__/breakeven.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { computeBreakEven, DEFAULT_MARGIN, COVERAGE_THRESHOLD } from "../breakeven";

const line = (price: number, qty: number, cost: number | null) => ({
  price_cents: price,
  quantity: qty,
  unit_cost_cents: cost,
});

describe("computeBreakEven", () => {
  it("computes margin and break-even from full-coverage lines", () => {
    // revenue 10000, cogs 5000 -> margin 0.5 -> break-even 2.0
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.margin).toBeCloseTo(0.5, 5);
    expect(r.breakEvenRoas).toBeCloseTo(2.0, 5);
    expect(r.confidence).toBe("ok");
    expect(r.coverage).toBeCloseTo(1, 5);
  });

  it("excludes (does not zero) lines with unknown cost", () => {
    // known: rev 10000 cogs 5000; unknown: rev 10000 -> coverage 0.5 < 0.70 -> default
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000), line(10000, 1, null)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.coverage).toBeCloseTo(0.5, 5);
    expect(r.confidence).toBe("default");
    expect(r.margin).toBeCloseTo(DEFAULT_MARGIN, 5);
  });

  it("keeps computed margin when coverage meets the threshold", () => {
    // known rev 9000 (cost 4500), unknown rev 1000 -> coverage 0.9 >= 0.70
    const r = computeBreakEven({
      lines: [line(9000, 1, 4500), line(1000, 1, null)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("ok");
    expect(r.margin).toBeCloseTo(0.5, 5);
  });

  it("honors a manual override above computed/default", () => {
    const r = computeBreakEven({
      lines: [line(10000, 1, 5000)],
      override: 0.25,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("override");
    expect(r.margin).toBeCloseTo(0.25, 5);
    expect(r.breakEvenRoas).toBeCloseTo(4.0, 5);
  });

  it("falls back to default when there is no revenue", () => {
    const r = computeBreakEven({
      lines: [],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("default");
    expect(r.coverage).toBe(0);
  });

  it("falls back to default when computed margin is non-positive", () => {
    // cost exceeds price -> margin <= 0 is meaningless for break-even
    const r = computeBreakEven({
      lines: [line(5000, 1, 6000)],
      override: null,
      defaultMargin: DEFAULT_MARGIN,
      coverageThreshold: COVERAGE_THRESHOLD,
    });
    expect(r.confidence).toBe("default");
    expect(r.margin).toBeCloseTo(DEFAULT_MARGIN, 5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/analytics/__tests__/breakeven.test.ts`
Expected: FAIL ("Cannot find module '../breakeven'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/analytics/breakeven.ts`:

```ts
import type { MarginConfidence } from "~/lib/types";

/** Fallback gross margin when costs are unknown/low-coverage. */
export const DEFAULT_MARGIN = 0.4;
/** Minimum fraction of revenue with a known unit cost to trust the computed margin. */
export const COVERAGE_THRESHOLD = 0.7;

export interface MarginLine {
  price_cents: number;
  quantity: number;
  unit_cost_cents: number | null;
}

export interface BreakEvenInput {
  lines: MarginLine[];
  override: number | null; // gross-margin fraction 0..1, or null
  defaultMargin: number;
  coverageThreshold: number;
}

export interface BreakEvenResult {
  margin: number; // 0..1
  breakEvenRoas: number;
  confidence: MarginConfidence;
  coverage: number; // 0..1
}

function fromMargin(margin: number, confidence: MarginConfidence, coverage: number): BreakEvenResult {
  return { margin, breakEvenRoas: 1 / margin, confidence, coverage };
}

export function computeBreakEven(input: BreakEvenInput): BreakEvenResult {
  if (input.override != null && input.override > 0 && input.override < 1) {
    // coverage still reported for display, but the override wins.
    return fromMargin(input.override, "override", coverageOf(input.lines));
  }

  const coverage = coverageOf(input.lines);
  const known = input.lines.filter((l) => l.unit_cost_cents != null);
  const revenueKnown = known.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  const cogsKnown = known.reduce((s, l) => s + (l.unit_cost_cents as number) * l.quantity, 0);

  if (revenueKnown > 0 && coverage >= input.coverageThreshold) {
    const margin = 1 - cogsKnown / revenueKnown;
    if (margin > 0) return fromMargin(margin, "ok", coverage);
  }
  return fromMargin(input.defaultMargin, "default", coverage);
}

function coverageOf(lines: MarginLine[]): number {
  const all = lines.reduce((s, l) => s + l.price_cents * l.quantity, 0);
  if (all <= 0) return 0;
  const known = lines
    .filter((l) => l.unit_cost_cents != null)
    .reduce((s, l) => s + l.price_cents * l.quantity, 0);
  return known / all;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/analytics/__tests__/breakeven.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/analytics/breakeven.ts app/lib/analytics/__tests__/breakeven.test.ts
git commit -m "feat(analytics): pure blended-margin break-even with coverage rules"
```

---

## Task 4: Meta Insights `mappers.server.ts` (pure)

**Files:**
- Create: `app/lib/meta/insights/mappers.server.ts`
- Test: `app/lib/meta/insights/__tests__/mappers.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/meta/insights/__tests__/mappers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapCampaignInsight, mapAdInsight, mapAdDim, mapCampaignDim } from "../mappers.server";

const SHOP = "shop-uuid";

const campaignRow = {
  campaign_id: "120",
  campaign_name: "Prospecting",
  date_start: "2026-05-01",
  date_stop: "2026-05-01",
  spend: "123.45",
  impressions: "1000",
  inline_link_clicks: "50",
  account_currency: "USD",
  actions: [
    { action_type: "omni_purchase", value: "5" },
    { action_type: "purchase", value: "9" }, // must be ignored (omni wins, no sum)
  ],
  action_values: [
    { action_type: "omni_purchase", value: "678.90" },
    { action_type: "purchase", value: "1000.00" },
  ],
};

const adRow = {
  ad_id: "777",
  ad_name: "Hero video",
  adset_id: "555",
  campaign_id: "120",
  date_start: "2026-05-01",
  date_stop: "2026-05-01",
  spend: "10.00",
  impressions: "100",
  inline_link_clicks: "4",
  account_currency: "USD",
  actions: [
    { action_type: "post_reaction", value: "12" },
    { action_type: "comment", value: "3" },
    { action_type: "post", value: "2" },
    { action_type: "onsite_conversion.post_save", value: "1" },
    { action_type: "post_engagement", value: "40" },
    { action_type: "omni_purchase", value: "1" },
  ],
  action_values: [{ action_type: "omni_purchase", value: "55.00" }],
};

describe("mapCampaignInsight", () => {
  it("maps spend/clicks/purchase, deduping omni_purchase over purchase (never both)", () => {
    expect(mapCampaignInsight(SHOP, campaignRow)).toEqual({
      shop_id: SHOP,
      campaign_external_id: "120",
      day_bucket: "2026-05-01",
      spend_cents: 12345,
      impressions: 1000,
      link_clicks: 50,
      purchases: 5,
      purchase_value_cents: 67890,
      currency: "USD",
    });
  });

  it("defaults missing money/counts to 0 and currency to USD", () => {
    const row = { campaign_id: "1", campaign_name: "x", date_start: "2026-05-02" };
    expect(mapCampaignInsight(SHOP, row)).toMatchObject({
      spend_cents: 0,
      impressions: 0,
      link_clicks: 0,
      purchases: 0,
      purchase_value_cents: 0,
      currency: "USD",
    });
  });
});

describe("mapAdInsight", () => {
  it("maps ad-level metrics and engagement columns", () => {
    expect(mapAdInsight(SHOP, adRow)).toEqual({
      shop_id: SHOP,
      ad_external_id: "777",
      campaign_external_id: "120",
      day_bucket: "2026-05-01",
      spend_cents: 1000,
      impressions: 100,
      link_clicks: 4,
      purchases: 1,
      purchase_value_cents: 5500,
      currency: "USD",
      reactions: 12,
      comments: 3,
      shares: 2,
      saves: 1,
      post_engagement: 40,
    });
  });

  it("stores 0 for engagement action types not present", () => {
    const row = { ad_id: "9", campaign_id: "1", date_start: "2026-05-02", actions: [] };
    expect(mapAdInsight(SHOP, row)).toMatchObject({
      reactions: 0,
      comments: 0,
      shares: 0,
      saves: 0,
      post_engagement: 0,
    });
  });
});

describe("dim mappers", () => {
  it("maps the ad dim", () => {
    expect(mapAdDim(SHOP, adRow)).toEqual({
      shop_id: SHOP,
      external_id: "777",
      campaign_external_id: "120",
      adset_external_id: "555",
      name: "Hero video",
    });
  });

  it("maps the campaign dim", () => {
    expect(mapCampaignDim(SHOP, campaignRow)).toEqual({
      shop_id: SHOP,
      external_id: "120",
      name: "Prospecting",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/meta/insights/__tests__/mappers.test.ts`
Expected: FAIL ("Cannot find module '../mappers.server'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/meta/insights/mappers.server.ts`:

```ts
// Pure: Meta Insights JSON rows -> Supabase fact/dim row shapes. No I/O.

export interface InsightAction {
  action_type: string;
  value?: string;
}

export interface InsightRow {
  campaign_id?: string;
  campaign_name?: string;
  ad_id?: string;
  ad_name?: string;
  adset_id?: string;
  date_start?: string;
  spend?: string;
  impressions?: string;
  inline_link_clicks?: string;
  account_currency?: string;
  actions?: InsightAction[];
  action_values?: InsightAction[];
}

// Priority order for purchases: prefer the omni superset, never sum both.
const PURCHASE_TYPES = ["omni_purchase", "purchase"] as const;

function toCents(v: string | undefined): number {
  if (v == null) return 0;
  return Math.round(Number(v) * 100);
}

function toInt(v: string | undefined): number {
  if (v == null) return 0;
  return Math.trunc(Number(v));
}

/** First matching action_type in priority order; numeric value or 0. */
function pickByPriority(arr: InsightAction[] | undefined, types: readonly string[]): number {
  if (!arr) return 0;
  for (const t of types) {
    const hit = arr.find((a) => a.action_type === t);
    if (hit) return Number(hit.value ?? 0);
  }
  return 0;
}

/** Exact action_type value or 0. */
function pickExact(arr: InsightAction[] | undefined, type: string): number {
  if (!arr) return 0;
  const hit = arr.find((a) => a.action_type === type);
  return hit ? Number(hit.value ?? 0) : 0;
}

export function mapCampaignInsight(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    campaign_external_id: String(row.campaign_id ?? ""),
    day_bucket: String(row.date_start ?? ""),
    spend_cents: toCents(row.spend),
    impressions: toInt(row.impressions),
    link_clicks: toInt(row.inline_link_clicks),
    purchases: Math.trunc(pickByPriority(row.actions, PURCHASE_TYPES)),
    purchase_value_cents: Math.round(pickByPriority(row.action_values, PURCHASE_TYPES) * 100),
    currency: row.account_currency ?? "USD",
  };
}

export function mapAdInsight(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    ad_external_id: String(row.ad_id ?? ""),
    campaign_external_id: String(row.campaign_id ?? ""),
    day_bucket: String(row.date_start ?? ""),
    spend_cents: toCents(row.spend),
    impressions: toInt(row.impressions),
    link_clicks: toInt(row.inline_link_clicks),
    purchases: Math.trunc(pickByPriority(row.actions, PURCHASE_TYPES)),
    purchase_value_cents: Math.round(pickByPriority(row.action_values, PURCHASE_TYPES) * 100),
    currency: row.account_currency ?? "USD",
    reactions: Math.trunc(pickExact(row.actions, "post_reaction")),
    comments: Math.trunc(pickExact(row.actions, "comment")),
    shares: Math.trunc(pickExact(row.actions, "post")),
    saves: Math.trunc(pickExact(row.actions, "onsite_conversion.post_save")),
    post_engagement: Math.trunc(pickExact(row.actions, "post_engagement")),
  };
}

export function mapAdDim(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    external_id: String(row.ad_id ?? ""),
    campaign_external_id: String(row.campaign_id ?? ""),
    adset_external_id: row.adset_id != null ? String(row.adset_id) : null,
    name: String(row.ad_name ?? ""),
  };
}

export function mapCampaignDim(shopId: string, row: InsightRow) {
  return {
    shop_id: shopId,
    external_id: String(row.campaign_id ?? ""),
    name: String(row.campaign_name ?? ""),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/meta/insights/__tests__/mappers.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/insights/mappers.server.ts app/lib/meta/insights/__tests__/mappers.test.ts
git commit -m "feat(meta): pure Insights mappers (ROAS dedup, engagement, cents)"
```

---

## Task 5: Supabase migrations

**Files:**
- Create: `supabase/migrations/20260602090000_ad_insights.sql`
- Create: `supabase/migrations/20260602091000_ad_spend_fact.sql`
- Create: `supabase/migrations/20260602092000_analytics_views.sql`
- Create: `supabase/migrations/20260602093000_analytics_settings.sql`

> These are Supabase-managed (CLAUDE.md carve-out, spec sec 10). They can't be
> unit-tested; verification is "apply to a dev/staging Supabase + run validation
> SELECTs". Reconcile every column name against **Task 0** before applying.

- [ ] **Step 1: Write `20260602090000_ad_insights.sql`**

```sql
-- Ad-level dim + daily insight fact (incl engagement). Shared with #3.
create table if not exists public.ad_dim (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  external_id text not null,
  campaign_external_id text not null,
  adset_external_id text,
  name text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shop_id, external_id)
);
create index if not exists ad_dim_shop_campaign_idx
  on public.ad_dim (shop_id, campaign_external_id);

create table if not exists public.ad_insight_fact (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null references public.shops(id) on delete cascade,
  ad_external_id text not null,
  campaign_external_id text not null,
  day_bucket date not null,
  spend_cents bigint not null default 0,
  impressions bigint not null default 0,
  link_clicks bigint not null default 0,
  purchases bigint not null default 0,
  purchase_value_cents bigint not null default 0,
  currency text not null default 'USD',
  reactions bigint not null default 0,
  comments bigint not null default 0,
  shares bigint not null default 0,
  saves bigint not null default 0,
  post_engagement bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (shop_id, ad_external_id, day_bucket)
);
create index if not exists ad_insight_fact_shop_campaign_day_idx
  on public.ad_insight_fact (shop_id, campaign_external_id, day_bucket);
```

- [ ] **Step 2: Write `20260602091000_ad_spend_fact.sql`**

> Adjust to Task 0 findings. If `ad_spend_fact` already has these columns, only the unique index runs.

```sql
-- Campaign-level daily spend fact: ensure analytics columns + idempotency key.
alter table public.ad_spend_fact add column if not exists campaign_external_id text;
alter table public.ad_spend_fact add column if not exists day_bucket date;
alter table public.ad_spend_fact add column if not exists spend_cents bigint not null default 0;
alter table public.ad_spend_fact add column if not exists impressions bigint not null default 0;
alter table public.ad_spend_fact add column if not exists link_clicks bigint not null default 0;
alter table public.ad_spend_fact add column if not exists purchases bigint not null default 0;
alter table public.ad_spend_fact add column if not exists purchase_value_cents bigint not null default 0;
alter table public.ad_spend_fact add column if not exists currency text not null default 'USD';

create unique index if not exists ad_spend_fact_shop_campaign_day_uniq
  on public.ad_spend_fact (shop_id, campaign_external_id, day_bucket);
```

- [ ] **Step 3: Write `20260602092000_analytics_views.sql`**

> `v_campaigns_flat` is redefined to read real 7d aggregates. Confirm its current
> output columns in Task 0 and preserve every column the app already reads
> (`id, shop_id, name, platform, status, daily_budget_cents, spend_7d_cents,
> roas_7d, contribution_margin`).

```sql
-- Daily-grain views for client-side 30/90 windowing.
create or replace view public.v_campaign_insights_daily as
select
  f.shop_id,
  f.campaign_external_id,
  d.name as campaign_name,
  f.day_bucket,
  f.spend_cents,
  f.impressions,
  f.link_clicks,
  f.purchases,
  f.purchase_value_cents
from public.ad_spend_fact f
left join public.ad_campaign_dim d
  on d.shop_id = f.shop_id and d.external_id = f.campaign_external_id;

create or replace view public.v_ad_insights_daily as
select
  i.shop_id,
  i.ad_external_id,
  i.campaign_external_id,
  a.name as ad_name,
  i.day_bucket,
  i.spend_cents,
  i.impressions,
  i.link_clicks,
  i.purchases,
  i.purchase_value_cents,
  i.reactions,
  i.comments,
  i.shares,
  i.saves,
  i.post_engagement
from public.ad_insight_fact i
left join public.ad_dim a
  on a.shop_id = i.shop_id and a.external_id = i.ad_external_id;

-- Real trailing-7d rollup for the campaigns page + dashboard tile.
create or replace view public.v_campaigns_flat as
select
  d.external_id as id,
  d.shop_id,
  d.name,
  'Meta'::text as platform,
  coalesce(d.status, 'active') as status,
  coalesce(d.daily_budget_cents, 0) as daily_budget_cents,
  coalesce(s.spend_7d_cents, 0) as spend_7d_cents,
  coalesce(s.roas_7d, 0) as roas_7d,
  0::numeric as contribution_margin
from public.ad_campaign_dim d
left join (
  select
    shop_id,
    campaign_external_id,
    sum(spend_cents) as spend_7d_cents,
    case when sum(spend_cents) > 0
      then sum(purchase_value_cents)::numeric / sum(spend_cents)
      else 0 end as roas_7d
  from public.ad_spend_fact
  where day_bucket >= (current_date - interval '7 days')
  group by shop_id, campaign_external_id
) s on s.shop_id = d.shop_id and s.campaign_external_id = d.external_id;
```

- [ ] **Step 4: Write `20260602093000_analytics_settings.sql`**

```sql
create table if not exists public.analytics_settings (
  shop_id uuid primary key references public.shops(id) on delete cascade,
  blended_margin_override numeric,
  updated_at timestamptz not null default now()
);
```

- [ ] **Step 5: Apply + validate**

Apply each file via the **supabase MCP** `apply_migration` (or `supabase db push`) against the dev project, then validate:

```sql
select count(*) from public.ad_insight_fact;          -- 0, table exists
select count(*) from public.analytics_settings;       -- 0, table exists
select * from public.v_campaign_insights_daily limit 1;
select * from public.v_campaigns_flat limit 1;        -- columns unchanged for the app
```

Expected: all four objects resolve; `v_campaigns_flat` still exposes the columns the app reads.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026060209*.sql
git commit -m "feat(db): ad_insight_fact, ad_dim, analytics views + settings"
```

---

## Task 6: `insights-client.server.ts` (paginated Insights GET)

**Files:**
- Create: `app/lib/meta/insights/insights-client.server.ts`
- Test: `app/lib/meta/insights/__tests__/insights-client.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/meta/insights/__tests__/insights-client.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchInsights, CAMPAIGN_FIELDS, AD_FIELDS } from "../insights-client.server";
import type { MetaClient } from "../../campaigns.server";

function fakeClient(pages: Array<Record<string, unknown>>): { client: MetaClient; get: ReturnType<typeof vi.fn> } {
  let i = 0;
  const get = vi.fn(async () => pages[i++] ?? { data: [] });
  return { client: { get, post: vi.fn() }, get };
}

describe("fetchInsights", () => {
  it("requests campaign-level insights with the agreed fields + params", async () => {
    const { client, get } = fakeClient([{ data: [{ campaign_id: "1" }] }]);
    const rows = await fetchInsights(client, "act_9", {
      level: "campaign",
      since: "2026-05-01",
      until: "2026-05-30",
    });
    expect(get).toHaveBeenCalledWith("/act_9/insights", {
      level: "campaign",
      fields: CAMPAIGN_FIELDS,
      time_increment: "1",
      time_range: JSON.stringify({ since: "2026-05-01", until: "2026-05-30" }),
      use_unified_attribution_setting: "true",
      action_report_time: "conversion",
      limit: "200",
    });
    expect(rows).toEqual([{ campaign_id: "1" }]);
  });

  it("uses AD_FIELDS at ad level and follows paging.next cursors", async () => {
    const { client, get } = fakeClient([
      { data: [{ ad_id: "a" }], paging: { next: "x", cursors: { after: "CUR2" } } },
      { data: [{ ad_id: "b" }] },
    ]);
    const rows = await fetchInsights(client, "act_9", { level: "ad", since: "2026-05-01", until: "2026-05-30" });
    expect(get.mock.calls[0][1]).toMatchObject({ fields: AD_FIELDS, level: "ad" });
    expect(get.mock.calls[1][1]).toMatchObject({ after: "CUR2" });
    expect(rows).toEqual([{ ad_id: "a" }, { ad_id: "b" }]);
  });

  it("throws on a Graph error payload", async () => {
    const client: MetaClient = { get: vi.fn(async () => ({ error: { message: "Rate limited", code: 17 } })), post: vi.fn() };
    await expect(
      fetchInsights(client, "act_9", { level: "campaign", since: "2026-05-01", until: "2026-05-30" }),
    ).rejects.toThrow(/Rate limited/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/meta/insights/__tests__/insights-client.test.ts`
Expected: FAIL ("Cannot find module '../insights-client.server'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/meta/insights/insights-client.server.ts`:

```ts
import type { MetaClient, MetaResponse } from "../campaigns.server";
import type { InsightRow } from "./mappers.server";

export const CAMPAIGN_FIELDS =
  "campaign_id,campaign_name,spend,impressions,inline_link_clicks,actions,action_values,account_currency";
export const AD_FIELDS =
  "ad_id,ad_name,adset_id,campaign_id,spend,impressions,inline_link_clicks,actions,action_values,account_currency";

const PAGE_LIMIT = "200";
const MAX_PAGES = 50; // safety bound on Insights pagination within one shop's single-pass pull

export interface InsightsQuery {
  level: "campaign" | "ad";
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD
}

function check(r: MetaResponse): MetaResponse {
  if (r.error) {
    const code = r.error.code != null ? ` (code ${r.error.code})` : "";
    throw new Error(`Meta Insights error: ${r.error.message}${code}`);
  }
  return r;
}

export async function fetchInsights(
  client: MetaClient,
  adAccountId: string,
  q: InsightsQuery,
): Promise<InsightRow[]> {
  const baseParams: Record<string, string> = {
    level: q.level,
    fields: q.level === "ad" ? AD_FIELDS : CAMPAIGN_FIELDS,
    time_increment: "1",
    time_range: JSON.stringify({ since: q.since, until: q.until }),
    use_unified_attribution_setting: "true",
    action_report_time: "conversion",
    limit: PAGE_LIMIT,
  };

  const out: InsightRow[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = after ? { ...baseParams, after } : baseParams;
    const body = check(await client.get(`/${adAccountId}/insights`, params));
    out.push(...((body.data as InsightRow[]) ?? []));
    const paging = body.paging as { next?: string; cursors?: { after?: string } } | undefined;
    if (!paging?.next || !paging.cursors?.after) break;
    after = paging.cursors.after;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/meta/insights/__tests__/insights-client.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/insights/insights-client.server.ts app/lib/meta/insights/__tests__/insights-client.test.ts
git commit -m "feat(meta): paginated Insights client (unified attribution, daily)"
```

---

## Task 7: Parameterize the DLQ connector

**Files:**
- Modify: `app/lib/ingest/dlq.server.ts`
- Test: `app/lib/ingest/__tests__/dlq.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/ingest/__tests__/dlq.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const insert = vi.fn(async () => ({ error: null }));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert }) }),
}));

import { writeDlq } from "../dlq.server";

beforeEach(() => insert.mockClear());

describe("writeDlq", () => {
  it("defaults connector to shopify", async () => {
    await writeDlq({ shopId: "s1", jobKind: "backfill", errorKind: "x", errorMessage: "boom", payload: {} });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ connector: "shopify", job_kind: "backfill" }));
  });

  it("uses the provided connector", async () => {
    await writeDlq({ shopId: "s1", connector: "meta", jobKind: "poll", errorKind: "x", errorMessage: "boom", payload: {} });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ connector: "meta", job_kind: "poll" }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ingest/__tests__/dlq.test.ts`
Expected: FAIL (the `connector` option does not exist yet -> second assertion fails).

- [ ] **Step 3: Modify implementation**

Replace the body of `app/lib/ingest/dlq.server.ts` with:

```ts
import { getSupabase } from "../supabase.server";

export async function writeDlq(opts: {
  shopId: string | null;
  connector?: string;
  jobKind: string;
  errorKind: string;
  errorMessage: string;
  payload: unknown;
}): Promise<void> {
  const { error } = await getSupabase().from("ingestion_dlq").insert({
    shop_id: opts.shopId,
    connector: opts.connector ?? "shopify",
    job_kind: opts.jobKind,
    attempts: 1,
    error_kind: opts.errorKind,
    error_message: opts.errorMessage.slice(0, 2000),
    payload: (opts.payload ?? {}) as object,
  });
  if (error) {
    // Never let DLQ failure mask the original error; log and move on (rule 12: stay visible).
    console.error("[ingest] failed to write ingestion_dlq", error, opts.jobKind);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/ingest/__tests__/dlq.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/dlq.server.ts app/lib/ingest/__tests__/dlq.test.ts
git commit -m "refactor(ingest): writeDlq accepts a connector (default shopify)"
```

---

## Task 8: `backfill.server.ts` (per-shop 90-day backfill, single-pass)

**Files:**
- Create: `app/lib/meta/insights/backfill.server.ts`
- Test: `app/lib/meta/insights/__tests__/backfill.test.ts`

The supabase write surface is injected so the orchestration is unit-testable with a fake. Window dates are computed by a pure helper that is asserted directly.

- [ ] **Step 1: Write the failing test**

`app/lib/meta/insights/__tests__/backfill.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { backfillMetaShop, windowRange } from "../backfill.server";

describe("windowRange", () => {
  it("returns an inclusive since..until of `days` ending today", () => {
    const { since, until } = windowRange(90, new Date("2026-06-02T00:00:00Z"));
    expect(until).toBe("2026-06-02");
    expect(since).toBe("2026-03-04"); // 90 days earlier
  });
});

describe("backfillMetaShop", () => {
  it("upserts campaign + ad facts/dims from fetched insights", async () => {
    const upserts: Record<string, unknown[]> = {};
    const deps = {
      shopId: "shop-1",
      adAccountId: "act_9",
      fetchInsights: vi.fn(async (_c: unknown, _a: string, q: { level: string }) =>
        q.level === "campaign"
          ? [{ campaign_id: "120", campaign_name: "Prospecting", date_start: "2026-05-01", spend: "10.00", action_values: [{ action_type: "omni_purchase", value: "30.00" }] }]
          : [{ ad_id: "777", ad_name: "Hero", adset_id: "5", campaign_id: "120", date_start: "2026-05-01", spend: "10.00", actions: [{ action_type: "post_reaction", value: "4" }] }],
      ),
      client: { get: vi.fn(), post: vi.fn() },
      upsert: vi.fn(async (table: string, rows: unknown[]) => {
        upserts[table] = (upserts[table] ?? []).concat(rows);
      }),
      now: new Date("2026-06-02T00:00:00Z"),
    };

    const res = await backfillMetaShop(deps);

    expect(deps.fetchInsights).toHaveBeenCalledTimes(2);
    expect(upserts["ad_campaign_dim"]).toEqual([{ shop_id: "shop-1", external_id: "120", name: "Prospecting" }]);
    expect(upserts["ad_spend_fact"][0]).toMatchObject({ campaign_external_id: "120", spend_cents: 1000, purchase_value_cents: 3000 });
    expect(upserts["ad_dim"][0]).toMatchObject({ external_id: "777", campaign_external_id: "120" });
    expect(upserts["ad_insight_fact"][0]).toMatchObject({ ad_external_id: "777", reactions: 4 });
    expect(res).toMatchObject({ campaignFacts: 1, adFacts: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/meta/insights/__tests__/backfill.test.ts`
Expected: FAIL ("Cannot find module '../backfill.server'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/meta/insights/backfill.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../../supabase.server";
import { metaClientForShop } from "../client.server";
import { writeDlq } from "../../ingest/dlq.server";
import type { MetaClient } from "../campaigns.server";
import { fetchInsights, type InsightsQuery } from "./insights-client.server";
import type { InsightRow } from "./mappers.server";
import { mapCampaignInsight, mapAdInsight, mapAdDim, mapCampaignDim } from "./mappers.server";

export const BACKFILL_DAYS = 90;

export interface BackfillDeps {
  shopId: string;
  adAccountId: string;
  client: MetaClient;
  fetchInsights: (c: MetaClient, acct: string, q: InsightsQuery) => Promise<InsightRow[]>;
  upsert: (table: string, rows: unknown[]) => Promise<void>;
  now: Date;
}

export interface BackfillResult {
  campaignFacts: number;
  adFacts: number;
}

/** Pure: YYYY-MM-DD since/until window of `days`, inclusive, ending on `now`. */
export function windowRange(days: number, now: Date): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return { since, until };
}

function dedupeByExternalId<T extends { external_id: string }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) m.set(r.external_id, r);
  return [...m.values()];
}

/** Orchestrate one shop's backfill with injected deps (unit-testable). */
export async function backfillMetaShop(deps: BackfillDeps): Promise<BackfillResult> {
  const { since, until } = windowRange(BACKFILL_DAYS, deps.now);

  const campaignRows = await deps.fetchInsights(deps.client, deps.adAccountId, { level: "campaign", since, until });
  const campaignDims = dedupeByExternalId(campaignRows.map((r) => mapCampaignDim(deps.shopId, r)));
  const campaignFacts = campaignRows.map((r) => mapCampaignInsight(deps.shopId, r));
  if (campaignDims.length) await deps.upsert("ad_campaign_dim", campaignDims);
  if (campaignFacts.length) await deps.upsert("ad_spend_fact", campaignFacts);

  const adRows = await deps.fetchInsights(deps.client, deps.adAccountId, { level: "ad", since, until });
  const adDims = dedupeByExternalId(adRows.map((r) => mapAdDim(deps.shopId, r)));
  const adFacts = adRows.map((r) => mapAdInsight(deps.shopId, r));
  if (adDims.length) await deps.upsert("ad_dim", adDims);
  if (adFacts.length) await deps.upsert("ad_insight_fact", adFacts);

  return { campaignFacts: campaignFacts.length, adFacts: adFacts.length };
}

const CONFLICT: Record<string, string> = {
  ad_campaign_dim: "shop_id,external_id",
  ad_dim: "shop_id,external_id",
  ad_spend_fact: "shop_id,campaign_external_id,day_bucket",
  ad_insight_fact: "shop_id,ad_external_id,day_bucket",
};

/** Production entry: resolves creds + supabase, delegates to backfillMetaShop. */
export async function runMetaBackfill(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const conn = await metaClientForShop(shopDomain);
  if (!conn) return { campaignFacts: 0, adFacts: 0 };

  try {
    const res = await backfillMetaShop({
      shopId,
      adAccountId: conn.adAccountId,
      client: conn.client,
      fetchInsights,
      now: new Date(),
      upsert: async (table, rows) => {
        const { error } = await sb.from(table).upsert(rows as object[], { onConflict: CONFLICT[table] });
        if (error) throw error;
      },
    });
    await sb
      .from("shop_integrations")
      .update({ sync_status: "ready", sync_error: null, last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({ shopId, connector: "meta", jobKind: "backfill", errorKind: "backfill_failed", errorMessage: message, payload: { shopDomain } });
    await sb
      .from("shop_integrations")
      .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/meta/insights/__tests__/backfill.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/insights/backfill.server.ts app/lib/meta/insights/__tests__/backfill.test.ts
git commit -m "feat(meta): per-shop Insights backfill (injected deps, DLQ)"
```

---

## Task 9: `poller.server.ts` (daily incremental)

**Files:**
- Create: `app/lib/meta/insights/poller.server.ts`
- Test: `app/lib/meta/insights/__tests__/poller.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/meta/insights/__tests__/poller.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { pollWindow } from "../poller.server";

describe("pollWindow", () => {
  it("re-pulls yesterday + today so late attributions correct in place", () => {
    const { since, until } = pollWindow(new Date("2026-06-02T00:00:00Z"));
    expect(since).toBe("2026-06-01");
    expect(until).toBe("2026-06-02");
  });
});

describe("runMetaPoll (smoke via injected backfill)", () => {
  it("delegates to the same upsert path for a 2-day window", async () => {
    const upserts: string[] = [];
    const { backfillMetaShop } = await import("../backfill.server");
    await backfillMetaShop({
      shopId: "s",
      adAccountId: "act_9",
      client: { get: vi.fn(), post: vi.fn() },
      now: new Date("2026-06-02T00:00:00Z"),
      fetchInsights: vi.fn(async () => []),
      upsert: vi.fn(async (t: string) => { upserts.push(t); }),
    });
    expect(upserts).toEqual([]); // empty insights -> no upserts, no throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/meta/insights/__tests__/poller.test.ts`
Expected: FAIL ("Cannot find module '../poller.server'").

- [ ] **Step 3: Write minimal implementation**

`app/lib/meta/insights/poller.server.ts`:

```ts
import { getSupabase, resolveShopId } from "../../supabase.server";
import { metaClientForShop } from "../client.server";
import { writeDlq } from "../../ingest/dlq.server";
import { fetchInsights } from "./insights-client.server";
import { backfillMetaShop, type BackfillResult } from "./backfill.server";

/** Pure: yesterday..today window (covers late-attributed conversions). */
export function pollWindow(now: Date): { since: string; until: string } {
  const until = now.toISOString().slice(0, 10);
  const since = new Date(now.getTime() - 1 * 86_400_000).toISOString().slice(0, 10);
  return { since, until };
}

const CONFLICT: Record<string, string> = {
  ad_campaign_dim: "shop_id,external_id",
  ad_dim: "shop_id,external_id",
  ad_spend_fact: "shop_id,campaign_external_id,day_bucket",
  ad_insight_fact: "shop_id,ad_external_id,day_bucket",
};

export async function runMetaPoll(shopDomain: string): Promise<BackfillResult> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shopDomain);
  const conn = await metaClientForShop(shopDomain);
  if (!conn) return { campaignFacts: 0, adFacts: 0 };

  const now = new Date();
  const { since, until } = pollWindow(now);
  try {
    // Reuse the backfill orchestration but constrain the window to 2 days.
    const res = await backfillMetaShop({
      shopId,
      adAccountId: conn.adAccountId,
      client: conn.client,
      now,
      fetchInsights: (c, a, q) => fetchInsights(c, a, { ...q, since, until }),
      upsert: async (table, rows) => {
        const { error } = await sb.from(table).upsert(rows as object[], { onConflict: CONFLICT[table] });
        if (error) throw error;
      },
    });
    await sb
      .from("shop_integrations")
      .update({ last_sync_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads");
    return res;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await writeDlq({ shopId, connector: "meta", jobKind: "poll", errorKind: "poll_failed", errorMessage: message, payload: { shopDomain } });
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/meta/insights/__tests__/poller.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/insights/poller.server.ts app/lib/meta/insights/__tests__/poller.test.ts
git commit -m "feat(meta): daily Insights poll (yesterday+today, reuses backfill upserts)"
```

---

## Task 10: Wire the Meta phase into cron

**Files:**
- Modify: `app/routes/cron.ingest.tsx`

- [ ] **Step 1: Add the Meta phase**

In `app/routes/cron.ingest.tsx`, add imports under the existing ones:

```ts
import { runMetaBackfill } from "~/lib/meta/insights/backfill.server";
import { runMetaPoll } from "~/lib/meta/insights/poller.server";
```

Extend the `summary` object literal with a `meta` field:

```ts
    meta: { backfilled: [] as string[], polled: [] as string[], errors: [] as string[] },
```

Then add Phase 4 immediately before `return json(summary);`:

```ts
  // Phase 4: Meta ad-spend ingestion. Single-pass per shop. Backfill a BOUNDED
  // number of not-yet-synced shops per tick (resumable at SHOP granularity, like
  // Phase 1's MAX_BACKFILL_SHOPS); poll the already-synced ones (cheap 2-day pull).
  // A failed shop keeps last_sync_at = null (runMetaBackfill sets error status,
  // not last_sync_at), so it is retried wholesale next tick -- safe because the
  // upserts are idempotent. One shop's failure is isolated (detail in ingestion_dlq).
  const { data: metaPending } = await sb
    .from("shop_integrations")
    .select("shops!inner(shop_domain)")
    .eq("kind", "meta_ads")
    .is("last_sync_at", null)
    .limit(MAX_BACKFILL_SHOPS);
  for (const row of metaPending ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await runMetaBackfill(domain);
      summary.meta.backfilled.push(domain);
    } catch {
      summary.meta.errors.push(domain); // detail already in ingestion_dlq
    }
  }

  const { data: metaReady } = await sb
    .from("shop_integrations")
    .select("shops!inner(shop_domain)")
    .eq("kind", "meta_ads")
    .not("last_sync_at", "is", null);
  for (const row of metaReady ?? []) {
    const domain = (row as unknown as { shops: { shop_domain: string } }).shops.shop_domain;
    try {
      await runMetaPoll(domain);
      summary.meta.polled.push(domain);
    } catch {
      summary.meta.errors.push(domain); // detail already in ingestion_dlq
    }
  }
```

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0 (route compiles).

- [ ] **Step 3: Commit**

```bash
git add app/routes/cron.ingest.tsx
git commit -m "feat(cron): Meta ad-spend backfill/poll phase"
```

---

## Task 11: `analytics` rollups + `calderynClient.analytics.*`

**Files:**
- Create: `app/lib/analytics/rollup.ts`
- Test: `app/lib/analytics/__tests__/rollup.test.ts`
- Modify: `app/lib/calderyn.server.ts`

Pure rollups carry the test weight; the client methods are thin Supabase reads that call them.

- [ ] **Step 1: Write the failing test for rollups**

`app/lib/analytics/__tests__/rollup.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { rollupTrend, rollupSummary, rollupCampaigns } from "../rollup";

const camp = [
  { campaign_external_id: "120", campaign_name: "Prospecting", day_bucket: "2026-05-01", spend_cents: 1000, impressions: 100, link_clicks: 5, purchases: 1, purchase_value_cents: 3000 },
  { campaign_external_id: "120", campaign_name: "Prospecting", day_bucket: "2026-05-02", spend_cents: 1000, impressions: 100, link_clicks: 5, purchases: 1, purchase_value_cents: 1000 },
];
const ads = [
  { campaign_external_id: "120", ad_external_id: "a1", ad_name: "Hero", day_bucket: "2026-05-01", spend_cents: 1000, purchase_value_cents: 3000, reactions: 4, comments: 1, shares: 2, saves: 1, post_engagement: 10 },
];

describe("rollupTrend", () => {
  it("sums spend per day and computes daily ROAS", () => {
    expect(rollupTrend(camp)).toEqual([
      { day_bucket: "2026-05-01", spend_cents: 1000, roas: 3 },
      { day_bucket: "2026-05-02", spend_cents: 1000, roas: 1 },
    ]);
  });
});

describe("rollupSummary", () => {
  it("computes account ROAS, total spend, and engagement", () => {
    const s = rollupSummary(camp, ads, { breakEvenRoas: 2, marginPct: 0.5, confidence: "ok", windowDays: 30 });
    expect(s.total_spend_cents).toBe(2000);
    expect(s.account_roas).toBeCloseTo(2, 5); // 4000/2000
    expect(s.total_engagement).toBe(8); // 4+1+2+1
    expect(s.break_even_roas).toBe(2);
    expect(s.window_days).toBe(30);
  });
});

describe("rollupCampaigns", () => {
  it("aggregates per campaign, grades, and attaches engagement + alerts", () => {
    const rows = rollupCampaigns(camp, ads, 2, { "120": ["alert-1"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      campaign_id: "120",
      spend_cents: 2000,
      purchase_value_cents: 4000,
      roas: 2,
      break_even_roas: 2,
      grade: "okay", // 2 >= 0.95*2 but < 1.2*2
      linked_alert_ids: ["alert-1"],
    });
    expect(rows[0].engagement).toMatchObject({ reactions: 4, shares: 2 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/analytics/__tests__/rollup.test.ts`
Expected: FAIL ("Cannot find module '../rollup'").

- [ ] **Step 3: Write the rollup implementation**

`app/lib/analytics/rollup.ts`:

```ts
import type {
  AnalyticsSummary,
  CampaignInsight,
  Engagement,
  MarginConfidence,
  TrendPoint,
} from "~/lib/types";
import { gradeCampaign } from "./classify";

export interface CampaignDailyRow {
  campaign_external_id: string;
  campaign_name: string;
  day_bucket: string;
  spend_cents: number;
  impressions: number;
  link_clicks: number;
  purchases: number;
  purchase_value_cents: number;
}

export interface AdDailyRow {
  campaign_external_id: string;
  ad_external_id: string;
  ad_name: string;
  day_bucket: string;
  spend_cents: number;
  purchase_value_cents: number;
  reactions: number;
  comments: number;
  shares: number;
  saves: number;
  post_engagement: number;
}

const roas = (value: number, spend: number) => (spend > 0 ? value / spend : 0);

export function rollupTrend(rows: CampaignDailyRow[]): TrendPoint[] {
  const byDay = new Map<string, { spend: number; value: number }>();
  for (const r of rows) {
    const cur = byDay.get(r.day_bucket) ?? { spend: 0, value: 0 };
    cur.spend += r.spend_cents;
    cur.value += r.purchase_value_cents;
    byDay.set(r.day_bucket, cur);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day_bucket, v]) => ({ day_bucket, spend_cents: v.spend, roas: roas(v.value, v.spend) }));
}

function sumEngagement(rows: AdDailyRow[]): Engagement {
  return rows.reduce<Engagement>(
    (e, r) => ({
      reactions: e.reactions + r.reactions,
      comments: e.comments + r.comments,
      shares: e.shares + r.shares,
      saves: e.saves + r.saves,
      post_engagement: e.post_engagement + r.post_engagement,
    }),
    { reactions: 0, comments: 0, shares: 0, saves: 0, post_engagement: 0 },
  );
}

export function rollupSummary(
  camp: CampaignDailyRow[],
  ads: AdDailyRow[],
  opts: { breakEvenRoas: number; marginPct: number; confidence: MarginConfidence; windowDays: 7 | 30 | 90 },
): AnalyticsSummary {
  const spend = camp.reduce((s, r) => s + r.spend_cents, 0);
  const value = camp.reduce((s, r) => s + r.purchase_value_cents, 0);
  const eng = sumEngagement(ads);
  return {
    window_days: opts.windowDays,
    blended_margin_pct: opts.marginPct,
    margin_confidence: opts.confidence,
    break_even_roas: opts.breakEvenRoas,
    account_roas: roas(value, spend),
    total_spend_cents: spend,
    total_engagement: eng.reactions + eng.comments + eng.shares + eng.saves,
  };
}

export function rollupCampaigns(
  camp: CampaignDailyRow[],
  ads: AdDailyRow[],
  breakEvenRoas: number,
  linkedAlerts: Record<string, string[]>,
): CampaignInsight[] {
  const engByCampaign = new Map<string, AdDailyRow[]>();
  for (const a of ads) {
    const list = engByCampaign.get(a.campaign_external_id) ?? [];
    list.push(a);
    engByCampaign.set(a.campaign_external_id, list);
  }

  const byCampaign = new Map<string, CampaignInsight>();
  for (const r of camp) {
    const cur =
      byCampaign.get(r.campaign_external_id) ??
      ({
        campaign_id: r.campaign_external_id,
        name: r.campaign_name,
        status: "active",
        spend_cents: 0,
        impressions: 0,
        link_clicks: 0,
        purchases: 0,
        purchase_value_cents: 0,
        roas: 0,
        break_even_roas: breakEvenRoas,
        grade: "poor",
        engagement: sumEngagement(engByCampaign.get(r.campaign_external_id) ?? []),
        linked_alert_ids: linkedAlerts[r.campaign_external_id] ?? [],
      } satisfies CampaignInsight);
    cur.spend_cents += r.spend_cents;
    cur.impressions += r.impressions;
    cur.link_clicks += r.link_clicks;
    cur.purchases += r.purchases;
    cur.purchase_value_cents += r.purchase_value_cents;
    byCampaign.set(r.campaign_external_id, cur);
  }

  return [...byCampaign.values()]
    .map((c) => {
      const r = roas(c.purchase_value_cents, c.spend_cents);
      return { ...c, roas: r, grade: gradeCampaign(r, breakEvenRoas) };
    })
    .sort((a, b) => b.spend_cents - a.spend_cents);
}
```

- [ ] **Step 4: Run rollup test to verify it passes**

Run: `npx vitest run app/lib/analytics/__tests__/rollup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the `analytics` namespace to the client**

In `app/lib/calderyn.server.ts`, add imports at the top:

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBreakEven, DEFAULT_MARGIN, COVERAGE_THRESHOLD, type BreakEvenResult } from "./analytics/breakeven";
import { rollupTrend, rollupSummary, rollupCampaigns, type CampaignDailyRow, type AdDailyRow } from "./analytics/rollup";
import type { AnalyticsSummary, CampaignInsight, AdInsight, TrendPoint } from "./types";
```

Add these module-level helpers above `calderynClient` (after the `rowTo*` helpers). They are free functions -- no `this`, and nothing is exposed on the client surface except real DTO methods:

```ts
export type AnalyticsWindow = 7 | 30 | 90;
const sinceISO = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

async function loadDaily(
  supabase: SupabaseClient,
  shopId: string,
  days: number,
): Promise<{ camp: CampaignDailyRow[]; ads: AdDailyRow[] }> {
  const since = sinceISO(days);
  const [campRes, adsRes] = await Promise.all([
    supabase.from("v_campaign_insights_daily").select("*").eq("shop_id", shopId).gte("day_bucket", since),
    supabase.from("v_ad_insights_daily").select("*").eq("shop_id", shopId).gte("day_bucket", since),
  ]);
  if (campRes.error) throw campRes.error;
  if (adsRes.error) throw adsRes.error;
  return { camp: (campRes.data ?? []) as CampaignDailyRow[], ads: (adsRes.data ?? []) as AdDailyRow[] };
}

async function loadBreakEven(supabase: SupabaseClient, shopId: string, days: number): Promise<BreakEvenResult> {
  const since = sinceISO(days);
  const [settingsRes, lineRes] = await Promise.all([
    supabase.from("analytics_settings").select("blended_margin_override").eq("shop_id", shopId).maybeSingle(),
    supabase
      .from("order_line_fact")
      .select("quantity, price_cents, sku_dim!inner(unit_cost_cents), order_fact!inner(shop_id, created_at)")
      .eq("order_fact.shop_id", shopId)
      .gte("order_fact.created_at", since),
  ]);
  if (settingsRes.error) throw settingsRes.error;
  if (lineRes.error) throw lineRes.error;
  const lines = (lineRes.data ?? []).map((r) => {
    const row = r as unknown as { quantity: number; price_cents: number; sku_dim: { unit_cost_cents: number | null } };
    return { price_cents: row.price_cents, quantity: row.quantity, unit_cost_cents: row.sku_dim?.unit_cost_cents ?? null };
  });
  const override =
    (settingsRes.data as { blended_margin_override?: number | null } | null)?.blended_margin_override ?? null;
  return computeBreakEven({ lines, override, defaultMargin: DEFAULT_MARGIN, coverageThreshold: COVERAGE_THRESHOLD });
}

// Open alerts keyed by campaign NAME (matches the existing name-link in
// app.campaigns.tsx). If Task 0 shows alerts carry a Meta campaign id, switch the
// key to the id and pass it straight to rollupCampaigns for a precise join.
async function loadAlertLinks(supabase: SupabaseClient, shopId: string): Promise<Record<string, string[]>> {
  const { data, error } = await supabase
    .from("v_alerts_view").select("id, campaign, status")
    .eq("shop_id", shopId).eq("status", "open");
  if (error) throw error;
  const out: Record<string, string[]> = {};
  for (const a of (data ?? []) as { id: string; campaign: string | null }[]) {
    if (!a.campaign) continue;
    (out[a.campaign] ??= []).push(a.id);
  }
  return out;
}
```

Then inside the object returned by `calderynClient`, add a new `analytics` key (sibling of `campaigns`). Every method is a real DTO method; the loaders above stay module-private:

```ts
    analytics: {
      async summary(days: AnalyticsWindow = 30): Promise<AnalyticsSummary> {
        try {
          const shopId = await shopIdP;
          const [{ camp, ads }, be] = await Promise.all([
            loadDaily(supabase, shopId, days),
            loadBreakEven(supabase, shopId, days),
          ]);
          return rollupSummary(camp, ads, {
            breakEvenRoas: be.breakEvenRoas,
            marginPct: be.margin,
            confidence: be.confidence,
            windowDays: days,
          });
        } catch (err) {
          rethrow("analytics.summary", err);
        }
      },
      async trend(days: AnalyticsWindow = 30): Promise<TrendPoint[]> {
        try {
          const shopId = await shopIdP;
          const { camp } = await loadDaily(supabase, shopId, days);
          return rollupTrend(camp);
        } catch (err) {
          rethrow("analytics.trend", err);
        }
      },
      async campaigns(days: AnalyticsWindow = 30): Promise<CampaignInsight[]> {
        try {
          const shopId = await shopIdP;
          const [{ camp, ads }, be, links] = await Promise.all([
            loadDaily(supabase, shopId, days),
            loadBreakEven(supabase, shopId, days),
            loadAlertLinks(supabase, shopId),
          ]);
          return rollupCampaigns(camp, ads, be.breakEvenRoas, links);
        } catch (err) {
          rethrow("analytics.campaigns", err);
        }
      },
      async ads(campaignId: string, days: AnalyticsWindow = 30): Promise<AdInsight[]> {
        try {
          const shopId = await shopIdP;
          const { ads } = await loadDaily(supabase, shopId, days);
          // Accumulate purchase value in a temp field, then derive ROAS once at the end.
          const byAd = new Map<string, AdInsight & { _value_cents: number }>();
          for (const a of ads.filter((r) => r.campaign_external_id === campaignId)) {
            const cur =
              byAd.get(a.ad_external_id) ?? {
                ad_id: a.ad_external_id, campaign_id: campaignId, name: a.ad_name,
                spend_cents: 0, roas: 0, _value_cents: 0,
                engagement: { reactions: 0, comments: 0, shares: 0, saves: 0, post_engagement: 0 },
              };
            cur.spend_cents += a.spend_cents;
            cur._value_cents += a.purchase_value_cents;
            cur.engagement.reactions += a.reactions;
            cur.engagement.comments += a.comments;
            cur.engagement.shares += a.shares;
            cur.engagement.saves += a.saves;
            cur.engagement.post_engagement += a.post_engagement;
            byAd.set(a.ad_external_id, cur);
          }
          return [...byAd.values()]
            .map(({ _value_cents, ...ad }) => ({ ...ad, roas: ad.spend_cents > 0 ? _value_cents / ad.spend_cents : 0 }))
            .sort((x, y) => y.spend_cents - x.spend_cents);
        } catch (err) {
          rethrow("analytics.ads", err);
        }
      },
      settings: {
        async get(): Promise<{ marginOverride: number | null }> {
          try {
            const shopId = await shopIdP;
            const { data, error } = await supabase
              .from("analytics_settings").select("blended_margin_override").eq("shop_id", shopId).maybeSingle();
            if (error) throw error;
            return { marginOverride: (data?.blended_margin_override as number | null) ?? null };
          } catch (err) {
            rethrow("analytics.settings.get", err);
          }
        },
        async update(patch: { marginOverride: number | null }): Promise<void> {
          try {
            const shopId = await shopIdP;
            const { error } = await supabase
              .from("analytics_settings")
              .upsert(
                { shop_id: shopId, blended_margin_override: patch.marginOverride, updated_at: new Date().toISOString() },
                { onConflict: "shop_id" },
              );
            if (error) throw error;
          } catch (err) {
            rethrow("analytics.settings.update", err);
          }
        },
      },
    },
```

> `rollupCampaigns` keys `linked_alert_ids` the same way `loadAlertLinks` does
> (campaign name today). If Task 0 shows alerts carry a Meta campaign id, switch
> both to the id for a precise join.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/lib/analytics/rollup.ts app/lib/analytics/__tests__/rollup.test.ts app/lib/calderyn.server.ts
git commit -m "feat(analytics): rollups + calderynClient.analytics.* DTOs"
```

---

## Task 12: Analytics page (`app.analytics.tsx`) + polaris-viz + nav

**Files:**
- Modify: `package.json` (add `@shopify/polaris-viz`)
- Create: `app/routes/app.analytics.tsx`
- Modify: `app/routes/app.tsx` (nav link)

- [ ] **Step 1: Add the dependency**

Run: `npm install @shopify/polaris-viz`
Expected: it installs and `package.json` dependencies now list `@shopify/polaris-viz`. (CLAUDE.md: flagged in the spec sec 11.)

- [ ] **Step 2: Create the route**

`app/routes/app.analytics.tsx`:

```tsx
import { useNavigate, useLoaderData, useSearchParams } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  Badge, Banner, BlockStack, Button, ButtonGroup, Card, DataTable,
  InlineGrid, Page, Text,
} from "@shopify/polaris";
import { PolarisVizProvider, LineChart } from "@shopify/polaris-viz";
import "@shopify/polaris-viz/build/esm/styles.css";
import { authenticate } from "../shopify.server";
import { calderynClient, type CalderynError } from "~/lib/calderyn.server";
import { fmtMoney } from "~/lib/format";
import type { AnalyticsSummary, CampaignInsight, TrendPoint } from "~/lib/types";

type LoaderPayload = {
  window: 30 | 90;
  summary: AnalyticsSummary | null;
  trend: TrendPoint[];
  campaigns: CampaignInsight[];
  error: { code: string; message: string } | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const window = url.searchParams.get("window") === "90" ? 90 : 30;
  const client = calderynClient(session.shop);
  try {
    const [summary, trend, campaigns] = await Promise.all([
      client.analytics.summary(window),
      client.analytics.trend(window),
      client.analytics.campaigns(window),
    ]);
    return json<LoaderPayload>({ window, summary, trend, campaigns, error: null });
  } catch (err) {
    const e = err as CalderynError;
    return json<LoaderPayload>({ window, summary: null, trend: [], campaigns: [], error: { code: e.code ?? "ERROR", message: e.message } });
  }
};

const GRADE_TONE = { winning: "success", okay: "attention", poor: "critical" } as const;

export default function Analytics() {
  const navigate = useNavigate();
  const { window, summary, trend, campaigns, error } = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();

  const setWindow = (w: 30 | 90) => {
    params.set("window", String(w));
    setParams(params);
  };

  const series = [
    { name: "Spend", data: trend.map((p) => ({ key: p.day_bucket, value: p.spend_cents / 100 })) },
    { name: "ROAS", data: trend.map((p) => ({ key: p.day_bucket, value: p.roas })) },
  ];

  const rows = campaigns.map((c) => [
    <Text key={`n-${c.campaign_id}`} as="span" fontWeight="semibold">{c.name}</Text>,
    <Badge key={`g-${c.campaign_id}`} tone={GRADE_TONE[c.grade]}>{c.grade}</Badge>,
    fmtMoney(c.spend_cents),
    c.roas.toFixed(2),
    c.break_even_roas.toFixed(2),
    String(c.engagement.reactions + c.engagement.comments + c.engagement.shares + c.engagement.saves),
    c.linked_alert_ids.length ? (
      <Button key={`a-${c.campaign_id}`} variant="plain" onClick={() => navigate("/app/campaigns")}>Take action</Button>
    ) : "-",
  ]);

  return (
    <Page
      title="Analytics"
      subtitle="Real Meta ad-spend, ROAS and engagement"
      backAction={{ content: "Dashboard", onAction: () => navigate("/app") }}
      primaryAction={{ content: window === 30 ? "Showing 30 days" : "Showing 90 days", disabled: true }}
    >
      <BlockStack gap="400">
        {error && (
          <Banner tone="critical" title="Couldn't load analytics"><p>{error.code}: {error.message}</p></Banner>
        )}
        {summary?.margin_confidence === "low" || summary?.margin_confidence === "default" ? (
          <Banner tone="warning" title="Margin estimate is low-confidence">
            <p>Set your gross margin in Settings for accurate break-even grading.</p>
          </Banner>
        ) : null}

        <ButtonGroup variant="segmented">
          <Button pressed={window === 30} onClick={() => setWindow(30)}>30 days</Button>
          <Button pressed={window === 90} onClick={() => setWindow(90)}>90 days</Button>
        </ButtonGroup>

        {summary && (
          <InlineGrid columns={{ xs: 1, sm: 2, md: 4 }} gap="400">
            <Stat label="Account ROAS" value={summary.account_roas.toFixed(2)} />
            <Stat label="Break-even ROAS" value={summary.break_even_roas.toFixed(2)} />
            <Stat label="Spend" value={fmtMoney(summary.total_spend_cents)} />
            <Stat label="Engagement" value={String(summary.total_engagement)} />
          </InlineGrid>
        )}

        <Card>
          <BlockStack gap="200">
            <Text as="h2" variant="headingSm">Spend &amp; ROAS trend</Text>
            <div style={{ height: 280 }}>
              <PolarisVizProvider>
                <LineChart data={series} theme="Light" />
              </PolarisVizProvider>
            </div>
          </BlockStack>
        </Card>

        <Card padding="0">
          <DataTable
            columnContentTypes={["text", "text", "numeric", "numeric", "numeric", "numeric", "text"]}
            headings={["Campaign", "Grade", "Spend", "ROAS", "Break-even", "Engagement", "Next step"]}
            rows={rows}
          />
        </Card>
      </BlockStack>
    </Page>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
      </BlockStack>
    </Card>
  );
}
```

- [ ] **Step 3: Add the nav link**

In `app/routes/app.tsx`, add inside `<NavMenu>` after the Campaigns link:

```tsx
        <Link to="/app/analytics">Analytics</Link>
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0 (route + polaris-viz bundle build).

> If polaris-viz styles import path differs by version, use the path its README
> documents; the build error will name the correct file.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json app/routes/app.analytics.tsx app/routes/app.tsx
git commit -m "feat(ui): Analytics page (trend chart, grade table) + nav"
```

---

## Task 13: Real "True ROAS" tile + Campaigns enrichment

**Files:**
- Modify: `app/routes/app._index.tsx`
- Modify: `app/routes/app.campaigns.tsx`

- [ ] **Step 1: Dashboard tile reads the real account ROAS**

In `app/routes/app._index.tsx`, extend the loader's `Promise.all` to also load the summary, and the payload type:

```ts
// add to LoaderPayload:
  trueRoas: number | null;
```

```ts
// inside the try, replace the Promise.all destructuring:
    const [alerts, audit, guardrails, onboarding, summary] = await Promise.all([
      client.alerts.list({ status: "open" }, request.signal),
      client.audit.list(request.signal),
      client.guardrails.get(request.signal),
      client.onboarding.getState(request.signal),
      client.analytics.summary(7).catch(() => null), // AnalyticsWindow includes 7 (Task 11)
    ]);
    return json<LoaderPayload>({ alerts, audit, guardrails, onboardingDone: onboarding.done, trueRoas: summary?.account_roas ?? null, error: null });
```

> Also update the loader's `catch` branch `json<LoaderPayload>({...})` to include
> `trueRoas: null` so both branches satisfy `LoaderPayload`.

Then replace the `"True ROAS (7d)"` StatCard placeholder value (the dash literal) with:

```tsx
            value={trueRoas != null ? trueRoas.toFixed(2) : "-"}
```

- [ ] **Step 2: Campaigns page shows ingested ROAS/spend instead of 0**

In `app/routes/app.campaigns.tsx`, in the loader's `if (meta)` branch, enrich the live rows with ingested metrics from `v_campaigns_flat` (already exposed by `client.campaigns.list`). Replace the `live.map(...)` block:

```ts
      const ingested = await client.campaigns.list(request.signal);
      const byId = new Map(ingested.map((c) => [c.id, c]));
      campaigns = live.map((c) => {
        const hit = byId.get(c.id);
        return {
          id: c.id,
          name: c.name,
          platform: "Meta" as const,
          status: c.status === "PAUSED" ? ("paused" as const) : ("active" as const),
          daily_budget_cents: c.dailyBudgetCents ?? 0,
          roas_7d: hit?.roas_7d ?? 0,
          contribution_margin: hit?.contribution_margin ?? 0,
          spend_7d: hit?.spend_7d ?? 0,
        };
      });
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck`
Expected: exit 0.
Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app._index.tsx app/routes/app.campaigns.tsx
git commit -m "feat(ui): real True ROAS tile + ingested ROAS on Campaigns"
```

---

## Task 14: MCP scope/banner copy

**Files:**
- Modify: `app/routes/app.mcp.tsx`

- [ ] **Step 1: Mention analytics in the granted read-only surface**

In `app/routes/app.mcp.tsx`, update the "How to connect" banner copy to include analytics:

```tsx
            grants read-only access to your alerts, audit log, campaigns, SKUs,
            ad-spend analytics, guardrails, and integration status.
```

- [ ] **Step 2: Note the external server change (no code here)**

Add a code comment at the top of `app/routes/app.mcp.tsx` action region documenting that the external `calderyn-mcp` server must add the `analytics_summary` / `analytics_campaigns` read tools backed by `v_campaign_insights_daily` / `v_ad_insights_daily`:

```tsx
// NOTE: the external calderyn-mcp server exposes read tools backed by the same
// Supabase views. Adding analytics requires a matching `analytics_summary` /
// `analytics_campaigns` tool there (reads v_campaign_insights_daily +
// v_ad_insights_daily); this repo owns only the token surface + scope copy.
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/app.mcp.tsx
git commit -m "docs(mcp): list analytics in token scope; note external tool"
```

---

## Final verification (pre-commit gate, CLAUDE.md)

- [ ] **Step 1: Full test suite** -- Run: `npm test` -- Expected: all suites pass.
- [ ] **Step 2: Typecheck** -- Run: `npm run typecheck` -- Expected: exit 0.
- [ ] **Step 3: Lint** -- Run: `npm run lint` -- Expected: exit 0 (no warnings on touched files).
- [ ] **Step 4: Build** -- Run: `npm run build` -- Expected: exit 0.
- [ ] **Step 5: `/code-review`** on the working tree; resolve blockers; downgrade nits with one-line justifications.
- [ ] **Step 6: Patch sanity** -- `git diff --stat main...HEAD` and `git diff --check`; no stray `console.log`/`.only`/`TODO(me)`.

---

## Self-review notes (planner)

- **Spec coverage:** ingestion (Tasks 4,6,8,9,10), schema incl. preflight (Tasks 0,5), break-even + grade (Tasks 2,3), surface (Tasks 12,13), DTO+MCP (Tasks 11,14), engagement ad-level (Tasks 4,5,11). All spec sections map to a task.
- **Type consistency:** `CampaignInsight`/`AnalyticsSummary`/`Engagement`/`TrendPoint` defined in Task 1 are used unchanged in Tasks 11-13. `windowRange`/`pollWindow` are distinct pure helpers. `computeBreakEven` returns `confidence` consumed by `rollupSummary`.
- **Known reconciliation points (call out during execution):** Task 0 column names feed Tasks 5 + 11; the alert<->campaign link key (name vs id) in Task 11; the dashboard 7-day window typing in Task 13 (fix the type, no `as unknown as`); the polaris-viz styles import path in Task 12.
```
