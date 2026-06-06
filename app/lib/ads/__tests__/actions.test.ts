import { describe, it, expect } from "vitest";
import type { ActionAdapter, CampaignActionState } from "../actions";
import { ActionError } from "../actions";

describe("action contract", () => {
  it("a fake adapter conforms and getState returns the documented shape", async () => {
    const state: CampaignActionState = { status: "active", dailyBudgetCents: 5000 };
    const adapter: ActionAdapter = {
      platform: "meta",
      pause: async () => {},
      resume: async () => {},
      setDailyBudget: async () => {},
      getState: async () => state,
    };
    expect(adapter.platform).toBe("meta");
    expect((await adapter.getState("c1")).dailyBudgetCents).toBe(5000);
  });

  it("ActionError carries a platform + message", () => {
    const e = new ActionError("meta", "boom");
    expect(e.platform).toBe("meta");
    expect(e.message).toContain("boom");
    expect(e).toBeInstanceOf(Error);
  });
});
