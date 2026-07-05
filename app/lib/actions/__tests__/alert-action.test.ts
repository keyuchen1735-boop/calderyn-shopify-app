import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeInventoryAlertAction } from "../alert-action.server";
import { CalderynError } from "../../calderyn.server";

const inventoryAdjustQuantities = vi.hoisted(() => vi.fn());
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));
const acknowledgeAlert = vi.hoisted(() => vi.fn());
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));
const snoozeAlert = vi.hoisted(() => vi.fn());
vi.mock("../snooze.server", () => ({
  snoozeAlert: (...a: unknown[]) => snoozeAlert(...a),
}));
const getOrgMode = vi.hoisted(() => vi.fn());
vi.mock("../../cutover/org-mode.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getOrgMode: (...a: unknown[]) => getOrgMode(...a),
}));
const resolveOwnedMoveTarget = vi.hoisted(() => vi.fn());
const applyOwnedInventoryMove = vi.hoisted(() => vi.fn());
vi.mock("../owned-writes.server", () => ({
  resolveOwnedMoveTarget: (...a: unknown[]) => resolveOwnedMoveTarget(...a),
  applyOwnedInventoryMove: (...a: unknown[]) => applyOwnedInventoryMove(...a),
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
    dollar_impact: 1_200_000, // cents ($12,000) — alert.dollar_impact is cents
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

const alertsGet = vi.hoisted(() => vi.fn());
const guardrailsGet = vi.hoisted(() => vi.fn());
const actionsExecute = vi.hoisted(() => vi.fn());
const client = {
  alerts: { get: (...a: unknown[]) => alertsGet(...a) },
  guardrails: { get: (...a: unknown[]) => guardrailsGet(...a) },
  actions: { execute: (...a: unknown[]) => actionsExecute(...a) },
} as never;

const ADMIN = { graphql: vi.fn() };

// sb stub that handles the sku_dim lookup for sku_id resolution.
// All other tables return null so existing test assertions are unaffected.
function makeSb(skuDimId: string | null = null) {
  function builder(table: string) {
    const chain: Record<string, unknown> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({
      data: table === "sku_dim" && skuDimId ? { id: skuDimId } : null,
      error: null,
    }));
    return chain;
  }
  return { from: vi.fn((t: string) => builder(t)) } as never;
}
const SB = makeSb();

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
  // Both values are cents. Default cap $20,000 (2,000,000c) comfortably clears
  // the default $12,000 alert impact (1,200,000c) so proceed-path tests proceed.
  guardrailsGet.mockResolvedValue({ dollar_cap_cents: 2_000_000 });
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/1" });
  actionsExecute.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
  acknowledgeAlert.mockResolvedValue(true);
  snoozeAlert.mockResolvedValue(true);
  getOrgMode.mockResolvedValue("mirror");
  resolveOwnedMoveTarget.mockResolvedValue({
    variantId: "var-1",
    fromLocationId: "loc-9",
    toLocationId: "loc-2",
  });
  applyOwnedInventoryMove.mockResolvedValue({ transferId: "tr-1" });
});

describe("executeInventoryAlertAction — org_mode routing", () => {
  it("mirror: never touches the owned engine", async () => {
    await run("reallocate_inventory");
    expect(applyOwnedInventoryMove).not.toHaveBeenCalled();
    expect(resolveOwnedMoveTarget).not.toHaveBeenCalled();
  });

  it("live: moves stock via the owned engine, never Shopify, with owned undo markers", async () => {
    getOrgMode.mockResolvedValue("live");
    await run("reallocate_inventory");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(applyOwnedInventoryMove).toHaveBeenCalledWith({
      shopId: "shop-1",
      variantId: "var-1",
      fromLocationId: "loc-9",
      toLocationId: "loc-2",
      quantity: 21,
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          owned: true,
          owned_transfer_id: "tr-1",
          owned_variant_id: "var-1",
          shopify_operation_id: "tr-1",
        }),
        writeTarget: "owned_sot",
      }),
    );
  });

  it("live: moves stock with a null admin (owned-native shop, no connected Shopify store)", async () => {
    getOrgMode.mockResolvedValue("live");
    // An owned-native shop has no Shopify session, so the route passes admin: null.
    // The owned branch must never touch it.
    const res = await run("reallocate_inventory", { admin: null });
    expect(res.outcome).toBe("succeeded");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(applyOwnedInventoryMove).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: "var-1", quantity: 21 }),
    );
  });

  it("mirror: a null admin fails with shopify_required rather than dereferencing null", async () => {
    getOrgMode.mockResolvedValue("mirror");
    await expect(run("reallocate_inventory", { admin: null })).rejects.toMatchObject({
      code: "shopify_required",
      status: 422,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).not.toHaveBeenCalled();
  });

  it("live: 422s when the plan's refs aren't linked to the owned store", async () => {
    getOrgMode.mockResolvedValue("live");
    resolveOwnedMoveTarget.mockResolvedValue(null);
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "invalid_inventory_evidence",
      status: 422,
    });
    expect(applyOwnedInventoryMove).not.toHaveBeenCalled();
    expect(actionsExecute).not.toHaveBeenCalled();
  });

  it("dual_run: writes Shopify AND mirrors into the owned engine", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    await run("reallocate_inventory");
    expect(inventoryAdjustQuantities).toHaveBeenCalled();
    expect(applyOwnedInventoryMove).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: "var-1", quantity: 21 }),
    );
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          dual_write: "ok",
          owned_transfer_id: "tr-1",
          shopify_operation_id: "gid://op/1",
        }),
        writeTarget: "shopify_admin", // Shopify authoritative in dual_run
      }),
    );
  });

  it("dual_run: a failed owned mirror never fails the action, recorded on the audit", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    applyOwnedInventoryMove.mockRejectedValue(new Error("insufficient_stock"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await run("reallocate_inventory");
      expect(res.outcome).toBe("succeeded");
    } finally {
      consoleError.mockRestore();
    }
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ dual_write: "failed: insufficient_stock" }),
      }),
    );
  });

  it("dual_run: unlinked refs record a skipped mirror, action still succeeds", async () => {
    getOrgMode.mockResolvedValue("dual_run");
    resolveOwnedMoveTarget.mockResolvedValue(null);
    const res = await run("reallocate_inventory");
    expect(res.outcome).toBe("succeeded");
    expect(applyOwnedInventoryMove).not.toHaveBeenCalled();
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ dual_write: "skipped_unlinked" }),
      }),
    );
  });
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

  it("compares impact to the cap in matching units (both cents)", async () => {
    // alert.dollar_impact and dollar_cap_cents are BOTH cents. A $600 impact
    // (60,000c) exceeds a $500 cap (50,000c) → blocked.
    alertsGet.mockResolvedValue(makeAlert({ dollar_impact: 60000 }));
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 50000 }); // $500
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "guardrail_dollar_cap",
      status: 403,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("proceeds when impact is within the cap — does NOT 100x-inflate it", async () => {
    // Regression: a $4,515 impact (451,538c) must clear a $25,000 cap
    // (2,500,000c). The old `* 100` inflated it to a notional $451,538 and
    // wrongly tripped the cap on every action once a realistic cap was set.
    alertsGet.mockResolvedValue(makeAlert({ dollar_impact: 451538 }));
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 2_500_000 }); // $25,000
    const res = await run("reallocate_inventory");
    expect(res.outcome).toBe("succeeded");
    expect(inventoryAdjustQuantities).toHaveBeenCalled();
  });

  it("allows an action whose impact is within the cap", async () => {
    alertsGet.mockResolvedValue(makeAlert({ dollar_impact: 400 })); // $400 < $500 cap
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 50000 });
    await expect(run("reallocate_inventory")).resolves.toMatchObject({ outcome: "succeeded" });
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
  it("audits a snooze, defers the alert, and never acknowledges it", async () => {
    const res = await run("snooze_alert");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "al-1", kind: "snooze_alert" }),
    );
    // Snooze hides the alert (status -> snoozed + deadline) instead of closing it.
    expect(snoozeAlert).toHaveBeenCalledWith(SB, "shop-1", "al-1");
    // Snooze is a deferral, not a resolution — never acknowledge.
    expect(acknowledgeAlert).not.toHaveBeenCalled();
    expect(res).toEqual({ auditId: "audit-1", outcome: "succeeded", acknowledged: false });
  });

  it("is exempt from the dollar cap (harmless action)", async () => {
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 1 });
    await expect(run("snooze_alert")).resolves.toMatchObject({ outcome: "succeeded" });
  });
});

describe("alert status gate", () => {
  it("refuses to act on a non-open alert (stale UI must not re-fire actions)", async () => {
    alertsGet.mockResolvedValue(makeAlert({ status: "acknowledged" }));
    await expect(run("reallocate_inventory")).rejects.toMatchObject({
      code: "alert_not_open",
      status: 409,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).not.toHaveBeenCalled();
  });

  it("refuses to snooze a resolved alert", async () => {
    alertsGet.mockResolvedValue(makeAlert({ status: "resolved" }));
    await expect(run("snooze_alert")).rejects.toMatchObject({ code: "alert_not_open" });
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

// ── actor / triggerReason / sku_id wiring ──────────────────────────

describe("executeInventoryAlertAction — actor/triggerReason/sku_id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertsGet.mockResolvedValue(makeAlert());
    guardrailsGet.mockResolvedValue({ dollar_cap_cents: 2_000_000 });
    inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://op/1" });
    actionsExecute.mockResolvedValue({ id: "audit-1", outcome: "succeeded" });
    acknowledgeAlert.mockResolvedValue(true);
    snoozeAlert.mockResolvedValue(true);
  });

  it("passes actor='autopilot' to actions.execute", async () => {
    const sbSku = makeSb("sku-dim-1");
    await executeInventoryAlertAction({
      client,
      admin: ADMIN,
      sb: sbSku,
      shopId: "shop-1",
      alertId: "al-1",
      kind: "reallocate_inventory",
      idempotencyKey: "idem-1",
      actor: "autopilot",
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "autopilot" }),
    );
  });

  it("passes triggerReason to actions.execute when provided", async () => {
    const sbSku = makeSb("sku-dim-1");
    const reason = "Auto-reallocate: Regional shortage — $12,000.00 at stake";
    await executeInventoryAlertAction({
      client,
      admin: ADMIN,
      sb: sbSku,
      shopId: "shop-1",
      alertId: "al-1",
      kind: "reallocate_inventory",
      idempotencyKey: "idem-1",
      actor: "autopilot",
      triggerReason: reason,
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ triggerReason: reason }),
    );
  });

  it("includes sku_id in audit params when sku_dim resolves the alert's sku", async () => {
    const sbSku = makeSb("sku-dim-1");
    await executeInventoryAlertAction({
      client,
      admin: ADMIN,
      sb: sbSku,
      shopId: "shop-1",
      alertId: "al-1",
      kind: "reallocate_inventory",
      idempotencyKey: "idem-1",
      actor: "autopilot",
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          sku_id: "sku-dim-1",
          // existing fields must still be present
          inventory_item_id: "gid://shopify/InventoryItem/1",
          delta: 21,
        }),
      }),
    );
  });

  it("omits sku_id when sku_dim returns no row (no partial failure)", async () => {
    const sbNoSku = makeSb(null);
    const res = await executeInventoryAlertAction({
      client,
      admin: ADMIN,
      sb: sbNoSku,
      shopId: "shop-1",
      alertId: "al-1",
      kind: "reallocate_inventory",
      idempotencyKey: "idem-1",
    });
    expect(res.outcome).toBe("succeeded");
    const call = actionsExecute.mock.calls[0][0] as Record<string, unknown>;
    const params = call.params as Record<string, unknown>;
    expect(params.sku_id).toBeUndefined();
  });

  it("omits actor/triggerReason when not passed — manual call path unchanged", async () => {
    const sbSku = makeSb("sku-dim-1");
    await executeInventoryAlertAction({
      client,
      admin: ADMIN,
      sb: sbSku,
      shopId: "shop-1",
      alertId: "al-1",
      kind: "reallocate_inventory",
      idempotencyKey: "idem-1",
    });
    const call = actionsExecute.mock.calls[0][0] as Record<string, unknown>;
    expect(call.actor).toBeUndefined();
    expect(call.triggerReason).toBeUndefined();
  });
});
