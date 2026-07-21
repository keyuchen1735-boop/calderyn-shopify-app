import { describe, expect, it } from "vitest";
import {
  STOREFRONT_DESIGN_GUIDANCE_VERSION,
  storefrontGenerationSystemPrompt,
} from "./design-guidance-generate.server";
import { storefrontReviewSystemPrompt } from "./design-guidance-review.server";

describe("storefront design guidance", () => {
  it("composes versioned design and review disciplines without agent workflow", () => {
    const generation = storefrontGenerationSystemPrompt();
    const review = storefrontReviewSystemPrompt();
    const combined = `${generation}\n${review}`;

    expect(STOREFRONT_DESIGN_GUIDANCE_VERSION).toBe("claude-design-3c3ddb-calderyn-1");
    for (const phrase of [
      "Every element must earn its place",
      "visual hierarchy",
      "WCAG",
      "prefers-reduced-motion",
      "trusted commerce slots",
    ]) {
      expect(combined).toContain(phrase);
    }
    for (const forbidden of [
      "launch four review agents",
      "filesystem-based project",
      "speaker notes",
      "tweak panel",
    ]) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it("keeps generated compiler source inside commerce and data boundaries", () => {
    const generation = storefrontGenerationSystemPrompt();

    for (const constraint of [
      "Do not emit script",
      "Do not use remote assets or fonts",
      "Do not create arbitrary actions",
      "Do not invent catalog values",
      "Do not remove or replace trusted commerce slots",
    ]) {
      expect(generation).toContain(constraint);
    }
  });

  it("directs and reviews source-owned imagery with responsive intent", () => {
    const generation = storefrontGenerationSystemPrompt();
    const review = storefrontReviewSystemPrompt();

    for (const discipline of [
      "subject, composition, and crop",
      "source-owned imagery",
      "responsive art direction",
    ]) {
      expect(generation).toContain(discipline);
    }
    expect(review).toContain("Reject weak or irrelevant imagery");
  });

  it("gives the reviewer a structured, source-grounded, scoped contract", () => {
    const review = storefrontReviewSystemPrompt();

    expect(review).toContain("Return only the requested structured review result");
    expect(review).toContain("Report only concrete, source-grounded defects");
    expect(review).toContain("Prefer the smallest scoped repair");
  });
});
