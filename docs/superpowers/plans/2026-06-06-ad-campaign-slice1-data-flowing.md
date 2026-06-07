# Ad Campaign Integrations — Slice 1 (Data Flowing) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make real ad spend/performance data flow from Meta (Facebook + Instagram), Google, and TikTok into `ad_spend_fact` through one shared adapter contract, polled by a single bounded-concurrency cron.

**Architecture:** Define one `AdPlatformAdapter` contract that exposes a per-shop `ShopAdSource` (fetch campaigns / backfill spend / daily spend) returning **normalized** rows. A generic ingest core upserts those rows into `ad_campaign_dim` + `ad_spend_fact` regardless of platform. Each platform (Meta, Google, TikTok) implements only `connect()` + its `ShopAdSource`. Google is refactored onto this core (its public functions stay as thin wrappers so existing tests pass). One `cron.ingest-ads` route loops every connected shop × adapter with a bounded concurrency pool, per-platform 429 backoff, and constant-time bearer auth.

**Tech Stack:** TypeScript (strict, ES modules), Remix loaders, `@supabase/supabase-js` (service role), Vitest, Node `crypto`. Spec: `docs/superpowers/specs/2026-06-06-ad-campaign-integrations-design.md`.

---

## File Structure

**New files:**
- `app/lib/ads/adapter.ts` — `Platform`, `NormalizedCampaign`, `NormalizedSpendRow`, `ShopAdSource`, `AdPlatformAdapter` types. No I/O.
- `app/lib/ads/ingest.server.ts` — generic `backfillAds` / `pollAdsDaily` (platform-blind upserts; the extracted core of today's `google/ingest.server.ts`).
- `app/lib/ads/backoff.ts` — `withRetry` (exponential backoff + jitter, honors `Retry-After`, retries only rate/throttle errors).
- `app/lib/ads/concurrency.ts` — `mapWithConcurrency` (bounded pool).
- `app/lib/ads/registry.server.ts` — `adaptersForShops` (group integration rows → which adapters run per shop).
- `app/lib/cron-auth.server.ts` — `isAuthorizedCron` (constant-time bearer compare).
- `app/lib/meta/transform.ts` — Meta insights → normalized.
- `app/lib/meta/insights.server.ts` — fetch FB+IG per-campaign/day metrics from Meta Insights.
- `app/lib/meta/ingest.server.ts` — `metaAdapter` + `metaSourceForShop`.
- `app/lib/tiktok/types.ts` — TikTok payload + normalized-input types.
- `app/lib/tiktok/transform.ts` — TikTok report → normalized.
- `app/lib/tiktok/client.server.ts` — TikTok client + `tiktokClientForShop`.
- `app/lib/tiktok/ingest.server.ts` — `tiktokAdapter` + `tiktokSourceForShop`.
- `app/routes/cron.ingest-ads.tsx` — unified cron.
- `supabase/migrations/20260606120000_tiktok_platform.sql` + `tests/engine/schema/migrations/20260606120000_tiktok_platform.sql` — enum additions.
- Test files mirror each module under `__tests__/`.

**Modified files:**
- `app/lib/google/ingest.server.ts` — `backfillGoogle`/`pollGoogleDaily` become thin wrappers over `backfillAds`/`pollAdsDaily`; introduce `googleSource(client)`.
- `app/lib/google/types.ts` — `platform` field widens from `"google"` literal to shared `Platform`.
- `.env.example` — add TikTok keys.

**Deleted files:**
- `app/routes/cron.google.tsx` — replaced by `cron.ingest-ads.tsx`.

---

## Task 1: Migration — add `tiktok` platform + `tiktok_ads` integration kind

**Files:**
- Create: `supabase/migrations/20260606120000_tiktok_platform.sql`
- Create: `tests/engine/schema/migrations/20260606120000_tiktok_platform.sql`

CI enforces test-schema/prod parity (commit `1586f2f`), so the enum change must land in **both** migration trees with identical SQL.

- [ ] **Step 1: Write the migration SQL (prod tree)**

Create `supabase/migrations/20260606120000_tiktok_platform.sql`:

```sql
-- Slice 1: TikTok ad-platform support.
-- ad_platform gains 'tiktok'; integration_kind gains 'tiktok_ads'.
-- ALTER TYPE ... ADD VALUE is idempotent-guarded with IF NOT EXISTS so re-runs
-- are safe. Note: a newly added enum value cannot be used in the same
-- transaction it is added in — this migration only alters the types.
alter type public.ad_platform add value if not exists 'tiktok';
alter type public.integration_kind add value if not exists 'tiktok_ads';
```

- [ ] **Step 2: Copy identical SQL to the test schema tree**

Create `tests/engine/schema/migrations/20260606120000_tiktok_platform.sql` with the exact same contents as Step 1.

- [ ] **Step 3: Verify the live enums before/after (Supabase MCP)**

Per the testing-on-prod convention, confirm against the live prod project. Run via the Supabase MCP `execute_sql`:

```sql
select t.typname, e.enumlabel
from pg_type t join pg_enum e on e.enumtypid = t.oid
where t.typname in ('ad_platform','integration_kind')
order by t.typname, e.enumsortorder;
```

Expected before: `ad_platform` = meta, google; `integration_kind` = shopify, meta_ads, google_ads, quickbooks.

- [ ] **Step 4: Apply the migration to prod (Supabase MCP)**

Use Supabase MCP `apply_migration` with name `tiktok_platform` and the Step 1 SQL. Re-run the Step 3 query; expected after: `ad_platform` now includes `tiktok`, `integration_kind` includes `tiktok_ads`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260606120000_tiktok_platform.sql tests/engine/schema/migrations/20260606120000_tiktok_platform.sql
git commit -m "supabase/migrations: add tiktok ad_platform + tiktok_ads integration_kind"
```

---

## Task 2: Shared adapter contract + normalized types

**Files:**
- Create: `app/lib/ads/adapter.ts`
- Test: `app/lib/ads/__tests__/adapter.test.ts`

This file is types-only (no runtime I/O), so the "test" is a compile-time/shape assertion that the contract is usable and a fake conforms.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/adapter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type {
  Platform,
  NormalizedCampaign,
  NormalizedSpendRow,
  ShopAdSource,
  AdPlatformAdapter,
} from "../adapter";

describe("adapter contract", () => {
  it("a fake adapter conforms to the contract and yields normalized rows", async () => {
    const campaign: NormalizedCampaign = {
      shop_id: "s1",
      platform: "meta",
      external_id: "c1",
      name: "Spring",
      status: "active",
      objective: "OUTCOME_SALES",
      daily_budget_cents: 5000,
      currency: "USD",
      geo_targets: [],
      created_at_source: null,
    };
    const spend: NormalizedSpendRow = {
      shop_id: "s1",
      campaign_external_id: "c1",
      platform: "meta",
      day: "2026-06-01",
      spend_cents: 1234,
      impressions: 100,
      clicks: 10,
      conversions: 2,
      revenue_attrib_cents: 9900,
    };
    const source: ShopAdSource = {
      fetchCampaigns: async () => [campaign],
      fetchBackfillSpend: async () => [spend],
      fetchDailySpend: async () => [spend],
    };
    const adapter: AdPlatformAdapter = {
      platform: "meta",
      integrationKind: "meta_ads",
      connect: async () => source,
    };

    expect(adapter.platform).toBe("meta");
    expect((await source.fetchCampaigns())[0].external_id).toBe("c1");
    expect((await source.fetchDailySpend("2026-06-01"))[0].spend_cents).toBe(1234);
    const p: Platform = adapter.platform;
    expect(p).toBe("meta");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/adapter.test.ts`
Expected: FAIL — cannot find module `../adapter`.

- [ ] **Step 3: Write the contract**

Create `app/lib/ads/adapter.ts`:

```ts
// Shared, platform-blind ad-ingestion contract. Each ad platform (meta, google,
// tiktok) implements only `connect()` + a per-shop `ShopAdSource` that returns
// NORMALIZED rows. The generic ingest core (ads/ingest.server.ts) and everything
// above it (grading, actions) never branch on platform.

export type Platform = "meta" | "google" | "tiktok";

export type IntegrationKind = "meta_ads" | "google_ads" | "tiktok_ads";

export type CampaignStatus = "active" | "paused" | "archived";

/** Mirrors the ad_campaign_dim upsert shape, platform-agnostic. */
export interface NormalizedCampaign {
  shop_id: string;
  platform: Platform;
  external_id: string;
  name: string;
  status: CampaignStatus;
  objective: string | null;
  daily_budget_cents: number | null;
  currency: string;
  geo_targets: string[];
  created_at_source: string | null;
}

/** Mirrors the ad_spend_fact upsert shape, keyed by campaign EXTERNAL id. */
export interface NormalizedSpendRow {
  shop_id: string;
  campaign_external_id: string;
  platform: Platform;
  day: string; // YYYY-MM-DD
  spend_cents: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue_attrib_cents: number;
}

/** Per-shop, already-authenticated handle over one platform's data. */
export interface ShopAdSource {
  fetchCampaigns(): Promise<NormalizedCampaign[]>;
  fetchBackfillSpend(): Promise<NormalizedSpendRow[]>; // trailing ~90 days
  fetchDailySpend(day: string): Promise<NormalizedSpendRow[]>; // one YYYY-MM-DD
}

/** A platform plug. `connect` returns null when the shop has no usable creds. */
export interface AdPlatformAdapter {
  readonly platform: Platform;
  readonly integrationKind: IntegrationKind;
  connect(shopId: string): Promise<ShopAdSource | null>;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/adapter.ts app/lib/ads/__tests__/adapter.test.ts
git commit -m "app/lib/ads/adapter: shared platform-blind ingestion contract"
```

---

## Task 3: Generic ingest core

**Files:**
- Create: `app/lib/ads/ingest.server.ts`
- Test: `app/lib/ads/__tests__/ingest.test.ts`

This is the extracted, platform-parameterized version of `google/ingest.server.ts`. It upserts campaigns and resolves report rows to campaign UUIDs via a single batched `in` lookup, skipping (not throwing on) unknown campaigns — identical behavior, now keyed on a `platform` argument.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/ingest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { backfillAds, pollAdsDaily } from "../ingest.server";
import type { ShopAdSource, NormalizedCampaign, NormalizedSpendRow } from "../adapter";

const SHOP = "00000000-0000-0000-0000-000000000002";

type SelectResult = { data: Array<Record<string, unknown>>; error: null };

function makeFakeSupabase(selectData: Array<Record<string, unknown>>) {
  const calls = {
    upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }>,
    inserts: [] as Array<{ table: string; rows: unknown }>,
    updates: [] as Array<{ table: string; values: unknown }>,
    selectEqArgs: [] as Array<{ column: string; value: unknown }>,
    selectInArgs: [] as Array<{ column: string; values: unknown }>,
  };
  function builder(table: string, result: SelectResult) {
    const chain: Record<string, unknown> = {};
    chain.eq = vi.fn((column: string, value: unknown) => {
      calls.selectEqArgs.push({ column, value });
      return chain;
    });
    chain.in = vi.fn((column: string, values: unknown) => {
      calls.selectInArgs.push({ column, values });
      return chain;
    });
    chain.select = vi.fn(() => chain);
    chain.upsert = vi.fn((rows: unknown, opts: unknown) => {
      calls.upserts.push({ table, rows, opts });
      return chain;
    });
    chain.insert = vi.fn((rows: unknown) => {
      calls.inserts.push({ table, rows });
      return chain;
    });
    chain.update = vi.fn((values: unknown) => {
      calls.updates.push({ table, values });
      return chain;
    });
    chain.then = (resolve: (r: SelectResult) => unknown) => resolve(result);
    return chain;
  }
  const sb = {
    from: vi.fn((table: string) => builder(table, { data: selectData, error: null })),
  } as unknown as SupabaseClient;
  return { sb, calls };
}

function fakeSource(campaigns: NormalizedCampaign[], spend: NormalizedSpendRow[]): ShopAdSource {
  return {
    fetchCampaigns: vi.fn(async () => campaigns),
    fetchBackfillSpend: vi.fn(async () => spend),
    fetchDailySpend: vi.fn(async () => spend),
  };
}

const cmp = (id: string): NormalizedCampaign => ({
  shop_id: SHOP, platform: "meta", external_id: id, name: "C" + id, status: "active",
  objective: null, daily_budget_cents: null, currency: "USD", geo_targets: [], created_at_source: null,
});
const fact = (id: string, day: string, cents: number): NormalizedSpendRow => ({
  shop_id: SHOP, campaign_external_id: id, platform: "meta", day,
  spend_cents: cents, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0,
});

describe("backfillAds", () => {
  it("upserts campaign dim rows on the platform conflict key", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], []), "meta", SHOP, sb);
    const dim = calls.upserts.find((u) => u.table === "ad_campaign_dim");
    expect(dim?.opts).toEqual({ onConflict: "shop_id,platform,external_id" });
    expect((dim?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      shop_id: SHOP, platform: "meta", external_id: "1",
    });
  });

  it("resolves spend rows to campaign uuids and upserts on campaign_id,day", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], [fact("1", "2026-06-01", 1234)]), "meta", SHOP, sb);
    const f = calls.upserts.find((u) => u.table === "ad_spend_fact");
    expect(f?.opts).toEqual({ onConflict: "campaign_id,day" });
    expect((f?.rows as Array<Record<string, unknown>>)[0]).toMatchObject({
      campaign_id: "u1", day: "2026-06-01", spend_cents: 1234,
    });
  });

  it("scopes the uuid lookup to the given platform", async () => {
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await backfillAds(fakeSource([cmp("1")], [fact("1", "2026-06-01", 1)]), "meta", SHOP, sb);
    expect(calls.selectEqArgs).toContainEqual({ column: "platform", value: "meta" });
  });

  it("skips spend rows for unknown campaigns instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { sb, calls } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await expect(
      backfillAds(fakeSource([cmp("1")], [fact("999", "2026-06-01", 5)]), "meta", SHOP, sb),
    ).resolves.toBeUndefined();
    expect(calls.upserts.find((u) => u.table === "ad_spend_fact")).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown campaign 999"));
    warn.mockRestore();
  });

  it("issues a single batched `in` lookup regardless of row count", async () => {
    const { sb, calls } = makeFakeSupabase([
      { id: "u1", external_id: "1" }, { id: "u2", external_id: "2" },
    ]);
    await backfillAds(
      fakeSource([cmp("1"), cmp("2")], [
        fact("1", "2026-06-01", 1), fact("2", "2026-06-01", 2), fact("1", "2026-06-02", 3),
      ]),
      "meta", SHOP, sb,
    );
    expect(calls.selectInArgs).toHaveLength(1);
    expect(new Set(calls.selectInArgs[0].values as string[])).toEqual(new Set(["1", "2"]));
  });
});

describe("pollAdsDaily", () => {
  it("uses fetchDailySpend for the given day", async () => {
    const src = fakeSource([cmp("1")], [fact("1", "2026-06-05", 7)]);
    const { sb } = makeFakeSupabase([{ id: "u1", external_id: "1" }]);
    await pollAdsDaily(src, "meta", SHOP, sb);
    expect(src.fetchDailySpend).toHaveBeenCalledWith("2026-06-05");
  });
});
```

Note: the `pollAdsDaily` test pins "yesterday". To make it deterministic, the implementation computes yesterday once; in the test, set a fixed clock — add at the top of the `pollAdsDaily` describe:

```ts
import { beforeAll, afterAll } from "vitest";
beforeAll(() => vi.useFakeTimers().setSystemTime(new Date("2026-06-06T00:00:00Z")));
afterAll(() => vi.useRealTimers());
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/ingest.test.ts`
Expected: FAIL — cannot find module `../ingest.server`.

- [ ] **Step 3: Write the generic ingest**

Create `app/lib/ads/ingest.server.ts`:

```ts
// Generic, platform-blind ad ingestion. The extracted core of the original
// google/ingest.server.ts: upsert campaign dims, then resolve spend rows to
// campaign UUIDs via ONE batched `in` lookup (scoped to the platform) and upsert
// facts. Unknown campaigns are skipped with a warning, never thrown (rule 12:
// surfaced, not silent). Source I/O + sync_status bookkeeping live in the
// per-platform adapters and the cron, not here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedCampaign, NormalizedSpendRow, Platform, ShopAdSource } from "./adapter";

function yesterdayISO(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function upsertCampaigns(
  campaigns: NormalizedCampaign[],
  sb: SupabaseClient,
): Promise<void> {
  const dims = campaigns
    .filter((c) => c.external_id)
    .map((c) => ({
      shop_id: c.shop_id,
      platform: c.platform,
      external_id: c.external_id,
      name: c.name,
      status: c.status,
      objective: c.objective,
      daily_budget_cents: c.daily_budget_cents,
      currency: c.currency,
      geo_targets: c.geo_targets,
      created_at_source: c.created_at_source,
      last_synced_at: new Date().toISOString(),
    }));
  if (!dims.length) return;
  const { error } = await sb
    .from("ad_campaign_dim")
    .upsert(dims, { onConflict: "shop_id,platform,external_id" });
  if (error) throw error;
}

async function upsertSpendFacts(
  rows: NormalizedSpendRow[],
  shopId: string,
  platform: Platform,
  sb: SupabaseClient,
): Promise<void> {
  const externalIds = new Set<string>();
  for (const r of rows) if (r.campaign_external_id) externalIds.add(r.campaign_external_id);
  if (externalIds.size === 0) return;

  // Single-batch external_id -> uuid lookup, scoped to this platform. Without
  // this, every spend row would issue its own SELECT.
  const { data: idRows, error: idErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id")
    .eq("shop_id", shopId)
    .eq("platform", platform)
    .in("external_id", [...externalIds]);
  if (idErr) throw idErr;
  const idMap = new Map<string, string>(
    (idRows ?? []).map((r) => [r.external_id as string, r.id as string]),
  );

  const now = new Date().toISOString();
  const factRows: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (!r.campaign_external_id || !r.day) continue;
    const uuid = idMap.get(r.campaign_external_id);
    if (!uuid) {
      console.warn(
        `[ads.ingest] ${platform} spend references unknown campaign ${r.campaign_external_id} for shop ${shopId}, skipping`,
      );
      continue;
    }
    factRows.push({
      shop_id: shopId,
      campaign_id: uuid,
      day: r.day,
      spend_cents: r.spend_cents,
      impressions: r.impressions,
      clicks: r.clicks,
      conversions: r.conversions,
      revenue_attrib_cents: r.revenue_attrib_cents,
      polled_at: now,
    });
  }
  if (!factRows.length) return;
  const { error } = await sb
    .from("ad_spend_fact")
    .upsert(factRows, { onConflict: "campaign_id,day" });
  if (error) throw error;
}

/** Backfill: full campaign list + trailing-window spend for one shop+platform. */
export async function backfillAds(
  source: ShopAdSource,
  platform: Platform,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  await upsertCampaigns(await source.fetchCampaigns(), sb);
  await upsertSpendFacts(await source.fetchBackfillSpend(), shopId, platform, sb);
}

/** Daily poll: refresh campaign state + yesterday's spend for one shop+platform. */
export async function pollAdsDaily(
  source: ShopAdSource,
  platform: Platform,
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  await upsertCampaigns(await source.fetchCampaigns(), sb);
  const day = yesterdayISO();
  await upsertSpendFacts(await source.fetchDailySpend(day), shopId, platform, sb);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/ingest.test.ts`
Expected: PASS (all 6).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/ingest.server.ts app/lib/ads/__tests__/ingest.test.ts
git commit -m "app/lib/ads/ingest: generic platform-blind campaign+spend upsert"
```

---

## Task 4: Refactor Google onto the generic core

**Files:**
- Modify: `app/lib/google/types.ts` (widen `platform`)
- Modify: `app/lib/google/transform.ts` (widen return `platform`)
- Modify: `app/lib/google/ingest.server.ts` (add `googleSource`, make public funcs thin wrappers)
- Test: `app/lib/google/__tests__/ingest.test.ts` (existing — must stay green)

Goal: zero behavior change, prove the core works for the platform that's already live.

- [ ] **Step 1: Widen the Google types to the shared Platform**

In `app/lib/google/types.ts`, replace the two `platform: "google"` literals and the local `CampaignStatus` with imports from the shared contract:

```ts
import type { Platform, CampaignStatus, NormalizedCampaign, NormalizedSpendRow } from "../ads/adapter";

export type AdCampaignDim = NormalizedCampaign;   // produced shape is identical
export type AdSpendFact = NormalizedSpendRow;
export type { Platform, CampaignStatus };
```

Keep the `GoogleCampaignPayload` / `GoogleReportRow` interfaces below unchanged.

- [ ] **Step 2: Fix the transform's platform literal**

In `app/lib/google/transform.ts`, the two object literals already set `platform: "google"`. Because `NormalizedCampaign.platform` is the wider `Platform`, `"google"` still satisfies it — no change needed. Run the transform tests to confirm:

Run: `npx vitest run app/lib/google/__tests__/transform.test.ts`
Expected: PASS (unchanged).

- [ ] **Step 3: Add `googleSource` and rewrite the public functions as wrappers**

In `app/lib/google/ingest.server.ts`, keep the GAQL constants and `yesterdayISO`/`reportGaqlForDay`. Replace the bodies of `backfillGoogle` and `pollGoogleDaily` and the private upsert helpers with a `ShopAdSource` factory delegating to the generic core. Add at the top:

```ts
import { backfillAds, pollAdsDaily } from "../ads/ingest.server";
import type { ShopAdSource } from "../ads/adapter";
```

Then define the source (raw-poll archival is retained):

```ts
/** Build a ShopAdSource over a GoogleAdsClient (campaigns + spend, normalized). */
export function googleSource(
  client: GoogleAdsClient,
  shopId: string,
  sb: SupabaseClient,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const raw = await client.search(CAMPAIGN_GAQL);
      await insertRawPoll(shopId, "campaigns", { data: raw }, sb);
      return (raw as GoogleCampaignPayload[]).map((r) => transformCampaign(r, shopId));
    },
    async fetchBackfillSpend() {
      const raw = await client.search(REPORT_GAQL_90D);
      await insertRawPoll(shopId, "report", { data: raw }, sb);
      return (raw as GoogleReportRow[]).map((r) => transformReportRow(r, shopId));
    },
    async fetchDailySpend(day: string) {
      const raw = await client.search(reportGaqlForDay(day));
      await insertRawPoll(shopId, "report", { data: raw, day }, sb);
      return (raw as GoogleReportRow[]).map((r) => transformReportRow(r, shopId));
    },
  };
}
```

Replace `backfillGoogle` / `pollGoogleDaily` bodies with wrappers that preserve the `sync_status` bookkeeping:

```ts
export async function backfillGoogle(
  client: GoogleAdsClient, shopId: string, sb: SupabaseClient,
): Promise<void> {
  try {
    await backfillAds(googleSource(client, shopId, sb), "google", shopId, sb);
    const now = new Date().toISOString();
    const { error } = await sb.from("shop_integrations")
      .update({ sync_status: "live", sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId).eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    await recordSyncError(shopId, err, sb);
    throw err;
  }
}

export async function pollGoogleDaily(
  client: GoogleAdsClient, shopId: string, sb: SupabaseClient,
): Promise<void> {
  try {
    await pollAdsDaily(googleSource(client, shopId, sb), "google", shopId, sb);
    const now = new Date().toISOString();
    const { error } = await sb.from("shop_integrations")
      .update({ sync_error: null, last_sync_at: now, updated_at: now })
      .eq("shop_id", shopId).eq("kind", "google_ads");
    if (error) throw error;
  } catch (err) {
    await recordSyncError(shopId, err, sb);
    throw err;
  }
}

async function recordSyncError(shopId: string, err: unknown, sb: SupabaseClient): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const now = new Date().toISOString();
  await sb.from("shop_integrations")
    .update({ sync_status: "error", sync_error: message.slice(0, 500), updated_at: now })
    .eq("shop_id", shopId).eq("kind", "google_ads");
}
```

Delete the now-unused private `upsertCampaigns` / `upsertSpendFacts` from this file (they live in the generic core). Keep `insertRawPoll`.

- [ ] **Step 4: Run the existing Google ingest tests**

Run: `npx vitest run app/lib/google/__tests__/ingest.test.ts`
Expected: PASS. The tests call `backfillGoogle(fakeClient, SHOP, sb)`; the wrapper now routes through `googleSource` → `backfillAds`, producing the same `ad_campaign_dim` and `ad_spend_fact` upserts the tests assert. The unknown-campaign test (id 999) still warns + skips because that logic moved verbatim into the core.

- [ ] **Step 5: Run the full module + typecheck**

Run: `npx vitest run app/lib/google app/lib/ads && npm run typecheck`
Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/google app/lib/ads
git commit -m "app/lib/google: route ingest through the generic ads core (no behavior change)"
```

---

## Task 5: Rate-limit backoff utility

**Files:**
- Create: `app/lib/ads/backoff.ts`
- Test: `app/lib/ads/__tests__/backoff.test.ts`

Retries only rate/throttle failures, with exponential backoff + jitter, honoring an explicit `retryAfterMs`. A caller marks an error retryable by throwing a `RateLimitError`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/backoff.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { withRetry, RateLimitError } from "../backoff";

describe("withRetry", () => {
  it("returns the result when the fn succeeds first try", async () => {
    const fn = vi.fn(async () => "ok");
    expect(await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on RateLimitError then succeeds", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 2) throw new RateLimitError("429");
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    expect(await withRetry(fn, { maxAttempts: 5, baseDelayMs: 10, sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("honors retryAfterMs when present", async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      if (n++ < 1) throw new RateLimitError("429", 5000);
      return "ok";
    });
    const sleep = vi.fn(async () => {});
    await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, sleep });
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("does NOT retry non-rate errors", async () => {
    const fn = vi.fn(async () => { throw new Error("boom"); });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }))
      .rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts and rethrows the last rate error", async () => {
    const fn = vi.fn(async () => { throw new RateLimitError("still 429"); });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, sleep: async () => {} }))
      .rejects.toThrow("still 429");
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/backoff.test.ts`
Expected: FAIL — cannot find module `../backoff`.

- [ ] **Step 3: Write the utility**

Create `app/lib/ads/backoff.ts`:

```ts
// Retry helper for ad-platform API calls. Retries ONLY rate-limit/throttle
// failures (surfaced as RateLimitError) with exponential backoff + jitter,
// honoring a server-provided Retry-After when available. Non-rate errors fail
// fast (rule 12: do not mask real failures behind retries).

export class RateLimitError extends Error {
  readonly retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  /** Injectable for tests; defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter in [0,1); defaults to Math.random. */
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RateLimitError)) throw err;
      lastErr = err;
      if (attempt === opts.maxAttempts) break;
      const expo = opts.baseDelayMs * 2 ** (attempt - 1);
      const jitter = Math.floor(random() * opts.baseDelayMs);
      await sleep(err.retryAfterMs ?? expo + jitter);
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/backoff.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/backoff.ts app/lib/ads/__tests__/backoff.test.ts
git commit -m "app/lib/ads/backoff: rate-limit retry with backoff + jitter"
```

---

## Task 6: Bounded concurrency utility

**Files:**
- Create: `app/lib/ads/concurrency.ts`
- Test: `app/lib/ads/__tests__/concurrency.test.ts`

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/concurrency.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapWithConcurrency } from "../concurrency";

describe("mapWithConcurrency", () => {
  it("processes all items and preserves result order", async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--; return n;
    });
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("isolates failures: one rejection does not abort the rest", async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("fail-2");
      return n;
    });
    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]).toMatchObject({ ok: false });
    expect(results[2]).toEqual({ ok: true, value: 3 });
  });
});
```

Note: when the worker can throw, callers want per-item isolation. The utility returns plain values when the worker never rejects, and `Settled<T>` entries when it can. To keep one signature, `mapWithConcurrency` always returns `Settled<T>[]`; adjust the first two tests accordingly:

Replace the first two test bodies' expectations with:
```ts
// test 1
expect(out).toEqual([
  { ok: true, value: 10 }, { ok: true, value: 20 },
  { ok: true, value: 30 }, { ok: true, value: 40 },
]);
// test 2 maps results but only asserts maxActive (unchanged)
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/concurrency.test.ts`
Expected: FAIL — cannot find module `../concurrency`.

- [ ] **Step 3: Write the utility**

Create `app/lib/ads/concurrency.ts`:

```ts
// Bounded-concurrency map with per-item failure isolation. Used by the ingest
// cron so one shop/adapter failure never aborts the rest, and so we never fan
// out into hundreds of simultaneous ad-platform calls (thundering herd).

export type Settled<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export async function mapWithConcurrency<I, T>(
  items: readonly I[],
  limit: number,
  worker: (item: I, index: number) => Promise<T>,
): Promise<Settled<T>[]> {
  const results = new Array<Settled<T>>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length || 1));

  async function run(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { ok: true, value: await worker(items[i], i) };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, run));
  return results;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/ads/__tests__/concurrency.test.ts`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/concurrency.ts app/lib/ads/__tests__/concurrency.test.ts
git commit -m "app/lib/ads/concurrency: bounded-pool map with failure isolation"
```

---

## Task 7: Meta transform (insights → normalized)

**Files:**
- Create: `app/lib/meta/transform.ts`
- Test: `app/lib/meta/__tests__/transform.test.ts`

Meta Insights returns `spend` as a major-unit string (e.g. `"12.34"`), per-campaign per-day when `level=campaign&time_increment=1`. Conversions + revenue come from the `actions` / `action_values` arrays (we read the `purchase`/`omni_purchase` action type). Campaign metadata (`listCampaigns`) is already normalized elsewhere; this transform handles campaign dim + a spend row.

- [ ] **Step 1: Write the failing test**

Create `app/lib/meta/__tests__/transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { metaCampaignToNormalized, metaInsightToSpend } from "../transform";

const SHOP = "00000000-0000-0000-0000-000000000003";

describe("metaCampaignToNormalized", () => {
  it("maps a MetaCampaign to a NormalizedCampaign", () => {
    const out = metaCampaignToNormalized(
      { id: "c1", name: "Spring", status: "ACTIVE", effectiveStatus: "ACTIVE", dailyBudgetCents: 5000 },
      SHOP, "USD",
    );
    expect(out).toMatchObject({
      shop_id: SHOP, platform: "meta", external_id: "c1", name: "Spring",
      status: "active", daily_budget_cents: 5000, currency: "USD",
    });
  });

  it("maps PAUSED/ARCHIVED statuses", () => {
    expect(metaCampaignToNormalized(
      { id: "c2", name: "x", status: "PAUSED", effectiveStatus: "PAUSED", dailyBudgetCents: null }, SHOP, "USD",
    ).status).toBe("paused");
    expect(metaCampaignToNormalized(
      { id: "c3", name: "x", status: "ARCHIVED", effectiveStatus: "ARCHIVED", dailyBudgetCents: null }, SHOP, "USD",
    ).status).toBe("archived");
  });
});

describe("metaInsightToSpend", () => {
  it("converts spend major-units to cents and reads purchase actions/values", () => {
    const out = metaInsightToSpend(
      {
        campaign_id: "c1",
        date_start: "2026-06-01",
        spend: "12.34",
        impressions: "1500",
        clicks: "38",
        actions: [{ action_type: "purchase", value: "4" }],
        action_values: [{ action_type: "purchase", value: "199.95" }],
      },
      SHOP,
    );
    expect(out).toMatchObject({
      shop_id: SHOP, campaign_external_id: "c1", platform: "meta", day: "2026-06-01",
      spend_cents: 1234, impressions: 1500, clicks: 38, conversions: 4, revenue_attrib_cents: 19995,
    });
  });

  it("defaults missing metrics to 0, never NaN", () => {
    const out = metaInsightToSpend({ campaign_id: "c9", date_start: "2026-06-02" }, SHOP);
    expect(out).toMatchObject({ spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/meta/__tests__/transform.test.ts`
Expected: FAIL — cannot find module `../transform`.

- [ ] **Step 3: Write the transform**

Create `app/lib/meta/transform.ts`:

```ts
// Pure transforms for the Meta connector (covers Facebook + Instagram — both ride
// the same ad account / Insights API). Money fields arrive as major-unit strings
// (e.g. "12.34") → cents. Conversions/revenue come from the actions/action_values
// arrays; we read the purchase action types.

import type { NormalizedCampaign, NormalizedSpendRow, CampaignStatus } from "../ads/adapter";
import type { MetaCampaign } from "./campaigns.server";

const PURCHASE_ACTIONS = new Set(["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"]);

function unitsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function toIntOr0(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizeStatus(s: string): CampaignStatus {
  const v = s.toUpperCase();
  if (v === "ACTIVE") return "active";
  if (v === "ARCHIVED" || v === "DELETED") return "archived";
  return "paused";
}

type MetaAction = { action_type?: string; value?: string | number };

export interface MetaInsightRow {
  campaign_id?: string;
  date_start?: string;
  spend?: string | number;
  impressions?: string | number;
  clicks?: string | number;
  actions?: MetaAction[];
  action_values?: MetaAction[];
}

function sumPurchase(actions: MetaAction[] | undefined): number {
  let total = 0;
  for (const a of actions ?? []) {
    if (a.action_type && PURCHASE_ACTIONS.has(a.action_type)) {
      const n = typeof a.value === "number" ? a.value : parseFloat(String(a.value ?? ""));
      if (Number.isFinite(n)) total += n;
    }
  }
  return total;
}

export function metaCampaignToNormalized(
  c: MetaCampaign,
  shopId: string,
  currency: string,
): NormalizedCampaign {
  return {
    shop_id: shopId,
    platform: "meta",
    external_id: c.id,
    name: c.name,
    status: normalizeStatus(c.status),
    objective: null,
    daily_budget_cents: c.dailyBudgetCents,
    currency,
    geo_targets: [],
    created_at_source: null,
  };
}

export function metaInsightToSpend(row: MetaInsightRow, shopId: string): NormalizedSpendRow {
  return {
    shop_id: shopId,
    campaign_external_id: row.campaign_id ?? "",
    platform: "meta",
    day: row.date_start ?? "",
    spend_cents: unitsToCents(row.spend),
    impressions: toIntOr0(row.impressions),
    clicks: toIntOr0(row.clicks),
    conversions: Math.round(sumPurchase(row.actions)),
    revenue_attrib_cents: Math.round(sumPurchase(row.action_values) * 100),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/meta/__tests__/transform.test.ts`
Expected: PASS (all 4).

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/transform.ts app/lib/meta/__tests__/transform.test.ts
git commit -m "app/lib/meta/transform: insights+campaign → normalized rows (FB+IG)"
```

---

## Task 8: Meta insights fetch + adapter

**Files:**
- Create: `app/lib/meta/insights.server.ts`
- Create: `app/lib/meta/ingest.server.ts`
- Test: `app/lib/meta/__tests__/ingest.test.ts`

`metaSourceForShop` resolves credentials from `integration_credentials` (kind `meta_ads`, text token via `crypto.server.ts`) by shop_id, builds a `MetaClient`, and returns a `ShopAdSource`. The `MetaClient.get` calls are wrapped in `withRetry` and translate a Meta rate error (code 4/17/613 or HTTP 429) into `RateLimitError`.

- [ ] **Step 1: Write the failing test (insights fetch + source)**

Create `app/lib/meta/__tests__/ingest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { fetchMetaInsights, makeMetaSource } from "../ingest.server";
import type { MetaClient } from "../campaigns.server";

const SHOP = "00000000-0000-0000-0000-000000000003";
const ACCT = "act_123";

function client(insightsData: unknown[], campaignData: unknown[]): MetaClient {
  return {
    get: vi.fn(async (path: string) => {
      if (path.includes("/insights")) return { data: insightsData };
      return { data: campaignData };
    }),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("fetchMetaInsights", () => {
  it("returns normalized spend rows for the account", async () => {
    const c = client(
      [{ campaign_id: "c1", date_start: "2026-06-01", spend: "10.00", impressions: "100", clicks: "5" }],
      [],
    );
    const rows = await fetchMetaInsights(c, ACCT, SHOP, { datePreset: "last_90d" });
    expect(rows[0]).toMatchObject({ campaign_external_id: "c1", spend_cents: 1000, platform: "meta" });
    expect(c.get).toHaveBeenCalledWith(
      `/${ACCT}/insights`,
      expect.objectContaining({ level: "campaign", time_increment: "1" }),
    );
  });
});

describe("makeMetaSource", () => {
  it("fetchCampaigns maps listCampaigns output with the account currency", async () => {
    const c = client([], [
      { id: "c1", name: "Spring", status: "ACTIVE", effective_status: "ACTIVE", daily_budget: "5000" },
    ]);
    const src = makeMetaSource(c, ACCT, SHOP, "USD");
    const camps = await src.fetchCampaigns();
    expect(camps[0]).toMatchObject({ external_id: "c1", platform: "meta", currency: "USD", daily_budget_cents: 5000 });
  });

  it("fetchDailySpend requests a single-day window", async () => {
    const c = client([{ campaign_id: "c1", date_start: "2026-06-05", spend: "1.00" }], []);
    const src = makeMetaSource(c, ACCT, SHOP, "USD");
    const rows = await src.fetchDailySpend("2026-06-05");
    expect(rows[0]).toMatchObject({ day: "2026-06-05", spend_cents: 100 });
    expect(c.get).toHaveBeenCalledWith(
      `/${ACCT}/insights`,
      expect.objectContaining({ "time_range": JSON.stringify({ since: "2026-06-05", until: "2026-06-05" }) }),
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/meta/__tests__/ingest.test.ts`
Expected: FAIL — cannot find module `../ingest.server`.

- [ ] **Step 3: Write the insights fetch**

Create `app/lib/meta/insights.server.ts`:

```ts
// Meta Insights fetch (campaign level, daily). Covers Facebook + Instagram —
// both placements bill through the same ad account, so account-level insights
// already include IG spend. A publisher_platform breakdown (FB vs IG) is a
// later/UI concern; Slice 1 only needs per-campaign daily spend.

import type { MetaClient, MetaResponse } from "./campaigns.server";
import { metaInsightToSpend, type MetaInsightRow } from "./transform";
import type { NormalizedSpendRow } from "../ads/adapter";
import { RateLimitError } from "../ads/backoff";

const META_RATE_CODES = new Set([4, 17, 32, 613]); // app/user/account rate limits

/** Throw RateLimitError on a Meta throttle so withRetry can back off. */
export function assertNotRateLimited(r: MetaResponse): MetaResponse {
  const code = r.error?.code;
  if (code !== undefined && META_RATE_CODES.has(code)) {
    throw new RateLimitError(`Meta rate limit (code ${code})`);
  }
  return r;
}

export interface InsightsWindow {
  datePreset?: string; // e.g. "last_90d"
  day?: string; // single YYYY-MM-DD
}

export async function fetchMetaInsights(
  client: MetaClient,
  adAccountId: string,
  shopId: string,
  window: InsightsWindow,
): Promise<NormalizedSpendRow[]> {
  const params: Record<string, string> = {
    level: "campaign",
    time_increment: "1",
    fields: "campaign_id,spend,impressions,clicks,actions,action_values",
  };
  if (window.day) {
    params.time_range = JSON.stringify({ since: window.day, until: window.day });
  } else {
    params.date_preset = window.datePreset ?? "last_90d";
  }
  const res = assertNotRateLimited(await client.get(`/${adAccountId}/insights`, params));
  if (res.error) throw new Error(`Meta Insights error: ${res.error.message}`);
  const rows = (res.data as MetaInsightRow[]) ?? [];
  return rows.map((r) => metaInsightToSpend(r, shopId));
}
```

- [ ] **Step 4: Write the adapter/source**

Create `app/lib/meta/ingest.server.ts`:

```ts
// Meta adapter: resolve creds by shop_id from integration_credentials (text
// token, crypto.server.ts), build a MetaClient, expose a ShopAdSource.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { listCampaigns, type MetaClient, type MetaResponse } from "./campaigns.server";
import { metaCampaignToNormalized } from "./transform";
import { fetchMetaInsights } from "./insights.server";
import type { AdPlatformAdapter, ShopAdSource } from "../ads/adapter";
import { withRetry } from "../ads/backoff";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const RETRY = { maxAttempts: 4, baseDelayMs: 500 };

// Re-export for direct unit testing.
export { fetchMetaInsights };

/** Default account currency when the account row doesn't carry one. */
const DEFAULT_CURRENCY = "USD";

export function makeMetaSource(
  client: MetaClient,
  adAccountId: string,
  shopId: string,
  currency: string,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const camps = await withRetry(() => listCampaigns(client, adAccountId), RETRY);
      return camps.map((c) => metaCampaignToNormalized(c, shopId, currency));
    },
    async fetchBackfillSpend() {
      return withRetry(() => fetchMetaInsights(client, adAccountId, shopId, { datePreset: "last_90d" }), RETRY);
    },
    async fetchDailySpend(day: string) {
      return withRetry(() => fetchMetaInsights(client, adAccountId, shopId, { day }), RETRY);
    },
  };
}

function buildClient(token: string): MetaClient {
  return {
    async get(path, params = {}) {
      const qs = new URLSearchParams({ ...params, access_token: token }).toString();
      const res = await fetch(`${GRAPH_BASE}${path}?${qs}`);
      if (res.status === 429) {
        // surfaced as a Meta error code path via the response body; map here too
        return { error: { message: "HTTP 429", code: 4 } } as MetaResponse;
      }
      return (await res.json()) as MetaResponse;
    },
    async post(path, body) {
      const form = new URLSearchParams({ ...body, access_token: token });
      const res = await fetch(`${GRAPH_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      return (await res.json()) as MetaResponse;
    },
  };
}

export const metaAdapter: AdPlatformAdapter = {
  platform: "meta",
  integrationKind: "meta_ads",
  async connect(shopId: string): Promise<ShopAdSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted, external_account_id")
      .eq("shop_id", shopId)
      .eq("kind", "meta_ads")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
    const token = decrypt(data.access_token_encrypted as string);
    const adAccountId = String(data.external_account_id);
    return makeMetaSource(buildClient(token), adAccountId, shopId, DEFAULT_CURRENCY);
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/lib/meta/__tests__/ingest.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add app/lib/meta/insights.server.ts app/lib/meta/ingest.server.ts app/lib/meta/__tests__/ingest.test.ts
git commit -m "app/lib/meta/ingest: insights fetch + adapter (FB+IG spend into ad_spend_fact)"
```

---

## Task 9: TikTok types + transform

**Files:**
- Create: `app/lib/tiktok/types.ts`
- Create: `app/lib/tiktok/transform.ts`
- Test: `app/lib/tiktok/__tests__/transform.test.ts`

TikTok Business "integrated report" returns rows with `dimensions` (`campaign_id`, `stat_time_day`) and `metrics` (`spend`, `impressions`, `clicks`, `conversion`, `total_purchase_value` or `total_complete_payment`). `spend` is a major-unit string. Campaign metadata comes from `/campaign/get/` (`campaign_id`, `campaign_name`, `operation_status`, `budget`).

- [ ] **Step 1: Write the failing test**

Create `app/lib/tiktok/__tests__/transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { tiktokCampaignToNormalized, tiktokReportToSpend } from "../transform";

const SHOP = "00000000-0000-0000-0000-000000000004";

describe("tiktokCampaignToNormalized", () => {
  it("maps a TikTok campaign to NormalizedCampaign with status + budget", () => {
    const out = tiktokCampaignToNormalized(
      { campaign_id: "tk1", campaign_name: "Promo", operation_status: "ENABLE", budget: 50 },
      SHOP, "USD",
    );
    expect(out).toMatchObject({
      shop_id: SHOP, platform: "tiktok", external_id: "tk1", name: "Promo",
      status: "active", daily_budget_cents: 5000, currency: "USD",
    });
  });

  it("maps DISABLE to paused", () => {
    expect(tiktokCampaignToNormalized(
      { campaign_id: "tk2", campaign_name: "x", operation_status: "DISABLE", budget: 0 }, SHOP, "USD",
    ).status).toBe("paused");
  });
});

describe("tiktokReportToSpend", () => {
  it("flattens dimensions+metrics into a normalized spend row in cents", () => {
    const out = tiktokReportToSpend(
      {
        dimensions: { campaign_id: "tk1", stat_time_day: "2026-06-01 00:00:00" },
        metrics: { spend: "12.34", impressions: "1500", clicks: "38", conversion: "4", total_purchase_value: "199.95" },
      },
      SHOP,
    );
    expect(out).toMatchObject({
      shop_id: SHOP, campaign_external_id: "tk1", platform: "tiktok", day: "2026-06-01",
      spend_cents: 1234, impressions: 1500, clicks: 38, conversions: 4, revenue_attrib_cents: 19995,
    });
  });

  it("defaults missing metrics to 0", () => {
    const out = tiktokReportToSpend(
      { dimensions: { campaign_id: "tk9", stat_time_day: "2026-06-02 00:00:00" }, metrics: {} }, SHOP,
    );
    expect(out).toMatchObject({ spend_cents: 0, impressions: 0, clicks: 0, conversions: 0, revenue_attrib_cents: 0 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/tiktok/__tests__/transform.test.ts`
Expected: FAIL — cannot find module `../transform`.

- [ ] **Step 3: Write the types**

Create `app/lib/tiktok/types.ts`:

```ts
// Loose TikTok Business API payload types (proto-ish JSON). Precise optionals,
// never `any` — the documented raw-API-payload exception.

export interface TikTokCampaignPayload {
  campaign_id?: string;
  campaign_name?: string;
  operation_status?: string; // 'ENABLE' | 'DISABLE'
  budget?: string | number;  // major currency units (daily budget)
}

export interface TikTokReportRow {
  dimensions?: {
    campaign_id?: string;
    stat_time_day?: string; // "YYYY-MM-DD HH:MM:SS"
  };
  metrics?: {
    spend?: string | number;
    impressions?: string | number;
    clicks?: string | number;
    conversion?: string | number;
    total_purchase_value?: string | number;
  };
}
```

- [ ] **Step 4: Write the transform**

Create `app/lib/tiktok/transform.ts`:

```ts
// Pure transforms for the TikTok connector. spend/value are major-unit strings →
// cents; stat_time_day is "YYYY-MM-DD HH:MM:SS" → take the date.

import type { NormalizedCampaign, NormalizedSpendRow, CampaignStatus } from "../ads/adapter";
import type { TikTokCampaignPayload, TikTokReportRow } from "./types";

function unitsToCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function toIntOr0(value: string | number | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function normalizeStatus(s: string | undefined): CampaignStatus {
  const v = (s ?? "").toUpperCase();
  if (v === "ENABLE") return "active";
  if (v === "DELETE") return "archived";
  return "paused";
}

export function tiktokCampaignToNormalized(
  c: TikTokCampaignPayload,
  shopId: string,
  currency: string,
): NormalizedCampaign {
  return {
    shop_id: shopId,
    platform: "tiktok",
    external_id: c.campaign_id ?? "",
    name: c.campaign_name ?? "",
    status: normalizeStatus(c.operation_status),
    objective: null,
    daily_budget_cents: c.budget === undefined ? null : unitsToCents(c.budget),
    currency,
    geo_targets: [],
    created_at_source: null,
  };
}

export function tiktokReportToSpend(r: TikTokReportRow, shopId: string): NormalizedSpendRow {
  const day = (r.dimensions?.stat_time_day ?? "").slice(0, 10);
  return {
    shop_id: shopId,
    campaign_external_id: r.dimensions?.campaign_id ?? "",
    platform: "tiktok",
    day,
    spend_cents: unitsToCents(r.metrics?.spend),
    impressions: toIntOr0(r.metrics?.impressions),
    clicks: toIntOr0(r.metrics?.clicks),
    conversions: toIntOr0(r.metrics?.conversion),
    revenue_attrib_cents: unitsToCents(r.metrics?.total_purchase_value),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/lib/tiktok/__tests__/transform.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add app/lib/tiktok/types.ts app/lib/tiktok/transform.ts app/lib/tiktok/__tests__/transform.test.ts
git commit -m "app/lib/tiktok/transform: report+campaign → normalized rows"
```

---

## Task 10: TikTok client + adapter

**Files:**
- Create: `app/lib/tiktok/client.server.ts`
- Create: `app/lib/tiktok/ingest.server.ts`
- Test: `app/lib/tiktok/__tests__/ingest.test.ts`

Same credential model as Meta: `integration_credentials` kind `tiktok_ads`, text token via `crypto.server.ts`, `external_account_id` = TikTok advertiser_id. Calls authenticate with the `Access-Token` header and wrap fetch in `withRetry`, mapping TikTok rate code `40100`/HTTP 429 to `RateLimitError`.

- [ ] **Step 1: Write the failing test**

Create `app/lib/tiktok/__tests__/ingest.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { makeTikTokSource } from "../ingest.server";
import type { TikTokClient } from "../client.server";

const SHOP = "00000000-0000-0000-0000-000000000004";
const ADV = "adv_123";

function client(report: unknown[], campaigns: unknown[]): TikTokClient {
  return {
    getReport: vi.fn(async () => report),
    getCampaigns: vi.fn(async () => campaigns),
  };
}

describe("makeTikTokSource", () => {
  it("fetchCampaigns maps campaign payloads", async () => {
    const c = client([], [{ campaign_id: "tk1", campaign_name: "Promo", operation_status: "ENABLE", budget: 50 }]);
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    const camps = await src.fetchCampaigns();
    expect(camps[0]).toMatchObject({ external_id: "tk1", platform: "tiktok", daily_budget_cents: 5000 });
  });

  it("fetchDailySpend maps a single day's report rows", async () => {
    const c = client(
      [{ dimensions: { campaign_id: "tk1", stat_time_day: "2026-06-05 00:00:00" }, metrics: { spend: "2.00" } }],
      [],
    );
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    const rows = await src.fetchDailySpend("2026-06-05");
    expect(rows[0]).toMatchObject({ day: "2026-06-05", spend_cents: 200, platform: "tiktok" });
    expect(c.getReport).toHaveBeenCalledWith(ADV, "2026-06-05", "2026-06-05");
  });

  it("fetchBackfillSpend requests a ~90-day window ending today", async () => {
    vi.useFakeTimers().setSystemTime(new Date("2026-06-06T00:00:00Z"));
    const c = client([], []);
    const src = makeTikTokSource(c, ADV, SHOP, "USD");
    await src.fetchBackfillSpend();
    expect(c.getReport).toHaveBeenCalledWith(ADV, "2026-03-08", "2026-06-06");
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/tiktok/__tests__/ingest.test.ts`
Expected: FAIL — cannot find module `../ingest.server`.

- [ ] **Step 3: Write the client**

Create `app/lib/tiktok/client.server.ts`:

```ts
// fetch-based TikTok Business API client. Testable surface (getReport/getCampaigns)
// behind an interface so ingest is unit-testable with a fake. Rate errors
// (HTTP 429 or body code 40100) become RateLimitError for withRetry.

import type { TikTokCampaignPayload, TikTokReportRow } from "./types";
import { RateLimitError } from "../ads/backoff";

const API_BASE = "https://business-api.tiktok.com/open_api/v1.3";

export interface TikTokClient {
  getReport(advertiserId: string, since: string, until: string): Promise<TikTokReportRow[]>;
  getCampaigns(advertiserId: string): Promise<TikTokCampaignPayload[]>;
}

type TikTokEnvelope = { code?: number; message?: string; data?: { list?: unknown[] } };

function unwrap(body: TikTokEnvelope, what: string): unknown[] {
  if (body.code === 40100 || body.code === 40016) throw new RateLimitError(`TikTok rate limit (code ${body.code})`);
  if (body.code !== 0 && body.code !== undefined) throw new Error(`TikTok ${what} error: ${body.message ?? body.code}`);
  return body.data?.list ?? [];
}

export function buildTikTokClient(token: string): TikTokClient {
  async function call(path: string, params: Record<string, string>): Promise<TikTokEnvelope> {
    const qs = new URLSearchParams(params).toString();
    const res = await fetch(`${API_BASE}${path}?${qs}`, { headers: { "Access-Token": token } });
    if (res.status === 429) throw new RateLimitError("TikTok HTTP 429");
    return (await res.json()) as TikTokEnvelope;
  }
  return {
    async getReport(advertiserId, since, until) {
      const body = await call("/report/integrated/get/", {
        advertiser_id: advertiserId,
        report_type: "BASIC",
        data_level: "AUCTION_CAMPAIGN",
        dimensions: JSON.stringify(["campaign_id", "stat_time_day"]),
        metrics: JSON.stringify(["spend", "impressions", "clicks", "conversion", "total_purchase_value"]),
        start_date: since,
        end_date: until,
        page_size: "1000",
      });
      return unwrap(body, "report") as TikTokReportRow[];
    },
    async getCampaigns(advertiserId) {
      const body = await call("/campaign/get/", { advertiser_id: advertiserId, page_size: "1000" });
      return unwrap(body, "campaign") as TikTokCampaignPayload[];
    },
  };
}
```

- [ ] **Step 4: Write the adapter/source**

Create `app/lib/tiktok/ingest.server.ts`:

```ts
// TikTok adapter: creds from integration_credentials (kind tiktok_ads, text token
// via crypto.server.ts), advertiser_id from external_account_id. Exposes a
// ShopAdSource over a TikTokClient.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../supabase.server";
import { decrypt } from "../crypto.server";
import { buildTikTokClient, type TikTokClient } from "./client.server";
import { tiktokCampaignToNormalized, tiktokReportToSpend } from "./transform";
import type { AdPlatformAdapter, ShopAdSource } from "../ads/adapter";
import { withRetry } from "../ads/backoff";

const RETRY = { maxAttempts: 4, baseDelayMs: 500 };
const DEFAULT_CURRENCY = "USD";

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

export function makeTikTokSource(
  client: TikTokClient,
  advertiserId: string,
  shopId: string,
  currency: string,
): ShopAdSource {
  return {
    async fetchCampaigns() {
      const camps = await withRetry(() => client.getCampaigns(advertiserId), RETRY);
      return camps.map((c) => tiktokCampaignToNormalized(c, shopId, currency));
    },
    async fetchBackfillSpend() {
      const rows = await withRetry(() => client.getReport(advertiserId, daysAgoISO(90), todayISO()), RETRY);
      return rows.map((r) => tiktokReportToSpend(r, shopId));
    },
    async fetchDailySpend(day: string) {
      const rows = await withRetry(() => client.getReport(advertiserId, day, day), RETRY);
      return rows.map((r) => tiktokReportToSpend(r, shopId));
    },
  };
}

export const tiktokAdapter: AdPlatformAdapter = {
  platform: "tiktok",
  integrationKind: "tiktok_ads",
  async connect(shopId: string): Promise<ShopAdSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted, external_account_id")
      .eq("shop_id", shopId)
      .eq("kind", "tiktok_ads")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted || !data.external_account_id) return null;
    const token = decrypt(data.access_token_encrypted as string);
    return makeTikTokSource(buildTikTokClient(token), String(data.external_account_id), shopId, DEFAULT_CURRENCY);
  },
};
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run app/lib/tiktok/__tests__/ingest.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Commit**

```bash
git add app/lib/tiktok/client.server.ts app/lib/tiktok/ingest.server.ts app/lib/tiktok/__tests__/ingest.test.ts
git commit -m "app/lib/tiktok/ingest: client + adapter (spend into ad_spend_fact)"
```

---

## Task 11: Constant-time cron auth helper

**Files:**
- Create: `app/lib/cron-auth.server.ts`
- Test: `app/lib/__tests__/cron-auth.test.ts`

The existing `cron.google.tsx` used a plain `!==` compare. The spec requires a constant-time comparison (parity with the engine's `fcc96ec` hardening).

- [ ] **Step 1: Write the failing test**

Create `app/lib/__tests__/cron-auth.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAuthorizedCron } from "../cron-auth.server";

describe("isAuthorizedCron", () => {
  it("accepts the exact bearer secret", () => {
    expect(isAuthorizedCron(`Bearer s3cret`, "s3cret")).toBe(true);
  });
  it("rejects a wrong secret", () => {
    expect(isAuthorizedCron(`Bearer nope`, "s3cret")).toBe(false);
  });
  it("rejects a missing header", () => {
    expect(isAuthorizedCron(null, "s3cret")).toBe(false);
  });
  it("rejects when the configured secret is empty", () => {
    expect(isAuthorizedCron(`Bearer `, "")).toBe(false);
  });
  it("rejects a length-mismatched header without throwing", () => {
    expect(isAuthorizedCron(`Bearer short`, "a-much-longer-secret")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/__tests__/cron-auth.test.ts`
Expected: FAIL — cannot find module `../cron-auth.server`.

- [ ] **Step 3: Write the helper**

Create `app/lib/cron-auth.server.ts`:

```ts
// Constant-time bearer check for cron endpoints. Mirrors the engine's hardening
// (commit fcc96ec): compare with timingSafeEqual over equal-length buffers, and
// fail closed when the secret is unset.

import { timingSafeEqual } from "node:crypto";

export function isAuthorizedCron(authHeader: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  if (!authHeader) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(authHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false; // length itself isn't secret
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/__tests__/cron-auth.test.ts`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add app/lib/cron-auth.server.ts app/lib/__tests__/cron-auth.test.ts
git commit -m "app/lib/cron-auth: constant-time bearer check for cron endpoints"
```

---

## Task 12: Adapter registry

**Files:**
- Create: `app/lib/ads/registry.server.ts`
- Test: `app/lib/ads/__tests__/registry.test.ts`

`adaptersForShops` reads `shop_integrations` for the three ad kinds in (`pending`,`live`) and returns a flat work list of `{ shopId, status, adapter }`, ready for the concurrency pool. Pure mapping over a fake Supabase result keeps it testable.

- [ ] **Step 1: Write the failing test**

Create `app/lib/ads/__tests__/registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { adaptersForShops, AD_ADAPTERS } from "../registry.server";

function sbReturning(rows: Array<Record<string, unknown>>) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.in = vi.fn(() => chain);
  chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
    resolve({ data: rows, error: null });
  return { from: vi.fn(() => chain) } as unknown as SupabaseClient;
}

describe("AD_ADAPTERS", () => {
  it("registers exactly meta, google, tiktok", () => {
    expect(AD_ADAPTERS.map((a) => a.platform).sort()).toEqual(["google", "meta", "tiktok"]);
  });
});

describe("adaptersForShops", () => {
  it("pairs each integration row with its adapter", async () => {
    const sb = sbReturning([
      { shop_id: "s1", kind: "meta_ads", sync_status: "pending" },
      { shop_id: "s1", kind: "google_ads", sync_status: "live" },
      { shop_id: "s2", kind: "tiktok_ads", sync_status: "live" },
    ]);
    const work = await adaptersForShops(sb);
    expect(work).toHaveLength(3);
    expect(work[0]).toMatchObject({ shopId: "s1", status: "pending" });
    expect(work[0].adapter.platform).toBe("meta");
    expect(work.find((w) => w.shopId === "s2")?.adapter.platform).toBe("tiktok");
  });

  it("ignores rows whose kind has no registered adapter", async () => {
    const sb = sbReturning([{ shop_id: "s1", kind: "quickbooks", sync_status: "live" }]);
    expect(await adaptersForShops(sb)).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/registry.test.ts`
Expected: FAIL — cannot find module `../registry.server`.

- [ ] **Step 3: Write the registry**

Create `app/lib/ads/registry.server.ts`:

```ts
// Maps connected shop_integrations rows to the adapter that should run for them.
// One place that knows the full adapter set; the cron stays platform-blind.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AdPlatformAdapter } from "./adapter";
import { metaAdapter } from "../meta/ingest.server";
import { googleAdapter } from "../google/ingest.server";
import { tiktokAdapter } from "../tiktok/ingest.server";

export const AD_ADAPTERS: AdPlatformAdapter[] = [metaAdapter, googleAdapter, tiktokAdapter];

const BY_KIND = new Map(AD_ADAPTERS.map((a) => [a.integrationKind, a]));

export interface AdWorkItem {
  shopId: string;
  status: string; // 'pending' | 'live'
  adapter: AdPlatformAdapter;
}

export async function adaptersForShops(sb: SupabaseClient): Promise<AdWorkItem[]> {
  const { data, error } = await sb
    .from("shop_integrations")
    .select("shop_id, kind, sync_status")
    .in("kind", ["meta_ads", "google_ads", "tiktok_ads"])
    .in("sync_status", ["pending", "live"]);
  if (error) throw error;
  const work: AdWorkItem[] = [];
  for (const row of data ?? []) {
    const adapter = BY_KIND.get(String(row.kind));
    if (!adapter) continue;
    work.push({ shopId: String(row.shop_id), status: String(row.sync_status), adapter });
  }
  return work;
}
```

- [ ] **Step 4: Add `googleAdapter` to the Google module**

`registry.server.ts` imports `googleAdapter`, which does not exist yet. In `app/lib/google/ingest.server.ts`, add it (it resolves a client via the existing `googleClientForShop`, then wraps `googleSource`). Add near the top:

```ts
import { googleClientForShop } from "./client.server";
import type { AdPlatformAdapter, ShopAdSource } from "../ads/adapter";
```

and at the bottom:

```ts
export const googleAdapter: AdPlatformAdapter = {
  platform: "google",
  integrationKind: "google_ads",
  async connect(shopId: string): Promise<ShopAdSource | null> {
    const conn = await googleClientForShop(shopId);
    if (!conn) return null;
    return googleSource(conn.client, shopId, getSupabase());
  },
};
```

Add `import { getSupabase } from "../supabase.server";` if not already present.

- [ ] **Step 5: Run the tests + typecheck**

Run: `npx vitest run app/lib/ads/__tests__/registry.test.ts && npm run typecheck`
Expected: PASS, tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/ads/registry.server.ts app/lib/ads/__tests__/registry.test.ts app/lib/google/ingest.server.ts
git commit -m "app/lib/ads/registry: map integration rows to platform adapters"
```

---

## Task 13: Unified `cron.ingest-ads` route

**Files:**
- Create: `app/routes/cron.ingest-ads.tsx`
- Delete: `app/routes/cron.google.tsx`
- Test: `app/routes/__tests__/cron.ingest-ads.test.ts`

Loops the work list with bounded concurrency; per item: `connect()` → backfill (status `pending`) or daily poll (status `live`); updates `sync_status` to `live`/`error`; per-item failures isolated by `mapWithConcurrency`.

- [ ] **Step 1: Write the failing test**

Create `app/routes/__tests__/cron.ingest-ads.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const adaptersForShops = vi.fn();
const backfillAds = vi.fn(async () => {});
const pollAdsDaily = vi.fn(async () => {});
const updateSync = vi.fn(async () => {});

vi.mock("~/lib/ads/registry.server", () => ({ adaptersForShops }));
vi.mock("~/lib/ads/ingest.server", () => ({ backfillAds, pollAdsDaily }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({ update: () => ({ eq: () => ({ eq: () => { updateSync(); return Promise.resolve({ error: null }); } }) }) }),
  }),
}));

import { loader } from "../cron.ingest-ads";

function req(auth?: string): Request {
  const headers = new Headers();
  if (auth) headers.set("authorization", auth);
  return new Request("http://x/cron/ingest-ads", { headers });
}

describe("cron.ingest-ads loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects an unauthorized request", async () => {
    const res = await loader({ request: req("Bearer wrong") } as never);
    expect(res.status).toBe(401);
  });

  it("backfills pending and polls live, isolating failures", async () => {
    const source = { fetchCampaigns: vi.fn(), fetchBackfillSpend: vi.fn(), fetchDailySpend: vi.fn() };
    adaptersForShops.mockResolvedValue([
      { shopId: "s1", status: "pending", adapter: { platform: "meta", integrationKind: "meta_ads", connect: async () => source } },
      { shopId: "s2", status: "live", adapter: { platform: "tiktok", integrationKind: "tiktok_ads", connect: async () => source } },
      { shopId: "s3", status: "live", adapter: { platform: "google", integrationKind: "google_ads", connect: async () => { throw new Error("boom"); } } },
    ]);
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(backfillAds).toHaveBeenCalledTimes(1);
    expect(pollAdsDaily).toHaveBeenCalledTimes(1);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toContain("s3");
  });

  it("skips shops with no connection", async () => {
    adaptersForShops.mockResolvedValue([
      { shopId: "s4", status: "live", adapter: { platform: "meta", integrationKind: "meta_ads", connect: async () => null } },
    ]);
    const res = await loader({ request: req("Bearer s3cret") } as never);
    const body = await res.json();
    expect(body.skipped).toContain("s4:meta");
    expect(pollAdsDaily).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/routes/__tests__/cron.ingest-ads.test.ts`
Expected: FAIL — cannot find module `../cron.ingest-ads`.

- [ ] **Step 3: Write the route**

Create `app/routes/cron.ingest-ads.tsx`:

```ts
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { adaptersForShops, type AdWorkItem } from "~/lib/ads/registry.server";
import { backfillAds, pollAdsDaily } from "~/lib/ads/ingest.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";

const CONCURRENCY = 4; // bounded fan-out across shops × adapters

async function setSync(shopId: string, kind: string, patch: Record<string, unknown>): Promise<void> {
  const sb = getSupabase();
  const now = new Date().toISOString();
  await sb
    .from("shop_integrations")
    .update({ ...patch, updated_at: now })
    .eq("shop_id", shopId)
    .eq("kind", kind);
}

async function runOne(item: AdWorkItem, summary: Summary): Promise<void> {
  const { shopId, status, adapter } = item;
  const tag = `${shopId}:${adapter.platform}`;
  const sb = getSupabase();
  const source = await adapter.connect(shopId);
  if (!source) {
    summary.skipped.push(tag);
    return;
  }
  const now = new Date().toISOString();
  try {
    if (status === "pending") {
      await backfillAds(source, adapter.platform, shopId, sb);
      await setSync(shopId, adapter.integrationKind, { sync_status: "live", sync_error: null, last_sync_at: now });
      summary.backfilled.push(tag);
    } else {
      await pollAdsDaily(source, adapter.platform, shopId, sb);
      await setSync(shopId, adapter.integrationKind, { sync_error: null, last_sync_at: now });
      summary.polled.push(tag);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await setSync(shopId, adapter.integrationKind, { sync_status: "error", sync_error: message.slice(0, 500) });
    throw err; // re-thrown into the isolated pool slot; recorded below
  }
}

interface Summary {
  backfilled: string[];
  polled: string[];
  skipped: string[];
  errors: string[];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sb = getSupabase();
  const work = await adaptersForShops(sb);
  const summary: Summary = { backfilled: [], polled: [], skipped: [], errors: [] };

  const settled = await mapWithConcurrency(work, CONCURRENCY, (item) => runOne(item, summary));
  settled.forEach((r, i) => {
    if (!r.ok) {
      const item = work[i];
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${item.shopId}:${item.adapter.platform}: ${message}`);
      console.error(`[cron.ingest-ads] sync failed for ${item.shopId}:${item.adapter.platform}`, r.error);
    }
  });

  return json(summary);
};
```

- [ ] **Step 4: Delete the old Google cron**

```bash
git rm app/routes/cron.google.tsx
```

- [ ] **Step 5: Update the Vercel cron schedule**

In `vercel.json`, replace the `/cron/google` entry with `/cron/ingest-ads` (same schedule). If no `crons` entry exists for google, add one for `ingest-ads` daily. Verify with:

Run: `npx vitest run app/routes/__tests__/cron.ingest-ads.test.ts`
Expected: PASS (all 3).

- [ ] **Step 6: Grep for stale references**

Run: `git grep -n "cron.google\|cron/google\|backfillGoogle\|pollGoogleDaily" -- app vercel.json`
Expected: only the internal `backfillGoogle`/`pollGoogleDaily` wrappers in `app/lib/google/ingest.server.ts` and their tests remain; no route references to `cron.google`.

- [ ] **Step 7: Commit**

```bash
git add app/routes/cron.ingest-ads.tsx app/routes/__tests__/cron.ingest-ads.test.ts vercel.json
git commit -m "routes/cron.ingest-ads: unified bounded-concurrency ad ingest; remove cron.google"
```

---

## Task 14: Env keys + full pre-commit gate

**Files:**
- Modify: `.env.example`

Per CLAUDE.md, new env keys must be documented and the full eval pipeline must pass before this slice is considered done.

- [ ] **Step 1: Document TikTok env keys**

Add to `.env.example` (least-privilege note inline):

```
# TikTok Marketing API (Slice 1 ad ingestion). App must request only the
# advertiser read scopes needed for reporting + campaign read.
TIKTOK_APP_ID=
TIKTOK_APP_SECRET=
```

(Meta + Google keys already exist: `META_APP_ID`/`META_APP_SECRET`, `GOOGLE_ADS_*`. `INTEGRATION_ENCRYPTION_KEY` and `CRON_SECRET` already documented.)

- [ ] **Step 2: Run the full eval pipeline (CLAUDE.md pre-commit gate)**

Run each, in order, and paste results (do not assert success without evidence):

```bash
npm run typecheck
npm run lint
npm run build
npx vitest run app/lib/ads app/lib/meta app/lib/google app/lib/tiktok app/routes/__tests__/cron.ingest-ads.test.ts
```

Expected: typecheck exit 0; lint exit 0 (no warnings on touched files); build completes; all vitest suites green.

- [ ] **Step 3: Run `/code-review` on the working tree**

Resolve every blocker; downgrade nits explicitly with a one-line justification.

- [ ] **Step 4: Patch sanity**

```bash
git diff --stat
git diff --check
```

Expected: no whitespace errors; no stray `console.log` (the `console.warn`/`console.error` in ingest + cron are intentional, documented surfacing per rule 12), no `.only`, no `TODO(me)`.

- [ ] **Step 5: Commit**

```bash
git add .env.example
git commit -m "env: document TikTok Marketing API keys for ad ingestion"
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --head calderyn/ad-campaign-integrations \
  --title "Ad campaign integrations — Slice 1: data flowing (adapter + Meta/Google/TikTok ingest)" \
  --body "Implements Slice 1 of docs/superpowers/specs/2026-06-06-ad-campaign-integrations-design.md: shared AdPlatformAdapter contract, generic ingest core, Google refactored onto it, Meta (FB+IG) + TikTok adapters, unified cron.ingest-ads with bounded concurrency + 429 backoff + constant-time auth, tiktok enum migration."
```

---

## Self-Review Notes

- **Spec coverage (Slice 1 bullets):** adapter contract → T2; refactor Google → T4; Meta poller→ingest (FB+IG) → T7/T8; TikTok adapter+ingest → T9/T10; `tiktok` enum → T1; collapse cron.google→cron.ingest-ads (shops×adapters) → T13; bounded concurrency → T6/T13; 429 backoff+jitter → T5 (used in T8/T10 clients); metadata caching → handled by re-poll scoping (daily poll only refetches yesterday + current campaign state, not full history) per the generic core in T3; TikTok encrypted creds + least-privilege scopes → T10 + T14; constant-time cron auth → T11/T13.
- **Type consistency:** `NormalizedCampaign`/`NormalizedSpendRow`/`ShopAdSource`/`Platform`/`IntegrationKind` defined in T2 are the exact names imported in T3–T13. Google's `AdCampaignDim`/`AdSpendFact` are re-aliased to the shared types in T4. `backfillAds(source, platform, shopId, sb)` / `pollAdsDaily(...)` signatures are identical across T3, T4, T13. `withRetry(fn, {maxAttempts, baseDelayMs})` and `RateLimitError` (T5) are used unchanged in T8/T10. `mapWithConcurrency(items, limit, worker)` → `Settled<T>[]` (T6) matches T13 usage. `isAuthorizedCron(header, secret)` (T11) matches T13.
- **Caching note:** "metadata caching" in the spec is satisfied by not re-fetching the 90-day history on every tick (daily poll = yesterday only) plus the existing in-process `shopIdCache`. If a stronger campaign-metadata cache is wanted, it is a follow-up, not a Slice 1 blocker.
