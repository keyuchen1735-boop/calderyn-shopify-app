// Pure sort helpers for the catalog list. Framework-free so the Catalog
// screen, the client fetcher, and the server route share one definition of
// the sort vocabulary.
export type CatalogSort = "updated" | "title_asc" | "title_desc";

export const CATALOG_SORTS: Array<{ value: CatalogSort; label: string }> = [
  { value: "updated", label: "Recently updated" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
];

export function isCatalogSort(v: string): v is CatalogSort {
  return v === "updated" || v === "title_asc" || v === "title_desc";
}

export function catalogSortToOrder(sort: CatalogSort): { column: "updated_at" | "title"; ascending: boolean } {
  if (sort === "title_asc") return { column: "title", ascending: true };
  if (sort === "title_desc") return { column: "title", ascending: false };
  return { column: "updated_at", ascending: false };
}
