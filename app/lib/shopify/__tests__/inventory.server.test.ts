import { describe, it, expect, vi } from "vitest";
import { inventoryAdjustQuantities, type AdminGraphqlClient } from "../inventory.server";

// Both relocate paths (merchant-initiated executeInventoryRelocation and the
// alert-driven executeInventoryAlertAction) funnel through this one function, so
// a malformed Shopify GID must be rejected HERE — with a clear error, before the
// mutation — rather than reaching Shopify as a raw "Invalid global id" parse
// error the merchant sees in the audit log. Regression guard for P0-2.

function okAdmin(): { admin: AdminGraphqlClient; graphql: ReturnType<typeof vi.fn> } {
  const graphql = vi.fn(async () => ({
    json: async () => ({
      data: {
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/9" },
          userErrors: [],
        },
      },
    }),
  }));
  return { admin: { graphql } as unknown as AdminGraphqlClient, graphql };
}

const VALID = {
  inventoryItemId: "gid://shopify/InventoryItem/300",
  fromLocationId: "gid://shopify/Location/7001",
  toLocationId: "gid://shopify/Location/7002",
  delta: 40,
};

describe("inventoryAdjustQuantities — GID validation", () => {
  it("rejects a malformed inventory item id before calling Shopify", async () => {
    const { admin, graphql } = okAdmin();
    await expect(
      inventoryAdjustQuantities(admin, { ...VALID, inventoryItemId: "invitem-summit-logo-tee-M" }),
    ).rejects.toThrow(/inventory item|InventoryItem|global id/i);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("rejects a malformed source location id before calling Shopify", async () => {
    const { admin, graphql } = okAdmin();
    await expect(
      inventoryAdjustQuantities(admin, { ...VALID, fromLocationId: "loc-reno-nv" }),
    ).rejects.toThrow(/location|Location|global id/i);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("rejects a wrong-type GID (a Product gid where an InventoryItem is expected)", async () => {
    const { admin, graphql } = okAdmin();
    await expect(
      inventoryAdjustQuantities(admin, { ...VALID, inventoryItemId: "gid://shopify/Product/300" }),
    ).rejects.toThrow(/InventoryItem|inventory item|global id/i);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("performs the adjustment when all GIDs are well-formed", async () => {
    const { admin, graphql } = okAdmin();
    const res = await inventoryAdjustQuantities(admin, VALID);
    expect(res.operationId).toBe("gid://shopify/InventoryAdjustmentGroup/9");
    expect(graphql).toHaveBeenCalledTimes(1);
  });
});
