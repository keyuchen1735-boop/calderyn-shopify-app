// Client fetchers for the owned-orders dashboard surface. Kept in its own
// module (not client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend } from "./client";
import type {
  OrderRow,
  DraftCartRow,
  AbandonedCheckoutRow,
  ShipChargeRow,
  OrdersPage,
} from "~/lib/order/list-types";
import type { ImportedOrdersPage } from "~/lib/order/imported-list-types";
import type { OrderDetail } from "~/lib/order/detail-types";

export type { OrderRow, DraftCartRow, AbandonedCheckoutRow, ShipChargeRow, OrdersPage };
export type { ImportedOrdersPage };
export type { OrderDetail };

export async function fetchOrdersPage(): Promise<OrdersPage> {
  return apiGet<OrdersPage>("/dashboard/api/orders");
}

/** Historical orders + refunds brought over by Import-from-Shopify (read-only). */
export async function fetchImportedOrders(): Promise<ImportedOrdersPage> {
  return apiGet<ImportedOrdersPage>("/dashboard/api/orders/imported");
}

export interface RefundResult {
  auditId: string;
  refundId: string | null;
  amountCents: number;
  orderState: string;
  refundedTotalCents: number;
  capturedCents: number;
  restockedLines: number;
  restockError: string | null;
}

/**
 * Issue a refund on an owned order (#3b). Omit amountCents for a full refund.
 * idempotencyKey dedups the action AND is handed to Stripe, so a retried submit
 * can never double-refund. Mirrors the Polaris app.orders action contract.
 */
export async function refundOrder(
  orderId: string,
  args: { amountCents?: number; idempotencyKey: string; reason?: string; restock?: boolean },
): Promise<RefundResult> {
  const data = await apiSend<{
    audit_id: string;
    refund_id: string | null;
    amount_cents: number;
    order_state: string;
    refunded_total_cents: number;
    captured_cents: number;
    restocked_lines: number;
    restock_error: string | null;
  }>("POST", `/dashboard/api/orders/${encodeURIComponent(orderId)}/refund`, {
    amount_cents: args.amountCents,
    idempotency_key: args.idempotencyKey,
    reason: args.reason,
    restock: args.restock,
  });
  return {
    auditId: data.audit_id,
    refundId: data.refund_id,
    amountCents: data.amount_cents,
    orderState: data.order_state,
    refundedTotalCents: data.refunded_total_cents,
    capturedCents: data.captured_cents,
    restockedLines: data.restocked_lines,
    restockError: data.restock_error,
  };
}

/** Fetch a single order's detail view (native or imported read-only). */
export async function fetchOrderDetail(sourceId: string): Promise<OrderDetail> {
  const data = await apiGet<{ order: OrderDetail }>(
    `/dashboard/api/orders/${encodeURIComponent(sourceId)}`,
  );
  return data.order;
}

/** Fulfill (ship) an order or some of its lines. Native orders only. */
export async function fulfillOrder(
  orderId: string,
  args: {
    lines?: { orderLineId: string; quantity: number }[];
    trackingNumber?: string;
    carrier?: string;
    notify: boolean;
    idempotencyKey: string;
  },
): Promise<{ orderState: string; fulfilledUnits: number; notified: boolean }> {
  const data = await apiSend<{
    order_state: string;
    fulfilled_units: number;
    notified: boolean;
  }>("POST", `/dashboard/api/orders/${encodeURIComponent(orderId)}/fulfill`, {
    lines: args.lines?.map((line) => ({ order_line_id: line.orderLineId, quantity: line.quantity })),
    tracking_number: args.trackingNumber,
    carrier: args.carrier,
    notify: args.notify,
    idempotency_key: args.idempotencyKey,
  });
  return {
    orderState: data.order_state,
    fulfilledUnits: data.fulfilled_units,
    notified: data.notified,
  };
}

/** Cancel (abandon) an order before or during fulfillment. Native orders only. */
export async function cancelOrder(
  orderId: string,
  args: { reason?: string; refund: boolean; restock: boolean; idempotencyKey: string },
): Promise<{ orderState: string; refunded: boolean; restockedLines: number }> {
  const data = await apiSend<{
    order_state: string;
    refunded: boolean;
    restocked_lines: number;
  }>("POST", `/dashboard/api/orders/${encodeURIComponent(orderId)}/cancel`, {
    reason: args.reason,
    refund: args.refund,
    restock: args.restock,
    idempotency_key: args.idempotencyKey,
  });
  return {
    orderState: data.order_state,
    refunded: data.refunded,
    restockedLines: data.restocked_lines,
  };
}

/** Add a staff note to an order's timeline. Native orders only. */
export async function addOrderNote(orderId: string, body: string): Promise<void> {
  await apiSend<{ note_id: string }>("POST", `/dashboard/api/orders/${encodeURIComponent(orderId)}/notes`, {
    body,
  });
}

/** Replace all tags on an order (full replace, not append). Native orders only. */
export async function setOrderTags(orderId: string, tags: string[]): Promise<string[]> {
  const data = await apiSend<{ tags: string[] }>(
    "POST",
    `/dashboard/api/orders/${encodeURIComponent(orderId)}/tags`,
    { tags },
  );
  return data.tags;
}

/** Archive or unarchive an order. Native orders only. */
export async function setOrderArchived(orderId: string, archived: boolean): Promise<boolean> {
  const data = await apiSend<{ archived: boolean }>(
    "POST",
    `/dashboard/api/orders/${encodeURIComponent(orderId)}/archive`,
    { archived },
  );
  return data.archived;
}
