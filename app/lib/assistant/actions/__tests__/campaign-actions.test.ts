import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocks must be defined before importing the module under test
vi.mock("../../../actions/execute.server", () => ({
  executeAction: vi.fn(async () => ({ id: "audit-1", outcome: "succeeded" as const })),
}));

vi.mock("../../../actions/reallocate.server", () => ({
  executeReallocation: vi.fn(async () => ({ id: "audit-2", outcome: "succeeded" as const })),
}));

vi.mock("../../../ads/campaign-draft.server", () => ({
  createCampaignDraft: vi.fn(async () => ({ id: "d1", name: "N", platform: "google" })),
}));

vi.mock("../../../supabase.server", () => ({ getSupabase: () => ({}) }));

// eslint-disable-next-line import/first -- import must follow vi.mock setup
import { CAMPAIGN_ACTIONS } from "../campaign-actions.server";
// eslint-disable-next-line import/first -- import must follow vi.mock setup
import * as executeModule from "../../../actions/execute.server";

const byName = (n: string) => CAMPAIGN_ACTIONS.find((a) => a.name === n)!;
const ctx = { shopId: "shop-1", conversationId: "conv-1", idempotencyKey: "ik-1" };

describe("campaign actions", () => {
  beforeEach(() => {
    vi.mocked(executeModule.executeAction).mockClear();
  });

  it("pause_campaign calls executeAction with kind=pause_campaign and the ctx idempotency key", async () => {
    const a = byName("pause_campaign");
    const v = a.validate({ campaign_id: "c1" });
    expect(v.ok).toBe(true);
    const receipt = await a.run(ctx, (v as { ok: true; value: Record<string, unknown> }).value);
    expect(vi.mocked(executeModule.executeAction)).toHaveBeenCalledWith("shop-1",
      expect.objectContaining({ kind: "pause_campaign", campaignId: "c1", idempotencyKey: "ik-1", actor: "merchant:assistant" }),
      expect.anything());
    expect(receipt.auditId).toBe("audit-1");
    expect(receipt.undoable).toBe(true);
  });

  it("a failed outcome throws so the loop reports an error, never a fake success", async () => {
    vi.mocked(executeModule.executeAction).mockResolvedValueOnce({ id: "audit-9", outcome: "failed" });
    const a = byName("pause_campaign");
    await expect(a.run(ctx, { campaign_id: "c1" })).rejects.toThrow(/rejected|failed/i);
  });

  it("reduce_campaign_budget validates daily_budget_cents > 0", () => {
    const a = byName("reduce_campaign_budget");
    expect(a.validate({ campaign_id: "c1", daily_budget_cents: 0 }).ok).toBe(false);
    expect(a.validate({ campaign_id: "c1", daily_budget_cents: 2500 }).ok).toBe(true);
  });

  it("increase_campaign_budget is confirm-tier and not undoable", () => {
    const a = byName("increase_campaign_budget");
    expect(a.tier).toBe("confirm");
    expect(a.undoable).toBe(false);
  });

  it("exclude_geo rejects an invalid region before any executor call", () => {
    const a = byName("exclude_geo");
    expect(a.validate({ campaign_id: "c1", region: "not-a-region" }).ok).toBe(false);
  });

  it("reallocate_budget requires distinct source and dest", () => {
    const a = byName("reallocate_budget");
    expect(a.validate({ source_campaign_id: "c1", dest_campaign_id: "c1", amount_cents: 500 }).ok).toBe(false);
  });
});
