// Landing pipeline for normalized ship-cost charges (contract C4). Provider-blind:
// takes NormalizedShipmentCost[] from any adapter and lands them as
// shipping_invoice_line rows under a single synthetic per-(shop, provider) period
// (source='connector'), so the existing resolver reads matched orders as
// actual_invoice / high. Adapts ingestInvoiceCsv (inputs.server.ts:46-109) with three
// connector-specific behaviors:
//   - get-or-create ONE synthetic period (idempotent via the partial unique index),
//   - land ONE LINE PER CHARGE (matched lines carry matched_order_id; the per-order SUM
//     happens in the resolver, runner.server.ts, which reads ALL lines with no window —
//     so it is always correct even when an order's charges straddle re-pull windows),
//   - idempotent delete-by-(period_id, external_charge_id set) then insert, so a
//     trailing-window re-pull never duplicates rows.
// Every line — matched or unmatched — is keyed by its own stable external_charge_id, so
// the window-scoped delete only ever touches charges whose date falls in that window;
// there is no cross-window straddle to miss. Unmatched charges (no order) still land
// (matched_order_id NULL) and are surfaced, never dropped (rule 12).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { MatchOrder } from "../match";
import type { NormalizedShipmentCost, ShipProvider } from "./adapter";

// match.ts's normalization rule, mirrored exactly (C5 — match.ts itself is unchanged).
// A parity test (land.test.ts) asserts matchCharge agrees with matchInvoiceLines so the
// two implementations can never silently drift.
function normRef(ref: string): string {
  return ref.replace(/^#/, "").trim().toLowerCase();
}

interface MatchIndex {
  byOrderRef: Map<string, string>;
  byTracking: Map<string, string>;
}

function buildMatchIndex(orders: MatchOrder[]): MatchIndex {
  const byOrderRef = new Map<string, string>();
  const byTracking = new Map<string, string>();
  for (const o of orders) {
    byOrderRef.set(normRef(o.orderNumber), o.id);
    for (const t of o.trackingNos) byTracking.set(t.trim().toLowerCase(), o.id);
  }
  return { byOrderRef, byTracking };
}

/** Order-ref match first, then tracking-number fallback — identical to matchInvoiceLines. */
function matchCharge(c: NormalizedShipmentCost, index: MatchIndex): string | null {
  let id: string | undefined;
  if (c.orderRef) id = index.byOrderRef.get(normRef(c.orderRef));
  if (!id && c.trackingNo) id = index.byTracking.get(c.trackingNo.trim().toLowerCase());
  return id ?? null;
}

// The synthetic connector period is fenced out of allocation (C6); period_start/end
// are cosmetic only. Use a wide sentinel so it never constrains anything.
const SENTINEL_PERIOD_START = "1970-01-01";
const SENTINEL_PERIOD_END = "2999-12-31";

export interface LandResult {
  /** Matched charges that landed as their own line (one per charge, matched_order_id set). */
  matchedLineCount: number;
  /** Charges that matched no order and landed with matched_order_id NULL. */
  unmatchedCount: number;
  /** Charges skipped because they carried no usable key (no tracking AND no order ref). */
  skippedNoKeyCount: number;
  /** Charges dropped as duplicate externalId within this pull (surfaced, not summed). */
  duplicateExternalIdCount: number;
  /** Σ cost_cents of all lines now under the synthetic period. */
  totalCents: number;
}

/** One landed row, ready to insert. Mirrors the CSV insert shape + external_charge_id. */
interface InvoiceLineInsert {
  shop_id: string;
  period_id: string;
  order_ref: string | null;
  tracking_no: string | null;
  cost_cents: number;
  matched_order_id: string | null;
  external_charge_id: string | null;
}

/**
 * Get-or-create the synthetic (shop, provider) period. Race-safe: the partial unique
 * index shipping_cost_period_connector_uidx (shop_id, carrier) WHERE source='connector'
 * means a concurrent insert conflicts; on any insert error we re-select the winner.
 * Surfaces a genuinely missing row (rule 12) rather than returning a null id silently.
 */
async function ensureConnectorPeriod(
  sb: SupabaseClient,
  shopId: string,
  provider: ShipProvider,
): Promise<string> {
  const existing = await sb
    .from("shipping_cost_period")
    .select("id")
    .eq("shop_id", shopId)
    .eq("source", "connector")
    .eq("carrier", provider)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) return String(existing.data.id);

  const inserted = await sb
    .from("shipping_cost_period")
    .insert({
      shop_id: shopId,
      period_start: SENTINEL_PERIOD_START,
      period_end: SENTINEL_PERIOD_END,
      carrier: provider,
      total_cents: 0,
      source: "connector",
    })
    .select("id")
    .single();
  if (!inserted.error && inserted.data?.id) return String(inserted.data.id);

  // Insert lost a race (unique-index conflict) or otherwise failed — re-select the
  // row that won. If it's still absent, the failure is real: surface it.
  const reselect = await sb
    .from("shipping_cost_period")
    .select("id")
    .eq("shop_id", shopId)
    .eq("source", "connector")
    .eq("carrier", provider)
    .maybeSingle();
  if (reselect.error) throw reselect.error;
  if (reselect.data?.id) return String(reselect.data.id);
  throw inserted.error ?? new Error(`failed to ensure connector period for ${shopId}/${provider}`);
}

/** Load the shop's orders (+ fulfillment tracking) for matching, mirroring the CSV path. */
async function loadMatchOrders(sb: SupabaseClient, shopId: string): Promise<MatchOrder[]> {
  const ordersRes = await sb
    .from("order_fact")
    .select("id, order_number")
    .eq("shop_id", shopId);
  if (ordersRes.error) throw ordersRes.error;
  const fulfillsRes = await sb
    .from("fulfillment_fact")
    .select("order_id, tracking_no")
    .eq("shop_id", shopId);
  if (fulfillsRes.error) throw fulfillsRes.error;

  const trackingByOrder = new Map<string, string[]>();
  for (const f of (fulfillsRes.data ?? []) as { order_id: string | null; tracking_no: string | null }[]) {
    if (!f.order_id || !f.tracking_no) continue;
    const list = trackingByOrder.get(f.order_id) ?? [];
    list.push(String(f.tracking_no));
    trackingByOrder.set(f.order_id, list);
  }
  return ((ordersRes.data ?? []) as { id: string; order_number: string | null }[]).map((o) => ({
    id: o.id,
    orderNumber: String(o.order_number ?? ""),
    trackingNos: trackingByOrder.get(o.id) ?? [],
  }));
}

/**
 * Land normalized charges for one shop/provider. Idempotent per the re-pull window:
 * re-running with the same charges leaves row counts unchanged.
 */
export async function landShipmentCharges(
  sb: SupabaseClient,
  shopId: string,
  provider: ShipProvider,
  charges: NormalizedShipmentCost[],
): Promise<LandResult> {
  const periodId = await ensureConnectorPeriod(sb, shopId, provider);

  // Keep one charge per externalId. A provider (or a paginated pull) could echo the
  // same shipment twice; without dedup we would land its cost twice as two rows with the
  // same external_charge_id and the delete-by-keyset couldn't tell them apart. externalId
  // is the idempotency key, so a later occurrence simply replaces the earlier (same id,
  // same charge). Surfaced via the tally (rule 12) rather than silently double-landed.
  const usable: NormalizedShipmentCost[] = [];
  const seenExternalIds = new Set<string>();
  let skippedNoKeyCount = 0;
  let duplicateExternalIdCount = 0;
  for (const c of charges) {
    // A charge with neither a tracking number nor an order ref can't be keyed for the
    // idempotent delete-and-replace (and can't match an order) — surface it as skipped
    // rather than landing an un-replaceable orphan.
    if (!c.trackingNo && !c.orderRef) {
      skippedNoKeyCount++;
      continue;
    }
    if (seenExternalIds.has(c.externalId)) {
      duplicateExternalIdCount++;
      continue;
    }
    seenExternalIds.add(c.externalId);
    usable.push(c);
  }
  // The window key-set is exactly the usable charges' ids (deduped above).
  const windowExternalIds = usable.map((c) => c.externalId);

  const matchOrders = await loadMatchOrders(sb, shopId);

  // matchCharge applies match.ts's EXACT rule — order-ref first (leading '#' stripped,
  // trimmed, lowercased), then tracking-number fallback — against maps built ONCE
  // (O(orders), not per charge). match.ts is unchanged (C5); a parity test pins
  // matchCharge to matchInvoiceLines so the two can never drift (§tests).
  const matchIndex = buildMatchIndex(matchOrders);

  // Land ONE LINE PER CHARGE. A matched charge carries matched_order_id; an unmatched one
  // carries null. Both are keyed by their OWN external_charge_id, so each charge appears
  // only in re-pull windows covering its ship date — no cross-window straddle. The per-
  // order SUM is deferred to the resolver (runner.server.ts), which reads ALL connector
  // lines with no window and is therefore always correct (the idempotency fix).
  const matchedLines: InvoiceLineInsert[] = [];
  const unmatchedLines: InvoiceLineInsert[] = [];

  for (const c of usable) {
    const orderId = matchCharge(c, matchIndex);
    (orderId ? matchedLines : unmatchedLines).push({
      shop_id: shopId,
      period_id: periodId,
      order_ref: c.orderRef,
      tracking_no: c.trackingNo,
      cost_cents: c.costCents,
      matched_order_id: orderId,
      external_charge_id: c.externalId,
    });
  }

  // Idempotent replace: delete every existing line under THIS period whose
  // external_charge_id is in this sync's window, then insert the freshly computed
  // rows. Rows outside the window (older shipments) are untouched → re-pull neither
  // duplicates nor wipes history. external_charge_id is the stable key (contract §8.2):
  // tracking_no can change mid-window (label re-print), the shipment id cannot.
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

  // Recompute the synthetic period total = Σ all its lines (honest; fenced from
  // allocation by C6). Read back every line under the period — the window-scoped
  // delete leaves out-of-window history in place, so we sum the table, not just this
  // sync's rows.
  const linesRes = await sb
    .from("shipping_invoice_line")
    .select("cost_cents")
    .eq("period_id", periodId);
  if (linesRes.error) throw linesRes.error;
  const totalCents = ((linesRes.data ?? []) as { cost_cents: number }[]).reduce(
    (s, l) => s + (l.cost_cents ?? 0),
    0,
  );
  const upd = await sb
    .from("shipping_cost_period")
    .update({ total_cents: totalCents, updated_at: new Date().toISOString() })
    .eq("id", periodId);
  if (upd.error) throw upd.error;

  return {
    matchedLineCount: matchedLines.length,
    unmatchedCount: unmatchedLines.length,
    skippedNoKeyCount,
    duplicateExternalIdCount,
    totalCents,
  };
}
