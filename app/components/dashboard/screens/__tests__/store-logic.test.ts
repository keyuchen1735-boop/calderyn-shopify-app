// Publish is warn-only: missingPieces() names what an about-to-publish store
// lacks (products, checkout) so the studio can offer to fix each one inline —
// but an empty list, or the merchant declining, must never block publishing.
import { describe, it, expect } from "vitest";
import {
  buildStep,
  missingPieces,
  parseChatIntent,
  isDeterministicChatIntent,
  decideWelcomeBranch,
  shouldShowWelcome,
  showPromptCanvas,
  parseProductLine,
  importStepRows,
  welcomeSubline,
} from "../store-logic";

describe("showPromptCanvas", () => {
  it("shows the empty prompt canvas until the shop has at least one live product", () => {
    // No live products -> invite a prompt instead of a generic fallback store,
    // even after the merchant has prompted (a draft with no catalog).
    expect(showPromptCanvas({ productCount: 0 })).toBe(true);
    // A real catalog -> render the store preview.
    expect(showPromptCanvas({ productCount: 2 })).toBe(false);
  });
});

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

describe("parseChatIntent", () => {
  it("prefers an explicit headline rewrite over everything else", () => {
    expect(parseChatIntent('Change the headline to "Gear for the quiet hours"')).toEqual({
      kind: "hero",
      headline: "Gear for the quiet hours",
    });
  });

  it("does not treat bare criticism as a headline rewrite", () => {
    const intent = parseChatIntent("the headline is boring");
    expect(intent.kind).not.toBe("hero");
  });

  it("maps vibe words to the three real vibe values", () => {
    expect(parseChatIntent("Make it bold and dramatic")).toEqual({ kind: "vibe", vibe: "bold" });
    expect(parseChatIntent("Warm and earthy please")).toEqual({ kind: "vibe", vibe: "warm" });
    expect(parseChatIntent("Keep it clean and minimal")).toEqual({ kind: "vibe", vibe: "minimal" });
  });

  it("maps a raw hex color to an accent intent", () => {
    expect(parseChatIntent("Use #2D7FF9 as the accent")).toEqual({ kind: "accent", color: "#2d7ff9" });
  });

  it("maps a curated color word to its hex", () => {
    expect(parseChatIntent("Make the buttons orange")).toEqual({ kind: "accent", color: "#C2410C" });
  });

  it("maps test/optimize language to an experiment intent, defaulting to headline", () => {
    expect(parseChatIntent("Optimize my store")).toEqual({ kind: "experiment", expKind: "headline" });
  });

  it("picks the vibe experiment kind when the message names the look", () => {
    expect(parseChatIntent("Test a new vibe")).toEqual({ kind: "experiment", expKind: "vibe" });
  });

  it("falls back to a real generate brief for free-form asks", () => {
    expect(parseChatIntent("Rebuild it around our new fall collection")).toEqual({
      kind: "generate",
      brief: "Rebuild it around our new fall collection",
    });
  });
});

describe("isDeterministicChatIntent", () => {
  it("is true for vibe, accent and hero intents", () => {
    expect(isDeterministicChatIntent({ kind: "vibe", vibe: "bold" })).toBe(true);
    expect(isDeterministicChatIntent({ kind: "accent", color: "#000000" })).toBe(true);
    expect(isDeterministicChatIntent({ kind: "hero", headline: "x" })).toBe(true);
  });

  it("is false for experiment and generate intents (the markup 'noted' fallback)", () => {
    expect(isDeterministicChatIntent({ kind: "experiment", expKind: "headline" })).toBe(false);
    expect(isDeterministicChatIntent({ kind: "generate", brief: "x" })).toBe(false);
  });
});

describe("decideWelcomeBranch", () => {
  it("shows the import branch whenever a Shopify import is in progress", () => {
    expect(
      decideWelcomeBranch({ shopDomain: null, productCount: 0, draftProductCount: 0, importInProgress: true }),
    ).toEqual({ kind: "importing" });
  });

  it("shows the empty branch for a Shopify-less shop with nothing to sell", () => {
    expect(
      decideWelcomeBranch({ shopDomain: null, productCount: 0, draftProductCount: 0, importInProgress: false }),
    ).toEqual({ kind: "empty" });
  });

  it("shows the ready branch once there is a Shopify connection or any catalog", () => {
    expect(
      decideWelcomeBranch({ shopDomain: "shop.myshopify.com", productCount: 0, draftProductCount: 0, importInProgress: false }),
    ).toEqual({ kind: "ready" });
    expect(
      decideWelcomeBranch({ shopDomain: null, productCount: 3, draftProductCount: 0, importInProgress: false }),
    ).toEqual({ kind: "ready" });
    expect(
      decideWelcomeBranch({ shopDomain: null, productCount: 0, draftProductCount: 1, importInProgress: false }),
    ).toEqual({ kind: "ready" });
  });
});

describe("welcomeSubline", () => {
  it("importing: reports the Shopify pull regardless of build phase or product count", () => {
    expect(
      welcomeSubline({ branch: { kind: "importing" }, buildPhase: { kind: "running" }, productCount: 5 }),
    ).toBe("Bringing your Shopify store over. I'll start building the moment it lands.");
  });

  it("working (running): reports generic progress copy, not the per-step sub", () => {
    expect(
      welcomeSubline({ branch: { kind: "ready" }, buildPhase: { kind: "running" }, productCount: 0 }),
    ).toBe("Building your store. This usually takes about a minute.");
  });

  it("working (done/failed): falls through to the build step's own sub copy", () => {
    expect(
      welcomeSubline({ branch: { kind: "ready" }, buildPhase: { kind: "done", status: "draft" }, productCount: 0 }),
    ).toBe(buildStep({ kind: "done", status: "draft" }).sub);
    expect(
      welcomeSubline({ branch: { kind: "ready" }, buildPhase: { kind: "failed", message: "boom" }, productCount: 0 }),
    ).toBe("boom");
  });

  it("empty: prompts for a first product when there is no build phase yet", () => {
    expect(welcomeSubline({ branch: { kind: "empty" }, buildPhase: null, productCount: 0 })).toBe(
      "I'm Calderyn. Your store is empty so far. Let's get you something to sell, then I'll build everything around it.",
    );
  });

  it("ready-with-count: names the real product count, singular vs plural", () => {
    expect(welcomeSubline({ branch: { kind: "ready" }, buildPhase: null, productCount: 1 })).toBe(
      "I've read the 1 product you have so far. Give me a minute and I'll build your store around it.",
    );
    expect(welcomeSubline({ branch: { kind: "ready" }, buildPhase: null, productCount: 4 })).toBe(
      "I've read the 4 products you have so far. Give me a minute and I'll build your store around them.",
    );
  });

  it("ready with no products and no build phase: generic invitation to build", () => {
    expect(welcomeSubline({ branch: { kind: "ready" }, buildPhase: null, productCount: 0 })).toBe(
      "Let's build your store. You can add products anytime; I'll design around whatever you have.",
    );
  });
});

describe("shouldShowWelcome", () => {
  it("is true only when nothing has ever been built", () => {
    expect(shouldShowWelcome({ hasDraft: false, hasPublished: false, generation: null })).toBe(true);
  });

  it("is false once a draft, a publish, or a generation run exists", () => {
    expect(shouldShowWelcome({ hasDraft: true, hasPublished: false, generation: null })).toBe(false);
    expect(shouldShowWelcome({ hasDraft: false, hasPublished: true, generation: null })).toBe(false);
    expect(shouldShowWelcome({ hasDraft: false, hasPublished: false, generation: { runId: "1" } })).toBe(false);
  });
});

describe("parseProductLine", () => {
  it("splits a trailing price from the title and converts it to cents", () => {
    expect(parseProductLine("Hand-poured cedar candle, $18")).toEqual({
      title: "Hand-poured Cedar Candle",
      priceCents: 1800,
    });
  });

  it("handles a decimal price with no dollar sign", () => {
    expect(parseProductLine("Trail flask 24.50")).toEqual({ title: "Trail Flask", priceCents: 2450 });
  });

  it("never fabricates a price when none was typed", () => {
    expect(parseProductLine("Cedar candle")).toEqual({ title: "Cedar Candle", priceCents: null });
  });

  it("falls back to a generic title when the line is empty of words", () => {
    expect(parseProductLine("$18")).toEqual({ title: "First product", priceCents: 1800 });
  });
});

describe("importStepRows", () => {
  it("shows only the first step running before any run exists", () => {
    const rows = importStepRows(null);
    expect(rows[0].state).toBe("run");
    expect(rows[1].state).toBe("wait");
    expect(rows[2].state).toBe("wait");
  });

  it("shows the second step running while pulling, with the real product count", () => {
    const rows = importStepRows({ state: "pulling", counts: { products: 120, variants: 0, collections: 0, balances: 0 } });
    expect(rows[0].state).toBe("done");
    expect(rows[1].state).toBe("run");
    expect(rows[1].sub).toMatch(/120 products/);
    expect(rows[2].state).toBe("wait");
  });

  it("shows the third step running while promoting", () => {
    const rows = importStepRows({ state: "promoting", counts: null });
    expect(rows[0].state).toBe("done");
    expect(rows[1].state).toBe("done");
    expect(rows[2].state).toBe("run");
  });

  it("shows every step done once the run finishes", () => {
    const rows = importStepRows({ state: "done", counts: { products: 363, variants: 400, collections: 12, balances: 400 } });
    expect(rows.every((r) => r.state === "done")).toBe(true);
  });
});
