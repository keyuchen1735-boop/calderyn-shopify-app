// app/routes/dashboard.api.orders.$id.returns.tsx
// Merchant-recorded returns (orders Phase 4, Task 2): GET lists every return on the order; POST
// opens a new one. Validation mirrors reduce-line.tsx's boundary style — native-only, bounded
// array/string shapes — and every domain failure (order_not_returnable, qty_exceeds_returnable,
// refund_exceeds_default, return_already_open, ...) is a CalderynError createOrderReturn already
// throws, so dashboardJson maps it to its status/code without this route special-casing any of it.
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { requireDashboardSession } from "~/lib/dashboard/session.server";
import { dashboardJson, jsonError, parseJsonObjectBody, requireSameOrigin } from "~/lib/dashboard/http.server";
import { isImportedOrderId, stripNativeOrderPrefix } from "~/lib/order/detail.server";
import { createOrderReturn, listOrderReturns, type CreateReturnLineInput } from "~/lib/order/returns.server";
import type { OrderReturn } from "~/lib/order/returns-types";

const MAX_LINES = 50;
const MAX_REASON_LENGTH = 500;

function mapReturnWire(r: OrderReturn) {
  return {
    id: r.id,
    order_id: r.orderId,
    status: r.status,
    reason: r.reason,
    created_at: r.createdAt,
    received_at: r.receivedAt,
    lines: r.lines.map((l) => ({
      id: l.id,
      order_line_id: l.orderLineId,
      quantity: l.quantity,
      restock: l.restock,
      refund_cents: l.refundCents,
    })),
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const session = await requireDashboardSession(request);
  const rawId = String(params.id);
  // Imported (Shopify-paid) orders never went through the native returns spine — an empty list is
  // the honest answer, not a 422 on a harmless read.
  if (isImportedOrderId(rawId)) {
    return dashboardJson(async () => ({ returns: [] }));
  }
  const orderId = stripNativeOrderPrefix(rawId);
  return dashboardJson(async () => {
    const returns = await listOrderReturns(session.shopId, orderId);
    return { returns: returns.map(mapReturnWire) };
  });
}

function parseLines(v: unknown): CreateReturnLineInput[] | null {
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_LINES) return null;
  const out: CreateReturnLineInput[] = [];
  for (const item of v) {
    if (typeof item !== "object" || item === null) return null;
    const r = item as Record<string, unknown>;
    if (typeof r.order_line_id !== "string" || !r.order_line_id) return null;
    if (typeof r.quantity !== "number" || !Number.isInteger(r.quantity) || r.quantity <= 0) return null;
    if (typeof r.restock !== "boolean") return null;
    let refundCents: number | undefined;
    if (r.refund_cents !== undefined && r.refund_cents !== null) {
      if (typeof r.refund_cents !== "number" || !Number.isInteger(r.refund_cents) || r.refund_cents < 0) return null;
      refundCents = r.refund_cents;
    }
    out.push({ orderLineId: r.order_line_id, quantity: r.quantity, restock: r.restock, refundCents });
  }
  return out;
}

export async function action({ request, params }: ActionFunctionArgs) {
  requireSameOrigin(request);
  const session = await requireDashboardSession(request);
  if (request.method !== "POST") return jsonError(405, "method_not_allowed");

  const rawId = String(params.id);
  if (isImportedOrderId(rawId)) {
    return jsonError(422, "imported_read_only", "Imported orders cannot have returns created here.");
  }
  const orderId = stripNativeOrderPrefix(rawId);

  const body = await parseJsonObjectBody(request);
  if (!body) return jsonError(400, "bad_body", "Expected a JSON body.");

  const lines = parseLines(body.lines);
  if (!lines) {
    return jsonError(
      422,
      "invalid_lines",
      `lines must be 1-${MAX_LINES} entries of {order_line_id, quantity (positive whole number), restock (boolean), refund_cents? (non-negative whole number)}.`,
    );
  }

  const reason = typeof body.reason === "string" ? body.reason : null;
  if (reason !== null && reason.length > MAX_REASON_LENGTH) {
    return jsonError(422, "invalid_reason", `reason must be ${MAX_REASON_LENGTH} characters or fewer.`);
  }

  return dashboardJson(async () => {
    const result = await createOrderReturn(session.shopId, { orderId, lines, reason });
    return {
      return_id: result.returnId,
      status: result.status,
      lines: result.lines.map((l) => ({
        id: l.id,
        order_line_id: l.orderLineId,
        quantity: l.quantity,
        restock: l.restock,
        refund_cents: l.refundCents,
      })),
    };
  });
}
