# Phase 3 — Carrier-adjustment reconciliation + 3PL houses

> Implements **contract §6c** against the frozen spine in `00-overview-and-contract.md` (§3 C1–C9, §4, §5). This doc **does not re-decide** anything in the contract; where it needs a contract fact it cites it. The adapter framework (C1–C9) exists from **Phase 1**; the Shippo adapter from **Phase 2**. Phase 3 details only what is new.
>
> Status: **design only, spike-gated.** Part A is deliberately blocked behind a live API spike — its reconciliation design is written as *conditional* on the spike outcome and must not be built before the spike resolves the link-back question.

## ⚠️ Contract concern (one, minor — non-blocking)

Contract **§5 risk #1** says adjustment link-back is "not confirmable from docs" for **both** providers and routes the resolution to a Phase 3 live spike. My doc research **partially advances** this for **EasyPost** before the spike: EasyPost's own materials state the `shipment_invoice` report carries **`Shipment ID` and `Tracking Code` columns** plus "claimed vs captured" column pairs and a `Package Dispute ID` ([EasyPost blog](https://www.easypost.com/blog/2023-07-31-better-shipment-and-payment-log-reporting-with-new-batch-id-and-tracking-number-columns/), [adjustments support](https://support.easypost.com/hc/en-us/articles/20174544322445-Shipment-Invoice-Report-Adjustments)). This makes link-back **likely** for EasyPost — but the contract's "unconfirmed" label is still **correct as written**, because (a) those columns are documented for the *dashboard CSV export*, not confirmed as present in the *API report rows* (the API `columns`/`additional_columns` params gate what is emitted), and (b) **Shippo's** beta Invoices API field schema is genuinely not publicly confirmable (the docs are behind 403/404 and explicitly "beta, subject to change"). **No divergence from the contract — recording the EasyPost lead so the spike can confirm it fast rather than discover it cold.** The contract clause stands; this is additive intel.

---

## 1. Goal & success criteria

**Goal.** Close the three remaining gaps after Phases 1–2 ship true label cost as `actual_invoice`:

1. When a carrier **adjusts** a charge after purchase (USPS APV re-weigh, dimension correction, surcharge), the already-landed `shipping_invoice_line` row is **corrected**, and the affected order is **re-resolved** so its `ship_cost_cents` reflects the true settled cost — not the optimistic at-purchase estimate.
2. Two more true-cost surfaces — **ShipBob** and **ShipHero** 3PL fulfillment houses — land as drop-in `ShipCostAdapter`s, extending coverage to merchants who outsource fulfillment.
3. The **unmatched carrier charges** surface (rule 12 / C4.6 / §5) is hardened into a real merchant-facing list with a resolve action, on **both** surfaces.

**Success criteria (verifiable):**

- **A.** After a confirmed adjustment lands in the re-pull window, the order's row holds the **settled** `cost_cents` (overwrite, not a second summed line), `runShipCostResolution` has re-run, and `order_fact.ship_cost_cents` / `ship_cost_source='actual_invoice'` reflect the new amount. A test drives label→adjustment and asserts the final cost equals the adjusted amount, not the sum.
- **B.** `SHIP_ADAPTERS` contains `shipBobAdapter` and `shipHeroAdapter`; a connected ShipBob/ShipHero shop is picked up by the existing cron with **zero** new generic-core code (C1 holds); each lands ≥1 matched line in a fixture test.
- **C.** A merchant with N unmatched charges sees an accurate count + list on both surfaces and can map one charge to an order (embedded) / see the count read-only (dashboard). Resolving a charge re-runs resolution and the count decrements.
- **Honest-coverage invariant unchanged:** no surface implies universal coverage (§5 #3).

---

## 2. Scope

**In scope (the three parts):**

- **Part A** — post-purchase carrier-adjustment reconciliation: a **live API spike first** (decision-gating), then a design *conditional* on the spike, for both EasyPost and Shippo.
- **Part B** — **ShipBob** and **ShipHero** adapters as further drop-ins on the existing framework (enum value, registry entry, connect mechanism, display constants).
- **Part C** — unmatched-charge surfacing UI hardening on `app/routes/app.settings.tsx` (embedded, interactive) + `app/components/dashboard/screens/Settings.tsx` (dashboard, read-only).

**Explicitly OUT (already shipped in Phase 1/2 — do not re-spec):**

- The `ShipCostAdapter`/`ShipSource`/`NormalizedShipmentCost` interfaces (C1), registry + `shipAdaptersForShops` (C2), the `/cron/ingest-ship-costs` cron (C3), landing into the synthetic period (C4), `matchInvoiceLines` reuse (C5), the allocation fence (C6), integrations enum/connect/UI wiring **machinery** (C7), provider-specific connect mechanism pattern (C8), naming (C9).
- EasyPost adapter (Phase 1) and Shippo adapter (Phase 2) themselves.
- Any change to `resolve.ts` tiering, `runner.server.ts` allocation math, or the line/period table shape beyond what Part A's spike *conditionally* requires (§6).

---

## 3. Part A — Carrier-adjustment reconciliation

This is the central, riskiest part. **It opens with a live spike, not a design.** Everything in A.2 is written as a branch on the spike's single decision.

### A.1 — The live API spike plan (decision-gating)

**Why a spike, not docs.** Contract §5 #1: whether a post-purchase adjustment row **links back** to the original shipment/order is the load-bearing unknown. If it links back, reconciliation is a clean overwrite of the right row. If it does **not**, an adjustment is an orphan dollar amount we can only re-match by tracking number (and only if the adjustment row even carries one) — a materially different, lower-confidence design. **No reconciliation code is written until this resolves.**

**The one decision the spike must return, per provider:**

> **Q-LINK:** Given an adjustment/invoice-item record, does it contain a field that identifies the *original shipment, label, or transaction* (or, failing that, the original **tracking number**)? — YES-strong (shipment/transaction id), YES-weak (tracking only), or NO.

#### A.1.1 — EasyPost spike

**Auth/setup:** real EasyPost prod key (a merchant test account or our own), Basic auth (key-as-username). EasyPost adjustments are **only ever real** (carrier-originated), so the spike needs an account with actual USPS volume that has incurred ≥1 APV adjustment — test-mode will not produce adjustments. Coordinate a window where a known label has been re-weighed.

**Exactly what to call:**

1. `POST /v2/reports/shipment_invoice` with `start_date`/`end_date` (≤31 days apart per [Reports docs](https://docs.easypost.com/docs/reports)), and **explicitly request the widening columns**: pass `additional_columns` / `columns` to force every adjustment-related field into the output (the dashboard export defaults differ from the API defaults — this is the crux).
2. Poll `GET /v2/reports/shipment_invoice/:id` (or register a webhook) until `status: "available"`, then fetch the `url` (signed CSV).
3. In parallel, `POST /v2/reports/payment_log` and `POST /v2/reports/refund` for the same window — to see whether adjustments surface as payment-log deltas / refunds with different (possibly richer) linkage than the shipment-invoice CSV.

**The precise fields whose existence decides the design** (inspect the CSV header + one adjustment row):

| Field to confirm | Decides |
|---|---|
| **`Shipment ID`** present **and populated** on an adjustment row | YES-strong link-back → overwrite by shipment id |
| **`Tracking Code`** present on adjustment row | YES-weak fallback → re-match by tracking via `matchInvoiceLines` |
| **`Reference`** (the `shipment.reference` we set on purchase) present | direct order match-back without tracking |
| **`Package Dispute ID`** + "claimed vs captured" cost pair | the adjustment **delta** and reason (for display + audit) |
| original-vs-adjusted **amount columns** | whether the row carries the *new total* or only the *delta* (overwrite needs the total; a delta needs additive math) |

> Doc lead (confirm, don't trust): EasyPost states the report carries `Shipment ID`, `Tracking Code`, `Package Dispute ID`, and claimed/captured columns ([blog](https://www.easypost.com/blog/2023-07-31-better-shipment-and-payment-log-reporting-with-new-batch-id-and-tracking-number-columns/)). If the spike confirms `Shipment ID` is populated on adjustment rows **via the API**, EasyPost is **YES-strong** and A.2-overwrite applies cleanly.

**Webhook to verify in the same spike:** confirm the event type string. The legacy announcement names it **`ShipmentInvoice`** ([blog](https://www.easypost.com/blog/2020-05-20-easypost-shipment-invoice-report-and-webhook-event/)); the modern `report.*` lifecycle fires `report.available` when a report CSV is ready. Pin both exact strings against the live Events feed — the cron's re-pull (A.3) does not strictly need them, but they decide whether we can go event-driven later.

#### A.1.2 — Shippo spike

**Auth/setup:** Shippo prod token (the same per-merchant OAuth token Phase 2 stores, `Bearer oauth.<token>`), against the **beta Invoices API**. As with EasyPost, adjustments are carrier-real — need an account with settled USPS volume.

**Exactly what to call:**

1. `GET /shippoinvoices/.../invoices` (`ListInvoices`) filtered by date range + status to find the invoice covering the window.
2. `GET .../invoices/{id}` (`GetInvoice`) and **`ListInvoiceItems`** filtered by `object_owner` — invoice items are "the individual amounts owed to Shippo … purchased label, a charge for a service, **and refunds**" ([Shippo Invoices beta](https://docs.goshippo.com/shippoinvoices/invoices/operation/ListInvoiceItemsTemplate/)).
3. Cross-check against the **Transaction** object: pull the original `Transaction` (the label) and inspect whether its `metadata` (the ≤100-char order-ref Phase 2 stores) is echoed onto the adjustment/refund item.

**The precise fields whose existence decides the design** (inspect one refund/adjustment invoice-item):

| Field to confirm | Decides |
|---|---|
| an **`object_id` / `transaction` / `shipment`** reference on the invoice item pointing at the original `Transaction` | YES-strong → overwrite by transaction id |
| **`tracking_number`** on the invoice item | YES-weak fallback → re-match by tracking |
| original `Transaction.metadata` echoed onto the item | direct order match-back (Phase 2's match key survives the adjustment) |
| item **type** enum distinguishing `label` / `charge` / `refund`/adjustment | how to recognize an adjustment vs the original charge |
| item **amount sign/semantics** (refund negative? adjustment = new total or delta?) | overwrite-vs-additive (same question as EasyPost) |

> Honest status: Shippo's Invoices API is **beta, contract subject to change**, and the field-level schema is **not publicly confirmable** (docs behind 403/404). The spike is the *only* way to answer Q-LINK for Shippo. If it returns **NO**, Shippo reconciliation ships **deferred/degraded** (A.4) while EasyPost proceeds — never block EasyPost on Shippo.

**Spike deliverable:** a one-page finding per provider — Q-LINK answer (strong/weak/NO), the exact field name that carries the link, whether the row carries the **new total** or a **delta**, and the confirmed webhook/poll story. **This finding is the gate for A.2.** Until it lands, "`actual_invoice`" remains the at-purchase label cost (Phase 1/2 behavior) and adjustments are a known, surfaced follow-up.

### A.2 — Reconciliation design, conditional on the spike

The framework already **re-fetches** the window: the cron passes `since` = a **trailing re-pull window** (C3, "carrier costs settle/adjust post-ship → re-pull, e.g. last 14–30 days"). So the adjusted charge is **already being re-pulled** on the daily poll — Part A is about what `land.server.ts` does with it once Q-LINK is known. The re-pull window must be **≥ the carrier adjustment SLA** (USPS APV commonly lands weeks later); widen the EasyPost/Shippo `since` window in Part A to e.g. 30–45 days specifically so adjustments fall inside it. (Cost: re-pulling more rows per poll; bounded by provider pagination.)

**The landing/overwrite decision tree:**

#### Branch YES-strong (link by shipment/transaction id) — *preferred, clean*
- `NormalizedShipmentCost.externalId` already is "the provider's stable charge/shipment/transaction id — idempotency key" (C1). The adjustment row carries the **same** `externalId` as the original label (or one that maps to it).
- **OVERWRITE, not append.** This is the C4-step-4 delete-by-keyset path doing its job: the re-pull re-computes the per-order line; because the adjusted charge shares the original's match key (tracking/ref), the existing line is deleted and re-inserted with the **settled** `cost_cents`. **No new line, no double-count** — which is mandatory because the resolver is last-write-wins / not summed (contract §2; `runner.server.ts:43-45` `invoiceByOrder` is a plain `Map`).
- If the provider row carries the **new total**: overwrite directly. If it carries only a **delta**: the re-pull must re-read the original + delta and write `original + Σdeltas` as the line's `cost_cents` (the spike says which). Pre-aggregation (C4.3, sum per `matched_order_id`) already handles the "original + adjustment both in-window" case **iff** both map to the same order — confirm in the test.

#### Branch YES-weak (tracking only) — *workable, lower confidence*
- The adjustment has no shipment id but does have a **tracking number**. `matchInvoiceLines` already does tracking-number fallback (`trim().toLowerCase()`, no `#` strip — `match.ts`, C5) — so the adjustment **re-matches to the same order** as the original label, and the same delete-by-keyset overwrite applies (the delete predicate already scopes on `tracking_no IN (<window keys>)`, C4.4).
- Risk: if the original label and the adjustment disagree on tracking normalization, the overwrite misses and the adjustment lands as a **second** line (double-count) or as **unmatched** (Part C). Test both.

#### Branch NO (no link) — *degraded; surface, don't fake*
- An adjustment with neither id nor tracking is an **orphan dollar amount**. We **cannot** safely attribute it to an order (rule 12: do not guess). It lands as an **unmatched charge** (Part C) with a clear reason ("carrier adjustment, no link"), visible and merchant-resolvable — never silently dropped, never blindly summed onto an arbitrary order.
- For this branch, `actual_invoice` stays at the **at-purchase** cost; the doc states plainly that adjustments are not auto-reconciled for that provider (mirrors the §1 Shopify "no API path" honesty).

**Re-resolution trigger (all branches).** No new trigger is invented — the cron **already** calls `await runShipCostResolution(sb, shopId, { shopCountry })` after landing (C3; `runner.server.ts:19-82`). Because the overwrite mutates the existing `shipping_invoice_line.cost_cents`, the very next resolver pass reads the new value at `runner.server.ts:41-46` (`select matched_order_id, cost_cents` → `invoiceByOrder.set(...)`), recomputes via `resolveOrderShipCost` (`resolve.ts:6-7`, still `actual_invoice`/high), and writes `order_fact.ship_cost_cents` (`runner.server.ts:73-78`) → which cascades into `rollShipCostIntoSkuPnl` (`runner.server.ts:81`). **The reconciliation re-trigger is "land the overwrite inside the existing post-land resolution call" — zero resolver change.** This satisfies the §2 inherited behavior "resolution is not triggered by insert" by reusing the cron's explicit call.

### A.3 — Webhooks vs poll

**Poll is the baseline and is sufficient.** The C3 cron re-pulls a trailing window daily; widening that window to cover the adjustment SLA (A.2) means adjustments are caught **without** any webhook. This is the simplest correct design and is what Phase 3 ships first (rule 2).

**Webhooks are an optimization, deferred:**
- **EasyPost:** `report.available` (modern) / `ShipmentInvoice` (legacy) could trigger an out-of-band re-pull of just the new report instead of waiting for the daily poll — lower latency to corrected P&L. Requires a new webhook route mirroring the existing webhook-awareness noted for Phase 1; **out of Phase 3 scope unless the daily-poll latency proves unacceptable.** Note: registering it touches Vercel function paths — heed the recent prod 501 path-collision incidents (`551dabf`, `b486895`) the contract flags in C3.
- **Shippo:** the beta Invoices API has **no documented invoice webhook** (Phase 2 uses `transaction_created` for the *original* label, not adjustments). So Shippo adjustments are **poll-only** regardless — another reason poll is the baseline.

**Decision: poll-only for Phase 3.** Webhooks are listed in §12 deferred.

### A.4 — Part A risks

1. **Link-back unconfirmed until the spike (the headline).** If Q-LINK = NO for a provider, that provider gets the degraded "surface as unmatched" branch, not silent reconciliation. EasyPost is *likely* YES-strong (doc lead), Shippo is genuinely unknown (beta).
2. **Delta-vs-total ambiguity.** If a row carries only the adjustment delta, naive overwrite would *lose* the original cost. The spike must report which; the design branches on it. A test with a known delta guards this.
3. **Adjustment outside the re-pull window.** USPS APV can land later than a 30-day window. Mitigation: widen the window to the carrier SLA; accept that a very-late adjustment may need a manual re-pull (surface as an open question, §10).
4. **Double-count on tracking-normalization mismatch** (YES-weak branch). The delete-by-keyset predicate must use the *same* normalization on both passes; tested explicitly.
5. **Pre-aggregation interaction.** If original + adjustment are both in-window and both match the same order, C4.3 sums them — correct only if the adjustment is a **delta**; if it's a **new total**, summing double-counts. The branch logic (A.2) must pick sum-vs-replace based on the spike's amount-semantics finding. **This is the single subtlest correctness point in Phase 3** — call it out in code review.

---

## 4. Part B — 3PL adapters (ShipBob, ShipHero)

Both are **drop-in `ShipCostAdapter`s** on the Phase 1 framework. Per C1, the generic core never branches on provider; all specifics live behind `connect()` / `fetchCharges()`. This section gives the **provider facts** (researched) + the **wiring deltas**; it does **not** re-spec the framework (C1–C9).

### B.1 — ShipBob — provider fact table

> Sources: [ShipBob Billing guide](https://developer.shipbob.com/guides/billing), [Concepts](https://developer.shipbob.com/concepts), [Orders](https://developer.shipbob.com/guides/orders).

| Fact | ShipBob |
|---|---|
| **Exposes true per-order ship cost?** | **YES.** Billing transactions carry the actual shipping charge `amount` per shipment. |
| **Auth model** | **Personal Access Token (PAT)** in `Authorization` header, scope **`billing_read`**. OAuth 2.0 exists for multi-user apps with granular permissions. |
| **Multi-merchant story** | **Channel-based.** A "channel" = a vendor app installed on the API; a multi-channel app **reads data across all channels belonging to the merchant**, writes only its own channel. For a read-only cost connector, **PAT per merchant** is the simplest path (mirrors EasyPost's "merchant pastes a key", C8). |
| **Cost endpoint** | `POST /2026-01/transactions:query` (filter by date range, type, status) and/or `GET /2026-01/invoices/{invoiceId}/transactions`. |
| **Cost field** | `amount` (+ `currency_code`); `transaction_fee` categorizes it (Shipping vs fuel surcharge etc.) — filter to shipping-type fees. |
| **Order match-back field** | **`reference_id`** with `reference_type = "Shipment"` → ties the charge to a ShipBob shipment; the shipment in turn carries the merchant's order **`reference_id`** (ShipBob "reference IDs tie records to upstream systems, unique per channel"). `additional_details` carries tracking ID. **Match path: charge → shipment → order reference / tracking.** |
| **Adjustments** | Surfaced as further billing **transactions** on later invoices (same `reference_id`) → fits Part A's overwrite-by-keyset naturally once the spike confirms the id is stable. |
| **Webhooks** | Yes (order shipped, shipment delivered, return completed) — **not billing-specific**; cost is **poll-only** via the Billing API (consistent with Part A poll baseline). |
| **Pagination** | `Page` (default 1) + `PageSize` (max 100). |
| **`NormalizedShipmentCost` mapping** | `externalId` = `transaction_id`; `orderRef` = shipment's order reference_id; `trackingNo` = `additional_details` tracking; `costCents` = `amount`×100 (parse carefully); `currency` = `currency_code`; `carrier` = from transaction fee/details; `shippedAt` = `charge_date`. |

### B.2 — ShipHero — provider fact table

> Sources: [ShipHero developer](https://developer.shiphero.com/), [shipment query](https://developer.shiphero.com/schema/queries/shipment.html), [3PL billing community](https://community.shiphero.com/t/shipping-price-on-label-and-invoice/1680).

| Fact | ShipHero |
|---|---|
| **Exposes true per-order ship cost?** | **YES** (with a caveat). The GraphQL `shipment` query exposes `shipping_labels { cost }` per label — the actual label cost. **Caveat:** community reports the label/invoice `FREIGHT` line can read **zero** in some configs; the spike-lite (B.3) must confirm `cost` is populated for our target accounts. |
| **Auth model** | **OAuth 2.0** (token + refresh) against the GraphQL endpoint. Per-merchant token, refreshed; no PAT-paste like ShipBob/EasyPost. Closer to Shippo's OAuth model (C8). |
| **Multi-merchant story** | 3PL accounts manage multiple customers; queries scope by account/customer. A 3PL-billing surface (`fulfillment invoice`) exposes shipping items per order with `amount`, `shipping rate`, `processing fee`, `picking fee`, `overcharge fee`. |
| **Cost endpoint** | GraphQL `shipment` query → `shipping_labels { cost }`; or the **3PL billing / fulfillment-invoice** query for per-order shipping items. Sum `cost` across a shipment's labels (no consolidated shipment-level total field). |
| **Cost field** | `shipping_labels { cost }` (decimal). |
| **Order match-back field** | **Strong.** Shipment → `order_id`, and nested `order { partner_order_id, order_number }`. `partner_order_id` is the upstream (Shopify) order id → **direct match-back**, better than tracking. Also `shipping_labels { tracking_number, carrier, shipping_method }`. |
| **Adjustments / overcharge** | `overcharge fee` appears in the fulfillment-invoice items; whether a *carrier* APV-style adjustment flows back through `shipping_labels { cost }` or a separate invoice item is **unknown** → Part A spike applies to ShipHero too (treat like Shippo: confirm or defer). |
| **Webhooks** | ShipHero supports webhooks for fulfillment events; **cost is poll-via-GraphQL** (poll baseline). |
| **Pagination** | GraphQL cursor/`Connection` pattern (`pageInfo`, `after`) — note ShipHero's documented credit/throttle limits on heavy queries; page conservatively. |
| **`NormalizedShipmentCost` mapping** | `externalId` = label id (or shipment id + label index); `orderRef` = `order.partner_order_id` (fallback `order_number`); `trackingNo` = `shipping_labels.tracking_number`; `costCents` = `cost`×100; `currency` = account currency; `carrier` = `shipping_labels.carrier`; `shippedAt` = label/shipment created date. |

### B.3 — How each becomes a drop-in adapter (deltas only; framework is C1–C9)

For **each** of ShipBob and ShipHero, the work is the Phase-2-proven "implement the adapter + wire it" — **near-zero new framework** (contract §6 Phase 2 boundary):

1. **Adapter object** — new `app/lib/ship-cost/adapters/shipbob.ts` / `shiphero.ts` implementing `ShipCostAdapter` (C1): `provider`, `integrationKind`, and `connect(shopId)` returning a `ShipSource` whose `fetchCharges(since)` calls the cost endpoint above, paginates, and maps to `NormalizedShipmentCost[]`.
2. **Enum value (C7, §4)** — `integration_kind += 'shipbob_ship'` / `'shiphero_ship'`, **each in its own migration step** (a freshly-added enum value can't be used in the same txn — precedent `20260606120000_tiktok_platform.sql`). Names follow C9 (`<provider>_ship`).
3. **Provider id + type (C7)** — extend `ShipProvider`/`ShipIntegrationKind` unions (C1); add `'shipbob'`/`'shiphero'` to `IntegrationProvider` (`app/lib/calderyn.server.ts:65`) and the maps `PROVIDER_TO_KIND` / `KIND_TO_PROVIDER` (`app/lib/integrations.ts:41-45, 94-98`).
4. **Registry entry (C2)** — append `shipBobAdapter`, `shipHeroAdapter` to `SHIP_ADAPTERS` (`app/lib/ship-cost/adapters/registry.server.ts`); `shipAdaptersForShops` then selects these kinds with **no code change** (its `kind IN (...)` set grows).
5. **Connect mechanism (C8 — provider-specific, do not over-abstract):**
   - **ShipBob:** **merchant pastes a PAT** (`billing_read` scope) → stored encrypted in `integration_credentials.access_token_encrypted` (AES-256-GCM, `crypto.server.ts`), upsert on `(shop_id, kind)`. Same API-key pattern as EasyPost (C8) — a simple paste form, not OAuth.
   - **ShipHero:** **per-merchant OAuth** (token + refresh) — follow the `startOAuth` ladder (`calderyn.server.ts:992-1073`) + `auth.<provider>.$.tsx` + `consumeOAuthState`, like Shippo (Phase 2). Store + refresh the token in `integration_credentials`.
6. **Display constants — BOTH surfaces (C7, §7 parity):**
   - **Embedded** (`app/routes/app.settings.tsx`): the card list is kind-agnostic (`Object.entries(integrations).map(...<IntegrationCard/>)`, :543-545) — a new kind renders automatically once it's in the integrations record + display constants. `IntegrationCard` (:849-917) shows Connect/Disconnect; ShipBob's PAT-paste needs a small **key-entry variant** of the connect affordance (ShipHero's OAuth reuses the existing `connect_integration` → `redirectUrl` flow at :316-333).
   - **Dashboard** (`app/components/dashboard/screens/Settings.tsx:380-401`): **read-only status pills** only (":383 connect/disconnect lives in the embedded app"). Parity = add the kind to the defaults map (`calderyn.server.ts:960-966`) + `INTEGRATION_DISPLAY_NAME` / `INTEGRATION_LOGO_CLS` / `INTEGRATION_ORDER`. New kind then auto-renders via `integrations.list` → `adaptIntegrations`.

**Verdict on true cost (the asked question):** **Both ShipBob and ShipHero DO expose true per-order ship cost** — ShipBob via Billing `amount` (`reference_type=Shipment`), ShipHero via `shipping_labels { cost }` with a strong `partner_order_id` match-back. Neither is a Shopify-style dead end. The only asterisk is ShipHero's community-reported zero-`cost` config, which B.3 step-0 (a read-only confirmation call per onboarded account) must verify before claiming `actual_invoice` confidence.

---

## 5. Part C — Unmatched-charge surfacing (both surfaces)

Hardens C4.6 / §5 #2 from "unmatched rows land but are only counted" into a real merchant surface. The landing path **already** inserts `matched_order_id = NULL` rows (C4.6, mirrors the CSV path) — Part C makes them **visible and resolvable**, never silently dropped (rule 12).

### C.1 — Data contract (shared by both surfaces)

A small server reader (new, in `app/lib/ship-cost/` — e.g. `unmatched.server.ts`, **not** inline in a route) returns, per shop:

```
UnmatchedCharges {
  count: number;                       // COUNT(*) shipping_invoice_line WHERE shop_id=? AND matched_order_id IS NULL
  items: Array<{
    id: string;                        // shipping_invoice_line.id
    provider: string;                  // derived from the synthetic period.carrier (source='connector')
    orderRef: string | null;           // the unmatched provider ref we couldn't resolve
    trackingNo: string | null;
    costCents: number;
    currency: string;
    shippedAt: string | null;
    reason: "no_ref" | "no_tracking_match" | "carrier_adjustment_no_link"; // why it didn't match (rule 12 visibility)
  }>;
}
```

- **Read-only, service-role** (the cron/server already uses the service-role key; `shipping_invoice_line` is deny-by-default RLS, §4 — keep it that way; do **not** add a merchant-facing RLS policy).
- The dashboard re-implements this read against its **own** stack (raw `postgres`/`withShopContext`) — **match the contract, not the code** (§7).

### C.2 — Embedded app (`app/routes/app.settings.tsx`) — interactive

Slots into the existing `ShippingCostSection` (already in this file, :919+) as a sibling block under the integrations/CSV area, using **Polaris** primitives (repo rule — no Lucide here):

- **Count banner:** when `count > 0`, a Polaris `Banner` tone="warning": "N carrier charges couldn't be matched to an order." (When 0, render nothing — no empty-state noise.)
- **List:** a Polaris `ResourceList`/`IndexTable` of the items (provider, tracking, cost, reason).
- **Resolve action (the new mutation):** per row, a "Map to order" control — an `Autocomplete`/`TextField` to type an order number → submits a new action `intent="map_ship_charge"` carrying `{ lineId, orderNumber }`. The action:
  1. validates the order belongs to the shop (resolve `order_number` → `order_fact.id` for `shop_id`),
  2. sets `shipping_invoice_line.matched_order_id`,
  3. **re-aggregates** if that order now has multiple lines (dodge last-write-wins, C4.3),
  4. calls `runShipCostResolution(...)` so the order flips to `actual_invoice`,
  5. returns `redirect()` (avoid double-submit, repo rule) + a toast.
- Validate `FormData` at the action boundary (repo rule); surface failure (unknown order → visible error, not a swallow).

### C.3 — Dashboard (`app/components/dashboard/screens/Settings.tsx`) — read-only

Per the dashboard's established contract (":383 connect/disconnect lives in the embedded app"), the dashboard is **status read-only** — so unmatched charges appear as an **informational count + list**, **no resolve action**:

- A new read-only block in the **Connections** section (or a sibling section), using the dashboard's own primitives (`Card`, `SettingRow`, `Pill` — **not** Polaris): "N unmatched carrier charges — resolve in the embedded app." with the same list (provider/tracking/cost/reason) shown read-only.
- Sourced from the dashboard's own `withShopContext` query implementing the C.1 contract.
- This mirrors how integrations themselves are read-only on the dashboard — same split, no redesign (§7).

---

## 6. Schema deltas

Via `prisma migrate` / Supabase migrations; never hand-edit applied migrations (§4). RLS stays service-role-only on `shipping_invoice_line` / `shipping_cost_period`.

| Δ | Required? | Migration |
|---|---|---|
| `integration_kind += 'shipbob_ship'` | **Yes** (Part B) | `ALTER TYPE public.integration_kind ADD VALUE 'shipbob_ship';` — own migration step |
| `integration_kind += 'shiphero_ship'` | **Yes** (Part B) | same pattern, own step |
| **Reconciliation column** `shipping_invoice_line.external_charge_id` + unique `(shop_id, external_charge_id)` | **CONDITIONAL — only if the spike (A.1) shows delete-by-keyset is insufficient** for stable adjustment overwrite (e.g. tracking proves non-unique, or YES-strong link needs a true `onConflict`). This is the contract's pre-flagged optional line-table change (§4 "1?", C4.4). **Do not add pre-spike.** | `ALTER TABLE shipping_invoice_line ADD COLUMN external_charge_id text; CREATE UNIQUE INDEX ... ON (shop_id, external_charge_id);` |
| Adjustment **reason/audit** columns (e.g. `adjustment_reason`, `claimed_cents`/`captured_cents`) | **CONDITIONAL — only if** the unmatched-`reason` (Part C) or adjustment delta needs persisting beyond display. Prefer deriving in the reader; add columns only if the spike shows the delta must be stored to compute the new total. | `ALTER TABLE shipping_invoice_line ADD COLUMN ...` (own migration) |

**No unconditional line/period table change in Phase 3.** The synthetic-period mechanism (C4) + delete-by-keyset already cover the common case; the conditional columns exist only as escape hatches the **spike** may force. (Part C's `reason` is derivable from match state — kept out of the schema unless proven needed.)

---

## 7. Files to add / change

**Add:**
- `app/lib/ship-cost/adapters/shipbob.ts` — ShipBob `ShipCostAdapter` (B.1/B.3).
- `app/lib/ship-cost/adapters/shiphero.ts` — ShipHero `ShipCostAdapter` (B.2/B.3).
- `app/lib/ship-cost/unmatched.server.ts` — unmatched-charges reader (C.1).
- `app/routes/auth.shiphero.$.tsx` — ShipHero OAuth callback (mirrors Shippo/Phase 2; ShipBob needs **no** OAuth route — PAT paste).
- Migrations: `..._integration_kind_shipbob_ship.sql`, `..._integration_kind_shiphero_ship.sql` (each one `ADD VALUE`). Conditional: `..._ship_invoice_line_external_charge_id.sql` (spike-gated, §6).
- Tests (see §9).

**Change:**
- `app/lib/ship-cost/adapters/registry.server.ts` — append `shipBobAdapter`, `shipHeroAdapter` to `SHIP_ADAPTERS` (C2).
- `app/lib/ship-cost/adapters/adapter.ts` — extend `ShipProvider`/`ShipIntegrationKind` unions (C1).
- `app/lib/ship-cost/adapters/land.server.ts` — **Part A overwrite logic** (branch per spike outcome; widen the adjustment re-pull window).
- `app/lib/calderyn.server.ts` — `IntegrationProvider` (:65) += `shipbob`/`shiphero`; defaults map (:960-966) += two kinds; `startOAuth` ladder (:992-1073) += ShipHero; `INTEGRATION_DISPLAY_NAME`/`INTEGRATION_LOGO_CLS`/`INTEGRATION_ORDER` (the §C7 dashboard display constants).
- `app/lib/integrations.ts` — `PROVIDER_TO_KIND` (:41-45) + `KIND_TO_PROVIDER` (:94-98); `OAUTH_PROVIDERS` (:13) += `shiphero` (ShipBob is **not** OAuth — keep it off this list, or `IntegrationCard` will render an OAuth Connect for a PAT provider). **⚠️ This is a real wiring subtlety: ShipBob is key-paste, so `isConnectable`/`canConnect` (:874) must NOT treat it as an OAuth Connect — add a key-entry affordance instead.**
- `app/routes/app.settings.tsx` — unmatched block + `map_ship_charge` action (C.2); ShipBob PAT-paste connect variant in/around `IntegrationCard` (:849-917).
- `app/components/dashboard/screens/Settings.tsx` — read-only unmatched block (C.3); the kind auto-renders once display constants are set.
- `.env.example` — any ShipHero OAuth client id/secret keys (secrets themselves in `.env.local` only, repo rule).

---

## 8. Step-by-step plan (spike FIRST, gated)

1. **SPIKE (A.1) — blocking gate.** Run the EasyPost + Shippo (+ ShipHero overcharge) live calls; produce the per-provider Q-LINK finding (strong/weak/NO, link field, total-vs-delta, webhook strings). **No reconciliation code until this lands.** If a provider = NO, mark its reconciliation deferred (A.4) and proceed with the others.
2. **Part B adapters (parallel to spike write-up — they don't depend on it).** ShipBob first (PAT, simplest, mirrors EasyPost), then ShipHero (OAuth). For each: adapter object → enum migration → provider/type/maps → registry entry → connect mechanism → both-surface display constants. Gate each behind a **read-only confirmation call** that `cost`/`amount` is actually populated for a real account (esp. ShipHero zero-`cost` caveat).
3. **Part A reconciliation (gated on step 1).** Implement the overwrite branch the spike selected in `land.server.ts`; widen the re-pull window to the carrier SLA; confirm the existing post-land `runShipCostResolution` call re-resolves. Add the conditional `external_charge_id` column **only if** step 1 demanded it.
4. **Part C surfacing.** `unmatched.server.ts` reader → embedded interactive block + `map_ship_charge` action → dashboard read-only block. Wire `reason` from match state.
5. **Tests (§9).** 6. **Pre-commit gate** (typecheck/lint/build, prisma validate + migrate diff for the new migrations, `/code-review`) per repo CLAUDE.md — show results, never assert green. 7. **Dashboard parity check (§11).** 8. Worktree per feature (repo rule), auto-commit only after the gate is green.

---

## 9. Tests (behavior, not coverage theater — rule 9)

- **A — adjustment overwrites + re-resolves (the central test).** Fixture: order O; land original label charge (cost 1000); assert `order_fact.ship_cost_cents=1000`, source `actual_invoice`. Then land an adjustment for the same shipment (settled total 1250) in the re-pull window; assert the line is **overwritten** (exactly one line for O, `cost_cents=1250`, **not** 2250) and `order_fact.ship_cost_cents=1250` after the post-land `runShipCostResolution`. **Delta variant:** if the spike says rows carry deltas, drive original 1000 + delta +250 and assert the line resolves to 1250 (sum), guarding the §A.4 #5 sum-vs-replace point.
- **A — degraded branch.** An adjustment with no link (NO branch) lands as **unmatched** with `reason="carrier_adjustment_no_link"`, does **not** alter any order's cost, and appears in the Part C reader.
- **B — 3PL mapping.** ShipBob fixture transaction (`amount`, `reference_id`→shipment→order ref) maps to `NormalizedShipmentCost` and lands ≥1 matched line resolving to `actual_invoice`. ShipHero fixture (`shipping_labels{cost}`, `partner_order_id`) same. **Zero-cost guard:** a ShipHero label with `cost=0`/null does **not** land a bogus 0 `actual_invoice` (it should be skipped/surfaced, not asserted as true cost).
- **B — registry generality (C1).** Adding the adapters changes **no** generic-core file; `shipAdaptersForShops` picks up the new kinds with no code edit (assert the kind set drives selection).
- **C — unmatched surface + resolve.** Reader returns the right `count`/items for NULL-matched rows. `map_ship_charge` with a valid order number sets `matched_order_id`, re-aggregates, re-resolves (order flips to `actual_invoice`), count decrements; an **unknown** order number returns a visible error and changes nothing (rule 12).
- **C — pre-aggregation on resolve.** Mapping a charge to an order that already has a line produces **one** summed/overwritten line, not two (last-write-wins guard).

---

## 10. Risks & open questions

1. **(LEAD) Adjustment link-back is unconfirmed until the spike.** Q-LINK gates the entire Part A design. EasyPost is *likely* YES-strong (doc lead: `Shipment ID`/`Tracking Code` columns), **Shippo is genuinely unknown** (beta API, schema not public), ShipHero overcharge flow unknown. **Until the spike: `actual_invoice` = at-purchase cost; adjustments surfaced, not auto-reconciled.**
2. **Delta-vs-total semantics** (A.4 #2/#5) — the subtlest correctness point; wrong choice double-counts or loses the original. Spike must report it; test guards it.
3. **Late adjustments outside the re-pull window** — may need manual re-pull; widen window to carrier SLA, accept residual.
4. **ShipHero zero-`cost` configs** (community-reported) — confirm `cost` is populated per onboarded account before claiming `actual_invoice`; else degrade to modeled/unmatched.
5. **ShipBob ≠ OAuth** — PAT-paste must not be wired as an OAuth Connect (`isConnectable`/`OAUTH_PROVIDERS`); needs a key-entry affordance (§7).
6. **Match rate when provider lacks order ref** (§5 #2) — ShipBob/ShipHero both carry strong refs (`reference_id` / `partner_order_id`), so match rate should beat the tracking-only providers; quantify per account.
7. **Webhook path collisions** (deferred webhooks) — registering EasyPost `report.available` must avoid the Vercel function-path 501 trap (`551dabf`, `b486895`).
8. **`shopCountry` stub** (§5 #4) — unchanged; reconciliation doesn't touch allocation, so it's not a Part A concern, but the post-land `runShipCostResolution` still passes `null` and degrades zone allocation gracefully.

---

## 11. Dashboard parity checklist (mandatory, §7 / repo CLAUDE.md)

- [ ] **ShipBob** kind added to dashboard display constants (`calderyn.server.ts:960-966` defaults + `INTEGRATION_DISPLAY_NAME`/`INTEGRATION_LOGO_CLS`/`INTEGRATION_ORDER`) → auto-renders read-only in `Settings.tsx:380-401`.
- [ ] **ShipHero** kind added to the same constants.
- [ ] **Unmatched-charge block** mirrored on the dashboard **read-only** (`Settings.tsx`), implementing the C.1 contract against the dashboard's own `withShopContext`/`postgres` stack — **match the contract, not the Polaris code.**
- [ ] Connect/disconnect stays **embedded-only** (dashboard shows status + unmatched count read-only) — no OAuth/PAT UI ported to the dashboard.
- [ ] No surface implies universal coverage (§5 #3) — unmatched count + the partial-coverage framing intact on both.
- [ ] If only one side can ship in a given change, say so + leave a TODO (never silently single-sided).

---

## 12. Out of scope / deferred

- **Webhook-driven reconciliation** (EasyPost `report.available`/`ShipmentInvoice`) — poll baseline ships first (A.3); webhooks are a latency optimization, deferred.
- **Shippo invoice webhooks** — none exist (beta) → Shippo adjustments are poll-only by necessity, not a choice to revisit.
- **ShipBob OAuth multi-channel** read-across — Phase 3 uses per-merchant PAT; the channel-app model is a future enhancement.
- **Providers beyond ShipBob/ShipHero** (Deliverr/Flexport, other 3PLs; direct carrier accounts UPS/FedEx/USPS per §1) — future adapters, same drop-in pattern.
- **EasyPost Forge sub-accounts** (C8 note) — a different product (provisions new accounts, changes label-buying workflow); not the read-only cost-connector path.
- **Anything in Phase 1/2** (framework C1–C9, EasyPost/Shippo adapters, the invoice tier, allocation math) — frozen, not re-touched here.
- **Conditional schema columns** (`external_charge_id`, adjustment audit columns) unless the spike forces them (§6).
