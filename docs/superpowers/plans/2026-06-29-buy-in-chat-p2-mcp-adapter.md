# Buy-in-Chat P2 — MCP Commerce Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an external Claude MCP client browse the catalog, lock an accurate quote, and place a real order that the buyer pays via a Stripe-hosted Checkout link — reusing the owned order core, gated by a `commerce` OAuth scope and a deterministic per-client spend cap.

**Architecture:** Adds the protocol-neutral order placement (`placeAgenticOrder`) to `app/lib/commerce/`, a deterministic spend-cap guardrail, and a Stripe Checkout Session builder. Exposes four commerce tools (`get_catalog`, `create_quote`, `get_quote`, `place_order`) on the existing `ASSISTANT_TOOLS` catalog + `makeToolDispatcher`, enforced by a `commerce` scope so the read/propose assistant cannot transact. The order placed is a normal owned `orders` row tagged `channel='agentic'`; payment completes through the existing Stripe webhook → `paid` → `emitPaidOrder` tail (no new paid path).

**Tech Stack:** TypeScript (strict, ESM), Supabase via `getSupabase()`, Stripe SDK v22 (`checkout.sessions`), Anthropic tool schema (`@anthropic-ai/sdk`), Vitest.

**Depends on:** P1 (`quoteCart`, `getQuote`/`lockQuote`, `getAgenticCatalog`). **Parent spec:** §7.2, §8.

**Cross-repo note (read first):** the external MCP server is a **separate deploy** (`calderyn-mcp.vercel.app/mcp`, not this repo). This plan delivers the tools, dispatcher cases, scope enforcement, and order core **in this repo**. Wiring the scope-filtered tool list into the `calderyn-mcp` deploy is a sibling task tracked alongside dashboard parity — flagged in Task 7, not built here.

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `supabase/migrations/<ts>_agentic_order_channel.sql` | `channel`/`protocol`/`client_id` on `orders`; `commerce_scope`/`spend_cap_cents` on `mcp_oauth_clients` | Create |
| `app/lib/commerce/order.server.ts` | `placeAgenticOrder()` — owned order from a locked quote, tagged channel | Create |
| `app/lib/commerce/guardrail.server.ts` | `assertWithinCommerceCap()` — deterministic per-client spend cap | Create |
| `app/lib/commerce/stripe-checkout.server.ts` | `createCommerceCheckoutSession()` — Stripe-hosted pay link for an order | Create |
| `app/lib/assistant/tools.server.ts` | add 4 commerce tools + dispatcher cases + `commerce` scope gate | Modify |
| `app/lib/assistant/commerce-tools.server.ts` | the commerce tool schemas + handlers (keep `tools.server.ts` focused) | Create |

---

## Task 1: Migration — order channel + client spend cap

**Files:**
- Create: `supabase/migrations/<timestamp>_agentic_order_channel.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Tag owned orders with their origination channel so the dashboard "Agentic channel" panel
-- and attribution can distinguish a chat sale from a storefront sale.
alter table orders add column if not exists channel  text not null default 'storefront';
alter table orders add column if not exists protocol text;            -- 'acp' | 'mcp' | null
alter table orders add column if not exists client_id text;           -- external AI client id
create index if not exists idx_orders_channel on orders (shop_id, channel, created_at desc);

-- Per-client commerce authorization + deterministic spend cap (rule 5: spend is never a model
-- decision). mcp_oauth_clients already registers external AI clients.
alter table mcp_oauth_clients add column if not exists commerce_scope   boolean not null default false;
alter table mcp_oauth_clients add column if not exists spend_cap_cents  integer not null default 0; -- 0 = no commerce
```

> Confirm the real table names (`orders`, `mcp_oauth_clients`) and that `mcp_oauth_clients` is the client-registry table (grep `mcp_oauth_clients` in `app/lib/mcp_oauth.server.ts`). Adjust if the registry table differs.

- [ ] **Step 2: Apply + validate**

Run: `npx supabase migration up`
Expected: applies; `select channel, protocol, client_id from orders limit 1;` and `select commerce_scope, spend_cap_cents from mcp_oauth_clients limit 1;` resolve.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/
git commit -m "commerce: order channel + per-client spend cap schema (buy-in-chat P2)"
```

---

## Task 2: `placeAgenticOrder()` — owned order from a locked quote

**Files:**
- Create: `app/lib/commerce/order.server.ts`
- Test: `app/lib/commerce/order.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/order.server.test.ts
import { describe, it, expect, vi } from "vitest";

const LOCKED = {
  quoteId: "q1", lines: [{ variantId: "V1", quantity: 2, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }],
  subtotalCents: 2000, shippingCents: 500, taxCents: 160, totalCents: 2660, currency: "usd",
  deliveryEarliest: null, deliveryLatest: null, lowConfidence: false, fallbackUsed: false, expiresAt: "2999-01-01T00:00:00Z",
};

function mock(insertedOrder: Record<string, unknown>[]) {
  vi.doMock("./quote-store.server", () => ({ getQuote: async () => LOCKED }));
  vi.doMock("~/lib/buyer/identity.server", () => ({
    upsertGuestBuyer: async () => ({ id: "buyer1" }), addBuyerAddress: async () => {}, recordCheckoutConsent: async () => {},
  }));
  vi.doMock("~/lib/supabase.server", () => ({
    getSupabase: () => ({
      from: (t: string) => ({
        insert: (row: Record<string, unknown>) => {
          if (t === "orders") { insertedOrder.push(row); return { select: () => ({ single: async () => ({ data: { id: "order1" }, error: null }) }) }; }
          return { error: null };
        },
      }),
    }),
  }));
}

describe("placeAgenticOrder", () => {
  it("creates a checkout_pending order tagged channel=agentic with the locked totals", async () => {
    vi.resetModules();
    const inserted: Record<string, unknown>[] = [];
    mock(inserted);
    const { placeAgenticOrder } = await import("./order.server");
    const res = await placeAgenticOrder("shop_test", "q1", { email: "b@x.com" }, { protocol: "mcp", clientId: "c1" });
    expect(res.orderId).toBe("order1");
    expect(inserted[0]).toMatchObject({ channel: "agentic", protocol: "mcp", client_id: "c1", total_cents: 2660, shipping_cents: 500, tax_cents: 160 });
  });

  it("rejects an expired/unknown quote (getQuote null) before any write", async () => {
    vi.resetModules();
    vi.doMock("./quote-store.server", () => ({ getQuote: async () => null }));
    const { placeAgenticOrder, QuoteExpiredError } = await import("./order.server");
    await expect(placeAgenticOrder("shop_test", "stale", { email: "b@x.com" }, { protocol: "mcp", clientId: "c1" }))
      .rejects.toBeInstanceOf(QuoteExpiredError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/order.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/order.server.ts
// placeAgenticOrder — turn a LOCKED quote into an owned `orders` row (checkout_pending) tagged
// with its agentic channel. Mirrors createCheckout's writes (buyer upsert + order + lines) but
// prices from the locked quote, never re-quoting (the "no second chance" guarantee). Payment is
// attached by the surface adapter (Stripe Checkout link for MCP; SPT charge for ACP) — this
// function never charges, so a crash leaves a checkout_pending order with no payment (safe).
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";
import { upsertGuestBuyer, addBuyerAddress, recordCheckoutConsent, type BuyerAddressInput } from "~/lib/buyer/identity.server";
import { getQuote } from "./quote-store.server";

export class QuoteExpiredError extends Error {
  code = "QUOTE_EXPIRED";
  constructor(quoteId: string) { super(`quote ${quoteId} is expired or unknown; re-quote required`); }
}

export interface AgenticBuyer {
  email: string;
  phone?: string | null;
  address?: BuyerAddressInput;
  consent?: { version: string; marketingOptIn: boolean; sourceIp?: string | null; ua?: string | null };
}

export interface PlaceResult { orderId: string; confirmationToken: string; totalCents: number; currency: string; }

export async function placeAgenticOrder(
  shopId: string,
  quoteId: string,
  buyer: AgenticBuyer,
  channel: { protocol: "acp" | "mcp"; clientId: string },
): Promise<PlaceResult> {
  if (!shopId) throw new Error("shopId is required");
  if (!buyer?.email) throw new Error("buyer.email is required");

  const quote = await getQuote(shopId, quoteId);
  if (!quote) throw new QuoteExpiredError(quoteId); // expired/unknown -> fail before any write

  const buyerRow = await upsertGuestBuyer(shopId, { email: buyer.email, phone: buyer.phone });
  if (buyer.address) await addBuyerAddress(shopId, buyerRow.id, buyer.address);
  if (buyer.consent) await recordCheckoutConsent(shopId, buyerRow.id, buyer.consent);

  const confirmationToken = randomBytes(32).toString("base64url");
  const sb = getSupabase();
  const orderIns = await sb.from("orders").insert({
    shop_id: shopId,
    buyer_id: buyerRow.id,
    channel: "agentic",
    protocol: channel.protocol,
    client_id: channel.clientId,
    subtotal_cents: quote.subtotalCents,
    shipping_cents: quote.shippingCents,
    tax_cents: quote.taxCents,
    total_cents: quote.totalCents,
    currency: quote.currency,
    attribution: { channel: "agentic", protocol: channel.protocol, client_id: channel.clientId },
    confirmation_token: confirmationToken,
  }).select("id").single();
  if (orderIns.error) throw orderIns.error;
  const orderId = String((orderIns.data as Record<string, unknown>).id);

  const lineRows = quote.lines.map((l) => ({
    shop_id: shopId, order_id: orderId, variant_id: l.variantId, quantity: l.quantity,
    unit_price_cents: l.unitPriceCents, title_snapshot: l.titleSnapshot,
  }));
  const lineIns = await sb.from("order_line").insert(lineRows);
  if (lineIns.error) throw lineIns.error;

  return { orderId, confirmationToken, totalCents: quote.totalCents, currency: quote.currency };
}
```

> Confirm `upsertGuestBuyer`/`addBuyerAddress`/`recordCheckoutConsent` signatures + `BuyerAddressInput` against `app/lib/buyer/identity.server.ts` and that `orders`/`order_line` column names match `checkout.server.ts`. They are the same writes `createCheckout` does.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/order.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/order.server.ts app/lib/commerce/order.server.test.ts
git commit -m "commerce: placeAgenticOrder from locked quote (buy-in-chat P2)"
```

---

## Task 3: `assertWithinCommerceCap()` — deterministic spend guard

**Files:**
- Create: `app/lib/commerce/guardrail.server.ts`
- Test: `app/lib/commerce/guardrail.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/guardrail.server.test.ts
import { describe, it, expect, vi } from "vitest";

function mockClient(row: Record<string, unknown> | null) {
  vi.doMock("~/lib/supabase.server", () => ({
    getSupabase: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }) }) }),
  }));
}

describe("assertWithinCommerceCap", () => {
  it("throws SPEND_CAP_EXCEEDED when amount exceeds the client's cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap, SpendCapError } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 6000)).rejects.toBeInstanceOf(SpendCapError);
  });

  it("throws COMMERCE_NOT_AUTHORIZED when the client lacks commerce_scope", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: false, spend_cap_cents: 100000 });
    const { assertWithinCommerceCap, CommerceNotAuthorizedError } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 100)).rejects.toBeInstanceOf(CommerceNotAuthorizedError);
  });

  it("passes when authorized and within cap", async () => {
    vi.resetModules();
    mockClient({ commerce_scope: true, spend_cap_cents: 5000 });
    const { assertWithinCommerceCap } = await import("./guardrail.server");
    await expect(assertWithinCommerceCap("c1", 4999)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/guardrail.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/guardrail.server.ts
// Deterministic per-client commerce guard (rule 5: spend authority is code, not model
// judgement). Checked BEFORE any charge. A client must carry commerce_scope and the order
// total must be <= its spend_cap_cents, else the transaction is refused, visibly.
import { getSupabase } from "~/lib/supabase.server";

export class CommerceNotAuthorizedError extends Error {
  code = "COMMERCE_NOT_AUTHORIZED";
  constructor(clientId: string) { super(`client ${clientId} is not authorized for commerce`); }
}
export class SpendCapError extends Error {
  code = "SPEND_CAP_EXCEEDED";
  constructor(clientId: string, amount: number, cap: number) {
    super(`client ${clientId} order ${amount}c exceeds spend cap ${cap}c`);
  }
}

export async function assertWithinCommerceCap(clientId: string, amountCents: number): Promise<void> {
  if (!clientId) throw new CommerceNotAuthorizedError("(none)");
  const res = await getSupabase()
    .from("mcp_oauth_clients")
    .select("commerce_scope, spend_cap_cents")
    .eq("client_id", clientId)
    .maybeSingle();
  if (res.error) throw res.error;
  const row = res.data as { commerce_scope?: boolean; spend_cap_cents?: number } | null;
  if (!row?.commerce_scope) throw new CommerceNotAuthorizedError(clientId);
  const cap = Number(row.spend_cap_cents ?? 0);
  if (amountCents > cap) throw new SpendCapError(clientId, amountCents, cap);
}
```

> Confirm the registry table key column (`client_id` vs `id`) against `mcp_oauth.server.ts`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/guardrail.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/guardrail.server.ts app/lib/commerce/guardrail.server.test.ts
git commit -m "commerce: deterministic per-client spend-cap guard (buy-in-chat P2)"
```

---

## Task 4: `createCommerceCheckoutSession()` — Stripe-hosted pay link

**Files:**
- Create: `app/lib/commerce/stripe-checkout.server.ts`
- Test: `app/lib/commerce/stripe-checkout.server.test.ts`

- [ ] **Step 1: Write a failing test**

```typescript
// app/lib/commerce/stripe-checkout.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("createCommerceCheckoutSession", () => {
  it("creates a Stripe Checkout Session for the order total and returns its URL", async () => {
    vi.resetModules();
    const created: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ checkout: { sessions: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "cs_1", url: "https://stripe/cs_1" }; } } } }),
    }));
    const { createCommerceCheckoutSession } = await import("./stripe-checkout.server");
    const res = await createCommerceCheckoutSession("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", confirmationToken: "tok" });
    expect(res.url).toBe("https://stripe/cs_1");
    expect((created[0] as { mode: string }).mode).toBe("payment");
    expect((created[0] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/stripe-checkout.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/stripe-checkout.server.ts
// The Claude/MCP payment path: a Stripe-hosted Checkout Session for an already-created owned
// order. The single line item is the order TOTAL (the locked quote already itemized
// subtotal/shipping/tax — Stripe Checkout only needs the amount to charge). On payment the
// existing webhooks.stripe.tsx -> processStripeEvent flips the order to `paid` keyed by
// metadata.order_ref, identical to the storefront Payment Element path.
import { getStripe } from "~/lib/payments/stripe.server";

export interface CommerceSessionInput {
  orderId: string;
  totalCents: number;
  currency: string;
  confirmationToken: string;
}

export async function createCommerceCheckoutSession(
  shopId: string,
  input: CommerceSessionInput,
): Promise<{ sessionId: string; url: string }> {
  if (!shopId) throw new Error("shopId is required");
  const base = process.env.STOREFRONT_BASE_URL ?? "";
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{
      quantity: 1,
      price_data: {
        currency: input.currency,
        unit_amount: input.totalCents,
        product_data: { name: `Order ${input.orderId.slice(0, 8).toUpperCase()}` },
      },
    }],
    metadata: { shop_id: shopId, order_ref: input.orderId },
    payment_intent_data: { metadata: { shop_id: shopId, order_ref: input.orderId } },
    success_url: `${base}/storefront/checkout/confirmation/${input.confirmationToken}`,
    cancel_url: `${base}/storefront/cart`,
  });
  if (!session.url) throw new Error(`Stripe Checkout Session ${session.id} returned no url`);
  return { sessionId: session.id, url: session.url };
}
```

> Confirm `processStripeEvent` resolves the order from `payment_intent.succeeded` via `metadata.order_ref` (Checkout Session payments carry the PI; `payment_intent_data.metadata` propagates the ref). If it instead keys off the `payment_intent` table row, add an insert mirroring `createPaymentIntent` so the webhook can resolve the order. Verify against `stripe.server.ts:processStripeEvent`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/stripe-checkout.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/stripe-checkout.server.ts app/lib/commerce/stripe-checkout.server.test.ts
git commit -m "commerce: Stripe Checkout pay-link for MCP orders (buy-in-chat P2)"
```

---

## Task 5: Commerce tool schemas + handlers

**Files:**
- Create: `app/lib/assistant/commerce-tools.server.ts`
- Test: `app/lib/assistant/commerce-tools.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/assistant/commerce-tools.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("commerce tool handlers", () => {
  it("place_order checks the spend cap then places the order and returns a pay URL", async () => {
    vi.resetModules();
    const calls: string[] = [];
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { calls.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { calls.push("place"); return { orderId: "order1", confirmationToken: "tok", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/stripe-checkout.server", () => ({ createCommerceCheckoutSession: async () => { calls.push("session"); return { sessionId: "cs_1", url: "https://stripe/cs_1" }; } }));
    const { handleCommerceTool } = await import("./commerce-tools.server");
    const res = await handleCommerceTool("place_order", { quote_id: "q1", email: "b@x.com" }, { shopId: "shop_test", clientId: "c1" });
    expect(calls).toEqual(["cap", "place", "session"]); // cap BEFORE place (rule 5)
    expect(JSON.parse(res.content).pay_url).toBe("https://stripe/cs_1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/assistant/commerce-tools.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement schemas + handlers**

```typescript
// app/lib/assistant/commerce-tools.server.ts
// The agentic-commerce toolset on the existing MCP seam. These tools carry the `commerce`
// scope; makeToolDispatcher refuses them for a client without it (tools.server.ts). Money in
// cents. place_order returns a Stripe-hosted pay URL (the Claude/MCP payment path).
import type Anthropic from "@anthropic-ai/sdk";
import { getAgenticCatalog } from "~/lib/commerce/catalog.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { lockQuote, getQuote } from "~/lib/commerce/quote-store.server";
import { assertWithinCommerceCap } from "~/lib/commerce/guardrail.server";
import { placeAgenticOrder } from "~/lib/commerce/order.server";
import { createCommerceCheckoutSession } from "~/lib/commerce/stripe-checkout.server";
import { sha256hex } from "~/lib/mcp_oauth.server";

export const COMMERCE_TOOL_NAMES = ["get_catalog", "create_quote", "get_quote", "place_order"] as const;

export const COMMERCE_TOOLS: Anthropic.Tool[] = [
  { name: "get_catalog", description: "List buyable products (variant id, title, price in cents, available qty). Use before quoting.", input_schema: { type: "object", properties: {} } },
  { name: "create_quote", description: "Lock an ACCURATE quote (price + real shipping + tax) for line items shipping to a destination. Returns quote_id + totals in cents + expiry. ALWAYS quote before placing an order; never estimate.", input_schema: { type: "object", properties: {
    line_items: { type: "array", items: { type: "object", properties: { variant_id: { type: "string" }, quantity: { type: "number" } }, required: ["variant_id", "quantity"] } },
    destination: { type: "object", properties: { street1: { type: "string" }, street2: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, country: { type: "string" } }, required: ["street1", "city", "state", "zip", "country"] },
  }, required: ["line_items", "destination"] } },
  { name: "get_quote", description: "Re-read a locked quote by id. Returns the SAME totals (never re-prices), or an expired error.", input_schema: { type: "object", properties: { quote_id: { type: "string" } }, required: ["quote_id"] } },
  { name: "place_order", description: "Place a real order for a locked quote and return a payment URL the buyer opens to pay. Requires the buyer's email. The order is unpaid until the buyer completes payment at the URL.", input_schema: { type: "object", properties: { quote_id: { type: "string" }, email: { type: "string" }, phone: { type: "string" } }, required: ["quote_id", "email"] } },
];

export interface CommerceCtx { shopId: string; clientId: string; }
export interface CommerceResult { content: string; isError?: boolean; }
const ok = (o: unknown): CommerceResult => ({ content: JSON.stringify(o) });

export async function handleCommerceTool(name: string, input: Record<string, unknown>, ctx: CommerceCtx): Promise<CommerceResult> {
  switch (name) {
    case "get_catalog":
      return ok({ products: await getAgenticCatalog(ctx.shopId) });
    case "create_quote": {
      const lines = (input.line_items as Array<{ variant_id: string; quantity: number }>).map((l) => ({ variantId: l.variant_id, quantity: l.quantity }));
      const dest = input.destination as { street1: string; street2?: string; city: string; state: string; zip: string; country: string };
      const quote = await quoteCart(ctx.shopId, lines, dest);
      const locked = await lockQuote(ctx.shopId, quote, { clientId: ctx.clientId, destinationHash: sha256hex(JSON.stringify(dest)) });
      return ok({ quote_id: locked.quoteId, expires_at: locked.expiresAt, subtotal_cents: quote.subtotalCents, shipping_cents: quote.shippingCents, tax_cents: quote.taxCents, total_cents: quote.totalCents, currency: quote.currency, delivery_by: quote.deliveryLatest, estimate: quote.fallbackUsed || quote.lowConfidence });
    }
    case "get_quote": {
      const q = await getQuote(ctx.shopId, String(input.quote_id));
      if (!q) return { content: JSON.stringify({ code: "QUOTE_EXPIRED", message: "quote expired; create a new quote" }), isError: true };
      return ok({ quote_id: q.quoteId, total_cents: q.totalCents, currency: q.currency, expires_at: q.expiresAt });
    }
    case "place_order": {
      const q = await getQuote(ctx.shopId, String(input.quote_id));
      if (!q) return { content: JSON.stringify({ code: "QUOTE_EXPIRED", message: "quote expired; create a new quote" }), isError: true };
      await assertWithinCommerceCap(ctx.clientId, q.totalCents); // rule 5: BEFORE placing
      const placed = await placeAgenticOrder(ctx.shopId, q.quoteId, { email: String(input.email), phone: input.phone ? String(input.phone) : null }, { protocol: "mcp", clientId: ctx.clientId });
      const session = await createCommerceCheckoutSession(ctx.shopId, { orderId: placed.orderId, totalCents: placed.totalCents, currency: placed.currency, confirmationToken: placed.confirmationToken });
      return ok({ order_id: placed.orderId, pay_url: session.url, total_cents: placed.totalCents, currency: placed.currency, status: "awaiting_payment" });
    }
    default:
      return { content: JSON.stringify({ code: "UNKNOWN_TOOL", message: `Unknown commerce tool: ${name}` }), isError: true };
  }
}
```

> Confirm `sha256hex` is exported from `mcp_oauth.server.ts` (it is, per the grep). If not, hash with `node:crypto` `createHash('sha256')`.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/assistant/commerce-tools.server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/lib/assistant/commerce-tools.server.ts app/lib/assistant/commerce-tools.server.test.ts
git commit -m "assistant: agentic commerce tool schemas + handlers (buy-in-chat P2)"
```

---

## Task 6: Wire commerce tools into the dispatcher with scope gating

**Files:**
- Modify: `app/lib/assistant/tools.server.ts`
- Test: `app/lib/assistant/tools.server.test.ts` (create if absent)

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/assistant/tools.server.test.ts
import { describe, it, expect, vi } from "vitest";
import { makeToolDispatcher } from "./tools.server";

describe("commerce scope gating", () => {
  it("refuses a commerce tool when the caller lacks the commerce scope", async () => {
    const dispatch = makeToolDispatcher({} as never, { scopes: ["read"] });
    const res = await dispatch("place_order", { quote_id: "q1", email: "b@x.com" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).code).toBe("COMMERCE_SCOPE_REQUIRED");
  });

  it("routes a commerce tool to the handler when commerce scope + ctx present", async () => {
    vi.resetModules();
    vi.doMock("./commerce-tools.server", async (orig) => ({ ...(await orig() as object), handleCommerceTool: async () => ({ content: JSON.stringify({ products: [] }) }) }));
    const { makeToolDispatcher: make } = await import("./tools.server");
    const dispatch = make({} as never, { scopes: ["read", "commerce"], commerceCtx: { shopId: "shop_test", clientId: "c1" } });
    const res = await dispatch("get_catalog", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content)).toHaveProperty("products");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/assistant/tools.server.test.ts`
Expected: FAIL — `scopes`/`commerceCtx` deps + routing not implemented.

- [ ] **Step 3: Implement the gate**

In `app/lib/assistant/tools.server.ts`:

```typescript
import { COMMERCE_TOOLS, COMMERCE_TOOL_NAMES, handleCommerceTool, type CommerceCtx } from "./commerce-tools.server";

// extend the deps:
export interface ToolDispatcherDeps {
  flagAlert?: (alertId: string) => Promise<boolean>;
  scopes?: string[];          // scopes of the calling token/grant
  commerceCtx?: CommerceCtx;  // present only on the external buyer surface
}

const COMMERCE_NAME_SET = new Set<string>(COMMERCE_TOOL_NAMES);

// Surface the commerce tools ONLY to callers that carry the commerce scope. The in-app
// merchant assistant (scopes without "commerce") never sees or runs them.
export function toolsForScopes(scopes: string[] | undefined): Anthropic.Tool[] {
  const base = ASSISTANT_TOOLS;
  return scopes?.includes("commerce") ? [...base, ...COMMERCE_TOOLS] : base;
}
```

Then, at the TOP of the `dispatch` switch in `makeToolDispatcher`, before the existing cases:

```typescript
    if (COMMERCE_NAME_SET.has(name)) {
      if (!deps.scopes?.includes("commerce") || !deps.commerceCtx) {
        return toolError("COMMERCE_SCOPE_REQUIRED", `${name} requires the commerce scope`);
      }
      return await handleCommerceTool(name, input, deps.commerceCtx);
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/assistant/tools.server.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add app/lib/assistant/tools.server.ts app/lib/assistant/tools.server.test.ts
git commit -m "assistant: scope-gate commerce tools in dispatcher (buy-in-chat P2)"
```

---

## Task 7: Gate + cross-repo / parity follow-ups

- [ ] **Step 1: Full gate**

Run, expecting exit 0 each: `npx tsc --noEmit`; `npm run lint`; `npx vitest run`; `npm run build`.

- [ ] **Step 2: Run `/code-review`** on the working tree; resolve blockers.

- [ ] **Step 3: Record the cross-repo follow-ups (do NOT silently skip — rule 12)**

Add a short note to the spec's progress section / open a tracking issue for:
1. **`calderyn-mcp` deploy wiring** — the external MCP server (separate repo, `calderyn-mcp.vercel.app`) must (a) serve `toolsForScopes(grantScopes)` so a commerce-scoped connector sees the four tools, (b) pass `commerceCtx = { shopId, clientId }` resolved from the OAuth grant into `makeToolDispatcher`, and (c) request the `commerce` scope during DCR/consent. This repo exposes `toolsForScopes` + the deps for it; the deploy consumes them.
2. **Grant the `commerce` scope + spend cap** — the consent screen (`oauth.authorize.tsx`) and the token UI (`app.mcp.tsx`) need a way to grant `commerce` and set `spend_cap_cents` per client; default stays off (no client transacts until a merchant opts it in).
3. **Dashboard parity** — agentic orders now exist (`orders.channel='agentic'`); the dashboard "Agentic channel" panel is built in P4.

---

## Self-review notes (author)

- **Spec coverage (§7.2, §8):** catalog/quote/place_order tools → Task 5; Stripe link payment → Task 4; spend cap + commerce scope (rule 5) → Tasks 3, 6; channel marker + order core → Tasks 1, 2; PII isolation reuses `createCheckout`'s buyer writes → Task 2.
- **Convergence on the existing paid tail:** place_order creates a `checkout_pending` order; payment + `paid` + emit are the unchanged Stripe webhook path (Task 4 note verifies order resolution).
- **Deliberately deferred:** ACP adapter → P3; storefront widget + dashboard panel → P4; the `calderyn-mcp` deploy + consent-scope UI → cross-repo follow-ups (Task 7, flagged not skipped).
- **Type consistency:** `placeAgenticOrder` → `PlaceResult`; `getQuote` → `LockedQuote` (from P1); `handleCommerceTool(name, input, ctx)` matches the dispatcher call; `toolsForScopes`/`commerceCtx` consistent across Task 6.
