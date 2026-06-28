# Action Executors (create_po_draft quick-approve + exclude_geo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `create_po_draft` "Needs You" card approve in one click with an auto-suggested order quantity, and turn `exclude_geo` into a real, wired action (real on Google, simulated in demo_mode, fail-visible on Meta/TikTok until Phase 2).

**Architecture:** Both fixes land in shared `app/lib` executors so the embedded (`app/routes/app.alerts.$id.tsx`) and dashboard (`app/routes/dashboard.api.alerts.$id.action.tsx`) approve handlers inherit them. `exclude_geo` follows the existing platform-blind `ActionAdapter` -> `executeAction` pattern: a new adapter method per platform, a new `executeAction` branch, and a table-driven region-to-geo-id map.

**Tech Stack:** TypeScript (strict, ES modules), Vitest, `@supabase/supabase-js` (service role), existing `ActionAdapter` / `executeAction` / `action_audit` / `action_idempotency` / `undo` infra.

## Global Constraints

- TypeScript only, strict. No `any` without written justification; prefer `unknown` + narrowing. `tsc --noEmit` is authoritative.
- No phantom actions (rule 12): never record `succeeded` without the real work. A missing input fails visibly.
- Pure helpers have no IO and are unit-tested in isolation.
- Internal region codes are exactly: `us-west`, `us-east`, `us-south`, `us-central`.
- Pre-commit gate before any commit: `/code-review`, `git diff --check`, `npm run typecheck` (exit 0), `npm run lint` (exit 0), `npm run build` (exit 0), plus the task's vitest. Paste evidence; never assert green without it.
- Dashboard parity: shared `app/lib` executors satisfy parity automatically; where a route file differs, mirror the embedded change into `app/routes/dashboard.api.alerts.$id.action.tsx`.

---

## Phase 1

### Task 1: `suggestedReorderQty` pure helper

**Files:**
- Create: `app/lib/actions/reorder-qty.ts`
- Test: `app/lib/actions/__tests__/reorder-qty.test.ts`

**Interfaces:**
- Produces: `suggestedReorderQty(evidence: Record<string, unknown>): number | null` — units to reorder, or `null` when velocity is unusable. `COVER_BUFFER_DAYS = 14` (exported const).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { suggestedReorderQty, COVER_BUFFER_DAYS } from "../reorder-qty";

describe("suggestedReorderQty", () => {
  it("covers lead time + buffer minus current cover", () => {
    // velocity 2.86, lead 14, cover 3.5 -> ceil(2.86 * (14 + 14 - 3.5)) = ceil(70.07) = 71
    expect(suggestedReorderQty({ daily_velocity_units: "2.86", lead_time_days: 14, days_of_cover: "3.5" })).toBe(71);
  });
  it("falls back to lead-time cover when days_of_cover is missing", () => {
    // ceil(6.29 * 14) = 89
    expect(suggestedReorderQty({ daily_velocity_units: "6.29", lead_time_days: 14 })).toBe(89);
  });
  it("floors at 1 when the computed quantity is <= 0", () => {
    expect(suggestedReorderQty({ daily_velocity_units: "1", lead_time_days: 5, days_of_cover: "999" })).toBe(1);
  });
  it("returns null when velocity is missing or non-positive", () => {
    expect(suggestedReorderQty({ lead_time_days: 14 })).toBeNull();
    expect(suggestedReorderQty({ daily_velocity_units: "0", lead_time_days: 14 })).toBeNull();
  });
  it("exposes the buffer constant", () => {
    expect(COVER_BUFFER_DAYS).toBe(14);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/reorder-qty.test.ts`
Expected: FAIL ("Cannot find module '../reorder-qty'").

- [ ] **Step 3: Write minimal implementation**

```ts
// app/lib/actions/reorder-qty.ts
// Suggested reorder quantity from a reorder_timing alert's evidence. Pure.
// Cover the supplier lead time plus a safety buffer, net of stock already on hand
// (expressed as days_of_cover). Falls back to lead-time-only cover when the
// current cover is unknown; returns null when velocity itself is unusable
// (caller must then route to the detail page rather than guess — rule 12).

export const COVER_BUFFER_DAYS = 14;

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : NaN;
};

export function suggestedReorderQty(evidence: Record<string, unknown>): number | null {
  const velocity = num(evidence.daily_velocity_units);
  if (!(velocity > 0)) return null;
  const lead = num(evidence.lead_time_days);
  const leadDays = lead > 0 ? lead : 0;
  const cover = num(evidence.days_of_cover);
  const coverDays = Number.isFinite(cover) && cover > 0 ? cover : 0;
  const targetDays = leadDays + COVER_BUFFER_DAYS - coverDays;
  const qty = Math.ceil(velocity * targetDays);
  return Math.max(1, qty);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/reorder-qty.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/reorder-qty.ts app/lib/actions/__tests__/reorder-qty.test.ts
git commit -m "feat(actions): suggestedReorderQty helper for create_po_draft quick-approve"
```

---

### Task 2: Default the order quantity inside `executeCreatePoDraft`

**Files:**
- Modify: `app/lib/actions/po-action.server.ts` (the quantity-validation block, ~lines 67-75)
- Test: `app/lib/actions/__tests__/po-action.test.ts` (add cases; create the file if absent following the existing test style for this module)

**Interfaces:**
- Consumes: `suggestedReorderQty` (Task 1), `alert.evidence` already loaded at the top of `executeCreatePoDraft`.
- Behavior change: when the caller passes an empty `quantity`, default to `suggestedReorderQty(alert.evidence ?? {})`. Only throw `invalid_po_quantity` when there is no typed quantity AND no suggestion. A typed quantity always wins and is validated exactly as today.

- [ ] **Step 1: Write the failing test**

```ts
// add to app/lib/actions/__tests__/po-action.test.ts
it("defaults an empty quantity to the suggested reorder qty", async () => {
  // alert evidence: velocity 2.0, lead 14, no cover -> ceil(2*28)=56
  const { client, sb, captured } = makePoHarness({
    alert: { detector_id: "reorder_timing", status: "open", sku: "PP-X",
      evidence: { daily_velocity_units: "2.0", lead_time_days: 14 } },
  });
  const res = await executeCreatePoDraft({
    client, sb, shopId: "shop-1", shopDomain: "x.myshopify.com",
    alertId: "a1", idempotencyKey: "k1", quantity: "", unitCost: "",
  });
  expect(res.outcome).toBe("succeeded");
  expect(captured.poDraft.quantity).toBe(56);
});

it("still rejects a bad typed quantity", async () => {
  const { client, sb } = makePoHarness({
    alert: { detector_id: "reorder_timing", status: "open", sku: "PP-X",
      evidence: { daily_velocity_units: "2.0", lead_time_days: 14 } },
  });
  await expect(executeCreatePoDraft({
    client, sb, shopId: "shop-1", shopDomain: "x.myshopify.com",
    alertId: "a1", idempotencyKey: "k1", quantity: "-3", unitCost: "",
  })).rejects.toThrow(/positive whole number/);
});
```

(`makePoHarness` mirrors the existing harness pattern in this repo's `*-action` tests: a fake `client.alerts.get` returning the given alert, a fake `client.actions.execute` capturing `params.po`, and a stub `sb`. If `po-action.test.ts` does not exist, create it modeled on `app/lib/actions/__tests__/adjust-price-action.test.ts`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/actions/__tests__/po-action.test.ts`
Expected: FAIL (empty quantity still throws `invalid_po_quantity`).

- [ ] **Step 3: Implement the default**

In `app/lib/actions/po-action.server.ts`, import the helper and change the quantity block:

```ts
import { suggestedReorderQty } from "./reorder-qty";
// ...
const typed = quantity.trim();
const qtyRaw = typed === "" ? String(suggestedReorderQty(alert.evidence ?? {}) ?? "") : typed;
const qty = Number(qtyRaw);
if (!/^\d+$/.test(qtyRaw) || qty <= 0 || qty > 1_000_000) {
  throw new CalderynError({
    code: "invalid_po_quantity",
    status: 422,
    message: "Order quantity must be a positive whole number.",
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/actions/__tests__/po-action.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/po-action.server.ts app/lib/actions/__tests__/po-action.test.ts
git commit -m "feat(actions): default empty create_po_draft quantity to the suggested reorder qty"
```

---

### Task 3: Route the embedded `create_po_draft` approve through `executeCreatePoDraft`

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (the action handler: `create_po_draft` must call `executeCreatePoDraft`, not the legacy recorder)

**Interfaces:**
- Consumes: `executeCreatePoDraft` (from `~/lib/actions/po-action.server`), which now self-defaults the quantity (Task 2).
- The dashboard route already calls `executeCreatePoDraft`, so Task 2 fixed it; this task brings the embedded route to parity.

- [ ] **Step 1: Confirm the current path**

Run: `npx grep -n "create_po_draft" app/routes/app.alerts.$id.tsx` (or use the editor). Confirm `create_po_draft` currently flows through `LEGACY_RECORDED_KINDS` + `client.actions.execute` (which never validates/sets a quantity).

- [ ] **Step 2: Write the failing test**

Add a route action test (mirror an existing `app/routes/__tests__/*alerts*` test, mocking `authenticate.admin` + `executeCreatePoDraft`):

```ts
it("create_po_draft approve calls executeCreatePoDraft and acknowledges", async () => {
  executeCreatePoDraftMock.mockResolvedValueOnce({ auditId: "au1", outcome: "succeeded", acknowledged: true });
  const res = await action(makeRequest({ alertId: "a1", intent: "create_po_draft" }));
  expect(executeCreatePoDraftMock).toHaveBeenCalledWith(expect.objectContaining({ alertId: "a1", quantity: "" }));
  expect((await res.json()).ok).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/<the-alerts-action-test>.ts`
Expected: FAIL (executeCreatePoDraft not called).

- [ ] **Step 4: Implement**

In `app/routes/app.alerts.$id.tsx`: remove `create_po_draft` from `LEGACY_RECORDED_KINDS`, add a branch before it that resolves `shopId` + `shopDomain` and calls:

```ts
if (kind === "create_po_draft") {
  const { outcome, acknowledged } = await executeCreatePoDraft({
    client, sb: getSupabase(), shopId, shopDomain: session.shop,
    alertId, idempotencyKey,
    quantity: stringOrEmpty(formData.get("quantity")),
    unitCost: stringOrEmpty(formData.get("unit_cost")),
    signal: request.signal,
  });
  // record approval on success, build the toast (mirror the adjust_price branch above)
  return json<ActionPayload>({ ok: outcome === "succeeded", /* calibration + toast as in adjust_price */ });
}
```

(Follow the existing `adjust_price` branch in the same file for the `client` construction, `recordApproval`, and toast shape.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run app/routes/__tests__/<the-alerts-action-test>.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/app.alerts.$id.tsx app/routes/__tests__/<the-alerts-action-test>.ts
git commit -m "feat(routes): embedded create_po_draft approve uses executeCreatePoDraft (one-click suggested qty)"
```

---

### Task 4: Extend `ActionAdapter` with `excludeGeo`/`includeGeo` + demo no-op

**Files:**
- Modify: `app/lib/ads/actions.ts` (interface + `RegionCode` type)
- Modify: `app/lib/demo/showcase.server.ts` (`showcaseActionAdapter`)
- Test: `app/lib/demo/__tests__/showcase.test.ts`

**Interfaces:**
- Produces: `RegionCode = "us-west" | "us-east" | "us-south" | "us-central"`; `ActionAdapter.excludeGeo(externalId: string, region: RegionCode): Promise<void>` and `includeGeo(externalId: string, region: RegionCode): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```ts
// showcase.test.ts
it("showcaseActionAdapter.excludeGeo / includeGeo resolve without throwing", async () => {
  const a = showcaseActionAdapter("meta");
  await expect(a.excludeGeo("c1", "us-west")).resolves.toBeUndefined();
  await expect(a.includeGeo("c1", "us-west")).resolves.toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/demo/__tests__/showcase.test.ts`
Expected: FAIL (excludeGeo not a function).

- [ ] **Step 3: Implement**

`app/lib/ads/actions.ts`: add `export type RegionCode = "us-west" | "us-east" | "us-south" | "us-central";` and add to the `ActionAdapter` interface:

```ts
  excludeGeo(externalId: string, region: RegionCode): Promise<void>;
  includeGeo(externalId: string, region: RegionCode): Promise<void>;
```

`app/lib/demo/showcase.server.ts`: in `showcaseActionAdapter`, add:

```ts
    async excludeGeo() {},
    async includeGeo() {},
```

- [ ] **Step 4: Run test**

Run: `npx vitest run app/lib/demo/__tests__/showcase.test.ts`
Expected: PASS. (`npm run typecheck` will now flag Meta/Google/TikTok adapters as missing the new methods — handled in Tasks 5-7.)

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/actions.ts app/lib/demo/showcase.server.ts app/lib/demo/__tests__/showcase.test.ts
git commit -m "feat(ads): add excludeGeo/includeGeo to ActionAdapter + demo no-op"
```

---

### Task 5: `geo-regions.ts` — region->states + Google geoTargetConstant table

**Files:**
- Create: `app/lib/ads/geo-regions.ts`
- Test: `app/lib/ads/__tests__/geo-regions.test.ts`

**Interfaces:**
- Produces: `REGION_STATES: Record<RegionCode, readonly UsState[]>`; `googleGeoTargetConstants(region: RegionCode): string[]` (returns `geoTargetConstants/<id>` resource names). `UsState` is the 2-letter USPS code union.

**Data source:** US Census regions for `REGION_STATES` (West / Northeast+Midwest split into east/central as documented inline). Google `geoTargetConstant` IDs are the official US state criteria IDs from Google's `geotargets` CSV (https://developers.google.com/google-ads/api/data/geotargets) — e.g. California = `21137`, New York = `21167`. The table lists all 50 states + DC; the coverage test below makes a missing entry fail the build.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from "vitest";
import { REGION_STATES, googleGeoTargetConstants } from "../geo-regions";

const REGIONS = ["us-west", "us-east", "us-south", "us-central"] as const;

describe("geo-regions", () => {
  it("every region maps to a non-empty, disjoint state list covering 50 states + DC", () => {
    const all = REGIONS.flatMap((r) => REGION_STATES[r]);
    expect(new Set(all).size).toBe(all.length); // disjoint
    expect(new Set(all).size).toBe(51); // 50 states + DC
    for (const r of REGIONS) expect(REGION_STATES[r].length).toBeGreaterThan(0);
  });
  it("every state in every region resolves to a Google geoTargetConstant", () => {
    for (const r of REGIONS) {
      const ids = googleGeoTargetConstants(r);
      expect(ids.length).toBe(REGION_STATES[r].length);
      for (const id of ids) expect(id).toMatch(/^geoTargetConstants\/\d+$/);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/ads/__tests__/geo-regions.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// app/lib/ads/geo-regions.ts
import type { RegionCode } from "./actions";

export type UsState =
  | "AL" | "AK" | "AZ" | "AR" | "CA" | "CO" | "CT" | "DE" | "DC" | "FL"
  | "GA" | "HI" | "ID" | "IL" | "IN" | "IA" | "KS" | "KY" | "LA" | "ME"
  | "MD" | "MA" | "MI" | "MN" | "MS" | "MO" | "MT" | "NE" | "NV" | "NH"
  | "NJ" | "NM" | "NY" | "NC" | "ND" | "OH" | "OK" | "OR" | "PA" | "RI"
  | "SC" | "SD" | "TN" | "TX" | "UT" | "VT" | "VA" | "WA" | "WV" | "WI" | "WY";

// Internal region buckets -> US states. Disjoint, covering all 50 + DC.
export const REGION_STATES: Record<RegionCode, readonly UsState[]> = {
  "us-west": ["WA","OR","CA","NV","ID","MT","WY","UT","CO","AZ","NM","AK","HI"],
  "us-central": ["ND","SD","NE","KS","MN","IA","MO","WI","IL","IN","MI","OH","OK","TX"],
  "us-south": ["AR","LA","MS","AL","TN","KY","GA","FL","SC","NC","VA","WV"],
  "us-east": ["ME","NH","VT","MA","RI","CT","NY","NJ","PA","DE","MD","DC"],
};

// Official Google Ads geo target constant IDs per US state (geotargets CSV).
const GOOGLE_STATE_ID: Record<UsState, string> = {
  AL:"21133", AK:"21132", AZ:"21135", AR:"21136", CA:"21137", CO:"21138", CT:"21139",
  DE:"21140", DC:"21141", FL:"21142", GA:"21143", HI:"21144", ID:"21145", IL:"21146",
  IN:"21147", IA:"21148", KS:"21149", KY:"21150", LA:"21151", ME:"21152", MD:"21153",
  MA:"21154", MI:"21155", MN:"21156", MS:"21157", MO:"21158", MT:"21159", NE:"21160",
  NV:"21161", NH:"21162", NJ:"21163", NM:"21164", NY:"21167", NC:"21165", ND:"21166",
  OH:"21168", OK:"21169", OR:"21170", PA:"21171", RI:"21172", SC:"21173", SD:"21174",
  TN:"21175", TX:"21176", UT:"21177", VT:"21178", VA:"21179", WA:"21180", WV:"21182",
  WI:"21183", WY:"21184",
};

export function googleGeoTargetConstants(region: RegionCode): string[] {
  return REGION_STATES[region].map((s) => `geoTargetConstants/${GOOGLE_STATE_ID[s]}`);
}
```

(IDs above are illustrative placeholders for the SHAPE; the implementer copies the exact current IDs from Google's geotargets CSV. The coverage test guarantees no state is missing; a wrong ID would surface as a Google API error at runtime, not a silent no-op.)

- [ ] **Step 4: Run test**

Run: `npx vitest run app/lib/ads/__tests__/geo-regions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/geo-regions.ts app/lib/ads/__tests__/geo-regions.test.ts
git commit -m "feat(ads): region->state map + Google geoTargetConstant table"
```

---

### Task 6: Google adapter `excludeGeo`/`includeGeo`

**Files:**
- Modify: `app/lib/google/actions.server.ts` (`makeGoogleActionAdapter` + resolver passes a `searchCriteria` fn)
- Test: `app/lib/google/__tests__/actions.test.ts`

**Interfaces:**
- Consumes: `googleGeoTargetConstants` (Task 5), the injected `mutate` fn, and a new injected search used by `includeGeo` to find criterion resource names.
- `excludeGeo` creates one negative campaign-criterion per geoTargetConstant. `includeGeo` looks up those negative location criteria for the campaign + removes them.

- [ ] **Step 1: Write the failing test**

```ts
it("excludeGeo creates a negative location criterion per state in the region", async () => {
  const ops: Array<{ resource: string; op: Record<string, unknown> }> = [];
  const mutate = async (resource: string, op: Record<string, unknown>) => { ops.push({ resource, op }); return {}; };
  const a = makeGoogleActionAdapter(mutate, "123", undefined, async () => ({ results: [] }));
  await a.excludeGeo("555", "us-east"); // us-east has 12 states
  expect(ops).toHaveLength(12);
  expect(ops[0].resource).toBe("campaignCriteria");
  expect(ops[0].op).toMatchObject({
    create: { campaign: "customers/123/campaigns/555", negative: true,
      location: { geoTargetConstant: expect.stringMatching(/^geoTargetConstants\/\d+$/) } },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/google/__tests__/actions.test.ts`
Expected: FAIL (excludeGeo not a function; signature mismatch).

- [ ] **Step 3: Implement**

Extend `makeGoogleActionAdapter(mutate, customerId, read?, searchCriteria?)` and add:

```ts
import { googleGeoTargetConstants } from "../ads/geo-regions";
import type { RegionCode } from "../ads/actions";

// inside the returned adapter:
async excludeGeo(externalId, region) {
  for (const geo of googleGeoTargetConstants(region)) {
    await mutate("campaignCriteria", {
      create: { campaign: `customers/${customerId}/campaigns/${externalId}`, negative: true,
        location: { geoTargetConstant: geo } },
    });
  }
},
async includeGeo(externalId, region) {
  if (!searchCriteria) throw new ActionError("google", "includeGeo reader not configured");
  const wanted = new Set(googleGeoTargetConstants(region));
  const rows = await searchCriteria(externalId); // [{ resourceName, geoTargetConstant }]
  for (const row of rows) {
    if (wanted.has(row.geoTargetConstant)) {
      await mutate("campaignCriteria", { remove: row.resourceName });
    }
  }
},
```

In the resolver (`googleActionAdapterForShop`), pass a real `searchCriteria(externalId)` built on the existing `search()` GAQL helper:

```ts
const searchCriteria = async (externalId: string) => {
  const json = await search(
    `SELECT campaign_criterion.resource_name, campaign_criterion.location.geo_target_constant
     FROM campaign_criterion
     WHERE campaign.id = ${externalId} AND campaign_criterion.negative = true
       AND campaign_criterion.type = LOCATION`,
  ) as { results?: Array<{ campaignCriterion?: { resourceName?: string; location?: { geoTargetConstant?: string } } }> };
  return (json.results ?? []).map((r) => ({
    resourceName: String(r.campaignCriterion?.resourceName ?? ""),
    geoTargetConstant: String(r.campaignCriterion?.location?.geoTargetConstant ?? ""),
  }));
};
return makeGoogleActionAdapter(mutate, customerId, undefined, searchCriteria);
```

- [ ] **Step 4: Run test**

Run: `npx vitest run app/lib/google/__tests__/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/google/actions.server.ts app/lib/google/__tests__/actions.test.ts
git commit -m "feat(google): real exclude_geo/include_geo via negative location criteria"
```

---

### Task 7: Meta + TikTok adapters — fail-visible stub (Phase 2 replaces)

**Files:**
- Modify: `app/lib/meta/actions.server.ts`, `app/lib/tiktok/actions.server.ts`
- Test: extend their existing adapter tests

**Interfaces:**
- `excludeGeo`/`includeGeo` throw `ActionError(platform, "geo exclusion not yet supported on <platform>", { retriable: false })` so a real Meta/TikTok shop fails terminally and visibly (no phantom, no retry burn). demo_mode shops never reach here (they use `showcaseActionAdapter`).

- [ ] **Step 1: Write the failing test (Meta; mirror for TikTok)**

```ts
it("excludeGeo fails terminally until Phase 2", async () => {
  const a = makeMetaActionAdapter(fakeClient);
  await expect(a.excludeGeo("c1", "us-west")).rejects.toMatchObject({ name: "ActionError", retriable: false });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run app/lib/meta/__tests__/actions.test.ts` -> FAIL.

- [ ] **Step 3: Implement** — in each adapter object:

```ts
async excludeGeo() { throw new ActionError("meta", "geo exclusion not yet supported on meta", { retriable: false }); },
async includeGeo() { throw new ActionError("meta", "geo exclusion not yet supported on meta", { retriable: false }); },
```

(`"tiktok"` in the TikTok file.)

- [ ] **Step 4: Run tests** — both adapter tests PASS; `npm run typecheck` now clean for adapters.

- [ ] **Step 5: Commit**

```bash
git add app/lib/meta/actions.server.ts app/lib/tiktok/actions.server.ts app/lib/meta/__tests__/actions.test.ts app/lib/tiktok/__tests__/actions.test.ts
git commit -m "feat(meta,tiktok): exclude_geo fail-visible stub pending Phase 2"
```

---

### Task 8: `executeAction` `exclude_geo` branch

**Files:**
- Modify: `app/lib/actions/execute.server.ts` (`ExecutableKind`, `ExecuteInput`, the kind dispatch + post_state)
- Test: `app/lib/actions/__tests__/execute.test.ts`

**Interfaces:**
- Consumes: `adapter.excludeGeo` (Task 4/6/7).
- `ExecutableKind` gains `"exclude_geo"`. `ExecuteInput` gains `region?: RegionCode`. Dispatch: `if (input.kind === "exclude_geo") await adapter.excludeGeo(externalId, requireRegion(input.region))`. `post_state` records `{ status: camp.status, daily_budget_cents: camp.daily_budget_cents, excluded_region: input.region }`. A missing region throws before the adapter call (visible failure, no phantom).

- [ ] **Step 1: Write the failing test**

```ts
it("exclude_geo calls adapter.excludeGeo with the region and records audit", async () => {
  const { sb, adapter } = makeExecHarness({ campaign: { id: "c1", external_id: "555", platform: "google", status: "active" } });
  const res = await executeAction("shop-1",
    { alertId: "a1", kind: "exclude_geo", campaignId: "c1", idempotencyKey: "k1", region: "us-west" }, sb);
  expect(adapter.excludeGeo).toHaveBeenCalledWith("555", "us-west");
  expect(res.outcome).toBe("succeeded");
});
it("exclude_geo without a region fails visibly", async () => {
  const { sb } = makeExecHarness({ campaign: { id: "c1", external_id: "555", platform: "google", status: "active" } });
  await expect(executeAction("shop-1",
    { alertId: "a1", kind: "exclude_geo", campaignId: "c1", idempotencyKey: "k1" }, sb)).rejects.toThrow(/region/i);
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run app/lib/actions/__tests__/execute.test.ts` -> FAIL.

- [ ] **Step 3: Implement** — add `"exclude_geo"` to `ExecutableKind`; add `region?: RegionCode` to `ExecuteInput` (import `RegionCode`); in the adapter-call block add, before the budget `else`:

```ts
} else if (input.kind === "exclude_geo") {
  if (!input.region) throw new Error(`exclude_geo for ${input.campaignId} has no region (alert evidence lacked it)`);
  await adapter.excludeGeo(externalId, input.region);
}
```

and set `postState` for `exclude_geo` to include `excluded_region: input.region`.

- [ ] **Step 4: Run test** — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/execute.server.ts app/lib/actions/__tests__/execute.test.ts
git commit -m "feat(actions): exclude_geo branch in executeAction (region-scoped, fail-visible)"
```

---

### Task 9: Undo support for `exclude_geo`

**Files:**
- Modify: `app/lib/actions/undo.server.ts`
- Test: `app/lib/actions/__tests__/undo.test.ts`

**Interfaces:**
- Consumes: `adapter.includeGeo`, the reversed audit row's `post_state.excluded_region` and `params` (campaign external id + platform).
- Undo of an `exclude_geo` row resolves the adapter and calls `includeGeo(externalId, region)`, writing a reversal audit (`undo_of` = original id), mirroring how undo reverses pause/budget.

- [ ] **Step 1: Write the failing test**

```ts
it("undo of exclude_geo calls includeGeo with the recorded region", async () => {
  const { sb, adapter } = makeUndoHarness({
    original: { action_kind: "exclude_geo", params: { external_id: "555", platform: "google" },
      post_state: { excluded_region: "us-west" } },
  });
  await undoAction("shop-1", "aud1", sb);
  expect(adapter.includeGeo).toHaveBeenCalledWith("555", "us-west");
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run app/lib/actions/__tests__/undo.test.ts` -> FAIL.

- [ ] **Step 3: Implement** — add an `exclude_geo` case to `undoAction`'s kind switch that reads `external_id`/`platform` from `params` and `excluded_region` from `post_state`, resolves the adapter, and calls `includeGeo`. Follow the existing pause/budget reversal shape for the audit write.

- [ ] **Step 4: Run test** — PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/undo.server.ts app/lib/actions/__tests__/undo.test.ts
git commit -m "feat(actions): undo exclude_geo via includeGeo"
```

---

### Task 10: Wire `exclude_geo` into both approve routes

**Files:**
- Modify: `app/routes/app.alerts.$id.tsx` (embedded), `app/routes/dashboard.api.alerts.$id.action.tsx` (dashboard)
- Test: the route action tests for each

**Interfaces:**
- Consumes: `executeAction` (Task 8). Both routes add an `exclude_geo` branch: resolve campaignId from `alert.evidence.campaign_id`, read `region` from `alert.evidence.region` (or `entity_ref.region`), call `executeAction(shopId, { alertId, kind: "exclude_geo", campaignId, idempotencyKey, region, actor: "merchant" }, getSupabase())`, then acknowledge + `recordApproval` + toast on success — exactly like the existing `pause_campaign` executable branch.

- [ ] **Step 1: Write the failing test (embedded; mirror for dashboard)**

```ts
it("exclude_geo approve calls executeAction with region and campaignId", async () => {
  executeActionMock.mockResolvedValueOnce({ id: "au1", outcome: "succeeded" });
  await action(makeRequest({ alertId: "a1", intent: "exclude_geo" })); // alert evidence: { campaign_id: "c1", region: "us-west" }
  expect(executeActionMock).toHaveBeenCalledWith("shop-1",
    expect.objectContaining({ kind: "exclude_geo", campaignId: "c1", region: "us-west" }), expect.anything());
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (no exclude_geo branch).

- [ ] **Step 3: Implement** — in each route, add `"exclude_geo"` to the executable-kinds handling (it now resolves a campaignId from evidence + a region) and call `executeAction` with the region. Remove `exclude_geo` from any "unsupported action" fall-through so it no longer 422s.

- [ ] **Step 4: Run tests** — both route tests PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/app.alerts.$id.tsx app/routes/dashboard.api.alerts.$id.action.tsx app/routes/__tests__/*
git commit -m "feat(routes): wire exclude_geo approve (embedded + dashboard) through executeAction"
```

---

### Task 11: Full pre-commit gate

- [ ] **Step 1:** `/code-review` on the working tree; resolve blockers.
- [ ] **Step 2:** `git diff --check`; `git diff --stat`; confirm no stray logs/markers.
- [ ] **Step 3:** `npm run typecheck` -> exit 0.
- [ ] **Step 4:** `npm run lint` -> exit 0 (`--max-warnings=0` on touched files).
- [ ] **Step 5:** `npm run build` -> exit 0.
- [ ] **Step 6:** `npx vitest run app/lib/actions app/lib/ads app/lib/google app/lib/meta app/lib/tiktok app/lib/demo app/routes` -> all green.
- [ ] **Step 7:** Paste all outputs. Only then is Phase 1 done.

---

## Phase 2 (separate plan, after Phase 1 ships)

Real geo-exclusion on Meta + TikTok, replacing the Task 7 stubs:
- `geo-regions.ts`: add `metaRegionKeys(region)` (state -> Meta region key, e.g. `US:CA`) and `tiktokLocationIds(region)` tables, with the same coverage test.
- Meta adapter: fan out over the campaign's ad sets (GET each `targeting`, merge `excluded_geo_locations.regions`, POST); `includeGeo` removes them.
- TikTok adapter: fan out over the campaign's ad groups, exclude/restore the region's `location_ids`.
- Live verification requires a connected real Meta/TikTok ad account with live campaigns.

## Post-merge data step (not code)

Un-snooze the `regional_spend_starved_stock` / `sku_stockout_vs_spend` / `reorder_timing` / `scaling_sku_fulfillment_risk` alerts on `calderyn-test` (set `status='open'`, `snoozed_until=null`) so the now-working cards reappear for the demo.
