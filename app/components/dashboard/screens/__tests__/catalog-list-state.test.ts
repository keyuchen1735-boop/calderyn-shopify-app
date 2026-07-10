import { describe, expect, it } from "vitest";
import { catalogSortToOrder, CATALOG_SORTS } from "../catalog-list-state";

describe("catalogSortToOrder", () => {
  it("maps updated to updated_at desc", () => {
    expect(catalogSortToOrder("updated")).toEqual({ column: "updated_at", ascending: false });
  });
  it("maps title_asc / title_desc to title", () => {
    expect(catalogSortToOrder("title_asc")).toEqual({ column: "title", ascending: true });
    expect(catalogSortToOrder("title_desc")).toEqual({ column: "title", ascending: false });
  });
  it("exposes exactly the three sorts", () => {
    expect(CATALOG_SORTS.map((s) => s.value)).toEqual(["updated", "title_asc", "title_desc"]);
  });
});
