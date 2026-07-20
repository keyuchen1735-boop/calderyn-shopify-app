import { describe, expect, it } from "vitest";

import { CRAFT_RULES, REVIEW_CRAFT_CHECKS } from "./doctrine";

describe("designer doctrine", () => {
  it("blocks are substantial and model the no-dash copy rule they enforce", () => {
    for (const block of [CRAFT_RULES, REVIEW_CRAFT_CHECKS]) {
      expect(block.length).toBeGreaterThan(120);
      expect(block).not.toMatch(/[–—]/);
    }
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
