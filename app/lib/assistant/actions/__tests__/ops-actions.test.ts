import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../actions/snooze.server", () => ({
  snoozeAlert: vi.fn(async () => true),
}));

vi.mock("../../../actions/autopilot.server", () => ({
  runAutopilotForShop: vi.fn(async () => ({
    skipped: false,
    acted: 1,
    blocked: 0,
    skippedMoves: 0,
    failed: 0,
    considered: 1,
    blockedReasons: {},
    decisions: [],
  })),
}));

vi.mock("../../../actions/undo.server", () => ({
  undoAction: vi.fn(async () => ({ id: "undo-1" })),
}));

vi.mock("../../../actions/refund.server", () => ({
  executeRefundAction: vi.fn(async () => ({
    auditId: "raudit-1",
    outcome: "succeeded" as const,
    refundId: "re_1",
    amountCents: 4250,
    capturedCents: 10000,
    refundedTotalCents: 4250,
    orderState: "partially_refunded" as const,
    replayed: false,
  })),
}));

vi.mock("../../../import/run.server", () => ({
  startImport: vi.fn(async () => ({ importId: "imp-1" })),
  kickDrainSoon: vi.fn(async () => undefined),
}));

vi.mock("../../../dashboard/guardrails-validation", () => ({
  validateGuardrailPatch: vi.fn((patch: Record<string, unknown>) =>
    typeof patch.dollar_cap_cents === "number" && patch.dollar_cap_cents < 0
      ? "invalid_dollar_cap_cents"
      : null,
  ),
}));

const setFeatureAutonomy = vi.fn(async () => ({ ok: true }));
const guardrailsGet = vi.fn(async () => ({ max_price_change_pct: 20, dollar_cap_cents: 50000 }));
const guardrailsUpdate = vi.fn(async (patch: Record<string, unknown>) => ({ ...patch }));
const integrationsDisconnect = vi.fn(async () => undefined);
const consentSet = vi.fn(async () => undefined);

vi.mock("../../../calderyn.server", () => ({
  calderynClient: () => ({
    calibration: { setFeatureAutonomy: (...a: unknown[]) => setFeatureAutonomy(...(a as [])) },
    guardrails: { get: () => guardrailsGet(), update: (...a: unknown[]) => guardrailsUpdate(...(a as [Record<string, unknown>])) },
    integrations: { disconnect: (...a: unknown[]) => integrationsDisconnect(...(a as [])) },
    consent: { set: (...a: unknown[]) => consentSet(...(a as [])) },
  }),
}));

vi.mock("../../../supabase.server", () => ({ getSupabase: () => ({}) }));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { OPS_ACTIONS } from "../ops-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { snoozeAlert } from "../../../actions/snooze.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { runAutopilotForShop } from "../../../actions/autopilot.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { undoAction } from "../../../actions/undo.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { executeRefundAction } from "../../../actions/refund.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { startImport, kickDrainSoon } from "../../../import/run.server";

type OkV = { ok: true; value: Record<string, unknown> };

const byName = (n: string) => OPS_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

describe("ops actions", () => {
  beforeEach(() => {
    vi.mocked(snoozeAlert).mockClear();
    vi.mocked(snoozeAlert).mockResolvedValue(true);
    vi.mocked(runAutopilotForShop).mockClear();
    vi.mocked(undoAction).mockClear();
    vi.mocked(undoAction).mockResolvedValue({ id: "undo-1" });
    vi.mocked(executeRefundAction).mockClear();
    vi.mocked(startImport).mockClear();
    vi.mocked(kickDrainSoon).mockClear();
    setFeatureAutonomy.mockClear();
    setFeatureAutonomy.mockResolvedValue({ ok: true });
    guardrailsGet.mockClear();
    guardrailsUpdate.mockClear();
    integrationsDisconnect.mockClear();
    consentSet.mockClear();
  });

  describe("snooze_alert", () => {
    it("is execute-tier, not undoable, and requires alert_id", () => {
      const a = byName("snooze_alert");
      expect(a.tier).toBe("execute");
      expect(a.undoable).toBe(false);
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ alert_id: "a1" }).ok).toBe(true);
    });

    it("calls snoozeAlert(sb, shopId, alertId) and the summary mentions tomorrow/auto-resurface", async () => {
      const a = byName("snooze_alert");
      const receipt = await a.run(ctx, { alert_id: "a1" });
      expect(vi.mocked(snoozeAlert)).toHaveBeenCalledWith(expect.anything(), "shop-1", "a1");
      expect(receipt.summary).toMatch(/tomorrow/i);
      expect(receipt.summary).toMatch(/auto-resurface/i);
      expect(receipt.undoable).toBe(false);
    });

    it("throws when snoozeAlert reports failure", async () => {
      vi.mocked(snoozeAlert).mockResolvedValueOnce(false);
      const a = byName("snooze_alert");
      await expect(a.run(ctx, { alert_id: "a1" })).rejects.toThrow();
    });
  });

  describe("run_autopilot_now", () => {
    it("run_autopilot_now returns the AutopilotSummary in receipt.detail", async () => {
      const r = await byName("run_autopilot_now").run(ctx, {});
      expect(r.detail).toBeDefined();
      expect(r.detail).toMatchObject({ acted: 1, blocked: 0, failed: 0, considered: 1 });
    });

    it("calls runAutopilotForShop with shopId and a supabase client", async () => {
      await byName("run_autopilot_now").run(ctx, {});
      expect(vi.mocked(runAutopilotForShop)).toHaveBeenCalledWith("shop-1", expect.anything());
    });
  });

  describe("undo_action", () => {
    it("surfaces undoAction's refusal message verbatim", async () => {
      vi.mocked(undoAction).mockRejectedValueOnce(new Error("issue_refund actions cannot be undone"));
      await expect(byName("undo_action").run(ctx, { audit_id: "a1" })).rejects.toThrow(/cannot be undone/);
    });

    it("calls undoAction(shopId, auditId, sb, {})", async () => {
      await byName("undo_action").run(ctx, { audit_id: "a1" });
      expect(vi.mocked(undoAction)).toHaveBeenCalledWith("shop-1", "a1", expect.anything(), {});
    });

    it("is execute-tier", () => {
      expect(byName("undo_action").tier).toBe("execute");
    });
  });

  describe("toggle_feature_autonomy", () => {
    it("requires detector_id, action_kind, enabled", () => {
      const a = byName("toggle_feature_autonomy");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ detector_id: "d1", action_kind: "pause_campaign", enabled: true }).ok).toBe(true);
    });

    it("calls calibration.setFeatureAutonomy with detector/action/enabled", async () => {
      const a = byName("toggle_feature_autonomy");
      await a.run(ctx, { detector_id: "d1", action_kind: "pause_campaign", enabled: true });
      expect(setFeatureAutonomy).toHaveBeenCalledWith("d1", "pause_campaign", true);
    });

    it("throws when the update fails", async () => {
      setFeatureAutonomy.mockResolvedValueOnce({ ok: false });
      const a = byName("toggle_feature_autonomy");
      await expect(a.run(ctx, { detector_id: "d1", action_kind: "pause_campaign", enabled: true })).rejects.toThrow();
    });

    it("is execute-tier", () => {
      expect(byName("toggle_feature_autonomy").tier).toBe("execute");
    });
  });

  describe("start_import", () => {
    it("is execute-tier and takes no required input", () => {
      const a = byName("start_import");
      expect(a.tier).toBe("execute");
      expect(a.validate({}).ok).toBe(true);
    });

    it("calls startImport then kickDrainSoon", async () => {
      await byName("start_import").run(ctx, {});
      expect(vi.mocked(startImport)).toHaveBeenCalledWith("shop-1");
      expect(vi.mocked(kickDrainSoon)).toHaveBeenCalled();
    });
  });

  describe("set_peer_consent", () => {
    it("requires a boolean consent field", () => {
      const a = byName("set_peer_consent");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ consent: "yes" }).ok).toBe(false);
      expect(a.validate({ consent: true }).ok).toBe(true);
    });

    it("calls consent.set(true) when consent is true", async () => {
      await byName("set_peer_consent").run(ctx, { consent: true });
      expect(consentSet).toHaveBeenCalledWith(true);
    });

    it("is execute-tier", () => {
      expect(byName("set_peer_consent").tier).toBe("execute");
    });
  });

  describe("issue_refund", () => {
    it("issue_refund is confirm-tier; summary states the dollar amount and irreversibility", async () => {
      const a = byName("issue_refund");
      expect(a.tier).toBe("confirm");
      const s = await a.confirmSummary!(ctx, { order_id: "o1", amount_cents: 4250 });
      expect(s).toMatch(/\$42\.50/);
      expect(s).toMatch(/cannot be undone/i);
    });

    it("issue_refund with no amount_cents means full remaining refund and says so", async () => {
      const s = await byName("issue_refund").confirmSummary!(ctx, { order_id: "o1" });
      expect(s).toMatch(/full remaining/i);
    });

    it("issue_refund run passes idempotencyKey and actor merchant:assistant", async () => {
      await byName("issue_refund").run(ctx, { order_id: "o1", amount_cents: 4250 });
      expect(vi.mocked(executeRefundAction)).toHaveBeenCalledWith(
        "shop-1",
        expect.objectContaining({ orderId: "o1", amountCents: 4250, idempotencyKey: "ik-1", actor: "merchant:assistant" }),
        expect.anything(),
      );
    });

    it("issue_refund receipt is not undoable and carries auditId from result.auditId", async () => {
      const r = await byName("issue_refund").run(ctx, { order_id: "o1", amount_cents: 4250 });
      expect(r.undoable).toBe(false);
      expect(r.auditId).toBe("raudit-1");
    });

    it("validates order_id is required, amount_cents (if present) is a positive int, reason <= 300 chars", () => {
      const a = byName("issue_refund");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ order_id: "o1", amount_cents: -5 }).ok).toBe(false);
      expect(a.validate({ order_id: "o1", reason: "x".repeat(301) }).ok).toBe(false);
      expect(a.validate({ order_id: "o1" }).ok).toBe(true);
      expect(a.validate({ order_id: "o1", amount_cents: 500, reason: "wrong size" }).ok).toBe(true);
    });
  });

  describe("update_guardrails", () => {
    it("drops non-patchable keys and refuses an invalid patch", () => {
      const a = byName("update_guardrails");
      const v = a.validate({ patch: { autopilot_enabled: true, evil_key: 1 } });
      expect(v.ok).toBe(true);
      expect((v as OkV).value.patch).toEqual({ autopilot_enabled: true });
      // validateGuardrailPatch mocked to return "invalid_dollar_cap_cents":
      expect(a.validate({ patch: { dollar_cap_cents: -5 } }).ok).toBe(false);
    });

    it("refuses an empty patch", () => {
      const a = byName("update_guardrails");
      expect(a.validate({ patch: {} }).ok).toBe(false);
      expect(a.validate({ patch: { evil_key: 1 } }).ok).toBe(false);
    });

    it("is confirm-tier and the summary names the keys being changed", async () => {
      const a = byName("update_guardrails");
      expect(a.tier).toBe("confirm");
      const s = await a.confirmSummary!(ctx, { patch: { autopilot_enabled: true } });
      expect(s).toMatch(/autopilot_enabled/);
    });

    it("run calls guardrails.update with the filtered patch", async () => {
      const a = byName("update_guardrails");
      await a.run(ctx, { patch: { autopilot_enabled: true } });
      expect(guardrailsUpdate).toHaveBeenCalledWith({ autopilot_enabled: true });
    });
  });

  describe("disconnect_integration", () => {
    it("is confirm-tier and requires provider", () => {
      const a = byName("disconnect_integration");
      expect(a.tier).toBe("confirm");
      expect(a.validate({}).ok).toBe(false);
      expect(a.validate({ provider: "meta" }).ok).toBe(true);
    });

    it("confirmSummary names the provider and says ingestion stops", async () => {
      const a = byName("disconnect_integration");
      const s = await a.confirmSummary!(ctx, { provider: "meta" });
      expect(s).toMatch(/meta/);
      expect(s).toMatch(/ingestion stops/i);
    });

    it("run calls integrations.disconnect with the provider", async () => {
      const a = byName("disconnect_integration");
      await a.run(ctx, { provider: "meta" });
      expect(integrationsDisconnect).toHaveBeenCalledWith("meta");
    });
  });

  it("every OPS_ACTIONS entry has the expected tier", () => {
    const executeNames = [
      "snooze_alert",
      "run_autopilot_now",
      "undo_action",
      "toggle_feature_autonomy",
      "start_import",
      "set_peer_consent",
    ];
    const confirmNames = ["issue_refund", "update_guardrails", "disconnect_integration"];
    for (const n of executeNames) expect(byName(n).tier).toBe("execute");
    for (const n of confirmNames) expect(byName(n).tier).toBe("confirm");
  });
});
