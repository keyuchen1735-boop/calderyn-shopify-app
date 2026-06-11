import { describe, it, expect, vi, beforeEach } from "vitest";
import { undoAction } from "../undo.server";

const inventoryAdjustQuantities = vi.fn();
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  // Spread keeps non-mocked exports (e.g. transferPlanFromEvidence) intact.
  ...(await importOriginal<Record<string, unknown>>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));
vi.mock("../../ads/action-registry.server", () => ({
  actionAdapterForShop: vi.fn(async () => null),
}));

const ORIG = {
  id: "audit-1",
  shop_id: "shop-1",
  alert_id: null,
  action_kind: "reallocate_inventory",
  params: {
    inventory_item_id: "gid://shopify/InventoryItem/1",
    from_location_id: "gid://shopify/Location/9",
    to_location_id: "gid://shopify/Location/2",
    delta: 40,
  },
  pre_state: { from_location_available: 80 },
  post_state: { from_location_available: 40 },
  dollar_impact_at_exec: 0,
  outcome: "succeeded",
};

function mockSb(
  orig: Record<string, unknown> | null,
  insertResult: { data: { id: string } | null; error: Error | null } = {
    data: { id: "audit-undo-1" },
    error: null,
  },
) {
  const single = vi.fn(async () => insertResult);
  const builder: Record<string, unknown> = {};
  for (const m of ["eq", "update", "insert", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  // The builder is shared across from() calls, so key maybeSingle on the most
  // recent select arg: the double-undo guard probes with select("id") and must
  // see no prior undo, while the full-column orig lookup gets the orig row.
  let lastSelect = "";
  builder.select = vi.fn((cols: string) => {
    lastSelect = cols;
    return builder;
  });
  builder.maybeSingle = vi.fn(async () => ({
    data: lastSelect === "id" ? null : orig,
    error: null,
  }));
  builder.single = single;
  return { from: vi.fn(() => builder) } as never;
}

const ADMIN = { graphql: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/undo" });
});

describe("undoAction for reallocate_inventory", () => {
  it("fires the REVERSE transfer (locations swapped) and records the undo row", async () => {
    const res = await undoAction("shop-1", "audit-1", mockSb(ORIG), { admin: ADMIN });
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(ADMIN, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      fromLocationId: "gid://shopify/Location/2", // original destination
      toLocationId: "gid://shopify/Location/9", // original source
      delta: 40,
    });
    expect(res.id).toBe("audit-undo-1");
  });

  it("refuses loudly when no Shopify admin client is supplied", async () => {
    await expect(undoAction("shop-1", "audit-1", mockSb(ORIG))).rejects.toThrow(
      /Shopify admin/i,
    );
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("refuses when the original audit lacks a replayable transfer plan", async () => {
    const noPlan = { ...ORIG, params: { delta: 40 } };
    await expect(
      undoAction("shop-1", "audit-1", mockSb(noPlan), { admin: ADMIN }),
    ).rejects.toThrow(/transfer plan/i);
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("refuses a non-succeeded original (failed transfers keep a replayable plan) without any platform call", async () => {
    const failed = { ...ORIG, outcome: "failed" };
    await expect(
      undoAction("shop-1", "audit-1", mockSb(failed), { admin: ADMIN }),
    ).rejects.toThrow(/only succeeded/i);
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("throws a do-not-retry error when the reversal applied but the undo row insert fails", async () => {
    const sb = mockSb(ORIG, { data: null, error: new Error("db down") });
    await expect(undoAction("shop-1", "audit-1", sb, { admin: ADMIN })).rejects.toThrow(
      /was applied .* do not retry/i,
    );
    // The reversal really fired — the error must say so instead of inviting a retry.
    expect(inventoryAdjustQuantities).toHaveBeenCalledTimes(1);
  });

  it("does not require an ads adapter for inventory undo", async () => {
    // actionAdapterForShop is mocked to return null (no ads integration);
    // an inventory undo must still succeed.
    const res = await undoAction("shop-1", "audit-1", mockSb(ORIG), { admin: ADMIN });
    expect(res.id).toBe("audit-undo-1");
  });
});
