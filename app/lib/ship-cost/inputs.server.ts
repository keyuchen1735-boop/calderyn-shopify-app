import type { SupabaseClient } from "@supabase/supabase-js";
import { parseInvoiceCsv } from "./csv";
import { matchInvoiceLines, type MatchOrder, type InvoiceLineRow } from "./match";
import { runShipCostResolution } from "./runner.server";

interface ReResolveOpts {
  shopCountry: string | null;
}

export interface TypedPeriodInput extends ReResolveOpts {
  totalCents: number;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export async function saveTypedPeriodTotal(
  sb: SupabaseClient,
  shopId: string,
  input: TypedPeriodInput,
): Promise<void> {
  await sb.from("shipping_cost_period").insert({
    shop_id: shopId,
    period_start: input.periodStart,
    period_end: input.periodEnd,
    carrier: input.carrier,
    total_cents: input.totalCents,
    source: "typed",
  });
  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
}

export interface InvoiceCsvInput extends ReResolveOpts {
  csvText: string;
  carrier: string | null;
  periodStart: string;
  periodEnd: string;
}

export interface InvoiceCsvResult {
  matchedCount: number;
  unmatched: InvoiceLineRow[];
  parseErrors: { line: number; reason: string }[];
}

export async function ingestInvoiceCsv(
  sb: SupabaseClient,
  shopId: string,
  input: InvoiceCsvInput,
): Promise<InvoiceCsvResult> {
  const { rows, errors } = parseInvoiceCsv(input.csvText);

  // Load the shop's orders (id + order_number) for matching. Tracking match is
  // best-effort: include tracking_no from fulfillment_fact when present.
  const { data: orders = [] } = await sb
    .from("order_fact")
    .select("id, order_number")
    .eq("shop_id", shopId);
  const { data: fulfills = [] } = await sb
    .from("fulfillment_fact")
    .select("order_id, tracking_no")
    .eq("shop_id", shopId);
  const trackingByOrder = new Map<string, string[]>();
  for (const f of fulfills as { order_id: string | null; tracking_no: string | null }[]) {
    if (!f.order_id || !f.tracking_no) continue;
    const list = trackingByOrder.get(f.order_id) ?? [];
    list.push(String(f.tracking_no));
    trackingByOrder.set(f.order_id, list);
  }
  const matchOrders: MatchOrder[] = (orders as { id: string; order_number: string | null }[]).map((o) => ({
    id: o.id,
    orderNumber: String(o.order_number ?? ""),
    trackingNos: trackingByOrder.get(o.id) ?? [],
  }));

  const { matched, unmatched } = matchInvoiceLines(rows, matchOrders);
  const totalCents = rows.reduce((s, r) => s + r.costCents, 0);

  const { data: period } = await sb
    .from("shipping_cost_period")
    .insert({
      shop_id: shopId,
      period_start: input.periodStart,
      period_end: input.periodEnd,
      carrier: input.carrier,
      total_cents: totalCents,
      source: "upload",
    })
    .select("id")
    .single();
  const periodId = (period as { id: string } | null)?.id ?? null;

  const allLines = [...matched, ...unmatched];
  if (allLines.length > 0) {
    await sb.from("shipping_invoice_line").insert(
      allLines.map((l) => ({
        shop_id: shopId,
        period_id: periodId,
        order_ref: l.orderRef,
        tracking_no: l.trackingNo,
        cost_cents: l.costCents,
        matched_order_id: l.matchedOrderId,
      })),
    );
  }

  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
  return { matchedCount: matched.length, unmatched, parseErrors: errors };
}

export interface ManualOverrideInput extends ReResolveOpts {
  orderId: string;
  /** null clears the override. */
  cents: number | null;
}

export async function setManualOverride(
  sb: SupabaseClient,
  shopId: string,
  input: ManualOverrideInput,
): Promise<void> {
  await sb
    .from("order_fact")
    .update({ ship_cost_manual_cents: input.cents })
    .eq("id", input.orderId)
    .eq("shop_id", shopId);
  await runShipCostResolution(sb, shopId, { shopCountry: input.shopCountry });
}
