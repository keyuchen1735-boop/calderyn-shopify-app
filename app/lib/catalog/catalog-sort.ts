// Pure sort helpers for the catalog list. Framework-free so the Catalog
// screen, the client fetcher, and the server route share one definition of
// the sort vocabulary.
export type CatalogSort =
  | "updated"
  | "title_asc"
  | "title_desc"
  | "status_asc"
  | "status_desc";

export const CATALOG_SORTS: Array<{ value: CatalogSort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
  { value: "status_asc", label: "Status A–Z" },
  { value: "status_desc", label: "Status Z–A" },
];

const CATALOG_SORT_VALUES = new Set<string>(CATALOG_SORTS.map((s) => s.value));

export function isCatalogSort(v: string): v is CatalogSort {
  return CATALOG_SORT_VALUES.has(v);
}

export function catalogSortToOrder(
  sort: CatalogSort,
): { column: "updated_at" | "title" | "status"; ascending: boolean } {
  if (sort === "title_asc") return { column: "title", ascending: true };
  if (sort === "title_desc") return { column: "title", ascending: false };
  if (sort === "status_asc") return { column: "status", ascending: true };
  if (sort === "status_desc") return { column: "status", ascending: false };
  return { column: "updated_at", ascending: false };
}
