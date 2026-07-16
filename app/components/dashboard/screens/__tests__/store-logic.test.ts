import { describe, expect, it } from "vitest";
import {
  buildStep,
  decideWelcomeBranch,
  importStepRows,
  missingPieces,
  parseProductLine,
  shouldShowWelcome,
  showPromptCanvas,
  welcomeSubline,
} from "../store-logic";

describe("Store readiness", () => {
  it("warns about missing catalog and payment setup without blocking publish", () => {
    expect(missingPieces({ productCount: 0, draftProductCount: 0, checkoutReady: false }).map(({ key }) => key))
      .toEqual(["products", "checkout"]);
    expect(missingPieces({ productCount: 2, draftProductCount: 0, checkoutReady: true })).toEqual([]);
  });

  it("shows first-run surfaces only before any store exists", () => {
    const fresh = { hasDraft: false, hasPublished: false, generation: null };
    expect(shouldShowWelcome(fresh)).toBe(true);
    expect(showPromptCanvas(fresh)).toBe(true);
    expect(shouldShowWelcome({ ...fresh, hasDraft: true })).toBe(false);
    expect(showPromptCanvas({ ...fresh, hasPublished: true })).toBe(false);
  });
});

describe("welcome flow", () => {
  it("prioritizes import, then an empty owned catalog, then ready", () => {
    expect(decideWelcomeBranch({ shopDomain: null, productCount: 0, draftProductCount: 0, importInProgress: true }))
      .toEqual({ kind: "importing" });
    expect(decideWelcomeBranch({ shopDomain: null, productCount: 0, draftProductCount: 0, importInProgress: false }))
      .toEqual({ kind: "empty" });
    expect(decideWelcomeBranch({ shopDomain: null, productCount: 1, draftProductCount: 0, importInProgress: false }))
      .toEqual({ kind: "ready" });
  });

  it("uses merchant copy for live command progress", () => {
    const phase = { kind: "running", stage: "checking_preview" } as const;
    expect(welcomeSubline({ branch: { kind: "ready" }, buildPhase: phase, productCount: 1 }))
      .toBe(buildStep(phase).sub);
    expect(welcomeSubline({ branch: { kind: "importing" }, buildPhase: phase, productCount: 1 }))
      .toMatch(/Shopify/i);
  });
});

describe("welcome helpers", () => {
  it("parses a merchant product line without inventing a price", () => {
    expect(parseProductLine("Hand-poured cedar candle, $18")).toEqual({
      title: "Hand-poured Cedar Candle",
      priceCents: 1800,
    });
    expect(parseProductLine("Cedar candle")).toEqual({ title: "Cedar Candle", priceCents: null });
  });

  it("reports real import progress", () => {
    expect(importStepRows(null).map(({ state }) => state)).toEqual(["run", "wait", "wait"]);
    expect(importStepRows({
      state: "pulling",
      counts: { products: 120, variants: 0, collections: 0, balances: 0 },
    })[1]).toMatchObject({ state: "run", sub: "120 products so far" });
  });
});
