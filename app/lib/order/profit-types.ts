// app/lib/order/profit-types.ts
// Browser-safe DTO for the per-order profit read model (Phase 4 Task 3). Plain types only — no
// imports from .server files — mirroring detail-types.ts/returns-types.ts.

export interface OrderProfit {
  source: "calderyn" | "shopify";
  /** total_cents minus ledger refunds already issued, floored at 0. Never null — a paid order
   *  always has a known total. */
  revenueCents: number;
  /** Sum of (effective qty x unit_cost_cents_snapshot) across every line that HAS a cost
   *  snapshot. A line with no snapshot is excluded here, never assumed 0 — see costsMissing. */
  cogsCents: number;
  /** Count of lines excluded from cogsCents because they carry no cost snapshot. 0 means COGS is
   *  complete for every line on this order. */
  costsMissing: number;
  /** Sum of shipping_invoice_line.cost_cents rows matched to this order's order_fact row. Null
   *  when no order_fact row was found, or it was found but has zero matched invoice lines — "no
   *  carrier cost recorded," never a fabricated 0. A recorded sum of exactly 0 is a real fact and
   *  stays 0, distinct from null. */
  carrierCostCents: number | null;
  /** Always an ESTIMATE: 2.9% of the captured amount + 30 cents per capture. No real per-order
   *  processor-fee data exists anywhere in this schema (application_fee_cents is Calderyn's own
   *  commission, never a processing fee, and is never read for this). */
  feeEstimateCents: number;
  /** revenueCents - cogsCents - (carrierCostCents ?? 0) - feeEstimateCents. Never null: an
   *  unmatched carrier cost or an incomplete COGS is treated as its best-known partial value
   *  (0-for-the-gap) rather than blocking the whole calculation — costsMissing and a null
   *  carrierCostCents are how the UI flags "this number is partial," not a null profitCents. */
  profitCents: number;
  /** profitCents / revenueCents * 100. Null ONLY when revenueCents is 0 (undefined ratio) — a
   *  margin is still computed when costs are incomplete or the carrier is unmatched, same
   *  partial-value reasoning as profitCents. */
  marginPct: number | null;
  /** Always true today: feeEstimateCents is always a label-only estimate (no real fee source
   *  exists anywhere), so every order's profit figure carries at least one estimated component.
   *  Kept as an explicit field (rather than a hardcoded UI string) so a future real-fee source can
   *  flip it to false without a DTO shape change. */
  estimated: boolean;
  /** Best-effort campaign/channel/source label from the order's captured attribution. Null for
   *  every imported (Shopify-paid) order — Calderyn never captured attribution for a sale made on
   *  Shopify. */
  attributionLabel: string | null;
}
