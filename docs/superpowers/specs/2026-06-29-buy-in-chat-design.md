# Design Spec — Feature #14 buy-in-chat + extend:MCP+storefront

**Spec covers:** platform-pivot `#14` (agentic commerce surface — buy-in-chat) **and** `extend:MCP+storefront` (single-source shipping quote on the non-checkout surfaces).
**Build-order step:** Step 8b (per the 2026-06-28 "both surfaces as one MVP" founder decision).
**Parent spec:** `docs/superpowers/specs/2026-06-27-calderyn-platform-pivot-design.md` (§`#14`, §`extend:MCP+storefront`).
**Date:** 2026-06-29 · **Owner:** Eric · **Status:** Approved design, ready for implementation plan.

---

## 0. One-paragraph ask

Let an external AI assistant browse a merchant's live catalog, get an **accurate binding quote** (price + real shipping + tax for a destination), and place a **real paid order** that completes on Calderyn's own rails — across **two buyer surfaces** (ChatGPT via ACP, Claude via the existing MCP connector) sharing **one owned commerce core** with **no per-surface pricing logic**. The same single-source quote also powers a storefront delivery-promise widget. This is the feature that turns Calderyn from read-only autopilot into something a buyer can transact through.

---

## 1. What changed since the parent spec (rule 7 — conflicts surfaced, not averaged)

The `#14` brief was written 2026-06-27, **before** the owned checkout core merged. Three of its assumptions are now stale; this spec supersedes them:

| Parent-spec assumption | Reality on `main` (2026-06-29) | Consequence for this spec |
|---|---|---|
| "Order completes **through Shopify rails**; payment stays on Shopify (draftOrderComplete)." | Checkout is **Calderyn-owned**: `createCheckout()` → own `orders` table + own **Stripe** PaymentIntent (`app/lib/order/checkout.server.ts`). No Shopify draftOrder anywhere. | buy-in-chat reuses the **owned Stripe checkout**, not Shopify. The owned core now *exists*, so net-new work shrinks. |
| "Quote must call **Shopify's** cart/draftOrder calculate." | The `#6.3` shipping engine exists and is real (`app/lib/shipping/` — `quoteShipping`, `ShippingQuote`, EasyPost adapter), **but checkout hardcodes `shipping=0, tax=0`** (`PILOT_FLAT_*`). | We build **one `quoteCart()`** over the existing engine + Stripe Tax. It is the single accuracy spine and *also* fixes checkout's flat-0 as a side effect. |
| "Extend `ASSISTANT_TOOLS`; external MCP endpoint is `app.mcp.tsx`." | `ASSISTANT_TOOLS` feeds the **in-app** assistant (`runConversationTurn`). The **external** MCP server is a *separate deploy* (`calderyn-mcp.vercel.app/mcp`). This repo holds the **OAuth seam** (`oauth.*`, `mcp_oauth.server.ts`) + token UI (`app.mcp.tsx`). | The MCP commerce tools are added to the shared `ASSISTANT_TOOLS` catalog (scope-gated); the external deploy exposes them. Transacting on the MCP surface uses a Stripe link (see §2). |

---

## 2. Decisions (founder calls + grounded defaults)

| # | Decision | Rationale |
|---|---|---|
| D1 | **Full transacting slice** — spec is done when a real paid order completes in chat. | Founder call (2026-06-29). Meets the MVP bar on the chat surface. |
| D2 | **Delegated charge where the surface supports it.** | Founder call — true in-chat purchase preferred. |
| D3 | **Two surfaces, one owned core:** ChatGPT (ACP) **and** Claude (MCP). | Founder call ("1 and also claude stripe"). Adapters are thin; core is protocol-neutral. |
| D4 | **Claude/MCP payment = Stripe-native link (Checkout Session).** Delegated charge from Claude is **not possible** for a general merchant as of 2026-06: Anthropic does not issue a buyer-side Shared Payment Token to arbitrary merchants (commerce work is partnership-specific/internal; MCP is a tool layer, not a payment rail). | Founder call: "2 if possible, stripe native link if not." Verified not possible → link. |
| D5 | **ChatGPT/ACP payment = delegated Shared Payment Token, charged via Stripe** (server-side, no browser hop). | ACP + Stripe is the mature path and we are already on Stripe. |
| D6 | **Both adapters in-scope, ship together.** ACP routes are built but gated on OpenAI merchant approval (external). | Founder call. The OpenAI/Stripe-ACP onboarding is a **hard external precondition** (§9). |
| D7 | **Tax = Stripe Tax** (`tax.calculations.create`). | Already on Stripe; no new vendor; ACP requires accurate tax. |
| D8 | **Reuse the owned order/payment tail verbatim** — order reaches `paid` only via the existing Stripe webhook. | `webhooks.stripe.tsx` → `processStripeEvent` → `transitionOrder('paid')` → `emitPaidOrder`. Idempotent. No new "paid" path. |

---

## 3. Architecture — one owned core, thin adapters

```
                       ┌──────────────────────────────────────────┐
  ChatGPT (ACP) ─────▶ │ ACP adapter: /acp/feed.json + /acp/       │
                       │ checkout_sessions create·update·complete  │ ─┐
                       │ (complete carries Shared Payment Token)    │  │
                       └──────────────────────────────────────────┘  │
                                                                      ▼
            ┌────────────────────────────────────────────────────────────────┐
            │ OWNED COMMERCE CORE  app/lib/commerce/  (protocol-neutral,        │
            │ NO per-surface pricing):                                         │
            │   • getAgenticCatalog()  ← v_agentic_catalog (sku_dim+inventory) │
            │   • quoteCart()  = subtotal + #6.3 shipping + Stripe Tax         │
            │   • commerce_quote_fact  (append-only, LOCKED, expires_at)       │
            │   • placeAgenticOrder()  ← reuses createCheckout() internals     │
            │   • guardrail: per-client commerce scope + deterministic cap     │
            └────────────────────────────────────────────────────────────────┘
                                                                      ▲
                       ┌──────────────────────────────────────────┐  │
  Claude (MCP) ──────▶ │ MCP adapter: get_catalog · create_quote · │ ─┘
                       │ get_quote · place_order → Stripe link      │
                       └──────────────────────────────────────────┘

  Storefront PDP/cart ─▶ delivery-promise widget reads the SAME quoteCart()
  Dashboard ───────────▶ "Agentic channel" parity panel (clients · quotes · orders)

  Both payment adapters converge on the SAME tail:
    owned order (checkout_pending) → Stripe charge → webhooks.stripe.tsx
      → transitionOrder('paid') → emitPaidOrder (order_fact + ad_click_ref)
```

**Boundary rule:** pricing, quoting, and order origination exist exactly once, in `app/lib/commerce/`. Adapters only translate transport (ACP REST ⇄ core, MCP tool ⇄ core) and select the payment method. An adapter holds **zero** pricing logic.

---

## 4. Module layout

New module `app/lib/commerce/` (server-only):

| File | Export | Purpose | Reuses |
|---|---|---|---|
| `catalog.server.ts` | `getAgenticCatalog(shopId, opts)` | product-feed rows from `v_agentic_catalog`; excludes out-of-stock/untracked | `sku_dim`, `inventory_level_fact` |
| `quote.server.ts` | `quoteCart(shopId, lines, destination)` | the single accuracy spine → `{subtotalCents, shippingCents, taxCents, totalCents, currency, deliveryWindow, lowConfidence, fallbackUsed, expiresAt}` | `priceCart` + `getShippingEngine()` (#6.3) + Stripe Tax |
| `quote-store.server.ts` | `lockQuote`, `getQuote` | persist/lock/read `commerce_quote_fact`; re-read returns the same row | `order_fact` upsert discipline |
| `order.server.ts` | `placeAgenticOrder(shopId, quoteId, buyer, payment)` | owned order in `checkout_pending` + Stripe charge, tagged `channel='agentic'` | `createCheckout` internals (`upsertGuestBuyer`, `orders`/`order_line` insert) |
| `guardrail.server.ts` | `assertWithinCommerceCap(clientId, amountCents)` | deterministic per-client spend/rate cap (rule 5) | `guardrail_config` pattern |

Adapters:
- `app/lib/commerce/acp/` (mapping helpers) + routes `app/routes/acp.feed[.]json.tsx`, `app/routes/acp.checkout_sessions.tsx`, `app/routes/acp.checkout_sessions.$id.tsx`, `app/routes/acp.checkout_sessions.$id.complete.tsx`.
- MCP: extend `ASSISTANT_TOOLS` + `makeToolDispatcher` in `app/lib/assistant/tools.server.ts` (scope-gated commerce tools).
- Storefront: App-Proxy route `app/routes/storefront.api.delivery-promise.tsx` (proxy-signed) + the PDP/cart widget.
- Dashboard: `app/routes/dashboard.api.agentic._index.tsx` + a `cd-*`/`CDIcon` screen.

---

## 5. Data model & contracts

**NET-NEW**
- `commerce_quote_fact` — `(shop_id, quote_id, client_id, line_items jsonb, subtotal_cents, shipping_cents, tax_cents, total_cents, currency, destination_hash, source_version, expires_at, created_at)`. Append-only, `onConflict(quote_id, source_version)`. **A re-presented quote is the same quote** — the "no second chance" guarantee.
- `v_agentic_catalog` — view over `sku_dim` + `inventory_level_fact` (`retail_price_cents`, availability, `inventory_policy`/`tracked`, category/vendor/tags).

**REUSE + minimal additions**
- `orders` (owned): add `channel` (`'storefront' | 'agentic'`), `protocol` (`'acp' | 'mcp' | null`), `client_id` (nullable). Set at origination; read by the dashboard panel. Channel also written into the existing `orders.attribution` jsonb so `emitPaidOrder` carries it to the warehouse with no new ingest plumbing.
- `mcp_oauth_clients`: add `commerce_scope boolean` + `spend_cap_cents int` (+ optional rate window). The external-AI-client registry already exists.
- OAuth seam (`mcp_oauth.server.ts`, `oauth.*` routes): unchanged.

**Contract: `quoteCart` is the only pricing function.** Checkout (`#2b`), the storefront widget, and both chat adapters call it. No surface re-computes price/shipping/tax.

---

## 6. Quote accuracy spine (`quoteCart`)

1. **Subtotal** — variant snapshot from `sku_dim` (same path as `priceCart`).
2. **Shipping** — `getShippingEngine()` (#6.3) with `origin` (shop ship-from), `destination`, rate source. Take the selected option (cheapest by default); carry `deliveryWindow`. Propagate `fallbackUsed` / `lowConfidence` — a guessed/degraded rate is surfaced, never hidden (rule 12).
3. **Tax** — Stripe Tax `tax.calculations.create` for the destination.
4. **Lock** — write `commerce_quote_fact` with `expires_at` (15 min). `create_quote`/`checkout_session` returns `quote_id`; `get_quote`/session re-read returns the identical row. Charge paths reference the locked total **only**.

Side effect: wiring step 2–3 into checkout replaces `PILOT_FLAT_SHIPPING_CENTS`/`PILOT_FLAT_TAX_CENTS` with real values — checkout, storefront, and chat then quote identically.

---

## 7. Adapters

### 7.1 ACP (ChatGPT) — REST endpoints OpenAI calls
- `GET /acp/feed.json` → `getAgenticCatalog` shaped to ACP product-feed schema.
- `POST /acp/checkout_sessions` (+ `…/{id}` update) → build line items → `quoteCart` → return ACP session with accurate `subtotal/shipping/tax/total` + delivery window.
- `POST /acp/checkout_sessions/{id}/complete` → carries the **Shared Payment Token**. Flow: `assertWithinCommerceCap` → `placeAgenticOrder` (owned order, `protocol='acp'`) → Stripe **PaymentIntent with the SPT as payment_method, confirmed server-side** → return order confirmation. **No browser hop.**
- Auth: verify OpenAI's request signature (not our OAuth). Buyer PII (name/address) → `#1` buyer store, never `order_fact`.

### 7.2 MCP (Claude) — tools on the existing seam, scope-gated
- `get_catalog`, `create_quote`, `get_quote` → call the core directly.
- `place_order(quote_id, buyer)` → `assertWithinCommerceCap` → `placeAgenticOrder` (owned order, `protocol='mcp'`) → create a Stripe **Checkout Session** bound to the order (line items + tax + shipping prefilled from the locked quote) → return the **session URL**. Buyer pays in browser.
- Gated by a `commerce` OAuth scope so the existing read/propose token **cannot** transact.

### 7.3 Shared payment tail (no new "paid" path)
Both adapters end at: owned order → Stripe charge → `webhooks.stripe.tsx` → `processStripeEvent` (`payment_intent.succeeded`) → `transitionOrder('paid')` → `emitPaidOrder` (`order_fact` + `ad_click_ref`). The `paid` transition is already idempotent on Stripe redelivery. A charge failure leaves the order in `checkout_pending` — never a phantom paid order.

---

## 8. Cross-cutting

**Guardrails / security (rule 5 — deterministic, not model-decided):**
- Per-client `spend_cap_cents` + rate check in `assertWithinCommerceCap`, evaluated **before** any charge. Exceeded → `SPEND_CAP_EXCEEDED`, no order.
- Charge paths bill **only** the locked `commerce_quote_fact` total — never a client-supplied amount. Expired → `QUOTE_EXPIRED`, re-quote required.
- ACP routes verify OpenAI signatures; MCP tools verify bearer/OAuth token + `commerce` scope.
- Buyer PII isolation: address/email → `#1` buyer-identity store; **never** `order_fact` (hard invariant).

**Storefront delivery-promise widget (`extend:MCP+storefront`):** App-Proxy (proxy-signed) route → `quoteCart` with a **coarse** destination (geo-IP / entered zip) → "Get it by `<date>`" + cheapest/fastest on PDP/cart. **Labeled an estimate** (coarse dest ≠ exact checkout rate — avoids bait-and-switch). Product-neutral; no provenance markers (browser-source hygiene).

**Dashboard parity ("Agentic channel" panel):** `dashboard.api.agentic.*` + a `cd-*`/`CDIcon` screen showing connected AI clients, quotes issued, and orders by channel/protocol (reads owned `orders` where `channel='agentic'`). **Mirror the contract, do not port Polaris JSX** (CLAUDE.md). This is part of this task, not a follow-up.

**Error handling:** typed errors everywhere (`QUOTE_EXPIRED`, `SPEND_CAP_EXCEEDED`, `OUT_OF_STOCK`, `RATE_UNAVAILABLE`); quote degrades via `fallbackUsed`/`lowConfidence` rather than failing silently.

---

## 9. Risks & preconditions (rule 12 — fail visibly)

- **HARD external precondition — OpenAI ACP merchant approval + Stripe ACP/SPT enablement.** The ACP adapter cannot transact until both land; timeline is out of our control. ACP routes ship **built but dormant**, activated by a flag when approval arrives. The MCP/Claude surface has **no** external gate and ships immediately.
- **Stripe Tax must be enabled** on the account, or tax is wrong and the accuracy bar fails. Verify before launch.
- **Quote accuracy is existential** — any path that estimates shipping/tax instead of calling `quoteCart` mis-quotes in chat with no recovery. Per-surface pricing is forbidden.
- **Coarse storefront estimate** must stay labeled.
- **Dashboard mirror** is in-scope for this task.

---

## 10. Out of scope (non-goals for this slice)

- AP2 (Google) adapter — core stays protocol-neutral so it can slot in later; not built now.
- Owned PSP / managed cart — payment stays on Stripe rails.
- `#15` agentic experimentation (the bandit/bracket) — separate, deferred.
- Refunds-as-action, fulfillment lifecycle — post-purchase, fast-follow.

---

## 11. Testing (behavior, not coverage — rule 9)

- `quoteCart` returns accurate subtotal+shipping+tax; lock/expiry honored; `lowConfidence`/`fallbackUsed` surfaced.
- Spend-cap rejection blocks the charge (`SPEND_CAP_EXCEEDED`).
- Quote-binding: a charge cannot bill an arbitrary amount — only the locked quote total.
- ACP `complete` (mocked Stripe SPT) → order `paid` → `emitPaidOrder` ran once.
- MCP `place_order` → session URL → simulated webhook → `paid` → emit.
- Catalog excludes out-of-stock/untracked.
- Buyer PII never written to `order_fact`.

---

## 12. Build notes

- Per CLAUDE.md feature-isolation: implement in a dedicated worktree (`feat/buy-in-chat`).
- Schema changes via `prisma migrate dev` / Supabase migration; `commerce_quote_fact`, `v_agentic_catalog`, the `orders`/`mcp_oauth_clients` columns.
- Pre-commit gate (typecheck/lint/build + `/code-review`) applies — this touches `app/lib/`, routes, schema, and the OAuth/payment seam (a major change).
- Dashboard parity ships in the same change.
