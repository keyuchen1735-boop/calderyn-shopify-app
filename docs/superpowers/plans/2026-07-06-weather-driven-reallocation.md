# Weather-Driven Reallocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A daily job that ranks the 4 US regions by 3-day weather forecast and writes budget-reallocation *suggestions* between geo-segmented campaigns; merchants approve them from a Weather panel under Customers → Segments, which drives the existing `executeReallocation`.

**Architecture:** New weather lib (`fetch` Open-Meteo → pure favorability score) + a suggester that maps campaign `geo_targets` to a `RegionCode` and sizes a move within a per-shop `weather_sensitivity` dial. A daily cron upserts pending rows into a new `weather_suggestion` table. The Segments panel rides the existing `/dashboard/api/customers` payload; an Approve/Dismiss route mirrors the existing manual reallocate path (no autopilot-guardrail coupling). Opt-in, default OFF.

**Tech Stack:** Remix (Vite), TypeScript strict, Supabase Postgres, Vitest. No new npm dependency (Open-Meteo is a plain `fetch`).

**Spec:** `docs/superpowers/specs/2026-07-06-weather-driven-reallocation-autopilot-design.md`

**Isolation:** Do all work in a dedicated worktree/branch `feat/weather-reallocation` (repo contract). Do NOT build on the current `feat/storegen-taste` branch.

---

## File map

| File | New/Modify | Responsibility |
|---|---|---|
| `supabase/migrations/…_weather_suggestion.sql` | Create | `weather_suggestion` table |
| `supabase/migrations/…_guardrail_weather_sensitivity.sql` | Create | `weather_sensitivity` column on `guardrail_config` |
| `app/lib/weather/regions.ts` | Create | 4 `RegionCode` → centroid `{lat,lon}` |
| `app/lib/weather/score.ts` | Create | Pure `favorability(RegionForecast) → [0,1]` |
| `app/lib/weather/open-meteo.server.ts` | Create | Batched 3-day forecast fetch + parse |
| `app/lib/ads/geo-regions.ts` | Modify | Add `regionForGeoTargets(geo_targets)` |
| `app/lib/actions/weather-suggest.server.ts` | Create | Load geo-segmented campaigns, build + upsert suggestions |
| `app/lib/weather/types.ts` | Create | `WeatherSuggestionDTO` shared client/server type |
| `app/routes/cron.weather-suggest.tsx` | Create | Daily cron: fan out, upsert |
| `vercel.json` | Modify | Add `/cron/weather-suggest` schedule |
| `app/routes/dashboard.api.weather-reallocation.tsx` | Create | Apply/Dismiss write route |
| `app/lib/dashboard/customers-client.ts` | Modify | `applyWeatherSuggestion(...)` client fn |
| `app/lib/buyer/directory-types.ts` | Modify | Add `weatherSuggestions` to `CustomersPage` |
| `app/routes/dashboard.api.customers._index.tsx` | Modify | Include pending suggestions in payload |
| `app/components/dashboard/screens/Customers.tsx` | Modify | Weather panel in Segments subtab |
| `app/lib/types.ts` | Modify | `weather_sensitivity` on `GuardrailConfig` |
| `app/routes/dashboard.api.guardrails.tsx` | Modify | `weather_sensitivity` in `PATCHABLE_KEYS` + loader select |
| `app/components/dashboard/screens/Settings.tsx` | Modify | `GuardrailField` row for the dial |

Build order below is dependency-ordered. Each task ends green + committed.

---

## Task 0: Worktree

- [ ] **Step 1: Create the isolated worktree**

```bash
git worktree add ../calderyn-weather-reallocation -b feat/weather-reallocation
cd ../calderyn-weather-reallocation
```

All subsequent paths are relative to this worktree root.

---

## Task 1: Migrations

**Files:**
- Create: `supabase/migrations/20260706193000_weather_suggestion.sql`
- Create: `supabase/migrations/20260706193100_guardrail_weather_sensitivity.sql`

- [ ] **Step 1: Write the `weather_suggestion` table migration**

`supabase/migrations/20260706193000_weather_suggestion.sql`:

```sql
-- Daily weather-driven reallocation suggestions, surfaced in the Customers →
-- Segments "Weather" panel for human approval. One row = one proposed move of
-- daily budget from a bad-weather-region campaign to a good-weather-region one.
-- Access is via the service role only (cron writer + approval route); RLS is
-- enabled with no policy so anon/authenticated roles are denied by default,
-- matching the other server-owned fact tables.
create table if not exists public.weather_suggestion (
  id                 uuid primary key default gen_random_uuid(),
  shop_id            uuid not null,
  suggested_on       date not null,
  source_region      text not null,
  dest_region        text not null,
  source_campaign_id uuid not null,
  dest_campaign_id   uuid not null,
  amount_cents       int  not null,
  source_score       numeric not null,
  dest_score         numeric not null,
  narrative          text not null,
  status             text not null default 'pending'
                       check (status in ('pending','applied','dismissed')),
  created_at         timestamptz not null default now(),
  unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id)
);

create index if not exists weather_suggestion_shop_pending_idx
  on public.weather_suggestion (shop_id, suggested_on)
  where status = 'pending';

alter table public.weather_suggestion enable row level security;
```

- [ ] **Step 2: Write the guardrail column migration**

`supabase/migrations/20260706193100_guardrail_weather_sensitivity.sql`:

```sql
-- Per-shop dial for the weather-reallocation feature: how aggressively to size a
-- suggested move, as a percent of the source campaign's daily budget scaled by
-- the weather score gap. 0 = feature OFF (default → zero regression; no
-- suggestions are written until a merchant opts in). This is NOT an autopilot_*
-- knob: weather suggestions are human-approved, so this bounds sizing only, it
-- does not feed the autopilot guardrail evaluator. Idempotent.
alter table public.guardrail_config
  add column if not exists weather_sensitivity int not null default 0;
```

- [ ] **Step 3: Apply both migrations to prod via the Supabase MCP**

Use `mcp__plugin_supabase__apply_migration` (project `ajgrmnvzxfxxlwrxcgnu`) once per file, `name` = the filename without extension, `query` = the SQL above.
Expected: both succeed. Verify with `mcp__plugin_supabase__list_tables` (see `weather_suggestion`) and a `mcp__plugin_supabase__execute_sql` of `select weather_sensitivity from guardrail_config limit 1;` (column exists).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260706193000_weather_suggestion.sql supabase/migrations/20260706193100_guardrail_weather_sensitivity.sql
git commit -m "feat(weather): weather_suggestion table + weather_sensitivity guardrail column"
```

---

## Task 2: Region centroids

**Files:**
- Create: `app/lib/weather/regions.ts`
- Test: `app/lib/weather/__tests__/regions.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/weather/__tests__/regions.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { REGION_CENTROIDS } from "../regions";
import { VALID_REGIONS } from "../../ads/actions";

describe("REGION_CENTROIDS", () => {
  it("has exactly one centroid per RegionCode", () => {
    const regions = REGION_CENTROIDS.map((c) => c.region).sort();
    expect(regions).toEqual([...VALID_REGIONS].sort());
  });

  it("centroids are plausible US coordinates", () => {
    for (const c of REGION_CENTROIDS) {
      expect(c.lat).toBeGreaterThan(24);
      expect(c.lat).toBeLessThan(50);
      expect(c.lon).toBeGreaterThan(-125);
      expect(c.lon).toBeLessThan(-66);
    }
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/weather/__tests__/regions.test.ts`
Expected: FAIL (`Cannot find module '../regions'`).

- [ ] **Step 3: Implement**

`app/lib/weather/regions.ts`:

```ts
// Representative population-weighted centroid per coarse RegionCode bucket, used
// to query a single forecast point per region. This is deliberately crude — one
// point stands in for ~12 states — which is acceptable for a marginal-signal
// MVP. ponytail: single centroid per region; refine to multi-point averaging
// only if per-region accuracy proves to matter.
import type { RegionCode } from "../ads/actions";

export interface RegionCentroid {
  region: RegionCode;
  lat: number;
  lon: number;
}

export const REGION_CENTROIDS: readonly RegionCentroid[] = [
  { region: "us-west", lat: 37.34, lon: -121.89 }, // San Jose / Bay Area
  { region: "us-central", lat: 41.88, lon: -87.63 }, // Chicago
  { region: "us-south", lat: 33.75, lon: -84.39 }, // Atlanta
  { region: "us-east", lat: 40.71, lon: -74.01 }, // New York
];
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/weather/__tests__/regions.test.ts`
Expected: PASS (2 tests). If `VALID_REGIONS` isn't exported from `app/lib/ads/actions`, confirm its export name first (`grep -n "VALID_REGIONS" app/lib/ads/actions.ts`) and adjust the import.

- [ ] **Step 5: Commit**

```bash
git add app/lib/weather/regions.ts app/lib/weather/__tests__/regions.test.ts
git commit -m "feat(weather): region centroids for forecast lookup"
```

---

## Task 3: Favorability score (pure)

**Files:**
- Create: `app/lib/weather/score.ts`
- Test: `app/lib/weather/__tests__/score.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/weather/__tests__/score.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { favorability, type RegionForecast } from "../score";

const base: RegionForecast = { avgTempC: 18, precipMm: 0, snowCm: 0, avgDaylightH: 12 };

describe("favorability", () => {
  it("returns 0 for the neutral baseline", () => {
    expect(favorability(base)).toBeCloseTo(0, 6);
  });

  it("stays within [0,1]", () => {
    const extreme = favorability({ avgTempC: -30, precipMm: 100, snowCm: 50, avgDaylightH: 0 });
    expect(extreme).toBeGreaterThanOrEqual(0);
    expect(extreme).toBeLessThanOrEqual(1);
  });

  it("is monotonic: colder scores higher", () => {
    expect(favorability({ ...base, avgTempC: 5 })).toBeGreaterThan(favorability({ ...base, avgTempC: 15 }));
  });

  it("is monotonic: more precipitation scores higher", () => {
    expect(favorability({ ...base, precipMm: 20 })).toBeGreaterThan(favorability({ ...base, precipMm: 5 }));
  });

  it("is monotonic: more snow scores higher", () => {
    expect(favorability({ ...base, snowCm: 8 })).toBeGreaterThan(favorability({ ...base, snowCm: 2 }));
  });

  it("is monotonic: shorter daylight scores higher", () => {
    expect(favorability({ ...base, avgDaylightH: 8 })).toBeGreaterThan(favorability({ ...base, avgDaylightH: 11 }));
  });

  it("cold+rain beats warm+clear (the core hypothesis)", () => {
    const coldRain = favorability({ avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 });
    const warmClear = favorability({ avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 });
    expect(coldRain).toBeGreaterThan(warmClear);
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/weather/__tests__/score.test.ts`
Expected: FAIL (`Cannot find module '../score'`).

- [ ] **Step 3: Implement**

`app/lib/weather/score.ts`:

```ts
// Pure weather → demand-favorability score in [0,1]. Higher = worse weather =
// (hypothesised) more indoor mobile browsing and e-commerce traffic. Weights sum
// to 1 and every factor is clamped to [0,1], so the output is inherently in
// [0,1] with no cross-region normalization needed. This is a fixed, explainable
// heuristic (spec: "fixed heuristic + per-shop knob"); learned per-merchant
// coefficients are a deferred v2.

export interface RegionForecast {
  /** Mean daily temperature over the forecast horizon, °C. */
  avgTempC: number;
  /** Total precipitation over the horizon, mm. */
  precipMm: number;
  /** Total snowfall over the horizon, cm. */
  snowCm: number;
  /** Mean daylight hours per day over the horizon. */
  avgDaylightH: number;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function favorability(f: RegionForecast): number {
  const coldness = clamp01((18 - f.avgTempC) / 30); // 18°C → 0, -12°C → 1
  const wetness = clamp01(f.precipMm / 30); // 30mm over 3d → 1
  const snowiness = clamp01(f.snowCm / 10); // 10cm over 3d → 1
  const darkness = clamp01((12 - f.avgDaylightH) / 6); // 12h → 0, 6h → 1
  return 0.4 * coldness + 0.3 * wetness + 0.2 * snowiness + 0.1 * darkness;
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/weather/__tests__/score.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/weather/score.ts app/lib/weather/__tests__/score.test.ts
git commit -m "feat(weather): pure favorability score heuristic"
```

---

## Task 4: Open-Meteo fetch + parse

**Files:**
- Create: `app/lib/weather/open-meteo.server.ts`
- Test: `app/lib/weather/__tests__/open-meteo.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/weather/__tests__/open-meteo.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchRegionForecasts } from "../open-meteo.server";

// Open-Meteo returns an ARRAY of location objects when multiple coords are
// passed. daily arrays are parallel-indexed by day; daylight_duration is in
// SECONDS. One location per REGION_CENTROIDS entry, in the same order.
function fakeLocation(tmax: number[], tmin: number[], precip: number[], snow: number[], daylightSec: number[]) {
  return {
    daily: {
      temperature_2m_max: tmax,
      temperature_2m_min: tmin,
      precipitation_sum: precip,
      snowfall_sum: snow,
      daylight_duration: daylightSec,
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchRegionForecasts", () => {
  it("parses the batched array into per-region aggregates", async () => {
    const body = [
      // us-west: mean temp 10, precip sum 6, snow sum 0, daylight 10h
      fakeLocation([12, 12, 12], [8, 8, 8], [2, 2, 2], [0, 0, 0], [36000, 36000, 36000]),
      // us-central: colder + snow
      fakeLocation([0, 0, 0], [-4, -4, -4], [1, 1, 1], [3, 3, 3], [32400, 32400, 32400]),
      fakeLocation([20, 20, 20], [10, 10, 10], [0, 0, 0], [0, 0, 0], [43200, 43200, 43200]),
      fakeLocation([5, 5, 5], [-1, -1, -1], [4, 4, 4], [1, 1, 1], [34200, 34200, 34200]),
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    const out = await fetchRegionForecasts([
      { region: "us-west", lat: 1, lon: 1 },
      { region: "us-central", lat: 2, lon: 2 },
      { region: "us-south", lat: 3, lon: 3 },
      { region: "us-east", lat: 4, lon: 4 },
    ]);

    expect(out.get("us-west")).toEqual({ avgTempC: 10, precipMm: 6, snowCm: 0, avgDaylightH: 10 });
    expect(out.get("us-central")!.avgTempC).toBeCloseTo(-2, 6);
    expect(out.get("us-central")!.snowCm).toBe(9);
  });

  it("throws on a non-200 response (caller skips the shop, never fabricates)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(
      fetchRegionForecasts([{ region: "us-west", lat: 1, lon: 1 }]),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/weather/__tests__/open-meteo.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`app/lib/weather/open-meteo.server.ts`:

```ts
// Fetch a 3-day daily forecast for each region centroid from Open-Meteo in one
// batched request (comma-separated lat/lon → array response), and aggregate each
// location's daily arrays into the RegionForecast shape the score consumes.
// Plain fetch, no SDK, no API key. Free public endpoint. On any failure the
// caller SKIPS the shop rather than acting on a fabricated forecast (rule 12).
import type { RegionCode } from "../ads/actions";
import type { RegionForecast } from "./score";

interface Point {
  region: RegionCode;
  lat: number;
  lon: number;
}

interface OpenMeteoLocation {
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    precipitation_sum?: number[];
    snowfall_sum?: number[];
    daylight_duration?: number[];
  };
}

const DAILY = "temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,daylight_duration";
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function aggregate(loc: OpenMeteoLocation): RegionForecast {
  const d = loc.daily ?? {};
  const tmax = d.temperature_2m_max ?? [];
  const tmin = d.temperature_2m_min ?? [];
  const dayMeans = tmax.map((mx, i) => (mx + (tmin[i] ?? mx)) / 2);
  return {
    avgTempC: mean(dayMeans),
    precipMm: sum(d.precipitation_sum ?? []),
    snowCm: sum(d.snowfall_sum ?? []),
    avgDaylightH: mean((d.daylight_duration ?? []).map((s) => s / 3600)),
  };
}

export async function fetchRegionForecasts(
  points: readonly Point[],
  opts: { timeoutMs?: number } = {},
): Promise<Map<RegionCode, RegionForecast>> {
  const lat = points.map((p) => p.lat).join(",");
  const lon = points.map((p) => p.lon).join(",");
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=${DAILY}&forecast_days=3&timezone=UTC`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 8000);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);

  const json = (await res.json()) as OpenMeteoLocation | OpenMeteoLocation[];
  // Single-point queries return an object; multi-point return an array. We always
  // pass >=1 points, but normalize both to be safe.
  const locations = Array.isArray(json) ? json : [json];
  const out = new Map<RegionCode, RegionForecast>();
  points.forEach((p, i) => {
    if (locations[i]) out.set(p.region, aggregate(locations[i]));
  });
  return out;
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/weather/__tests__/open-meteo.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/weather/open-meteo.server.ts app/lib/weather/__tests__/open-meteo.test.ts
git commit -m "feat(weather): Open-Meteo batched forecast fetch"
```

---

## Task 5: `regionForGeoTargets` reverse mapping

**Files:**
- Modify: `app/lib/ads/geo-regions.ts` (append; do not alter existing exports)
- Test: `app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts`

Context: `geo_targets` is only populated for Google campaigns (`geoTargetConstants/<id>`) and seeded demo shops (`RegionCode` literals). Meta/TikTok write `[]`. Existing `REGION_STATES` + `GOOGLE_STATE_ID` (already in the file) give state→id per region; we invert them.

- [ ] **Step 1: Write the failing test**

`app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { regionForGeoTargets } from "../geo-regions";

describe("regionForGeoTargets", () => {
  it("resolves a single RegionCode literal (seed shops)", () => {
    expect(regionForGeoTargets(["us-west"])).toBe("us-west");
  });

  it("resolves Google geoTargetConstants that all fall in one region", () => {
    // 21167 = NY, 21163 = NJ — both us-east
    expect(regionForGeoTargets(["geoTargetConstants/21167", "geoTargetConstants/21163"])).toBe("us-east");
  });

  it("returns null when targets span multiple regions", () => {
    expect(regionForGeoTargets(["us-east", "us-west"])).toBeNull();
    // 21167 = NY (east), 21137 = CA (west)
    expect(regionForGeoTargets(["geoTargetConstants/21167", "geoTargetConstants/21137"])).toBeNull();
  });

  it("returns null for empty targets (Meta/TikTok, national)", () => {
    expect(regionForGeoTargets([])).toBeNull();
  });

  it("returns null for an unrecognized target (conservative — do not act)", () => {
    expect(regionForGeoTargets(["geoTargetConstants/999999"])).toBeNull();
    expect(regionForGeoTargets(["country/US"])).toBeNull();
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts`
Expected: FAIL (`regionForGeoTargets` not exported).

- [ ] **Step 3: Implement — append to `app/lib/ads/geo-regions.ts`**

Add these imports at the top of the file if not already present: `VALID_REGIONS` from `./actions` (confirm the export name with `grep -n "VALID_REGIONS" app/lib/ads/actions.ts`; if it is a different symbol, build the set from the `RegionCode` union instead). Then append:

```ts
// Reverse index: Google geo-target numeric id -> our RegionCode. Built from the
// same REGION_STATES + GOOGLE_STATE_ID maps used to target campaigns, so it can
// never drift from the forward mapping.
const GOOGLE_ID_TO_REGION: Record<string, RegionCode> = (() => {
  const idx: Record<string, RegionCode> = {};
  (Object.keys(REGION_STATES) as RegionCode[]).forEach((region) => {
    for (const st of REGION_STATES[region]) idx[GOOGLE_STATE_ID[st]] = region;
  });
  return idx;
})();

const REGION_SET = new Set<string>(VALID_REGIONS);

/**
 * Resolve a campaign's `geo_targets` to exactly ONE RegionCode, or null if it
 * targets zero/multiple/unrecognized regions (→ ineligible for weather moves).
 * Accepts two input forms:
 *   - RegionCode literals ("us-west") — seeded demo shops.
 *   - Google geoTargetConstants ("geoTargetConstants/21167") or bare numeric ids.
 * Any unrecognized entry makes the whole campaign ineligible (conservative: we
 * never move money on an ambiguous target).
 */
export function regionForGeoTargets(geoTargets: string[]): RegionCode | null {
  if (geoTargets.length === 0) return null;
  const regions = new Set<RegionCode>();
  for (const t of geoTargets) {
    if (REGION_SET.has(t)) {
      regions.add(t as RegionCode);
      continue;
    }
    const id = t.match(/geoTargetConstants\/(\d+)/)?.[1] ?? t.match(/^(\d+)$/)?.[1];
    const region = id ? GOOGLE_ID_TO_REGION[id] : undefined;
    if (!region) return null; // unrecognized → ineligible
    regions.add(region);
  }
  return regions.size === 1 ? [...regions][0] : null;
}
```

Note: `GOOGLE_STATE_ID` is currently a module-private const in `geo-regions.ts` (defined near the top). Since this new code lives in the same file, it is in scope — no export change needed.

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ads/geo-regions.ts app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts
git commit -m "feat(ads): regionForGeoTargets reverse mapping (Google ids + RegionCode literals)"
```

---

## Task 6: Suggestion builder (pure sizing/ranking)

**Files:**
- Create: `app/lib/actions/weather-suggest.server.ts` (builder only this task; loaders/upsert in Task 7)
- Test: `app/lib/actions/__tests__/weather-suggest-build.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/actions/__tests__/weather-suggest-build.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildSuggestion, type EligibleCampaign } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";

const camp = (id: string, region: RegionCode, budget: number, name: string): EligibleCampaign => ({
  campaignId: id, region, dailyBudgetCents: budget, name,
});

const scores = new Map<RegionCode, number>([
  ["us-west", 0.20], ["us-central", 0.30], ["us-south", 0.25], ["us-east", 0.80],
]);

describe("buildSuggestion", () => {
  it("moves budget from the lowest-score region campaign to the highest", () => {
    const s = buildSuggestion(
      [camp("w1", "us-west", 10000, "West"), camp("e1", "us-east", 5000, "East")],
      scores,
      50, // sensitivity %
    );
    expect(s).not.toBeNull();
    expect(s!.sourceCampaignId).toBe("w1");
    expect(s!.destCampaignId).toBe("e1");
    // amount = 10000 * 0.50 * (0.80 - 0.20) = 3000
    expect(s!.amountCents).toBe(3000);
    expect(s!.sourceRegion).toBe("us-west");
    expect(s!.destRegion).toBe("us-east");
    expect(s!.narrative).toContain("West");
    expect(s!.narrative).toContain("East");
  });

  it("returns null when the score gap is below the noise floor", () => {
    const flat = new Map<RegionCode, number>([
      ["us-west", 0.40], ["us-central", 0.41], ["us-south", 0.42], ["us-east", 0.50],
    ]);
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("e1", "us-east", 5000, "E")], flat, 50)).toBeNull();
  });

  it("returns null at sensitivity 0 (feature off)", () => {
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("e1", "us-east", 5000, "E")], scores, 0)).toBeNull();
  });

  it("returns null when fewer than two regions are represented", () => {
    expect(buildSuggestion([camp("w1", "us-west", 10000, "W"), camp("w2", "us-west", 5000, "W2")], scores, 50)).toBeNull();
  });

  it("clamps the move below the source budget", () => {
    // huge sensitivity + gap would exceed budget; must clamp under source budget.
    const s = buildSuggestion([camp("w1", "us-west", 1000, "W"), camp("e1", "us-east", 5000, "E")], scores, 100);
    expect(s!.amountCents).toBeLessThan(1000);
  });

  it("returns null when the sized amount is below the $1 floor", () => {
    const s = buildSuggestion([camp("w1", "us-west", 100, "W"), camp("e1", "us-east", 5000, "E")], scores, 1);
    expect(s).toBeNull();
  });

  it("picks the highest-budget campaign in the source region as the giver", () => {
    const s = buildSuggestion(
      [camp("w1", "us-west", 4000, "Small"), camp("w2", "us-west", 12000, "Big"), camp("e1", "us-east", 5000, "E")],
      scores,
      50,
    );
    expect(s!.sourceCampaignId).toBe("w2");
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/actions/__tests__/weather-suggest-build.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the builder**

`app/lib/actions/weather-suggest.server.ts`:

```ts
// Weather-driven reallocation suggester. Pure ranking/sizing (buildSuggestion)
// plus DB glue (loadGeoSegmentedCampaigns / runWeatherSuggestForShop, Task 7).
// Sizing lives HERE, not in the model or the approval route: the merchant's
// weather_sensitivity dial scales a move as a fraction of the source budget,
// bounded so it always leaves the source positive.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RegionCode } from "../ads/actions";

/** Minimum score gap worth acting on — below this it's forecast noise. */
export const SCORE_GAP_FLOOR = 0.15;
/** Never move more than this fraction of the source daily budget in one move. */
export const MAX_CUT_FRACTION = 0.9;
/** Skip sub-$1 moves — not worth a merchant's attention or a platform write. */
export const MIN_MOVE_CENTS = 100;

export interface EligibleCampaign {
  campaignId: string;
  region: RegionCode;
  dailyBudgetCents: number;
  name: string;
}

export interface BuiltSuggestion {
  sourceRegion: RegionCode;
  destRegion: RegionCode;
  sourceCampaignId: string;
  destCampaignId: string;
  amountCents: number;
  sourceScore: number;
  destScore: number;
  narrative: string;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

/**
 * Rank the eligible campaigns by their region's favorability score and size a
 * single source→dest move. Returns null when there's nothing worth proposing.
 */
export function buildSuggestion(
  campaigns: EligibleCampaign[],
  scores: Map<RegionCode, number>,
  sensitivityPct: number,
): BuiltSuggestion | null {
  if (sensitivityPct <= 0) return null;

  // Regions actually represented by an eligible campaign, ranked by score.
  const byRegion = new Map<RegionCode, EligibleCampaign[]>();
  for (const c of campaigns) {
    const list = byRegion.get(c.region) ?? [];
    list.push(c);
    byRegion.set(c.region, list);
  }
  if (byRegion.size < 2) return null;

  const ranked = [...byRegion.keys()].sort((a, b) => (scores.get(a) ?? 0) - (scores.get(b) ?? 0));
  const sourceRegion = ranked[0];
  const destRegion = ranked[ranked.length - 1];
  const sourceScore = scores.get(sourceRegion) ?? 0;
  const destScore = scores.get(destRegion) ?? 0;
  if (destScore - sourceScore < SCORE_GAP_FLOOR) return null;

  // Giver = biggest-budget campaign in the worst-weather region (most to spare);
  // receiver = biggest-budget campaign in the best-weather region.
  const pickBiggest = (r: RegionCode): EligibleCampaign =>
    byRegion.get(r)!.slice().sort((a, b) => b.dailyBudgetCents - a.dailyBudgetCents)[0];
  const source = pickBiggest(sourceRegion);
  const dest = pickBiggest(destRegion);

  const raw = Math.round(source.dailyBudgetCents * (sensitivityPct / 100) * (destScore - sourceScore));
  const capped = Math.min(raw, Math.floor(source.dailyBudgetCents * MAX_CUT_FRACTION));
  if (capped < MIN_MOVE_CENTS) return null;

  const narrative =
    `Next 3 days: ${destRegion} weather favors demand (score ${destScore.toFixed(2)}) ` +
    `vs ${sourceRegion} (${sourceScore.toFixed(2)}). Shift ${dollars(capped)}/day from ` +
    `"${source.name}" to "${dest.name}".`;

  return {
    sourceRegion,
    destRegion,
    sourceCampaignId: source.campaignId,
    destCampaignId: dest.campaignId,
    amountCents: capped,
    sourceScore,
    destScore,
    narrative,
  };
}

// --- DB glue added in Task 7 (loadGeoSegmentedCampaigns, runWeatherSuggestForShop) ---
export type { SupabaseClient };
```

(The trailing `export type { SupabaseClient }` is a placeholder so the import is used; Task 7 replaces it with real functions.)

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/actions/__tests__/weather-suggest-build.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/actions/weather-suggest.server.ts app/lib/actions/__tests__/weather-suggest-build.test.ts
git commit -m "feat(weather): pure suggestion builder (rank + size)"
```

---

## Task 7: Suggester DB glue (load + upsert per shop)

**Files:**
- Modify: `app/lib/actions/weather-suggest.server.ts` (replace the placeholder export with real functions)
- Test: `app/lib/actions/__tests__/weather-suggest-run.test.ts`

- [ ] **Step 1: Write the failing test**

`app/lib/actions/__tests__/weather-suggest-run.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runWeatherSuggestForShop } from "../weather-suggest.server";
import type { RegionCode } from "../../ads/actions";
import type { RegionForecast } from "../../weather/score";

const SHOP = "11111111-1111-1111-1111-111111111111";

// Minimal chainable Supabase stub: guardrail_config → sensitivity; ad_campaign_dim
// → campaign rows; weather_suggestion → capture upserts.
function fakeSb(opts: { sensitivity: number; campaigns: Array<Record<string, unknown>> }) {
  const calls = { upserts: [] as unknown[] };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.not = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () =>
      table === "guardrail_config"
        ? { data: { weather_sensitivity: opts.sensitivity }, error: null }
        : { data: null, error: null },
    );
    // ad_campaign_dim list resolves via the awaited builder (no maybeSingle).
    chain.then = (res: (v: { data: unknown; error: null }) => void) => {
      if (table === "ad_campaign_dim") return Promise.resolve({ data: opts.campaigns, error: null }).then(res);
      return Promise.resolve({ data: null, error: null }).then(res);
    };
    chain.upsert = vi.fn((rows: unknown) => {
      calls.upserts.push(rows);
      return { select: vi.fn(() => ({ maybeSingle: vi.fn(async () => ({ data: { id: "s1" }, error: null })) })) };
    });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as import("@supabase/supabase-js").SupabaseClient;
  return { sb, calls };
}

const forecasts = new Map<RegionCode, RegionForecast>([
  ["us-west", { avgTempC: 28, precipMm: 0, snowCm: 0, avgDaylightH: 14 }], // low score
  ["us-east", { avgTempC: 2, precipMm: 25, snowCm: 3, avgDaylightH: 9 }], // high score
]);

const fetchForecasts = vi.fn(async () => forecasts);

describe("runWeatherSuggestForShop", () => {
  it("skips when sensitivity is 0 (no fetch, no write)", async () => {
    const { sb, calls } = fakeSb({ sensitivity: 0, campaigns: [] });
    const ff = vi.fn(async () => forecasts);
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts: ff, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(ff).not.toHaveBeenCalled();
    expect(calls.upserts).toHaveLength(0);
  });

  it("upserts a suggestion for a two-region shop", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 50,
      campaigns: [
        { id: "w1", name: "West", status: "active", daily_budget_cents: 10000, geo_targets: ["us-west"] },
        { id: "e1", name: "East", status: "active", daily_budget_cents: 5000, geo_targets: ["us-east"] },
      ],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(1);
    expect(calls.upserts).toHaveLength(1);
    const row = (calls.upserts[0] as Record<string, unknown>[])[0] ?? calls.upserts[0];
    expect(row).toMatchObject({ shop_id: SHOP, suggested_on: "2026-07-06", status: "pending" });
  });

  it("skips a shop with no geo-segmented campaigns", async () => {
    const { sb, calls } = fakeSb({
      sensitivity: 50,
      campaigns: [{ id: "n1", name: "National", status: "active", daily_budget_cents: 10000, geo_targets: [] }],
    });
    const r = await runWeatherSuggestForShop(SHOP, sb, { fetchForecasts, today: "2026-07-06" });
    expect(r.suggested).toBe(0);
    expect(calls.upserts).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/lib/actions/__tests__/weather-suggest-run.test.ts`
Expected: FAIL (`runWeatherSuggestForShop` not exported).

- [ ] **Step 3: Implement — replace the placeholder line in `weather-suggest.server.ts`**

Remove the trailing `export type { SupabaseClient };` line and append:

```ts
import { regionForGeoTargets } from "../ads/geo-regions";
import { favorability, type RegionForecast } from "../weather/score";
import { REGION_CENTROIDS } from "../weather/regions";
import { fetchRegionForecasts } from "../weather/open-meteo.server";

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  daily_budget_cents: number | null;
  geo_targets: string[] | null;
}

/** Load a shop's active, budgeted, single-region campaigns. */
export async function loadGeoSegmentedCampaigns(
  shopId: string,
  sb: SupabaseClient,
): Promise<EligibleCampaign[]> {
  const { data, error } = await sb
    .from("ad_campaign_dim")
    .select("id, name, status, daily_budget_cents, geo_targets")
    .eq("shop_id", shopId)
    .eq("status", "active")
    .not("daily_budget_cents", "is", null);
  if (error) throw error;

  const out: EligibleCampaign[] = [];
  for (const c of (data ?? []) as CampaignRow[]) {
    if (c.daily_budget_cents == null) continue;
    const region = regionForGeoTargets(c.geo_targets ?? []);
    if (!region) continue; // multi-region / national / Meta / TikTok → ineligible
    out.push({ campaignId: c.id, region, dailyBudgetCents: c.daily_budget_cents, name: c.name });
  }
  return out;
}

export interface RunDeps {
  /** Injectable for tests; defaults to the live Open-Meteo fetch. */
  fetchForecasts?: (points: typeof REGION_CENTROIDS) => Promise<Map<RegionCode, RegionForecast>>;
  /** YYYY-MM-DD; defaults to today (UTC). */
  today?: string;
}

export interface RunResult {
  suggested: number;
  skippedReason?: "sensitivity_off" | "no_eligible_campaigns" | "no_suggestion";
}

/**
 * Compute and upsert today's weather suggestion for one shop. Idempotent: the
 * unique (shop_id, suggested_on, source_campaign_id, dest_campaign_id) constraint
 * + upsert means a re-run the same day updates in place, never duplicates.
 */
export async function runWeatherSuggestForShop(
  shopId: string,
  sb: SupabaseClient,
  deps: RunDeps = {},
): Promise<RunResult> {
  const { data: cfg } = await sb
    .from("guardrail_config")
    .select("weather_sensitivity")
    .eq("shop_id", shopId)
    .maybeSingle();
  const sensitivity = Number((cfg as { weather_sensitivity?: unknown } | null)?.weather_sensitivity ?? 0);
  if (!(sensitivity > 0)) return { suggested: 0, skippedReason: "sensitivity_off" };

  const campaigns = await loadGeoSegmentedCampaigns(shopId, sb);
  const regions = new Set(campaigns.map((c) => c.region));
  if (regions.size < 2) return { suggested: 0, skippedReason: "no_eligible_campaigns" };

  const fetchForecasts = deps.fetchForecasts ?? ((pts) => fetchRegionForecasts(pts));
  const forecasts = await fetchForecasts(REGION_CENTROIDS);
  const scores = new Map<RegionCode, number>();
  for (const [region, f] of forecasts) scores.set(region, favorability(f));

  const suggestion = buildSuggestion(campaigns, scores, sensitivity);
  if (!suggestion) return { suggested: 0, skippedReason: "no_suggestion" };

  const today = deps.today ?? new Date().toISOString().slice(0, 10);
  const { error } = await sb.from("weather_suggestion").upsert(
    [
      {
        shop_id: shopId,
        suggested_on: today,
        source_region: suggestion.sourceRegion,
        dest_region: suggestion.destRegion,
        source_campaign_id: suggestion.sourceCampaignId,
        dest_campaign_id: suggestion.destCampaignId,
        amount_cents: suggestion.amountCents,
        source_score: suggestion.sourceScore,
        dest_score: suggestion.destScore,
        narrative: suggestion.narrative,
        status: "pending",
      },
    ],
    { onConflict: "shop_id,suggested_on,source_campaign_id,dest_campaign_id" },
  );
  if (error) throw error;
  return { suggested: 1 };
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/lib/actions/__tests__/weather-suggest-run.test.ts`
Expected: PASS (3 tests). If the `chain.then` stub doesn't resolve the campaign list (thenable quirk), switch the `ad_campaign_dim` list read to a terminal `.then`-free form by having `loadGeoSegmentedCampaigns` await the builder directly — the stub already returns `{ data: opts.campaigns }` from its `then`.

- [ ] **Step 5: Full suite + typecheck**

Run: `npx vitest run app/lib/weather app/lib/actions/__tests__/weather-suggest-build.test.ts app/lib/actions/__tests__/weather-suggest-run.test.ts app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts && npm run typecheck`
Expected: all PASS, `tsc` exit 0.

- [ ] **Step 6: Commit**

```bash
git add app/lib/actions/weather-suggest.server.ts app/lib/actions/__tests__/weather-suggest-run.test.ts
git commit -m "feat(weather): per-shop suggestion load + idempotent upsert"
```

---

## Task 8: Daily cron route

**Files:**
- Create: `app/routes/cron.weather-suggest.tsx`
- Modify: `vercel.json` (add one `crons` entry)

No unit test — this is thin glue mirroring `app/routes/cron.autopilot.tsx`; the tested logic is `runWeatherSuggestForShop`. Verify via typecheck + a live authorized curl in Task 12.

- [ ] **Step 1: Implement the cron route**

`app/routes/cron.weather-suggest.tsx`:

```tsx
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getSupabase } from "~/lib/supabase.server";
import { isAuthorizedCron } from "~/lib/cron-auth.server";
import { mapWithConcurrency } from "~/lib/ads/concurrency";
import { runWeatherSuggestForShop } from "~/lib/actions/weather-suggest.server";

const CONCURRENCY = 4;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorizedCron(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const sb = getSupabase();
  const summary = { shops: 0, suggested: 0, skipped: 0, failed: 0, errors: [] as string[] };

  // Only shops that opted in (weather_sensitivity > 0). A list-read failure is a
  // 500, not an empty 200 — a cron monitor must not read a DB outage as "nobody
  // opted in" (rule 12).
  const { data: rows, error: listErr } = await sb
    .from("guardrail_config")
    .select("shop_id")
    .gt("weather_sensitivity", 0);
  if (listErr) {
    console.error("[cron.weather-suggest] failed to list shops", listErr);
    return json({ error: `failed to list shops: ${listErr.message}` }, { status: 500 });
  }
  const shopIds = (rows ?? []).map((r) => String(r.shop_id));

  const settled = await mapWithConcurrency(shopIds, CONCURRENCY, (shopId) =>
    runWeatherSuggestForShop(shopId, sb),
  );
  settled.forEach((r, i) => {
    if (r.ok) {
      summary.shops += 1;
      summary.suggested += r.value.suggested;
      if (r.value.suggested === 0) summary.skipped += 1;
    } else {
      summary.failed += 1;
      const message = r.error instanceof Error ? r.error.message : String(r.error);
      summary.errors.push(`${shopIds[i]}: ${message}`);
      console.error(`[cron.weather-suggest] failed for ${shopIds[i]}`, r.error);
    }
  });
  console.info("[cron.weather-suggest] summary", summary);
  return json(summary);
};
```

- [ ] **Step 2: Add the schedule to `vercel.json`**

In the `crons` array (after the `/cron/autopilot` line), add:

```json
    { "path": "/cron/weather-suggest", "schedule": "0 7 * * *" },
```

(07:00 UTC daily — after morning forecast refresh, before US business hours.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add app/routes/cron.weather-suggest.tsx vercel.json
git commit -m "feat(weather): daily cron.weather-suggest route + schedule"
```

---

## Task 9: Approve/Dismiss route

**Files:**
- Create: `app/routes/dashboard.api.weather-reallocation.tsx`
- Test: `app/routes/__tests__/dashboard.api.weather-reallocation.test.ts`

Mirrors the manual reallocate path (`app/routes/app.campaigns._index.tsx` calls `executeReallocation` with **no** `checkGuardrails`). Auth/envelope pattern from `app/routes/dashboard.api.cutover.tsx`.

- [ ] **Step 1: Write the failing test**

`app/routes/__tests__/dashboard.api.weather-reallocation.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { requireSameOrigin, requireDashboardSession, executeReallocation } = vi.hoisted(() => ({
  requireSameOrigin: vi.fn(),
  requireDashboardSession: vi.fn(async () => ({ shopId: "shop-1" })),
  executeReallocation: vi.fn(async () => ({ outcome: "succeeded" })),
}));
vi.mock("~/lib/dashboard/session.server", () => ({ requireDashboardSession }));
vi.mock("~/lib/dashboard/http.server", async () => {
  // Use the real envelope helpers so status codes are exercised.
  const actual = await vi.importActual<typeof import("~/lib/dashboard/http.server")>("~/lib/dashboard/http.server");
  return { ...actual, requireSameOrigin };
});
vi.mock("~/lib/actions/reallocate.server", () => ({ executeReallocation }));

let suggestion: Record<string, unknown> | null;
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.update = () => chain;
      chain.maybeSingle = async () => ({ data: suggestion, error: null });
      return chain;
    },
  }),
}));

import { action } from "../dashboard.api.weather-reallocation";

const post = (body: unknown) =>
  action({
    request: new Request("https://app.test/dashboard/api/weather-reallocation", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://app.test" },
      body: JSON.stringify(body),
    }),
    params: {},
    context: {},
  } as never);

beforeEach(() => {
  executeReallocation.mockClear();
  suggestion = {
    id: "sg1", shop_id: "shop-1", status: "pending",
    source_campaign_id: "src", dest_campaign_id: "dst", amount_cents: 3000,
  };
});

describe("weather-reallocation action", () => {
  it("applies a pending suggestion via executeReallocation", async () => {
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(executeReallocation).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({ sourceCampaignId: "src", destCampaignId: "dst", amountCents: 3000, idempotencyKey: "weather:sg1" }),
      expect.anything(),
    );
    expect(res.status).toBe(200);
  });

  it("dismisses without reallocating", async () => {
    const res = await post({ suggestionId: "sg1", intent: "dismiss" });
    expect(executeReallocation).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("409s a non-pending suggestion", async () => {
    suggestion = { ...(suggestion as object), status: "applied" } as Record<string, unknown>;
    const res = await post({ suggestionId: "sg1", intent: "apply" });
    expect(res.status).toBe(409);
    expect(executeReallocation).not.toHaveBeenCalled();
  });

  it("404s an unknown / wrong-shop suggestion", async () => {
    suggestion = null;
    const res = await post({ suggestionId: "nope", intent: "apply" });
    expect(res.status).toBe(404);
  });

  it("422s a bad intent", async () => {
    const res = await post({ suggestionId: "sg1", intent: "frobnicate" });
    expect(res.status).toBe(422);
  });
});
```

- [ ] **Step 2: Run it — expect fail**

Run: `npx vitest run app/routes/__tests__/dashboard.api.weather-reallocation.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

`app/routes/dashboard.api.weather-reallocation.tsx`:

```tsx
import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { getSupabase } from "~/lib/supabase.server";
import { executeReallocation } from "~/lib/actions/reallocate.server";

interface SuggestionRow {
  id: string;
  status: string;
  source_campaign_id: string;
  dest_campaign_id: string;
  amount_cents: number;
}

export async function action({ request }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as
    | { suggestionId?: unknown; intent?: unknown }
    | null;
  const suggestionId = typeof body?.suggestionId === "string" ? body.suggestionId : "";
  const intent = body?.intent === "apply" || body?.intent === "dismiss" ? body.intent : "";
  if (!suggestionId || !intent) return jsonError(422, "bad_request");

  return dashboardJson(async () => {
    const sb = getSupabase();
    const { data, error } = await sb
      .from("weather_suggestion")
      .select("id, status, source_campaign_id, dest_campaign_id, amount_cents")
      .eq("id", suggestionId)
      .eq("shop_id", session.shopId)
      .maybeSingle();
    if (error) throw error;
    const row = data as SuggestionRow | null;
    if (!row) throw jsonError(404, "not_found");

    if (intent === "dismiss") {
      await sb.from("weather_suggestion").update({ status: "dismissed" }).eq("id", row.id).eq("shop_id", session.shopId);
      return { ok: true, status: "dismissed" };
    }

    if (row.status !== "pending") throw jsonError(409, "not_pending");

    // Mirrors app.campaigns._index.tsx: human-approved, so NO checkGuardrails
    // (those caps require autopilot_enabled). executeReallocation re-validates
    // ownership and that the move leaves the source budget positive.
    const res = await executeReallocation(
      session.shopId,
      {
        alertId: null,
        sourceCampaignId: row.source_campaign_id,
        destCampaignId: row.dest_campaign_id,
        amountCents: row.amount_cents,
        idempotencyKey: `weather:${row.id}`,
        actor: "merchant",
        triggerReason: "weather",
      },
      sb,
    );
    if (res.outcome === "failed") throw jsonError(502, "reallocation_failed");

    await sb.from("weather_suggestion").update({ status: "applied" }).eq("id", row.id).eq("shop_id", session.shopId);
    return { ok: true, status: "applied", outcome: res.outcome };
  });
}
```

- [ ] **Step 4: Run it — expect pass**

Run: `npx vitest run app/routes/__tests__/dashboard.api.weather-reallocation.test.ts`
Expected: PASS (5 tests). If `dashboardJson` swallows a thrown `Response` differently than assumed, confirm its behavior in `app/lib/dashboard/http.server.ts` (it rethrows `Response` instances) — the thrown `jsonError(...)` Responses must propagate with their status.

- [ ] **Step 5: Commit**

```bash
git add app/routes/dashboard.api.weather-reallocation.tsx app/routes/__tests__/dashboard.api.weather-reallocation.test.ts
git commit -m "feat(weather): approve/dismiss route (mirrors manual reallocate path)"
```

---

## Task 10: Surface suggestions in the customers payload

**Files:**
- Create: `app/lib/weather/types.ts`
- Modify: `app/lib/buyer/directory-types.ts` (add field to `CustomersPage`)
- Modify: `app/routes/dashboard.api.customers._index.tsx` (populate it)
- Modify: `app/lib/dashboard/customers-client.ts` (add `applyWeatherSuggestion`)

- [ ] **Step 1: Create the shared DTO**

`app/lib/weather/types.ts`:

```ts
/** One pending weather suggestion as rendered in the Segments panel. */
export interface WeatherSuggestionDTO {
  id: string;
  narrative: string;
  amountCents: number;
}
```

- [ ] **Step 2: Add the field to `CustomersPage`**

In `app/lib/buyer/directory-types.ts`, add the import and extend the interface:

```ts
import type { WeatherSuggestionDTO } from "../weather/types";
```

and in `CustomersPage`:

```ts
export interface CustomersPage {
  stats: /* existing */ unknown; // leave existing fields unchanged
  // ...existing customers, segments...
  /** Pending weather-reallocation suggestions for the Segments → Weather panel. Empty for opted-out shops. */
  weatherSuggestions: WeatherSuggestionDTO[];
}
```

Apply this as an additive edit to the real interface — keep all existing fields; only add `weatherSuggestions`.

- [ ] **Step 3: Populate it in the loader**

In `app/routes/dashboard.api.customers._index.tsx`, after the existing data is assembled and before returning `CustomersPage`, read today's pending rows and attach them. Add a helper (top of file or inline):

```ts
import { getSupabase } from "~/lib/supabase.server";
import type { WeatherSuggestionDTO } from "~/lib/weather/types";

async function loadWeatherSuggestions(shopId: string): Promise<WeatherSuggestionDTO[]> {
  const sb = getSupabase();
  const today = new Date().toISOString().slice(0, 10);
  const { data, error } = await sb
    .from("weather_suggestion")
    .select("id, narrative, amount_cents")
    .eq("shop_id", shopId)
    .eq("suggested_on", today)
    .eq("status", "pending")
    .order("amount_cents", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: String(r.id),
    narrative: String(r.narrative),
    amountCents: Number(r.amount_cents),
  }));
}
```

Then include `weatherSuggestions: await loadWeatherSuggestions(session.shopId)` in the returned `CustomersPage` object (use the loader's existing session/shopId variable — match how the file already obtains `shopId`).

- [ ] **Step 4: Add the client function**

In `app/lib/dashboard/customers-client.ts`, add (importing `apiSend` from `./client` — the file already imports `apiGet` from there):

```ts
import { apiGet, apiSend } from "./client";
export type { WeatherSuggestionDTO } from "../weather/types";

/** Approve or dismiss a weather-reallocation suggestion. */
export async function applyWeatherSuggestion(
  suggestionId: string,
  intent: "apply" | "dismiss",
): Promise<{ ok: boolean; status: string }> {
  return apiSend("POST", "/dashboard/api/weather-reallocation", { suggestionId, intent });
}
```

(Adjust the existing `import { apiGet } from "./client";` line to also import `apiSend`.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. Fix any spots where `CustomersPage` is constructed elsewhere (e.g. a demo/seed builder) that now needs `weatherSuggestions: []` — add the empty default there; `tsc` will point to each site.

- [ ] **Step 6: Commit**

```bash
git add app/lib/weather/types.ts app/lib/buyer/directory-types.ts app/routes/dashboard.api.customers._index.tsx app/lib/dashboard/customers-client.ts
git commit -m "feat(weather): surface pending suggestions in the customers payload"
```

---

## Task 11: Weather panel in the Segments subtab

**Files:**
- Modify: `app/components/dashboard/screens/Customers.tsx`

No unit test (presentational). Verify via typecheck + build + browser dogfood (Task 12).

- [ ] **Step 1: Add the panel above the segments list**

In `app/components/dashboard/screens/Customers.tsx`:

1. Add imports near the top with the other client imports:

```tsx
import { applyWeatherSuggestion, type WeatherSuggestionDTO } from "~/lib/dashboard/customers-client";
```

2. Inside the `Customers` component, add local state seeded from the page, kept in sync:

```tsx
const [wx, setWx] = useState<WeatherSuggestionDTO[]>(page?.weatherSuggestions ?? []);
useEffect(() => { setWx(page?.weatherSuggestions ?? []); }, [page]);

const onWeather = async (id: string, intent: "apply" | "dismiss") => {
  setWx((cur) => cur.filter((s) => s.id !== id)); // optimistic
  try {
    await applyWeatherSuggestion(id, intent);
    app.toast(intent === "apply" ? "Budget shifted" : "Suggestion dismissed");
  } catch {
    app.toast("Could not update suggestion");
    setWx((cur) => (page?.weatherSuggestions ?? []).filter((s) => cur.some((c) => c.id === s.id) || s.id === id));
  }
};
```

3. In the `sub === "segments"` branch, render the weather card ABOVE the existing segments `<Card>`, only when there are suggestions:

```tsx
{wx.length > 0 && (
  <Card>
    <CardHead title="Weather segments" caption="Forecast-driven budget shifts across regions" />
    {wx.map((s) => (
      <div key={s.id} className="cd-trow" style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="cd-row-title truncate">{`$${(s.amountCents / 100).toFixed(2)}/day`}</div>
          <div className="cd-caption">{s.narrative}</div>
        </div>
        <button className="cd-btn cd-btn-sm" onClick={() => onWeather(s.id, "apply")}>Approve</button>
        <button className="cd-btn cd-btn-sm cd-btn-ghost" onClick={() => onWeather(s.id, "dismiss")}>Dismiss</button>
      </div>
    ))}
  </Card>
)}
```

Match the exact button classNames to the ones already used in this file (grep `cd-btn` in `Customers.tsx` for the real modifier names; use the existing ghost/small variants rather than inventing classes). `CardHead` is already defined in this file (~line 151).

- [ ] **Step 2: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: both exit 0 (build includes the browser-bundle verifier — no provenance markers introduced).

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/Customers.tsx
git commit -m "feat(weather): Weather segments panel with approve/dismiss"
```

---

## Task 12: Guardrail dial + end-to-end dogfood

**Files:**
- Modify: `app/lib/types.ts` (`GuardrailConfig` + `weather_sensitivity`)
- Modify: `app/routes/dashboard.api.guardrails.tsx` (`PATCHABLE_KEYS` + loader select)
- Modify: `app/components/dashboard/screens/Settings.tsx` (`GuardrailField` row)

- [ ] **Step 1: Add the field to the `GuardrailConfig` type**

In `app/lib/types.ts`, in the `GuardrailConfig` interface, add:

```ts
  /** Weather-reallocation aggressiveness dial (0..100 percent). 0 = feature OFF. */
  weather_sensitivity: number;
```

- [ ] **Step 2: Allow patching + load it**

In `app/routes/dashboard.api.guardrails.tsx`:
- Add `"weather_sensitivity"` to the `PATCHABLE_KEYS` array (~line 17).
- Ensure the loader's `guardrail_config` select includes `weather_sensitivity` and the returned DTO carries it (match how the file maps the row → `GuardrailConfig`; add the field with a `Number(row.weather_sensitivity ?? 0)` default).

- [ ] **Step 3: Add the UI row**

In `app/components/dashboard/screens/Settings.tsx`, near the other autopilot `GuardrailField`s (~line 818), add a row:

```tsx
<GuardrailField
  value={g.weather_sensitivity}
  presets={[
    { value: 0, label: "Off" },
    { value: 25, label: "25%" },
    { value: 50, label: "50%" },
  ]}
  fromInput={(raw) => {
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 && n <= 100 ? n : null;
  }}
  suffix="%"
  disabled={saving}
  onCommit={(v) => { if (v !== null) commit("weather_sensitivity", v); }}
/>
```

Wrap it with whatever label/description markup the sibling `GuardrailField`s use in this file (match the existing row structure — heading + caption + field). Caption text: "Shift ad budget toward regions with demand-favoring weather. 0 turns it off."

- [ ] **Step 4: Typecheck + lint + full test + build (the pre-commit gate)**

Run in order, paste each result:

```bash
npm run typecheck
npm run lint
npx vitest run app/lib/weather app/lib/ads/__tests__/geo-regions-region-for-targets.test.ts app/lib/actions/__tests__/weather-suggest-build.test.ts app/lib/actions/__tests__/weather-suggest-run.test.ts app/routes/__tests__/dashboard.api.weather-reallocation.test.ts
npm run build
```

Expected: all exit 0. Do not proceed past a failure — fix the root cause (rule 12; no `--no-verify`, no disabling checks).

- [ ] **Step 5: Live dogfood on a seeded geo-segmented shop**

The seed dataset (`app/lib/seed/dataset.ts`) already has single-region campaigns (e.g. `geoTargets: ["us-west"]`, `["us-east", "us-west"]`). On a seeded/demo shop:

1. Set the dial: `mcp__plugin_supabase__execute_sql` →
   `update guardrail_config set weather_sensitivity = 50 where shop_id = '<demo-shop-id>';`
   (Ensure at least two campaigns resolve to *different* single regions — a `["us-west"]` and a `["us-east"]` campaign, both active with a daily budget. Add/adjust via SQL if the seed lacks two single-region campaigns.)
2. Trigger the cron locally:
   `curl -s -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/cron/weather-suggest | jq`
   Expected JSON: `suggested >= 1` for that shop (weather permitting a gap ≥ 0.15; if the live forecast gap is below the floor, temporarily inject scores via a unit-level check instead — the cron is verified, the *signal* is weather-dependent).
3. Confirm the row: `select id, narrative, amount_cents, status from weather_suggestion where shop_id = '<demo-shop-id>' and status = 'pending';`
4. In the dashboard UI, open Customers → Segments. Confirm the **Weather segments** card renders the narrative + amount with Approve/Dismiss.
5. Click **Approve**. Confirm: a toast appears, the card row disappears, the suggestion row flips to `applied`, and an `action_audit` row with `action_kind = 'reallocate_budget'` and `trigger_reason = 'weather'` was written for the shop. Verify the source/dest `daily_budget_cents` actually changed on the campaigns (for a live-platform shop) or on the showcase adapter (for a demo shop).

- [ ] **Step 6: Commit**

```bash
git add app/lib/types.ts app/routes/dashboard.api.guardrails.tsx app/components/dashboard/screens/Settings.tsx
git commit -m "feat(weather): weather_sensitivity dial in Settings"
```

- [ ] **Step 7: Run `/code-review` on the branch and resolve blockers**

Per the repo pre-commit gate. Resolve every blocker; downgrade nits with a one-line justification. Then the branch is ready for a PR (open only when the user asks).

---

## Notes for the implementer

- **Convention over novelty (rule 11):** the Approve route intentionally omits `checkGuardrails` to match the existing manual reallocate path. Do not add it — it would silently require `autopilot_enabled`.
- **Fail visibly (rule 12):** Open-Meteo errors skip the shop (never fabricate a forecast); the cron summary counts skipped/failed shops distinctly; a shop-list DB error is a 500, not an empty 200.
- **Google-only reach:** Meta/TikTok campaigns have empty `geo_targets` and are silently ineligible. That's expected, not a bug. Widening reach = adding Meta/TikTok geo ingest (deferred).
- **No new npm dependency.** If you reach for a weather SDK or an HTTP client, stop — `fetch` is the whole dependency.
- **Screen cache:** the panel rides the existing `/dashboard/api/customers` payload + `customers` cache key, so no `WARM_TARGETS`/`SCREEN_CACHE_KEYS` change is needed.
