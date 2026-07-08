import { describe, it, expect } from "vitest";
import { parseSeedPlan, FALLBACK_SEED, ICON_HINTS } from "./seed";

const good = JSON.stringify({
  collections: [{ title: "Trail Gear" }, { title: "Camp Kitchen" }],
  products: [
    { title: "Ridgeline 40L Pack", description: "A weatherproof pack for long hauls.", priceCents: 14800, collection: "Trail Gear", iconHint: "backpack", phTone: "cool" },
    { title: "Ember Cast Skillet", description: "Pre-seasoned cast iron for open flame.", priceCents: 6400, collection: "Camp Kitchen", iconHint: "kitchen", phTone: "warm" },
    { title: "Summit Shell Jacket", description: "Three-layer shell that packs to a fist.", priceCents: 21900, collection: "Trail Gear", iconHint: "shirt", phTone: "neutral" },
  ],
});

describe("parseSeedPlan", () => {
  it("parses a valid plan and preserves fields", () => {
    const plan = parseSeedPlan(good);
    expect(plan).not.toBeNull();
    expect(plan!.collections.map((c) => c.title)).toEqual(["Trail Gear", "Camp Kitchen"]);
    expect(plan!.products).toHaveLength(3);
    expect(plan!.products[0]).toMatchObject({ title: "Ridgeline 40L Pack", priceCents: 14800, iconHint: "backpack", phTone: "cool" });
  });
  it("strips a ```json fence", () => {
    expect(parseSeedPlan("```json\n" + good + "\n```")).not.toBeNull();
  });
  it("returns null on junk / non-JSON / empty products", () => {
    expect(parseSeedPlan("I can't help with that")).toBeNull();
    expect(parseSeedPlan('{"collections":[],"products":[]}')).toBeNull();
  });
  it("coerces an unknown iconHint to package and bad phTone to neutral", () => {
    const p = parseSeedPlan(good.replace('"backpack"', '"spaceship"').replace('"cool"', '"sparkly"'));
    expect(p!.products[0].iconHint).toBe("package");
    expect(p!.products[0].phTone).toBe("neutral");
  });
  it("dedupes duplicate collection titles", () => {
    const raw = JSON.parse(good);
    raw.collections = [{ title: "Trail Gear" }, { title: "Trail Gear" }, { title: "Camp Kitchen" }];
    const p = parseSeedPlan(JSON.stringify(raw));
    expect(p!.collections.map((c) => c.title)).toEqual(["Trail Gear", "Camp Kitchen"]);
    expect(p!.products).toHaveLength(3);
  });
  it("defaults a non-finite priceCents to 2900 and clamps a negative price to the floor", () => {
    // JSON cannot carry a literal NaN; 1e999 parses to Infinity, hitting the same
    // Number.isFinite guard a NaN would.
    const raw = good.replace('"priceCents":14800', '"priceCents":1e999').replace('"priceCents":6400', '"priceCents":-100');
    const p = parseSeedPlan(raw);
    expect(p).not.toBeNull();
    expect(p!.products[0].priceCents).toBe(2900);
    expect(p!.products[1].priceCents).toBe(500);
  });
  it("drops a product whose collection is not in the plan, clamps price into range", () => {
    const raw = JSON.parse(good);
    raw.products[1].collection = "Nonexistent";
    raw.products[2].priceCents = 9_000_000;
    const p = parseSeedPlan(JSON.stringify(raw));
    expect(p!.products).toHaveLength(2);
    expect(p!.products.find((x) => x.title === "Summit Shell Jacket")!.priceCents).toBeLessThanOrEqual(50000);
  });
});

describe("FALLBACK_SEED", () => {
  it("is itself a valid plan (round-trips the parser)", () => {
    expect(parseSeedPlan(JSON.stringify(FALLBACK_SEED))).not.toBeNull();
  });
  it("only uses known icon hints", () => {
    for (const p of FALLBACK_SEED.products) expect(ICON_HINTS).toContain(p.iconHint);
  });
});
