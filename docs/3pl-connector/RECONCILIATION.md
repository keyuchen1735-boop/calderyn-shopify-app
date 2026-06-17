# Part A — Carrier-adjustment reconciliation: status & analysis

> Phase 3, Part A. Implements **contract §6c** against the frozen spine (`00-overview-and-contract.md`)
> and the Phase-3 plan (`03-phase-3-reconciliation-and-3pl.md` §3). **This part is spike-gated.**
> This document records (1) what already works without new code, (2) what is scaffolded but
> spike-pending, and (3) the live spike that gates the rest. It deliberately does **not** present
> any unverified reconciliation behavior as done (rule 12).

## TL;DR (honest status)

| Case | Status | Evidence |
|---|---|---|
| **Adjustment REUSES the original `externalId`** (same shipment/charge id) | **DONE — no new code needed.** Phase-1 idempotent landing already overwrites it with the settled cost. | `land.server.ts:264-277` (verified, quoted below) + the source-priority runner pass. |
| **Adjustment carries a NEW id but LINKS BACK** (shipment id / tracking / ref) | **Spike-pending.** The link FIELD is unconfirmed (contract §5 #1). Scaffolding is described below; no overwrite code is written until the spike returns Q-LINK. | — |
| **Adjustment has NO link** (orphan dollar amount) | **Already handled, degraded.** Lands as an unmatched charge (Part C), surfaced + merchant-resolvable, never summed onto an arbitrary order. | `land.server.ts` unmatched path + `unmatched.server.ts` (Part C). |
| **Live API spike** (EasyPost + Shippo + ShipHero overcharge) | **Open follow-up.** No prod creds in this environment. | Plan 03 §A.1. |

---

## 1. The same-id case already reconciles (verified, zero new code)

The cron re-pulls a **trailing window** every tick (contract C3: "carrier costs settle/adjust
post-ship → re-pull"). When a carrier adjusts a charge and the provider re-emits it **under the
same stable id**, the re-pull carries the *settled* amount on a row whose `externalId` equals the
original's. Phase-1 landing is a **delete-by-`external_charge_id`-then-insert** within the window
key-set — so the existing line is deleted and re-inserted with the new cost. This is an **overwrite,
not a second summed line**, which is mandatory because the resolver is last-write-wins / not summed.

Verified in `app/lib/ship-cost/adapters/land.server.ts` (lines 264-277):

```ts
// Idempotent replace: delete every existing line under THIS period whose
// external_charge_id is in this sync's window, then insert the freshly computed rows.
if (windowExternalIds.length > 0) {
  const del = await sb
    .from("shipping_invoice_line")
    .delete()
    .eq("period_id", periodId)
    .in("external_charge_id", windowExternalIds);
  if (del.error) throw del.error;
}
const allLines = [...matchedLines, ...unmatchedLines];
if (allLines.length > 0) {
  const ins = await sb.from("shipping_invoice_line").insert(allLines);
  if (ins.error) throw ins.error;
}
```

Then the cron's existing post-land `runShipCostResolution` re-reads the line and re-resolves the
order — **no new re-trigger invented** (contract A.2 "land the overwrite inside the existing
post-land resolution call — zero resolver change"). The order's `ship_cost_cents` /
`ship_cost_source='actual_invoice'` reflect the settled amount on the very next pass.

**Phase-3 hardening that makes this even safer:** the source-priority runner change
(`runner.server.ts`, committed in Part 1 of this phase) guarantees that even if a stray
upload/typed line co-exists for the same order, the **connector** line (the real per-shipment
carrier charge, now possibly adjusted) wins deterministically — `connector > upload > typed`.

**Requirements for this case to hold (all currently true):**
1. The provider re-emits the adjusted charge under the **same `externalId`** (the spike confirms
   this per provider — for ShipBob the plan notes adjustments arrive as further transactions with
   the same `reference_id`, B.1).
2. The re-pull **window is ≥ the carrier adjustment SLA** so the adjustment falls inside it. USPS
   APV can land weeks later → the connector's `since` window must be widened to ~30-45 days for
   providers that surface late adjustments. **This widening is a per-adapter `since` choice made in
   the cron** (C3) and is independent of this overwrite mechanism; it is called out as an open
   tuning item (§4) rather than hard-coded here, because the right width is provider-specific and
   the spike informs it.

> Net: for the **same-id** adjustment path, Part A is **complete with no new landing code** — the
> Phase-1 delete-by-keyset + the Phase-3 source-priority runner already produce the settled cost.

---

## 2. New-id-with-link-back — scaffolding, spike-pending (NO overwrite code written)

If a provider emits an adjustment under a **new** id that *references* the original
shipment/transaction (or carries the original tracking), the same-id overwrite (§1) does **not**
fire, because the new row's `externalId` is not in the original's key-set. Closing this needs the
spike's **Q-LINK** answer (contract §A.1): *does the adjustment row carry a field identifying the
original shipment/label/transaction, or failing that the original tracking number?*

This is **not implemented** — writing it before the spike would be guessing at a field name and at
delta-vs-total semantics (the single subtlest correctness point, plan A.4 #5). The clean structural
shape it will take, once Q-LINK returns, is:

- **Branch YES-strong (link by shipment/transaction id).** Map the adjustment's link field to the
  original charge's `externalId` (or resolve the original line by it) and **re-key the adjustment to
  that line** so the existing delete-by-keyset overwrites it in place. The adapter's
  `NormalizedShipmentCost` already exposes `externalId`; the *only* new surface is a per-adapter step
  that sets the adjustment's effective key to the *original's* id. **No generic-core change** — it
  lives behind `fetchCharges()` like every other provider specific.
- **Branch YES-weak (tracking only).** No code needed beyond what exists: `matchInvoiceLines`
  already does tracking-number fallback, so an adjustment carrying the original tracking re-matches
  to the same order and the delete-by-keyset overwrites — **provided** the adjustment's own
  `externalId` collides with the original's, which YES-weak does not guarantee. If it does not, the
  adjustment lands as a *second* line for the order; the **source-priority runner still resolves
  deterministically** (it picks one connector line, not the sum) but the *non-winning* line is
  stale. Whether that needs an explicit same-order de-dup at land time is a **spike+test decision**,
  not a guess — flagged, not coded.
- **Delta vs total.** If the spike says adjustment rows carry only a **delta** (not the new total),
  the YES-strong branch must read `original + Σdeltas`; the pre-aggregation (C4.3) already sums
  per-order lines, so a delta that maps to the same order sums correctly **iff** it is genuinely a
  delta. If it is a **new total**, summing double-counts. The branch must pick sum-vs-replace from
  the spike's amount-semantics finding. **No code commits to either until the spike reports which.**

**Conditional schema (§6 of the plan):** a `UNIQUE (shop_id, external_charge_id)` index / a true
`onConflict` upsert, and any adjustment-audit columns, are added **only if** the spike shows
delete-by-keyset is insufficient. The `external_charge_id` column already ships (Phase 1), so that
later index needs **zero backfill**. **Not added pre-spike.**

---

## 3. The live spike (the gate) — explicit follow-up, NOT done here

Per Plan 03 §A.1, the spike answers **Q-LINK** per provider with a real prod key against real
post-purchase adjustments (test-mode does not produce carrier adjustments). It is **not run in this
environment — no prod API credentials are available here.** Until it runs:

- `actual_invoice` remains the **at-purchase** label cost (Phase 1/2/3-Part-B behavior).
- Same-id adjustments **do** reconcile automatically (§1).
- New-id adjustments either reconcile via tracking (YES-weak, if `externalId` happens to collide) or
  surface as unmatched (NO link, Part C) — never silently summed.

**Spike checklist (carried from Plan 03 §A.1, unchanged):**
- **EasyPost:** `POST /v2/reports/shipment_invoice` with explicit `additional_columns`; inspect an
  adjustment row for `Shipment ID` (populated?), `Tracking Code`, `Reference`, `Package Dispute ID`,
  and original-vs-adjusted amount columns. Cross-check `payment_log` / `refund` reports. Pin the
  webhook event strings (`report.available` modern / `ShipmentInvoice` legacy).
- **Shippo:** `ListInvoiceItems` (beta Invoices API) — inspect a refund/adjustment item for an
  `object_id`/`transaction`/`shipment` ref, `tracking_number`, echoed `Transaction.metadata`, the
  item `type` enum, and amount sign/semantics. (Schema is beta + not publicly confirmable → the
  spike is the only way to answer Q-LINK for Shippo.)
- **ShipHero (Part B caveat):** confirm whether a carrier APV-style adjustment flows back through
  `shipping_labels { cost }` or a separate fulfillment-invoice `overcharge fee` item, and whether the
  zero-`cost` config affects adjustments. Treat like Shippo — confirm or defer.

**Deliverable:** a one-page per-provider finding (Q-LINK strong/weak/NO, the exact link field,
total-vs-delta, webhook/poll story). **That finding gates §2.**

---

## 4. Open items (surfaced, not buried — rule 12)

1. **Re-pull window width vs carrier SLA.** The same-id overwrite (§1) only catches an adjustment
   that falls **inside** the re-pull window. Late USPS APV can exceed a 30-day window → widen the
   per-adapter `since` to the carrier SLA (~30-45d) when wiring each provider's cron call; a
   very-late adjustment may still need a manual re-pull. Not hard-coded here — provider-specific,
   spike-informed.
2. **Webhooks deferred.** Poll is the baseline and is sufficient (plan A.3). EasyPost
   `report.available` / `ShipmentInvoice` and Shippo (no invoice webhook exists) are a latency
   optimization, deferred (plan §12). Registering an EasyPost webhook route must avoid the Vercel
   function-path 501 trap (commits `551dabf`, `b486895`).
3. **Delta-vs-total** is the subtlest correctness point (plan A.4 #5) — guarded by a spike finding
   and a test, never by assumption.
