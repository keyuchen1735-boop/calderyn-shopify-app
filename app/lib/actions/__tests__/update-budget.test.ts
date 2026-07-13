import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { executeAction } from "../execute.server";

// Validation throws before any Supabase/platform call, so an empty stub is safe.
const SB = {} as SupabaseClient;

describe("update_campaign_budget validation", () => {
  it("refuses a missing dailyBudgetCents", async () => {
    await expect(
      executeAction("shop-1", {
        alertId: null,
        kind: "update_campaign_budget",
        campaignId: "camp-1",
        idempotencyKey: "k1",
      }, SB),
    ).rejects.toThrow(/dailyBudgetCents/);
  });

  it("refuses a zero dailyBudgetCents", async () => {
    await expect(
      executeAction("shop-1", {
        alertId: null,
        kind: "update_campaign_budget",
        campaignId: "camp-1",
        idempotencyKey: "k1",
        dailyBudgetCents: 0,
      }, SB),
    ).rejects.toThrow(/dailyBudgetCents/);
  });
});
