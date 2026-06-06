import { describe, it, expect, vi } from "vitest";
import { makeGoogleActionAdapter } from "../actions.server";

describe("googleActionAdapter", () => {
  it("pause issues an updateMask status=PAUSED mutate on the campaign", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").pause("777");
    expect(mutate).toHaveBeenCalledWith("campaigns", expect.objectContaining({
      update: expect.objectContaining({ resourceName: "customers/123/campaigns/777", status: "PAUSED" }),
      updateMask: "status",
    }));
  });

  it("setDailyBudget mutates the budget resource in micros", async () => {
    const mutate = vi.fn(async () => ({}));
    await makeGoogleActionAdapter(mutate, "123").setDailyBudget("777", 5000);
    // 5000 cents -> 50,000,000 micros
    expect(mutate).toHaveBeenCalledWith("campaignBudgets", expect.objectContaining({
      update: expect.objectContaining({ amountMicros: 50000000 }),
      updateMask: "amount_micros",
    }), "777");
  });

  it("getState reads status + budget via the injected reader", async () => {
    const mutate = vi.fn();
    const read = vi.fn(async () => ({ status: "PAUSED", amountMicros: 50000000 }));
    const s = await makeGoogleActionAdapter(mutate, "123", read).getState("777");
    expect(s).toEqual({ status: "paused", dailyBudgetCents: 5000 });
  });
});
