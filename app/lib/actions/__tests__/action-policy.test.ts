import { describe, it, expect, vi } from "vitest";
import { getActionPolicy } from "../action-policy.server";

describe("getActionPolicy", () => {
  it("returns null when the policy fn finds no model (safe full-cap fallthrough)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const sb = { rpc } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBeNull();
    expect(rpc).toHaveBeenCalledWith("autopilot_action_mu", {
      p_shop_id: "shop1",
      p_detector_id: "ad_tax_overload",
      p_action_kind: "reduce_campaign_budget",
    });
  });

  it("returns null on an rpc error (never throws — full-cap fallthrough)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const sb = { rpc } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBeNull();
  });

  it("returns mu from the policy fn (coercing numeric string)", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "0.4", error: null }); // pg numeric may arrive as string
    const sb = { rpc } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBe(0.4);
  });
});
