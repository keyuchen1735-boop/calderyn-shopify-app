import { describe, it, expect } from "vitest";
import { generateImprovements, copyGenerator, GENERATE_TOOL_NAME, type GateDeps } from "../generate.server";
import { DIMENSIONS, type CreativeInput, type ScoreCard, type GeneratedCandidate } from "../types";

const original: CreativeInput = {
  imageUrl: null, headline: "Introducing our serum", primaryText: "Buy now.",
  cta: "SHOP_NOW", destinationUrl: "https://x.test/p", audience: "women 25-44",
};

function scorecard(composite: number): ScoreCard {
  return {
    composite, grade: "okay", confidence: "medium", summary: "ok",
    metrics: DIMENSIONS.map((d, i) => ({ id: d.id, group: d.group, label: d.label, score: i < 3 ? 40 : 70, reasoning: "r" })),
    outcomes: {
      estimatedRoas: 2, roasLow: 1.5, roasHigh: 2.6, breakEvenRoas: 1.9, predictedCtr: 0.01,
      holdRate: 0.05, assumedSpendCents: 50000, predictedRevenueCents: 100000, mappedSku: null, skuPriceCents: null,
    },
    tips: ["front-load the offer"],
  };
}

const cand = (headline: string): GeneratedCandidate => ({
  input: { ...original, headline }, rationale: `addresses hook via ${headline}`,
});

function gateDeps(over: Partial<GateDeps> = {}): GateDeps {
  return {
    generator: {
      mode: "copy",
      available: () => true,
      generate: async () => [cand("A"), cand("B"), cand("C")],
    },
    scoreOne: async (input) => {
      const map: Record<string, number> = { A: 80, B: 50, C: 90 };
      return { composite: map[input.headline] ?? 0, summary: `s:${input.headline}`, metrics: [] };
    },
    ...over,
  };
}

describe("generateImprovements (re-score gate)", () => {
  it("keeps only variants that beat the original, ranked best-first", async () => {
    const out = await generateImprovements({ original, originalScorecard: scorecard(64), count: 3 }, gateDeps());
    expect(out.available).toBe(true);
    expect(out.generated).toBe(3);
    expect(out.discarded).toBe(1);
    expect(out.variants.map((v) => v.input.headline)).toEqual(["C", "A"]);
    expect(out.variants[0].delta).toBe(26);
    expect(out.variants[0].rationale).toContain("C");
  });

  it("short-circuits when the generator is unavailable", async () => {
    const out = await generateImprovements(
      { original, originalScorecard: scorecard(64) },
      gateDeps({ generator: { mode: "image", available: () => false, generate: async () => [] } }),
    );
    expect(out.available).toBe(false);
    expect(out.variants).toEqual([]);
    expect(out.generated).toBe(0);
  });

  it("returns no winners when nothing beats the original", async () => {
    const out = await generateImprovements({ original, originalScorecard: scorecard(95) }, gateDeps());
    expect(out.variants).toEqual([]);
    expect(out.discarded).toBe(3);
  });

  it("survives a scoreOne failure on one candidate (keeps the rest)", async () => {
    const out = await generateImprovements(
      { original, originalScorecard: scorecard(64), count: 3 },
      gateDeps({
        scoreOne: async (input) => {
          if (input.headline === "B") throw new Error("transient score error");
          const map: Record<string, number> = { A: 80, C: 90 };
          return { composite: map[input.headline] ?? 0, summary: "s", metrics: [] };
        },
      }),
    );
    expect(out.variants.map((v) => v.input.headline)).toEqual(["C", "A"]);
    expect(out.generated).toBe(3);
    expect(out.discarded).toBe(1); // B failed re-scoring → discarded, not crashing the batch
  });

  it("returns every re-scored candidate in allScored so the UI can show losing remakes with critiques", async () => {
    const out = await generateImprovements({ original, originalScorecard: scorecard(64), count: 3 }, gateDeps());
    // winners stay filtered/ranked, but allScored keeps B (50 < 64) with its critique
    expect(out.variants.map((v) => v.input.headline)).toEqual(["C", "A"]);
    expect(out.allScored.map((v) => v.input.headline)).toEqual(["C", "A", "B"]);
    const b = out.allScored.find((v) => v.input.headline === "B");
    expect(b?.composite).toBe(50);
    expect(b?.delta).toBe(-14);
    expect(b?.summary).toBe("s:B");
  });

  it("passes extraDirection through to the generator", async () => {
    let seen: string | undefined;
    await generateImprovements(
      { original, originalScorecard: scorecard(64), extraDirection: "golden hour, UGC handheld" },
      gateDeps({
        generator: {
          mode: "image",
          available: () => true,
          generate: async (req) => {
            seen = req.extraDirection;
            return [];
          },
        },
      }),
    );
    expect(seen).toBe("golden hour, UGC handheld");
  });

  it("passes styleRefs through to the generator", async () => {
    let seen: string[] = [];
    await generateImprovements(
      { original, originalScorecard: scorecard(64), styleRefs: ["Top Ad A", "Top Ad B"] },
      gateDeps({
        generator: {
          mode: "copy",
          available: () => true,
          generate: async (req) => {
            seen = req.styleRefs;
            return [];
          },
        },
      }),
    );
    expect(seen).toEqual(["Top Ad A", "Top Ad B"]);
  });
});

describe("copyGenerator", () => {
  it("calls the forced tool and returns candidates", async () => {
    const gen = copyGenerator({
      createMessage: async () => ({
        content: [{ type: "tool_use", name: GENERATE_TOOL_NAME, input: {
          variants: [
            { headline: "New hook", primaryText: "Tight body.", cta: "SHOP_NOW", rationale: "fixes hook" },
          ],
        } }],
      }) as never,
      model: "m",
    });
    const out = await gen.generate({ input: original, weakMetrics: [], tips: [], styleRefs: [], count: 1 });
    expect(gen.mode).toBe("copy");
    expect(gen.available()).toBe(true);
    expect(out[0].input.headline).toBe("New hook");
    expect(out[0].input.destinationUrl).toBe(original.destinationUrl);
    expect(out[0].rationale).toBe("fixes hook");
  });
});
