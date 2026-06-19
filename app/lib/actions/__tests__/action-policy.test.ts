import { describe, it, expect, vi } from "vitest";
import { getActionPolicy } from "../action-policy.server";

describe("getActionPolicy", () => {
  it("returns null when the shop has no pseudonym row (safe full-cap fallthrough)", async () => {
    const schema = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: null }) }) }) }),
    });
    const sb = { schema } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBeNull();
  });

  it("returns mu from action_models keyed by the resolved pseudonym", async () => {
    const pseudoChain = { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { pseudonym_id: "ps1" } }) }) }) };
    const modelChain = { select: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ eq: vi.fn().mockReturnValue({ maybeSingle: vi.fn().mockResolvedValue({ data: { policy_json: { mu: 0.4 } } }) }) }) }) }) };
    const schema = vi.fn().mockImplementation((s: string) => ({ from: vi.fn().mockReturnValue(s === "moat_keys" ? pseudoChain : modelChain) }));
    const sb = { schema } as never;
    expect(await getActionPolicy(sb, "shop1", "ad_tax_overload", "reduce_campaign_budget")).toBe(0.4);
  });
});
