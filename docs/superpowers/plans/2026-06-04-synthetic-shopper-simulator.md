# Synthetic Shopper Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an embedded-admin route `/app/simulator` that runs LLM-driven shopper personas through the merchant's live store and shows a funnel-first conversion teardown ("290 of 470 bounced at the shipping reveal") before any ad spend.

**Architecture:** Two-tier engine. On **Run**, the server fetches real storefront pages + shipping rate, then makes ONE structured Claude call that returns a *behavior model* (≈8 store-tailored archetypes, per-stage advance probabilities, friction findings, suggested fixes). That model is persisted. A pure, isomorphic Monte Carlo sampler then scales the model to any N (10–1,000) — instantly and with zero extra API calls — so dragging the slider just re-samples in the browser.

**Tech Stack:** Remix (Vite) + `@vercel/remix`, React 18 + Shopify Polaris + App Bridge, `@anthropic-ai/sdk` (existing `getAnthropic()` client), Supabase (Postgres) for persistence, Vitest for tests. No new top-level dependencies.

**Refinement vs. spec:** The spec sketched an async "queued → cron → poll" run model to dodge serverless timeouts. This plan runs the simulation **synchronously inside the route action** with `export const config = { maxDuration: 60 }`, mirroring how the existing in-app Assistant already calls Claude within a request. The run is a *single* structured call (~15–30s), which fits the budget and removes polling/cron/fire-and-forget complexity. The `status` column is retained so a later move to cron-based async needs no schema change. **If you'd rather keep true async, stop and flag it before Task 9.**

---

## File Structure

```
supabase/migrations/
  20260604120000_simulation_run.sql      # new table + read view

app/lib/simulator/
  types.ts                 # FUNNEL_STAGES, BehaviorModel, Archetype, Finding, StoreSnapshot, SimulationRun, SampleResult
  sample.ts                # isomorphic Monte Carlo + seeded RNG  (pure, unit-tested)
  html-to-text.ts          # strip storefront HTML → readable text (pure, unit-tested)
  fetch-pages.server.ts    # fetch home + products.json + shipping rate → StoreSnapshot
  simulate.server.ts       # prompt + forced-tool Claude call + parse → BehaviorModel
  runs.server.ts           # simulation_run persistence + rowToRun mapper
  orchestrate.server.ts    # executeSimulation(): fetch → simulate → persist (deps injected)
  __tests__/
    sample.test.ts
    html-to-text.test.ts
    fetch-pages.test.ts
    simulate.test.ts
    runs.test.ts
    orchestrate.test.ts

app/routes/
  app.simulator.tsx        # loader + action + UI (controls, funnel, findings, persona table)
  __tests__/
    simulator-action.test.ts

app/routes/app.tsx         # MODIFY: add "Simulator" nav link
```

**Boundaries:** `sample.ts` and `html-to-text.ts` are framework-free pure modules (run in browser + Node, deterministic to test). `*.server.ts` modules hold all I/O (network, Anthropic, Supabase) behind small functions with injectable dependencies so tests never touch the network.

---

### Task 1: Supabase migration — `simulation_run` table + view

**Files:**
- Create: `supabase/migrations/20260604120000_simulation_run.sql`

- [ ] **Step 1: Write the migration SQL**

Follows the convention in `supabase/migrations/20260602120000_assistant.sql` (shop-scoped, RLS deferred — access is service-role in code).

```sql
-- simulation_run: one synthetic-shopper simulation. `model` holds the Claude-built
-- behavior model (archetypes + per-stage probabilities + findings); the slider
-- re-samples from it client-side. Shop-scoped in code (service-role); RLS deferred.

create table simulation_run (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references shops(id) on delete cascade,
  status        text not null default 'queued'
                  check (status in ('queued','running','done','error')),
  target        text not null default 'whole_store',
  requested_n   integer not null default 1000
                  check (requested_n between 10 and 1000),
  model         jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz
);

create index simulation_run_shop_created_idx
  on simulation_run (shop_id, created_at desc);

-- Read view mirrors the v_*_view convention used elsewhere (e.g. v_alerts_view).
create view v_simulation_runs as
  select id, shop_id, status, target, requested_n, model, error, created_at, completed_at
  from simulation_run;
```

- [ ] **Step 2: Apply the migration to the dev/linked Supabase project**

Use the Supabase MCP `apply_migration` tool (name: `simulation_run`, the SQL above) **or** the CLI:

Run: `npx supabase db push`
Expected: migration `20260604120000_simulation_run` applied with no error.

- [ ] **Step 3: Verify the table exists**

Use the Supabase MCP `list_tables` (expect `simulation_run` present) or:

Run: `npx supabase db push --dry-run`
Expected: "no schema changes found" (table already applied).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260604120000_simulation_run.sql
git commit -m "feat(simulator): add simulation_run table + view"
```

---

### Task 2: Domain types

**Files:**
- Create: `app/lib/simulator/types.ts`

No runtime test (types only); they are exercised by every later task's tests.

- [ ] **Step 1: Write the types**

```ts
// app/lib/simulator/types.ts

/** Ordered funnel a shopper walks. Index order is significant. */
export const FUNNEL_STAGES = [
  "landed",
  "viewed_product",
  "added_to_cart",
  "started_checkout",
  "shipping_reveal",
  "bought",
] as const;

export type FunnelStageId = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_STAGE_LABELS: Record<FunnelStageId, string> = {
  landed: "Landed",
  viewed_product: "Viewed a product",
  added_to_cart: "Added to cart",
  started_checkout: "Started checkout",
  shipping_reveal: "Shipping reveal",
  bought: "Bought",
};

export type Severity = "critical" | "high" | "low";

/** One shopper archetype the model treats as a homogeneous sub-population. */
export interface Archetype {
  id: string; // slug, e.g. "deal-hunter"
  name: string; // display, e.g. "Deal-hunter"
  weight: number; // share of the population (0..1); normalised at sample time
  /** advance[stage] = P(moving from `stage` to the NEXT stage). `bought` is terminal. */
  advance: Record<FunnelStageId, number>;
  /** Why this archetype bounces at a given stage (shown in the persona table). */
  dropReason: Partial<Record<FunnelStageId, string>>;
}

export interface Finding {
  id: string;
  severity: Severity;
  title: string; // "Shipping cost shock"
  stage: FunnelStageId; // where it bites
  personaIds: string[]; // archetype ids most affected
  fix: string; // one-line suggested fix
}

export interface BehaviorModel {
  storeSummary: string; // Claude's one-line read of the store
  shipping: { amount: number; currency: string; estimated: boolean };
  archetypes: Archetype[];
  findings: Finding[];
}

/** Real page content handed to Claude. */
export interface StoreSnapshot {
  shop: string;
  homeText: string;
  product: {
    title: string;
    descriptionText: string;
    priceText: string;
    url: string;
  } | null;
  shipping: { amount: number; currency: string; estimated: boolean };
}

export type RunStatus = "queued" | "running" | "done" | "error";

/** DTO shape returned to the client — never the raw DB row. */
export interface SimulationRun {
  id: string;
  status: RunStatus;
  target: string;
  requestedN: number;
  model: BehaviorModel | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StageCount {
  id: FunnelStageId;
  label: string;
  reached: number;
}

export interface SampleResult {
  n: number;
  stages: StageCount[];
  bought: number;
  biggestLeak: { stageId: FunnelStageId; label: string; count: number } | null;
  findingCounts: Record<string, number>; // findingId -> affected shoppers
}

export const MIN_SHOPPERS = 10;
export const MAX_SHOPPERS = 1000;
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add app/lib/simulator/types.ts
git commit -m "feat(simulator): add domain types"
```

---

### Task 3: Monte Carlo sampler (`sample.ts`)

**Files:**
- Create: `app/lib/simulator/sample.ts`
- Test: `app/lib/simulator/__tests__/sample.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/sample.test.ts
import { describe, it, expect } from "vitest";
import { sampleFunnel, mulberry32, seedFromString } from "../sample";
import { FUNNEL_STAGES, type BehaviorModel } from "../types";

const model: BehaviorModel = {
  storeSummary: "test store",
  shipping: { amount: 9.95, currency: "USD", estimated: false },
  archetypes: [
    {
      id: "a",
      name: "A",
      weight: 0.5,
      advance: {
        landed: 1, viewed_product: 1, added_to_cart: 1,
        started_checkout: 1, shipping_reveal: 0, bought: 1,
      },
      dropReason: { shipping_reveal: "too pricey" },
    },
    {
      id: "b",
      name: "B",
      weight: 0.5,
      advance: {
        landed: 1, viewed_product: 1, added_to_cart: 1,
        started_checkout: 1, shipping_reveal: 1, bought: 1,
      },
      dropReason: {},
    },
  ],
  findings: [
    { id: "f1", severity: "critical", title: "Shipping", stage: "shipping_reveal", personaIds: ["a"], fix: "free ship" },
  ],
};

describe("mulberry32", () => {
  it("is deterministic for a fixed seed", () => {
    const r1 = mulberry32(123);
    const r2 = mulberry32(123);
    expect(r1()).toBe(r2());
    expect(r1()).toBe(r2());
  });
});

describe("sampleFunnel", () => {
  it("is deterministic for the same (model, n, seed)", () => {
    const a = sampleFunnel(model, 1000, 42);
    const b = sampleFunnel(model, 1000, 42);
    expect(a).toEqual(b);
  });

  it("starts with everyone landed and never increases down the funnel", () => {
    const res = sampleFunnel(model, 1000, 42);
    expect(res.stages[0].reached).toBe(1000);
    for (let i = 1; i < res.stages.length; i++) {
      expect(res.stages[i].reached).toBeLessThanOrEqual(res.stages[i - 1].reached);
    }
    expect(res.stages).toHaveLength(FUNNEL_STAGES.length);
  });

  it("respects probabilities at scale: ~half bounce at shipping (archetype A)", () => {
    const res = sampleFunnel(model, 1000, 42);
    // A (50% of pop) always bounces at shipping_reveal; B always buys.
    expect(res.bought).toBeGreaterThan(420);
    expect(res.bought).toBeLessThan(580);
    const leak = res.biggestLeak!;
    expect(leak.stageId).toBe("shipping_reveal");
    expect(res.findingCounts.f1).toBeGreaterThan(420);
  });

  it("seedFromString is stable and unsigned", () => {
    expect(seedFromString("run-123")).toBe(seedFromString("run-123"));
    expect(seedFromString("run-123")).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/sample.test.ts`
Expected: FAIL — "Cannot find module '../sample'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/sample.ts
import {
  FUNNEL_STAGES,
  FUNNEL_STAGE_LABELS,
  type BehaviorModel,
  type SampleResult,
} from "./types";

/** Small fast deterministic PRNG. Same seed ⇒ same stream (stable slider + exact tests). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a → unsigned 32-bit, used to seed a run deterministically from its id. */
export function seedFromString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function sampleFunnel(model: BehaviorModel, n: number, seed: number): SampleResult {
  const rng = mulberry32(seed);
  const archetypes = model.archetypes.length
    ? model.archetypes
    : [
        {
          id: "default",
          name: "Shopper",
          weight: 1,
          // Object.fromEntries loses key typing; this asserts the funnel-keyed shape.
          advance: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 1])) as Record<
            (typeof FUNNEL_STAGES)[number],
            number
          >,
          dropReason: {},
        },
      ];
  const totalWeight = archetypes.reduce((s, a) => s + Math.max(0, a.weight), 0) || 1;

  const reached = new Array(FUNNEL_STAGES.length).fill(0);
  const dropsByStagePersona = new Map<string, number>(); // `${stageId}|${archetypeId}` -> count

  for (let i = 0; i < n; i++) {
    // pick archetype by weight
    let r = rng() * totalWeight;
    let chosen = archetypes[0];
    for (const a of archetypes) {
      r -= Math.max(0, a.weight);
      if (r <= 0) {
        chosen = a;
        break;
      }
    }
    // walk the funnel
    reached[0]++;
    for (let stageIdx = 0; stageIdx < FUNNEL_STAGES.length - 1; stageIdx++) {
      const stageId = FUNNEL_STAGES[stageIdx];
      const p = clamp01(chosen.advance?.[stageId] ?? 0);
      if (rng() < p) {
        reached[stageIdx + 1]++;
      } else {
        const key = `${stageId}|${chosen.id}`;
        dropsByStagePersona.set(key, (dropsByStagePersona.get(key) ?? 0) + 1);
        break;
      }
    }
  }

  const stages = FUNNEL_STAGES.map((id, i) => ({
    id,
    label: FUNNEL_STAGE_LABELS[id],
    reached: reached[i],
  }));

  let biggestLeak: SampleResult["biggestLeak"] = null;
  for (let i = 0; i < FUNNEL_STAGES.length - 1; i++) {
    const count = reached[i] - reached[i + 1];
    if (count > 0 && (!biggestLeak || count > biggestLeak.count)) {
      biggestLeak = {
        stageId: FUNNEL_STAGES[i],
        label: FUNNEL_STAGE_LABELS[FUNNEL_STAGES[i]],
        count,
      };
    }
  }

  const findingCounts: Record<string, number> = {};
  for (const f of model.findings) {
    let c = 0;
    for (const pid of f.personaIds) {
      c += dropsByStagePersona.get(`${f.stage}|${pid}`) ?? 0;
    }
    findingCounts[f.id] = c;
  }

  return {
    n,
    stages,
    bought: reached[FUNNEL_STAGES.length - 1],
    biggestLeak,
    findingCounts,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/sample.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/sample.ts app/lib/simulator/__tests__/sample.test.ts
git commit -m "feat(simulator): add deterministic Monte Carlo funnel sampler"
```

---

### Task 4: HTML→text utility

**Files:**
- Create: `app/lib/simulator/html-to-text.ts`
- Test: `app/lib/simulator/__tests__/html-to-text.test.ts`

Dependency-free (no cheerio/parser dep) — strip scripts/styles/tags, decode a few entities, collapse whitespace, truncate.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/html-to-text.test.ts
import { describe, it, expect } from "vitest";
import { htmlToText } from "../html-to-text";

describe("htmlToText", () => {
  it("strips tags and collapses whitespace", () => {
    const html = "<h1>Hello</h1>\n\n  <p>World <strong>now</strong></p>";
    expect(htmlToText(html)).toBe("Hello World now");
  });

  it("drops script and style content entirely", () => {
    const html = "<style>.a{color:red}</style><p>Keep</p><script>alert(1)</script>";
    expect(htmlToText(html)).toBe("Keep");
  });

  it("decodes common entities", () => {
    expect(htmlToText("<p>Tom &amp; Jerry &mdash; 50%&nbsp;off</p>")).toBe("Tom & Jerry — 50% off");
  });

  it("truncates to maxLen", () => {
    const out = htmlToText("<p>" + "x".repeat(100) + "</p>", 10);
    expect(out.length).toBe(10);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/html-to-text.test.ts`
Expected: FAIL — "Cannot find module '../html-to-text'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/html-to-text.ts

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
};

/** Best-effort HTML → readable text. Not a full parser; good enough to feed an LLM. */
export function htmlToText(html: string, maxLen = 4000): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&[a-z]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/html-to-text.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/html-to-text.ts app/lib/simulator/__tests__/html-to-text.test.ts
git commit -m "feat(simulator): add dependency-free html-to-text util"
```

---

### Task 5: Fetch real store pages + shipping (`fetch-pages.server.ts`)

**Files:**
- Create: `app/lib/simulator/fetch-pages.server.ts`
- Test: `app/lib/simulator/__tests__/fetch-pages.test.ts`

Fetches the live storefront home page and `products.json` (public; gives a real product handle, title, body_html, price with no Admin scope), and reads a representative shipping rate from Admin `deliveryProfiles`. All I/O is injected (`fetchImpl`, `admin`) so tests never hit the network. `pickShippingRate` is a pure helper, tested directly.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/fetch-pages.test.ts
import { describe, it, expect, vi } from "vitest";
import { fetchSnapshot, pickShippingRate } from "../fetch-pages.server";

const PRODUCTS_JSON = JSON.stringify({
  products: [
    {
      title: "Wool Beanie",
      handle: "wool-beanie",
      body_html: "<p>Warm &amp; cozy</p>",
      variants: [{ price: "29.00" }],
    },
  ],
});

function fakeFetch(map: Record<string, { ok: boolean; body: string }>) {
  return vi.fn(async (url: string) => {
    const hit = map[url];
    if (!hit) return { ok: false, status: 404, text: async () => "" } as unknown as Response;
    return { ok: hit.ok, status: hit.ok ? 200 : 500, text: async () => hit.body } as unknown as Response;
  });
}

const shippingData = {
  deliveryProfiles: {
    nodes: [
      {
        profileLocationGroups: [
          {
            locationGroupZones: {
              nodes: [
                {
                  methodDefinitions: {
                    nodes: [
                      { active: true, rateProvider: { __typename: "DeliveryRateDefinition", price: { amount: "9.95", currencyCode: "USD" } } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  },
};

describe("pickShippingRate", () => {
  it("returns the lowest active flat rate", () => {
    expect(pickShippingRate(shippingData)).toEqual({ amount: 9.95, currency: "USD", estimated: false });
  });

  it("falls back to an estimate when no flat rate is found", () => {
    expect(pickShippingRate({ deliveryProfiles: { nodes: [] } })).toEqual({
      amount: 7.95,
      currency: "USD",
      estimated: true,
    });
  });
});

describe("fetchSnapshot", () => {
  it("builds a snapshot from home + products.json + shipping", async () => {
    const fetchImpl = fakeFetch({
      "https://acme.myshopify.com/": { ok: true, body: "<h1>Best socks</h1>" },
      "https://acme.myshopify.com/products.json?limit=5": { ok: true, body: PRODUCTS_JSON },
    });
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ data: shippingData }) })) };

    const snap = await fetchSnapshot("acme.myshopify.com", { fetchImpl: fetchImpl as never, admin: admin as never });

    expect(snap.homeText).toBe("Best socks");
    expect(snap.product).toEqual({
      title: "Wool Beanie",
      descriptionText: "Warm & cozy",
      priceText: "29.00",
      url: "https://acme.myshopify.com/products/wool-beanie",
    });
    expect(snap.shipping).toEqual({ amount: 9.95, currency: "USD", estimated: false });
  });

  it("tolerates products.json being disabled (product = null)", async () => {
    const fetchImpl = fakeFetch({
      "https://acme.myshopify.com/": { ok: true, body: "<h1>Hi</h1>" },
    });
    const admin = { graphql: vi.fn(async () => ({ json: async () => ({ data: shippingData }) })) };

    const snap = await fetchSnapshot("acme.myshopify.com", { fetchImpl: fetchImpl as never, admin: admin as never });
    expect(snap.product).toBeNull();
    expect(snap.homeText).toBe("Hi");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/fetch-pages.test.ts`
Expected: FAIL — "Cannot find module '../fetch-pages.server'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/fetch-pages.server.ts
import { unauthenticated } from "../../shopify.server";
import { htmlToText } from "./html-to-text";
import type { StoreSnapshot } from "./types";

type AdminClient = Awaited<ReturnType<typeof unauthenticated.admin>>["admin"];

export interface FetchDeps {
  fetchImpl: typeof fetch;
  admin: Pick<AdminClient, "graphql">;
}

const DEFAULT_SHIPPING = { amount: 7.95, currency: "USD", estimated: true } as const;

const SHIPPING_QUERY = `#graphql
  query SimShippingRates {
    deliveryProfiles(first: 1) {
      nodes {
        profileLocationGroups {
          locationGroupZones(first: 5) {
            nodes {
              methodDefinitions(first: 10) {
                nodes {
                  active
                  rateProvider {
                    __typename
                    ... on DeliveryRateDefinition { price { amount currencyCode } }
                  }
                }
              }
            }
          }
        }
      }
    }
  }`;

// Hand-typed (this repo types Admin responses by hand — see ingest/shopify-admin.server.ts).
type ShippingData = {
  deliveryProfiles: {
    nodes: Array<{
      profileLocationGroups: Array<{
        locationGroupZones: {
          nodes: Array<{
            methodDefinitions: {
              nodes: Array<{
                active: boolean;
                rateProvider:
                  | { __typename: "DeliveryRateDefinition"; price: { amount: string; currencyCode: string } }
                  | { __typename: string };
              }>;
            };
          }>;
        };
      }>;
    }>;
  };
};

/** Lowest active flat-rate shipping price, or a labeled estimate. Pure (unit-tested). */
export function pickShippingRate(data: ShippingData): StoreSnapshot["shipping"] {
  const rates: Array<{ amount: number; currency: string }> = [];
  for (const profile of data.deliveryProfiles.nodes) {
    for (const group of profile.profileLocationGroups) {
      for (const zone of group.locationGroupZones.nodes) {
        for (const md of zone.methodDefinitions.nodes) {
          const rp = md.rateProvider;
          if (md.active && rp.__typename === "DeliveryRateDefinition") {
            const price = (rp as { price: { amount: string; currencyCode: string } }).price;
            rates.push({ amount: Number(price.amount), currency: price.currencyCode });
          }
        }
      }
    }
  }
  if (rates.length === 0) return { ...DEFAULT_SHIPPING };
  rates.sort((a, b) => a.amount - b.amount);
  return { amount: rates[0].amount, currency: rates[0].currency, estimated: false };
}

async function getText(fetchImpl: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export async function fetchSnapshot(shop: string, deps?: Partial<FetchDeps>): Promise<StoreSnapshot> {
  const fetchImpl = deps?.fetchImpl ?? fetch;
  const admin = deps?.admin ?? (await unauthenticated.admin(shop)).admin;
  const base = `https://${shop}`;

  const homeHtml = (await getText(fetchImpl, `${base}/`)) ?? "";
  const homeText = htmlToText(homeHtml);

  let product: StoreSnapshot["product"] = null;
  const productsRaw = await getText(fetchImpl, `${base}/products.json?limit=5`);
  if (productsRaw) {
    try {
      const parsed = JSON.parse(productsRaw) as {
        products?: Array<{ title: string; handle: string; body_html?: string; variants?: Array<{ price?: string }> }>;
      };
      const p = parsed.products?.[0];
      if (p) {
        product = {
          title: p.title,
          descriptionText: htmlToText(p.body_html ?? "", 2000),
          priceText: p.variants?.[0]?.price ?? "",
          url: `${base}/products/${p.handle}`,
        };
      }
    } catch {
      product = null;
    }
  }

  let shipping = { ...DEFAULT_SHIPPING };
  try {
    const resp = await admin.graphql(SHIPPING_QUERY);
    const body = (await resp.json()) as { data?: ShippingData; errors?: unknown };
    if (!body.errors && body.data) shipping = pickShippingRate(body.data);
  } catch {
    // keep labeled estimate
  }

  return { shop, homeText, product, shipping };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/fetch-pages.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/fetch-pages.server.ts app/lib/simulator/__tests__/fetch-pages.test.ts
git commit -m "feat(simulator): fetch storefront pages + representative shipping rate"
```

---

### Task 6: Claude behavior-model builder (`simulate.server.ts`)

**Files:**
- Create: `app/lib/simulator/simulate.server.ts`
- Test: `app/lib/simulator/__tests__/simulate.test.ts`

One structured Claude call using a **forced tool** (`tool_choice`) so the reply is reliable JSON, matching the repo's tool-use idiom. `parseBehaviorModel` normalizes/validates the tool input and is unit-tested directly. The Anthropic call is injected as `createMessage` so the test never hits the API.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/simulate.test.ts
import { describe, it, expect, vi } from "vitest";
import { buildBehaviorModel, parseBehaviorModel } from "../simulate.server";
import type { StoreSnapshot } from "../types";

const snapshot: StoreSnapshot = {
  shop: "acme.myshopify.com",
  homeText: "Premium wool socks",
  product: { title: "Wool Beanie", descriptionText: "Warm", priceText: "29.00", url: "https://acme.myshopify.com/products/wool-beanie" },
  shipping: { amount: 9.95, currency: "USD", estimated: false },
};

const validInput = {
  storeSummary: "Wool accessories store",
  archetypes: [
    {
      id: "deal-hunter", name: "Deal-hunter", weight: 0.6,
      advance: { landed: 0.9, viewed_product: 0.7, added_to_cart: 0.8, started_checkout: 0.9, shipping_reveal: 0.2, bought: 1 },
      dropReason: { shipping_reveal: "shipping too high" },
    },
  ],
  findings: [
    { id: "f1", severity: "critical", title: "Shipping shock", stage: "shipping_reveal", personaIds: ["deal-hunter"], fix: "free-ship bar" },
  ],
};

function fakeMessage(toolInput: unknown) {
  return {
    content: [{ type: "tool_use", id: "t1", name: "report_simulation", input: toolInput }],
    stop_reason: "tool_use",
  };
}

describe("parseBehaviorModel", () => {
  it("accepts and passes through a valid model, attaching shipping from the snapshot", () => {
    const model = parseBehaviorModel(validInput, snapshot.shipping);
    expect(model.archetypes).toHaveLength(1);
    expect(model.archetypes[0].advance.shipping_reveal).toBe(0.2);
    expect(model.shipping).toEqual(snapshot.shipping);
    expect(model.findings[0].stage).toBe("shipping_reveal");
  });

  it("clamps out-of-range probabilities and drops malformed archetypes", () => {
    const model = parseBehaviorModel(
      { storeSummary: "x", archetypes: [{ id: "a", name: "A", weight: 2, advance: { landed: 5 }, dropReason: {} }, { name: "noid" }], findings: [] },
      snapshot.shipping,
    );
    expect(model.archetypes).toHaveLength(1);
    expect(model.archetypes[0].weight).toBeLessThanOrEqual(1);
    expect(model.archetypes[0].advance.landed).toBe(1);
  });

  it("throws when there are zero usable archetypes", () => {
    expect(() => parseBehaviorModel({ storeSummary: "x", archetypes: [], findings: [] }, snapshot.shipping)).toThrow();
  });
});

describe("buildBehaviorModel", () => {
  it("calls Claude with a forced tool and parses the tool input", async () => {
    const createMessage = vi.fn(async () => fakeMessage(validInput));
    const model = await buildBehaviorModel(snapshot, { createMessage: createMessage as never, model: "test-model" });
    expect(createMessage).toHaveBeenCalledTimes(1);
    const arg = createMessage.mock.calls[0][0] as { tool_choice?: { name: string } };
    expect(arg.tool_choice).toEqual({ type: "tool", name: "report_simulation" });
    expect(model.storeSummary).toBe("Wool accessories store");
    expect(model.archetypes[0].id).toBe("deal-hunter");
  });

  it("throws a clear error when Claude returns no tool_use block", async () => {
    const createMessage = vi.fn(async () => ({ content: [{ type: "text", text: "nope" }], stop_reason: "end_turn" }));
    await expect(
      buildBehaviorModel(snapshot, { createMessage: createMessage as never, model: "test-model" }),
    ).rejects.toThrow(/did not return/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/simulate.test.ts`
Expected: FAIL — "Cannot find module '../simulate.server'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/simulate.server.ts
import type Anthropic from "@anthropic-ai/sdk";
import {
  FUNNEL_STAGES,
  type Archetype,
  type BehaviorModel,
  type Finding,
  type FunnelStageId,
  type Severity,
  type StoreSnapshot,
} from "./types";

export type CreateMessageFn = (
  params: Anthropic.MessageCreateParamsNonStreaming,
) => Promise<Anthropic.Message>;

const TOOL_NAME = "report_simulation";
const MAX_TOKENS = 4096;
const SEVERITIES: Severity[] = ["critical", "high", "low"];

/** Forced-output tool: Claude must call this with the behavior model. */
export const REPORT_TOOL: Anthropic.Tool = {
  name: TOOL_NAME,
  description:
    "Report the simulated shopper behavior model for this store: archetypes with per-stage advance probabilities, and ranked friction findings.",
  input_schema: {
    type: "object",
    properties: {
      storeSummary: { type: "string", description: "One sentence reading of the store." },
      archetypes: {
        type: "array",
        description: "About 8 distinct shopper archetypes tailored to this store.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "kebab-case slug" },
            name: { type: "string" },
            weight: { type: "number", description: "population share 0..1" },
            advance: {
              type: "object",
              description:
                "Probability (0..1) of advancing from each stage to the next: landed, viewed_product, added_to_cart, started_checkout, shipping_reveal, bought.",
              properties: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, { type: "number" }])),
            },
            dropReason: {
              type: "object",
              description: "Short reason this archetype bounces at a stage (keyed by stage id).",
              properties: Object.fromEntries(FUNNEL_STAGES.map((s) => [s, { type: "string" }])),
            },
          },
          required: ["id", "name", "weight", "advance"],
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            severity: { type: "string", enum: SEVERITIES },
            title: { type: "string" },
            stage: { type: "string", enum: [...FUNNEL_STAGES] },
            personaIds: { type: "array", items: { type: "string" } },
            fix: { type: "string" },
          },
          required: ["id", "severity", "title", "stage", "personaIds", "fix"],
        },
      },
    },
    required: ["storeSummary", "archetypes", "findings"],
  },
};

export function buildSystemPrompt(): string {
  return [
    "You simulate a population of online shoppers walking a Shopify store and predict where they drop off.",
    "You are given the store's real homepage text, a representative product, and the shipping cost shown at checkout.",
    "Invent ~8 distinct, realistic shopper archetypes tailored to THIS store's category (e.g. deal-hunter, gift-buyer, skeptical first-timer, comparison researcher, impatient mobile shopper, loyal repeat-buyer).",
    "For each archetype, estimate the probability of advancing through each funnel stage. Be opinionated: weak value props, thin product info, and surprise shipping costs should LOWER the relevant advance probabilities.",
    "Then summarise the biggest friction points as findings, each tied to the stage and the archetypes it hurts, with a concrete fix.",
    `Always call the ${TOOL_NAME} tool.`,
  ].join("\n");
}

function buildUserMessage(s: StoreSnapshot): string {
  const product = s.product
    ? `Product: ${s.product.title}\nPrice: ${s.product.priceText}\nDescription: ${s.product.descriptionText}`
    : "No product page could be read.";
  const ship = s.shipping.estimated
    ? `Shipping at checkout: ~${s.shipping.amount} ${s.shipping.currency} (estimated)`
    : `Shipping at checkout: ${s.shipping.amount} ${s.shipping.currency}`;
  return `Store: ${s.shop}\n\nHomepage:\n${s.homeText}\n\n${product}\n\n${ship}`;
}

function clamp01(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function normalizeArchetype(raw: unknown): Archetype | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return null;
  const advanceIn = (r.advance ?? {}) as Record<string, unknown>;
  const advance = {} as Record<FunnelStageId, number>;
  for (const stage of FUNNEL_STAGES) advance[stage] = clamp01(advanceIn[stage]);
  const dropIn = (r.dropReason ?? {}) as Record<string, unknown>;
  const dropReason: Archetype["dropReason"] = {};
  for (const stage of FUNNEL_STAGES) {
    if (typeof dropIn[stage] === "string") dropReason[stage] = dropIn[stage] as string;
  }
  return { id: r.id, name: r.name, weight: clamp01(r.weight), advance, dropReason };
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;
  const stage = FUNNEL_STAGES.includes(r.stage as FunnelStageId) ? (r.stage as FunnelStageId) : "landed";
  const severity = SEVERITIES.includes(r.severity as Severity) ? (r.severity as Severity) : "low";
  const personaIds = Array.isArray(r.personaIds) ? r.personaIds.filter((x): x is string => typeof x === "string") : [];
  return { id: r.id, severity, title: r.title, stage, personaIds, fix: typeof r.fix === "string" ? r.fix : "" };
}

export function parseBehaviorModel(
  input: unknown,
  shipping: BehaviorModel["shipping"],
): BehaviorModel {
  const obj = (input ?? {}) as Record<string, unknown>;
  const archetypes = Array.isArray(obj.archetypes)
    ? obj.archetypes.map(normalizeArchetype).filter((a): a is Archetype => a !== null)
    : [];
  if (archetypes.length === 0) throw new Error("Simulation returned no usable archetypes");
  const findings = Array.isArray(obj.findings)
    ? obj.findings.map(normalizeFinding).filter((f): f is Finding => f !== null)
    : [];
  return {
    storeSummary: typeof obj.storeSummary === "string" ? obj.storeSummary : "",
    shipping,
    archetypes,
    findings,
  };
}

export async function buildBehaviorModel(
  snapshot: StoreSnapshot,
  opts: { createMessage: CreateMessageFn; model: string },
): Promise<BehaviorModel> {
  const res = await opts.createMessage({
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(),
    tools: [REPORT_TOOL],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content: buildUserMessage(snapshot) }],
  });
  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === TOOL_NAME,
  );
  if (!toolUse) throw new Error("Simulation did not return a report_simulation tool call");
  return parseBehaviorModel(toolUse.input, snapshot.shipping);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/simulate.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/simulate.server.ts app/lib/simulator/__tests__/simulate.test.ts
git commit -m "feat(simulator): build behavior model via forced-tool Claude call"
```

---

### Task 7: Run persistence (`runs.server.ts`)

**Files:**
- Create: `app/lib/simulator/runs.server.ts`
- Test: `app/lib/simulator/__tests__/runs.test.ts`

Persistence against Supabase (service-role), shaped to DTOs via a pure `rowToRun` mapper (tested directly, like the `rowToAlert` style in `calderyn.server.ts`).

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/runs.test.ts
import { describe, it, expect } from "vitest";
import { rowToRun } from "../runs.server";

describe("rowToRun", () => {
  it("maps a DB row to a SimulationRun DTO", () => {
    const dto = rowToRun({
      id: "run-1",
      status: "done",
      target: "whole_store",
      requested_n: 1000,
      model: { storeSummary: "s", shipping: { amount: 9.95, currency: "USD", estimated: false }, archetypes: [], findings: [] },
      error: null,
      created_at: "2026-06-04T00:00:00Z",
      completed_at: "2026-06-04T00:00:30Z",
    });
    expect(dto).toEqual({
      id: "run-1",
      status: "done",
      target: "whole_store",
      requestedN: 1000,
      model: { storeSummary: "s", shipping: { amount: 9.95, currency: "USD", estimated: false }, archetypes: [], findings: [] },
      error: null,
      createdAt: "2026-06-04T00:00:00Z",
      completedAt: "2026-06-04T00:00:30Z",
    });
  });

  it("defaults missing model/error/completed_at to null", () => {
    const dto = rowToRun({ id: "r", status: "queued", target: "whole_store", requested_n: 10, created_at: "t" });
    expect(dto.model).toBeNull();
    expect(dto.error).toBeNull();
    expect(dto.completedAt).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/runs.test.ts`
Expected: FAIL — "Cannot find module '../runs.server'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/runs.server.ts
import { getSupabase, resolveShopId } from "../supabase.server";
import type { BehaviorModel, RunStatus, SimulationRun } from "./types";

export function rowToRun(r: Record<string, unknown>): SimulationRun {
  return {
    id: String(r.id),
    status: r.status as RunStatus,
    target: String(r.target ?? "whole_store"),
    requestedN: Number(r.requested_n ?? 0),
    model: (r.model as BehaviorModel | null) ?? null,
    error: (r.error as string | null) ?? null,
    createdAt: String(r.created_at),
    completedAt: (r.completed_at as string | null) ?? null,
  };
}

// Insert a run already marked 'running' — the simulation executes synchronously
// in the same request (see the route's maxDuration config). The 'queued' status
// stays in the schema for a future move to cron-based async.
export async function startRun(
  shop: string,
  requestedN: number,
  target = "whole_store",
): Promise<SimulationRun> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("simulation_run")
    .insert({ shop_id: shopId, status: "running", requested_n: requestedN, target })
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function completeRun(id: string, model: BehaviorModel): Promise<SimulationRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("simulation_run")
    .update({ status: "done", model, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function failRun(id: string, message: string): Promise<SimulationRun> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from("simulation_run")
    .update({ status: "error", error: message, completed_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return rowToRun(data);
}

export async function getLatestRun(shop: string): Promise<SimulationRun | null> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_simulation_runs")
    .select("*")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? rowToRun(data) : null;
}

export async function listRuns(shop: string, limit = 10): Promise<SimulationRun[]> {
  const sb = getSupabase();
  const shopId = await resolveShopId(shop);
  const { data, error } = await sb
    .from("v_simulation_runs")
    .select("id, status, target, requested_n, error, created_at, completed_at")
    .eq("shop_id", shopId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowToRun);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/runs.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/runs.server.ts app/lib/simulator/__tests__/runs.test.ts
git commit -m "feat(simulator): add simulation_run persistence + DTO mapper"
```

---

### Task 8: Orchestration (`orchestrate.server.ts`)

**Files:**
- Create: `app/lib/simulator/orchestrate.server.ts`
- Test: `app/lib/simulator/__tests__/orchestrate.test.ts`

Ties the pieces together: insert run (`running`) → fetch snapshot → build model → complete (or fail). Dependencies injected so the test runs with fakes and asserts both the success and failure persistence paths.

- [ ] **Step 1: Write the failing test**

```ts
// app/lib/simulator/__tests__/orchestrate.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeSimulation } from "../orchestrate.server";
import type { BehaviorModel, SimulationRun, StoreSnapshot } from "../types";

const snapshot: StoreSnapshot = {
  shop: "acme.myshopify.com", homeText: "h", product: null,
  shipping: { amount: 9.95, currency: "USD", estimated: false },
};
const model: BehaviorModel = {
  storeSummary: "s", shipping: snapshot.shipping,
  archetypes: [{ id: "a", name: "A", weight: 1, advance: { landed: 1, viewed_product: 1, added_to_cart: 1, started_checkout: 1, shipping_reveal: 1, bought: 1 }, dropReason: {} }],
  findings: [],
};
const run: SimulationRun = { id: "run-1", status: "running", target: "whole_store", requestedN: 1000, model: null, error: null, createdAt: "t", completedAt: null };

function deps(over: Partial<Parameters<typeof executeSimulation>[1]> = {}) {
  return {
    startRun: vi.fn(async () => run),
    completeRun: vi.fn(async (_id: string, m: BehaviorModel) => ({ ...run, status: "done" as const, model: m })),
    failRun: vi.fn(async (_id: string, msg: string) => ({ ...run, status: "error" as const, error: msg })),
    fetchSnapshot: vi.fn(async () => snapshot),
    buildBehaviorModel: vi.fn(async () => model),
    ...over,
  };
}

describe("executeSimulation", () => {
  it("persists the model on success and returns a done run", async () => {
    const d = deps();
    const result = await executeSimulation({ shop: "acme.myshopify.com", requestedN: 1000 }, d);
    expect(d.fetchSnapshot).toHaveBeenCalledWith("acme.myshopify.com");
    expect(d.completeRun).toHaveBeenCalledWith("run-1", model);
    expect(result.status).toBe("done");
    expect(result.model).toEqual(model);
  });

  it("records an error run when a step throws", async () => {
    const d = deps({ buildBehaviorModel: vi.fn(async () => { throw new Error("api down"); }) });
    const result = await executeSimulation({ shop: "acme.myshopify.com", requestedN: 500 }, d);
    expect(d.failRun).toHaveBeenCalledWith("run-1", "api down");
    expect(result.status).toBe("error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/lib/simulator/__tests__/orchestrate.test.ts`
Expected: FAIL — "Cannot find module '../orchestrate.server'".

- [ ] **Step 3: Write the implementation**

```ts
// app/lib/simulator/orchestrate.server.ts
import { getAnthropic, assistantModel } from "../assistant/anthropic.server";
import { fetchSnapshot as realFetchSnapshot } from "./fetch-pages.server";
import { buildBehaviorModel as realBuildModel } from "./simulate.server";
import {
  startRun as realStart,
  completeRun as realComplete,
  failRun as realFail,
} from "./runs.server";
import type { BehaviorModel, SimulationRun, StoreSnapshot } from "./types";

export interface ExecuteDeps {
  startRun: (shop: string, requestedN: number) => Promise<SimulationRun>;
  completeRun: (id: string, model: BehaviorModel) => Promise<SimulationRun>;
  failRun: (id: string, message: string) => Promise<SimulationRun>;
  fetchSnapshot: (shop: string) => Promise<StoreSnapshot>;
  buildBehaviorModel: (snapshot: StoreSnapshot) => Promise<BehaviorModel>;
}

function defaultDeps(): ExecuteDeps {
  return {
    startRun: realStart,
    completeRun: realComplete,
    failRun: realFail,
    fetchSnapshot: (shop) => realFetchSnapshot(shop),
    // The default dep owns the Anthropic wiring so the orchestration test never
    // imports the SDK — it injects a plain fake instead.
    buildBehaviorModel: (snapshot) =>
      realBuildModel(snapshot, {
        createMessage: (p) => getAnthropic().messages.create(p),
        model: assistantModel(),
      }),
  };
}

export async function executeSimulation(
  input: { shop: string; requestedN: number },
  deps: ExecuteDeps = defaultDeps(),
): Promise<SimulationRun> {
  const run = await deps.startRun(input.shop, input.requestedN);
  try {
    const snapshot = await deps.fetchSnapshot(input.shop);
    const model = await deps.buildBehaviorModel(snapshot);
    return await deps.completeRun(run.id, model);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return await deps.failRun(run.id, message);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/lib/simulator/__tests__/orchestrate.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/simulator/orchestrate.server.ts app/lib/simulator/__tests__/orchestrate.test.ts
git commit -m "feat(simulator): add run orchestration with injectable deps"
```

---

### Task 9: Route + UI (`app.simulator.tsx`) and nav link

**Files:**
- Create: `app/routes/app.simulator.tsx`
- Modify: `app/routes/app.tsx` (add the nav link)
- Test: `app/routes/__tests__/simulator-action.test.ts`

The route loader returns the latest run + history; the action runs a simulation synchronously and returns the run DTO; the component holds slider state and re-samples the cached model live with `sampleFunnel`.

- [ ] **Step 1: Write the failing action test**

```ts
// app/routes/__tests__/simulator-action.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionFunctionArgs } from "@remix-run/node";

const { execSpy } = vi.hoisted(() => ({ execSpy: vi.fn() }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));
vi.mock("~/lib/simulator/orchestrate.server", () => ({
  executeSimulation: (...a: unknown[]) => execSpy(...a),
}));

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { action } from "../app.simulator";

function run(n: string): Promise<Response> {
  const fd = new FormData();
  fd.set("requestedN", n);
  const request = new Request("http://localhost/app/simulator", { method: "POST", body: fd });
  return action({ request } as unknown as ActionFunctionArgs) as Promise<Response>;
}

beforeEach(() => {
  execSpy.mockReset();
  execSpy.mockResolvedValue({ id: "run-1", status: "done", target: "whole_store", requestedN: 1000, model: null, error: null, createdAt: "t", completedAt: "t" });
});

describe("simulator action", () => {
  it("clamps requestedN into [10,1000] and runs the simulation", async () => {
    await run("999999");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 1000 });
  });

  it("clamps a too-small value up to the minimum", async () => {
    await run("1");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 10 });
  });

  it("defaults non-numeric input to 1000", async () => {
    await run("abc");
    expect(execSpy).toHaveBeenCalledWith({ shop: "acme.myshopify.com", requestedN: 1000 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run app/routes/__tests__/simulator-action.test.ts`
Expected: FAIL — "Cannot find module '../app.simulator'".

- [ ] **Step 3: Write the route loader + action + helper**

```tsx
// app/routes/app.simulator.tsx
import { useMemo, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Badge, Banner, BlockStack, Box, Button, Card, InlineGrid, InlineStack,
  Page, RangeSlider, Select, Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { executeSimulation } from "~/lib/simulator/orchestrate.server";
import { getLatestRun, listRuns } from "~/lib/simulator/runs.server";
import { sampleFunnel, seedFromString } from "~/lib/simulator/sample";
import { MAX_SHOPPERS, MIN_SHOPPERS, type SimulationRun } from "~/lib/simulator/types";

// Run a single structured Claude call synchronously; fits the function budget.
export const config = { maxDuration: 60 };

export function clampN(raw: FormDataEntryValue | null): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return MAX_SHOPPERS;
  return Math.min(Math.max(n, MIN_SHOPPERS), MAX_SHOPPERS);
}

type LoaderPayload = { latest: SimulationRun | null; history: SimulationRun[] };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [latest, history] = await Promise.all([
    getLatestRun(session.shop),
    listRuns(session.shop, 10),
  ]);
  return json<LoaderPayload>({ latest, history });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const requestedN = clampN(form.get("requestedN"));
  const run = await executeSimulation({ shop: session.shop, requestedN });
  return json(run);
};

export default function Simulator() {
  const { latest, history } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const run: SimulationRun | null = (fetcher.data as SimulationRun | undefined) ?? latest;
  const running = fetcher.state !== "idle";

  const [n, setN] = useState<number>(latest?.requestedN ?? MAX_SHOPPERS);

  const sample = useMemo(() => {
    if (!run?.model) return null;
    return sampleFunnel(run.model, n, seedFromString(run.id));
  }, [run, n]);

  return (
    <Page
      title="Synthetic Shopper Simulator"
      subtitle="Send LLM-driven shoppers through your store before you spend on ads"
    >
      <BlockStack gap="500">
        <Card>
          <BlockStack gap="300">
            <InlineGrid columns={{ xs: 1, md: 3 }} gap="400">
              <Box>
                <RangeSlider
                  label={`Shoppers to simulate: ${n.toLocaleString()}`}
                  min={MIN_SHOPPERS}
                  max={MAX_SHOPPERS}
                  step={10}
                  value={n}
                  onChange={(v) => setN(Array.isArray(v) ? v[0] : v)}
                  helpText="Drag to re-sample instantly — no new run."
                />
              </Box>
              <Select
                label="Test target"
                options={[{ label: "Whole store (home → product → checkout)", value: "whole_store" }]}
                value="whole_store"
                disabled
                onChange={() => {}}
              />
              <Box paddingBlockStart="600">
                <fetcher.Form method="post">
                  <input type="hidden" name="requestedN" value={n} />
                  <Button submit variant="primary" loading={running}>
                    {run ? "Run new simulation" : "Run first simulation"}
                  </Button>
                </fetcher.Form>
              </Box>
            </InlineGrid>
            {run?.status === "error" && (
              <Banner tone="critical" title="Simulation failed">
                <p>{run.error}</p>
              </Banner>
            )}
            {run?.model?.shipping.estimated && (
              <Text as="p" tone="subdued" variant="bodySm">
                Shipping cost is estimated — connect real rates for sharper results.
              </Text>
            )}
          </BlockStack>
        </Card>

        {running && !run?.model && (
          <Card>
            <Text as="p" tone="subdued">Simulating shoppers… this takes ~30 seconds.</Text>
          </Card>
        )}

        {run?.model && sample && (
          <>
            {sample.biggestLeak && (
              <Banner tone="critical" title={`Biggest leak — ${sample.biggestLeak.label}`}>
                <p>
                  {sample.biggestLeak.count.toLocaleString()} of {sample.n.toLocaleString()} shoppers
                  dropped at the {sample.biggestLeak.label.toLowerCase()} stage.
                </p>
              </Banner>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Where your {sample.n.toLocaleString()} shoppers fell out</Text>
                <BlockStack gap="150">
                  {sample.stages.map((st, i) => {
                    const pct = sample.n ? Math.round((st.reached / sample.n) * 100) : 0;
                    const isLeak = sample.biggestLeak?.stageId === st.id;
                    const isBought = st.id === "bought";
                    return (
                      <InlineStack key={st.id} gap="300" blockAlign="center">
                        <div style={{ width: 150 }}>
                          <Text as="span" variant="bodySm">{st.label}</Text>
                        </div>
                        <div style={{ flex: 1, background: "#f1f1f1", borderRadius: 4, overflow: "hidden" }}>
                          <div
                            style={{
                              width: `${Math.max(pct, 2)}%`,
                              background: isBought ? "#2b9d4b" : isLeak ? "#e03b3b" : "#3b6cff",
                              color: "#fff", padding: "6px 10px", whiteSpace: "nowrap", fontSize: 13,
                            }}
                          >
                            {st.reached.toLocaleString()}
                            {i > 0 ? ` (−${(sample.stages[i - 1].reached - st.reached).toLocaleString()})` : ""}
                          </div>
                        </div>
                      </InlineStack>
                    );
                  })}
                </BlockStack>
              </BlockStack>
            </Card>

            {run.model.findings.length > 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingSm">Friction findings</Text>
                  {run.model.findings.map((f) => (
                    <Box key={f.id} padding="300" borderColor="border" borderBlockStartWidth="025">
                      <InlineStack align="space-between" blockAlign="start" gap="400">
                        <BlockStack gap="100">
                          <InlineStack gap="200" blockAlign="center">
                            <Badge tone={f.severity === "critical" ? "critical" : f.severity === "high" ? "warning" : "attention"}>
                              {f.severity}
                            </Badge>
                            <Text as="span" variant="bodyMd" fontWeight="semibold">{f.title}</Text>
                          </InlineStack>
                          <Text as="span" variant="bodySm" tone="subdued">Fix: {f.fix}</Text>
                        </BlockStack>
                        <Text as="span" variant="bodyMd" fontWeight="semibold">
                          −{(sample.findingCounts[f.id] ?? 0).toLocaleString()}
                        </Text>
                      </InlineStack>
                    </Box>
                  ))}
                </BlockStack>
              </Card>
            )}

            <Card>
              <BlockStack gap="200">
                <Text as="h2" variant="headingSm">Per-persona breakdown</Text>
                {run.model.archetypes.map((a) => {
                  const dropStage = a.dropReason ? Object.keys(a.dropReason)[0] : undefined;
                  const reason = dropStage ? a.dropReason[dropStage as keyof typeof a.dropReason] : "—";
                  return (
                    <InlineStack key={a.id} align="space-between">
                      <Text as="span" variant="bodySm" fontWeight="semibold">{a.name}</Text>
                      <Text as="span" variant="bodySm" tone="subdued">{reason ?? "Converted"}</Text>
                    </InlineStack>
                  );
                })}
              </BlockStack>
            </Card>
          </>
        )}

        {!run && !running && (
          <Card>
            <Text as="p" tone="subdued">
              No simulations yet. Set the slider and run your first one to see where shoppers drop off.
            </Text>
          </Card>
        )}

        {history.length > 0 && (
          <Text as="p" tone="subdued" variant="bodySm">{history.length} previous run(s) on record.</Text>
        )}
      </BlockStack>
    </Page>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run app/routes/__tests__/simulator-action.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the nav link**

In `app/routes/app.tsx`, add the Simulator link after the SKUs link:

```tsx
        <Link to="/app/skus">SKUs</Link>
        <Link to="/app/simulator">Simulator</Link>
        <Link to="/app/settings">Settings</Link>
```

- [ ] **Step 6: Run the full test suite + typecheck**

Run: `npm run test`
Expected: all suites pass (including the 6 new simulator suites).

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add app/routes/app.simulator.tsx app/routes/app.tsx app/routes/__tests__/simulator-action.test.ts
git commit -m "feat(simulator): add /app/simulator route, funnel UI, and nav link"
```

---

### Task 10: Pre-commit gate (CLAUDE.md MANDATORY)

**Files:** none (verification only)

This is a major change (new route, schema, lib, nav). Run the repo's gate in order and paste real output — do not assert success without evidence.

- [ ] **Step 1: Code review**

Run: `/code-review` on the working tree. Resolve every blocker; downgrade nits with a one-line justification.

- [ ] **Step 2: Patch sanity**

Run: `git diff --stat` and `git diff --check`
Expected: clean; no stray `console.log`, `.only`, `TODO(me)`, or commented-out blocks in the diff.

- [ ] **Step 3: Eval pipeline (in order)**

Run: `npm run typecheck` → expect exit 0
Run: `npm run lint` → expect exit 0 (no warnings on touched files)
Run: `npm run build` → expect exit 0 (Remix + Vite build completes)
Run: `npx prisma validate` → not required (no Prisma schema change; business data is Supabase)

> GraphQL codegen is **not** required: the shipping query is inline `#graphql` with a hand-typed response, matching `ingest/shopify-admin.server.ts` (no `.graphql` files or generated types touched).

- [ ] **Step 4: Manual smoke (optional but recommended)**

With `ANTHROPIC_API_KEY` set, run `npm run dev`, open the embedded app → Simulator, click Run, confirm a funnel renders and dragging the slider re-samples instantly.

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to merge / open a PR.

---

## Notes for the implementer

- **Env:** the feature needs `ANTHROPIC_API_KEY` (shared with the Assistant; still pending in Vercel). Without it, a run ends `status: 'error'` with "ANTHROPIC_API_KEY is not set" — surfaced in the UI banner, not a crash. That's expected.
- **No new dependencies.** If you find yourself reaching for `cheerio`/an HTML parser, stop — `html-to-text.ts` is intentionally enough.
- **Business data is Supabase, not Prisma.** Prisma/SQLite here is only the Shopify session store. The schema change is the Supabase migration in Task 1.
- **Determinism:** `sampleFunnel` seeds from the run id, so a given run's funnel is stable across slider drags and reloads.
