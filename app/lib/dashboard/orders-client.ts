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
import type { OrdersListParams, UnifiedOrderRow, UnifiedOrdersPage } from "~/lib/order/unified-list-types";

export type { OrderRow, DraftCartRow, AbandonedCheckoutRow, ShipChargeRow, OrdersPage };
export type { ImportedOrdersPage };
export type { OrderDetail };
export type { OrdersListParams, UnifiedOrderRow, UnifiedOrdersPage };

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

// --- unified list + saved views (Phase 2 Task 2) ----------------------------

interface UnifiedOrderRowWire {
  source: "calderyn" | "shopify";
  id: string;
  ref: string;
  buyer_email: string | null;
  total_cents: number;
  currency: string;
  payment_status: string;
  state: string;
  cancelled_at: string | null;
  archived_at: string | null;
  occurred_at: string;
  item_count: number;
  tags: string[];
  remaining_refundable_cents: number;
}

function mapUnifiedRow(row: UnifiedOrderRowWire): UnifiedOrderRow {
  return {
    source: row.source,
    id: row.id,
    ref: row.ref,
    buyerEmail: row.buyer_email,
    totalCents: row.total_cents,
    currency: row.currency,
    paymentStatus: row.payment_status,
    state: row.state,
    cancelledAt: row.cancelled_at,
    archivedAt: row.archived_at,
    occurredAt: row.occurred_at,
    itemCount: row.item_count,
    tags: row.tags,
    remainingRefundableCents: row.remaining_refundable_cents,
  };
}

/** Search/filter/sort/paginate across native + imported orders (Phase 2 list power tools).
 *  Omits any param that's undefined so the querystring stays minimal. */
export async function fetchOrdersList(params: OrdersListParams): Promise<UnifiedOrdersPage> {
  const qs = new URLSearchParams();
  if (params.search) qs.set("search", params.search);
  if (params.paymentStatus?.length) qs.set("payment_status", params.paymentStatus.join(","));
  if (params.fulfillmentStatus) qs.set("fulfillment_status", params.fulfillmentStatus);
  if (params.source) qs.set("source", params.source);
  if (params.dateFrom) qs.set("date_from", params.dateFrom);
  if (params.dateTo) qs.set("date_to", params.dateTo);
  if (params.tag) qs.set("tag", params.tag);
  if (params.archived !== undefined) qs.set("archived", params.archived ? "true" : "false");
  if (params.sort) qs.set("sort", params.sort);
  if (params.dir) qs.set("dir", params.dir);
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";

  const data = await apiGet<{
    rows: UnifiedOrderRowWire[];
    total_count: number;
    offset: number;
    limit: number;
  }>(`/dashboard/api/orders/list${suffix}`);
  return {
    rows: data.rows.map(mapUnifiedRow),
    totalCount: data.total_count,
    offset: data.offset,
    limit: data.limit,
  };
}

/** A merchant-saved orders-list filter preset. */
export interface OrderViewVM {
  id: string;
  name: string;
  filters: Record<string, unknown>;
  position: number;
}

/** List the shop's saved order-list views, in display order. */
export async function fetchOrderViews(): Promise<OrderViewVM[]> {
  const data = await apiGet<{ views: OrderViewVM[] }>("/dashboard/api/orders/views");
  return data.views;
}

/** Save the current toolbar filters as a named view. 409s (DashboardApiError) on a duplicate
 *  name; 422s past the per-shop saved-view cap. */
export async function createOrderView(name: string, filters: Record<string, unknown>): Promise<OrderViewVM> {
  const data = await apiSend<{ view: OrderViewVM }>("POST", "/dashboard/api/orders/views", { name, filters });
  return data.view;
}

/** Delete a saved view by id. */
export async function deleteOrderView(id: string): Promise<void> {
  await apiSend<{ deleted: true }>("DELETE", `/dashboard/api/orders/views?id=${encodeURIComponent(id)}`);
}
