import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "../../supabase.server";
import { applyAttribution } from "../../attribution/apply.server";
import type { AttributionSignals } from "../../attribution/types";
import type { OwnedCheckoutCompleted } from "./events";

const EMPTY_SIGNALS: AttributionSignals = { utm: {}, clickIds: {}, referringSite: null };

// Write one owned paid order into the analytics warehouse: order_fact (+buyer_id),
// order_line_fact, and attribution. PII-free by construction — only buyer_id (a
// pseudonymous OLTP ref) lands in order_fact. Idempotent via the same onConflict keys
// the Shopify path uses. No sku_dim lookup is needed: an owned line's variant_id IS
// the sku_dim.id (repo invariant sku_dim.id == variant_dim.id), so the header is safe
// to write first; a variant not yet projected to sku_dim fails the order_line_fact FK
// and sends the whole event to the DLQ (visible), never a silent sku_id=null.
export async function applyOwnedOrder(event: OwnedCheckoutCompleted): Promise<number> {
  const sb = getSupabase();
  const o = event.order;
  const parsedVersion = Date.parse(event.occurred_at);
  const sourceVersion = Number.isFinite(parsedVersion) ? parsedVersion : 0;
  const signals = o.attribution ?? EMPTY_SIGNALS;

  const { data: oUp, error: oErr } = await sb
    .from("order_fact")
    .upsert(
      {
        shop_id: event.shop_id,
        external_id: o.external_id,
        order_number: o.order_number,
        created_at_source: event.occurred_at,
        total_cents: o.total_cents,
        subtotal_cents: o.subtotal_cents,
        shipping_cents: o.shipping_cents,
        tax_cents: o.tax_cents,
        discount_cents: o.discount_cents,
        currency: o.currency,
        financial_status: o.financial_status,
        source_version: sourceVersion,
        landing_site: null,
        referring_site: signals.referringSite ?? null,
        utm_source: signals.utm.utm_source ?? null,
        utm_medium: signals.utm.utm_medium ?? null,
        utm_campaign: signals.utm.utm_campaign ?? null,
        utm_content: signals.utm.utm_content ?? null,
        utm_term: signals.utm.utm_term ?? null,
        buyer_id: o.buyer_id,
      },
      { onConflict: "shop_id,external_id" },
    )
    .select("id")
    .single();
  if (oErr) throw oErr;
  const orderId = (oUp as { id: string }).id;

  // Best-effort attribution (never aborts ingestion; a failure surfaces via the
  // caller's DLQ path), mirroring the Shopify applyOrder contract.
  await applyAttribution(event.shop_id, orderId, o.total_cents, signals, sb as unknown as SupabaseClient);

  if (!event.lines.length) return 1;

  const lineRows = event.lines.map((l) => ({
    shop_id: event.shop_id,
    order_id: orderId,
    sku_id: l.variant_id, // == sku_dim.id (repo invariant)
    external_line_id: l.external_line_id,
    quantity: l.quantity,
    price_cents: l.price_cents,
    total_cents: l.total_cents,
    grams: l.grams ?? null,
  }));

  const { error: lErr } = await sb
    .from("order_line_fact")
    .upsert(lineRows, { onConflict: "order_id,external_line_id" });
  if (lErr) throw lErr;

  return 1 + lineRows.length;
}
