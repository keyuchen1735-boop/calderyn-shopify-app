# Ad Campaign Integrations — Slice 2 (Attribution) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tie each Shopify order back to the ad that earned it — server-side, from the order webhook Shopify already sends — and feed that attributed revenue to the grader, with a confidence level on every match.

**Architecture:** No storefront code. Shopify's `orders/create` webhook already carries `landing_site` (the URL the shopper arrived on, which holds `fbclid`/`gclid`/`ttclid` + `utm_*`), `referring_site`, and `note_attributes`. We parse those server-side in the existing ingest transform, store click-IDs in a new `ad_click_ref` table, resolve order→campaign with a pure matcher (UTM campaign → click-ID platform → referrer host → unknown), write `attribution_fact` with a confidence stamp, then aggregate per campaign/day into `ad_spend_fact.revenue_attrib_cents` (order-attribution overrides the platform-reported number from Slice 1; platform-reported stays as the fallback).

**Tech Stack:** TypeScript (strict, ES modules), `@supabase/supabase-js` (service role), Vitest, existing ingest pipeline (`app/lib/ingest/`, `cron.ingest`). Spec: `docs/superpowers/specs/2026-06-06-ad-campaign-integrations-design.md`.

---

## Open questions resolved (best-practice defaults)

- **Storefront injection mechanism** → **none.** Parse UTM + click-IDs server-side from `landing_site`/`note_attributes` in the order payload. Avoids a Web Pixel extension, its sandbox, app review, and a separate consent gate (Shopify governs the consent for the order data it sends). A Web Pixel for cross-session capture is a later enhancement, out of scope here.
- **Platform-reported reconciliation** → order-attribution **overrides** the per-(campaign,day) platform-reported `revenue_attrib_cents` from Slice 1 *only where we have order attribution*; otherwise the platform-reported value stays. We never add the two (no double-count). The more-trustworthy order number wins when present.

## Known limitations (documented, not bugs)

- `landing_site` is the **session entry URL**. A shopper who clicks an ad, leaves, and returns directly before buying loses the click-ID (same cross-session gap noted in the spec). Covered by the layered fallback; a Web Pixel would shrink it later.
- Click-IDs (`fbclid`/`gclid`/`ttclid`) identify a click, not a campaign. Without a per-click platform API lookup (not in scope), a click-ID alone yields **platform-level** attribution (which platform, `campaign_id` null). Campaign-level attribution comes from `utm_campaign`.
- Attributed revenue is booked to the **order's day** (not the click's day). A v1 simplification.

---

## File Structure

**New files:**
- `app/lib/attribution/parse.ts` — pure: `parseLandingSite()` (extract + sanitize UTM + click-IDs from a URL), `clickIdPlatform()`.
- `app/lib/attribution/match.ts` — pure: `resolveAttribution(signals, campaigns)` → `{ campaignExternalId, platform, method, confidence }`.
- `app/lib/attribution/apply.server.ts` — `applyAttribution(shopId, orderId, day, revenueCents, signals, sb)`: resolve campaigns, run matcher, upsert `attribution_fact` + `ad_click_ref`.
- `app/lib/attribution/revenue.server.ts` — `reconcileAttributedRevenue(shopId, sb)`: aggregate `attribution_fact` → override `ad_spend_fact.revenue_attrib_cents` where present.
- `app/lib/attribution/types.ts` — `AttributionMethod`, `Confidence`, `AttributionSignals`, `CampaignRef`, `AttributionResult`.
- Test files mirror each under `__tests__/`.
- `supabase/migrations/20260606130000_attribution.sql` + `tests/engine/schema/migrations/20260606130000_attribution.sql`.

**Modified files:**
- `app/lib/ingest/types.ts` — extend `OrderRow` with `landing_site`/`referring_site`/`utm_*`.
- `app/lib/ingest/mappers.server.ts` — `parseOrderWebhook` extracts the new fields + returns a `clickRef`.
- `app/lib/ingest/transform.server.ts` — `applyOrder` calls `applyAttribution` after the order upsert.
- `app/routes/cron.ingest.tsx` — run `reconcileAttributedRevenue` after the transform phase.
- `app/lib/gdpr/sweep.server.ts` — add `ad_click_ref` retention purge.

---

## Task 1: Migration — `ad_click_ref` table + `attribution_fact.confidence`

**Files:**
- Create: `supabase/migrations/20260606130000_attribution.sql`
- Create: `tests/engine/schema/migrations/20260606130000_attribution.sql`

Identical SQL in both trees (CI parity). Do NOT apply to prod here — the controller applies it at the end (Task 10), like Slice 1.

- [ ] **Step 1: Write the migration SQL**

Create `supabase/migrations/20260606130000_attribution.sql`:

```sql
-- Slice 2: attribution. Per-order click-ID breadcrumbs + a confidence stamp on
-- attribution_fact. attribution_method stays a free text column; new values
-- written by the matcher: 'utm_exact' | 'click_id' | 'referrer_host' | 'unknown'.

alter table public.attribution_fact
  add column if not exists confidence text not null default 'none';  -- 'high'|'strong'|'rough'|'none'

create table if not exists public.ad_click_ref (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  order_id    uuid references public.order_fact(id) on delete cascade,
  platform    public.ad_platform,                       -- meta|google|tiktok (null if unknown)
  click_id    text not null,                            -- fbclid / gclid / ttclid value
  utm         jsonb,                                    -- captured utm_* params
  captured_at timestamptz not null default now(),
  unique (order_id, platform, click_id)
);

create index if not exists ad_click_ref_shop_idx on public.ad_click_ref (shop_id, captured_at desc);

alter table public.ad_click_ref enable row level security;

create policy ad_click_ref_read on public.ad_click_ref
  for select using (shop_id = public.current_shop_id());
```

- [ ] **Step 2: Copy identical SQL to the test schema tree**

Create `tests/engine/schema/migrations/20260606130000_attribution.sql` byte-for-byte identical to Step 1.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260606130000_attribution.sql tests/engine/schema/migrations/20260606130000_attribution.sql
git commit -m "supabase/migrations: ad_click_ref table + attribution_fact.confidence"
```

---

## Task 2: Pure parse helpers (landing-site → UTM + click-IDs)

**Files:**
- Create: `app/lib/attribution/types.ts`
- Create: `app/lib/attribution/parse.ts`
- Test: `app/lib/attribution/__tests__/parse.test.ts`

`parseLandingSite` extracts `utm_*` params and `fbclid`/`gclid`/`ttclid` from a URL, **sanitizing** untrusted input: values capped at 512 chars, non-string/empty ignored, malformed URLs return empty (never throw). `clickIdPlatform` maps a click-ID kind to a platform.

- [ ] **Step 1: Write the failing test**

Create `app/lib/attribution/__tests__/parse.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseLandingSite, clickIdPlatform } from "../parse";

describe("parseLandingSite", () => {
  it("extracts utm params and click ids from a relative landing URL", () => {
    const out = parseLandingSite(
      "/products/widget?utm_source=facebook&utm_medium=cpc&utm_campaign=spring&fbclid=ABC123",
    );
    expect(out.utm).toMatchObject({ utm_source: "facebook", utm_medium: "cpc", utm_campaign: "spring" });
    expect(out.clickIds).toEqual({ fbclid: "ABC123" });
  });

  it("handles absolute URLs and all three click-id kinds", () => {
    expect(parseLandingSite("https://shop.com/?gclid=G1").clickIds).toEqual({ gclid: "G1" });
    expect(parseLandingSite("https://shop.com/?ttclid=T1").clickIds).toEqual({ ttclid: "T1" });
  });

  it("returns empty for null / no query / malformed input, never throws", () => {
    expect(parseLandingSite(null)).toEqual({ utm: {}, clickIds: {} });
    expect(parseLandingSite("/plain-page")).toEqual({ utm: {}, clickIds: {} });
    expect(parseLandingSite("::::not a url::::")).toEqual({ utm: {}, clickIds: {} });
  });

  it("caps oversized values to 512 chars (sanitize untrusted input)", () => {
    const huge = "x".repeat(1000);
    const out = parseLandingSite(`/?utm_campaign=${huge}&fbclid=${huge}`);
    expect(out.utm.utm_campaign?.length).toBe(512);
    expect(out.clickIds.fbclid?.length).toBe(512);
  });

  it("ignores empty param values", () => {
    expect(parseLandingSite("/?utm_source=&fbclid=")).toEqual({ utm: {}, clickIds: {} });
  });
});

describe("clickIdPlatform", () => {
  it("maps each click-id kind to its platform", () => {
    expect(clickIdPlatform("fbclid")).toBe("meta");
    expect(clickIdPlatform("gclid")).toBe("google");
    expect(clickIdPlatform("ttclid")).toBe("tiktok");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/attribution/__tests__/parse.test.ts`
Expected: FAIL — cannot find module `../parse`.

- [ ] **Step 3: Write the types**

Create `app/lib/attribution/types.ts`:

```ts
import type { Platform } from "../ads/adapter";

export type { Platform };

export type ClickIdKind = "fbclid" | "gclid" | "ttclid";

export type AttributionMethod = "utm_exact" | "click_id" | "referrer_host" | "unknown";

export type Confidence = "high" | "strong" | "rough" | "none";

/** UTM params we read (all optional). */
export interface Utm {
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

/** Click-ID breadcrumbs keyed by kind. */
export type ClickIds = Partial<Record<ClickIdKind, string>>;

/** Everything the matcher needs from one order. */
export interface AttributionSignals {
  utm: Utm;
  clickIds: ClickIds;
  referringSite: string | null;
}

/** A campaign the order could be attributed to. */
export interface CampaignRef {
  id: string; // ad_campaign_dim uuid
  external_id: string;
  name: string;
  platform: Platform;
}

export interface AttributionResult {
  campaignId: string | null;
  platform: Platform | null;
  method: AttributionMethod;
  confidence: Confidence;
}
```

- [ ] **Step 4: Write the parser**

Create `app/lib/attribution/parse.ts`:

```ts
// Pure parsing of a Shopify landing_site URL into UTM params + ad click-IDs.
// Untrusted input: values are capped and malformed URLs degrade to empty —
// never throws (rule 12: a bad URL must not abort order ingestion).

import type { Utm, ClickIds, ClickIdKind, Platform } from "./types";

const MAX_LEN = 512;
const UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

const CLICK_PLATFORM: Record<ClickIdKind, Platform> = {
  fbclid: "meta",
  gclid: "google",
  ttclid: "tiktok",
};

export function clickIdPlatform(kind: ClickIdKind): Platform {
  return CLICK_PLATFORM[kind];
}

function clean(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.slice(0, MAX_LEN);
  return trimmed.length ? trimmed : null;
}

export function parseLandingSite(landingSite: string | null): { utm: Utm; clickIds: ClickIds } {
  const utm: Utm = {};
  const clickIds: ClickIds = {};
  if (!landingSite) return { utm, clickIds };

  // Resolve against a dummy base so relative paths ("/products/x?...") parse.
  let params: URLSearchParams;
  try {
    params = new URL(landingSite, "https://placeholder.invalid").searchParams;
  } catch {
    return { utm, clickIds };
  }

  for (const key of UTM_KEYS) {
    const v = clean(params.get(key));
    if (v) utm[key] = v;
  }
  for (const key of CLICK_KEYS) {
    const v = clean(params.get(key));
    if (v) clickIds[key] = v;
  }
  return { utm, clickIds };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run app/lib/attribution/__tests__/parse.test.ts`
Expected: PASS (all 7).

- [ ] **Step 6: Commit**

```bash
git add app/lib/attribution/types.ts app/lib/attribution/parse.ts app/lib/attribution/__tests__/parse.test.ts
git commit -m "app/lib/attribution/parse: extract UTM + click-IDs from landing_site (sanitized)"
```

---

## Task 3: Capture order attribution fields in the webhook parser

**Files:**
- Modify: `app/lib/ingest/types.ts` (extend `OrderRow`)
- Modify: `app/lib/ingest/mappers.server.ts` (`parseOrderWebhook` reads new fields)
- Test: `app/lib/ingest/__tests__/mappers.test.ts` (extend) — if no such file exists, create `app/lib/ingest/__tests__/order-attribution.test.ts`

`order_fact` already has `landing_site`, `referring_site`, `utm_source/medium/campaign/content/term` columns (see `tests/engine/schema/migrations/20260426000003_orders_and_fulfillments.sql`). The parser must populate them and surface the click-IDs.

- [ ] **Step 1: Extend the `OrderRow` type**

In `app/lib/ingest/types.ts`, add to the `OrderRow` type (keep existing fields):

```ts
  landing_site: string | null;
  referring_site: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
```

- [ ] **Step 2: Write the failing test**

Create `app/lib/ingest/__tests__/order-attribution.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseOrderWebhook } from "../mappers.server";

const base = {
  admin_graphql_api_id: "gid://shopify/Order/1",
  name: "#1001",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  total_price: "100.00",
  currency: "USD",
  line_items: [],
};

describe("parseOrderWebhook attribution capture", () => {
  it("captures landing_site, referring_site and parses utm + click-ids", () => {
    const { order, clickRef } = parseOrderWebhook({
      ...base,
      landing_site: "/products/x?utm_source=facebook&utm_campaign=spring&fbclid=ABC",
      referring_site: "https://l.facebook.com/",
    });
    expect(order.landing_site).toBe("/products/x?utm_source=facebook&utm_campaign=spring&fbclid=ABC");
    expect(order.referring_site).toBe("https://l.facebook.com/");
    expect(order.utm_source).toBe("facebook");
    expect(order.utm_campaign).toBe("spring");
    expect(clickRef.clickIds).toEqual({ fbclid: "ABC" });
    expect(clickRef.utm).toMatchObject({ utm_source: "facebook", utm_campaign: "spring" });
    expect(clickRef.referringSite).toBe("https://l.facebook.com/");
  });

  it("defaults attribution fields to null when absent", () => {
    const { order, clickRef } = parseOrderWebhook(base);
    expect(order.landing_site).toBeNull();
    expect(order.utm_source).toBeNull();
    expect(clickRef.clickIds).toEqual({});
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/__tests__/order-attribution.test.ts`
Expected: FAIL — `parseOrderWebhook` return has no `clickRef` / order has no `landing_site`.

- [ ] **Step 4: Update `parseOrderWebhook`**

In `app/lib/ingest/mappers.server.ts`:

Add the import at the top:
```ts
import { parseLandingSite } from "../attribution/parse";
import type { AttributionSignals } from "../attribution/types";
```

Extend `RawOrderWebhook` with the new optional fields:
```ts
  landing_site?: string | null;
  referring_site?: string | null;
```

Change the `parseOrderWebhook` return type and body. Replace the existing function signature/return with:

```ts
export function parseOrderWebhook(p: RawOrderWebhook): {
  order: ParsedOrderHeader;
  lines: OrderLineRow[];
  clickRef: AttributionSignals;
} {
  const updatedAt = String(p.updated_at ?? p.created_at);
  const landingSite = p.landing_site ?? null;
  const referringSite = p.referring_site ?? null;
  const { utm, clickIds } = parseLandingSite(landingSite);
  const order: ParsedOrderHeader = {
    external_id: String(p.admin_graphql_api_id),
    order_number: String(p.name),
    created_at_source: String(p.created_at),
    total_cents: moneyToCents(p.total_price),
    subtotal_cents: moneyToCents(p.subtotal_price),
    shipping_cents: moneyToCents(p.total_shipping_price_set?.shop_money?.amount),
    tax_cents: moneyToCents(p.total_tax),
    discount_cents: moneyToCents(p.total_discounts),
    currency: String(p.currency ?? "USD"),
    financial_status: p.financial_status ?? null,
    source_version: Date.parse(updatedAt),
    landing_site: landingSite,
    referring_site: referringSite,
    utm_source: utm.utm_source ?? null,
    utm_medium: utm.utm_medium ?? null,
    utm_campaign: utm.utm_campaign ?? null,
    utm_content: utm.utm_content ?? null,
    utm_term: utm.utm_term ?? null,
  };
  const lines: OrderLineRow[] = (p.line_items ?? []).map((ln) => {
    const priceCents = moneyToCents(ln.price);
    return {
      sku_external_id: ln.variant_id ? `gid://shopify/ProductVariant/${ln.variant_id}` : null,
      external_line_id: String(ln.admin_graphql_api_id),
      quantity: Number(ln.quantity ?? 0),
      price_cents: priceCents,
      total_cents: priceCents * Number(ln.quantity ?? 0),
    };
  });
  return { order, lines, clickRef: { utm, clickIds, referringSite } };
}
```

Note: `ParsedOrderHeader = Omit<OrderRow, "shop_id">`, so extending `OrderRow` in Step 1 makes these fields required on the header — that's why all are set explicitly above. Also update `mapOrder` (the GraphQL backfill path) to set the new fields to `null` (backfill has no landing data), so it still satisfies `OrderRow`:

```ts
    // backfill (GraphQL) does not carry landing/UTM — null them.
    landing_site: null,
    referring_site: null,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
```

(append inside the `mapOrder` return object).

- [ ] **Step 5: Run the test to verify it passes + typecheck**

Run: `npx vitest run app/lib/ingest/__tests__/order-attribution.test.ts && npm run typecheck`
Expected: PASS; tsc exit 0 (any other caller of `parseOrderWebhook`/`mapOrder` must still compile — the transform worker reads `.order`/`.lines`, unaffected by the added `.clickRef`).

- [ ] **Step 6: Commit**

```bash
git add app/lib/ingest/types.ts app/lib/ingest/mappers.server.ts app/lib/ingest/__tests__/order-attribution.test.ts
git commit -m "app/lib/ingest: capture landing_site/referring_site/UTM + click-ids on orders"
```

---

## Task 4: Pure attribution matcher

**Files:**
- Create: `app/lib/attribution/match.ts`
- Test: `app/lib/attribution/__tests__/match.test.ts`

`resolveAttribution(signals, campaigns)` returns exactly one result. Precedence: UTM campaign match (campaign-level) → click-ID (platform-level) → referrer host (platform-level) → unknown.

- [ ] **Step 1: Write the failing test**

Create `app/lib/attribution/__tests__/match.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveAttribution } from "../match";
import type { CampaignRef, AttributionSignals } from "../types";

const campaigns: CampaignRef[] = [
  { id: "u-meta", external_id: "23998", name: "Spring Sale", platform: "meta" },
  { id: "u-goog", external_id: "G-77", name: "Brand Search", platform: "google" },
];

const empty: AttributionSignals = { utm: {}, clickIds: {}, referringSite: null };

describe("resolveAttribution", () => {
  it("matches utm_campaign by name (case-insensitive) → utm_exact, strong", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "spring sale", utm_source: "facebook" } }, campaigns);
    expect(r).toEqual({ campaignId: "u-meta", platform: "meta", method: "utm_exact", confidence: "strong" });
  });

  it("matches utm_campaign by external_id → utm_exact", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "G-77" } }, campaigns);
    expect(r.campaignId).toBe("u-goog");
    expect(r.method).toBe("utm_exact");
  });

  it("upgrades to high confidence when a click-id corroborates the utm campaign match", () => {
    const r = resolveAttribution(
      { ...empty, utm: { utm_campaign: "Spring Sale" }, clickIds: { fbclid: "X" } },
      campaigns,
    );
    expect(r).toMatchObject({ campaignId: "u-meta", method: "utm_exact", confidence: "high" });
  });

  it("falls back to click-id platform attribution when no utm campaign matches", () => {
    const r = resolveAttribution({ ...empty, clickIds: { gclid: "Y" } }, campaigns);
    expect(r).toEqual({ campaignId: null, platform: "google", method: "click_id", confidence: "rough" });
  });

  it("falls back to referrer host platform attribution", () => {
    const r = resolveAttribution({ ...empty, referringSite: "https://l.facebook.com/path" }, campaigns);
    expect(r).toEqual({ campaignId: null, platform: "meta", method: "referrer_host", confidence: "rough" });
  });

  it("returns unknown when nothing matches", () => {
    expect(resolveAttribution(empty, campaigns)).toEqual({
      campaignId: null, platform: null, method: "unknown", confidence: "none",
    });
  });

  it("does not match an unknown utm_campaign to any campaign", () => {
    const r = resolveAttribution({ ...empty, utm: { utm_campaign: "nonexistent" } }, campaigns);
    expect(r.method).toBe("unknown");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/attribution/__tests__/match.test.ts`
Expected: FAIL — cannot find module `../match`.

- [ ] **Step 3: Write the matcher**

Create `app/lib/attribution/match.ts`:

```ts
// Pure order→campaign matcher. Precedence (best evidence first):
//   1. utm_campaign resolves to a known campaign  -> campaign-level (utm_exact)
//   2. a click-id is present                      -> platform-level (click_id)
//   3. referring_site host maps to a platform     -> platform-level (referrer_host)
//   4. nothing                                     -> unknown
// Confidence: utm match corroborated by a click-id = high; utm match alone =
// strong; platform-only (click-id / referrer) = rough; nothing = none.

import type {
  AttributionSignals,
  AttributionResult,
  CampaignRef,
  ClickIdKind,
  Platform,
} from "./types";
import { clickIdPlatform } from "./parse";

const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

const REFERRER_HOST_PLATFORM: Array<{ needle: string; platform: Platform }> = [
  { needle: "facebook.", platform: "meta" },
  { needle: "instagram.", platform: "meta" },
  { needle: "google.", platform: "google" },
  { needle: "googleadservices.", platform: "google" },
  { needle: "tiktok.", platform: "tiktok" },
];

function firstClickId(signals: AttributionSignals): { kind: ClickIdKind; platform: Platform } | null {
  for (const key of CLICK_KEYS) {
    if (signals.clickIds[key]) return { kind: key, platform: clickIdPlatform(key) };
  }
  return null;
}

function matchCampaign(utmCampaign: string, campaigns: CampaignRef[]): CampaignRef | null {
  const needle = utmCampaign.trim().toLowerCase();
  if (!needle) return null;
  // external_id exact, then case-insensitive name.
  return (
    campaigns.find((c) => c.external_id.toLowerCase() === needle) ??
    campaigns.find((c) => c.name.trim().toLowerCase() === needle) ??
    null
  );
}

function referrerPlatform(referringSite: string | null): Platform | null {
  if (!referringSite) return null;
  let host: string;
  try {
    host = new URL(referringSite).hostname.toLowerCase();
  } catch {
    return null;
  }
  return REFERRER_HOST_PLATFORM.find((m) => host.includes(m.needle))?.platform ?? null;
}

export function resolveAttribution(
  signals: AttributionSignals,
  campaigns: CampaignRef[],
): AttributionResult {
  const click = firstClickId(signals);

  // 1. UTM campaign → campaign-level
  const utmCampaign = signals.utm.utm_campaign;
  if (utmCampaign) {
    const campaign = matchCampaign(utmCampaign, campaigns);
    if (campaign) {
      return {
        campaignId: campaign.id,
        platform: campaign.platform,
        method: "utm_exact",
        confidence: click ? "high" : "strong",
      };
    }
  }

  // 2. Click-id → platform-level
  if (click) {
    return { campaignId: null, platform: click.platform, method: "click_id", confidence: "rough" };
  }

  // 3. Referrer host → platform-level
  const refPlatform = referrerPlatform(signals.referringSite);
  if (refPlatform) {
    return { campaignId: null, platform: refPlatform, method: "referrer_host", confidence: "rough" };
  }

  // 4. Nothing
  return { campaignId: null, platform: null, method: "unknown", confidence: "none" };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/attribution/__tests__/match.test.ts`
Expected: PASS (all 7).

- [ ] **Step 5: Commit**

```bash
git add app/lib/attribution/match.ts app/lib/attribution/__tests__/match.test.ts
git commit -m "app/lib/attribution/match: order→campaign resolver with confidence"
```

---

## Task 5: Attribution write step

**Files:**
- Create: `app/lib/attribution/apply.server.ts`
- Test: `app/lib/attribution/__tests__/apply.test.ts`

`applyAttribution(shopId, orderId, revenueCents, signals, sb)`: loads the shop's campaigns, runs `resolveAttribution`, upserts one `attribution_fact` row (with `confidence`), and upserts an `ad_click_ref` row per captured click-ID.

- [ ] **Step 1: Write the failing test**

Create `app/lib/attribution/__tests__/apply.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { applyAttribution } from "../apply.server";
import type { AttributionSignals } from "../types";

const SHOP = "00000000-0000-0000-0000-000000000010";
const ORDER = "00000000-0000-0000-0000-0000000000aa";

function fakeSb(campaignRows: Array<Record<string, unknown>>) {
  const calls = { upserts: [] as Array<{ table: string; rows: unknown; opts: unknown }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.upsert = vi.fn((rows: unknown, opts: unknown) => {
      calls.upserts.push({ table, rows, opts });
      return chain;
    });
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "ad_campaign_dim" ? campaignRows : [], error: null });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

const campaigns = [{ id: "u-meta", external_id: "23998", name: "Spring Sale", platform: "meta" }];

describe("applyAttribution", () => {
  it("writes a campaign-attributed fact with confidence + a click_ref row", async () => {
    const signals: AttributionSignals = {
      utm: { utm_campaign: "Spring Sale" }, clickIds: { fbclid: "ABC" }, referringSite: null,
    };
    const { sb, calls } = fakeSb(campaigns);
    await applyAttribution(SHOP, ORDER, 10000, signals, sb);

    const af = calls.upserts.find((u) => u.table === "attribution_fact");
    expect(af?.opts).toEqual({ onConflict: "order_id,campaign_id" });
    expect((af?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, order_id: ORDER, campaign_id: "u-meta", platform: "meta",
      attributed_revenue_cents: 10000, attribution_method: "utm_exact", confidence: "high",
    });
    const cr = calls.upserts.find((u) => u.table === "ad_click_ref");
    expect((cr?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP, order_id: ORDER, platform: "meta", click_id: "ABC",
    });
  });

  it("writes an unknown (campaign_id null) fact and no click_ref when there are no signals", async () => {
    const { sb, calls } = fakeSb(campaigns);
    await applyAttribution(SHOP, ORDER, 5000, { utm: {}, clickIds: {}, referringSite: null }, sb);
    const af = calls.upserts.find((u) => u.table === "attribution_fact");
    expect((af?.rows as Record<string, unknown>)).toMatchObject({
      campaign_id: null, platform: null, attribution_method: "unknown", confidence: "none",
    });
    expect(calls.upserts.find((u) => u.table === "ad_click_ref")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/attribution/__tests__/apply.test.ts`
Expected: FAIL — cannot find module `../apply.server`.

- [ ] **Step 3: Write the apply step**

Create `app/lib/attribution/apply.server.ts`:

```ts
// Resolve one order to a campaign and persist the result. Writes exactly one
// attribution_fact row (campaign_id null for platform-level/unknown) and one
// ad_click_ref row per captured click-id. Called from the ingest transform
// after order_fact is upserted.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttributionSignals, CampaignRef, ClickIdKind } from "./types";
import { resolveAttribution } from "./match";
import { clickIdPlatform } from "./parse";

const CLICK_KEYS: ClickIdKind[] = ["fbclid", "gclid", "ttclid"];

export async function applyAttribution(
  shopId: string,
  orderId: string,
  revenueCents: number,
  signals: AttributionSignals,
  sb: SupabaseClient,
): Promise<void> {
  const { data: campRows, error: cErr } = await sb
    .from("ad_campaign_dim")
    .select("id, external_id, name, platform")
    .eq("shop_id", shopId);
  if (cErr) throw cErr;
  const campaigns = (campRows ?? []) as CampaignRef[];

  const result = resolveAttribution(signals, campaigns);

  const { error: aErr } = await sb.from("attribution_fact").upsert(
    {
      shop_id: shopId,
      order_id: orderId,
      campaign_id: result.campaignId,
      platform: result.platform,
      attributed_revenue_cents: result.campaignId ? revenueCents : 0,
      attribution_method: result.method,
      confidence: result.confidence,
    },
    { onConflict: "order_id,campaign_id" },
  );
  if (aErr) throw aErr;

  // Persist captured click-ids (one row each). Keyed (order_id, platform, click_id).
  const clickRows = CLICK_KEYS.flatMap((kind) => {
    const value = signals.clickIds[kind];
    if (!value) return [];
    return [
      {
        shop_id: shopId,
        order_id: orderId,
        platform: clickIdPlatform(kind),
        click_id: value,
        utm: signals.utm,
      },
    ];
  });
  if (clickRows.length) {
    const { error: clErr } = await sb
      .from("ad_click_ref")
      .upsert(clickRows, { onConflict: "order_id,platform,click_id" });
    if (clErr) throw clErr;
  }
}
```

Note on revenue: `attributed_revenue_cents` is booked only when we resolved an actual campaign (`campaignId` non-null). Platform-level/unknown rows carry 0 so they never inflate a campaign's revenue.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/attribution/__tests__/apply.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add app/lib/attribution/apply.server.ts app/lib/attribution/__tests__/apply.test.ts
git commit -m "app/lib/attribution/apply: persist attribution_fact + ad_click_ref per order"
```

---

## Task 6: Wire attribution into the order transform

**Files:**
- Modify: `app/lib/ingest/transform.server.ts` (`applyOrder` calls `applyAttribution`)
- Test: `app/lib/ingest/__tests__/transform.test.ts` (extend — confirm attribution runs)

- [ ] **Step 1: Write the failing test**

Read the existing `app/lib/ingest/__tests__/transform.test.ts` to match its fake-Supabase pattern, then add a test asserting that processing an `ORDERS_CREATE` webhook whose payload has a `landing_site` with `utm_campaign` results in an `attribution_fact` upsert. Use the file's existing fake (extend it to record `attribution_fact` upserts and to return a campaign row from `ad_campaign_dim`). The assertion:

```ts
it("writes attribution_fact when an order carries a matching utm_campaign", async () => {
  // arrange: fake raw_shopify_webhook row with ORDERS_CREATE payload incl.
  //   landing_site "/p/x?utm_campaign=Spring%20Sale", and ad_campaign_dim
  //   returning { id:"u-meta", external_id:"1", name:"Spring Sale", platform:"meta" }
  // act: await transformPendingWebhooks()
  // assert: an upsert to "attribution_fact" occurred with campaign_id "u-meta",
  //   attribution_method "utm_exact"
});
```

(Fill in using the existing test's fake harness shape — mirror how it already asserts `order_fact`/`order_line_fact` upserts.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/ingest/__tests__/transform.test.ts`
Expected: FAIL — no `attribution_fact` upsert recorded.

- [ ] **Step 3: Wire `applyAttribution` into `applyOrder`**

In `app/lib/ingest/transform.server.ts`:

Add the import:
```ts
import { applyAttribution } from "../attribution/apply.server";
```

Capture `clickRef` from the parse and call attribution after the order upsert. Change the destructure and add the call right after `orderId` is known:

```ts
  const { order, lines, clickRef } = parseOrderWebhook(payload as Parameters<typeof parseOrderWebhook>[0]);
  // ... existing order_fact upsert ...
  const orderId = (oUp as { id: string }).id;

  // Attribution: tie this order to the ad that earned it (best-effort; never
  // aborts ingestion — failures surface via the caller's DLQ path).
  await applyAttribution(shopId, orderId, order.total_cents, clickRef, sb);
```

(Insert the `applyAttribution` call immediately after `const orderId = ...;` and before the `if (!lines.length) return 1;` line. Pass `sb` — the function already holds `const sb = getSupabase();` at the top of `applyOrder`.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run app/lib/ingest && npm run typecheck`
Expected: PASS; tsc exit 0. The existing order/line tests still pass (the added call is additive; the fake must return `[]` for `ad_campaign_dim` in those cases, yielding an `unknown` attribution row, which is harmless).

- [ ] **Step 5: Commit**

```bash
git add app/lib/ingest/transform.server.ts app/lib/ingest/__tests__/transform.test.ts
git commit -m "app/lib/ingest: attribute each order after upsert (transform pipeline)"
```

---

## Task 7: Revenue feed — reconcile attributed revenue into ad_spend_fact

**Files:**
- Create: `app/lib/attribution/revenue.server.ts`
- Test: `app/lib/attribution/__tests__/revenue.test.ts`

`reconcileAttributedRevenue(shopId, sb)`: for each (campaign, order-day) where we have order attribution, sum `attribution_fact.attributed_revenue_cents` (joined to `order_fact.created_at_source`'s date) and write it into `ad_spend_fact.revenue_attrib_cents` for that campaign/day — **overriding** the platform-reported value from Slice 1. Rows with no order attribution keep their platform-reported value.

To keep this testable and avoid a complex SQL join in app code, the function: (1) selects attributed rows joined to their order day via a Postgres RPC `attributed_revenue_by_campaign_day(shop)` *if present*, else (2) does it in two queries (fetch attribution_fact rows with campaign_id; fetch the matching order days; aggregate in TS). Use approach (2) for portability.

- [ ] **Step 1: Write the failing test**

Create `app/lib/attribution/__tests__/revenue.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { reconcileAttributedRevenue } from "../revenue.server";

const SHOP = "00000000-0000-0000-0000-000000000010";

// Fake returns: attribution_fact rows (campaign_id, order_id, attributed_revenue_cents)
// and order_fact rows (id, created_at_source). Records ad_spend_fact updates.
function fakeSb(attr: Array<Record<string, unknown>>, orders: Array<Record<string, unknown>>) {
  const calls = { updates: [] as Array<{ match: Record<string, unknown>; values: Record<string, unknown> }> };
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    const match: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn((col: string, val: unknown) => { match[col] = val; return chain; });
    chain.in = vi.fn(() => chain);
    chain.gt = vi.fn(() => chain);
    chain.update = vi.fn((values: Record<string, unknown>) => {
      // capture subsequent .eq() matches for this update
      const upd: Record<string, unknown> = {};
      const updChain: Record<string, unknown> = {
        eq: vi.fn((c: string, v: unknown) => { upd[c] = v; return updChain; }),
        then: (resolve: (r: { error: null }) => unknown) => {
          calls.updates.push({ match: { ...upd }, values });
          return resolve({ error: null });
        },
      };
      return updChain;
    });
    chain.then = (resolve: (r: { data: unknown; error: null }) => unknown) =>
      resolve({ data: table === "attribution_fact" ? attr : orders, error: null });
    return chain;
  }
  const sb = { from: vi.fn((t: string) => builder(t)) } as unknown as SupabaseClient;
  return { sb, calls };
}

describe("reconcileAttributedRevenue", () => {
  it("sums attributed revenue per campaign/day and updates ad_spend_fact", async () => {
    const attr = [
      { campaign_id: "u-meta", order_id: "o1", attributed_revenue_cents: 10000 },
      { campaign_id: "u-meta", order_id: "o2", attributed_revenue_cents: 5000 },
    ];
    const orders = [
      { id: "o1", created_at_source: "2026-06-01T10:00:00Z" },
      { id: "o2", created_at_source: "2026-06-01T20:00:00Z" },
    ];
    const { sb, calls } = fakeSb(attr, orders);
    await reconcileAttributedRevenue(SHOP, sb);
    expect(calls.updates).toContainEqual({
      match: { campaign_id: "u-meta", day: "2026-06-01" },
      values: { revenue_attrib_cents: 15000 },
    });
  });

  it("ignores attribution rows with no campaign (campaign_id null)", async () => {
    const attr = [{ campaign_id: null, order_id: "o3", attributed_revenue_cents: 0 }];
    const orders = [{ id: "o3", created_at_source: "2026-06-02T00:00:00Z" }];
    const { sb, calls } = fakeSb(attr, orders);
    await reconcileAttributedRevenue(SHOP, sb);
    expect(calls.updates).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run app/lib/attribution/__tests__/revenue.test.ts`
Expected: FAIL — cannot find module `../revenue.server`.

- [ ] **Step 3: Write the reconciler**

Create `app/lib/attribution/revenue.server.ts`:

```ts
// Reconcile order-level attributed revenue into ad_spend_fact.revenue_attrib_cents.
// Order attribution OVERRIDES the platform-reported value (from Slice 1) for any
// (campaign, day) we actually attributed; untouched (campaign, day) rows keep the
// platform-reported number. Revenue is booked to the ORDER's day (v1 simplification).

import type { SupabaseClient } from "@supabase/supabase-js";

export async function reconcileAttributedRevenue(
  shopId: string,
  sb: SupabaseClient,
): Promise<void> {
  const { data: attrRows, error: aErr } = await sb
    .from("attribution_fact")
    .select("campaign_id, order_id, attributed_revenue_cents")
    .eq("shop_id", shopId);
  if (aErr) throw aErr;

  const attributed = (attrRows ?? []).filter(
    (r) => (r as { campaign_id: string | null }).campaign_id,
  ) as Array<{ campaign_id: string; order_id: string; attributed_revenue_cents: number }>;
  if (!attributed.length) return;

  const { data: orderRows, error: oErr } = await sb
    .from("order_fact")
    .select("id, created_at_source")
    .eq("shop_id", shopId)
    .in("id", attributed.map((r) => r.order_id));
  if (oErr) throw oErr;
  const dayByOrder = new Map<string, string>(
    (orderRows ?? []).map((o) => [
      String((o as { id: string }).id),
      String((o as { created_at_source: string }).created_at_source).slice(0, 10),
    ]),
  );

  // Sum per (campaign_id, day).
  const sums = new Map<string, { campaignId: string; day: string; cents: number }>();
  for (const r of attributed) {
    const day = dayByOrder.get(r.order_id);
    if (!day) continue;
    const key = `${r.campaign_id}|${day}`;
    const acc = sums.get(key) ?? { campaignId: r.campaign_id, day, cents: 0 };
    acc.cents += Number(r.attributed_revenue_cents ?? 0);
    sums.set(key, acc);
  }

  for (const { campaignId, day, cents } of sums.values()) {
    const { error: uErr } = await sb
      .from("ad_spend_fact")
      .update({ revenue_attrib_cents: cents })
      .eq("campaign_id", campaignId)
      .eq("day", day);
    if (uErr) throw uErr;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run app/lib/attribution/__tests__/revenue.test.ts`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add app/lib/attribution/revenue.server.ts app/lib/attribution/__tests__/revenue.test.ts
git commit -m "app/lib/attribution/revenue: order-attributed revenue overrides platform-reported"
```

---

## Task 8: Run the reconciler in cron.ingest

**Files:**
- Modify: `app/routes/cron.ingest.tsx`
- Test: `app/routes/__tests__/cron.ingest.test.ts` (extend if present; else add a focused test)

After the transform phase, run `reconcileAttributedRevenue` for each shop that had orders processed (or, simply, for all `live` shops — bounded). Mirror the existing per-shop isolation pattern in that route.

- [ ] **Step 1: Read `app/routes/cron.ingest.tsx`** and its test to match the established loader shape + summary object + how shops are selected.

- [ ] **Step 2: Write/extend the failing test**

Add a test asserting that after the transform phase, `reconcileAttributedRevenue` is invoked per processed shop and its failure for one shop is isolated (recorded in the summary, doesn't abort). Mock `~/lib/attribution/revenue.server` with `vi.fn`. (Match the route's existing test harness; if none exists, create `app/routes/__tests__/cron.ingest.test.ts` mirroring `cron.ingest-ads.test.ts`'s `vi.hoisted` + mock pattern.)

- [ ] **Step 3: Wire it in**

In `app/routes/cron.ingest.tsx`, import and call after the transform phase:

```ts
import { reconcileAttributedRevenue } from "~/lib/attribution/revenue.server";
```

After the transform step completes, for the shops in scope run `reconcileAttributedRevenue(shopId, sb)` inside a try/catch that records failures in the summary (`summary.attributionErrors.push(...)`) without aborting other shops. Add `attributionErrors: []` to the summary object.

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run app/routes/__tests__/cron.ingest.test.ts && npm run typecheck`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/routes/cron.ingest.tsx app/routes/__tests__/cron.ingest.test.ts
git commit -m "routes/cron.ingest: reconcile attributed revenue after transform"
```

---

## Task 9: ad_click_ref retention purge (GDPR / data safety)

**Files:**
- Modify: `app/lib/gdpr/sweep.server.ts`
- Test: `app/lib/gdpr/__tests__/sweep.test.ts` (extend)

`ad_click_ref` rows hold tracking identifiers — they must be purged on a retention schedule (and they already cascade-delete with the shop via the `shop_id` FK, covering `shop/redact`). Add a 90-day retention purge mirroring the existing `raw_shopify_webhook` retention sweep.

- [ ] **Step 1: Read `app/lib/gdpr/sweep.server.ts`** to find the `raw_shopify_webhook` retention deletion (the `DELETE ... WHERE received_at < cutoff` pattern) and its test.

- [ ] **Step 2: Write the failing test**

In `app/lib/gdpr/__tests__/sweep.test.ts`, add a test asserting the sweep issues a delete on `ad_click_ref` for rows older than the retention cutoff (mirror the existing raw_shopify_webhook retention assertion; reuse its fake clock + fake Supabase).

- [ ] **Step 3: Add the purge**

In `sweep.server.ts`, alongside the `raw_shopify_webhook` retention deletion, add an `ad_click_ref` purge using the same cutoff/idiom:

```ts
// Tracking identifiers: purge click-id breadcrumbs past the retention window.
// (attribution_fact keeps the resolved result; the raw click-id does not persist.)
await sb.from("ad_click_ref").delete().lt("captured_at", cutoffIso);
```

Use the same `cutoffIso` variable the existing retention block computes (90-day). If the retention constant is local, reuse it; do not introduce a second window.

- [ ] **Step 4: Run the test + typecheck**

Run: `npx vitest run app/lib/gdpr && npm run typecheck`
Expected: PASS; tsc exit 0.

- [ ] **Step 5: Commit**

```bash
git add app/lib/gdpr/sweep.server.ts app/lib/gdpr/__tests__/sweep.test.ts
git commit -m "app/lib/gdpr/sweep: retention purge for ad_click_ref tracking ids"
```

---

## Task 10: Full pre-commit gate + prod migration + PR update

**Files:** none (verification + ops)

- [ ] **Step 1: Full eval pipeline (CLAUDE.md gate)**

Run, in order, and paste results:

```bash
npm run typecheck
npm run lint
npm run build
npx vitest run
```

Expected: typecheck exit 0; lint 0 errors on touched files; build completes; all suites green.

- [ ] **Step 2: `/code-review` on the working tree**

Resolve blockers; downgrade nits with one-line justifications.

- [ ] **Step 3: Patch sanity**

```bash
git diff --stat
git diff --check
```

No whitespace errors; no stray `console.log`/`.only`/`TODO(me)` introduced.

- [ ] **Step 4: Apply the migration to prod (controller-confirmed)**

Verify current enums/columns, then apply `20260606130000_attribution.sql` to the prod Supabase project (`ajgrmnvzxfxxlwrxcgnu`) via the Supabase MCP `apply_migration` (name `attribution`). Re-query to confirm `attribution_fact.confidence` exists and `ad_click_ref` is present with RLS enabled. (This is the one outward-facing step — do it only with explicit go-ahead.)

- [ ] **Step 5: Push + update the PR**

```bash
git push
```

The branch already has PR #9 open against `main`; pushing updates it. Add a comment summarizing Slice 2, or open a fresh PR if Slice 1 has merged by now.

---

## Self-Review Notes

- **Spec coverage (Slice 2 bullets):** storefront capture → resolved to server-side parse (Tasks 2–3); `ad_click_ref` table + `attribution_fact.confidence` → Task 1; matcher (click-ID → UTM → platform-reported, confidence) → Task 4 (precedence UTM→click-ID→referrer; platform-reported handled as the aggregate fallback in Task 7, per the resolved open question); feed `revenue_attrib_cents` → Task 7 + Task 8; security: consent-gated capture → N/A (no storefront code; Shopify governs order-data consent — documented); input sanitize → Task 2 (length cap, malformed-safe); `ad_click_ref` RLS → Task 1; retention purge + GDPR redact → Task 9 (+ `shop_id` cascade covers shop/redact).
- **Type consistency:** `AttributionSignals`, `CampaignRef`, `AttributionResult`, `AttributionMethod`, `Confidence`, `ClickIds`, `Utm` defined in Task 2's `types.ts` are imported unchanged in Tasks 4–7. `parseLandingSite`/`clickIdPlatform` (Task 2) used in Tasks 3–5. `resolveAttribution(signals, campaigns)` (Task 4) used in Task 5. `applyAttribution(shopId, orderId, revenueCents, signals, sb)` (Task 5) called in Task 6. `reconcileAttributedRevenue(shopId, sb)` (Task 7) called in Task 8.
- **Placeholder check:** Tasks 6, 8, 9 reference existing test harnesses the implementer must read first (transform.test, cron.ingest test, sweep.test) rather than reproducing their full fakes here — each names the exact assertion to add and the exact production edit (complete code). This is deliberate (match the file's existing fake), not a placeholder for production code.
- **`customers/redact` nuance:** `ad_click_ref` is keyed to `order_id`, not customer. A `customers/redact` request maps to specific orders; the existing GDPR path handles customer→order redaction, and `ad_click_ref` cascades when an order/shop is deleted. If the existing customer-redact path deletes `order_fact` rows, `ad_click_ref` follows via `ON DELETE CASCADE`. Confirm during Task 9 that no extra customer-scoped delete is needed; if the existing path only nulls fields, add an `ad_click_ref` delete keyed on the affected order ids.
