import { describe, it, expect, vi } from "vitest";

// Route modules eagerly construct the Shopify app at import; stub like the
// other route tests so CI (no SHOPIFY_APP_URL) can load the module.
vi.mock("../../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

/* eslint-disable import/first -- imports must follow vi.mock */
import {
  parseGeneratorForm,
  weakestMetrics,
  GENERATOR_STYLES,
  GENERATOR_ASPECTS,
} from "../../../routes/app.generator";
import { DIMENSIONS, type ScoreCard } from "../types";
/* eslint-enable import/first */

function form(entries: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(entries)) fd.set(k, v);
  return fd;
}

describe("parseGeneratorForm", () => {
  it("reads style, aspect, count and trimmed extra direction", () => {
    const out = parseGeneratorForm(
      form({ style: "ugc", aspect: "9:16", count: "4", extraDirection: "  golden hour  " }),
    );
    expect(out).toEqual({ style: "ugc", aspect: "9:16", count: 4, extraDirection: "golden hour" });
  });

  it("defaults unknown or missing values (style studio, aspect 1:1, count 1)", () => {
    const out = parseGeneratorForm(form({ style: "bogus", aspect: "16:10", count: "2" }));
    expect(out).toEqual({ style: "studio", aspect: "1:1", count: 1, extraDirection: "" });
  });

  it("caps extra direction length so the prompt can't be flooded", () => {
    const out = parseGeneratorForm(form({ extraDirection: "x".repeat(1000) }));
    expect(out.extraDirection).toHaveLength(500);
  });
});

describe("generator constants", () => {
  it("every aspect maps to a platform aspect_ratio value", () => {
    expect(GENERATOR_ASPECTS["1:1"]).toBe("1:1");
    expect(GENERATOR_ASPECTS["3:4"]).toBe("3:4");
    expect(GENERATOR_ASPECTS["9:16"]).toBe("9:16");
  });
  it("every style has a prompt preset", () => {
    for (const preset of Object.values(GENERATOR_STYLES)) {
      expect(preset.prompt.length).toBeGreaterThan(10);
      expect(preset.label.length).toBeGreaterThan(2);
    }
  });
});

describe("weakestMetrics", () => {
  it("returns the n weakest dimensions, weakest first", () => {
    const card = {
      metrics: DIMENSIONS.map((d, i) => ({
        id: d.id, group: d.group, label: d.label, score: (i * 7) % 100, reasoning: `r${i}`,
      })),
    } as ScoreCard;
    const weak = weakestMetrics(card, 4);
    expect(weak).toHaveLength(4);
    expect(weak[0].score).toBeLessThanOrEqual(weak[1].score);
    expect(weak.map((m) => m.score)).toEqual([...weak.map((m) => m.score)].sort((a, b) => a - b));
  });
});
