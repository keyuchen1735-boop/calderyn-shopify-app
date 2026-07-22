// Pure sort vocabulary for the inventory list. Framework-free so the Inventory
// screen, the client fetcher, and the server route share one definition — the
// same split catalog-sort.ts uses.
//
// Ordering is applied by the inventory_list RPC rather than in the browser: the
// list pages 50 rows at a time behind "load more", so a client-side sort would
// answer "highest on hand" with "highest among the rows loaded so far".

/** Column keys the inventory list can be ordered by. Values are the wire format
 *  and are matched literally by the RPC's ORDER BY, so they must stay in sync
 *  with the CASE arms in the inventory_list migration. */
export type InventorySortKey = "product" | "on_hand" | "reserved" | "available" | "status";

const INVENTORY_SORT_KEYS: readonly string[] = [
  "product",
  "on_hand",
  "reserved",
  "available",
  "status",
];

/** Narrow an untrusted value to a sort key, or undefined. Also the screen's
 *  "does this state name a real column?" test: the default ordering below uses
 *  a sentinel that deliberately fails this check. An unknown value is already
 *  inert at the RPC (it matches no CASE arm and falls back to the default
 *  order) — this keeps it from reaching the database at all. */
export function parseInventorySort(value: string | null | undefined): InventorySortKey | undefined {
  return typeof value === "string" && INVENTORY_SORT_KEYS.includes(value)
    ? (value as InventorySortKey)
    : undefined;
}

/** The list's default ordering — lowest stock first, applied by the RPC. It is
 *  deliberately not one of the sort keys: no column represents it, so no header
 *  shows as active and the fetcher sends no sort param. The shared header-sort
 *  policy returns here on a column's third click, the same arrangement as the
 *  Customers directory's "joined" default and the Orders labels list's date
 *  sort. */
export const DEFAULT_INVENTORY_SORT = { sort: "default", dir: "asc" } as const;
