import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordApproval } from "../approval.server";

describe("recordApproval", () => {
  it("upserts an alpha + clean_approvals increment for the pair", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const sb = { rpc } as unknown as SupabaseClient;
    await recordApproval("shop-1", "campaign_below_breakeven", "pause_campaign", sb);
    expect(rpc).toHaveBeenCalledWith("calibration_record_approval", {
      p_shop_id: "shop-1",
      p_detector_id: "campaign_below_breakeven",
      p_action_kind: "pause_campaign",
    });
  });
  it("does not throw when the RPC errors (action result is authoritative)", async () => {
    const sb = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } }) } as unknown as SupabaseClient;
    await expect(recordApproval("shop-1", "d", "pause_campaign", sb)).resolves.toBeUndefined();
  });
});
