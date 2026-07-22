import { describe, it, expect } from "vitest";

import { DEFAULT_PO_SORT, parsePoSort } from "../po-sort";
import { nextSortState } from "~/components/dashboard/screens/OrderListFamily";

describe("parsePoSort", () => {
  it("accepts every column the RPC can order by", () => {
    for (const key of ["po", "supplier", "destination", "expected", "lines", "status"]) {
      expect(parsePoSort(key)).toBe(key);
    }
  });

  it("rejects unknown, empty and absent values", () => {
    // The screen's default state uses a sentinel that is deliberately not a
    // column, so it has to fail this check and leave the RPC on its own order.
    expect(parsePoSort(DEFAULT_PO_SORT.sort)).toBeUndefined();
    expect(parsePoSort("created")).toBeUndefined();
    expect(parsePoSort("")).toBeUndefined();
    expect(parsePoSort(null)).toBeUndefined();
    expect(parsePoSort(undefined)).toBeUndefined();
  });

  it("rejects a SQL-shaped value rather than passing it to the database", () => {
    expect(parsePoSort("status; drop table purchase_order")).toBeUndefined();
    expect(parsePoSort("po asc, 1")).toBeUndefined();
  });
});

describe("purchase-order header sort cycle", () => {
  const cycle = (state: { sort: string; dir: "asc" | "desc" }, col: string) =>
    nextSortState(state, col, DEFAULT_PO_SORT);

  it("sorts the text columns A-Z on the first click", () => {
    // These live in the shared ASC_FIRST_SORT_COLS set; a text column that
    // opened Z-A would read backwards next to every other table.
    expect(cycle(DEFAULT_PO_SORT, "supplier")).toEqual({ sort: "supplier", dir: "asc" });
  });

  it("sorts counts, dates and status highest/latest first on the first click", () => {
    for (const col of ["expected", "lines", "status", "destination", "po"]) {
      expect(cycle(DEFAULT_PO_SORT, col)).toEqual({ sort: col, dir: "desc" });
    }
  });

  it("flips the active column on the second click", () => {
    expect(cycle({ sort: "lines", dir: "desc" }, "lines")).toEqual({ sort: "lines", dir: "asc" });
    expect(cycle({ sort: "supplier", dir: "asc" }, "supplier")).toEqual({
      sort: "supplier",
      dir: "desc",
    });
  });

  it("returns to the RPC's newest-first default on the third click", () => {
    // The default has no column of its own, so this is the only way back to it
    // without a page reload.
    expect(cycle({ sort: "lines", dir: "asc" }, "lines")).toEqual(DEFAULT_PO_SORT);
    expect(cycle({ sort: "supplier", dir: "desc" }, "supplier")).toEqual(DEFAULT_PO_SORT);
  });

  it("switches columns without carrying the previous direction over", () => {
    expect(cycle({ sort: "lines", dir: "asc" }, "supplier")).toEqual({
      sort: "supplier",
      dir: "asc",
    });
  });
});
