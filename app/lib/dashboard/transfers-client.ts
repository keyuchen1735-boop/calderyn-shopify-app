// Client fetchers for the shop-wide Transfers surface. Kept in its own module
// (not client.ts) so parallel surface work never collides on one file.
import { apiGet } from "./client";

/** One transfer, shop-wide: the variant-scoped PendingTransferVM shape plus
 *  the variant labels the list screen needs. `sku`/`variantTitle` are null
 *  when the variant row is gone or unlabeled — the screen falls back to the
 *  variant id rather than inventing a name. `receivedAt` is set only on rows
 *  from the received-history fetch; in-transit rows carry null. */
export interface ShopTransferVM {
  id: string;
  variantId: string;
  qty: number;
  fromName: string;
  toName: string;
  createdAt: string;
  receivedAt: string | null;
  sku: string | null;
  variantTitle: string | null;
}

/** All in-transit transfers for the session's shop. Same GET as the
 *  variant-scoped fetchPendingTransfers, just without the variantId filter;
 *  every row it returns is receivable (the route filters state=in_transit). */
export async function fetchAllPendingTransfers(): Promise<ShopTransferVM[]> {
  const d = await apiGet<{ transfers: ShopTransferVM[] }>(
    "/dashboard/api/catalog/inventory/transfer",
  );
  return d.transfers;
}

/** Transfers received in the last 30 days (newest first, capped at 100 by the
 *  route), for the Transfers screen's history card. */
export async function fetchReceivedTransfers(): Promise<ShopTransferVM[]> {
  const d = await apiGet<{ transfers: ShopTransferVM[] }>(
    "/dashboard/api/catalog/inventory/transfer?state=received",
  );
  return d.transfers;
}
