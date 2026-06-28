import { describe, it, expect } from "vitest";
import { HAS_UNDO_BRANCH } from "../undo-branches";

describe("HAS_UNDO_BRANCH", () => {
  it("includes every kind with an undo branch in undo.server.ts", () => {
    for (const k of ["pause_campaign", "resume_campaign", "reduce_campaign_budget",
                     "reallocate_budget", "reallocate_inventory", "discontinue_sku",
                     "adjust_price"] as const) {
      expect(HAS_UNDO_BRANCH.has(k)).toBe(true);
    }
  });
  it("excludes kinds with no undo branch", () => {
    expect(HAS_UNDO_BRANCH.has("increase_campaign_budget")).toBe(false);
    expect(HAS_UNDO_BRANCH.has("create_po_draft")).toBe(false);
  });
});
