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

export type { OrderRow, DraftCartRow, AbandonedCheckoutRow, ShipChargeRow, OrdersPage };
export type { ImportedOrdersPage };

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
  };
}
