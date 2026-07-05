# Viral Product Sourcing (#17 discovery slice) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a merchant with no catalog a ranked "Discover" feed of viral products under the Store Builder; picking one writes the owned catalog + a supplier link and auto-generates a draft store.

**Architecture:** A nightly, low-API cron (`cron.sourcing`) pulls trending products through a provider-blind `SupplierAdapter` (fixture provider for tests/offline; CJ Dropshipping as the first real provider) into **global platform reference tables**; a pure deterministic scorer ranks them (no LLM in the ranking loop — rule 5), with a hard `>=2000 users` gate reserved for the later own-data reweight. A **Discover** dashboard screen (nested under the Build/Store nav group, reusing the existing `WelcomeOverlay` cold-start seam) renders the ranked feed; picking a product runs a server-side orchestration that calls the existing `createProduct` + writes `product_media.external_url` + records a shop-scoped `sourced_product_link` + invokes the existing `generateStore({mode:"catalog"})`.

**Tech Stack:** Remix (Vite) · React 18 · Supabase Postgres (service-role + manual `.eq('shop_id')`, no RLS — the repo convention) · TypeScript strict · Vitest · the `cd-*` design system in `app/components/dashboard/ui.tsx` · Lucide via the `CDIcon` registry.

**Out of scope (separate plans):** `#17.fulfillment` (live dropship order-routing) — depends on unbuilt `#10`/`#2`/`#3`. Phase-2 own-data score reweight — gated on ≥2000 users + real sales volume; only the gate is built here.

---

## Scope & decomposition

This plan covers the **discovery slice** only. `#17.fulfillment` is a gated follow-up (its deps do not exist yet). Within this slice, files split by responsibility:

**New backend (`app/lib/sourcing/`)**
- `types.ts` — `NormalizedSourceProduct`, `NormalizedSupplier`, `SourceSignal`, `DiscoverFeedItem`, `PickResult` DTOs.
- `supplier-adapter.ts` — the provider-blind `SupplierAdapter` interface + `getSupplierAdapter()` registry (env `SOURCING_PROVIDER`, default `fixture`).
- `providers/fixture.server.ts` + `fixtures/trending.json` — offline deterministic provider (powers every test).
- `providers/cj.server.ts` — CJ Dropshipping adapter skeleton (first real provider, same interface).
- `score.ts` — **pure** deterministic `scoreVirality()` + `resolveScoringPhase()` (the 2000-user gate).
- `ingest.server.ts` — `toUpsertRows()` (pure) + `runSourcingIngest()` (I/O: adapter → upsert → score → audit row).
- `discover.server.ts` — `listDiscoverFeed()` (global read) + `pickProduct()` (orchestration: createProduct → media → link → generateStore).

**New route surface**
- `app/routes/cron.sourcing.tsx` — nightly cron entry (secret-guarded, mirrors `cron.import`).
- `app/routes/dashboard.api.discover.tsx` — loader (feed) + action (pick).

**New/modified frontend**
- `app/components/dashboard/screens/Discover.tsx` — the ranked-feed screen.
- `app/lib/dashboard/discover-client.ts` — `fetchDiscover` / `pickDiscoverProduct` (mirrors `store-client.ts`).
- Wiring: `context.ts` (Screen union) · `routes.ts` (seg/parsePath) · `DashboardApp.tsx` (SCREENS + NAV_HIGHLIGHT) · `screen-cache.ts` (key) · `prefetch.ts` (WARM_TARGET) · `store/WelcomeOverlay.tsx` + `Store.tsx` (a "Find a viral product" cold-start action).

**Migration**
- `supabase/migrations/20260705170000_viral_sourcing.sql` — global reference tables + shop-scoped link + audit.

---

## Task 1: Migration — sourcing tables

**Files:**
- Create: `supabase/migrations/20260705170000_viral_sourcing.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Viral product sourcing (#17 discovery). GLOBAL platform reference data
-- (source_product/supplier/signal/score) is written ONLY by the cron.sourcing
-- ingest and read-only to merchants (no merchant-facing write route exists).
-- Tenant-specific data lives in the shop-scoped sourced_product_link.
-- Follows the warehouse convention: service-role access + manual .eq('shop_id'),
-- no RLS (RLS hardening is the separate #12 fast-follow).

create table if not exists supplier (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_supplier_id text not null,
  name text not null,
  reliability_score numeric,               -- 0..1 if the provider exposes it, else null
  created_at timestamptz not null default now(),
  unique (provider, external_supplier_id)
);

create table if not exists source_product (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  external_id text not null,
  title text not null,
  category text,
  image_urls text[] not null default '{}',
  unit_cost_cents integer not null,
  moq integer not null default 1,
  lead_time_days integer not null default 0,
  supplier_id uuid references supplier(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (provider, external_id)
);

create table if not exists source_product_signal (
  id bigserial primary key,
  source_product_id uuid not null references source_product(id) on delete cascade,
  kind text not null,                       -- 'order_volume_30d' | 'order_volume_7d' | 'trend_index' | ...
  value numeric not null,
  captured_at timestamptz not null default now()
);
create index if not exists source_product_signal_product_idx on source_product_signal (source_product_id);

create table if not exists source_product_score (
  source_product_id uuid primary key references source_product(id) on delete cascade,
  score numeric not null,                   -- 0..100
  phase text not null,                      -- 'external' | 'blended'
  decay numeric not null,                   -- 0..1 saturation multiplier
  computed_at timestamptz not null default now()
);
create index if not exists source_product_score_rank_idx on source_product_score (score desc);

-- Tenant-specific: which owned product a shop created from which viral source.
create table if not exists sourced_product_link (
  id uuid primary key default gen_random_uuid(),
  shop_id uuid not null,
  product_id uuid not null,                 -- -> product_dim.id (owned catalog)
  source_product_id uuid references source_product(id) on delete set null,
  supplier_id uuid references supplier(id) on delete set null,
  picked_at timestamptz not null default now(),
  unique (shop_id, product_id)
);
create index if not exists sourced_product_link_shop_idx on sourced_product_link (shop_id);

-- Append-only audit of each ingest run (rule 12: a degraded run is visible).
create table if not exists sourcing_run (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  fetched integer not null default 0,
  scored integer not null default 0,
  phase text not null default 'external',
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
```

- [ ] **Step 2: Apply to the local/branch DB and verify**

Run (via the Supabase MCP `apply_migration`, or CLI): apply `20260705170000_viral_sourcing.sql`.
Expected: success; `list_tables` shows `supplier`, `source_product`, `source_product_signal`, `source_product_score`, `sourced_product_link`, `sourcing_run`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260705170000_viral_sourcing.sql
git commit -m "feat(sourcing): global viral-product reference tables + shop-scoped link"
```

---

## Task 2: DTOs + provider-blind SupplierAdapter registry

**Files:**
- Create: `app/lib/sourcing/types.ts`
- Create: `app/lib/sourcing/supplier-adapter.ts`
- Test: `app/lib/sourcing/supplier-adapter.test.ts`

- [ ] **Step 1: Write the DTOs**

```typescript
// app/lib/sourcing/types.ts
// Provider-blind sourcing DTOs. A SupplierAdapter normalizes any dropship
// provider (CJ / Zendrop / AliExpress / fixture) into these shapes so the
// ingest, scorer, and pick flow never branch on the provider.

export interface NormalizedSupplier {
  provider: string;            // "cj" | "zendrop" | "aliexpress" | "fixture"
  externalSupplierId: string;
  name: string;
  reliabilityScore: number | null; // 0..1 if exposed, else null
}

export interface SourceSignal {
  kind: string;   // "order_volume_30d" | "order_volume_7d" | "trend_index"
  value: number;
}

export interface NormalizedSourceProduct {
  provider: string;
  externalId: string;
  title: string;
  category: string | null;
  imageUrls: string[];         // hotlinkable supplier images
  unitCostCents: number;
  moq: number;
  leadTimeDays: number;
  supplier: NormalizedSupplier;
  signals: SourceSignal[];
}

// Read-model row for the Discover feed (global reference join + derived fields).
export interface DiscoverFeedItem {
  sourceProductId: string;
  title: string;
  category: string | null;
  imageUrl: string | null;
  unitCostCents: number;
  suggestedRetailCents: number;
  marginPct: number;           // 0..1
  leadTimeDays: number;
  supplierName: string;
  supplierReliability: number | null;
  score: number;               // 0..100
}

export interface PickResult {
  productId: string;
  storeRunId: string;
}
```

- [ ] **Step 2: Write the failing test**

```typescript
// app/lib/sourcing/supplier-adapter.test.ts
import { describe, it, expect } from "vitest";
import { getSupplierAdapter } from "./supplier-adapter";

describe("getSupplierAdapter", () => {
  it("returns the fixture adapter by name", () => {
    const a = getSupplierAdapter("fixture");
    expect(a.provider).toBe("fixture");
    expect(typeof a.getTrending).toBe("function");
  });

  it("throws on an unknown provider (fail visibly, rule 12)", () => {
    expect(() => getSupplierAdapter("nope")).toThrow(/unknown sourcing provider/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/sourcing/supplier-adapter.test.ts`
Expected: FAIL — cannot find module `./supplier-adapter`.

- [ ] **Step 4: Write the adapter interface + registry**

```typescript
// app/lib/sourcing/supplier-adapter.ts
import type { NormalizedSourceProduct } from "./types";
import { fixtureAdapter } from "./providers/fixture.server";
import { cjAdapter } from "./providers/cj.server";

export interface SupplierAdapter {
  provider: string;
  /** Trending/"hot" products, the low-API primary signal. */
  getTrending(limit: number): Promise<NormalizedSourceProduct[]>;
  /** One product by the provider's external id (used by pick to refresh). */
  getProduct(externalId: string): Promise<NormalizedSourceProduct | null>;
}

const ADAPTERS: Record<string, SupplierAdapter> = {
  fixture: fixtureAdapter,
  cj: cjAdapter,
};

/** Resolve an adapter by name; defaults to SOURCING_PROVIDER (fixture in dev). */
export function getSupplierAdapter(
  provider: string = process.env.SOURCING_PROVIDER || "fixture",
): SupplierAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`unknown sourcing provider: ${provider}`);
  return a;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run app/lib/sourcing/supplier-adapter.test.ts`
Expected: PASS. (Requires Task 3's provider files to exist — do Task 3 in the same commit, or stub `cj.server.ts`/`fixture.server.ts` first.)

- [ ] **Step 6: Commit** (after Task 3)

```bash
git add app/lib/sourcing/types.ts app/lib/sourcing/supplier-adapter.ts app/lib/sourcing/supplier-adapter.test.ts
git commit -m "feat(sourcing): provider-blind SupplierAdapter interface + registry"
```

---

## Task 3: Fixture provider (offline, deterministic) + CJ skeleton

**Files:**
- Create: `app/lib/sourcing/fixtures/trending.json`
- Create: `app/lib/sourcing/providers/fixture.server.ts`
- Create: `app/lib/sourcing/providers/cj.server.ts`
- Test: `app/lib/sourcing/providers/fixture.server.test.ts`

- [ ] **Step 1: Write the fixture data**

```json
[
  {
    "provider": "fixture", "externalId": "fx-1", "title": "Mini Portable Blender",
    "category": "Kitchen", "imageUrls": ["https://cdn.example.com/fx-1.jpg"],
    "unitCostCents": 850, "moq": 1, "leadTimeDays": 9,
    "supplier": { "provider": "fixture", "externalSupplierId": "sup-a", "name": "Shenzhen HomeGoods", "reliabilityScore": 0.92 },
    "signals": [ { "kind": "order_volume_30d", "value": 8200 }, { "kind": "order_volume_7d", "value": 3100 }, { "kind": "trend_index", "value": 88 } ]
  },
  {
    "provider": "fixture", "externalId": "fx-2", "title": "LED Sunset Lamp",
    "category": "Home", "imageUrls": ["https://cdn.example.com/fx-2.jpg"],
    "unitCostCents": 420, "moq": 1, "leadTimeDays": 14,
    "supplier": { "provider": "fixture", "externalSupplierId": "sup-b", "name": "Yiwu Lighting", "reliabilityScore": 0.81 },
    "signals": [ { "kind": "order_volume_30d", "value": 2400 }, { "kind": "order_volume_7d", "value": 300 }, { "kind": "trend_index", "value": 41 } ]
  }
]
```

- [ ] **Step 2: Write the failing test**

```typescript
// app/lib/sourcing/providers/fixture.server.test.ts
import { describe, it, expect } from "vitest";
import { fixtureAdapter } from "./fixture.server";

describe("fixtureAdapter", () => {
  it("returns normalized trending products capped at limit", async () => {
    const rows = await fixtureAdapter.getTrending(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toBe("fx-1");
    expect(rows[0].supplier.name).toBe("Shenzhen HomeGoods");
    expect(rows[0].signals.find((s) => s.kind === "trend_index")?.value).toBe(88);
  });

  it("getProduct resolves by externalId, null when missing", async () => {
    expect((await fixtureAdapter.getProduct("fx-2"))?.title).toBe("LED Sunset Lamp");
    expect(await fixtureAdapter.getProduct("nope")).toBeNull();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run app/lib/sourcing/providers/fixture.server.test.ts`
Expected: FAIL — cannot find module `./fixture.server`.

- [ ] **Step 4: Write the fixture provider + CJ skeleton**

```typescript
// app/lib/sourcing/providers/fixture.server.ts
import type { SupplierAdapter } from "../supplier-adapter";
import type { NormalizedSourceProduct } from "../types";
import seed from "../fixtures/trending.json";

const DATA = seed as NormalizedSourceProduct[];

export const fixtureAdapter: SupplierAdapter = {
  provider: "fixture",
  async getTrending(limit: number): Promise<NormalizedSourceProduct[]> {
    return DATA.slice(0, Math.max(0, limit));
  },
  async getProduct(externalId: string): Promise<NormalizedSourceProduct | null> {
    return DATA.find((p) => p.externalId === externalId) ?? null;
  },
};
```

```typescript
// app/lib/sourcing/providers/cj.server.ts
// CJ Dropshipping adapter — the first REAL provider behind the provider-blind
// interface. CJ exposes an open product API (list/detail) + supplier data.
// ponytail: only the two methods the ingest + pick need are implemented; auth
// is a single access token from env (CJ_ACCESS_TOKEN). Swap SOURCING_PROVIDER=cj
// in prod once the token is configured; tests run on the fixture provider.
import type { SupplierAdapter } from "../supplier-adapter";
import type { NormalizedSourceProduct } from "../types";

const BASE = "https://developers.cjdropshipping.com/api2.0/v1";

function token(): string {
  const t = process.env.CJ_ACCESS_TOKEN;
  if (!t) throw new Error("CJ_ACCESS_TOKEN not set");
  return t;
}

interface CjProduct {
  pid: string; productNameEn: string; categoryName?: string; productImage?: string;
  sellPrice?: string; supplierId?: string; supplierName?: string; listingCount?: number;
}

function normalize(p: CjProduct): NormalizedSourceProduct {
  const unitCostCents = Math.round(Number(p.sellPrice ?? "0") * 100);
  return {
    provider: "cj", externalId: p.pid, title: p.productNameEn,
    category: p.categoryName ?? null,
    imageUrls: p.productImage ? [p.productImage] : [],
    unitCostCents, moq: 1, leadTimeDays: 12,
    supplier: {
      provider: "cj", externalSupplierId: p.supplierId ?? "cj",
      name: p.supplierName ?? "CJ Dropshipping", reliabilityScore: null,
    },
    // CJ's listingCount (how many stores already sell it) is our order-volume proxy.
    signals: [{ kind: "order_volume_30d", value: Number(p.listingCount ?? 0) }],
  };
}

export const cjAdapter: SupplierAdapter = {
  provider: "cj",
  async getTrending(limit: number): Promise<NormalizedSourceProduct[]> {
    const res = await fetch(`${BASE}/product/list?pageSize=${limit}&pageNum=1`, {
      headers: { "CJ-Access-Token": token() },
    });
    if (!res.ok) throw new Error(`CJ getTrending ${res.status}`);
    const body = (await res.json()) as { data?: { list?: CjProduct[] } };
    return (body.data?.list ?? []).map(normalize);
  },
  async getProduct(externalId: string): Promise<NormalizedSourceProduct | null> {
    const res = await fetch(`${BASE}/product/query?pid=${encodeURIComponent(externalId)}`, {
      headers: { "CJ-Access-Token": token() },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: CjProduct };
    return body.data ? normalize(body.data) : null;
  },
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run app/lib/sourcing/providers/fixture.server.test.ts app/lib/sourcing/supplier-adapter.test.ts`
Expected: PASS (all 4).

- [ ] **Step 6: Commit**

```bash
git add app/lib/sourcing/fixtures/ app/lib/sourcing/providers/ app/lib/sourcing/types.ts app/lib/sourcing/supplier-adapter.ts app/lib/sourcing/*.test.ts
git commit -m "feat(sourcing): fixture provider (offline) + CJ Dropshipping adapter skeleton"
```

---

## Task 4: Deterministic virality scorer + the 2000-user gate

**Files:**
- Create: `app/lib/sourcing/score.ts`
- Test: `app/lib/sourcing/score.test.ts`

The scorer is a **pure function** — no I/O, no model (rule 5). This is the "accurate over time" core: Phase 1 uses external signals only; `resolveScoringPhase` reserves the ≥2000-user flip for the later own-data reweight.

- [ ] **Step 1: Write the failing tests**

```typescript
// app/lib/sourcing/score.test.ts
import { describe, it, expect } from "vitest";
import { scoreVirality, resolveScoringPhase, type ScoreInputs } from "./score";

const base: ScoreInputs = {
  orderVolume30d: 8000, orderVolume7d: 3000, trendIndex: 85,
  firstSeenDaysAgo: 3, unitCostCents: 800, suggestedRetailCents: 2400, leadTimeDays: 9,
};

describe("scoreVirality", () => {
  it("scores a fresh, accelerating, high-margin product high", () => {
    expect(scoreVirality(base).score).toBeGreaterThan(70);
  });

  it("is deterministic", () => {
    expect(scoreVirality(base)).toEqual(scoreVirality(base));
  });

  it("decays a peaked (old) product toward zero regardless of volume", () => {
    const stale = scoreVirality({ ...base, firstSeenDaysAgo: 120 });
    expect(stale.decay).toBeLessThan(0.1);
    expect(stale.score).toBeLessThan(base.orderVolume30d ? 15 : 0);
  });

  it("penalizes thin margin vs a fat-margin twin", () => {
    const thin = scoreVirality({ ...base, suggestedRetailCents: 900 }); // ~11% margin
    const fat = scoreVirality(base);                                     // ~67% margin
    expect(thin.score).toBeLessThan(fat.score);
  });

  it("clamps to 0..100", () => {
    const huge = scoreVirality({ ...base, orderVolume30d: 1e9, trendIndex: 100 });
    expect(huge.score).toBeLessThanOrEqual(100);
    expect(scoreVirality({ ...base, orderVolume30d: 0, orderVolume7d: 0, trendIndex: 0 }).score)
      .toBeGreaterThanOrEqual(0);
  });
});

describe("resolveScoringPhase", () => {
  it("stays external below 2000 users", () => {
    expect(resolveScoringPhase(0)).toBe("external");
    expect(resolveScoringPhase(1999)).toBe("external");
  });
  it("flips to blended at 2000 users (the founder-set gate)", () => {
    expect(resolveScoringPhase(2000)).toBe("blended");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run app/lib/sourcing/score.test.ts`
Expected: FAIL — cannot find module `./score`.

- [ ] **Step 3: Write the scorer**

```typescript
// app/lib/sourcing/score.ts
// Deterministic virality score (rule 5: ranking is code, never a model call).
// Phase 1 = external signals only. The own-data reweight (Phase 2) is gated on
// >=2000 users and is a SEPARATE future task — resolveScoringPhase only flips
// the label here; scoreVirality is Phase-1 math.

export const OWN_DATA_USER_THRESHOLD = 2000;
export type ScoringPhase = "external" | "blended";

export interface ScoreInputs {
  orderVolume30d: number;
  orderVolume7d: number;
  trendIndex: number;        // 0..100 (external, e.g. Google Trends)
  firstSeenDaysAgo: number;  // for saturation/decay
  unitCostCents: number;
  suggestedRetailCents: number;
  leadTimeDays: number;
}

export interface ScoreResult {
  score: number;       // 0..100
  velocity: number;    // 0..1
  momentum: number;    // 0..1
  decay: number;       // 0..1
  marginPenalty: number; // 0..1
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Phase gate: below the threshold we cannot trust own-sales data, so rank on
 *  externals only. At/after it, the blended reweight activates (future task). */
export function resolveScoringPhase(userCount: number): ScoringPhase {
  return userCount >= OWN_DATA_USER_THRESHOLD ? "blended" : "external";
}

export function scoreVirality(x: ScoreInputs): ScoreResult {
  // Velocity: log-scaled recent demand (10k+ orders/30d -> ~1).
  const velocity = clamp01(Math.log10(1 + Math.max(0, x.orderVolume30d)) / 4);

  // Momentum: is the 7d run out-pacing the 30d average? (>1 = accelerating.)
  const expected7d = Math.max(1, x.orderVolume30d) * (7 / 30);
  const momentum = clamp01(Math.max(0, x.orderVolume7d) / expected7d / 2);

  const trend = clamp01(x.trendIndex / 100);

  // Decay: a product first seen long ago has likely saturated. Linear to ~0 at 60d.
  const decay = clamp01(1 - Math.max(0, x.firstSeenDaysAgo) / 60);

  // Margin penalty: healthy dropship margin ~>=50%. Penalize below that.
  const margin = x.suggestedRetailCents > 0
    ? (x.suggestedRetailCents - x.unitCostCents) / x.suggestedRetailCents
    : 0;
  const marginPenalty = margin >= 0.5 ? 0 : clamp01((0.5 - margin) / 0.5);

  // Lead-time penalty: >20d shipping hurts (small).
  const leadPenalty = x.leadTimeDays > 20 ? clamp01((x.leadTimeDays - 20) / 40) : 0;

  const demand = 0.45 * velocity + 0.3 * momentum + 0.25 * trend; // 0..1
  const raw = demand * decay * (1 - marginPenalty) * (1 - 0.3 * leadPenalty);
  return { score: Math.round(clamp01(raw) * 100), velocity, momentum, decay, marginPenalty };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run app/lib/sourcing/score.test.ts`
Expected: PASS (7).

- [ ] **Step 5: Commit**

```bash
git add app/lib/sourcing/score.ts app/lib/sourcing/score.test.ts
git commit -m "feat(sourcing): deterministic virality scorer + 2000-user phase gate"
```

---

## Task 5: Ingest — pure transform + I/O runner + audit

**Files:**
- Create: `app/lib/sourcing/ingest.server.ts`
- Test: `app/lib/sourcing/ingest.test.ts`

Split the pure transform (`toUpsertRows`) from the DB I/O so the ranking logic is unit-tested without a database.

- [ ] **Step 1: Write the failing test (pure transform)**

```typescript
// app/lib/sourcing/ingest.test.ts
import { describe, it, expect } from "vitest";
import { toUpsertRows, suggestedRetailCents } from "./ingest.server";
import type { NormalizedSourceProduct } from "./types";

const prod: NormalizedSourceProduct = {
  provider: "fixture", externalId: "fx-1", title: "Mini Blender", category: "Kitchen",
  imageUrls: ["https://x/1.jpg"], unitCostCents: 850, moq: 1, leadTimeDays: 9,
  supplier: { provider: "fixture", externalSupplierId: "sup-a", name: "HomeGoods", reliabilityScore: 0.9 },
  signals: [
    { kind: "order_volume_30d", value: 8200 },
    { kind: "order_volume_7d", value: 3100 },
    { kind: "trend_index", value: 88 },
  ],
};

describe("suggestedRetailCents", () => {
  it("applies the deterministic markup", () => {
    expect(suggestedRetailCents(850)).toBe(2125); // 2.5x default
  });
});

describe("toUpsertRows", () => {
  it("builds a scored row from signals (phase external)", () => {
    const rows = toUpsertRows([prod], "external", 0);
    expect(rows).toHaveLength(1);
    expect(rows[0].score.score).toBeGreaterThan(60);
    expect(rows[0].score.phase).toBe("external");
    expect(rows[0].firstSeenDaysAgo).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/sourcing/ingest.test.ts`
Expected: FAIL — cannot find module `./ingest.server`.

- [ ] **Step 3: Write the ingest module**

```typescript
// app/lib/sourcing/ingest.server.ts
import { getSupabase } from "~/lib/supabase.server";
import { getSupplierAdapter } from "./supplier-adapter";
import { scoreVirality, resolveScoringPhase, type ScoringPhase } from "./score";
import type { NormalizedSourceProduct } from "./types";

const MARKUP = Number(process.env.SOURCING_MARKUP || "2.5");
const TRENDING_LIMIT = Number(process.env.SOURCING_TRENDING_LIMIT || "60");

/** Deterministic suggested retail from supplier cost (rule 5). */
export function suggestedRetailCents(unitCostCents: number): number {
  return Math.round(unitCostCents * MARKUP);
}

function sig(p: NormalizedSourceProduct, kind: string): number {
  return p.signals.find((s) => s.kind === kind)?.value ?? 0;
}

export interface ScoredRow {
  product: NormalizedSourceProduct;
  firstSeenDaysAgo: number;
  score: ReturnType<typeof scoreVirality> & { phase: ScoringPhase };
}

/** Pure: turn normalized products into scored rows ready to upsert. */
export function toUpsertRows(
  products: NormalizedSourceProduct[],
  phase: ScoringPhase,
  firstSeenDaysAgo: number,
): ScoredRow[] {
  return products.map((product) => {
    const s = scoreVirality({
      orderVolume30d: sig(product, "order_volume_30d"),
      orderVolume7d: sig(product, "order_volume_7d"),
      trendIndex: sig(product, "trend_index"),
      firstSeenDaysAgo,
      unitCostCents: product.unitCostCents,
      suggestedRetailCents: suggestedRetailCents(product.unitCostCents),
      leadTimeDays: product.leadTimeDays,
    });
    return { product, firstSeenDaysAgo, score: { ...s, phase } };
  });
}

/** Count platform users for the phase gate. Tolerant: if the users table isn't
 *  wired yet, default to 0 → the conservative "external" phase (never crash ingest). */
async function userCount(): Promise<number> {
  const { count, error } = await getSupabase().from("users").select("id", { count: "exact", head: true });
  if (error) return 0;
  return count ?? 0;
}

/** I/O: pull trending -> upsert supplier/source_product/signals -> upsert score -> audit. */
export async function runSourcingIngest(providerName?: string): Promise<{ fetched: number; scored: number }> {
  const sb = getSupabase();
  const adapter = getSupplierAdapter(providerName);
  const phase = resolveScoringPhase(await userCount());
  const { data: run } = await sb.from("sourcing_run")
    .insert({ provider: adapter.provider, phase }).select("id").single();
  const runId = run?.id as string | undefined;

  try {
    const products = await adapter.getTrending(TRENDING_LIMIT);
    let scored = 0;
    for (const row of toUpsertRows(products, phase, 0)) {
      const p = row.product;
      const { data: sup } = await sb.from("supplier").upsert(
        { provider: p.supplier.provider, external_supplier_id: p.supplier.externalSupplierId,
          name: p.supplier.name, reliability_score: p.supplier.reliabilityScore },
        { onConflict: "provider,external_supplier_id" }).select("id").single();

      const { data: sp } = await sb.from("source_product").upsert(
        { provider: p.provider, external_id: p.externalId, title: p.title, category: p.category,
          image_urls: p.imageUrls, unit_cost_cents: p.unitCostCents, moq: p.moq,
          lead_time_days: p.leadTimeDays, supplier_id: sup?.id, last_seen_at: new Date().toISOString() },
        { onConflict: "provider,external_id" }).select("id").single();
      if (!sp?.id) continue;

      await sb.from("source_product_signal").insert(
        p.signals.map((s) => ({ source_product_id: sp.id, kind: s.kind, value: s.value })));
      await sb.from("source_product_score").upsert(
        { source_product_id: sp.id, score: row.score.score, phase, decay: row.score.decay },
        { onConflict: "source_product_id" });
      scored += 1;
    }
    if (runId) await sb.from("sourcing_run").update(
      { fetched: products.length, scored, finished_at: new Date().toISOString() }).eq("id", runId);
    return { fetched: products.length, scored };
  } catch (err) {
    // Fail visibly (rule 12): record the error on the run row, then rethrow.
    if (runId) await sb.from("sourcing_run").update(
      { error: String(err), finished_at: new Date().toISOString() }).eq("id", runId);
    throw err;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/sourcing/ingest.test.ts`
Expected: PASS (2). (Only the pure exports are tested; `runSourcingIngest` I/O is covered by the cron smoke in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add app/lib/sourcing/ingest.server.ts app/lib/sourcing/ingest.test.ts
git commit -m "feat(sourcing): ingest transform + runner with visible-failure audit"
```

---

## Task 6: Cron route — nightly ingest

**Files:**
- Create: `app/routes/cron.sourcing.tsx`
- Reference: `app/routes/cron.import.tsx` (secret-guard pattern)

- [ ] **Step 1: Read the existing cron auth pattern**

Read `app/routes/cron.import.tsx` — copy its secret-guard (e.g. `CRON_SECRET` header/`?key=` check) verbatim so this route matches the repo's cron convention.

- [ ] **Step 2: Write the route**

```tsx
// app/routes/cron.sourcing.tsx
// Nightly viral-product ingest (low-API). Mirrors cron.import's secret guard.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { runSourcingIngest } from "~/lib/sourcing/ingest.server";

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(request.url);
  return (
    request.headers.get("authorization") === `Bearer ${secret}` ||
    url.searchParams.get("key") === secret
  );
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!authorized(request)) return new Response("forbidden", { status: 403 });
  const result = await runSourcingIngest();
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
```

> **Match, don't guess:** if `cron.import.tsx` uses a different env name or header than `CRON_SECRET`, use that exact one here. Add the cron schedule wherever the repo registers crons (e.g. `vercel.json` `crons`, matching `cron.import`).

- [ ] **Step 3: Verify locally**

Run the dev server, then:
`curl -s -H "authorization: Bearer $CRON_SECRET" http://localhost:3000/cron/sourcing`
Expected: `{"fetched":2,"scored":2}` (fixture provider); a `sourcing_run` row with `finished_at` set; `source_product`/`source_product_score` populated.

- [ ] **Step 4: Commit**

```bash
git add app/routes/cron.sourcing.tsx
git commit -m "feat(sourcing): nightly cron.sourcing ingest route"
```

---

## Task 7: Read model + pick orchestration

**Files:**
- Create: `app/lib/sourcing/discover.server.ts`
- Test: `app/lib/sourcing/discover.test.ts`

`pickProduct` is the money path: it reuses the confirmed `createProduct(shopId, ProductInput)` and `generateStore({shopId, mode:"catalog"})` signatures, writes `product_media.external_url` (since `createProduct` doesn't handle media), and links the pick.

- [ ] **Step 1: Write the failing test (orchestration order, deps injected)**

```typescript
// app/lib/sourcing/discover.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildProductInput } from "./discover.server";
import type { NormalizedSourceProduct } from "./types";

const src: NormalizedSourceProduct = {
  provider: "fixture", externalId: "fx-1", title: "Mini Blender", category: "Kitchen",
  imageUrls: ["https://x/1.jpg", "https://x/2.jpg"], unitCostCents: 800, moq: 1, leadTimeDays: 9,
  supplier: { provider: "fixture", externalSupplierId: "sup-a", name: "HomeGoods", reliabilityScore: 0.9 },
  signals: [],
};

describe("buildProductInput", () => {
  it("creates an active product with a single priced+sourced variant", () => {
    const input = buildProductInput(src);
    expect(input.status).toBe("active");
    expect(input.vendor).toBe("HomeGoods");
    expect(input.variants).toHaveLength(1);
    expect(input.variants[0].unitCostCents).toBe(800);
    expect(input.variants[0].retailPriceCents).toBe(2000); // 2.5x
    expect(input.variants[0].requiresShipping).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/sourcing/discover.test.ts`
Expected: FAIL — cannot find module `./discover.server`.

- [ ] **Step 3: Write the read model + pick**

```typescript
// app/lib/sourcing/discover.server.ts
import { getSupabase } from "~/lib/supabase.server";
import { createProduct } from "~/lib/catalog/catalog.server";
import { generateStore } from "~/lib/storegen/generate.server";
import type { ProductInput } from "~/lib/catalog/types";
import { suggestedRetailCents } from "./ingest.server";
import type { DiscoverFeedItem, NormalizedSourceProduct, PickResult } from "./types";

/** Pure: map a viral source product to the owned-catalog ProductInput. */
export function buildProductInput(src: NormalizedSourceProduct): ProductInput {
  const retail = suggestedRetailCents(src.unitCostCents);
  return {
    title: src.title,
    status: "active",
    vendor: src.supplier.name,
    category: src.category ?? undefined,
    description: undefined,
    tags: [],
    variants: [
      {
        title: "Default",
        retailPriceCents: retail,
        unitCostCents: src.unitCostCents,
        inventoryTracked: false,
        requiresShipping: true,
        weightGrams: 0,
      },
    ],
  };
}

/** Global read: ranked feed (source_product ⨝ latest score ⨝ supplier). */
export async function listDiscoverFeed(limit = 40): Promise<DiscoverFeedItem[]> {
  const { data, error } = await getSupabase()
    .from("source_product_score")
    .select(
      "score, source_product:source_product_id(id, title, category, image_urls, unit_cost_cents, lead_time_days, supplier:supplier_id(name, reliability_score))",
    )
    .order("score", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return (data ?? []).flatMap((row: Record<string, any>) => {
    const p = row.source_product;
    if (!p) return [];
    const retail = suggestedRetailCents(p.unit_cost_cents);
    return [{
      sourceProductId: String(p.id),
      title: String(p.title),
      category: p.category ?? null,
      imageUrl: (p.image_urls ?? [])[0] ?? null,
      unitCostCents: Number(p.unit_cost_cents),
      suggestedRetailCents: retail,
      marginPct: retail > 0 ? (retail - p.unit_cost_cents) / retail : 0,
      leadTimeDays: Number(p.lead_time_days),
      supplierName: p.supplier?.name ?? "Unknown",
      supplierReliability: p.supplier?.reliability_score ?? null,
      score: Number(row.score),
    }] as DiscoverFeedItem[];
  });
}

/** Pick: write owned product + media + link, then generate a draft store. */
export async function pickProduct(shopId: string, sourceProductId: string): Promise<PickResult> {
  const sb = getSupabase();
  const { data: src, error } = await sb
    .from("source_product")
    .select("id, title, category, image_urls, unit_cost_cents, moq, lead_time_days, provider, external_id, supplier_id, supplier:supplier_id(provider, external_supplier_id, name, reliability_score)")
    .eq("id", sourceProductId)
    .maybeSingle();
  if (error) throw error;
  if (!src) throw new Error(`source product ${sourceProductId} not found`);

  const normalized: NormalizedSourceProduct = {
    provider: src.provider, externalId: src.external_id, title: src.title,
    category: src.category, imageUrls: src.image_urls ?? [], unitCostCents: src.unit_cost_cents,
    moq: src.moq, leadTimeDays: src.lead_time_days,
    supplier: {
      provider: (src as any).supplier?.provider ?? src.provider,
      externalSupplierId: (src as any).supplier?.external_supplier_id ?? "",
      name: (src as any).supplier?.name ?? "Supplier",
      reliabilityScore: (src as any).supplier?.reliability_score ?? null,
    },
    signals: [],
  };

  // 1. Owned catalog product (reuses the validated write-path).
  const { id: productId } = await createProduct(shopId, buildProductInput(normalized));

  // 2. Media — createProduct does NOT write media; hotlink supplier images
  //    via product_media.external_url (the storefront reads these).
  if (normalized.imageUrls.length) {
    const { error: mErr } = await sb.from("product_media").insert(
      normalized.imageUrls.map((url, i) => ({
        product_id: productId, external_url: url, position: i, is_primary: i === 0,
      })));
    if (mErr) throw mErr;
  }

  // 3. Shop-scoped link back to the global source + supplier.
  const { error: lErr } = await sb.from("sourced_product_link").insert({
    shop_id: shopId, product_id: productId, source_product_id: sourceProductId, supplier_id: src.supplier_id,
  });
  if (lErr) throw lErr;

  // 4. Auto-build a draft store from the now-non-empty catalog.
  const gen = await generateStore({ shopId, mode: "catalog" });
  return { productId, storeRunId: gen.runId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/sourcing/discover.test.ts`
Expected: PASS (1).

- [ ] **Step 5: Commit**

```bash
git add app/lib/sourcing/discover.server.ts app/lib/sourcing/discover.test.ts
git commit -m "feat(sourcing): Discover read model + pick->catalog->store orchestration"
```

---

## Task 8: Dashboard API route — feed + pick

**Files:**
- Create: `app/routes/dashboard.api.discover.tsx`
- Reference: `app/routes/dashboard.api.store.tsx` (loader/action + auth shape)

- [ ] **Step 1: Write the route**

```tsx
// app/routes/dashboard.api.discover.tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, requireSameOrigin } from "~/lib/dashboard/http.server";
import { listDiscoverFeed, pickProduct } from "~/lib/sourcing/discover.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireDashboardSession(request); // auth gate; the feed is global reference data
  return dashboardJson(async () => ({ items: await listDiscoverFeed(40) }));
}

export async function action({ request }: ActionFunctionArgs) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const body = (await request.json().catch(() => null)) as { action?: string; sourceProductId?: string } | null;
  if (body?.action !== "pick" || !body.sourceProductId) return jsonError(422, "bad_request", "pick requires sourceProductId");

  return dashboardJson(async () => await pickProduct(session.shopId, body.sourceProductId!));
}
```

> **Match, don't guess:** confirm against `dashboard.api.store.tsx` that `requireSameOrigin` is used as a RETURN-the-response guard (per `http.server.ts`) vs a throwing one, and that `requireDashboardSession` returns an object with `.shopId`. Mirror that file exactly.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Verify the endpoint**

Dev server + an authenticated session cookie:
`curl -s -b <session-cookie> http://localhost:3000/dashboard/api/discover` → `{"items":[...]}` ranked by score.
POST `{"action":"pick","sourceProductId":"<id>"}` with the Origin header → `{"productId":"...","storeRunId":"..."}`, and the catalog now shows the product.

- [ ] **Step 4: Commit**

```bash
git add app/routes/dashboard.api.discover.tsx
git commit -m "feat(sourcing): dashboard.api.discover loader (feed) + action (pick)"
```

---

## Task 9: Client fetchers

**Files:**
- Create: `app/lib/dashboard/discover-client.ts`
- Reference: `app/lib/dashboard/store-client.ts` (`apiGet`/`apiSend` shape)

- [ ] **Step 1: Write the client**

```typescript
// app/lib/dashboard/discover-client.ts
import { apiGet, apiSend } from "./client";
import type { DiscoverFeedItem, PickResult } from "~/lib/sourcing/types";

export interface DiscoverState { items: DiscoverFeedItem[] }

export const fetchDiscover = () => apiGet<DiscoverState>("/dashboard/api/discover");

export const pickDiscoverProduct = (sourceProductId: string) =>
  apiSend<PickResult>("/dashboard/api/discover", { action: "pick", sourceProductId });
```

> **Match, don't guess:** confirm `apiGet`/`apiSend` names + generic signatures in `app/lib/dashboard/client.ts` (memory: `apiGet`/`apiSend` exist and add the CSRF `Origin` header). If `apiSend` takes `(path, body)` vs `(path, { body })`, match it.

- [ ] **Step 2: Typecheck & commit**

Run: `npm run typecheck` → exit 0.
```bash
git add app/lib/dashboard/discover-client.ts
git commit -m "feat(sourcing): discover-client fetchers"
```

---

## Task 10: Discover screen (the ranked feed UI)

**Files:**
- Create: `app/components/dashboard/screens/Discover.tsx`
- Reference: `screens/Catalog.tsx` (`cd-tablehd`/`cd-trow` rows), `ui.tsx` (`Card`, `Btn`, `Placeholder`, `TableSkeleton`, `ScorePill`, `Pill`)

- [ ] **Step 1: Write the screen**

```tsx
// app/components/dashboard/screens/Discover.tsx
// Ranked viral-product feed — the Store Builder's cold-start front door.
// Seeds from the screen cache for instant paint, then refetches.
import { useEffect, useState } from "react";
import type { DashboardApp } from "../context";
import { Card, Btn, Placeholder, TableSkeleton, ScorePill } from "../ui";
import { CDIcon } from "../icons";
import { cachedScreenData, cacheScreenData, SCREEN_CACHE_KEYS } from "~/lib/dashboard/screen-cache";
import { fetchDiscover, pickDiscoverProduct, type DiscoverState } from "~/lib/dashboard/discover-client";

const money = (c: number) => `$${(c / 100).toFixed(2)}`;

export default function Discover({ app }: { app: DashboardApp }) {
  const [data, setData] = useState<DiscoverState | null>(() =>
    cachedScreenData<DiscoverState>(SCREEN_CACHE_KEYS.discover));
  const [picking, setPicking] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetchDiscover().then((s) => { if (live) { cacheScreenData(SCREEN_CACHE_KEYS.discover, s); setData(s); } }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function pick(id: string) {
    setPicking(id);
    try {
      await pickDiscoverProduct(id);
      app.toast?.("Product added — building your store…");
      app.navigate("storefront"); // land on the Store builder with the new draft
    } catch {
      app.toast?.("Could not add that product");
    } finally {
      setPicking(null);
    }
  }

  if (!data) return <TableSkeleton />;
  if (!data.items.length) {
    return <Placeholder icon="sparkle" title="No trending products yet"
      sub="The nightly sourcing run hasn't populated the feed. Check back shortly." />;
  }

  return (
    <Card pad={false}>
      <div className="cd-tablehd" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto" }}>
        <span>Product</span><span>Virality</span><span>Cost</span><span>Suggested</span><span>Margin</span><span></span>
      </div>
      {data.items.map((it) => (
        <div key={it.sourceProductId} className="cd-trow" style={{ gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr auto" }}>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {it.imageUrl && <img src={it.imageUrl} alt="" width={28} height={28} style={{ borderRadius: 6, objectFit: "cover" }} />}
            <span>{it.title}<small style={{ display: "block", opacity: 0.6 }}>{it.supplierName} · {it.leadTimeDays}d</small></span>
          </span>
          <span><ScorePill score={it.score} /></span>
          <span>{money(it.unitCostCents)}</span>
          <span>{money(it.suggestedRetailCents)}</span>
          <span>{Math.round(it.marginPct * 100)}%</span>
          <span>
            <Btn small kind="primary" icon="sparkle" onClick={() => pick(it.sourceProductId)} disabled={picking === it.sourceProductId}>
              {picking === it.sourceProductId ? "Adding…" : "Sell this"}
            </Btn>
          </span>
        </div>
      ))}
    </Card>
  );
}
```

> **Match, don't guess:** confirm `ScorePill`/`Btn`/`Placeholder` prop names in `ui.tsx` (map says `Btn` has `kind`/`small`/`icon`; `Placeholder` has `icon/title/sub/actionLabel/onAction`; `ScorePill` at `:182`). Confirm `app.toast`/`app.navigate` names on `DashboardApp` (map: `navigate` at `DashboardApp.tsx:246`; toast host is `ToastHost`). Adjust to the real API — do not invent methods.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` → exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/components/dashboard/screens/Discover.tsx
git commit -m "feat(sourcing): Discover ranked-feed screen"
```

---

## Task 11: Wire Discover under the Build/Store nav + cache + cold-start entry

**Files:**
- Modify: `app/components/dashboard/context.ts` (Screen union, ~:47)
- Modify: `app/components/dashboard/routes.ts` (`seg` ~:48, `parsePath` ~:123)
- Modify: `app/components/dashboard/DashboardApp.tsx` (import ~:63, `SCREENS` ~:165, `NAV_HIGHLIGHT` ~:111)
- Modify: `app/lib/dashboard/screen-cache.ts` (`SCREEN_CACHE_KEYS` ~:70)
- Modify: `app/lib/dashboard/prefetch.ts` (`WARM_TARGETS` ~:37, import ~:7)
- Modify: `app/components/dashboard/store/WelcomeOverlay.tsx` + `screens/Store.tsx` (cold-start action)

- [ ] **Step 1: Add the screen id to the union**

In `context.ts` (~:47), extend the `Screen` union:
```typescript
  | "discover"; // Viral product sourcing (BUILD group, under Store)
```

- [ ] **Step 2: Register the screen + keep Store lit**

In `DashboardApp.tsx`, add the import near the other screen imports (~:63):
```typescript
import ScreenDiscover from "./screens/Discover";
```
Add to the `SCREENS` map (~:165):
```typescript
  discover: ScreenDiscover,
```
Add to `NAV_HIGHLIGHT` (~:111) so the **Store** nav item stays highlighted on Discover:
```typescript
  discover: "storefront",
```

- [ ] **Step 3: Make `/dashboard/store/discover` deep-linkable**

In `routes.ts` `seg()` (~:48), add:
```typescript
    case "discover": return "store/discover";
```
In `parsePath()`, change the `case "store":` block (~:123) to accept the child:
```typescript
    case "store":
      if (!b) return { screen: "storefront", param: null, sub: null };
      if (b === "discover") return { screen: "discover", param: null, sub: null };
      return null;
```

- [ ] **Step 4: Add the cache key + warm target**

In `screen-cache.ts` `SCREEN_CACHE_KEYS` (~:70):
```typescript
  discover: "discover",
```
In `prefetch.ts`, import the fetcher (~:7) and add a warm target (~:37):
```typescript
import { fetchDiscover } from "~/lib/dashboard/discover-client";
// …inside WARM_TARGETS:
  [SCREEN_CACHE_KEYS.discover, fetchDiscover],
```

- [ ] **Step 5: Add the cold-start entry point (the "under Store Builder" hook)**

In `store/WelcomeOverlay.tsx`, add a third primary action alongside the existing build actions — a "Find a viral product to sell" button. In `Store.tsx` (~:516-559, where `onWelcomeBuildPlain`/`onWelcomeAddProduct` are wired) pass a new handler:
```tsx
onWelcomeDiscover={() => app.navigate("discover")}
```
And render it in `WelcomeOverlay.tsx` next to the other CTAs:
```tsx
<button className="cd-welcome-cta" onClick={onWelcomeDiscover}>
  <CDIcon name="sparkle" /> Find a viral product to sell
</button>
```

> **Match, don't guess:** open `WelcomeOverlay.tsx` and copy the existing CTA markup/prop-threading exactly (the map shows `onWelcomeBuildPlain`/`onWelcomeBuildWithVibe`/`onWelcomeAddProduct` at `Store.tsx:516-559`). Add `onWelcomeDiscover` to its props interface the same way.

- [ ] **Step 6: Typecheck, lint, verify the flow**

Run: `npm run typecheck` → exit 0.
Run: `npm run lint` → exit 0 (no new warnings on touched files).
Manual: sign in with a no-catalog shop → the Store `WelcomeOverlay` shows "Find a viral product to sell" → click routes to `/dashboard/store/discover` (Store nav lit) → the ranked feed renders → "Sell this" adds the product and lands back on the Store builder with a generated draft.

- [ ] **Step 7: Commit**

```bash
git add app/components/dashboard/context.ts app/components/dashboard/routes.ts app/components/dashboard/DashboardApp.tsx app/lib/dashboard/screen-cache.ts app/lib/dashboard/prefetch.ts app/components/dashboard/store/WelcomeOverlay.tsx app/components/dashboard/screens/Store.tsx
git commit -m "feat(sourcing): nest Discover under Store Builder (nav, deep-link, cache, cold-start CTA)"
```

---

## Task 12: Full-suite verification (pre-commit gate)

**Files:** none (verification only)

- [ ] **Step 1: Run the eval pipeline in order**

```bash
npm run typecheck   # exit 0
npm run lint        # exit 0 (--max-warnings=0 on new code)
npm run test        # vitest run — all green, incl. the new sourcing tests
npm run build       # Remix + Vite build completes (runs verify:client-bundle)
```
Expected: every step exit 0. Paste the results (rule 12 — do not assert success without evidence).

- [ ] **Step 2: Drive the feature end-to-end (verification-before-completion)**

Trigger `cron.sourcing` (fixture provider) → confirm the feed populates → open Discover under Store → pick a product → confirm: an `active` `product_dim` row exists, `product_media.external_url` rows exist, a `sourced_product_link` row exists, and a store draft was generated (`store_generation`/`generateStore` runId returned). Screenshot the ranked feed.

- [ ] **Step 3: Final commit (if any fixups)**

```bash
git add -A && git commit -m "chore(sourcing): verification fixups"
```

---

## Self-review (completed against the spec)

- **Spec coverage:** nightly low-API ingest (T5/T6) · deterministic scorer + 2000-user gate (T4) · provider-blind `SupplierAdapter` + Zendrop/CJ/AliExpress seam (T2/T3, CJ concrete + fixture) · global reference tables + shop-scoped link (T1) · Discover screen **under Store Builder** (T10/T11) · pick → `createProduct` + `product_media.external_url` + `sourced_product_link` + `generateStore` (T7) · saturation/decay in-score (T4) · fail-visibly audit (T5). Not covered by design: `#17.fulfillment` (deferred — needs #10/#2/#3) and the Phase-2 own-data reweight (gate only; needs ≥2000 users + sales data).
- **Type consistency:** `NormalizedSourceProduct`/`DiscoverFeedItem`/`PickResult` defined once in `types.ts` and consumed everywhere; `createProduct(shopId, ProductInput)→{id}` and `generateStore({shopId, mode})→{runId,…}` used per their real signatures; `SCREEN_CACHE_KEYS.discover` referenced consistently.
- **Provider caveat (logged, not silent):** ships on the **fixture** provider so it is testable offline; the **CJ** adapter is the first real provider and is swapped in via `SOURCING_PROVIDER=cj` + `CJ_ACCESS_TOKEN`. Zendrop/AliExpress are additional adapters behind the same interface (not built here).
- **Known limitation (surface, don't hide — rule 12):** the dashboard **Catalog** list keys its thumbnail on `product_media.storage_path` (uploads); a sourced product's images are `external_url` hotlinks, so its Catalog thumbnail is blank until a follow-up extends that select (or `#9` mirrors the image). The **storefront** renders `external_url` correctly. Flagged for the engineer.

---

## Execution handoff

Two options:
1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks.
2. **Inline Execution** — batch execution in this session with checkpoints.
