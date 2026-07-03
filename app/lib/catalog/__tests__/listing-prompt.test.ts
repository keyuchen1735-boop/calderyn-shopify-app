import { describe, expect, it } from "vitest";
import {
  draftPlanFromPrompt,
  parseListingPrompt,
  sanitizePlan,
  type ListingContext,
  type ListingOp,
} from "../listing-prompt";

const CTX: ListingContext = { title: "Canvas Tote Bag", priceCents: 8000, hasShipping: false };

function opsOf(prompt: string, ctx: ListingContext = CTX): ListingOp[] {
  return parseListingPrompt(prompt, ctx).ops;
}

describe("parseListingPrompt", () => {
  it('adds the full size run for "a bunch of sizes"', () => {
    const ops = opsOf("make it have a bunch of sizes");
    expect(ops).toEqual([{ op: "add_option", name: "Size", values: ["XS", "S", "M", "L", "XL", "2XL"] }]);
  });

  it("adds the short size run without a quantity word", () => {
    expect(opsOf("add sizes")).toEqual([{ op: "add_option", name: "Size", values: ["S", "M", "L"] }]);
  });

  it("uses named colors when given, defaults otherwise", () => {
    expect(opsOf("add black and navy colors")).toEqual([
      { op: "add_option", name: "Color", values: ["Black", "Navy"] },
    ]);
    expect(opsOf("add some colors")).toEqual([
      { op: "add_option", name: "Color", values: ["Black", "White", "Navy"] },
    ]);
  });

  it("sets an explicit dollar price in cents", () => {
    expect(opsOf("set the price to $25")).toEqual([{ op: "set_price", priceCents: 2500 }]);
    expect(opsOf("charge 19.99 for it")).toEqual([{ op: "set_price", priceCents: 1999 }]);
  });

  it("treats percentage price prompts as relative, never absolute", () => {
    // The regression this guards: "lower the price by 10%" once parsed as set_price $10.
    expect(opsOf("lower the price by 10%")).toEqual([{ op: "scale_price", factor: 0.85 }]);
  });

  it("scales the price for cheaper/premium only when a price exists", () => {
    expect(opsOf("make it cheaper")).toEqual([{ op: "scale_price", factor: 0.85 }]);
    expect(opsOf("make it more premium")).toEqual([{ op: "scale_price", factor: 1.25 }]);
    const noPrice = { ...CTX, priceCents: null };
    expect(opsOf("make it cheaper", noPrice)).toEqual([]);
  });

  it("reads the stock count next to the stock word, not the first number anywhere", () => {
    expect(opsOf("stock 50 of them")).toEqual([{ op: "set_stock", stock: 50 }]);
    expect(opsOf("charge $30 and stock 100")).toEqual([
      { op: "set_price", priceCents: 3000 },
      { op: "set_stock", stock: 100 },
    ]);
  });

  it("rewrites the description using the current title", () => {
    const ops = opsOf("rewrite the description");
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe("set_description");
    // Template choice is seed-dependent and one template lowercases the title.
    expect((ops[0] as { description: string }).description.toLowerCase()).toContain("canvas tote bag");
  });

  it("renames via 'call it' without swallowing following clauses", () => {
    expect(opsOf("call it midnight tee")).toEqual([{ op: "set_title", title: "Midnight Tee" }]);
    const ops = opsOf("call it midnight tee and set the price to $20");
    expect(ops).toEqual([
      { op: "set_title", title: "Midnight Tee" },
      { op: "set_price", priceCents: 2000 },
    ]);
  });

  it("estimates shipping only when none is recorded", () => {
    const ops = opsOf("estimate the shipping");
    expect(ops).toHaveLength(1);
    const ship = ops[0] as Extract<ListingOp, { op: "set_shipping" }>;
    expect(ship.op).toBe("set_shipping");
    for (const v of [ship.weightGrams, ship.lengthMm, ship.widthMm, ship.heightMm]) {
      expect(v).toBeGreaterThan(0);
    }
    // Real shipping data present → never overwritten by a derived estimate.
    expect(opsOf("double-check the shipping weight", { ...CTX, hasShipping: true })).toEqual([]);
  });

  it("flips status for publish / keep-as-draft", () => {
    expect(opsOf("publish it")).toEqual([{ op: "set_status", status: "active" }]);
    expect(opsOf("keep it as a draft")).toEqual([{ op: "set_status", status: "draft" }]);
  });

  it("stacks multiple intents from one prompt", () => {
    const ops = opsOf("add a bunch of sizes and set the price to $30");
    expect(ops.map((o) => o.op)).toEqual(["add_option", "set_price"]);
  });

  it("returns an empty plan for prompts it cannot place", () => {
    expect(opsOf("make it feel more like our brand")).toEqual([]);
  });
});

describe("draftPlanFromPrompt", () => {
  it("drafts title, price, stock, description, and tags deterministically", () => {
    const a = draftPlanFromPrompt("t shirt for my brand");
    const b = draftPlanFromPrompt("t shirt for my brand");
    expect(a).toEqual(b);
    const kinds = a.ops.map((o) => o.op);
    expect(kinds).toEqual(["set_title", "set_price", "set_stock", "set_description", "set_tags"]);
    const titleOp = a.ops[0] as Extract<ListingOp, { op: "set_title" }>;
    expect(titleOp.title).toBe("T Shirt For My Brand");
    const priceOp = a.ops[1] as Extract<ListingOp, { op: "set_price" }>;
    expect(priceOp.priceCents).toBeGreaterThan(0);
    expect(priceOp.priceCents % 100).toBe(0);
  });
});

describe("sanitizePlan", () => {
  it("round-trips a valid plan", () => {
    const plan = {
      ops: [
        { op: "set_title", title: "Midnight Tee" },
        { op: "set_price", priceCents: 2500 },
        { op: "add_option", name: "Size", values: ["S", "M"] },
      ],
      summaries: ["Renamed", "Set price to $25.00", "Added sizes"],
    };
    expect(sanitizePlan(plan)).toEqual(plan);
  });

  it("drops malformed ops and rejects plans with none left", () => {
    expect(
      sanitizePlan({ ops: [{ op: "set_price", priceCents: -5 }, { op: "explode" }], summaries: [] }),
    ).toBeNull();
    const mixed = sanitizePlan({
      ops: [{ op: "set_price", priceCents: -5 }, { op: "set_stock", stock: 3 }],
      summaries: ["ok"],
    });
    expect(mixed?.ops).toEqual([{ op: "set_stock", stock: 3 }]);
  });

  it("collapses summaries to a generic receipt when any op is dropped", () => {
    // Positional receipts lie once their op is gone — the survivor set must
    // not claim changes that never landed.
    const plan = sanitizePlan({
      ops: [
        { op: "set_shipping", weightGrams: 0, lengthMm: 10, widthMm: 10, heightMm: 10 },
        { op: "set_stock", stock: 3 },
      ],
      summaries: ["Estimated shipping size & weight", "Set stock to 3"],
    });
    expect(plan?.ops).toEqual([{ op: "set_stock", stock: 3 }]);
    expect(plan?.summaries).toEqual(["Applied your change"]);
  });

  it("rejects zero-dimension shipping and non-object input", () => {
    expect(
      sanitizePlan({
        ops: [{ op: "set_shipping", weightGrams: 100, lengthMm: 0, widthMm: 10, heightMm: 10 }],
        summaries: [],
      }),
    ).toBeNull();
    expect(sanitizePlan(null)).toBeNull();
    expect(sanitizePlan("ops")).toBeNull();
  });

  it("caps runaway values and clamps title length", () => {
    const plan = sanitizePlan({
      ops: [
        { op: "set_price", priceCents: 99_999_999_999 },
        { op: "set_title", title: "x".repeat(120) },
      ],
      summaries: [],
    });
    // The absurd price op is dropped; the title survives clamped to 70.
    expect(plan?.ops).toHaveLength(1);
    expect(plan?.ops[0]).toEqual({ op: "set_title", title: "x".repeat(70) });
    expect(plan?.summaries).toEqual(["Applied your change"]);
  });
});
