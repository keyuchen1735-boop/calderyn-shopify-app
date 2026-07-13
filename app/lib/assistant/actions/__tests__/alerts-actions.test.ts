import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../actions/po-action.server", () => ({
  executeCreatePoDraft: vi.fn(async () => ({
    auditId: "audit-po-1",
    outcome: "succeeded" as const,
    acknowledged: true,
  })),
}));

const mockAlertsGet = vi.fn(async () => ({
  detector_id: "reorder_timing",
  campaign_id: null,
  dollar_impact: 1234,
}));
const mockRecordRejection = vi.fn(async () => ({
  reflection: "ok",
  delta: 0,
  before: {},
  after: {},
  savedAsRule: false,
}));

vi.mock("../../../calderyn.server", () => ({
  calderynClient: vi.fn(() => ({
    alerts: { get: mockAlertsGet },
    calibration: { recordRejection: mockRecordRejection },
  })),
}));

vi.mock("../../../labels", () => ({
  recommendedAction: vi.fn(() => "create_po_draft"),
}));

vi.mock("../../../calibration/mute-guard", () => ({
  muteConfirmationMessage: vi.fn(() => null),
}));

vi.mock("../../../supabase.server", () => ({ getSupabase: () => ({}) }));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { ALERTS_ACTIONS } from "../alerts-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import * as poModule from "../../../actions/po-action.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import * as calderynModule from "../../../calderyn.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import * as labelsModule from "../../../labels";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import * as muteModule from "../../../calibration/mute-guard";

const byName = (n: string) => ALERTS_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

type OkV = { ok: true; value: Record<string, unknown> };

describe("alerts actions", () => {
  beforeEach(() => {
    vi.mocked(poModule.executeCreatePoDraft).mockClear();
    vi.mocked(calderynModule.calderynClient).mockClear();
    vi.mocked(labelsModule.recommendedAction).mockClear();
    vi.mocked(muteModule.muteConfirmationMessage).mockClear();
    mockAlertsGet.mockClear();
    mockRecordRejection.mockClear();

    mockAlertsGet.mockResolvedValue({
      detector_id: "reorder_timing",
      campaign_id: null,
      dollar_impact: 1234,
    } as never);
    vi.mocked(labelsModule.recommendedAction).mockReturnValue("create_po_draft" as never);
    vi.mocked(muteModule.muteConfirmationMessage).mockReturnValue(null);
  });

  describe("create_po_draft", () => {
    it("passes idempotencyKey + stringified quantity/unit cost to executeCreatePoDraft", async () => {
      const a = byName("create_po_draft");
      const v = a.validate({ alert_id: "a1", quantity: 5, unit_cost_cents: 250 });
      expect(v.ok).toBe(true);
      const receipt = await a.run(ctx, (v as OkV).value);
      expect(vi.mocked(poModule.executeCreatePoDraft)).toHaveBeenCalledWith(
        expect.objectContaining({
          shopId: "shop-1",
          shopDomain: "shop-1",
          alertId: "a1",
          idempotencyKey: "ik-1",
          quantity: "5",
          unitCost: "2.5",
        }),
      );
      expect(receipt.auditId).toBe("audit-po-1");
      expect(receipt.undoable).toBe(false);
      expect(receipt.link?.href).toBe("/dashboard/api/audit/audit-po-1/po.pdf");
      expect(receipt.summary.toLowerCase()).toContain("purchase order");
      expect(receipt.summary.toLowerCase()).not.toContain("shopify");
    });

    it("defaults unitCost to a blank string when unit_cost_cents is omitted", async () => {
      const a = byName("create_po_draft");
      const v = a.validate({ alert_id: "a1", quantity: 5 });
      await a.run(ctx, (v as OkV).value);
      expect(vi.mocked(poModule.executeCreatePoDraft)).toHaveBeenCalledWith(
        expect.objectContaining({ unitCost: "" }),
      );
    });

    it("throws when the executor outcome is not succeeded", async () => {
      vi.mocked(poModule.executeCreatePoDraft).mockResolvedValueOnce({
        auditId: "audit-9",
        outcome: "failed",
        acknowledged: false,
      });
      const a = byName("create_po_draft");
      await expect(a.run(ctx, { alert_id: "a1", quantity: 5 })).rejects.toThrow();
    });

    it("rejects a non-positive or non-integer quantity in validate()", () => {
      const a = byName("create_po_draft");
      expect(a.validate({ alert_id: "a1", quantity: 0 }).ok).toBe(false);
      expect(a.validate({ alert_id: "a1", quantity: -3 }).ok).toBe(false);
      expect(a.validate({ alert_id: "a1", quantity: 2.5 }).ok).toBe(false);
      expect(a.validate({ alert_id: "a1", quantity: 5 }).ok).toBe(true);
    });

    it("rejects a missing alert_id", () => {
      const a = byName("create_po_draft");
      expect(a.validate({ quantity: 5 }).ok).toBe(false);
    });

    it("rejects a negative unit_cost_cents", () => {
      const a = byName("create_po_draft");
      expect(a.validate({ alert_id: "a1", quantity: 5, unit_cost_cents: -1 }).ok).toBe(false);
    });
  });

  describe("reject_queue_action", () => {
    it("re-derives detector_id/action_kind/dollar_impact from the fetched alert, never from input", async () => {
      mockAlertsGet.mockResolvedValueOnce({
        detector_id: "margin_erosion",
        campaign_id: "camp-1",
        dollar_impact: 999,
      } as never);
      vi.mocked(labelsModule.recommendedAction).mockReturnValueOnce("adjust_price" as never);

      const a = byName("reject_queue_action");
      const v = a.validate({
        alert_id: "a1",
        reason: "too_aggressive",
        // Model-supplied noise that must be ignored / re-derived server-side.
        detector_id: "sneaky_detector",
        action_kind: "sneaky_action",
        dollar_impact: 1,
      });
      expect(v.ok).toBe(true);
      await a.run(ctx, (v as OkV).value);

      expect(mockAlertsGet).toHaveBeenCalledWith("a1");
      expect(vi.mocked(labelsModule.recommendedAction)).toHaveBeenCalledWith("margin_erosion", {
        hasCampaign: true,
      });
      expect(mockRecordRejection).toHaveBeenCalledWith({
        alertId: "a1",
        detectorId: "margin_erosion",
        actionKind: "adjust_price",
        reason: "too_aggressive",
        note: undefined,
        dollarImpactCents: 999,
      });
    });

    it("throws the mute-confirmation warning for i_handle_this without confirm, and never calls recordRejection", async () => {
      vi.mocked(muteModule.muteConfirmationMessage).mockReturnValueOnce(
        "This protection catches something. Confirm?",
      );
      const a = byName("reject_queue_action");
      const v = a.validate({ alert_id: "a1", reason: "i_handle_this" });
      await expect(a.run(ctx, (v as OkV).value)).rejects.toThrow(/confirm/i);
      expect(mockRecordRejection).not.toHaveBeenCalled();
    });

    it("proceeds past the mute guard when confirm is true", async () => {
      vi.mocked(muteModule.muteConfirmationMessage).mockReturnValue("warning");
      const a = byName("reject_queue_action");
      const v = a.validate({ alert_id: "a1", reason: "i_handle_this", confirm: true });
      const receipt = await a.run(ctx, (v as OkV).value);
      expect(mockRecordRejection).toHaveBeenCalled();
      expect(receipt.undoable).toBe(false);
    });

    it("rejects an invalid reason in validate()", () => {
      const a = byName("reject_queue_action");
      expect(a.validate({ alert_id: "a1", reason: "not_a_real_reason" }).ok).toBe(false);
      expect(a.validate({ alert_id: "a1", reason: "other" }).ok).toBe(true);
    });

    it("requires alert_id", () => {
      const a = byName("reject_queue_action");
      expect(a.validate({ reason: "other" }).ok).toBe(false);
    });

    it("throws when the alert has no recommended action", async () => {
      vi.mocked(labelsModule.recommendedAction).mockReturnValueOnce(null);
      const a = byName("reject_queue_action");
      const v = a.validate({ alert_id: "a1", reason: "other" });
      await expect(a.run(ctx, (v as OkV).value)).rejects.toThrow(/recommended action/i);
      expect(mockRecordRejection).not.toHaveBeenCalled();
    });
  });
});
