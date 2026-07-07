import { describe, it, expect } from "vitest";
import { canOneClickAlert } from "../one-click";

describe("weather reallocate_budget one-click", () => {
  it("one-clicks only with a reallocation plan in evidence", () => {
    const withPlan = { evidence: { source_campaign_id: "s", dest_campaign_id: "d", amount_cents: "4000" } } as never;
    const without = { evidence: {} } as never;
    expect(canOneClickAlert(withPlan, "reallocate_budget")).toBe(true);
    expect(canOneClickAlert(without, "reallocate_budget")).toBe(false);
  });
});
