# Buy-in-Chat P4 — Storefront Promise + Dashboard Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a buyer a "Get it by &lt;date&gt;" delivery-promise on the owned storefront PDP/cart (an estimate from the same shipping engine), and give the merchant a dashboard "Agentic channel" panel (connected AI clients, quotes issued, agentic orders).

**Architecture:** A thin `estimateShipping()` over the `#6.3` engine (shipping + delivery window only — no tax; a promise shows a date and options, not tax). The storefront PDP fetches it from a same-origin storefront-callable endpoint (the storefront is owned, not a Shopify theme, so no App Proxy HMAC is needed — that variant is deferred for Shopify-theme shops). The dashboard panel reads the owned `orders`/`commerce_quote_fact`/`mcp_oauth_clients` tables via the existing dashboard route helpers and renders with the dashboard's own `cd-*`/`CDIcon` primitives (mirror the contract, never port Polaris).

**Tech Stack:** TypeScript (strict, ESM), Remix (resource + UI routes), the `#6.3` shipping engine, dashboard `dashboardJson`/`requireSameOrigin` helpers, `CDIcon` (Lucide), Vitest.

**Depends on:** P1 (`getShopOrigin`, `getRateSource`, engine, `priceLines`), P2 (`orders.channel`, `mcp_oauth_clients.commerce_scope`), P3 (agentic orders exist). **Parent spec:** §8 ("Storefront delivery-promise widget", "Dashboard parity").

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `app/lib/commerce/estimate.server.ts` | `estimateShipping(shopId, lines, coarseDest)` — engine-only coarse promise | Create |
| `app/routes/storefront.api.delivery-promise.tsx` | same-origin endpoint the PDP/cart fetches | Create |
| `app/components/storefront/DeliveryPromise.tsx` | the client widget ("Get it by X — estimate") | Create |
| `app/routes/storefront.products.$handle.tsx` | mount the widget on the PDP | Modify |
| `app/routes/dashboard.api.agentic._index.tsx` | dashboard data: clients · quotes · agentic orders | Create |
| `app/components/dashboard/icons.tsx` | add a `bot` icon for the channel | Modify |
| `app/components/dashboard/DashboardApp.tsx` | register the "Agentic" screen (ScreenId + NAV + SCREENS) | Modify |
| `app/components/dashboard/screens/AgenticChannel.tsx` | the panel UI (cd-* primitives) | Create |

---

## Task 1: `estimateShipping()` — coarse engine-only promise

**Files:**
- Create: `app/lib/commerce/estimate.server.ts`
- Test: `app/lib/commerce/estimate.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/estimate.server.test.ts
import { describe, it, expect, vi } from "vitest";

const ORIGIN = { street1: "1 W St", city: "Denver", state: "CO", zip: "80202", country: "US" };

function mockDeps(engineResult: unknown) {
  vi.doMock("~/lib/order/cart.server", () => ({
    priceLines: async () => ({ lines: [{ variantId: "V1", quantity: 1, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }], subtotalCents: 1000, currency: "usd" }),
  }));
  vi.doMock("./origin.server", () => ({ getShopOrigin: async () => ORIGIN }));
  vi.doMock("./rate-source.server", () => ({ getRateSource: () => ({}) }));
  vi.doMock("~/lib/shipping/engine.server", () => ({ getShippingEngine: () => async () => engineResult }));
}

describe("estimateShipping", () => {
  it("returns cheapest + fastest options and a delivery-by date from a coarse zip", async () => {
    vi.resetModules();
    mockDeps({
      options: [
        { service: "ground", serviceName: "Ground", carrier: "USPS", amountCents: 500, baseAmountCents: 500, appliedRules: [], currency: "usd", deliveryWindow: { earliest: "2026-07-04", latest: "2026-07-07" }, guaranteed: false, pickupAvailable: false },
        { service: "express", serviceName: "Express", carrier: "USPS", amountCents: 1500, baseAmountCents: 1500, appliedRules: [], currency: "usd", deliveryWindow: { earliest: "2026-07-02", latest: "2026-07-02" }, guaranteed: true, pickupAvailable: false },
      ],
      currency: "usd", source: "carrier", fallbackUsed: false, lowConfidence: true, requestHash: "h",
    });
    const { estimateShipping } = await import("./estimate.server");
    const est = await estimateShipping("shop_test", [{ variantId: "V1", quantity: 1 }], { zip: "10001", country: "US" });
    expect(est.cheapest.amountCents).toBe(500);
    expect(est.fastest.deliveryLatest).toBe("2026-07-02");
    expect(est.isEstimate).toBe(true); // coarse destination => always an estimate
  });

  it("marks isEstimate true even when the engine is confident (coarse dest is never exact)", async () => {
    vi.resetModules();
    mockDeps({ options: [{ service: "g", serviceName: "G", carrier: "U", amountCents: 500, baseAmountCents: 500, appliedRules: [], currency: "usd", deliveryWindow: null, guaranteed: false, pickupAvailable: false }], currency: "usd", source: "carrier", fallbackUsed: false, lowConfidence: false, requestHash: "h" });
    const { estimateShipping } = await import("./estimate.server");
    const est = await estimateShipping("shop_test", [{ variantId: "V1", quantity: 1 }], { zip: "10001", country: "US" });
    expect(est.isEstimate).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/estimate.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/estimate.server.ts
// Storefront delivery-promise: a COARSE shipping estimate (no exact street address, no tax).
// Shows the buyer "delivered by <date>" + cheapest/fastest BEFORE checkout. Always flagged
// isEstimate=true — the coarse destination means the exact checkout rate can differ, so the
// widget must label it an estimate (avoids a bait-and-switch perception, rule 12).
import type { ShippingQuoteRequest } from "~/lib/shipping/quote";
import { getShippingEngine } from "~/lib/shipping/engine.server";
import { priceLines } from "~/lib/order/cart.server";
import type { QuoteLine } from "./types";
import { getShopOrigin } from "./origin.server";
import { getRateSource } from "./rate-source.server";

export interface CoarseDestination { zip: string; country: string; state?: string }

export interface EstimateOption { serviceName: string; carrier: string; amountCents: number; deliveryEarliest: string | null; deliveryLatest: string | null }
export interface ShippingEstimate { cheapest: EstimateOption; fastest: EstimateOption; currency: string; isEstimate: true }

function toOption(o: { serviceName: string; carrier: string; amountCents: number; deliveryWindow: { earliest: string; latest: string } | null }): EstimateOption {
  return { serviceName: o.serviceName, carrier: o.carrier, amountCents: o.amountCents, deliveryEarliest: o.deliveryWindow?.earliest ?? null, deliveryLatest: o.deliveryWindow?.latest ?? null };
}

export async function estimateShipping(shopId: string, lines: QuoteLine[], dest: CoarseDestination): Promise<ShippingEstimate> {
  if (!shopId) throw new Error("shopId is required");
  if (!lines.length) throw new Error("at least one line is required to estimate");
  const priced = await priceLines(shopId, lines);
  const origin = await getShopOrigin(shopId);

  // Coarse destination: zip + country (+ state if known). Street/city blank — EasyPost rates
  // primarily on zip+country; the engine flags lowConfidence which we surface as isEstimate.
  const req: ShippingQuoteRequest = {
    cart: priced.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })),
    cartSubtotalCents: priced.subtotalCents,
    origin,
    destination: { street1: "", city: "", state: dest.state ?? "", zip: dest.zip, country: dest.country },
    currency: priced.currency,
    options: { selection: "all" },
  };
  const quote = await getShippingEngine()(req, getRateSource(shopId));
  if (!quote.options.length) throw new Error("no shipping options for the coarse destination");

  const byPrice = [...quote.options].sort((a, b) => a.amountCents - b.amountCents);
  const dateKey = (o: { deliveryWindow: { latest: string } | null }) => o.deliveryWindow ? Date.parse(o.deliveryWindow.latest) : Number.POSITIVE_INFINITY;
  const bySpeed = [...quote.options].sort((a, b) => dateKey(a) - dateKey(b));

  return { cheapest: toOption(byPrice[0]), fastest: toOption(bySpeed[0]), currency: quote.currency, isEstimate: true };
}
```

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run app/lib/commerce/estimate.server.test.ts` → PASS.

```bash
git add app/lib/commerce/estimate.server.ts app/lib/commerce/estimate.server.test.ts
git commit -m "commerce: coarse storefront shipping estimate (buy-in-chat P4)"
```

---

## Task 2: Storefront-callable delivery-promise endpoint

**Files:**
- Create: `app/routes/storefront.api.delivery-promise.tsx`
- Test: `app/routes/__tests__/delivery-promise.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/routes/__tests__/delivery-promise.test.ts
import { describe, it, expect, vi } from "vitest";

describe("delivery-promise loader", () => {
  it("returns an estimate for a variant + zip", async () => {
    vi.resetModules();
    vi.doMock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: async () => "shop_test" }));
    vi.doMock("~/lib/commerce/estimate.server", () => ({ estimateShipping: async () => ({ cheapest: { serviceName: "Ground", carrier: "USPS", amountCents: 500, deliveryEarliest: "2026-07-04", deliveryLatest: "2026-07-07" }, fastest: { serviceName: "Express", carrier: "USPS", amountCents: 1500, deliveryEarliest: "2026-07-02", deliveryLatest: "2026-07-02" }, currency: "usd", isEstimate: true }) }));
    const { loader } = await import("../storefront.api.delivery-promise");
    const req = new Request("https://shop/storefront/api/delivery-promise?variantId=V1&qty=1&zip=10001&country=US");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    const data = await res.json();
    expect(data.isEstimate).toBe(true);
    expect(data.cheapest.amountCents).toBe(500);
  });

  it("400s when zip is missing", async () => {
    vi.resetModules();
    vi.doMock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: async () => "shop_test" }));
    const { loader } = await import("../storefront.api.delivery-promise");
    const req = new Request("https://shop/storefront/api/delivery-promise?variantId=V1&qty=1");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/delivery-promise.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/routes/storefront.api.delivery-promise.tsx
// Same-origin endpoint the owned storefront PDP/cart fetches for a delivery promise. The
// storefront is owned (not a Shopify theme), so a same-origin GET suffices — no App Proxy HMAC.
// (For Shopify-theme shops a proxy-signed variant would be added; deferred.) Returns an ESTIMATE.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { resolveStorefrontShop } from "~/lib/storefront/shop.server";
import { estimateShipping } from "~/lib/commerce/estimate.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const variantId = url.searchParams.get("variantId");
  const zip = url.searchParams.get("zip");
  const country = url.searchParams.get("country") ?? "US";
  const qty = Math.max(1, Number(url.searchParams.get("qty") ?? "1") || 1);
  if (!variantId) return json({ error: "variantId is required" }, { status: 400 });
  if (!zip) return json({ error: "zip is required" }, { status: 400 });

  const shopId = await resolveStorefrontShop(request);
  try {
    const est = await estimateShipping(shopId, [{ variantId, quantity: qty }], { zip, country });
    return json(est, { headers: { "Cache-Control": "private, max-age=120" } });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // ORIGIN_NOT_CONFIGURED or no-options: the PDP simply hides the promise (caller treats a
    // non-200 as "no estimate available") rather than showing a wrong date.
    return json({ error: e.code ?? "ESTIMATE_UNAVAILABLE", message: e.message }, { status: 422 });
  }
}
```

> Confirm `resolveStorefrontShop(request)` exists with this signature (it is imported by `storefront.products.$handle.tsx`).

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run app/routes/__tests__/delivery-promise.test.ts` → PASS.

```bash
git add app/routes/storefront.api.delivery-promise.tsx app/routes/__tests__/delivery-promise.test.ts
git commit -m "storefront: delivery-promise estimate endpoint (buy-in-chat P4)"
```

---

## Task 3: PDP delivery-promise widget

**Files:**
- Create: `app/components/storefront/DeliveryPromise.tsx`
- Modify: `app/routes/storefront.products.$handle.tsx`

- [ ] **Step 1: Implement the widget**

```tsx
// app/components/storefront/DeliveryPromise.tsx
// Buyer-facing PDP widget: enter a zip -> "Get it by <date> (estimate)". Product-neutral copy,
// no provenance markers. Hides itself when no estimate is available (never shows a wrong date).
import { useState } from "react";

interface Estimate {
  cheapest: { amountCents: number; deliveryLatest: string | null; serviceName: string };
  fastest: { amountCents: number; deliveryLatest: string | null; serviceName: string };
  currency: string;
  isEstimate: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "soon";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}

export function DeliveryPromise({ variantId }: { variantId: string }) {
  const [zip, setZip] = useState("");
  const [est, setEst] = useState<Estimate | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "none">("idle");

  async function check() {
    if (!/^\d{5}$/.test(zip)) return;
    setState("loading");
    const res = await fetch(`/storefront/api/delivery-promise?variantId=${encodeURIComponent(variantId)}&qty=1&zip=${zip}&country=US`);
    if (!res.ok) { setEst(null); setState("none"); return; }
    setEst(await res.json());
    setState("idle");
  }

  return (
    <div className="cd-pdp__promise">
      <label className="cd-pdp__promise-label">
        Estimate delivery
        <input className="cd-pdp__promise-zip" inputMode="numeric" maxLength={5} placeholder="ZIP" value={zip}
          onChange={(e) => setZip(e.target.value.replace(/\D/g, ""))} onBlur={check} aria-label="ZIP code for delivery estimate" />
      </label>
      {state === "loading" && <p className="cd-pdp__promise-line">Checking…</p>}
      {state === "none" && <p className="cd-pdp__promise-line">No estimate for that ZIP.</p>}
      {est && (
        <p className="cd-pdp__promise-line">
          Get it by <strong>{fmtDate(est.cheapest.deliveryLatest)}</strong> for {fmtMoney(est.cheapest.amountCents, est.currency)}
          {est.fastest.deliveryLatest !== est.cheapest.deliveryLatest && (
            <> · as fast as <strong>{fmtDate(est.fastest.deliveryLatest)}</strong> ({fmtMoney(est.fastest.amountCents, est.currency)})</>
          )}
          <span className="cd-pdp__promise-estimate"> — estimate</span>
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Mount it on the PDP**

In `app/routes/storefront.products.$handle.tsx`, import the widget and render it inside `.cd-pdp__info` near the add-to-cart `Form`. Wire `variantId` to the currently selected variant (the `<select name="variantId">`). Minimal version: render `<DeliveryPromise variantId={defaultVariantId} />` using the first/selected variant id from the loader data.

```tsx
import { DeliveryPromise } from "~/components/storefront/DeliveryPromise";
// ...inside the .cd-pdp__info block, after the price / before or after the add form:
<DeliveryPromise variantId={selectedVariantId} />
```

> Use the same variant id the add-to-cart `<select>` defaults to. If the PDP already tracks the selected variant in state, pass that; otherwise pass the first variant's id from the loader.

- [ ] **Step 3: Build + commit**

Run: `npm run build` → exit 0 (verifies the client bundle has no forbidden markers).

```bash
git add app/components/storefront/DeliveryPromise.tsx app/routes/storefront.products.\$handle.tsx
git commit -m "storefront: PDP delivery-promise widget (buy-in-chat P4)"
```

---

## Task 4: Dashboard "Agentic channel" data route

**Files:**
- Create: `app/routes/dashboard.api.agentic._index.tsx`
- Test: `app/routes/__tests__/dashboard-agentic.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/routes/__tests__/dashboard-agentic.test.ts
import { describe, it, expect, vi } from "vitest";

describe("dashboard agentic channel loader", () => {
  it("returns connected clients, quote count, and agentic orders for the shop", async () => {
    vi.resetModules();
    vi.doMock("~/lib/dashboard/http.server", () => ({
      requireSameOrigin: () => {},
      dashboardJson: async (fn: () => Promise<unknown>) => new Response(JSON.stringify(await fn()), { headers: { "content-type": "application/json" } }),
    }));
    vi.doMock("~/lib/dashboard/shop.server", () => ({ resolveDashboardShop: async () => "shop_test" }));
    // getSupabase chain: clients, quotes(count), orders
    const tables: Record<string, unknown> = {
      mcp_oauth_clients: [{ name: "ChatGPT", commerce_scope: true, spend_cap_cents: 50000 }],
      commerce_quote_fact: { count: 12 },
      orders: [{ id: "o1", total_cents: 2660, currency: "usd", protocol: "mcp", state: "paid", created_at: "2026-06-29" }],
    };
    vi.doMock("~/lib/supabase.server", () => ({
      getSupabase: () => ({
        from: (t: string) => ({
          select: (_c?: string, opts?: { count?: string }) => ({
            eq: () => (t === "commerce_quote_fact" && opts?.count ? Promise.resolve({ count: (tables.commerce_quote_fact as { count: number }).count, error: null }) : Promise.resolve({ data: tables[t], error: null })),
          }),
        }),
      }),
    }));
    const { loader } = await import("../dashboard.api.agentic._index");
    const res = await loader({ request: new Request("https://app/dashboard/api/agentic"), params: {}, context: {} } as never);
    const data = await res.json();
    expect(data.clients[0].name).toBe("ChatGPT");
    expect(data.quotesIssued).toBe(12);
    expect(data.orders[0].protocol).toBe("mcp");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/dashboard-agentic.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/routes/dashboard.api.agentic._index.tsx
// Dashboard parity for the agentic channel: connected AI clients, quotes issued, and agentic
// orders. Reads the OWNED commerce tables via getSupabase (service-role, shop-scoped). Uses the
// dashboard's own envelope (dashboardJson + requireSameOrigin) — the panel UI renders with cd-*
// primitives, never Polaris (CLAUDE.md dashboard parity).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { requireSameOrigin, dashboardJson } from "~/lib/dashboard/http.server";
import { resolveDashboardShop } from "~/lib/dashboard/shop.server";
import { getSupabase } from "~/lib/supabase.server";

export async function loader({ request }: LoaderFunctionArgs) {
  requireSameOrigin(request);
  return dashboardJson(async () => {
    const shopId = await resolveDashboardShop(request);
    const sb = getSupabase();

    const clientsRes = await sb.from("mcp_oauth_clients").select("name, commerce_scope, spend_cap_cents").eq("commerce_scope", true);
    if (clientsRes.error) throw clientsRes.error;

    const quotesRes = await sb.from("commerce_quote_fact").select("quote_id", { count: "exact", head: true }).eq("shop_id", shopId);
    if (quotesRes.error) throw quotesRes.error;

    const ordersRes = await sb.from("orders").select("id, total_cents, currency, protocol, state, created_at").eq("shop_id", shopId).eq("channel", "agentic");
    if (ordersRes.error) throw ordersRes.error;

    const orders = (ordersRes.data ?? []) as Array<Record<string, unknown>>;
    return {
      clients: (clientsRes.data ?? []).map((c: Record<string, unknown>) => ({ name: String(c.name), spendCapCents: Number(c.spend_cap_cents ?? 0) })),
      quotesIssued: quotesRes.count ?? 0,
      orders: orders.map((o) => ({ id: String(o.id), totalCents: Number(o.total_cents), currency: String(o.currency), protocol: o.protocol ? String(o.protocol) : null, state: String(o.state), createdAt: String(o.created_at) })),
      ordersCount: orders.length,
      revenueCents: orders.filter((o) => o.state === "paid").reduce((s, o) => s + Number(o.total_cents), 0),
    };
  });
}
```

> Confirm `resolveDashboardShop` (or the equivalent shop-from-session helper the other `dashboard.api.*` routes use — grep a sibling like `dashboard.api.audit._index.tsx`) and the `getSupabase` count syntax against an existing count query in the repo. Match the sibling exactly.

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run app/routes/__tests__/dashboard-agentic.test.ts` → PASS.

```bash
git add app/routes/dashboard.api.agentic._index.tsx app/routes/__tests__/dashboard-agentic.test.ts
git commit -m "dashboard: agentic-channel data route (buy-in-chat P4)"
```

---

## Task 5: Dashboard "Agentic" screen (UI registration)

**Files:**
- Modify: `app/components/dashboard/icons.tsx`
- Create: `app/components/dashboard/screens/AgenticChannel.tsx`
- Modify: `app/components/dashboard/DashboardApp.tsx`

- [ ] **Step 1: Add the `bot` icon**

In `app/components/dashboard/icons.tsx`: import `Bot` from `lucide-react` (add to the existing import block) and add one line to the `CD_ICONS` registry: `bot: Bot,`. Do not hand-draw SVG; follow the existing one-line registry convention (CLAUDE.md icon rule).

- [ ] **Step 2: Implement the panel UI**

```tsx
// app/components/dashboard/screens/AgenticChannel.tsx
// "Agentic channel" panel: connected AI clients, quotes issued, agentic orders. Mirrors the
// feature's data contract using the dashboard's own cd-* primitives (no Polaris). Fetches the
// same-origin data route. Money in cents -> formatted for display.
import { useEffect, useState } from "react";
import { CDIcon } from "../icons";

interface AgenticData {
  clients: { name: string; spendCapCents: number }[];
  quotesIssued: number;
  orders: { id: string; totalCents: number; currency: string; protocol: string | null; state: string; createdAt: string }[];
  ordersCount: number;
  revenueCents: number;
}
const money = (c: number, cur = "usd") => new Intl.NumberFormat(undefined, { style: "currency", currency: cur.toUpperCase() }).format(c / 100);

export function AgenticChannel() {
  const [data, setData] = useState<AgenticData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch("/dashboard/api/agentic", { headers: { "x-requested-with": "dashboard" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  if (error) return <div className="cd-screen"><p className="cd-error">Couldn’t load the agentic channel: {error}</p></div>;
  if (!data) return <div className="cd-screen"><p className="cd-muted">Loading…</p></div>;

  return (
    <div className="cd-screen cd-agentic">
      <header className="cd-screen__head">
        <CDIcon name="bot" size={22} strokeWidth={1.8} />
        <h1 className="cd-screen__title">Agentic channel</h1>
      </header>

      <div className="cd-stat-row">
        <div className="cd-stat"><span className="cd-stat__label">Quotes issued</span><span className="cd-stat__value">{data.quotesIssued}</span></div>
        <div className="cd-stat"><span className="cd-stat__label">Orders</span><span className="cd-stat__value">{data.ordersCount}</span></div>
        <div className="cd-stat"><span className="cd-stat__label">Revenue</span><span className="cd-stat__value">{money(data.revenueCents)}</span></div>
      </div>

      <section className="cd-card">
        <h2 className="cd-card__title">Connected AI clients</h2>
        {data.clients.length === 0 ? <p className="cd-muted">No AI clients are authorized to transact yet.</p> : (
          <ul className="cd-list">{data.clients.map((c, i) => (
            <li key={i} className="cd-list__row"><span>{c.name}</span><span className="cd-muted">cap {money(c.spendCapCents)}</span></li>
          ))}</ul>
        )}
      </section>

      <section className="cd-card">
        <h2 className="cd-card__title">Recent agentic orders</h2>
        {data.orders.length === 0 ? <p className="cd-muted">No agentic orders yet.</p> : (
          <ul className="cd-list">{data.orders.map((o) => (
            <li key={o.id} className="cd-list__row">
              <span>#{o.id.slice(0, 8).toUpperCase()}</span>
              <span className="cd-muted">{o.protocol ?? "—"}</span>
              <span className={`cd-badge cd-badge--${o.state}`}>{o.state}</span>
              <span>{money(o.totalCents, o.currency)}</span>
            </li>
          ))}</ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 3: Register the screen**

In `app/components/dashboard/DashboardApp.tsx`:
1. Add `"agentic"` to the `ScreenId` union type.
2. Add to `NAV_ITEMS`: `{ id: "agentic", label: "Agentic", icon: "bot" }`.
3. Import `AgenticChannel` and add to `SCREENS`: `agentic: () => <AgenticChannel />,`.

```tsx
import { AgenticChannel } from "./screens/AgenticChannel";
// ScreenId: ... | "agentic"
// NAV_ITEMS: { id: "agentic", label: "Agentic", icon: "bot" },
// SCREENS: agentic: () => <AgenticChannel />,
```

> The `SCREENS` map values take `(props: { app: DashboardCtx }) => JSX.Element`; `AgenticChannel` ignores props, so `() => <AgenticChannel />` matches. Confirm `ScreenId` is the type used by `nav.screen`.

- [ ] **Step 4: Build + commit**

Run: `npm run build` → exit 0.

```bash
git add app/components/dashboard/icons.tsx app/components/dashboard/screens/AgenticChannel.tsx app/components/dashboard/DashboardApp.tsx
git commit -m "dashboard: Agentic channel screen + nav + icon (buy-in-chat P4)"
```

---

## Task 6: Gate + parity confirmation

- [ ] **Step 1: Full gate**

Run, expecting exit 0 each: `npx tsc --noEmit`; `npm run lint`; `npx vitest run`; `npm run build` (the client-bundle verifier must pass — the storefront widget + dashboard screen are browser code; confirm no provenance/AI markers, no source maps).

- [ ] **Step 2: Smoke the storefront widget (verification-before-completion)**

Start the app, open a PDP, enter a ZIP, confirm "Get it by &lt;date&gt; — estimate" renders and a bad ZIP shows "No estimate". Confirm no console errors. (Use the `run`/`verification-loop` skill.)

- [ ] **Step 3: Smoke the dashboard panel**

Open the dashboard, click "Agentic", confirm the panel loads (clients/quotes/orders) and a same-origin guard rejects a cross-origin fetch.

- [ ] **Step 4: Add CSS for the new classes**

Add styles for `cd-pdp__promise*`, `cd-agentic`, `cd-stat*`, `cd-card`, `cd-list*`, `cd-badge--*` in the storefront + dashboard stylesheets, matching the existing visual language. (Grep an existing `cd-pdp__` / `cd-card` rule to find the stylesheet and match its tokens.)

- [ ] **Step 5: Run `/code-review`**; resolve blockers.

---

## Self-review notes (author)

- **Spec coverage (§8):** delivery-promise widget (estimate-labeled, coarse dest) → Tasks 1–3; dashboard "Agentic channel" parity (clients · quotes · orders, cd-*/CDIcon, no Polaris) → Tasks 4–5.
- **Right-sized the quote:** the promise needs shipping + date only, so `estimateShipping` skips Stripe Tax (cheaper, and tax isn't shown pre-checkout) — distinct from P1's full `quoteCart`.
- **Owned-storefront decision:** same-origin endpoint, not App Proxy HMAC (the storefront is owned, not a Shopify theme); the proxy-signed variant for Shopify-theme shops is explicitly deferred, not silently dropped.
- **Known confirmations flagged:** `resolveStorefrontShop` / `resolveDashboardShop` signatures + the `getSupabase` count syntax must match existing siblings (Tasks 2, 4 say so). CSS for new classes is a real task (Task 6 Step 4), not assumed.
- **Type consistency:** `estimateShipping` → `ShippingEstimate` consumed by the endpoint + widget; dashboard route shape matches the panel’s `AgenticData`.
```
