import { it, expect } from "vitest";
import { GRADUATABLE } from "../graduation";

it("contains exactly the seven graduatable kinds", () => {
  expect([...GRADUATABLE].sort()).toEqual([
    "adjust_price", "discontinue_sku", "pause_campaign", "reallocate_budget",
    "reallocate_inventory", "reduce_campaign_budget", "resume_campaign",
  ]);
});
