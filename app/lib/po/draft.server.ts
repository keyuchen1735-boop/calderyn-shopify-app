// Purchase-order draft payload builder.
//
// The PO payload is built once at execute time and snapshotted into the
// action_audit row's params, so the downloadable PDF is reproducible forever
// from the audit row alone — no live data dependencies.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DetectorId } from "~/lib/types";

export interface PoLine {
  sku: string;
  title: string;
  quantity: number;
  /** null = unit cost unknown (no open cogs_fact row) — rendered as "TBD". */
  unit_cost_cents: number | null;
}

export interface PoDraft {
  po_number: string;
  issued_at: string;
  shop_domain: string;
  alert_id: string;
  detector_id: DetectorId;
  lines: PoLine[];
  subtotal_cents: number | null;
  total_cents: number | null;
}

export interface BuildPoDraftInput {
  alertId: string;
  detectorId: DetectorId;
  shopDomain: string;
  sku: string;
  title: string;
  quantity: number;
  unitCostCents: number | null;
  now: Date;
}

/**
 * Current unit cost for a sku code: the open (effective_to IS NULL) cogs_fact
 * row, shop-scoped. Returns null when the sku or cost is unknown — callers
 * render that as "TBD", never $0.
 */
export async function getCurrentUnitCostCents(
  sb: SupabaseClient,
  shopId: string,
  skuCode: string,
): Promise<number | null> {
  const { data: sku, error: sErr } = await sb
    .from("sku_dim")
    .select("id")
    .eq("shop_id", shopId)
    .eq("sku", skuCode)
    .maybeSingle();
  if (sErr) throw sErr;
  if (!sku?.id) return null;

  const { data: cost, error: cErr } = await sb
    .from("cogs_fact")
    .select("unit_cost_cents")
    .eq("shop_id", shopId)
    .eq("sku_id", sku.id)
    .is("effective_to", null)
    // Multiple sources (shopify, quickbooks, seed) may each hold an open row;
    // take the most recently effective one.
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (cErr) throw cErr;
  const cents = Number(cost?.unit_cost_cents);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/**
 * Recommended order quantity from alert evidence. Detectors emit numbers as
 * strings (Decimal serialisation); shortfall_units wins when present.
 */
export function derivePoQuantity(evidence: Record<string, unknown>): number | null {
  const shortfall = Number(evidence.shortfall_units);
  if (Number.isFinite(shortfall) && shortfall > 0) return Math.ceil(shortfall);

  // Cover demand through the resupply lead time.
  const velocity = Number(evidence.daily_velocity_units ?? evidence.velocity_units_per_day);
  if (Number.isFinite(velocity) && velocity > 0) {
    const leadDays = Number(evidence.lead_time_days);
    const days = Number.isFinite(leadDays) && leadDays > 0 ? leadDays : 14;
    return Math.ceil(velocity * days);
  }
  return null;
}

export function buildPoDraft(input: BuildPoDraftInput): PoDraft {
  const ymd = input.now.toISOString().slice(0, 10).replaceAll("-", "");
  const ref = input.alertId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toUpperCase();
  const total =
    input.unitCostCents === null ? null : input.quantity * input.unitCostCents;
  return {
    po_number: `PO-${ymd}-${ref}`,
    issued_at: input.now.toISOString(),
    shop_domain: input.shopDomain,
    alert_id: input.alertId,
    detector_id: input.detectorId,
    lines: [
      {
        sku: input.sku,
        title: input.title,
        quantity: input.quantity,
        unit_cost_cents: input.unitCostCents,
      },
    ],
    subtotal_cents: total,
    total_cents: total,
  };
}
