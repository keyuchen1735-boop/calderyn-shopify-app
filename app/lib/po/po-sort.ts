// Pure sort vocabulary for the purchase-order list. Framework-free so the
// PurchaseOrders screen, the client fetcher and the server route share one
// definition — the same split catalog-sort.ts and inventory-sort.ts use.
//
// Ordering is applied by the po_list RPC rather than in the browser: the list
// pages 50 rows at a time behind "load more", so a client-side sort would only
// order the rows already paged in.

/** Column keys the PO list can be ordered by. Values are the wire format and
 *  are matched literally by the RPC's ORDER BY, so they must stay in sync with
 *  the CASE arms in the po_list migration. */
export type PoSortKey = "po" | "supplier" | "destination" | "expected" | "lines" | "status";

const PO_SORT_KEYS: readonly string[] = [
  "po",
  "supplier",
  "destination",
  "expected",
  "lines",
  "status",
];

/** Narrow an untrusted value to a sort key, or undefined. Also the screen's
 *  "does this state name a real column?" test: the default ordering below uses
 *  a sentinel that deliberately fails this check. An unknown value is already
 *  inert at the RPC (it matches no CASE arm and falls back to newest-first) —
 *  this keeps it from reaching the database at all. */
export function parsePoSort(value: string | null | undefined): PoSortKey | undefined {
  return typeof value === "string" && PO_SORT_KEYS.includes(value)
    ? (value as PoSortKey)
    : undefined;
}

/** The list's default ordering — newest first, applied by the RPC. It is
 *  deliberately not one of the sort keys: no column represents it, so no header
 *  shows as active and the fetcher sends no sort param. The shared header-sort
 *  policy returns here on a column's third click. */
export const DEFAULT_PO_SORT = { sort: "default", dir: "desc" } as const;
