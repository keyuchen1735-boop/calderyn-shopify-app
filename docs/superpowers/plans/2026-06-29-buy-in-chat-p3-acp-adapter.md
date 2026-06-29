# Buy-in-Chat P3 — ACP (ChatGPT) Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a buyer in ChatGPT complete a real, paid purchase with no browser hop — via the Agentic Commerce Protocol: a product feed + `checkout_sessions` create/update/complete endpoints, where `complete` carries a Stripe **Shared Payment Token** we charge server-side.

**Architecture:** A thin ACP REST adapter over the P1/P2 owned core. The product feed projects `getAgenticCatalog`. Session create/update call `quoteCart` + `lockQuote` (zero ACP-specific pricing). `complete` runs the same `assertWithinCommerceCap` → `placeAgenticOrder` core as MCP, then charges the SPT through Stripe; the existing Stripe webhook flips the order to `paid`. Requests are authenticated by ACP request-signature verification, NOT our OAuth.

**Tech Stack:** TypeScript (strict, ESM), Remix resource routes, Supabase via `getSupabase()`, Stripe SDK v22 (`paymentIntents` with a delegated payment method), Vitest.

**Depends on:** P1 (`quoteCart`, `lockQuote`/`getQuote`, `getAgenticCatalog`), P2 (`placeAgenticOrder`, `assertWithinCommerceCap`, `orders.channel`). **Parent spec:** §7.1, §9.

> **HARD EXTERNAL PRECONDITION (rule 12):** ACP cannot transact until **OpenAI approves us as an ACP merchant** AND **Stripe ACP / Shared Payment Token acceptance is enabled** on the account. This plan ships the adapter **built but dormant** behind `ACP_ENABLED`. Do not claim the surface is live until both approvals land and a real SPT test charge clears.

> **WIRE-SCHEMA NOTE:** the ACP request/response field names below are the *current best-known* shape. Before implementing each route, open the live spec (`developers.openai.com/commerce` + `agenticcommerce.dev/docs`) and confirm exact field names for the spec version we onboard against. Our **internal** mapping (to `quoteCart`/`placeAgenticOrder`) is the stable part; adjust only the wire (de)serialization.

---

## File structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `supabase/migrations/<ts>_acp_session.sql` | `acp_session` (ACP session id ↔ shop/quote/order/status) | Create |
| `app/lib/commerce/acp/signature.server.ts` | `verifyAcpSignature()` — authenticate inbound ACP requests | Create |
| `app/lib/commerce/acp/session-store.server.ts` | `createAcpSession`/`getAcpSession`/`attachOrder` | Create |
| `app/lib/commerce/acp/charge.server.ts` | `chargeSharedPaymentToken()` — Stripe charge of the delegated token | Create |
| `app/lib/commerce/acp/map.ts` | pure ACP⇄core mappers (feed item, session body) | Create |
| `app/routes/acp.feed[.]json.tsx` | `GET` product feed | Create |
| `app/routes/acp.checkout_sessions.tsx` | `POST` create session | Create |
| `app/routes/acp.checkout_sessions.$id.tsx` | `POST` update / `GET` retrieve | Create |
| `app/routes/acp.checkout_sessions.$id.complete.tsx` | `POST` complete (SPT charge) | Create |

---

## Task 1: Migration — ACP session table

**Files:**
- Create: `supabase/migrations/<timestamp>_acp_session.sql`

- [ ] **Step 1: Write the migration**

```sql
-- An ACP checkout session: the protocol's stateful handle that maps to our locked quote and,
-- once completed, our owned order. client_id ties it to the registered AI client for the cap.
create table if not exists acp_session (
  session_id  text        primary key,           -- the ACP session id we mint
  shop_id     text        not null,
  client_id   text        not null,
  quote_id    uuid,                               -- set on create/update (the locked quote)
  order_id    text,                               -- set on complete
  status      text        not null default 'open', -- open | completed | canceled
  buyer_email text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists idx_acp_session_shop on acp_session (shop_id, created_at desc);
```

- [ ] **Step 2: Apply + commit**

Run: `npx supabase migration up` → applies.

```bash
git add supabase/migrations/
git commit -m "commerce: acp_session table (buy-in-chat P3)"
```

---

## Task 2: `verifyAcpSignature()` — authenticate inbound ACP requests

**Files:**
- Create: `app/lib/commerce/acp/signature.server.ts`
- Test: `app/lib/commerce/acp/signature.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/acp/signature.server.test.ts
import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAcpSignature } from "./signature.server";

const SECRET = "whsec_test";
const body = JSON.stringify({ a: 1 });
const good = createHmac("sha256", SECRET).update(body).digest("hex");

describe("verifyAcpSignature", () => {
  it("accepts a correct signature", () => {
    expect(verifyAcpSignature(body, good, SECRET)).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyAcpSignature(JSON.stringify({ a: 2 }), good, SECRET)).toBe(false);
  });
  it("rejects a missing/garbage signature without throwing", () => {
    expect(verifyAcpSignature(body, "", SECRET)).toBe(false);
    expect(verifyAcpSignature(body, "deadbeef", SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/acp/signature.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/acp/signature.server.ts
// Authenticate inbound ACP requests by HMAC over the RAW body (constant-time compare). The
// shared secret is provisioned during OpenAI/Stripe ACP merchant onboarding (ACP_SIGNING_SECRET).
// NOTE: confirm the exact header name + signing scheme against the onboarded ACP spec version;
// some versions sign `${timestamp}.${body}` and send a `Signature`/`timestamp` header pair.
// If so, fold the timestamp into the signed payload and reject stale timestamps here.
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyAcpSignature(rawBody: string, signatureHex: string, secret: string): boolean {
  if (!signatureHex || !secret) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try { b = Buffer.from(signatureHex, "hex"); } catch { return false; }
  return a.length === b.length && timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run app/lib/commerce/acp/signature.server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/lib/commerce/acp/signature.server.ts app/lib/commerce/acp/signature.server.test.ts
git commit -m "commerce/acp: request signature verification (buy-in-chat P3)"
```

---

## Task 3: ACP⇄core mappers + session store

**Files:**
- Create: `app/lib/commerce/acp/map.ts`
- Create: `app/lib/commerce/acp/session-store.server.ts`
- Test: `app/lib/commerce/acp/map.test.ts`

- [ ] **Step 1: Write a failing test for the mappers**

```typescript
// app/lib/commerce/acp/map.test.ts
import { describe, it, expect } from "vitest";
import { toAcpFeedItem, toAcpSessionBody } from "./map";

describe("ACP mappers", () => {
  it("maps a catalog item to an ACP feed item", () => {
    const item = toAcpFeedItem({ variantId: "V1", title: "Widget", priceCents: 1999, currency: "usd", availableQty: 5, vendor: "Acme", category: "tools", tags: [] });
    expect(item).toMatchObject({ id: "V1", title: "Widget", availability: "in_stock" });
    expect(item.price).toBe("19.99 USD"); // ACP price string; confirm format against spec
  });
  it("maps a locked quote to an ACP session totals body in cents", () => {
    const body = toAcpSessionBody("sess_1", { quoteId: "q1", subtotalCents: 2000, shippingCents: 500, taxCents: 160, totalCents: 2660, currency: "usd", deliveryLatest: "2026-07-05", lines: [{ variantId: "V1", quantity: 2, unitPriceCents: 1000, currency: "usd", titleSnapshot: "Widget" }] } as never);
    expect(body.id).toBe("sess_1");
    expect(body.totals).toMatchObject({ total: 2660, tax: 160, shipping: 500, currency: "usd" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/acp/map.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the pure mappers**

```typescript
// app/lib/commerce/acp/map.ts
// Pure ACP<->core translation. The ONLY place ACP wire field names live. Confirm field names /
// price formatting against the onboarded ACP spec version; the inputs (our core types) are stable.
import type { CatalogFeedItem } from "~/lib/commerce/catalog.server";
import type { LockedQuote } from "~/lib/commerce/quote-store.server";

export interface AcpFeedItem { id: string; title: string; price: string; availability: "in_stock" | "out_of_stock"; }
export interface AcpSessionBody {
  id: string;
  line_items: Array<{ id: string; quantity: number; amount: number }>;
  totals: { subtotal: number; shipping: number; tax: number; total: number; currency: string };
  fulfillment: { delivery_by: string | null };
  status: "ready_for_payment";
}

export function toAcpFeedItem(c: CatalogFeedItem): AcpFeedItem {
  return {
    id: c.variantId,
    title: c.title,
    price: `${(c.priceCents / 100).toFixed(2)} ${c.currency.toUpperCase()}`,
    availability: c.availableQty > 0 ? "in_stock" : "out_of_stock",
  };
}

export function toAcpSessionBody(sessionId: string, q: LockedQuote): AcpSessionBody {
  return {
    id: sessionId,
    line_items: q.lines.map((l) => ({ id: l.variantId, quantity: l.quantity, amount: l.unitPriceCents * l.quantity })),
    totals: { subtotal: q.subtotalCents, shipping: q.shippingCents, tax: q.taxCents, total: q.totalCents, currency: q.currency },
    fulfillment: { delivery_by: q.deliveryLatest },
    status: "ready_for_payment",
  };
}
```

- [ ] **Step 4: Implement the session store**

```typescript
// app/lib/commerce/acp/session-store.server.ts
// Persist the ACP session <-> locked-quote <-> order mapping.
import { randomBytes } from "node:crypto";
import { getSupabase } from "~/lib/supabase.server";

export interface AcpSession { sessionId: string; shopId: string; clientId: string; quoteId: string | null; orderId: string | null; status: string; }

export async function createAcpSession(shopId: string, clientId: string, quoteId: string): Promise<string> {
  const sessionId = `acp_${randomBytes(16).toString("hex")}`;
  const ins = await getSupabase().from("acp_session").insert({ session_id: sessionId, shop_id: shopId, client_id: clientId, quote_id: quoteId, status: "open" });
  if (ins.error) throw ins.error;
  return sessionId;
}

export async function updateAcpSessionQuote(sessionId: string, quoteId: string): Promise<void> {
  const up = await getSupabase().from("acp_session").update({ quote_id: quoteId, updated_at: new Date().toISOString() }).eq("session_id", sessionId);
  if (up.error) throw up.error;
}

export async function getAcpSession(sessionId: string): Promise<AcpSession | null> {
  const res = await getSupabase().from("acp_session").select("session_id, shop_id, client_id, quote_id, order_id, status").eq("session_id", sessionId).maybeSingle();
  if (res.error) throw res.error;
  const r = res.data as Record<string, unknown> | null;
  if (!r) return null;
  return { sessionId: String(r.session_id), shopId: String(r.shop_id), clientId: String(r.client_id), quoteId: r.quote_id ? String(r.quote_id) : null, orderId: r.order_id ? String(r.order_id) : null, status: String(r.status) };
}

export async function completeAcpSession(sessionId: string, orderId: string): Promise<void> {
  const up = await getSupabase().from("acp_session").update({ order_id: orderId, status: "completed", updated_at: new Date().toISOString() }).eq("session_id", sessionId);
  if (up.error) throw up.error;
}
```

- [ ] **Step 5: Run to verify pass + commit**

Run: `npx vitest run app/lib/commerce/acp/map.test.ts` → PASS. `npx tsc --noEmit` → exit 0.

```bash
git add app/lib/commerce/acp/map.ts app/lib/commerce/acp/map.test.ts app/lib/commerce/acp/session-store.server.ts
git commit -m "commerce/acp: core<->wire mappers + session store (buy-in-chat P3)"
```

---

## Task 4: `chargeSharedPaymentToken()` — Stripe delegated charge

**Files:**
- Create: `app/lib/commerce/acp/charge.server.ts`
- Test: `app/lib/commerce/acp/charge.server.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// app/lib/commerce/acp/charge.server.test.ts
import { describe, it, expect, vi } from "vitest";

describe("chargeSharedPaymentToken", () => {
  it("creates a confirmed PaymentIntent for the order total using the SPT as payment_method", async () => {
    vi.resetModules();
    const created: Record<string, unknown>[] = [];
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async (a: Record<string, unknown>) => { created.push(a); return { id: "pi_1", status: "succeeded" }; } } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }));
    const { chargeSharedPaymentToken } = await import("./charge.server");
    const res = await chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_123" });
    expect(res.status).toBe("succeeded");
    expect(created[0]).toMatchObject({ amount: 2660, currency: "usd", payment_method: "spt_123", confirm: true });
    expect((created[0] as { metadata: { order_ref: string } }).metadata.order_ref).toBe("order1");
  });

  it("surfaces a declined charge (rule 12) rather than reporting success", async () => {
    vi.resetModules();
    vi.doMock("~/lib/payments/stripe.server", () => ({
      getStripe: () => ({ paymentIntents: { create: async () => ({ id: "pi_2", status: "requires_payment_method" }) } }),
    }));
    vi.doMock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }) }));
    const { chargeSharedPaymentToken, ChargeDeclinedError } = await import("./charge.server");
    await expect(chargeSharedPaymentToken("shop_test", { orderId: "order1", totalCents: 2660, currency: "usd", sharedPaymentToken: "spt_bad" }))
      .rejects.toBeInstanceOf(ChargeDeclinedError);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/lib/commerce/acp/charge.server.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

```typescript
// app/lib/commerce/acp/charge.server.ts
// The ChatGPT/ACP payment path: charge the buyer's delegated Shared Payment Token through
// Stripe, server-side, no browser hop. The SPT is a Stripe payment-method-like token scoped to
// this merchant + amount. We confirm synchronously; the existing webhooks.stripe.tsx still
// flips the order to `paid` on payment_intent.succeeded (single paid path). A non-succeeded
// status is surfaced as a decline (rule 12) so we never mark a failed charge as an order.
import { getStripe } from "~/lib/payments/stripe.server";
import { getSupabase } from "~/lib/supabase.server";

export class ChargeDeclinedError extends Error {
  code = "CHARGE_DECLINED";
  constructor(orderId: string, status: string) { super(`charge for order ${orderId} not completed (status: ${status})`); }
}

export interface SptChargeInput { orderId: string; totalCents: number; currency: string; sharedPaymentToken: string; }

export async function chargeSharedPaymentToken(shopId: string, input: SptChargeInput): Promise<{ paymentIntentId: string; status: string }> {
  const pi = await getStripe().paymentIntents.create({
    amount: input.totalCents,
    currency: input.currency.toLowerCase(),
    payment_method: input.sharedPaymentToken,
    confirm: true,
    off_session: true,
    metadata: { shop_id: shopId, order_ref: input.orderId },
  });
  // Mirror into payment_intent so the webhook + reconciliation resolve the order (same as
  // createPaymentIntent does for the storefront path).
  await getSupabase().from("payment_intent").insert({ shop_id: shopId, stripe_pi_id: pi.id, order_ref: input.orderId, amount_cents: input.totalCents, currency: input.currency.toLowerCase(), status: pi.status });
  if (pi.status !== "succeeded" && pi.status !== "processing") {
    throw new ChargeDeclinedError(input.orderId, pi.status);
  }
  return { paymentIntentId: pi.id, status: pi.status };
}
```

> Confirm the exact SPT field name in the ACP `complete` payload and whether Stripe expects it as `payment_method` or a `payment_method_data`/network-token shape — this depends on the Stripe ACP integration mode enabled during onboarding. Adjust the `create` call accordingly; the surrounding flow is stable.

- [ ] **Step 4: Run to verify pass + commit**

Run: `npx vitest run app/lib/commerce/acp/charge.server.test.ts` → PASS.

```bash
git add app/lib/commerce/acp/charge.server.ts app/lib/commerce/acp/charge.server.test.ts
git commit -m "commerce/acp: Stripe shared-payment-token charge (buy-in-chat P3)"
```

---

## Task 5: Product feed route

**Files:**
- Create: `app/routes/acp.feed[.]json.tsx`

- [ ] **Step 1: Implement the loader**

```typescript
// app/routes/acp.feed[.]json.tsx
// ACP product feed. Dormant unless ACP_ENABLED. The shop is resolved from a signed feed key
// issued at onboarding (one feed URL per merchant); confirm the resolution mechanism against
// the onboarded spec (path param vs query token).
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getAgenticCatalog } from "~/lib/commerce/catalog.server";
import { toAcpFeedItem } from "~/lib/commerce/acp/map";

export async function loader({ request }: LoaderFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const shopId = resolveShopFromFeedKey(new URL(request.url));
  if (!shopId) return json({ error: "unknown_feed" }, { status: 404 });
  const items = (await getAgenticCatalog(shopId)).map(toAcpFeedItem);
  return json({ items });
}

function resolveShopFromFeedKey(url: URL): string | null {
  // Map the per-merchant feed key (?key=... or a path segment) to a shop_id. Reuse the same
  // shop-resolution the OAuth seam uses (resolveShopId). Replace this stub with that lookup.
  const key = url.searchParams.get("key");
  return key ? key : null; // TODO-REPLACE: resolve key -> shop_id via the registry
}
```

> Replace `resolveShopFromFeedKey` with a real key→shop lookup (a `feed_key` column on the client/shop registry, or reuse `resolveShopId`). The placeholder returns the key verbatim only so the route compiles — it must be replaced before onboarding.

- [ ] **Step 2: Typecheck + commit**

Run: `npx tsc --noEmit` → exit 0.

```bash
git add "app/routes/acp.feed[.]json.tsx"
git commit -m "commerce/acp: product feed route (dormant) (buy-in-chat P3)"
```

---

## Task 6: Checkout session routes — create / update / complete

**Files:**
- Create: `app/routes/acp.checkout_sessions.tsx` (create)
- Create: `app/routes/acp.checkout_sessions.$id.tsx` (update/retrieve)
- Create: `app/routes/acp.checkout_sessions.$id.complete.tsx` (complete)
- Test: `app/routes/__tests__/acp-complete.test.ts`

- [ ] **Step 1: Write a failing integration test for `complete`**

```typescript
// app/routes/__tests__/acp-complete.test.ts
import { describe, it, expect, vi } from "vitest";

describe("ACP complete action", () => {
  it("verifies signature, places the order, charges the SPT, returns the order (cap BEFORE charge)", async () => {
    vi.resetModules();
    process.env.ACP_ENABLED = "true";
    process.env.ACP_SIGNING_SECRET = "whsec_test";
    const order: string[] = [];
    vi.doMock("~/lib/commerce/acp/signature.server", () => ({ verifyAcpSignature: () => true }));
    vi.doMock("~/lib/commerce/acp/session-store.server", () => ({
      getAcpSession: async () => ({ sessionId: "acp_1", shopId: "shop_test", clientId: "c1", quoteId: "q1", orderId: null, status: "open" }),
      completeAcpSession: async () => { order.push("complete_session"); },
    }));
    vi.doMock("~/lib/commerce/quote-store.server", () => ({ getQuote: async () => ({ quoteId: "q1", totalCents: 2660, currency: "usd" }) }));
    vi.doMock("~/lib/commerce/guardrail.server", () => ({ assertWithinCommerceCap: async () => { order.push("cap"); } }));
    vi.doMock("~/lib/commerce/order.server", () => ({ placeAgenticOrder: async () => { order.push("place"); return { orderId: "order1", confirmationToken: "t", totalCents: 2660, currency: "usd" }; } }));
    vi.doMock("~/lib/commerce/acp/charge.server", () => ({ chargeSharedPaymentToken: async () => { order.push("charge"); return { paymentIntentId: "pi_1", status: "succeeded" }; } }));
    const { action } = await import("../acp.checkout_sessions.$id.complete");
    const req = new Request("https://app/acp/checkout_sessions/acp_1/complete", { method: "POST", body: JSON.stringify({ payment: { shared_payment_token: "spt_1" }, buyer: { email: "b@x.com" } }) });
    const res = await action({ request: req, params: { id: "acp_1" }, context: {} } as never);
    const data = await res.json();
    expect(order).toEqual(["cap", "place", "charge", "complete_session"]); // cap precedes charge (rule 5)
    expect(data.order_id).toBe("order1");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run app/routes/__tests__/acp-complete.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement create + update routes**

```typescript
// app/routes/acp.checkout_sessions.tsx  (POST create)
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { lockQuote } from "~/lib/commerce/quote-store.server";
import { createAcpSession } from "~/lib/commerce/acp/session-store.server";
import { toAcpSessionBody } from "~/lib/commerce/acp/map";
import { getQuote } from "~/lib/commerce/quote-store.server";
import { sha256hex } from "~/lib/mcp_oauth.server";

export async function action({ request }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }
  const body = JSON.parse(raw) as { shop_key: string; client_id: string; line_items: Array<{ id: string; quantity: number }>; fulfillment_address: { line_1: string; line_2?: string; city: string; state: string; postal_code: string; country: string } };
  const shopId = resolveShop(body.shop_key); // reuse the feed-key->shop resolution
  const dest = { street1: body.fulfillment_address.line_1, street2: body.fulfillment_address.line_2, city: body.fulfillment_address.city, state: body.fulfillment_address.state, zip: body.fulfillment_address.postal_code, country: body.fulfillment_address.country };
  const quote = await quoteCart(shopId, body.line_items.map((l) => ({ variantId: l.id, quantity: l.quantity })), dest);
  const locked = await lockQuote(shopId, quote, { clientId: body.client_id, destinationHash: sha256hex(JSON.stringify(dest)) });
  const sessionId = await createAcpSession(shopId, body.client_id, locked.quoteId);
  const full = await getQuote(shopId, locked.quoteId);
  return json(toAcpSessionBody(sessionId, full!));
}

function resolveShop(shopKey: string): string { return shopKey; } // TODO-REPLACE: key->shop_id lookup
```

```typescript
// app/routes/acp.checkout_sessions.$id.tsx  (POST update / GET retrieve)
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { getAcpSession, updateAcpSessionQuote } from "~/lib/commerce/acp/session-store.server";
import { getQuote, lockQuote } from "~/lib/commerce/quote-store.server";
import { quoteCart } from "~/lib/commerce/quote.server";
import { toAcpSessionBody } from "~/lib/commerce/acp/map";
import { sha256hex } from "~/lib/mcp_oauth.server";

export async function loader({ params }: LoaderFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const s = await getAcpSession(String(params.id));
  if (!s?.quoteId) return json({ error: "not_found" }, { status: 404 });
  const q = await getQuote(s.shopId, s.quoteId);
  if (!q) return json({ error: "expired" }, { status: 409 });
  return json(toAcpSessionBody(s.sessionId, q));
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }
  const s = await getAcpSession(String(params.id));
  if (!s) return json({ error: "not_found" }, { status: 404 });
  const body = JSON.parse(raw) as { line_items: Array<{ id: string; quantity: number }>; fulfillment_address: { line_1: string; line_2?: string; city: string; state: string; postal_code: string; country: string } };
  const dest = { street1: body.fulfillment_address.line_1, street2: body.fulfillment_address.line_2, city: body.fulfillment_address.city, state: body.fulfillment_address.state, zip: body.fulfillment_address.postal_code, country: body.fulfillment_address.country };
  const quote = await quoteCart(s.shopId, body.line_items.map((l) => ({ variantId: l.id, quantity: l.quantity })), dest);
  const locked = await lockQuote(s.shopId, quote, { clientId: s.clientId, destinationHash: sha256hex(JSON.stringify(dest)) });
  await updateAcpSessionQuote(s.sessionId, locked.quoteId);
  const full = await getQuote(s.shopId, locked.quoteId);
  return json(toAcpSessionBody(s.sessionId, full!));
}
```

- [ ] **Step 4: Implement the complete route**

```typescript
// app/routes/acp.checkout_sessions.$id.complete.tsx  (POST complete)
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { verifyAcpSignature } from "~/lib/commerce/acp/signature.server";
import { getAcpSession, completeAcpSession } from "~/lib/commerce/acp/session-store.server";
import { getQuote } from "~/lib/commerce/quote-store.server";
import { assertWithinCommerceCap } from "~/lib/commerce/guardrail.server";
import { placeAgenticOrder } from "~/lib/commerce/order.server";
import { chargeSharedPaymentToken } from "~/lib/commerce/acp/charge.server";

export async function action({ request, params }: ActionFunctionArgs) {
  if (process.env.ACP_ENABLED !== "true") return json({ error: "acp_disabled" }, { status: 404 });
  const raw = await request.text();
  if (!verifyAcpSignature(raw, request.headers.get("signature") ?? "", process.env.ACP_SIGNING_SECRET ?? "")) {
    return json({ error: "bad_signature" }, { status: 401 });
  }
  const s = await getAcpSession(String(params.id));
  if (!s?.quoteId) return json({ error: "not_found" }, { status: 404 });
  if (s.status === "completed" && s.orderId) return json({ order_id: s.orderId, status: "completed" }); // idempotent

  const q = await getQuote(s.shopId, s.quoteId);
  if (!q) return json({ error: "QUOTE_EXPIRED" }, { status: 409 });

  const body = JSON.parse(raw) as { payment: { shared_payment_token: string }; buyer: { email: string; phone?: string } };

  await assertWithinCommerceCap(s.clientId, q.totalCents);            // rule 5: BEFORE charge
  const placed = await placeAgenticOrder(s.shopId, s.quoteId, { email: body.buyer.email, phone: body.buyer.phone ?? null }, { protocol: "acp", clientId: s.clientId });
  await chargeSharedPaymentToken(s.shopId, { orderId: placed.orderId, totalCents: placed.totalCents, currency: placed.currency, sharedPaymentToken: body.payment.shared_payment_token });
  await completeAcpSession(s.sessionId, placed.orderId);
  // The order reaches `paid` via the existing Stripe webhook on payment_intent.succeeded.
  return json({ order_id: placed.orderId, status: "completed", total: placed.totalCents, currency: placed.currency });
}
```

> Confirm exact request field names (`shared_payment_token`, `fulfillment_address`, `signature` header) against the onboarded ACP spec and adjust only the JSON (de)serialization. The order of operations (verify → cap → place → charge → complete) is the stable invariant.

- [ ] **Step 5: Run the integration test to verify pass**

Run: `npx vitest run app/routes/__tests__/acp-complete.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/routes/acp.checkout_sessions.tsx "app/routes/acp.checkout_sessions.\$id.tsx" "app/routes/acp.checkout_sessions.\$id.complete.tsx" app/routes/__tests__/acp-complete.test.ts
git commit -m "commerce/acp: checkout_sessions create/update/complete routes (dormant) (buy-in-chat P3)"
```

---

## Task 7: Gate + dormancy + onboarding precondition

- [ ] **Step 1: Full gate**

Run, expecting exit 0 each: `npx tsc --noEmit`; `npm run lint`; `npx vitest run`; `npm run build`.

- [ ] **Step 2: Confirm dormancy**

Verify every ACP route 404s when `ACP_ENABLED !== "true"` (the create/update/complete/feed all guard on it). Add `ACP_ENABLED`, `ACP_SIGNING_SECRET` to `.env.example` with comments.

- [ ] **Step 3: Replace the shop-resolution stubs**

Replace `resolveShop`/`resolveShopFromFeedKey` placeholders with the real per-merchant key→`shop_id` lookup (a `feed_key` on the registry, or reuse `resolveShopId`). Grep for `TODO-REPLACE` and confirm none remain.

- [ ] **Step 4: Record the onboarding precondition (rule 12 — do not claim live)**

In the spec progress section, mark ACP as **built, dormant — blocked on OpenAI merchant approval + Stripe ACP enablement**. The surface is NOT live until both land and a real SPT test charge clears end-to-end (charge → webhook → `paid` → `emitPaidOrder`).

- [ ] **Step 5: Run `/code-review`**; resolve blockers.

---

## Self-review notes (author)

- **Spec coverage (§7.1, §9):** feed → Task 5; create/update/complete → Task 6; SPT charge → Task 4; signature auth → Task 2; cap-before-charge (rule 5) → Task 6 ordering test; dormancy + onboarding precondition → Task 7.
- **Reuses the owned core verbatim:** `quoteCart`, `lockQuote`/`getQuote`, `assertWithinCommerceCap`, `placeAgenticOrder`, and the Stripe webhook → `paid` tail — ACP adds zero pricing logic, satisfying "thin adapter."
- **Known wire-schema risk, flagged not hidden:** ACP field names + SPT/Stripe integration mode must be confirmed against the onboarded spec version (Tasks 2, 4, 6 each say so). Stub shop-resolution is `TODO-REPLACE` and gated by `ACP_ENABLED`; Task 7 Step 3 forces its removal.
- **Type consistency:** `LockedQuote` (P1) feeds `toAcpSessionBody`; `placeAgenticOrder` → `PlaceResult` (P2); `chargeSharedPaymentToken` input matches `placed` output.
```
