import { describe, it, expect } from "vitest";
import { openAlertsBySku, inventoryAlertActions } from "../inventory-alerts";
import type { Alert } from "../types";

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: "al-1",
    detector_id: "regional_spend_starved_stock",
    severity: "high",
    status: "open",
    dollar_impact: 12000,
    claude_rank: 1,
    created_at: "2026-06-12T00:00:00Z",
    title: "Spend landing on a starved region",
    narrative: "",
    campaign: null,
    sku: "PP-SUMMIT-LOGO-TEE-M",
    evidence: {},
    ...overrides,
  };
}

const TRANSFER_EVIDENCE = {
  inventory_item_id: "gid://shopify/InventoryItem/1",
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  recommended_delta: 21,
};

describe("openAlertsBySku", () => {
  it("groups OPEN alerts by their sku code", () => {
    const map = openAlertsBySku([
      makeAlert({ id: "a", sku: "SKU-1" }),
      makeAlert({ id: "b", sku: "SKU-1" }),
      makeAlert({ id: "c", sku: "SKU-2" }),
    ]);
    expect(map.get("SKU-1")?.map((a) => a.id)).toEqual(["a", "b"]);
    expect(map.get("SKU-2")?.map((a) => a.id)).toEqual(["c"]);
  });

  it("ignores non-open alerts and alerts without a sku", () => {
    const map = openAlertsBySku([
      makeAlert({ id: "a", status: "acknowledged" }),
      makeAlert({ id: "b", status: "resolved" }),
      makeAlert({ id: "c", sku: null }),
    ]);
    expect(map.size).toBe(0);
  });
});

describe("inventoryAlertActions", () => {
  it("offers inline reallocate when the evidence carries a full transfer plan", () => {
    const actions = inventoryAlertActions(makeAlert({ evidence: TRANSFER_EVIDENCE }));
    expect(actions).toContainEqual({ kind: "reallocate_inventory", mode: "execute" });
  });

  it("omits reallocate when the evidence lacks the plan (dead buttons forbidden)", () => {
    const actions = inventoryAlertActions(makeAlert({ evidence: { region: "CA" } }));
    expect(actions.map((a) => a.kind)).not.toContain("reallocate_inventory");
  });

  it("always offers snooze when the detector allows it", () => {
    const actions = inventoryAlertActions(makeAlert());
    expect(actions).toContainEqual({ kind: "snooze_alert", mode: "execute" });
  });

  it("offers create_po_draft as a deep link, never inline", () => {
    const actions = inventoryAlertActions(
      makeAlert({ detector_id: "regional_shortage_risk", evidence: TRANSFER_EVIDENCE }),
    );
    expect(actions).toContainEqual({ kind: "create_po_draft", mode: "link" });
  });

  it("never offers kinds the detector does not allow", () => {
    // cogs_drift allows none of the inventory kinds.
    const actions = inventoryAlertActions(makeAlert({ detector_id: "cogs_drift" }));
    expect(actions.map((a) => a.kind)).not.toContain("reallocate_inventory");
    expect(actions.map((a) => a.kind)).not.toContain("create_po_draft");
  });

  it("accepts dashboard view-model alerts (string detector ids, stringified evidence)", () => {
    const vmAlert = {
      detector_id: "regional_spend_starved_stock" as string,
      evidence: {
        inventory_item_id: "gid://shopify/InventoryItem/1",
        from_location_id: "gid://shopify/Location/9",
        to_location_id: "gid://shopify/Location/2",
        recommended_delta: "21",
      } as Record<string, string>,
    };
    expect(inventoryAlertActions(vmAlert)).toContainEqual({
      kind: "reallocate_inventory",
      mode: "execute",
    });
    expect(inventoryAlertActions({ detector_id: "not_a_detector", evidence: {} })).toEqual([]);
  });

  it("accepts a legacy delta field in place of recommended_delta", () => {
    const actions = inventoryAlertActions(
      makeAlert({ evidence: { ...TRANSFER_EVIDENCE, recommended_delta: undefined, delta: 21 } }),
    );
    expect(actions).toContainEqual({ kind: "reallocate_inventory", mode: "execute" });
  });
});
