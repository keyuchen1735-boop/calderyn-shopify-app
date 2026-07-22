import { describe, it, expect } from "vitest";

import { DEFAULT_INVENTORY_SORT, parseInventorySort } from "../inventory-sort";
import {
  entranceStartIndex,
  nextSortState,
} from "~/components/dashboard/screens/OrderListFamily";

describe("parseInventorySort", () => {
  it("accepts every column the RPC can order by", () => {
    for (const key of ["product", "on_hand", "reserved", "available", "status"]) {
      expect(parseInventorySort(key)).toBe(key);
    }
  });

  it("rejects unknown, empty and absent values", () => {
    // The screen's default state uses a sentinel that is deliberately not a
    // column, so it has to fail this check and leave the RPC on its own order.
    expect(parseInventorySort(DEFAULT_INVENTORY_SORT.sort)).toBeUndefined();
    expect(parseInventorySort("incoming")).toBeUndefined();
    expect(parseInventorySort("")).toBeUndefined();
    expect(parseInventorySort(null)).toBeUndefined();
    expect(parseInventorySort(undefined)).toBeUndefined();
  });

  it("rejects a SQL-shaped value rather than passing it to the database", () => {
    expect(parseInventorySort("on_hand; drop table variant_dim")).toBeUndefined();
    expect(parseInventorySort("on_hand asc, 1")).toBeUndefined();
  });
});

describe("entranceStartIndex", () => {
  it("animates every row on a first paint", () => {
    expect(entranceStartIndex(null, "a|b|c")).toBe(0);
  });

  it("animates only the new tail when a page is appended", () => {
    // "Load more" on the Inventory list: the first 50 rows stay put and only
    // the incoming page rises.
    expect(entranceStartIndex("a|b|c", "a|b|c|d|e")).toBe(3);
    expect(entranceStartIndex("a", "a|b")).toBe(1);
  });

  it("animates every row on a re-sort, where the same rows come back reordered", () => {
    expect(entranceStartIndex("a|b|c", "c|b|a")).toBe(0);
  });

  it("animates every row when the rows themselves change", () => {
    expect(entranceStartIndex("a|b|c", "x|y|z")).toBe(0);
    expect(entranceStartIndex("a|b|c", "a|b")).toBe(0);
  });

  it("does not mistake an id that merely shares a prefix for an append", () => {
    // "a" is a prefix of "ab" as a string, but not as a row list — without the
    // separator check this would skip the first row's entrance.
    expect(entranceStartIndex("a", "ab|c")).toBe(0);
  });
});

describe("inventory header sort cycle", () => {
  const cycle = (state: { sort: string; dir: "asc" | "desc" }, col: string) =>
    nextSortState(state, col, DEFAULT_INVENTORY_SORT);

  it("sorts Product A-Z on the first click", () => {
    // "product" has to be in the shared ASC_FIRST_SORT_COLS set: a text column
    // that opened Z-A would read backwards next to Customers' Customer column.
    expect(cycle(DEFAULT_INVENTORY_SORT, "product")).toEqual({ sort: "product", dir: "asc" });
  });

  it("sorts the numeric columns highest-first on the first click", () => {
    for (const col of ["on_hand", "reserved", "available", "status"]) {
      expect(cycle(DEFAULT_INVENTORY_SORT, col)).toEqual({ sort: col, dir: "desc" });
    }
  });

  it("flips the active column on the second click", () => {
    expect(cycle({ sort: "on_hand", dir: "desc" }, "on_hand")).toEqual({
      sort: "on_hand",
      dir: "asc",
    });
    expect(cycle({ sort: "product", dir: "asc" }, "product")).toEqual({
      sort: "product",
      dir: "desc",
    });
  });

  it("returns to the default ordering on the third click", () => {
    // The default is lowest-stock-first and has no column of its own, so this
    // is the only way back to it without a page reload.
    expect(cycle({ sort: "on_hand", dir: "asc" }, "on_hand")).toEqual(DEFAULT_INVENTORY_SORT);
    expect(cycle({ sort: "product", dir: "desc" }, "product")).toEqual(DEFAULT_INVENTORY_SORT);
  });

  it("switches columns without carrying the previous direction over", () => {
    expect(cycle({ sort: "on_hand", dir: "asc" }, "product")).toEqual({
      sort: "product",
      dir: "asc",
    });
    expect(cycle({ sort: "product", dir: "desc" }, "available")).toEqual({
      sort: "available",
      dir: "desc",
    });
  });
});
