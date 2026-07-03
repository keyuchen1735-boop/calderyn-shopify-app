// Client fetchers for the owned-orders dashboard surface. Kept in its own
// module (not client.ts) so parallel surface work never collides on one file.
import { apiGet } from "./client";
import type {
  OrderRow,
  DraftCartRow,
  AbandonedCheckoutRow,
  ShipChargeRow,
  OrdersPage,
} from "~/lib/order/list-types";

export type { OrderRow, DraftCartRow, AbandonedCheckoutRow, ShipChargeRow, OrdersPage };

export async function fetchOrdersPage(): Promise<OrdersPage> {
  return apiGet<OrdersPage>("/dashboard/api/orders");
}
