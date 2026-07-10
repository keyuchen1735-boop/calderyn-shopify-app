import type { ActionFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { executeEditInvoiceLines, type EditInvoiceLineInput } from "~/lib/order/edit.server";
import { getSupabase } from "~/lib/supabase.server";

const MIN_LINES = 1;
const MAX_LINES = 50;
const MAX_QTY = 999;

function parseLines(v: unknown): EditInvoiceLineInput[] | null {
  if (!Array.isArray(v) || v.length < MIN_LINES || v.length > MAX_LINES) return null;
  const out: EditInvoiceLineInput[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.variant_id !== "string" || !r.variant_id) return null;
    const quantity = Number(r.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY) return null;
    out.push({ variantId: r.variant_id, quantity });
  }
  return out;
}

/**
 * Wholesale line replacement on an UNPAID invoice order (orders phase 3, Task 3). Only
 * channel='invoice' orders in state='checkout_pending' qualify (409 otherwise — a paid order's
 * lines can only be REDUCED via reduce-line.tsx, never replaced outright). Re-prices from the
 * live catalog and recomputes totals; no Stripe work, since the pay-link route always mints its
 * session from the order's current total at click-time.
 */
export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot be edited here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const lines = parseLines(body.lines);
  if (!lines) {
    return jsonError(422, "invalid_lines", `lines must be ${MIN_LINES}-${MAX_LINES} entries of {variant_id, quantity 1-${MAX_QTY}}.`);
  }

  return dashboardJson(async () => {
    const result = await executeEditInvoiceLines(session.shopId, orderId, lines, getSupabase());
    return {
      order_id: result.orderId,
      subtotal_cents: result.subtotalCents,
      shipping_cents: result.shippingCents,
      tax_cents: result.taxCents,
      total_cents: result.totalCents,
      currency: result.currency,
    };
  });
}
