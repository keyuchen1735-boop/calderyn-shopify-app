import { describe, it, expect, vi } from "vitest";
import { makeTikTokActionAdapter } from "../actions.server";

describe("tiktokActionAdapter", () => {
  it("pause posts operation_status DISABLE", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").pause("c1");
    expect(call).toHaveBeenCalledWith("/campaign/status/update/", expect.objectContaining({
      advertiser_id: "adv1", campaign_ids: ["c1"], operation_status: "DISABLE",
    }));
  });

  it("resume posts operation_status ENABLE", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").resume("c1");
    expect(call).toHaveBeenCalledWith("/campaign/status/update/", expect.objectContaining({ operation_status: "ENABLE" }));
  });

  it("setDailyBudget posts budget in major units (cents/100)", async () => {
    const call = vi.fn(async () => ({ code: 0 }));
    await makeTikTokActionAdapter(call, "adv1").setDailyBudget("c1", 5000);
    expect(call).toHaveBeenCalledWith("/campaign/update/", expect.objectContaining({
      advertiser_id: "adv1", campaign_id: "c1", budget: 50,
    }));
  });
});
