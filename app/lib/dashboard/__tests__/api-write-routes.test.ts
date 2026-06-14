import { describe, it, expect, vi, beforeEach } from "vitest";

import { action as campaignAction } from "../../../routes/dashboard.api.campaigns.$id.action";
import { action as alertAction } from "../../../routes/dashboard.api.alerts.$id.action";
import { action as undoRoute } from "../../../routes/dashboard.api.audit.$id.undo";
import { action as guardrailsAction } from "../../../routes/dashboard.api.guardrails";
import { action as consentAction } from "../../../routes/dashboard.api.consent";
import { action as logoutAction } from "../../../routes/dashboard.api.logout";

const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();
const executeAction = vi.fn();
const undoAction = vi.fn();
const guardrailsGet = vi.fn();
const guardrailsUpdate = vi.fn();
const consentSet = vi.fn();
const revokeSession = vi.fn();
const alertsGet = vi.fn();
const actionsExecute = vi.fn();
const inventoryAdjustQuantities = vi.fn();
const acknowledgeAlert = vi.fn();
const snoozeAlert = vi.fn();
const unauthenticatedAdmin = vi.fn();

vi.mock("../session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../session.server")>()),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
  revokeSession: (...a: unknown[]) => revokeSession(...a),
}));
vi.mock("../http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../http.server")>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../actions/execute.server", () => ({
  executeAction: (...a: unknown[]) => executeAction(...a),
}));
vi.mock("../../actions/undo.server", () => ({
  undoAction: (...a: unknown[]) => undoAction(...a),
}));
vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ mocked: true }),
  resolveShopId: vi.fn(async () => "shop-1"),
}));
vi.mock("../../calderyn.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../../calderyn.server")>();
  return {
    ...orig,
    calderynClient: () => ({
      guardrails: {
        get: (...a: unknown[]) => guardrailsGet(...a),
        update: (...a: unknown[]) => guardrailsUpdate(...a),
      },
      consent: {
        set: (...a: unknown[]) => consentSet(...a),
      },
      alerts: {
        get: (...a: unknown[]) => alertsGet(...a),
      },
      actions: {
        execute: (...a: unknown[]) => actionsExecute(...a),
      },
    }),
  };
});
vi.mock("../../shopify/inventory.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shopify/inventory.server")>()),
  inventoryAdjustQuantities: (...a: unknown[]) => inventoryAdjustQuantities(...a),
}));
vi.mock("../../alerts.server", () => ({
  acknowledgeAlert: (...a: unknown[]) => acknowledgeAlert(...a),
}));
// Export both so session.server's `import { resurfaceAllSnoozes }` still resolves.
vi.mock("../../actions/snooze.server", () => ({
  snoozeAlert: (...a: unknown[]) => snoozeAlert(...a),
  resurfaceAllSnoozes: vi.fn(),
}));
vi.mock("../../../shopify.server", () => ({
  unauthenticated: { admin: (...a: unknown[]) => unauthenticatedAdmin(...a) },
}));

// Mirrors the transfer plan the regional_spend_starved_stock detector emits
// into alert evidence (engine commit e3238b5).
const TRANSFER_EVIDENCE = {
  region: "US-TX",
  inventory_item_id: "gid://shopify/InventoryItem/123",
  from_location_id: "gid://shopify/Location/77",
  to_location_id: "gid://shopify/Location/88",
  recommended_delta: 21,
};

function makeAlert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    detector_id: "regional_spend_starved_stock",
    dollar_impact: 50_000,
    sku: "SKU-1",
    campaign: null,
    status: "open",
    evidence: TRANSFER_EVIDENCE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireDashboardSession.mockResolvedValue({
    shopId: "shop-1",
    shopDomain: "x.myshopify.com",
    sessionId: "sess-1",
  });
  guardrailsGet.mockResolvedValue({ dollar_cap_cents: 100_000_000, cooldown_minutes: 30 });
  alertsGet.mockResolvedValue(makeAlert());
  actionsExecute.mockResolvedValue({ id: "audit-inv-1" });
  inventoryAdjustQuantities.mockResolvedValue({ operationId: "gid://shopify/InventoryAdjustmentGroup/9" });
  acknowledgeAlert.mockResolvedValue(true);
  snoozeAlert.mockResolvedValue(true);
  unauthenticatedAdmin.mockResolvedValue({ admin: { graphql: vi.fn() } });
});

function post(url: string, body: unknown, method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", Origin: "https://calderyncompany.com" },
    body: JSON.stringify(body),
  });
}

describe("POST /dashboard/api/campaigns/:id/action", () => {
  it("executes a pause through the shared action pipeline", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-1", outcome: "succeeded" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "key-1",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-1", outcome: "succeeded" });
    expect(executeAction).toHaveBeenCalledWith(
      "shop-1",
      expect.objectContaining({
        kind: "pause_campaign",
        campaignId: "c1",
        idempotencyKey: "key-1",
        actor: "merchant:web-dashboard",
      }),
      expect.anything(),
    );
  });

  it("422s on a bad action type and on a missing budget for budget changes", async () => {
    for (const body of [
      { type: "delete_campaign", idempotency_key: "k" },
      { type: "reduce_campaign_budget", idempotency_key: "k" },
    ]) {
      const res = (await campaignAction({
        request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", body),
        params: { id: "c1" },
        context: {},
      })) as Response;
      expect(res.status).toBe(422);
    }
    expect(executeAction).not.toHaveBeenCalled();
  });

  it("returns 502 with the audit id when the platform call failed", async () => {
    executeAction.mockResolvedValueOnce({ id: "audit-2", outcome: "failed" });
    const res = (await campaignAction({
      request: post("https://calderyncompany.com/dashboard/api/campaigns/c1/action", {
        type: "pause_campaign",
        idempotency_key: "k2",
      }),
      params: { id: "c1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: "action_failed",
      audit_id: "audit-2",
      outcome: "failed",
    });
  });
});

describe("POST /dashboard/api/alerts/:id/action", () => {
  const url = "https://calderyncompany.com/dashboard/api/alerts/a1/action";
  const body = { type: "reallocate_inventory", idempotency_key: "key-inv-1" };

  it("executes the transfer Shopify mutation from the alert's evidence, audits, and acknowledges", async () => {
    const res = (await alertAction({
      request: post(url, body),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-inv-1",
      outcome: "succeeded",
      acknowledged: true,
    });
    // Mutation inputs must come from the trusted alert record, not the request body.
    expect(unauthenticatedAdmin).toHaveBeenCalledWith("x.myshopify.com");
    expect(inventoryAdjustQuantities).toHaveBeenCalledWith(expect.anything(), {
      inventoryItemId: "gid://shopify/InventoryItem/123",
      fromLocationId: "gid://shopify/Location/77",
      toLocationId: "gid://shopify/Location/88",
      delta: 21,
    });
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        alertId: "a1",
        kind: "reallocate_inventory",
        idempotencyKey: "key-inv-1",
        params: expect.objectContaining({
          inventory_item_id: "gid://shopify/InventoryItem/123",
          from_location_id: "gid://shopify/Location/77",
          to_location_id: "gid://shopify/Location/88",
          delta: 21,
          shopify_operation_id: "gid://shopify/InventoryAdjustmentGroup/9",
        }),
      }),
    );
    expect(acknowledgeAlert).toHaveBeenCalledWith(expect.anything(), "shop-1", "a1");
  });

  it("defers via snooze — no Shopify mutation, no guardrail, hides instead of acknowledging", async () => {
    const res = (await alertAction({
      request: post(url, { type: "snooze_alert", idempotency_key: "key-snooze-1" }),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      audit_id: "audit-inv-1",
      outcome: "succeeded",
      acknowledged: false,
    });
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(guardrailsGet).not.toHaveBeenCalled();
    // Snooze hides the alert (status -> snoozed + deadline) rather than closing it.
    expect(acknowledgeAlert).not.toHaveBeenCalled();
    expect(snoozeAlert).toHaveBeenCalledWith(expect.anything(), "shop-1", "a1");
    expect(actionsExecute).toHaveBeenCalledWith(
      expect.objectContaining({ alertId: "a1", kind: "snooze_alert" }),
    );
  });

  it("422s with invalid_inventory_evidence when the alert lacks a transfer plan, without mutating", async () => {
    alertsGet.mockResolvedValueOnce(makeAlert({ evidence: { region: "US-TX" } }));
    const res = (await alertAction({
      request: post(url, body),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_inventory_evidence");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
    expect(actionsExecute).not.toHaveBeenCalled();
  });

  it("403s when the alert's detector does not expose reallocate_inventory", async () => {
    alertsGet.mockResolvedValueOnce(makeAlert({ detector_id: "campaign_below_breakeven" }));
    const res = (await alertAction({
      request: post(url, body),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("action_not_allowed");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("403s when the alert's impact exceeds the guardrail dollar cap", async () => {
    guardrailsGet.mockResolvedValueOnce({ dollar_cap_cents: 1_000 });
    const res = (await alertAction({
      request: post(url, body),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("guardrail_dollar_cap");
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("422s on an unsupported action type and a missing idempotency key", async () => {
    for (const bad of [
      { type: "pause_campaign", idempotency_key: "k" },
      { type: "reallocate_inventory" },
    ]) {
      const res = (await alertAction({
        request: post(url, bad),
        params: { id: "a1" },
        context: {},
      })) as Response;
      expect(res.status).toBe(422);
    }
    expect(inventoryAdjustQuantities).not.toHaveBeenCalled();
  });

  it("502s as action_failed when the Shopify mutation throws, without writing an audit row", async () => {
    inventoryAdjustQuantities.mockRejectedValueOnce(new Error("THROTTLED: try later"));
    const res = (await alertAction({
      request: post(url, body),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("action_failed");
    expect(actionsExecute).not.toHaveBeenCalled();
    expect(acknowledgeAlert).not.toHaveBeenCalled();
  });

  it("405s non-POST methods", async () => {
    const res = (await alertAction({
      request: post(url, body, "PUT"),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(405);
  });
});

describe("PUT /dashboard/api/guardrails", () => {
  it("applies the patch via calderynClient.guardrails.update", async () => {
    guardrailsUpdate.mockResolvedValueOnce({ cooldown_minutes: 45 });
    const res = (await guardrailsAction({
      request: post(
        "https://calderyncompany.com/dashboard/api/guardrails",
        { cooldown_minutes: 45 },
        "PUT",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(guardrailsUpdate).toHaveBeenCalledWith({ cooldown_minutes: 45 });
  });

  it("405s non-PUT methods", async () => {
    const res = (await guardrailsAction({
      request: post("https://calderyncompany.com/dashboard/api/guardrails", {}, "PATCH"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(405);
  });

  it.each([
    ["zero budget", { daily_action_budget_cents: 0 }],
    ["negative cap", { dollar_cap_cents: -100 }],
    ["non-numeric budget", { daily_action_budget_cents: "lots" }],
    ["negative cooldown", { cooldown_minutes: -5 }],
  ])("422s on %s and never calls update (parity with onboarding guard)", async (_label, patch) => {
    const res = (await guardrailsAction({
      request: post("https://calderyncompany.com/dashboard/api/guardrails", patch, "PUT"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_guardrails");
    expect(guardrailsUpdate).not.toHaveBeenCalled();
  });

  it("accepts a zero cooldown and an autopilot-only patch (no budget/cap to validate)", async () => {
    guardrailsUpdate.mockResolvedValueOnce({ cooldown_minutes: 0 });
    const res = (await guardrailsAction({
      request: post(
        "https://calderyncompany.com/dashboard/api/guardrails",
        { cooldown_minutes: 0, autopilot_enabled: true },
        "PUT",
      ),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(guardrailsUpdate).toHaveBeenCalledWith({ cooldown_minutes: 0, autopilot_enabled: true });
  });
});

describe("PUT /dashboard/api/consent", () => {
  it("sets consent and echoes the new value (parity with embedded toggle)", async () => {
    consentSet.mockResolvedValueOnce(undefined);
    const res = (await consentAction({
      request: post("https://calderyncompany.com/dashboard/api/consent", { consent: true }, "PUT"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ consent: true });
    expect(consentSet).toHaveBeenCalledWith(true);
  });

  it("422s when consent is not a boolean and never writes", async () => {
    const res = (await consentAction({
      request: post("https://calderyncompany.com/dashboard/api/consent", { consent: "yes" }, "PUT"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("invalid_consent");
    expect(consentSet).not.toHaveBeenCalled();
  });

  it("405s non-PUT methods", async () => {
    const res = (await consentAction({
      request: post("https://calderyncompany.com/dashboard/api/consent", { consent: true }, "POST"),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(405);
  });
});

describe("POST /dashboard/api/audit/:id/undo", () => {
  it("delegates to undoAction with the session's shop", async () => {
    undoAction.mockResolvedValueOnce({ id: "audit-3" });
    const res = (await undoRoute({
      request: post("https://calderyncompany.com/dashboard/api/audit/a1/undo", {}),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-3" });
    expect(undoAction).toHaveBeenCalledWith(
      "shop-1",
      "a1",
      expect.anything(),
      // inventory undos need a Shopify admin client; the route passes one through
      expect.objectContaining({ admin: expect.anything() }),
    );
  });

  it("still performs campaign undos when no offline Shopify session exists", async () => {
    // Admin construction is best-effort: only inventory undos need it, and the
    // executor refuses those loudly itself when admin is missing.
    unauthenticatedAdmin.mockRejectedValueOnce(new Error("no offline session"));
    undoAction.mockResolvedValueOnce({ id: "audit-4" });
    const res = (await undoRoute({
      request: post("https://calderyncompany.com/dashboard/api/audit/a1/undo", {}),
      params: { id: "a1" },
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ audit_id: "audit-4" });
    expect(undoAction).toHaveBeenCalledWith("shop-1", "a1", expect.anything(), {
      admin: undefined,
    });
  });
});

describe("POST /dashboard/api/logout", () => {
  it("revokes the session and clears the cookie", async () => {
    const res = (await logoutAction({
      request: post("https://calderyncompany.com/dashboard/api/logout", {}),
      params: {},
      context: {},
    })) as Response;
    expect(res.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith("sess-1");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
