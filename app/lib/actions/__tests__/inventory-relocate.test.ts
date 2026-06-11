import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeInventoryRelocation,
  RelocationError,
} from "../inventory-relocate.server";

const priorExecutionForKey = vi.fn();
const insertAuditWithIdempotency = vi.fn();
vi.mock("../execute.server", () => ({
  priorExecutionForKey: (...a: unknown[]) => priorExecutionForKey(...a),
  insertAuditWithIdempotency: (...a: unknown[]) => insertAuditWithIdempotency(...a),
}));

const inventoryAdjustQuantities = vi.fn();
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shopify/inventory.server")>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));

const SHOP = "shop-1";
const ADMIN = { graphql: vi.fn() };
const INPUT = {
  alertId: null,
  skuId: "sku-1",
  fromLocationId: "gid://shopify/Location/9",
  toLocationId: "gid://shopify/Location/2",
  quantity: 40,
  idempotencyKey: "idem-1",
};

let skuRow: Record<string, unknown> | null;
let locRows: Array<Record<string, unknown>>;
let invRow: Record<string, unknown> | null;

function mockSb() {
  const result = (table: string) => {
    if (table === "sku_dim") return { data: skuRow, error: null };
    if (table === "location_dim") return { data: locRows, error: null };
    return { data: invRow, error: null }; // inventory_level_fact
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) {
      b[m] = vi.fn(() => b);
    }
    b.maybeSingle = vi.fn(async () => result(table));
    // location_dim list resolves the awaited builder itself (thenable).
    b.then = (resolve: (v: unknown) => void) => resolve(result(table));
    return b;
  };
  return { from: vi.fn((table: string) => builder(table)) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  priorExecutionForKey.mockResolvedValue(null);
  insertAuditWithIdempotency.mockImplementation(async (_s, _k, audit) => ({
    id: "audit-1",
    outcome: audit.outcome,
  }));
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/1" });
  skuRow = {
    id: "sku-1",
    title: "Widget",
    sku: "W-1",
    inventory_item_id: "gid://shopify/InventoryItem/1",
  };
  locRows = [
    { id: "loc-a", external_id: "gid://shopify/Location/9", name: "NY", active: true },
    { id: "loc-b", external_id: "gid://shopify/Location/2", name: "LA", active: true },
  ];
  invRow = { available: 80, observed_at: "2026-06-11T00:00:00Z" };
});

describe("executeInventoryRelocation", () => {
  it("moves stock, records a succeeded audit with the alert-shaped params", async () => {
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("succeeded");
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(ADMIN, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      fromLocationId: "gid://shopify/Location/9",
      toLocationId: "gid://shopify/Location/2",
      delta: 40,
    });
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.action_kind).toBe("reallocate_inventory");
    expect(audit.alert_id).toBeNull();
    expect(audit.params).toMatchObject({
      inventory_item_id: "gid://shopify/InventoryItem/1",
      from_location_id: "gid://shopify/Location/9",
      to_location_id: "gid://shopify/Location/2",
      delta: 40,
      shopify_operation_id: "gid://op/1",
      target: "Widget",
    });
    expect(audit.pre_state).toEqual({ from_location_available: 80 });
    expect(audit.post_state).toEqual({ from_location_available: 40 });
  });

  it("returns the prior outcome on a replayed idempotency key", async () => {
    priorExecutionForKey.mockResolvedValue({ id: "audit-0", outcome: "failed" });
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res).toEqual({ id: "audit-0", outcome: "failed" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it.each([
    ["zero quantity", { quantity: 0 }, "INVALID_QUANTITY"],
    ["fractional quantity", { quantity: 1.5 }, "INVALID_QUANTITY"],
    ["NaN quantity", { quantity: Number.NaN }, "INVALID_QUANTITY"],
    ["same location", { toLocationId: INPUT.fromLocationId }, "SAME_LOCATION"],
  ])("throws on %s with no audit row", async (_n, patch, code) => {
    await expect(
      executeInventoryRelocation(SHOP, { ...INPUT, ...patch }, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws SKU_NOT_FOUND for a foreign or missing sku", async () => {
    skuRow = null;
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "SKU_NOT_FOUND" });
  });

  it("throws INVALID_TRANSFER_PLAN when the sku has no inventory item", async () => {
    skuRow = { ...skuRow!, inventory_item_id: null };
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
  });

  it("throws INVALID_TRANSFER_PLAN when a location is foreign or missing", async () => {
    locRows = [locRows[0]]; // destination missing
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
  });

  it("throws INVALID_TRANSFER_PLAN when the destination is inactive", async () => {
    locRows = [locRows[0], { ...locRows[1], active: false }];
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
  });

  it("throws QTY_EXCEEDS_AVAILABLE against FRESH availability", async () => {
    invRow = { available: 39 };
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "QTY_EXCEEDS_AVAILABLE" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("treats a missing inventory row as zero availability", async () => {
    invRow = null;
    await expect(
      executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN),
    ).rejects.toMatchObject({ code: "QTY_EXCEEDS_AVAILABLE" });
  });

  it("records a FAILED audit row when Shopify rejects the mutation (rule 12)", async () => {
    inventoryAdjustQuantities.mockRejectedValue(new Error("ERR: location disabled"));
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res.outcome).toBe("failed");
    const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
    expect(audit.outcome).toBe("failed");
    expect(audit.last_error).toContain("location disabled");
    expect(audit.post_state).toBeNull();
  });
});
