# Weather Demand Signal (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-home the existing weather feature onto the alert/deck/calibration spine: add a fully outcome-gated weather inventory-restock nudge, give the weather ad move deck visibility with human approval, and retire the bespoke `weather_suggestion` path.

**Architecture:** A daily cron computes region weather favorability (existing score, unchanged) and emits `weather_demand` alerts through a Postgres RPC that mirrors the engine's canonical alert upsert. Two consumers: `reallocate_inventory` (rides the fully-existing inventory execution + reward path, becomes an autopilot candidate) and `reallocate_budget` (evidence-gated deck approval calling the existing `executeReallocation`, human-only this phase). Autonomous ad reallocation is deferred to Phase 1b.

**Tech Stack:** Remix (Vite) + TypeScript strict, Supabase Postgres (RLS, service-role writes), Vitest, existing `app/lib/weather/*`, `app/lib/actions/*`, calibration engine.

## Global Constraints

- TypeScript only; no `any` without written justification; `tsc --noEmit` authoritative.
- `.server.ts` files are server-only; never import from a client module.
- Every dashboard route/API goes through `requireDashboardSession(request)` and `requireSameOrigin` for writes; tenant comes from the session, never the body.
- No browser-visible AI/provenance markers; no dev overlays; `build.sourcemap` stays off.
- New detector must register in `DetectorId` (types.ts), `DETECTOR_TO_ACTIONS`, `DETECTOR_LABELS`, `DETECTOR_TERMS` (labels.ts) or its card falls back to a humanized label + snooze-only and is excluded from the calibration weight universe.
- Alert writes must match the canonical column set in `engine/calderyn_engine/alerts_repo.py`: `alerts(shop_id, detector_id, entity_ref, severity, dollar_impact, day_bucket, claude_narrative, claude_rank)` + separate `alert_context(alert_id, shop_id, evidence)`; dedup on the partial index `(shop_id, detector_id, entity_ref) WHERE status IN ('open','acknowledged','snoozed')`.
- SQL migrations are checked in and applied to prod via the supabase MCP; views use `security_invoker`.
- Pre-commit gate before any major commit: `/code-review`, `git diff --check`, `npm run typecheck`, `npm run lint` (`--max-warnings=0` on new code), `npm run build`, `npx prisma validate` if schema changed. Never `--no-verify`.
- `GRADUATABLE` and `HAS_UNDO_BRANCH` are keyed by `ActionKind` and already include `reallocate_inventory` and `reallocate_budget`; do NOT edit them.
- Reward (`action_audit.reward_signal`) computes ONLY for `actor_user_id='autopilot' AND outcome='succeeded'`. Merchant approvals earn trust signals, not dollar rewards — this is the Phase 1 boundary for the ad mover.

---

## File Structure

**Create:**
- `supabase/migrations/<ts>_weather_demand_alert_rpc.sql` — `upsert_weather_alert(...)` RPC (canonical alert + context upsert callable from TS).
- `supabase/migrations/<ts>_autopilot_candidates_weather.sql` — `create or replace view v_autopilot_candidates` adding `weather_demand`.
- `app/lib/weather/reallocation-plan.ts` — pure `hasReallocationPlan()` / `reallocationPlanFromEvidence()` (budget analog of `transferPlanFromEvidence`).
- `app/lib/weather/inventory-signal.ts` — pure: map a `v_sku_regional_demand` row + region favorability → an inventory `WeatherAlertDraft` or null.
- `app/lib/weather/alert-writer.server.ts` — `writeWeatherAlert(sb, draft)` calling the RPC.
- `app/lib/weather/drafts.ts` — the shared `WeatherAlertDraft` type + `entityRef`/`evidence` builders.
- Tests alongside each under `app/lib/weather/__tests__/`.

**Modify:**
- `app/lib/types.ts` — add `weather_demand` to `DetectorId`.
- `app/lib/labels.ts` — `DETECTOR_TO_ACTIONS`, `DETECTOR_LABELS`, `DETECTOR_TERMS`.
- `app/lib/actions/autopilot.server.ts` — add `weather_demand` to `INVENTORY_RELOCATION_DETECTORS`.
- `app/lib/dashboard/one-click.ts` — evidence-gated `reallocate_budget` one-click.
- `app/routes/dashboard.api.alerts.$id.action.tsx` — `reallocate_budget` branch (evidence → `executeReallocation`).
- `app/lib/actions/weather-suggest.server.ts` — refactor `runWeatherSuggestForShop` to build drafts (ad + inventory) and write alerts instead of `weather_suggestion`.
- `app/routes/cron.weather-suggest.tsx` — unchanged shape; now drains via the refactored runner.

**Delete / retire:**
- `app/routes/dashboard.api.weather-reallocation.tsx`.
- Customers → Weather tab + `WeatherSuggestionDTO` usage in `app/components/dashboard/screens/Customers.tsx`, `loadWeatherSuggestions` in `app/routes/dashboard.api.customers._index.tsx`, and the client wrapper `applyWeatherSuggestion`.

---

## Task 1: `upsert_weather_alert` RPC migration

**Files:**
- Create: `supabase/migrations/<ts>_weather_demand_alert_rpc.sql`

**Interfaces:**
- Produces: SQL function `public.upsert_weather_alert(p_shop_id uuid, p_detector_id text, p_entity_ref jsonb, p_severity text, p_dollar_impact numeric, p_day_bucket date, p_narrative text, p_rank int, p_evidence jsonb) returns uuid` — one alert + one alert_context row, dedup-correct, returns the alert id.

- [ ] **Step 1: Write the migration SQL**

```sql
-- Canonical weather-alert upsert callable from the TS cron. Mirrors
-- engine/calderyn_engine/alerts_repo.py exactly: the alerts upsert targets the
-- partial unique index alerts_active_condition_key (active statuses only), which
-- PostgREST .upsert() cannot address, so we expose it as a SECURITY DEFINER
-- function the service role calls via sb.rpc(). One alert row + one alert_context
-- row, returning the alert id.
create or replace function public.upsert_weather_alert(
  p_shop_id uuid,
  p_detector_id text,
  p_entity_ref jsonb,
  p_severity text,
  p_dollar_impact numeric,
  p_day_bucket date,
  p_narrative text,
  p_rank int,
  p_evidence jsonb
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_alert_id uuid;
begin
  insert into alerts (
    shop_id, detector_id, entity_ref, severity,
    dollar_impact, day_bucket, claude_narrative, claude_rank,
    first_seen_at, last_seen_at
  )
  values (
    p_shop_id, p_detector_id, p_entity_ref, p_severity::alert_severity,
    p_dollar_impact, p_day_bucket, p_narrative, p_rank, now(), now()
  )
  on conflict (shop_id, detector_id, entity_ref)
    where status in ('open','acknowledged','snoozed')
  do update set
    dollar_impact    = excluded.dollar_impact,
    severity         = excluded.severity,
    claude_narrative = excluded.claude_narrative,
    claude_rank      = excluded.claude_rank,
    day_bucket       = excluded.day_bucket,
    last_seen_at     = now(),
    status = case when alerts.status = 'acknowledged'
                  then 'open'::alert_status else alerts.status end
  returning id into v_alert_id;

  insert into alert_context (alert_id, shop_id, evidence)
  values (v_alert_id, p_shop_id, p_evidence)
  on conflict (alert_id) do update set evidence = excluded.evidence;

  return v_alert_id;
end;
$$;

revoke all on function public.upsert_weather_alert(
  uuid, text, jsonb, text, numeric, date, text, int, jsonb
) from public, anon, authenticated;
```

- [ ] **Step 2: Apply the migration to the dev/prod project via the supabase MCP**

Use `mcp__supabase__apply_migration` with name `weather_demand_alert_rpc` and the SQL above. Expected: success, no error. Then `mcp__supabase__list_migrations` shows it.

- [ ] **Step 3: Smoke the function**

Run via `mcp__supabase__execute_sql`:
```sql
select public.upsert_weather_alert(
  (select id from shops limit 1),
  'weather_demand',
  '{"campaign_id":"00000000-0000-0000-0000-000000000000","title":"smoke"}'::jsonb,
  'medium', 0, current_date, 'smoke narrative', 50, '{"k":"v"}'::jsonb
);
```
Expected: returns a uuid; a matching `alerts` + `alert_context` row exist. Then delete the smoke row:
```sql
delete from alerts where detector_id='weather_demand' and claude_narrative='smoke narrative';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/*_weather_demand_alert_rpc.sql
git commit -m "weather: add upsert_weather_alert RPC mirroring engine alerts_repo"
```

---

## Task 2: Register the `weather_demand` detector

**Files:**
- Modify: `app/lib/types.ts:26-46` (DetectorId union)
- Modify: `app/lib/labels.ts:6-27` (DETECTOR_LABELS), `:31-52` (DETECTOR_TERMS), `:409-434` (DETECTOR_TO_ACTIONS)
- Test: `app/lib/__tests__/labels.weather.test.ts` (create)

**Interfaces:**
- Produces: `DetectorId` now includes `"weather_demand"`; `DETECTOR_TO_ACTIONS.weather_demand = ["reallocate_inventory","reallocate_budget","snooze_alert"]`.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/__tests__/labels.weather.test.ts
import { describe, it, expect } from "vitest";
import { DETECTOR_TO_ACTIONS, DETECTOR_LABELS, DETECTOR_TERMS } from "../labels";

describe("weather_demand registration", () => {
  it("maps to inventory + budget actions and snooze", () => {
    expect(DETECTOR_TO_ACTIONS.weather_demand).toEqual([
      "reallocate_inventory",
      "reallocate_budget",
      "snooze_alert",
    ]);
  });
  it("has a plain label and a jargon term", () => {
    expect(DETECTOR_LABELS.weather_demand).toBeTruthy();
    expect(DETECTOR_TERMS.weather_demand).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run app/lib/__tests__/labels.weather.test.ts`. Expected: TS/type error or property missing.

- [ ] **Step 3: Add `weather_demand` to the `DetectorId` union in `app/lib/types.ts`** (append after `"missing_cost"`):

```ts
  | "missing_cost"
  | "weather_demand";
```

- [ ] **Step 4: Add the three label/action entries in `app/lib/labels.ts`.**

In `DETECTOR_LABELS`:
```ts
  weather_demand: "Weather is shifting demand between regions",
```
In `DETECTOR_TERMS`:
```ts
  weather_demand: "Weather demand signal",
```
In `DETECTOR_TO_ACTIONS`:
```ts
  weather_demand: ["reallocate_inventory", "reallocate_budget", "snooze_alert"],
```

- [ ] **Step 5: Run tests + typecheck** — `npx vitest run app/lib/__tests__/labels.weather.test.ts` (PASS) and `npm run typecheck` (exit 0; this surfaces any other `Record<DetectorId, ...>` maps that now need a `weather_demand` key — add a sensible entry to each the compiler flags).

- [ ] **Step 6: Commit**

```bash
git add app/lib/types.ts app/lib/labels.ts app/lib/__tests__/labels.weather.test.ts
git commit -m "weather: register weather_demand detector (id, labels, actions)"
```

---

## Task 3: `WeatherAlertDraft` type + evidence/entity_ref builders

**Files:**
- Create: `app/lib/weather/drafts.ts`
- Test: `app/lib/weather/__tests__/drafts.test.ts`

**Interfaces:**
- Consumes: `RegionCode` from `../ads/actions`.
- Produces:
```ts
export interface WeatherAlertDraft {
  entityRef: Record<string, unknown>; // becomes alerts.entity_ref
  severity: "low" | "medium" | "high" | "critical";
  dollarImpact: number;
  rank: number;                        // claude_rank, higher = more prominent
  narrative: string;                   // claude_narrative
  evidence: Record<string, unknown>;   // becomes alert_context.evidence
}
export function budgetDraft(a: {
  sourceCampaignId: string; destCampaignId: string; sourceName: string; destName: string;
  amountCents: number; sourceRegion: RegionCode; destRegion: RegionCode;
  sourceScore: number; destScore: number; narrative: string;
}): WeatherAlertDraft;
```

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/weather/__tests__/drafts.test.ts
import { describe, it, expect } from "vitest";
import { budgetDraft } from "../drafts";

describe("budgetDraft", () => {
  it("carries the source campaign in entity_ref and the reallocation plan in evidence", () => {
    const d = budgetDraft({
      sourceCampaignId: "src", destCampaignId: "dst", sourceName: "West", destName: "East",
      amountCents: 4000, sourceRegion: "us-west", destRegion: "us-east",
      sourceScore: 0.1, destScore: 0.5, narrative: "shift budget east",
    });
    expect(d.entityRef.campaign_id).toBe("src");
    expect(d.entityRef.title).toContain("East");
    expect(d.evidence.source_campaign_id).toBe("src");
    expect(d.evidence.dest_campaign_id).toBe("dst");
    expect(d.evidence.amount_cents).toBe(4000);
    expect(d.dollarImpact).toBe(40); // dollars, from cents
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run app/lib/weather/__tests__/drafts.test.ts`.

- [ ] **Step 3: Implement `app/lib/weather/drafts.ts`**

```ts
import type { RegionCode } from "../ads/actions";

export interface WeatherAlertDraft {
  entityRef: Record<string, unknown>;
  severity: "low" | "medium" | "high" | "critical";
  dollarImpact: number;
  rank: number;
  narrative: string;
  evidence: Record<string, unknown>;
}

export function budgetDraft(a: {
  sourceCampaignId: string; destCampaignId: string; sourceName: string; destName: string;
  amountCents: number; sourceRegion: RegionCode; destRegion: RegionCode;
  sourceScore: number; destScore: number; narrative: string;
}): WeatherAlertDraft {
  return {
    // entity_ref keys the dedup: one active budget suggestion per source campaign.
    entityRef: { campaign_id: a.sourceCampaignId, title: `Shift budget to ${a.destName}` },
    severity: "medium",
    dollarImpact: Math.round(a.amountCents / 100),
    rank: 50,
    narrative: a.narrative,
    evidence: {
      source_campaign_id: a.sourceCampaignId,
      dest_campaign_id: a.destCampaignId,
      amount_cents: a.amountCents,
      source_region: a.sourceRegion,
      dest_region: a.destRegion,
      source_score: a.sourceScore,
      dest_score: a.destScore,
    },
  };
}
```

- [ ] **Step 4: Run tests, expect PASS** — `npx vitest run app/lib/weather/__tests__/drafts.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/weather/drafts.ts app/lib/weather/__tests__/drafts.test.ts
git commit -m "weather: WeatherAlertDraft type + budget draft builder"
```

---

## Task 4: Inventory-signal draft builder

**Files:**
- Create: `app/lib/weather/inventory-signal.ts`
- Test: `app/lib/weather/__tests__/inventory-signal.test.ts`

**Interfaces:**
- Consumes: `SkuDemandViewRow`, `suggestedTransferFromRow` from `../inventory-demand`; `RegionCode` + `VALID_REGIONS` from `../ads/actions`; `favorability`/`RegionForecast` from `./score`; `WeatherAlertDraft` from `./drafts`.
- Produces:
```ts
export const WEATHER_DEMAND_SCORE_FLOOR = 0.35;
export function inventoryDraft(
  row: SkuDemandViewRow,
  regionScores: Map<RegionCode, number>,
): WeatherAlertDraft | null;
```
Returns a `reallocate_inventory` draft only when the row's `main_demand_region` is a known region whose favorability >= floor AND `suggestedTransferFromRow(row)` yields a transfer. Evidence carries the four transfer-plan fields the executor requires.

- [ ] **Step 1: Write the failing tests**

```ts
// app/lib/weather/__tests__/inventory-signal.test.ts
import { describe, it, expect } from "vitest";
import { inventoryDraft } from "../inventory-signal";
import type { SkuDemandViewRow } from "../../inventory-demand";

const row = (over: Partial<SkuDemandViewRow> = {}): SkuDemandViewRow => ({
  sku_id: "sku1", main_demand_region: "us-east",
  demand_units_30d: 60, daily_demand: 2, demand_share: 1, stock_in_region: 3,
  dest_location_external_id: "gid://Location/1", dest_location_name: "NJ",
  src_location_external_id: "gid://Location/2", src_location_name: "CA",
  src_available: 50, inventory_item_id: "gid://InventoryItem/9",
  locations_detail: null, ...over,
});

describe("inventoryDraft", () => {
  it("emits a transfer draft when the short region has favorable weather", () => {
    const d = inventoryDraft(row(), new Map([["us-east", 0.6]]));
    expect(d).not.toBeNull();
    expect(d!.evidence.inventory_item_id).toBe("gid://InventoryItem/9");
    expect(d!.evidence.from_location_id).toBe("gid://Location/2");
    expect(d!.evidence.to_location_id).toBe("gid://Location/1");
    expect(d!.evidence.recommended_delta).toBeGreaterThan(0);
    expect(d!.entityRef.sku_id).toBe("sku1");
  });
  it("returns null when weather in the short region is mild (below floor)", () => {
    expect(inventoryDraft(row(), new Map([["us-east", 0.1]]))).toBeNull();
  });
  it("returns null when there is no transfer to make", () => {
    expect(inventoryDraft(row({ src_available: 0 }), new Map([["us-east", 0.9]]))).toBeNull();
  });
  it("returns null when the demand region is not a known weather region", () => {
    expect(inventoryDraft(row({ main_demand_region: "unknown" }), new Map())).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL** — `npx vitest run app/lib/weather/__tests__/inventory-signal.test.ts`.

- [ ] **Step 3: Implement `app/lib/weather/inventory-signal.ts`**

```ts
import type { SkuDemandViewRow } from "../inventory-demand";
import { suggestedTransferFromRow } from "../inventory-demand";
import { VALID_REGIONS, type RegionCode } from "../ads/actions";
import type { WeatherAlertDraft } from "./drafts";

// Only nudge when the demand region's weather is meaningfully demand-favorable;
// mild forecasts must not manufacture inventory moves (weather is a secondary
// signal — see the design's research section).
export const WEATHER_DEMAND_SCORE_FLOOR = 0.35;

const isRegion = (s: string): s is RegionCode =>
  (VALID_REGIONS as readonly string[]).includes(s);

export function inventoryDraft(
  row: SkuDemandViewRow,
  regionScores: Map<RegionCode, number>,
): WeatherAlertDraft | null {
  const region = row.main_demand_region;
  if (!isRegion(region)) return null;
  const score = regionScores.get(region) ?? 0;
  if (score < WEATHER_DEMAND_SCORE_FLOOR) return null;

  const plan = suggestedTransferFromRow(row);
  if (!plan) return null;

  const skuId = row.sku_id;
  return {
    entityRef: { sku_id: skuId, region, sku: skuId, title: `Move stock to ${region}` },
    severity: "medium",
    dollarImpact: 0, // no reliable dollar estimate at emit time; reward measures the real outcome
    rank: 45,
    narrative:
      `Weather forecast favors demand in ${region} over the next 3 days, and you're low ` +
      `on cover there. Move ${plan.recommended_delta} units from ${plan.from_location_name} ` +
      `to ${plan.to_location_name} ahead of it.`,
    // Exact shape transferPlanFromEvidence requires (regional_spend_starved_stock template).
    evidence: {
      inventory_item_id: plan.inventory_item_id,
      from_location_id: plan.from_location_id,
      to_location_id: plan.to_location_id,
      recommended_delta: plan.recommended_delta,
      region,
      weather_score: score,
      sku_title: skuId,
    },
  };
}
```

- [ ] **Step 4: Run tests, expect PASS** — `npx vitest run app/lib/weather/__tests__/inventory-signal.test.ts`.

- [ ] **Step 5: Verify `VALID_REGIONS` export exists and equals the four buckets.** Run: `npx vitest run app/lib/weather/__tests__/inventory-signal.test.ts` already covers the unknown-region path. If `VALID_REGIONS` is not exported from `app/lib/ads/actions`, import the region list from wherever `regionForGeoTargets` sources it (`app/lib/ads/geo-regions.ts` `REGION_STATES` keys) and adjust `isRegion` accordingly.

- [ ] **Step 6: Commit**

```bash
git add app/lib/weather/inventory-signal.ts app/lib/weather/__tests__/inventory-signal.test.ts
git commit -m "weather: inventory-signal draft builder (transfer gated by favorability)"
```

---

## Task 5: Alert writer (RPC glue)

**Files:**
- Create: `app/lib/weather/alert-writer.server.ts`
- Test: `app/lib/weather/__tests__/alert-writer.test.ts`

**Interfaces:**
- Consumes: `WeatherAlertDraft` from `./drafts`; `SupabaseClient`.
- Produces: `writeWeatherAlert(sb: SupabaseClient, shopId: string, dayBucket: string, draft: WeatherAlertDraft): Promise<string>` (returns alert id) — one `sb.rpc("upsert_weather_alert", ...)` call.

- [ ] **Step 1: Write the failing test (fake sb captures the rpc args)**

```ts
// app/lib/weather/__tests__/alert-writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { writeWeatherAlert } from "../alert-writer.server";
import type { WeatherAlertDraft } from "../drafts";

const draft: WeatherAlertDraft = {
  entityRef: { campaign_id: "src" }, severity: "medium", dollarImpact: 40,
  rank: 50, narrative: "n", evidence: { amount_cents: 4000 },
};

describe("writeWeatherAlert", () => {
  it("calls the RPC with the mapped column args and returns the id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "alert-1", error: null });
    const sb = { rpc } as unknown as import("@supabase/supabase-js").SupabaseClient;
    const id = await writeWeatherAlert(sb, "shop-1", "2026-07-07", draft);
    expect(id).toBe("alert-1");
    expect(rpc).toHaveBeenCalledWith("upsert_weather_alert", {
      p_shop_id: "shop-1", p_detector_id: "weather_demand",
      p_entity_ref: { campaign_id: "src" }, p_severity: "medium",
      p_dollar_impact: 40, p_day_bucket: "2026-07-07",
      p_narrative: "n", p_rank: 50, p_evidence: { amount_cents: 4000 },
    });
  });
  it("throws on rpc error", async () => {
    const sb = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } as never;
    await expect(writeWeatherAlert(sb, "s", "2026-07-07", draft)).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL** — `npx vitest run app/lib/weather/__tests__/alert-writer.test.ts`.

- [ ] **Step 3: Implement `app/lib/weather/alert-writer.server.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { WeatherAlertDraft } from "./drafts";

/** Write (idempotently) one weather_demand alert + its evidence via the canonical
 *  upsert RPC. dayBucket is an ISO YYYY-MM-DD string. Returns the alert id. */
export async function writeWeatherAlert(
  sb: SupabaseClient,
  shopId: string,
  dayBucket: string,
  draft: WeatherAlertDraft,
): Promise<string> {
  const { data, error } = await sb.rpc("upsert_weather_alert", {
    p_shop_id: shopId,
    p_detector_id: "weather_demand",
    p_entity_ref: draft.entityRef,
    p_severity: draft.severity,
    p_dollar_impact: draft.dollarImpact,
    p_day_bucket: dayBucket,
    p_narrative: draft.narrative,
    p_rank: draft.rank,
    p_evidence: draft.evidence,
  });
  if (error) throw new Error(error.message);
  return String(data);
}
```

- [ ] **Step 4: Run tests, expect PASS** — `npx vitest run app/lib/weather/__tests__/alert-writer.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add app/lib/weather/alert-writer.server.ts app/lib/weather/__tests__/alert-writer.test.ts
git commit -m "weather: alert-writer calling upsert_weather_alert RPC"
```

---

## Task 6: Refactor `runWeatherSuggestForShop` to emit alerts

**Files:**
- Modify: `app/lib/actions/weather-suggest.server.ts`
- Test: `app/lib/actions/__tests__/weather-suggest-run.test.ts` (extend existing)

**Interfaces:**
- Consumes: `buildSuggestion` (existing, unchanged), `budgetDraft` (Task 3), `inventoryDraft` (Task 4), `writeWeatherAlert` (Task 5), `loadGeoSegmentedCampaigns` (existing).
- Produces: `runWeatherSuggestForShop` now writes 0..N `weather_demand` alerts (one budget draft if eligible, plus one inventory draft per eligible SKU row) and returns `{ suggested, skippedReason? }` where `suggested` counts alerts written.

- [ ] **Step 1: Write the failing test** — that a shop with 2 geo campaigns and a favorable score gap writes a budget alert, and a shop with an eligible SKU-demand row writes an inventory alert. Inject a fake `sb` whose `rpc` records calls and whose `from("v_sku_regional_demand")` returns one eligible row. Model it on the existing `weather-suggest-run.test.ts` deps pattern (`fetchForecasts`, `today`), adding a `writeAlert` dep so the test asserts the drafts without a live DB:

```ts
it("writes a budget alert and an inventory alert", async () => {
  const written: string[] = [];
  const res = await runWeatherSuggestForShop("shop-1", fakeSb, {
    today: "2026-07-07",
    fetchForecasts: async () => new Map([
      ["us-west", { avgTempC: 24, precipMm: 0, snowCm: 0, avgDaylightH: 14 }],
      ["us-east", { avgTempC: 2, precipMm: 40, snowCm: 8, avgDaylightH: 9 }],
    ]),
    writeAlert: async (_sb, _shop, _day, draft) => {
      written.push(draft.entityRef.campaign_id ? "budget" : "inventory");
      return "id";
    },
  });
  expect(written).toContain("budget");
  expect(res.suggested).toBeGreaterThanOrEqual(1);
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run app/lib/actions/__tests__/weather-suggest-run.test.ts`.

- [ ] **Step 3: Refactor `runWeatherSuggestForShop`.** Keep the guardrail-sensitivity gate and `buildSuggestion` call. After computing `scores`, (a) if `buildSuggestion` returns a suggestion, build a `budgetDraft` and write it; (b) load `v_sku_regional_demand` rows for the shop, map each through `inventoryDraft(row, scores)`, and write the non-null ones. Add a `writeAlert` dep defaulting to `writeWeatherAlert`. Replace the `weather_suggestion` upsert block entirely.

```ts
// add to RunDeps:
//   writeAlert?: typeof writeWeatherAlert;
// after scores are built:
const writeAlert = deps.writeAlert ?? writeWeatherAlert;
const today = deps.today ?? new Date().toISOString().slice(0, 10);
let written = 0;

const suggestion = buildSuggestion(campaigns, scores, sensitivity);
if (suggestion) {
  await writeAlert(sb, shopId, today, budgetDraft({
    sourceCampaignId: suggestion.sourceCampaignId, destCampaignId: suggestion.destCampaignId,
    sourceName: campaignName(campaigns, suggestion.sourceCampaignId),
    destName: campaignName(campaigns, suggestion.destCampaignId),
    amountCents: suggestion.amountCents, sourceRegion: suggestion.sourceRegion,
    destRegion: suggestion.destRegion, sourceScore: suggestion.sourceScore,
    destScore: suggestion.destScore, narrative: suggestion.narrative,
  }));
  written += 1;
}

const { data: demandRows } = await sb
  .from("v_sku_regional_demand").select("*").eq("shop_id", shopId);
for (const r of (demandRows ?? []) as SkuDemandViewRow[]) {
  const draft = inventoryDraft(r, scores);
  if (draft) { await writeAlert(sb, shopId, today, draft); written += 1; }
}

return written > 0 ? { suggested: written } : { suggested: 0, skippedReason: "no_suggestion" };
```

Add a small `campaignName(campaigns, id)` helper returning the campaign's `name`. Remove the now-dead `weather_suggestion` upsert and its imports.

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run app/lib/actions/__tests__/weather-suggest-run.test.ts` and `npm run typecheck`. Both green.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/weather-suggest.server.ts app/lib/actions/__tests__/weather-suggest-run.test.ts
git commit -m "weather: emit weather_demand alerts (budget + inventory) instead of weather_suggestion"
```

---

## Task 7: Add `weather_demand` to autopilot candidates + inventory relocation

**Files:**
- Create: `supabase/migrations/<ts>_autopilot_candidates_weather.sql`
- Modify: `app/lib/actions/autopilot.server.ts` (`INVENTORY_RELOCATION_DETECTORS`, ~lines 69-75)
- Test: `app/lib/actions/__tests__/autopilot-weather-candidacy.test.ts` (create, light)

**Interfaces:**
- Produces: a `weather_demand` inventory alert is an autopilot candidate and routes through `tryInventoryRelocation`.

- [ ] **Step 1: Write the migration** — copy the entire `create or replace view public.v_autopilot_candidates` body from `supabase/migrations/20260627120000_autopilot_candidates_resume.sql` verbatim and append `'weather_demand'` to the `detector_id in (...)` list. Header comment: "add weather_demand so the inventory-relocation branch can act on weather nudges."

- [ ] **Step 2: Apply via `mcp__supabase__apply_migration`** (name `autopilot_candidates_weather`). Expected: success.

- [ ] **Step 3: Add `"weather_demand"` to `INVENTORY_RELOCATION_DETECTORS` in `app/lib/actions/autopilot.server.ts`.** Read the set (around lines 69-75) and add the entry, keeping formatting.

- [ ] **Step 4: Write a light guard test** asserting the set contains `weather_demand`:

```ts
import { INVENTORY_RELOCATION_DETECTORS } from "../autopilot.server";
it("routes weather_demand through inventory relocation", () => {
  expect(INVENTORY_RELOCATION_DETECTORS.has("weather_demand")).toBe(true);
});
```
(If the set is not exported, export it or add a `for-test` predicate; do not widen its visibility beyond what a test needs.)

- [ ] **Step 5: Run test + typecheck** — green.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/*_autopilot_candidates_weather.sql app/lib/actions/autopilot.server.ts app/lib/actions/__tests__/autopilot-weather-candidacy.test.ts
git commit -m "weather: weather_demand becomes an inventory-relocation autopilot candidate"
```

---

## Task 8: Evidence-gated `reallocate_budget` one-click + approve branch

**Files:**
- Create: `app/lib/weather/reallocation-plan.ts`
- Modify: `app/lib/dashboard/one-click.ts`
- Modify: `app/routes/dashboard.api.alerts.$id.action.tsx`
- Test: `app/lib/weather/__tests__/reallocation-plan.test.ts`, `app/lib/dashboard/__tests__/one-click.weather.test.ts`

**Interfaces:**
- Consumes: `executeReallocation` from `~/lib/actions/reallocate.server` (`{ alertId, sourceCampaignId, destCampaignId, amountCents, idempotencyKey, actor?, triggerReason? }`).
- Produces: `reallocationPlanFromEvidence(evidence)` → `{ sourceCampaignId, destCampaignId, amountCents } | null`; the deck can one-click a `reallocate_budget` alert only when this is non-null; approving executes it human-side.

- [ ] **Step 1: Write the failing test for the pure plan reader**

```ts
// app/lib/weather/__tests__/reallocation-plan.test.ts
import { describe, it, expect } from "vitest";
import { reallocationPlanFromEvidence } from "../reallocation-plan";

describe("reallocationPlanFromEvidence", () => {
  it("reads a complete plan", () => {
    expect(reallocationPlanFromEvidence({
      source_campaign_id: "s", dest_campaign_id: "d", amount_cents: 4000,
    })).toEqual({ sourceCampaignId: "s", destCampaignId: "d", amountCents: 4000 });
  });
  it("returns null when any field is missing or non-positive", () => {
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d" })).toBeNull();
    expect(reallocationPlanFromEvidence({ source_campaign_id: "s", dest_campaign_id: "d", amount_cents: 0 })).toBeNull();
    expect(reallocationPlanFromEvidence(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it, expect FAIL.**

- [ ] **Step 3: Implement `app/lib/weather/reallocation-plan.ts`**

```ts
export interface ReallocationPlan {
  sourceCampaignId: string;
  destCampaignId: string;
  amountCents: number;
}

/** Extract a budget-reallocation plan from an alert's evidence, or null if it is
 *  not a complete, actionable plan. Mirrors transferPlanFromEvidence for inventory:
 *  the presence of a plan is what makes a reallocate_budget alert one-click-able,
 *  so alerts without one (e.g. ad_tax_overload) never expose the button. */
export function reallocationPlanFromEvidence(
  evidence: Record<string, unknown> | null | undefined,
): ReallocationPlan | null {
  if (!evidence) return null;
  const source = evidence.source_campaign_id;
  const dest = evidence.dest_campaign_id;
  const amount = Number(evidence.amount_cents);
  if (typeof source !== "string" || typeof dest !== "string") return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (source === dest) return null;
  return { sourceCampaignId: source, destCampaignId: dest, amountCents: amount };
}
```

- [ ] **Step 4: Run test, expect PASS.**

- [ ] **Step 5: Gate one-click on the plan in `app/lib/dashboard/one-click.ts`.** Add `reallocate_budget` to `ONE_CLICK_KINDS`, and in `canOneClickAlert` add an evidence gate so it is one-click ONLY when a plan is present:

```ts
// import at top:
import { reallocationPlanFromEvidence } from "~/lib/weather/reallocation-plan";
// in ONE_CLICK_KINDS add "reallocate_budget"
// in canOneClickAlert, before the final return:
if (kind === "reallocate_budget" && !reallocationPlanFromEvidence(alert?.evidence)) return false;
```

Write `app/lib/dashboard/__tests__/one-click.weather.test.ts`:
```ts
import { canOneClickAlert } from "../one-click";
it("one-clicks a weather reallocate_budget only with a plan", () => {
  const withPlan = { evidence: { source_campaign_id: "s", dest_campaign_id: "d", amount_cents: 4000 } } as never;
  const without = { evidence: {} } as never;
  expect(canOneClickAlert(withPlan, "reallocate_budget")).toBe(true);
  expect(canOneClickAlert(without, "reallocate_budget")).toBe(false);
});
```
Confirm `AlertVM` carries `evidence`; if the deck's `QueueProposalVM` does not include evidence, thread it through `queue.list` (add `evidence` to the queue DTO) so `canOneClickAlert` sees it. Verify against `app/components/dashboard/view-models.ts` and `calderyn.server.ts` `queue.list`.

- [ ] **Step 6: Add the `reallocate_budget` branch to `app/routes/dashboard.api.alerts.$id.action.tsx`.** Extend `KINDS` to include `"reallocate_budget"`, and add a branch (before the inventory fallthrough) that reads the plan from the alert's evidence and calls `executeReallocation`:

```ts
// imports:
import { executeReallocation } from "~/lib/actions/reallocate.server";
import { reallocationPlanFromEvidence } from "~/lib/weather/reallocation-plan";
// in KINDS: add "reallocate_budget"
// branch:
if (kind === "reallocate_budget") {
  const alert = await client.alerts.get(alertId).catch(() => null);
  const plan = reallocationPlanFromEvidence(alert?.evidence ?? null);
  if (!plan) return jsonError(422, "invalid_reallocation_evidence");
  const { id, outcome } = await executeReallocation(session.shopId, {
    alertId,
    sourceCampaignId: plan.sourceCampaignId,
    destCampaignId: plan.destCampaignId,
    amountCents: plan.amountCents,
    idempotencyKey,
    actor: "merchant:web-dashboard",
    triggerReason: "weather",
  }, sb);
  const calibration = await recordCalibration(kind, outcome, id);
  return { audit_id: id, outcome, acknowledged: false, calibration };
}
```
(`ExecutedAudit` returns `{ id, outcome }`; confirm the field name is `id` in `reallocate.server.ts` and match it. `recordCalibration` records the merchant approval trust signal — no reward, by design.)

- [ ] **Step 7: Run tests + typecheck + lint** — `npx vitest run app/lib/weather app/lib/dashboard/__tests__/one-click.weather.test.ts`, `npm run typecheck`, `npm run lint`. All green.

- [ ] **Step 8: Commit**

```bash
git add app/lib/weather/reallocation-plan.ts app/lib/dashboard/one-click.ts app/routes/dashboard.api.alerts.\$id.action.tsx app/lib/weather/__tests__/reallocation-plan.test.ts app/lib/dashboard/__tests__/one-click.weather.test.ts
git commit -m "weather: evidence-gated reallocate_budget one-click + human approve branch"
```

---

## Task 9: Retire the bespoke weather path

**Files:**
- Delete: `app/routes/dashboard.api.weather-reallocation.tsx`
- Modify: `app/components/dashboard/screens/Customers.tsx` (remove the Weather sub-tab + wx state + `onWeather` + imports)
- Modify: `app/routes/dashboard.api.customers._index.tsx` (remove `loadWeatherSuggestions` + `weatherSuggestions`)
- Modify: `app/lib/dashboard/customers-client.ts` (remove `applyWeatherSuggestion` + `WeatherSuggestionDTO` re-export usage)
- Modify: `app/lib/weather/types.ts` (remove `WeatherSuggestionDTO` if now unused)

**Interfaces:**
- Produces: weather now surfaces only through the deck/Alerts; the Customers screen no longer references weather.

- [ ] **Step 1: Delete the route** — `git rm app/routes/dashboard.api.weather-reallocation.tsx` and its test `app/routes/__tests__/dashboard.api.weather-reallocation.test.ts`.

- [ ] **Step 2: Remove the Weather sub-tab from `Customers.tsx`.** Remove the `weather` entry from the `SubTabs` `tabs` array, the `sub === "weather"` render branch, the `wx`/`setWx` state, the `onWeather` handler, the `useEffect` syncing `wx`, and the `applyWeatherSuggestion`/`WeatherSuggestionDTO` imports. Leave Directory and Segments intact.

- [ ] **Step 3: Remove weather from the customers loader.** In `dashboard.api.customers._index.tsx` delete `loadWeatherSuggestions`, the `WeatherSuggestionDTO` import, and drop `weatherSuggestions` from the returned object (revert the `Promise.all` to just `loadCustomersPage`).

- [ ] **Step 4: Remove `applyWeatherSuggestion`** from `app/lib/dashboard/customers-client.ts` and the `weatherSuggestions` field from the `CustomersPage` type. Remove `WeatherSuggestionDTO` from `app/lib/weather/types.ts` if nothing else imports it (grep first: `git grep WeatherSuggestionDTO`).

- [ ] **Step 5: Typecheck + build + lint** — `npm run typecheck`, `npm run build`, `npm run lint`. Fix any dangling references the compiler flags. Expected: exit 0.

- [ ] **Step 6: Grep for stragglers** — `git grep -n "weather-reallocation\|applyWeatherSuggestion\|weatherSuggestions"` returns nothing in `app/`.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "weather: retire bespoke weather_suggestion route + Customers Weather tab"
```

> Note: the `weather_suggestion` table itself is intentionally kept for one release (design §6). No migration drops it here; a follow-up will after in-flight rows drain.

---

## Task 10: End-to-end verification on a seeded shop

**Files:** none (verification only).

- [ ] **Step 1: Enable the feature for a demo shop.** Set `guardrail_config.weather_sensitivity = 50` for the Peak & Pine demo shop via `mcp__supabase__execute_sql`.

- [ ] **Step 2: Run the cron locally** against prod-config per the local dashboard dev recipe, hitting `/cron/weather-suggest` with the `CRON_SECRET` bearer. Expected JSON summary with `suggested >= 1` (the demo shop has geo campaigns and/or regional demand).

- [ ] **Step 3: Confirm the alert rows** — `select detector_id, entity_ref, dollar_impact from alerts where detector_id='weather_demand' and shop_id = '<demo>'` returns the budget and/or inventory alerts, each with a matching `alert_context.evidence`.

- [ ] **Step 4: Confirm deck + Alerts render.** Load the dashboard Home for the demo shop; a weather card appears in the "Needs you" deck; the Alerts screen lists it with a resolved title + narrative.

- [ ] **Step 5: Approve the budget card.** Click Approve; confirm a toast, an `action_audit` row with `action_kind='reallocate_budget'`, `actor_user_id` starting `merchant`, and that the source/dest `ad_campaign_dim.daily_budget_cents` moved by the evidence `amount_cents`. Approve the inventory card; confirm the transfer executed (`executeInventoryAlertAction` path) and an `action_audit` row exists.

- [ ] **Step 6: Idempotency** — re-run the cron; confirm no duplicate open alerts (same `(shop_id, detector_id, entity_ref)`), only `last_seen_at` refreshed.

- [ ] **Step 7: Reset the demo shop** per the demo-showcase reset recipe so the seeded state is clean.

---

## Self-Review

- **Spec coverage:** Visibility (Tasks 6-8, deck+Alerts via alerts), activation/inventory (Tasks 4,6,7), ad visibility + human approve (Task 8), retire bespoke path (Task 9), RPC writer (Tasks 1,5), registration (Task 2), autopilot candidacy for inventory graduation (Task 7), verification (Task 10). Autonomous ad reallocation is explicitly deferred (spec §11 Phase 1b) — no task, by design.
- **Placeholder scan:** none; every code step shows code. Task 7 step 1 says "copy the view body verbatim" — the source file and the one-line change are named exactly, which is complete.
- **Type consistency:** `WeatherAlertDraft` fields (`entityRef`, `evidence`, `severity`, `dollarImpact`, `rank`, `narrative`) are used identically in Tasks 3, 5, 6. `reallocationPlanFromEvidence` shape (`sourceCampaignId`/`destCampaignId`/`amountCents`) matches `ReallocateInput` consumed in Task 8. `inventoryDraft` evidence keys (`inventory_item_id`/`from_location_id`/`to_location_id`/`recommended_delta`) match what `transferPlanFromEvidence` requires (verified).
- **Open confirmations folded into steps:** `VALID_REGIONS` export (Task 4 step 5), `QueueProposalVM.evidence` threading (Task 8 step 5), `ExecutedAudit.id` field name (Task 8 step 6). Each is a named check with a fallback, not a placeholder.
