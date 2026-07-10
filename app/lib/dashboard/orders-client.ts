// Client fetchers for the owned-orders dashboard surface. Kept in its own
// module (not client.ts) so parallel surface work never collides on one file.
import { apiGet, apiSend, DashboardApiError } from "./client";
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

/** OrdersListParams -> the query string the list/export routes both parse (parseOrdersListParams
 *  on the server). Shared by fetchOrdersList and the Export CSV link (dashboard.api.orders.export)
 *  so the two routes are ALWAYS handed an identical filter surface for "the same view" — building
 *  the export URL any other way risks a silent drift between what's on screen and what's exported.
 *  Omits any param that's undefined/empty so the querystring stays minimal. */
export function ordersListParamsToQueryString(params: OrdersListParams): string {
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
  return qs.toString();
}

/** Search/filter/sort/paginate across native + imported orders (Phase 2 list power tools). */
export async function fetchOrdersList(params: OrdersListParams): Promise<UnifiedOrdersPage> {
  const qsString = ordersListParamsToQueryString(params);
  const suffix = qsString ? `?${qsString}` : "";

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

// --- bulk order actions (Phase 2 Task 3) -------------------------------------

/** One order's outcome from a bulk action: ok + a small per-action result, or ok:false + a
 *  plain-language error — never thrown per-order, since partial failure across a bulk
 *  selection is normal, expected output. */
export interface BulkResultVM {
  orderId: string;
  ok: boolean;
  error?: string;
}

interface BulkResultWire {
  order_id: string;
  ok: boolean;
  error?: string;
}

function mapBulkResults(rows: BulkResultWire[]): BulkResultVM[] {
  return rows.map((r) => ({ orderId: r.order_id, ok: r.ok, error: r.error }));
}

// The orders list's page size is 50 (fetchOrdersList's default limit), so "select all on this
// page" can hand these functions up to 50 ids — but the server-side bulk routes cap a single
// request at MAX_BULK_ORDERS = 25 (app/lib/order/bulk.server.ts) and 422 the WHOLE request over
// that, taking the entire selection down with it. Chunk into slices of at most this size and send
// them one at a time (never Promise.all) so a full-page bulk action never doubles the server's
// intended concurrent load.
const BULK_CHUNK_SIZE = 25;

/** Split `items` into consecutive slices of at most `size` elements each. */
export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Run a bulk-action sender over `orderIds` in <=BULK_CHUNK_SIZE slices, SEQUENTIALLY (each slice
 *  awaited before the next is sent), concatenating every slice's `results` into one flat array so
 *  callers see the same shape they would from a single request.
 *
 *  A single request's per-order failures are already captured inside its `results` (that's
 *  runBulkOrderAction's whole design, server-side) and never throw. But now that one logical bulk
 *  action can span 2-3 HTTP requests, a WHOLE chunk can still reject outright (network blip,
 *  expired session, a 5xx) after one or more earlier chunks already succeeded. Losing those
 *  already-applied results by letting the rejection propagate would both discard real work from
 *  the caller's summary AND skip its post-action refetch, leaving the screen showing stale data
 *  for orders that in fact changed. So a chunk-level rejection is caught here and downgraded to
 *  per-order `ok:false` entries for just that slice — the same "partial failure is normal, never
 *  a whole-request throw" contract runBulkOrderAction already guarantees within one request. */
async function runBulkInChunks(
  orderIds: string[],
  send: (slice: string[]) => Promise<{ results: BulkResultVM[] }>,
): Promise<{ results: BulkResultVM[] }> {
  const results: BulkResultVM[] = [];
  for (const slice of chunk(orderIds, BULK_CHUNK_SIZE)) {
    try {
      const { results: sliceResults } = await send(slice);
      results.push(...sliceResults);
    } catch (err) {
      const message = err instanceof DashboardApiError ? err.message : "Something went wrong.";
      for (const orderId of slice) results.push({ orderId, ok: false, error: message });
    }
  }
  return { results };
}

/** Fulfill every selected order in full (no per-order lines/tracking/carrier — that stays a
 *  single-order-only refinement). Native orders only; imported (shopify:) ids 422 the whole
 *  request. `idempotencyKey` is the outer key — the server derives one per order internally, so
 *  reusing it across chunked requests below is safe (each order still gets its own derived key). */
export async function bulkFulfillOrders(
  orderIds: string[],
  notify: boolean,
  idempotencyKey: string,
): Promise<{ results: BulkResultVM[] }> {
  return runBulkInChunks(orderIds, async (slice) => {
    const data = await apiSend<{ results: BulkResultWire[] }>("POST", "/dashboard/api/orders/bulk/fulfill", {
      order_ids: slice,
      notify,
      idempotency_key: idempotencyKey,
    });
    return { results: mapBulkResults(data.results) };
  });
}

/** Archive or unarchive every selected order. Native orders only. */
export async function bulkArchiveOrders(
  orderIds: string[],
  archived: boolean,
): Promise<{ results: BulkResultVM[] }> {
  return runBulkInChunks(orderIds, async (slice) => {
    const data = await apiSend<{ results: BulkResultWire[] }>("POST", "/dashboard/api/orders/bulk/archive", {
      order_ids: slice,
      archived,
    });
    return { results: mapBulkResults(data.results) };
  });
}

/** Add tags to every selected order WITHOUT removing any tag already there (additive, never the
 *  full-replace path setOrderTags uses). Native orders only. */
export async function bulkAddOrderTags(
  orderIds: string[],
  addTags: string[],
): Promise<{ results: BulkResultVM[] }> {
  return runBulkInChunks(orderIds, async (slice) => {
    const data = await apiSend<{ results: BulkResultWire[] }>("POST", "/dashboard/api/orders/bulk/tags", {
      order_ids: slice,
      add_tags: addTags,
    });
    return { results: mapBulkResults(data.results) };
  });
}

// --- merchant drafts + send-invoice (Phase 3 Task 2) -------------------------

export interface DraftLineVM {
  id: string;
  variantId: string;
  title: string;
  quantity: number;
  unitPriceCents: number;
  currency: string;
}

export interface MerchantDraftVM {
  id: string;
  lines: DraftLineVM[];
  subtotalCents: number;
  currency: string;
  createdAt: string;
}

interface DraftLineWire {
  id: string;
  variant_id: string;
  title: string;
  quantity: number;
  unit_price_cents: number;
  currency: string;
}

interface MerchantDraftWire {
  id: string;
  lines: DraftLineWire[];
  subtotal_cents: number;
  currency: string;
  created_at: string;
}

function mapDraft(d: MerchantDraftWire): MerchantDraftVM {
  return {
    id: d.id,
    lines: d.lines.map((l) => ({
      id: l.id,
      variantId: l.variant_id,
      title: l.title,
      quantity: l.quantity,
      unitPriceCents: l.unit_price_cents,
      currency: l.currency,
    })),
    subtotalCents: d.subtotal_cents,
    currency: d.currency,
    createdAt: d.created_at,
  };
}

/** List every open merchant-draft cart for the session's shop. */
export async function fetchMerchantDrafts(): Promise<MerchantDraftVM[]> {
  const data = await apiGet<{ drafts: MerchantDraftWire[] }>("/dashboard/api/orders/drafts");
  return data.drafts.map(mapDraft);
}

/** Create a new merchant draft (omit cartId) or replace an existing one's lines (cartId given).
 *  1-50 lines, qty 1-999 each; an unknown/unavailable variant 422s (DashboardApiError). */
export async function saveMerchantDraft(input: {
  cartId?: string;
  lines: Array<{ variantId: string; quantity: number }>;
}): Promise<MerchantDraftVM> {
  const data = await apiSend<{ draft: MerchantDraftWire }>("POST", "/dashboard/api/orders/drafts", {
    cart_id: input.cartId,
    lines: input.lines.map((l) => ({ variant_id: l.variantId, quantity: l.quantity })),
  });
  return mapDraft(data.draft);
}

/** Delete a merchant-draft cart outright. 404s (DashboardApiError) on an unknown/foreign/non-draft id. */
export async function deleteMerchantDraft(cartId: string): Promise<void> {
  await apiSend<{ deleted: true }>("DELETE", `/dashboard/api/orders/drafts?id=${encodeURIComponent(cartId)}`);
}

/** Buyer address captured for a sent invoice (mirrors BuyerAddressInput, browser-safe copy). */
export interface InvoiceAddressInput {
  kind?: "shipping" | "billing";
  name?: string;
  line1: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
  phone?: string;
}

export interface SendInvoiceResult {
  orderId: string;
  confirmationToken: string;
  totalCents: number;
  currency: string;
  emailSent: boolean;
}

/** Turn a merchant-draft cart into a real invoice and email the buyer a pay link. 409s
 *  (DashboardApiError, code "payments_not_ready") if the shop can't take payments yet. */
export async function sendDraftInvoice(input: {
  cartId: string;
  email: string;
  address?: InvoiceAddressInput;
  note?: string;
}): Promise<SendInvoiceResult> {
  const data = await apiSend<{
    order_id: string;
    confirmation_token: string;
    total_cents: number;
    currency: string;
    email_sent: boolean;
  }>("POST", "/dashboard/api/orders/drafts/send", {
    cart_id: input.cartId,
    email: input.email,
    address: input.address,
    note: input.note,
  });
  return {
    orderId: data.order_id,
    confirmationToken: data.confirmation_token,
    totalCents: data.total_cents,
    currency: data.currency,
    emailSent: data.email_sent,
  };
}
