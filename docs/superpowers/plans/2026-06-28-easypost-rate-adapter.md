# EasyPost Rate-Quote Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a provider-blind `getRates()` quote direction to the ship-cost adapter family — given origin + destination + parcel, return live EasyPost carrier rate OPTIONS as `NormalizedRateOption[]`, degrading to a static fallback table (never throwing) when the carrier is slow, down, or returns no rates.

**Architecture:** A net-new pure contract (`rate-quote.ts`) mirrors the existing `adapter.ts` two-level shape (`RateQuoteAdapter.connect()` → `RateQuoteSource.getRates()`). A net-new `easypost-rate.server.ts` implements it against EasyPost's rate-shopping flow (`POST /v2/shipments`, then read **all** `rates[]` — not `selected_rate`), reusing the cost adapter's `parseRateToCents`, `basicAuthHeader`, `apiBase`, `integration_credentials` credential load, and `decrypt`. A hard ~5s `AbortController` timeout plus a static fallback rate table make a slow/down carrier non-fatal (no rate = no sale, so this is load-bearing).

**Tech Stack:** TypeScript (strict), Remix + Vite, Vitest. Built-in `fetch` + HTTP Basic auth — **NO new npm dependency** (repo rule P6: do not pull `@easypost/api`). Built-in `AbortController` for the timeout. Recorded EasyPost test-mode JSON fixture for deterministic, offline tests (mirrors the existing `easypost.test.ts` mock-`fetch` style).

---

## Execution context

- **Worktree:** all work happens in the `feat/external-integrations` worktree, created at execution time via **superpowers:using-git-worktrees** (`git worktree add ../calderyn-external-integrations -b feat/external-integrations`). Never on `main` or on top of in-flight work. This is Module 1 of 3 standalone slices in that branch; it has ZERO dependency on teammate "John".
- **NO new npm dependency.** Built-in `fetch` + HTTP Basic (key as username, empty password) + built-in `AbortController`. Do not add `@easypost/api` or any HTTP client. The Pre-commit gate greps the diff for new `package.json` dependencies.
- **Provider-blind discipline:** callers never branch on carrier. The contract lives in a non-`.server` file (`rate-quote.ts`); the EasyPost specifics live only in `easypost-rate.server.ts`.
- **Money is integer cents** via the reused `parseRateToCents` — decimal strings parsed without float drift; malformed/negative → `null` → option **dropped**, never coerced to 0 (rule 12, fail-visibly).

---

## File Structure

| File | Responsibility |
|---|---|
| `app/lib/ship-cost/adapters/easypost.server.ts` | **MODIFY** — add `export` to `basicAuthHeader` (`:39`) and `apiBase` (`:81`). Two-line change; everything else untouched. Single source of HTTP Basic + base-URL-resolution logic, reused verbatim by the rate adapter (no duplication). |
| `app/lib/ship-cost/adapters/rate-quote.ts` | **CREATE** — pure, provider-blind contract (no `.server`). Defines `RateQuoteAdapter`, `RateQuoteSource`, `NormalizedRateOption`, `RateRequest`, `RateQuoteResult`, `Address`, `Parcel`. Reuses `ShipProvider` / `ShipIntegrationKind` from `adapter.ts`. |
| `app/lib/ship-cost/adapters/easypost-rate.server.ts` | **CREATE** — EasyPost rate-quote implementation: the `EasyPostRateQuote` rate shape; `mapRateToOption` (pure normalizer, reuses `parseRateToCents`); the static fallback rate table + `buildFallbackOptions`; `fetchEasyPostRates` (`POST /v2/shipments`, read all `rates[]`, `AbortController` timeout, degrade-to-fallback); `easyPostRateAdapter` (`connect()` reusing `integration_credentials` + `decrypt`). |
| `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts` | **CREATE** — Vitest unit tests, built incrementally across tasks. Mock-`fetch` style mirroring `easypost.test.ts`; `vi.mock` of `supabase.server` + `crypto.server` for `connect()` mirroring `shiphero.test.ts`. |
| `app/lib/ship-cost/adapters/__tests__/fixtures/easypost-rates.json` | **CREATE** — recorded EasyPost test-mode shipment-create response (`rates[]` with good rates + one negative rate to prove the rule-12 drop). Offline + deterministic; committed once. |

**Deferred (NOT in this slice):** the `ship_rate_quote_log` observability table (YAGNI for this adapter spike — the adapter returns `latencyMs`/`fallbackUsed` on `RateQuoteResult`, so logging can be added later in `#6.3` without an adapter change).

---

## Principles applied throughout

- **Provider-blind:** callers never branch on carrier. EasyPost specifics never leak past `easypost-rate.server.ts`.
- **Money as integer cents** via the reused `parseRateToCents`. Never coerce a bad rate to 0.
- **Fail visibly (rule 12):** drop malformed/negative rates; flag every degraded response with `fallbackUsed: true`.
- **Degrade, never throw at runtime:** `getRates` returns the static fallback on abort/timeout/network-error/non-2xx/malformed-body/empty-`rates[]`. `connect()` keeps the cost-side semantics: `null` = not connected, **THROW** = stored-but-broken.
- **Deliberate simplifications** are marked `// ponytail:` with an upgrade path: single-parcel only (`parcels[0]`), static fallback table, list rates only.

---

## Task 1: Export `basicAuthHeader` + `apiBase` from `easypost.server.ts`

Reuse the cost adapter's HTTP Basic + base-URL helpers verbatim (no duplication, rule 3). The base-URL resolver to export is `apiBase()` — the function that reads the `DEFAULT_BASE` const + the `EASYPOST_API_BASE` env override + strips the trailing slash — so the rate adapter reuses that logic instead of re-deriving it.

**Files:**
- Modify: `app/lib/ship-cost/adapters/easypost.server.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Create the new test file with this content (this also establishes the shared vitest imports the later tasks append to):

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { basicAuthHeader, apiBase } from "../easypost.server";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── easypost.server shared HTTP helpers, exported for reuse by the rate adapter ──
describe("easypost.server exported helpers", () => {
  it("basicAuthHeader emits HTTP Basic with the key as username + empty password", () => {
    expect(basicAuthHeader("EZTKtest123")).toBe(
      `Basic ${Buffer.from("EZTKtest123:").toString("base64")}`,
    );
  });

  it("apiBase defaults to the production v2 base and strips a trailing slash from an override", () => {
    const prev = process.env.EASYPOST_API_BASE;
    delete process.env.EASYPOST_API_BASE;
    expect(apiBase()).toBe("https://api.easypost.com/v2");
    process.env.EASYPOST_API_BASE = "https://example.test/v2/";
    expect(apiBase()).toBe("https://example.test/v2");
    if (prev === undefined) delete process.env.EASYPOST_API_BASE;
    else process.env.EASYPOST_API_BASE = prev;
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — module-load error `does not provide an export named 'basicAuthHeader'` (and `'apiBase'`), because both are still module-private.

- [ ] **Step 3: Write minimal implementation.** Add `export` to the two existing functions in `app/lib/ship-cost/adapters/easypost.server.ts` (no other change):

```ts
// line 39 — was: function basicAuthHeader(apiKey: string): string {
export function basicAuthHeader(apiKey: string): string {
  // EasyPost: key as username, empty password → base64("KEY:").
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;
}
```

```ts
// line 81 — was: function apiBase(): string {
export function apiBase(): string {
  // Optional override (contract P5); default to production v2.
  const raw = process.env.EASYPOST_API_BASE?.trim();
  return (raw && raw.length > 0 ? raw : DEFAULT_BASE).replace(/\/+$/, "");
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — both helpers import and behave as asserted. (The existing `easypost.test.ts` still passes; the change is additive.)

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/easypost.server: export basicAuthHeader + apiBase for reuse

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Define the `rate-quote.ts` provider-blind contract

The net-new contract mirrors `adapter.ts`: an adapter plug that authenticates (`connect`) and a per-shop source handle that does the work (`getRates`). All types are provider-blind; `ShipProvider` / `ShipIntegrationKind` are reused from `adapter.ts`.

**Files:**
- Create: `app/lib/ship-cost/adapters/rate-quote.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Append this describe block to the test file. Add this import at the top with the others:

```ts
import type {
  NormalizedRateOption,
  RateRequest,
  RateQuoteResult,
  Address,
  Parcel,
} from "../rate-quote";
```

```ts
// ── rate-quote.ts contract: shape guards (tsc enforces; runtime confirms) ───────
describe("rate-quote contract types", () => {
  it("a NormalizedRateOption literal satisfies the contract shape", () => {
    const opt = {
      carrier: "USPS",
      serviceCode: "Priority",
      serviceName: "Priority",
      amountCents: 739,
      currency: "USD",
      estTransitDays: 2,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    } satisfies NormalizedRateOption;
    expect(opt.amountCents).toBe(739);
    expect(opt.rateType).toBe("list");
  });

  it("a RateRequest literal satisfies the contract shape (origin/destination/parcels)", () => {
    const origin: Address = { street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" };
    const destination: Address = { street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" };
    const parcel: Parcel = { lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 32 };
    const req = { origin, destination, parcels: [parcel] } satisfies RateRequest;
    expect(req.parcels[0].weightOz).toBe(32);
  });

  it("a RateQuoteResult carries fallbackUsed + latencyMs visibility fields", () => {
    const res = { options: [], fallbackUsed: true, latencyMs: 12, provider: "easypost" } satisfies RateQuoteResult;
    expect(res.fallbackUsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — `Failed to resolve import "../rate-quote"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation.** Create `app/lib/ship-cost/adapters/rate-quote.ts`:

```ts
// Shared, provider-blind RATE-QUOTE connector contract — the buyer-facing /
// pre-purchase direction of the ship-cost adapter family. Where ShipCostAdapter
// (adapter.ts) reads ACTUAL PAID charges for analytics, RateQuoteAdapter returns
// LIVE CARRIER RATE OPTIONS for a given origin/destination/parcel. Callers never
// branch on carrier — exactly like the cost side. Money is integer cents.

import type { ShipProvider, ShipIntegrationKind } from "./adapter";

/** A postal address, provider-blind (the adapter maps it to the carrier body). */
export interface Address {
  name?: string;
  company?: string;
  street1: string;
  street2?: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO-2, default "US".
  phone?: string;
}

/** One package's dims + weight, provider-blind (mapped to the carrier body). */
export interface Parcel {
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightOz: number;
}

/** The input to a rate quote. */
export interface RateRequest {
  origin: Address;
  destination: Address;
  // Array for forward-compat; v1 reads parcels[0] only.
  // ponytail: single-parcel; upgrade path = multi-parcel packing in #6.3.
  parcels: Parcel[];
  // Optional client-side filter to a set of serviceCodes.
  // ponytail: filter after the call, not a server-side constraint.
  serviceFilter?: string[];
}

/** One carrier rate OPTION, normalized across providers (callers never branch). */
export interface NormalizedRateOption {
  carrier: string; // e.g. "USPS"
  serviceCode: string; // e.g. "Priority"
  serviceName: string; // ponytail: serviceCode === serviceName until a display map exists
  amountCents: number; // integer cents via parseRateToCents; never coerced to 0
  currency: string; // ISO-4217, default "USD"
  estTransitDays: number | null;
  guaranteed: boolean;
  deliveryDateEstimate: string | null;
  // Provenance for #6.3 margin reconciliation. v1 is always "list"
  // (EasyPost `rate` = list rate; negotiated needs attached carrier_accounts).
  // ponytail: list rates only; upgrade path = negotiated rates in v2.
  rateType: "list" | "negotiated";
}

/** The result of a rate quote: options plus degraded-mode + latency visibility. */
export interface RateQuoteResult {
  options: NormalizedRateOption[];
  fallbackUsed: boolean;
  latencyMs: number;
  provider: ShipProvider;
}

/** Per-shop, already-authenticated handle that fetches live rate options. */
export interface RateQuoteSource {
  // Runtime. NEVER throws on carrier slowness/down — degrades to the static
  // fallback table (fallbackUsed: true). See easypost-rate.server.ts.
  getRates(req: RateRequest): Promise<RateQuoteResult>;
}

/** A provider plug. `connect` returns null when the shop has NO credential stored. */
export interface RateQuoteAdapter {
  readonly provider: ShipProvider;
  readonly integrationKind: ShipIntegrationKind;
  // null = no credential stored (shop not connected).
  // THROW = a credential is stored but structurally broken (failure-visibility, rule 12).
  connect(shopId: string): Promise<RateQuoteSource | null>;
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — the literals satisfy the interfaces and the runtime assertions hold. (Also run `npm run typecheck` here — the `satisfies` clauses are the real guard.)

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/rate-quote.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/rate-quote: add provider-blind RateQuoteAdapter contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Pure normalization mapper (`mapRateToOption`) + recorded fixture

One EasyPost `rates[]` element → `NormalizedRateOption`, reusing `parseRateToCents`. Malformed/negative rate → `null` → caller drops it (rule 12). Tested against a recorded EasyPost test-mode fixture.

**Files:**
- Create: `app/lib/ship-cost/adapters/easypost-rate.server.ts`
- Create: `app/lib/ship-cost/adapters/__tests__/fixtures/easypost-rates.json`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** First create the recorded fixture `app/lib/ship-cost/adapters/__tests__/fixtures/easypost-rates.json` (a real EasyPost test-mode shipment-create response; 4 rates — 3 valid + 1 negative to prove the drop):

```json
{
  "id": "shp_ratetest123",
  "object": "Shipment",
  "rates": [
    {
      "id": "rate_usps_priority",
      "object": "Rate",
      "carrier": "USPS",
      "service": "Priority",
      "rate": "7.39",
      "currency": "USD",
      "list_rate": "7.39",
      "delivery_days": 2,
      "est_delivery_days": 2,
      "delivery_date": "2026-07-02T00:00:00Z",
      "delivery_date_guaranteed": false
    },
    {
      "id": "rate_usps_express",
      "object": "Rate",
      "carrier": "USPS",
      "service": "Express",
      "rate": "26.95",
      "currency": "USD",
      "list_rate": "29.95",
      "delivery_days": 1,
      "est_delivery_days": 1,
      "delivery_date": "2026-07-01T00:00:00Z",
      "delivery_date_guaranteed": true
    },
    {
      "id": "rate_ups_ground",
      "object": "Rate",
      "carrier": "UPS",
      "service": "Ground",
      "rate": "9.12",
      "currency": "USD",
      "list_rate": "9.12",
      "delivery_days": null,
      "est_delivery_days": 3,
      "delivery_date": null,
      "delivery_date_guaranteed": false
    },
    {
      "id": "rate_broken_negative",
      "object": "Rate",
      "carrier": "FedEx",
      "service": "Home",
      "rate": "-4.00",
      "currency": "USD",
      "list_rate": "-4.00",
      "delivery_days": 4,
      "est_delivery_days": 4,
      "delivery_date": null,
      "delivery_date_guaranteed": false
    }
  ]
}
```

Then append this describe block to the test file. Add these imports at the top with the others:

```ts
import rateFixture from "./fixtures/easypost-rates.json";
import { mapRateToOption, type EasyPostRateQuote } from "../easypost-rate.server";
```

```ts
// ── mapRateToOption: one EasyPost rate → NormalizedRateOption (parseRateToCents reuse) ──
describe("mapRateToOption (pure normalization)", () => {
  const rates = rateFixture.rates as EasyPostRateQuote[];

  it('maps a USPS Priority "7.39" rate to 739 cents with every field', () => {
    expect(mapRateToOption(rates[0])).toEqual({
      carrier: "USPS",
      serviceCode: "Priority",
      serviceName: "Priority",
      amountCents: 739,
      currency: "USD",
      estTransitDays: 2,
      guaranteed: false,
      deliveryDateEstimate: "2026-07-02T00:00:00Z",
      rateType: "list",
    });
  });

  it("reads guaranteed + delivery_date for an Express rate", () => {
    const opt = mapRateToOption(rates[1]);
    expect(opt?.amountCents).toBe(2695);
    expect(opt?.guaranteed).toBe(true);
    expect(opt?.deliveryDateEstimate).toBe("2026-07-01T00:00:00Z");
  });

  it("falls back delivery_days → est_delivery_days, and delivery_date → null", () => {
    const opt = mapRateToOption(rates[2]);
    expect(opt?.estTransitDays).toBe(3);
    expect(opt?.deliveryDateEstimate).toBeNull();
  });

  it("DROPS a negative/malformed rate (null), never coerces to 0 (rule 12)", () => {
    expect(mapRateToOption(rates[3])).toBeNull();
  });

  it("drops a rate missing carrier or service (cannot present an option)", () => {
    expect(mapRateToOption({ service: "Priority", rate: "5.00" })).toBeNull();
    expect(mapRateToOption({ carrier: "USPS", rate: "5.00" })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — `Failed to resolve import "../easypost-rate.server"` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation.** Create `app/lib/ship-cost/adapters/easypost-rate.server.ts` with the rate shape + the pure mapper (reusing `parseRateToCents`):

```ts
// EasyPost adapter (rate-quote / buyer-facing direction). Reuses the cost adapter's
// HTTP Basic + base-URL + money parsing (easypost.server.ts) and credential load
// (integration_credentials kind 'easypost_ship' via crypto.server.ts). Hits the
// rate-shopping flow: POST /v2/shipments, then reads ALL rates[] (NOT selected_rate).
//
// No new npm dependency (repo rule P6): built-in fetch + HTTP Basic + AbortController.

import { parseRateToCents } from "./easypost.server";
import type { NormalizedRateOption } from "./rate-quote";

/** Shape of one element of an EasyPost shipment's `rates[]` (fields we read). */
export interface EasyPostRateQuote {
  carrier?: string | null;
  service?: string | null;
  rate?: string | null; // list rate, decimal STRING e.g. "7.39".
  currency?: string | null;
  delivery_days?: number | null;
  est_delivery_days?: number | null;
  delivery_date?: string | null;
  delivery_date_guaranteed?: boolean | null;
}

/**
 * Pure mapper: one EasyPost rate → NormalizedRateOption, or null to DROP.
 * Drop when carrier/service is missing (can't present an option) or the rate is
 * malformed/negative (parseRateToCents → null) — never coerce a bad rate to 0 (rule 12).
 */
export function mapRateToOption(r: EasyPostRateQuote): NormalizedRateOption | null {
  const carrier = r.carrier?.trim();
  const service = r.service?.trim();
  if (!carrier || !service) return null;
  const amountCents = parseRateToCents(r.rate);
  if (amountCents == null) return null; // malformed/negative → drop, surfaced as a missing option.
  return {
    carrier,
    serviceCode: service,
    serviceName: service, // ponytail: serviceCode === serviceName until a display map exists.
    amountCents,
    currency: r.currency?.trim() || "USD",
    estTransitDays: r.delivery_days ?? r.est_delivery_days ?? null,
    guaranteed: r.delivery_date_guaranteed === true,
    deliveryDateEstimate: r.delivery_date ?? null,
    rateType: "list", // v1: EasyPost `rate` is the list rate; negotiated is v2.
  };
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — the three valid fixture rates map exactly; the negative one and the carrier/service-less ones drop to `null`.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost-rate.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts app/lib/ship-cost/adapters/__tests__/fixtures/easypost-rates.json
git commit -m "ship-cost/adapters/easypost-rate: normalize one EasyPost rate to NormalizedRateOption

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Static fallback rate table + `buildFallbackOptions`

A simple weight-band → conservative-cents static table yielding a non-empty option set (economy + expedited). Load-bearing: a slow/down carrier must not leave the caller with zero rates. Exported so `#6.3` reuses the same table.

**Files:**
- Modify: `app/lib/ship-cost/adapters/easypost-rate.server.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Append this describe block to the test file. Add `buildFallbackOptions` to the existing `../easypost-rate.server` import, and add the `RateRequest` type import if not already present:

```ts
// (extend the existing import)
import { mapRateToOption, buildFallbackOptions, type EasyPostRateQuote } from "../easypost-rate.server";
import type { RateRequest } from "../rate-quote"; // already imported in Task 2 — keep one copy
```

```ts
// ── buildFallbackOptions: static table (load-bearing — no rate = no sale) ────────
function fallbackReq(weightOz: number): RateRequest {
  return {
    origin: { street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" },
    destination: { street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" },
    parcels: [{ lengthIn: 10, widthIn: 8, heightIn: 4, weightOz }],
  };
}

describe("buildFallbackOptions (static table)", () => {
  it("returns a NON-EMPTY conservative set (economy + expedited)", () => {
    const opts = buildFallbackOptions(fallbackReq(20));
    expect(opts.length).toBeGreaterThanOrEqual(1);
    expect(opts.map((o) => o.serviceCode)).toEqual(["Economy", "Expedited"]);
  });

  it("prices a heavier parcel into a higher band", () => {
    const light = buildFallbackOptions(fallbackReq(8))[0].amountCents;
    const heavy = buildFallbackOptions(fallbackReq(100))[0].amountCents;
    expect(heavy).toBeGreaterThan(light);
  });

  it("never marks a fallback option guaranteed, and uses integer cents", () => {
    for (const o of buildFallbackOptions(fallbackReq(500))) {
      expect(o.guaranteed).toBe(false);
      expect(Number.isInteger(o.amountCents)).toBe(true);
      expect(o.deliveryDateEstimate).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — `buildFallbackOptions` is not exported by `../easypost-rate.server` (import resolves to `undefined`; calling it throws).

- [ ] **Step 3: Write minimal implementation.** Add the static table + `buildFallbackOptions` to `app/lib/ship-cost/adapters/easypost-rate.server.ts` (add `RateRequest` to the type import from `./rate-quote`):

```ts
// (extend the existing type import at the top of the file)
import type { NormalizedRateOption, RateRequest } from "./rate-quote";

// Static fallback rate table — conservative cents by weight band, surfaced when the
// carrier is slow/down/empty so the caller always has a quote (no rate = no sale).
// ponytail: hardcoded constant table; upgrade path = the merchant-configurable
// ship_fallback_rate table owned by #6.3 (master spec §282).
interface FallbackBand {
  maxWeightOz: number;
  economyCents: number;
  expeditedCents: number;
}

const FALLBACK_BANDS: FallbackBand[] = [
  { maxWeightOz: 16, economyCents: 599, expeditedCents: 1299 },
  { maxWeightOz: 48, economyCents: 999, expeditedCents: 1899 },
  { maxWeightOz: 160, economyCents: 1599, expeditedCents: 2999 },
];
const FALLBACK_TOP = { economyCents: 2499, expeditedCents: 4499 }; // > 160 oz.

/**
 * Conservative static rate options for the given request, by parcel weight band.
 * Always non-empty. Exported so the #6.3 engine reuses the same table rather than
 * re-implementing it. Options are never guaranteed and carry no firm delivery date.
 */
export function buildFallbackOptions(req: RateRequest): NormalizedRateOption[] {
  const weightOz = req.parcels[0]?.weightOz ?? 0; // ponytail: single-parcel.
  const band = FALLBACK_BANDS.find((b) => weightOz <= b.maxWeightOz);
  const economyCents = band ? band.economyCents : FALLBACK_TOP.economyCents;
  const expeditedCents = band ? band.expeditedCents : FALLBACK_TOP.expeditedCents;
  return [
    {
      carrier: "Standard",
      serviceCode: "Economy",
      serviceName: "Economy",
      amountCents: economyCents,
      currency: "USD",
      estTransitDays: 7,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
    {
      carrier: "Standard",
      serviceCode: "Expedited",
      serviceName: "Expedited",
      amountCents: expeditedCents,
      currency: "USD",
      estTransitDays: 3,
      guaranteed: false,
      deliveryDateEstimate: null,
      rateType: "list",
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — non-empty economy+expedited set; heavier parcel costs more; all conservative + integer cents.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost-rate.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/easypost-rate: static fallback rate table + buildFallbackOptions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `fetchEasyPostRates` happy path — `POST /v2/shipments`, read all `rates[]`

Build the shipment-create request (`to`/`from`/`parcel`), read **all** `rates[]` (not `selected_rate`), normalize provider-blind via `mapRateToOption`, apply the optional client-side `serviceFilter`. Mock `fetch` with the recorded fixture. (Timeout + degrade come in Task 6.)

**Files:**
- Modify: `app/lib/ship-cost/adapters/easypost-rate.server.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Append this describe block. Add `fetchEasyPostRates` to the existing `../easypost-rate.server` import:

```ts
// (extend the existing import)
import {
  mapRateToOption,
  buildFallbackOptions,
  fetchEasyPostRates,
  type EasyPostRateQuote,
} from "../easypost-rate.server";
```

```ts
// ── fetchEasyPostRates: POST /v2/shipments → normalize ALL rates[] ──────────────
function sampleReq(serviceFilter?: string[]): RateRequest {
  return {
    origin: { name: "Shop", street1: "1 A St", city: "SF", state: "CA", zip: "94016", country: "US" },
    destination: { name: "Buyer", street1: "2 B St", city: "NYC", state: "NY", zip: "10001", country: "US" },
    parcels: [{ lengthIn: 10, widthIn: 8, heightIn: 4, weightOz: 32 }],
    serviceFilter,
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, statusText: "OK", json: async () => body } as Response;
}

describe("fetchEasyPostRates — happy path", () => {
  it("POSTs the shipment with to/from/parcel and HTTP Basic auth", async () => {
    const mockFetch = vi.fn(async () => okJson(rateFixture));
    await fetchEasyPostRates("EZTKtest123", sampleReq(), mockFetch as unknown as typeof fetch);
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.easypost.com/v2/shipments");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("EZTKtest123:").toString("base64")}`);
    const body = JSON.parse(init.body as string);
    expect(body.shipment.parcel.weight).toBe(32); // EasyPost parcel weight is OUNCES.
    expect(body.shipment.to_address.zip).toBe("10001");
    expect(body.shipment.from_address.zip).toBe("94016");
  });

  it("normalizes ALL rates[] (not selected_rate) and drops the malformed one", async () => {
    const mockFetch = vi.fn(async () => okJson(rateFixture));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(false);
    expect(result.provider).toBe("easypost");
    expect(result.options.map((o) => `${o.carrier}:${o.serviceCode}:${o.amountCents}`)).toEqual([
      "USPS:Priority:739",
      "USPS:Express:2695",
      "UPS:Ground:912",
    ]);
  });

  it("applies serviceFilter client-side to the returned options", async () => {
    const mockFetch = vi.fn(async () => okJson(rateFixture));
    const result = await fetchEasyPostRates("k", sampleReq(["Priority"]), mockFetch as unknown as typeof fetch);
    expect(result.options.map((o) => o.serviceCode)).toEqual(["Priority"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — `fetchEasyPostRates` is not exported by `../easypost-rate.server`.

- [ ] **Step 3: Write minimal implementation.** Add the request mappers, the rates envelope type, and `fetchEasyPostRates` (happy path only) to `app/lib/ship-cost/adapters/easypost-rate.server.ts`. Extend the imports to include `apiBase`, `basicAuthHeader`, `RateQuoteResult`, and `Address` / `Parcel`:

```ts
// (extend the existing imports)
import { parseRateToCents, basicAuthHeader, apiBase } from "./easypost.server";
import type {
  Address,
  NormalizedRateOption,
  Parcel,
  RateQuoteResult,
  RateRequest,
} from "./rate-quote";
```

```ts
/** Provider-blind Address → EasyPost address body. */
function toEasyPostAddress(a: Address): Record<string, unknown> {
  return {
    name: a.name,
    company: a.company,
    street1: a.street1,
    street2: a.street2,
    city: a.city,
    state: a.state,
    zip: a.zip,
    country: a.country || "US",
    phone: a.phone,
  };
}

/** Provider-blind Parcel → EasyPost parcel body (weight in OUNCES). */
function toEasyPostParcel(p: Parcel): Record<string, unknown> {
  return { length: p.lengthIn, width: p.widthIn, height: p.heightIn, weight: p.weightOz };
}

/** Shape of the POST /v2/shipments response (fields we read). */
interface EasyPostShipmentRates {
  rates?: EasyPostRateQuote[] | null;
}

/**
 * Create a shipment and read ALL of its rate options. v1 quotes parcels[0] only.
 * (Timeout + degrade-to-fallback are added in Task 6 — this is the happy path.)
 */
export async function fetchEasyPostRates(
  apiKey: string,
  req: RateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RateQuoteResult> {
  const start = Date.now();
  const parcel = req.parcels[0]; // ponytail: single-parcel; multi-parcel packing is #6.3.
  const res = await fetchImpl(`${apiBase()}/shipments`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(apiKey),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      shipment: {
        to_address: toEasyPostAddress(req.destination),
        from_address: toEasyPostAddress(req.origin),
        parcel: toEasyPostParcel(parcel),
      },
    }),
  });
  const json = (await res.json()) as EasyPostShipmentRates;
  const rawRates = json.rates ?? [];
  let options = rawRates
    .map(mapRateToOption)
    .filter((o): o is NormalizedRateOption => o !== null);
  if (req.serviceFilter && req.serviceFilter.length > 0) {
    const allow = new Set(req.serviceFilter); // ponytail: client-side filter, not server-side.
    options = options.filter((o) => allow.has(o.serviceCode));
  }
  return { options, fallbackUsed: false, latencyMs: Date.now() - start, provider: "easypost" };
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — correct URL/method/auth/body; 3 normalized options (negative dropped); `serviceFilter` narrows to `Priority`.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost-rate.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/easypost-rate: getRates happy path (POST /v2/shipments, read rates[])

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Timeout + degrade-to-fallback contract (load-bearing)

Wrap the `fetch` in a ~5s `AbortController`. On **abort/timeout**, **network error**, **non-2xx**, **malformed body**, or **empty `rates[]`** (incl. all rates dropped), return the static fallback with `fallbackUsed: true` — **never throw**. The happy path from Task 5 must still pass.

**Files:**
- Modify: `app/lib/ship-cost/adapters/easypost-rate.server.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Append this describe block (reuses `sampleReq` / `okJson` from Task 5):

```ts
// ── fetchEasyPostRates: degrade-to-fallback, NEVER throw at runtime ─────────────
describe("fetchEasyPostRates — timeout & fallback", () => {
  it("returns the static fallback (fallbackUsed:true) WITHOUT throwing when the carrier times out", async () => {
    vi.useFakeTimers();
    // fetch that never resolves on its own and rejects only when the AbortController fires.
    const hangingFetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const promise = fetchEasyPostRates("k", sampleReq(), hangingFetch as unknown as typeof fetch);
    await vi.advanceTimersByTimeAsync(5000); // trip RATE_TIMEOUT_MS.
    const result = await promise;
    expect(result.fallbackUsed).toBe(true);
    expect(result.options.length).toBeGreaterThan(0);
    vi.useRealTimers();
  });

  it("falls back on a non-2xx response without throwing", async () => {
    const mockFetch = vi.fn(async () =>
      ({ ok: false, status: 500, statusText: "ISE", text: async () => "boom", json: async () => ({}) } as Response));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
    expect(result.options.length).toBeGreaterThan(0);
  });

  it("falls back when rates[] is EMPTY (rate-shopping creds not configured)", async () => {
    const mockFetch = vi.fn(async () => okJson({ id: "shp_x", rates: [] }));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back on a malformed body (json() throws) without throwing", async () => {
    const mockFetch = vi.fn(async () =>
      ({ ok: true, status: 200, statusText: "OK", json: async () => { throw new Error("bad json"); } } as unknown as Response));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back when every rate is malformed/dropped (never returns zero options)", async () => {
    const mockFetch = vi.fn(async () => okJson({ id: "shp_x", rates: [{ carrier: "USPS", service: "X", rate: "-1.00" }] }));
    const result = await fetchEasyPostRates("k", sampleReq(), mockFetch as unknown as typeof fetch);
    expect(result.fallbackUsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — the Task-5 happy-path `fetchEasyPostRates` has no timeout and rethrows on non-2xx/malformed (the fallback assertions fail; the hanging-fetch test never resolves).

- [ ] **Step 3: Write minimal implementation.** Replace the Task-5 `fetchEasyPostRates` body in `app/lib/ship-cost/adapters/easypost-rate.server.ts` with the timeout + degrade version (add the `RATE_TIMEOUT_MS` constant near the top of the file):

```ts
const RATE_TIMEOUT_MS = 5000; // hard p95 budget; carrier slowness must not block checkout.
```

```ts
/**
 * Create a shipment and read ALL of its rate options, provider-blind. v1 quotes
 * parcels[0] only. NEVER throws at runtime: on abort/timeout, network error,
 * non-2xx, malformed body, or empty rates[] it returns the static fallback with
 * fallbackUsed:true (load-bearing — no rate = no sale). connect() keeps throw
 * semantics; this runtime path degrades.
 */
export async function fetchEasyPostRates(
  apiKey: string,
  req: RateRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<RateQuoteResult> {
  const start = Date.now();
  const parcel = req.parcels[0]; // ponytail: single-parcel; multi-parcel packing is #6.3.
  const fallback = (): RateQuoteResult => ({
    options: buildFallbackOptions(req),
    fallbackUsed: true,
    latencyMs: Date.now() - start,
    provider: "easypost",
  });
  if (!parcel) return fallback(); // nothing to quote → degrade, never throw.

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RATE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${apiBase()}/shipments`, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(apiKey),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        shipment: {
          to_address: toEasyPostAddress(req.destination),
          from_address: toEasyPostAddress(req.origin),
          parcel: toEasyPostParcel(parcel),
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return fallback(); // non-2xx at RUNTIME → degrade (flagged), never throw.
    const json = (await res.json()) as EasyPostShipmentRates;
    const rawRates = json.rates ?? [];
    let options = rawRates
      .map(mapRateToOption)
      .filter((o): o is NormalizedRateOption => o !== null);
    if (req.serviceFilter && req.serviceFilter.length > 0) {
      const allow = new Set(req.serviceFilter); // ponytail: client-side filter, not server-side.
      options = options.filter((o) => allow.has(o.serviceCode));
    }
    if (options.length === 0) return fallback(); // empty rates[] / all-dropped → degrade.
    return { options, fallbackUsed: false, latencyMs: Date.now() - start, provider: "easypost" };
  } catch {
    // abort/timeout/network/malformed-body → degrade, NEVER propagate (load-bearing).
    return fallback();
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — all degrade paths return `fallbackUsed:true` with a non-empty option set, none throw; the Task-5 happy-path tests still pass (`fallbackUsed:false`, 3 options).

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost-rate.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/easypost-rate: AbortController timeout + degrade-to-fallback contract

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `connect()` + `easyPostRateAdapter` wiring

Mirror the cost adapter's credential load (`integration_credentials` by `(shop_id, kind="easypost_ship")` → `decrypt`), preserving the semantics: `null` = not connected, **THROW** = stored-but-broken (rule 12). Wire it into the exported `easyPostRateAdapter: RateQuoteAdapter` whose source's `getRates` delegates to `fetchEasyPostRates`.

**Files:**
- Modify: `app/lib/ship-cost/adapters/easypost-rate.server.ts`
- Test: `app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`

- [ ] **Step 1: Write the failing test.** Add the `vi.mock` declarations + `maybeSingleMock` near the top of the test file (just below the vitest import line — `vi.mock` is hoisted, and mocking `supabase.server`/`crypto.server` is harmless for the earlier blocks since they never call `connect()`). Mirror `shiphero.test.ts` paths exactly:

```ts
const maybeSingleMock = vi.fn();
vi.mock("../../../supabase.server", () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: maybeSingleMock }) }) }),
    }),
  }),
}));
vi.mock("../../../crypto.server", () => ({
  decrypt: (cipher: string) => {
    if (cipher === "enc(broken)") throw new Error("malformed ciphertext");
    return `key_for_${cipher}`;
  },
}));
```

Add `easyPostRateAdapter` to the `../easypost-rate.server` import, and append this describe block:

```ts
describe("easyPostRateAdapter.connect", () => {
  beforeEach(() => maybeSingleMock.mockReset());

  it("exposes the provider-blind adapter identity", () => {
    expect(easyPostRateAdapter.provider).toBe("easypost");
    expect(easyPostRateAdapter.integrationKind).toBe("easypost_ship");
  });

  it("returns null when NO credential row exists (shop not connected)", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: null });
    expect(await easyPostRateAdapter.connect("shop-1")).toBeNull();
  });

  it("returns a RateQuoteSource exposing getRates when a credential is stored", async () => {
    maybeSingleMock.mockResolvedValue({ data: { access_token_encrypted: "enc(ok)" }, error: null });
    const source = await easyPostRateAdapter.connect("shop-1");
    expect(source).not.toBeNull();
    expect(typeof source?.getRates).toBe("function");
  });

  it("THROWS when a credential is stored but the ciphertext is broken (rule 12, not a silent null)", async () => {
    maybeSingleMock.mockResolvedValue({ data: { access_token_encrypted: "enc(broken)" }, error: null });
    await expect(easyPostRateAdapter.connect("shop-1")).rejects.toThrow(/malformed ciphertext/);
  });

  it("THROWS when the credential read itself errors", async () => {
    maybeSingleMock.mockResolvedValue({ data: null, error: new Error("db down") });
    await expect(easyPostRateAdapter.connect("shop-1")).rejects.toThrow(/db down/);
  });
});
```

Also add `beforeEach` to the top vitest import: `import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";`

- [ ] **Step 2: Run test to verify it fails.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: FAIL — `easyPostRateAdapter` is not exported by `../easypost-rate.server`.

- [ ] **Step 3: Write minimal implementation.** Add the credential imports and `easyPostRateAdapter` to `app/lib/ship-cost/adapters/easypost-rate.server.ts`:

```ts
// (add these imports near the top of the file)
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { decrypt } from "../../crypto.server";
import type {
  Address,
  NormalizedRateOption,
  Parcel,
  RateQuoteAdapter,
  RateQuoteResult,
  RateQuoteSource,
  RateRequest,
} from "./rate-quote";
```

```ts
/**
 * Provider plug. connect() is CONFIG-TIME and keeps the cost-side semantics:
 *   null  = no credential stored (shop not connected)
 *   THROW = a credential is stored but structurally broken (decrypt fails / db error)
 * Runtime carrier failures are handled by fetchEasyPostRates' degrade path, not here.
 */
export const easyPostRateAdapter: RateQuoteAdapter = {
  provider: "easypost",
  integrationKind: "easypost_ship",
  async connect(shopId: string): Promise<RateQuoteSource | null> {
    const sb: SupabaseClient = getSupabase();
    const { data, error } = await sb
      .from("integration_credentials")
      .select("access_token_encrypted")
      .eq("shop_id", shopId)
      .eq("kind", "easypost_ship")
      .maybeSingle();
    if (error) throw error;
    if (!data || !data.access_token_encrypted) return null; // shop not connected.
    const apiKey = decrypt(data.access_token_encrypted as string); // throws if ciphertext is broken (rule 12).
    return {
      getRates: (req: RateRequest) => fetchEasyPostRates(apiKey, req),
    };
  },
};
```

- [ ] **Step 4: Run test to verify it passes.** Run: `npx vitest run app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts`
  Expected: PASS — identity correct; `null` on no row; a working `getRates` source on a valid credential; THROWS on broken ciphertext and on a read error. The full file (all 7 tasks' blocks) is green.

- [ ] **Step 5: Commit.**
```bash
git add app/lib/ship-cost/adapters/easypost-rate.server.ts app/lib/ship-cost/adapters/__tests__/easypost-rate.test.ts
git commit -m "ship-cost/adapters/easypost-rate: connect() + easyPostRateAdapter wiring

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification (Pre-commit gate — run before opening a PR)

Run in order; paste results, do not assert success without evidence (rule 12):

1. `npm run typecheck` → exit 0 (the `satisfies` clauses + strict mode are the contract guard).
2. `npm run lint` → exit 0 (no warnings on the two new files).
3. `npm run test` → exit 0 (the full suite, including `easypost-rate.test.ts` and the untouched `easypost.test.ts`).
4. `npm run build` → exit 0 (Remix + Vite build + `verify:client-bundle`).
5. **No new dependency:** `git diff main -- package.json package-lock.json` shows no added dependency (built-in `fetch` + `AbortController` only).

No Prisma/GraphQL steps apply — this slice adds no schema and no `.graphql`/Admin query (the `ship_rate_quote_log` table is deferred).

## Dashboard parity

Backend lib, no merchant-facing UI in this slice — the parity trigger ("new merchant-facing behavior") does not fire here. **`TODO(parity)`:** when `#6` rates surface to the merchant (rate preview, fallback indicator, or a shipping-rates diagnostics view), mirror that surface into the Calderyn dashboard (`app/routes/dashboard.*`) against its own stack — match the `NormalizedRateOption` / `RateQuoteResult` contract, do not port Polaris JSX. Stated so it is not silently skipped; this slice ships the adapter only, single-sided by design.
