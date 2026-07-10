// app/lib/order/returns-types.ts
// Browser-safe DTO shapes for merchant-recorded returns (Phase 4 Task 1). Plain types only — no
// imports from .server files — so the detail route/screen (Task 2) can import them without pulling
// in server-only code, mirroring detail-types.ts.

/** Mirrors order_return.status's check constraint (migration 20260710210000). 'received' is a
 *  reserved future value — v1's receive flow (executeReturnReceivedAction) goes straight from
 *  'open' to 'closed', stamping received_at, so it never actually persists 'received' today. */
export type OrderReturnStatus = "open" | "received" | "closed" | "cancelled";

export interface OrderReturnLine {
  id: string;
  orderLineId: string;
  quantity: number;
  restock: boolean;
  refundCents: number;
}

export interface OrderReturn {
  id: string;
  orderId: string;
  status: OrderReturnStatus;
  reason: string | null;
  createdAt: string;
  /** Non-null once the return has been marked received (status 'closed' in v1). */
  receivedAt: string | null;
  lines: OrderReturnLine[];
}
