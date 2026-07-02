import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  executeInventoryRelocation,
  RelocationError,
} from "../inventory-relocate.server";
import type * as InventoryServer from "../../shopify/inventory.server";
import type * as CutoverOrgMode from "../../cutover/org-mode.server";

const priorExecutionForKey = vi.hoisted(() => vi.fn());
const insertAuditWithIdempotency = vi.hoisted(() => vi.fn());
vi.mock("../execute.server", () => ({
  priorExecutionForKey: (...a: unknown[]) => priorExecutionForKey(...a),
  insertAuditWithIdempotency: (...a: unknown[]) => insertAuditWithIdempotency(...a),
}));

const inventoryAdjustQuantities = vi.hoisted(() => vi.fn());
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof InventoryServer>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));

const getOrgMode = vi.hoisted(() => vi.fn());
vi.mock("../../cutover/org-mode.server", async (importOriginal) => ({
  ...(await importOriginal<typeof CutoverOrgMode>()),
  getOrgMode: (...a: unknown[]) => getOrgMode(...a),
}));

const applyOwnedInventoryMove = vi.hoisted(() => vi.fn());
vi.mock("../owned-writes.server", () => ({
  applyOwnedInventoryMove: (...a: unknown[]) => applyOwnedInventoryMove(...a),
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
  getOrgMode.mockResolvedValue("mirror");
  applyOwnedInventoryMove.mockResolvedValue({ transferId: "tr-1" });
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
      sku: "W-1",
      sku_id: "sku-1",
      from_location_name: "NY",
      to_location_name: "LA",
    });
    expect(audit.pre_state).toEqual({ from_location_available: 80 });
    expect(audit.post_state).toEqual({ from_location_available: 40 });
    expect(audit.actor_user_id).toBe("merchant");
  });

  it("returns the prior outcome on a replayed idempotency key", async () => {
    priorExecutionForKey.mockResolvedValue({ id: "audit-0", outcome: "failed" });
    const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    expect(res).toEqual({ id: "audit-0", outcome: "failed" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("idempotency check fires before validation: replayed key with quantity 0 returns prior, does not throw", async () => {
    priorExecutionForKey.mockResolvedValue({ id: "audit-0", outcome: "succeeded" });
    const res = await executeInventoryRelocation(
      SHOP,
      { ...INPUT, quantity: 0 },
      mockSb(),
      ADMIN,
    );
    expect(res).toEqual({ id: "audit-0", outcome: "succeeded" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it.each([
    ["zero quantity", { quantity: 0 }, "INVALID_QUANTITY"],
    ["fractional quantity", { quantity: 1.5 }, "INVALID_QUANTITY"],
    ["NaN quantity", { quantity: Number.NaN }, "INVALID_QUANTITY"],
    ["same location", { toLocationId: INPUT.fromLocationId }, "SAME_LOCATION"],
  ])("throws on %s with no audit row", async (_n, patch, code) => {
    const p = executeInventoryRelocation(SHOP, { ...INPUT, ...patch }, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws SKU_NOT_FOUND for a foreign or missing sku", async () => {
    skuRow = null;
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "SKU_NOT_FOUND" });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws INVALID_TRANSFER_PLAN when the sku has no inventory item", async () => {
    skuRow = { ...skuRow!, inventory_item_id: null };
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws INVALID_TRANSFER_PLAN when a location is foreign or missing", async () => {
    locRows = [locRows[0]]; // destination missing
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws INVALID_TRANSFER_PLAN when the destination is inactive", async () => {
    locRows = [locRows[0], { ...locRows[1], active: false }];
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "INVALID_TRANSFER_PLAN" });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("throws QTY_EXCEEDS_AVAILABLE against FRESH availability", async () => {
    invRow = { available: 39 };
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "QTY_EXCEEDS_AVAILABLE" });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
  });

  it("treats a missing inventory row as zero availability", async () => {
    invRow = null;
    const p = executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
    await expect(p).rejects.toBeInstanceOf(RelocationError);
    await expect(p).rejects.toMatchObject({ code: "QTY_EXCEEDS_AVAILABLE" });
    expect(insertAuditWithIdempotency).not.toHaveBeenCalled();
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

  describe("executeInventoryRelocation — org_mode routing", () => {
    it("mirror: moves stock via Shopify, never the owned engine", async () => {
      getOrgMode.mockResolvedValue("mirror");
      const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
      expect(res.outcome).toBe("succeeded");
      expect(inventoryAdjustQuantities).toHaveBeenCalled(); // Shopify path (underlying)
      expect(applyOwnedInventoryMove).not.toHaveBeenCalled();
    });

    it("live: moves stock via the owned engine, never Shopify", async () => {
      getOrgMode.mockResolvedValue("live");
      const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
      expect(res.outcome).toBe("succeeded");
      // owned engine keyed by owned variant id (input.skuId) + owned location ids (loc-a/loc-b).
      expect(applyOwnedInventoryMove).toHaveBeenCalledWith({
        shopId: SHOP,
        variantId: "sku-1",
        fromLocationId: "loc-a",
        toLocationId: "loc-b",
        quantity: 40,
      });
      expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
      const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
      expect(audit.params.shopify_operation_id).toBe("tr-1"); // owned transfer id in the operation slot
      // Owned undo markers: undo.server.ts reverses through the owned engine off these.
      expect(audit.params.owned).toBe(true);
      expect(audit.params.owned_transfer_id).toBe("tr-1");
      expect(audit.params.owned_variant_id).toBe("sku-1");
      expect(audit.params.owned_from_location_id).toBe("loc-a");
      expect(audit.params.owned_to_location_id).toBe("loc-b");
    });

    it("dual_run: writes Shopify AND mirrors the move into the owned engine", async () => {
      getOrgMode.mockResolvedValue("dual_run");
      const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
      expect(res.outcome).toBe("succeeded");
      expect(inventoryAdjustQuantities).toHaveBeenCalled(); // Shopify stays authoritative
      expect(applyOwnedInventoryMove).toHaveBeenCalledWith({
        shopId: SHOP,
        variantId: "sku-1",
        fromLocationId: "loc-a",
        toLocationId: "loc-b",
        quantity: 40,
      });
      const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
      expect(audit.params.dual_write).toBe("ok");
      expect(audit.params.owned_transfer_id).toBe("tr-1");
      expect(audit.params.owned).toBeUndefined(); // Shopify was authoritative, not owned
    });

    it("dual_run: a failed owned mirror never fails the action, recorded on the audit", async () => {
      getOrgMode.mockResolvedValue("dual_run");
      applyOwnedInventoryMove.mockRejectedValue(new Error("insufficient_stock"));
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
        expect(res.outcome).toBe("succeeded");
      } finally {
        consoleError.mockRestore();
      }
      const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
      expect(audit.outcome).toBe("succeeded");
      expect(audit.params.dual_write).toBe("failed: insufficient_stock");
      expect(audit.params.owned_transfer_id).toBeUndefined();
    });

    it("live: records a FAILED audit row when the owned engine rejects (insufficient stock)", async () => {
      getOrgMode.mockResolvedValue("live");
      applyOwnedInventoryMove.mockRejectedValue(new Error("insufficient_stock"));
      const res = await executeInventoryRelocation(SHOP, INPUT, mockSb(), ADMIN);
      expect(res.outcome).toBe("failed");
      const [, , audit] = insertAuditWithIdempotency.mock.calls[0];
      expect(audit.outcome).toBe("failed");
      expect(audit.last_error).toContain("insufficient_stock");
      expect(audit.post_state).toBeNull();
    });
  });
});
