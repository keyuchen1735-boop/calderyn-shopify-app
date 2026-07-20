import { describe, expect, it } from "vitest";

import { CRAFT_RULES, EDIT_FEEDBACK_RULES, REVIEW_CRAFT_CHECKS } from "./doctrine";

describe("designer doctrine", () => {
  it("blocks are substantial and model the no-dash copy rule they enforce", () => {
    for (const block of [CRAFT_RULES, EDIT_FEEDBACK_RULES, REVIEW_CRAFT_CHECKS]) {
      expect(block.length).toBeGreaterThan(120);
      expect(block).not.toMatch(/[–—]/);
    }
  });
  it("edit-feedback rules close each observed failure mode", () => {
    // No status-report openers recapping prior work.
    expect(EDIT_FEEDBACK_RULES).toContain('"everything you asked for is already in place"');
    // Size complaints target the region's height, not typography.
    expect(EDIT_FEEDBACK_RULES).toContain("min-height or vh value");
    expect(EDIT_FEEDBACK_RULES).toContain("aspect-ratio");
    // Never argue with the merchant's perception; escalate step size instead.
    expect(EDIT_FEEDBACK_RULES).toContain("perception is the spec");
    expect(EDIT_FEEDBACK_RULES).toContain("twice the size");
    // Anti-squish floors and the whitespace-first recovery path.
    expect(EDIT_FEEDBACK_RULES).toContain("15px");
    expect(EDIT_FEEDBACK_RULES).toContain("squished");
    // Merchant direction outlives the turn and beats the built-in defaults.
    expect(EDIT_FEEDBACK_RULES).toContain("override the visual defaults");
  });
  it("craft rules cover the state, motion, and accessibility floors the system prompt lacked", () => {
    expect(CRAFT_RULES).toContain(":focus-visible");
    expect(CRAFT_RULES).toContain("prefers-reduced-motion");
    expect(CRAFT_RULES).toContain("0.15-0.3s");
    expect(CRAFT_RULES).toContain("44px");
    expect(CRAFT_RULES).toContain("Exactly one h1");
    expect(CRAFT_RULES).toContain("8px scale");
    expect(CRAFT_RULES).toContain("corner-radius scale");
  });
  it("review checks are phrased as concrete findable defects", () => {
    expect(REVIEW_CRAFT_CHECKS).toContain("4.5:1 body, 3:1 large text and controls");
    expect(REVIEW_CRAFT_CHECKS).toContain("focus-visible");
    expect(REVIEW_CRAFT_CHECKS).toContain("#FFFFFF");
    expect(REVIEW_CRAFT_CHECKS).toContain("skipped heading levels");
  });
});
