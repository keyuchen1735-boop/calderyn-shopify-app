import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeInventoryAlertAction } from "../alert-action.server";
import { CalderynError } from "../../calderyn.server";

const inventoryAdjustQuantities = vi.fn();
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));
const acknowledgeAlert = vi.fn();
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));

const TRANSFER_EVIDENCE = {
  inventory_item_id: "gid://shopify/InventoryItem/1",
  from_location_id: "gid://shopify/Location/9",
  to_location_id: "gid://shopify/Location/2",
  recommended_delta: 21,
};

function makeAlert(overrides: Record<string, unknown> = {}) {
  return {
    id: "al-1",
    detector_id: "regional_spend_starved_stock",
    severity: "high",
    status: "open",
    dollar_impact: 12000,
    claude_rank: 1,
    created_at: "2026-06-12T00:00:00Z",
    title: "Starved region",
    narrative: "",
    campaign: null,
    sku: "PP-1",
    evidence: TRANSFER_EVIDENCE,
    ...overrides,
  };
}

const alertsGet = vi.fn();
const guardrailsGet = vi.fn();
const actionsExecute = vi.fn();
const client = {
  alerts: { get: (...a: unknown[]) => alertsGet(...a) },
  guardrails: { get: (...a: unknown[]) => guardrailsGet(...a) },
  actions: { execute: (...a: unknown[]) => actionsExecute(...a) },
} as never;

const ADMIN = { graphql: vi.fn() };
const SB = { mocked: true } as never;

function run(kind: "reallocate_inventory" | "snooze_alert", over: Record<string, unknown> = {}) {
  return executeInventoryAlertAction({
    client,
    admin: ADMIN,
    sb: SB,
    shopId: "shop-1",
    alertId: "al-1",
    kind,
    idempotencyKey: "idem-1",
    ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  alertsGet.mockResolvedValue(makeAlert());
  guardrailsGet.mockResolvedValue({ dollar_cap_cents: 50000 });
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/1" });
  actionsExecute.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  acknowledgeAlert.mockResolvedValue(true);
});

describe("executeInventoryAlertAction — reallocate_inventory", () => {
  it("replays the evidence plan into Shopify, audits, and acknowledges", async () => {
    const res = await run("reallocate_inventory");
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(ADMIN, {
      inventoryItemId: "gid://shopify/InventoryItem/1",
      fromLocationId: "gid://shopify/Location/9",
      toLocationId: "gid://shopify/Location/2",
      delta: 21,
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: "al-1",
        kind: "reallocate_inventory",
        idempotencyKey: "idem-1",
        params: expect.objectContaining({
          inventory_item_id: "gid://shopify/InventoryItem/1",
          from_location_id: "gid://shopify/Location/9",
          to_location_id: "gid://shopify/Location/2",
          delta: 21,
          shopify_operation_id: "gid://op/1",
        }),
      }),
    );
    expect(acknowledgeAlert).toHaveBeenCalledWith(SB, "shop-1", "al-1");
    expect(res).toEqual({ auditId: "audit-1", outcome: "succeeded", acknowledged: true });
  });

  it("refuses kinds the detector does not allow, touching nothing", async () => {
    alertsGet.mockResolvedValue(makeAlert({ detector_id: "cogs_drift" }));
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "action_not_allowed",
      status: 403,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).not.toHaveBeenCalled();
  });

  it("enforces the per-action dollar cap", async () => {
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 1000 });
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "guardrail_dollar_cap",
      status: 403,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("422s when the evidence lacks a transfer plan", async () => {
    alertsGet.mockResolvedValue(makeAlert({ evidence: { region: "CA" } }));
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "invalid_inventory_evidence",
      status: 422,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("maps a Shopify failure to action_failed without auditing success", async () => {
    inventoryAdjustQuantities.mockRejectedValue(new Error("location disabled"));
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "action_failed",
      status: 502,
    });
    expect(actionsExecute).not.toHaveBeenCalled();
  });
});

describe("executeInventoryAlertAction — snooze_alert", () => {
  it("audits a snooze without touching Shopify and leaves the alert open", async () => {
    const res = await run("snooze_alert");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "al-1", kind: "snooze_alert" }),
    );
    // Snooze is a deferral, not a resolution — never acknowledge.
    expect(acknowledgeAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ auditId: "audit-1", outcome: "succeeded", acknowledged: false });
  });

  it("is exempt from the dollar cap (harmless action)", async () => {
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 1 });
    await expect(run("snooze_alert")).resolves.toMatchObject({ outcome: "succeeded" });
  });
});

describe("error propagation", () => {
  it("propagates a foreign/missing alert error untouched", async () => {
    alertsGet.mockRejectedValue(
      new CalderynError({ code: "ALERT_NOT_FOUND", status: 404, message: "nope" }),
    );
    await expect(run("snooze_alert")).rejects.toMatchObject({ code: "ALERT_NOT_FOUND" });
    expect(actionsExecute).not.toHaveBeenCalled();
  });
});
