import { describe, it, expect } from "vitest";
import { parseInventoryItems, reconcileCost } from "../ingest.server";

describe("parseInventoryItems", () => {
  it("keeps inventory items with a SKU and positive cost, converting to cents", () => {
    const json = {
      QueryResponse: {
        Item: [
          { Id: "1", Sku: "MUG", PurchaseCost: 8, Type: "Inventory" },
          { Id: "2", Sku: "  TEE  ", PurchaseCost: 3.5, Type: "Inventory" },
        ],
      },
    };
    expect(parseInventoryItems(json)).toEqual([
      { id: "1", sku: "MUG", unitCostCents: 800 },
      { id: "2", sku: "TEE", unitCostCents: 350 },
    ]);
  });

  it("skips items with no SKU, zero/absent cost, or no id", () => {
    const json = {
      QueryResponse: {
        Item: [
          { Id: "1", PurchaseCost: 8 },                       // no Sku
          { Id: "2", Sku: "X", PurchaseCost: 0 },              // zero cost
          { Id: "3", Sku: "Y" },                               // absent cost
          { Sku: "Z", PurchaseCost: 5 },                       // no id
        ],
      },
    };
    expect(parseInventoryItems(json)).toEqual([]);
  });

  it("returns [] when the response shape is empty/unexpected", () => {
    expect(parseInventoryItems({})).toEqual([]);
    expect(parseInventoryItems({ QueryResponse: {} })).toEqual([]);
  });
});

describe("reconcileCost", () => {
  it("inserts when there is no open row", () => {
    expect(reconcileCost(null, 800)).toEqual({ kind: "insert" });
  });
  it("no-ops when the open cost is unchanged", () => {
    expect(reconcileCost({ id: "a", unit_cost_cents: 800 }, 800)).toEqual({ kind: "noop" });
  });
  it("closes the old row and inserts when the cost changed", () => {
    expect(reconcileCost({ id: "a", unit_cost_cents: 800 }, 900)).toEqual({
      kind: "update_then_insert",
      closeId: "a",
    });
  });
});
