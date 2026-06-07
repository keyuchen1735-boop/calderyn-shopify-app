import { describe, it, expect, vi } from "vitest";
import { makeMetaActionAdapter } from "../actions.server";
import type { MetaClient } from "../campaigns.server";

function client(getBody: Record<string, unknown>): MetaClient {
  return {
    get: vi.fn(async () => getBody),
    post: vi.fn(async () => ({ success: true })),
  };
}

describe("metaActionAdapter", () => {
  it("pause posts status PAUSED", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).pause("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "PAUSED" });
  });

  it("resume posts status ACTIVE", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).resume("c1");
    expect(c.post).toHaveBeenCalledWith("/c1", { status: "ACTIVE" });
  });

  it("setDailyBudget posts daily_budget in minor units as a string", async () => {
    const c = client({});
    await makeMetaActionAdapter(c).setDailyBudget("c1", 5000);
    expect(c.post).toHaveBeenCalledWith("/c1", { daily_budget: "5000" });
  });

  it("getState maps effective_status + daily_budget", async () => {
    const c = client({ status: "PAUSED", daily_budget: "5000" });
    const s = await makeMetaActionAdapter(c).getState("c1");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });
});
