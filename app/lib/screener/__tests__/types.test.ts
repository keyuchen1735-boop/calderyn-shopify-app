import { describe, it, expect } from "vitest";
import { normalizeTip } from "../types";

describe("normalizeTip", () => {
  it("passes a structured tip through unchanged", () => {
    const tip = { title: "Add a benefit-led headline", detail: "Your headline is blank." };
    expect(normalizeTip(tip)).toBe(tip);
  });

  it("splits a legacy numbered string into a scannable title and expandable detail", () => {
    const raw =
      "1. ADD A HEADLINE IMMEDIATELY — this is the single biggest lever; write a specific, benefit-led headline (e.g., 'Lightweight Summit Tee — Built for the Trail') so viewers know what they're buying.";
    expect(normalizeTip(raw)).toEqual({
      title: "ADD A HEADLINE IMMEDIATELY",
      detail:
        "this is the single biggest lever; write a specific, benefit-led headline (e.g., 'Lightweight Summit Tee — Built for the Trail') so viewers know what they're buying.",
    });
  });

  it("splits on the FIRST separator so dashes inside the detail are preserved", () => {
    const raw = "Swap the Marketplace link — use a product page — not Marketplace";
    expect(normalizeTip(raw)).toEqual({
      title: "Swap the Marketplace link",
      detail: "use a product page — not Marketplace",
    });
  });

  it("accepts a colon as the title/detail boundary", () => {
    expect(normalizeTip("Add social proof: overlay a 4.8★ rating")).toEqual({
      title: "Add social proof",
      detail: "overlay a 4.8★ rating",
    });
  });

  it("keeps a separator-less string as the title with no detail (not expandable)", () => {
    expect(normalizeTip("Add a clear offer")).toEqual({
      title: "Add a clear offer",
      detail: "",
    });
  });
});
