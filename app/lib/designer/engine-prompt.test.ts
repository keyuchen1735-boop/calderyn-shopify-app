// Honesty rules in the designer's system prompt are contract (designer
// flagship spec D5): exact substrings so a reworded or dropped rule is a
// deliberate diff here, never silent drift — same pattern as context.test.ts
// pins the Peakwell anti-fabrication framing.
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./engine.server";

describe("designer SYSTEM_PROMPT honesty rules", () => {
  it("forbids specific policy/spec numbers that were not supplied", () => {
    expect(SYSTEM_PROMPT).toContain("Policy and spec copy is only ever specific when the fact was supplied");
    expect(SYSTEM_PROMPT).toContain("shipping thresholds, delivery windows, returns windows");
    expect(SYSTEM_PROMPT).toContain("burn time, materials, dimensions, capacity");
    expect(SYSTEM_PROMPT).toContain("NEVER state a number, duration, percentage, or threshold that wasn't supplied");
  });

  it("extends the merchant-ask pattern from brand story to policies", () => {
    expect(SYSTEM_PROMPT).toContain("ask them for the real details in your reply");
    expect(SYSTEM_PROMPT).toContain("their actual shipping promise, returns window, materials");
  });

  it("gates the coupon popup on a real merchant-supplied code", () => {
    expect(SYSTEM_PROMPT).toContain("ONLY when the merchant has given you a real discount code");
    expect(SYSTEM_PROMPT).toContain("no discounts feature yet, so never invent a code");
  });

  it("no longer carries the WELCOME10 example anywhere", () => {
    expect(SYSTEM_PROMPT).not.toContain("WELCOME10");
  });

  it("ties announcement-bar shipping thresholds to a supplied fact", () => {
    expect(SYSTEM_PROMPT).toContain("free-shipping-threshold line ONLY when the merchant supplied that exact threshold");
  });

  it("keeps the pre-existing anti-fabrication rule intact", () => {
    expect(SYSTEM_PROMPT).toContain("Never fabricate facts");
    expect(SYSTEM_PROMPT).toContain("no invented review counts or star ratings");
  });

  it("routes the store accent through --signal so widget chrome follows a swap (D6)", () => {
    expect(SYSTEM_PROMPT).toContain("--signal");
    expect(SYSTEM_PROMPT).toContain("update --signal in the same edit");
  });

  it("forbids invented image paths and pins the allowed image vocabulary (D4)", () => {
    expect(SYSTEM_PROMPT).toContain("NEVER invent an image path or file name");
    expect(SYSTEM_PROMPT).toContain("{{product.image}}, {{store.logo}}, {{asset.<key>}}");
    // The old blanket license for template art is gone; only paths already in
    // the current files stay legal (edit turns on existing stores).
    expect(SYSTEM_PROMPT).not.toContain("template art under /storefront-recipes/ and the product placeholders");
    expect(SYSTEM_PROMPT).toContain("template art paths already present in the current files");
  });
});
