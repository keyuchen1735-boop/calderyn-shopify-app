import { describe, expect, it, vi } from "vitest";
import type { ActionCtx, AssistantAction } from "../registry-types";

vi.mock("../pending.server", () => ({
  createPendingAction: vi.fn(async (_s, _c, action, _i, summary) => ({
    id: "pend-1", action, summary, expiresAt: new Date(Date.now() + 600_000).toISOString(),
  })),
}));

const ctx: ActionCtx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

const tier1: AssistantAction = {
  name: "test_pause", description: "test", tier: "execute", undoable: true,
  inputSchema: { type: "object", properties: { campaign_id: { type: "string" } }, required: ["campaign_id"] },
  validate: (i) => (typeof i.campaign_id === "string" && i.campaign_id
    ? { ok: true, value: { campaign_id: i.campaign_id } }
    : { ok: false, message: "campaign_id required" }),
  run: vi.fn(async () => ({ action: "test_pause", summary: "Paused X", auditId: "a1", undoable: true })),
};

const tier2: AssistantAction = {
  name: "test_refund", description: "test", tier: "confirm", undoable: false,
  inputSchema: { type: "object", properties: {}, required: [] },
  validate: () => ({ ok: true, value: { order_id: "o1" } }),
  confirmSummary: async () => "Refund $10.00 to order o1 — cannot be undone",
  run: vi.fn(async () => ({ action: "test_refund", summary: "Refunded", auditId: null, undoable: false })),
};

describe("runRegistryAction", () => {
  it("executes a tier-1 action and returns its receipt", async () => {
    const { runRegistryAction, __setActionsForTest } = await import("../execute.server");
    __setActionsForTest([tier1, tier2]);
    const out = await runRegistryAction("test_pause", { campaign_id: "c1" }, ctx);
    expect(out.receipt?.auditId).toBe("a1");
    expect(JSON.parse(out.content).ok).toBe(true);
    expect(tier1.run).toHaveBeenCalledWith(ctx, { campaign_id: "c1" });
  });

  it("returns a validation error without running anything", async () => {
    const { runRegistryAction, __setActionsForTest } = await import("../execute.server");
    __setActionsForTest([tier1]);
    const freshRun = vi.fn();
    __setActionsForTest([{ ...tier1, run: freshRun }]);
    const out = await runRegistryAction("test_pause", {}, ctx);
    expect(out.isError).toBe(true);
    expect(freshRun).not.toHaveBeenCalled();
  });

  it("tier-2 creates a pending action and does NOT run", async () => {
    const { runRegistryAction, __setActionsForTest } = await import("../execute.server");
    __setActionsForTest([tier2]);
    const out = await runRegistryAction("test_refund", {}, ctx);
    expect(out.pending?.id).toBe("pend-1");
    expect(out.receipt).toBeUndefined();
    expect(tier2.run).not.toHaveBeenCalled();
    expect(JSON.parse(out.content).status).toBe("pending_merchant_confirmation");
  });

  it("an executor throw becomes a structured tool error, not an exception", async () => {
    const boom: AssistantAction = { ...tier1, name: "test_boom",
      run: async () => { throw new Error("platform rejected"); } };
    const { runRegistryAction, __setActionsForTest } = await import("../execute.server");
    __setActionsForTest([boom]);
    const out = await runRegistryAction("test_boom", { campaign_id: "c1" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("platform rejected");
  });

  it("unknown action name is a structured error", async () => {
    const { runRegistryAction, __setActionsForTest } = await import("../execute.server");
    __setActionsForTest([]);
    const out = await runRegistryAction("nope", {}, ctx);
    expect(out.isError).toBe(true);
  });
});
