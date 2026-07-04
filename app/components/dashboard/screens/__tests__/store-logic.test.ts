// Publish is warn-only: missingPieces() names what an about-to-publish store
// lacks (products, checkout) so the studio can offer to fix each one inline —
// but an empty list, or the merchant declining, must never block publishing.
import { describe, it, expect } from "vitest";
import { buildStep, missingPieces } from "../store-logic";

describe("missingPieces", () => {
  it("returns nothing when the store has live products and can take payment", () => {
    expect(missingPieces({ productCount: 3, draftProductCount: 0, checkoutReady: true })).toEqual([]);
  });

  it("flags missing products with a route to add them", () => {
    const pieces = missingPieces({ productCount: 0, draftProductCount: 0, checkoutReady: true });
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ key: "products", screen: "catalog" });
    expect(pieces[0].label).toBeTruthy();
  });

  it("points at unfinished drafts when products exist but none are live", () => {
    const pieces = missingPieces({ productCount: 0, draftProductCount: 3, checkoutReady: true });
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ key: "products", screen: "catalog" });
    expect(pieces[0].label).toMatch(/draft/i);
  });

  it("flags payments not fully set up with a route to payments", () => {
    const pieces = missingPieces({ productCount: 2, draftProductCount: 0, checkoutReady: false });
    expect(pieces).toHaveLength(1);
    expect(pieces[0]).toMatchObject({ key: "checkout", screen: "payments" });
  });

  it("lists both when both are missing", () => {
    expect(
      missingPieces({ productCount: 0, draftProductCount: 0, checkoutReady: false }).map((p) => p.key),
    ).toEqual(["products", "checkout"]);
  });
});

describe("buildStep", () => {
  it("treats a no-products generation as a finished draft, not a blocker", () => {
    const step = buildStep({ kind: "done", status: "no_products" });
    expect(step.dot).toBe("done");
    expect(step.title).not.toMatch(/add products first/i);
  });

  it("keeps the failed state visible", () => {
    const step = buildStep({ kind: "failed", message: "boom" });
    expect(step.dot).toBe("wait");
    expect(step.sub).toBe("boom");
  });

  it("says a degraded (AI-unavailable) draft is a starter layout, not the design", () => {
    // A soft-degraded run produced a draft, but the prompt wasn't applied — the
    // copy must not read as "draft ready" or the merchant thinks it worked.
    const step = buildStep({ kind: "done", status: "failed" });
    expect(step.dot).toBe("wait");
    expect(step.title).not.toMatch(/ready/i);
    expect(step.sub).toMatch(/unavailable|starter/i);
  });
});
