import { describe, it, expect } from "vitest";
import { buildScoreCardMetrics, scoreCreative, SCORE_TOOL_NAME } from "../score.server";
import { DIMENSIONS, type CreativeInput } from "../types";

const input: CreativeInput = {
  imageUrl: null,
  headline: "Introducing our new serum",
  primaryText: "A serum for your skin. Buy now and feel great every single day.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example.com/p/serum?utm_campaign=spring",
  audience: "Women 25-44 interested in skincare",
};

function fakeToolResult(overrides?: Record<string, unknown>) {
  const dims = Object.fromEntries(
    DIMENSIONS.map((d) => [d.id, { score: 60, reasoning: `r:${d.id}` }]),
  );
  return {
    content: [
      {
        type: "tool_use",
        name: SCORE_TOOL_NAME,
        input: { summary: "ok", dimensions: dims, tips: ["fix the hook"], ...overrides },
      },
    ],
  };
}

describe("buildScoreCardMetrics", () => {
  it("maps all 13 dimensions with labels and reasoning, clamping out-of-range", () => {
    const dims = Object.fromEntries(DIMENSIONS.map((d) => [d.id, { score: 150, reasoning: "x" }]));
    const metrics = buildScoreCardMetrics(dims);
    expect(metrics).toHaveLength(13);
    expect(metrics.every((m) => m.score >= 0 && m.score <= 100)).toBe(true);
    expect(metrics.find((m) => m.id === "hook_strength")?.label).toBe("Hook strength");
  });
  it("defaults a missing dimension to 50 with empty reasoning", () => {
    const metrics = buildScoreCardMetrics({});
    expect(metrics).toHaveLength(13);
    expect(metrics[0].score).toBe(50);
  });
});

describe("scoreCreative", () => {
  it("calls the forced tool and returns metrics + summary + tips", async () => {
    const res = await scoreCreative(input, ["Top Ad A"], {
      createMessage: async () => fakeToolResult() as never,
      model: "test-model",
    });
    expect(res.summary).toBe("ok");
    expect(res.tips).toContain("fix the hook");
    expect(res.metrics).toHaveLength(13);
  });

  it("throws if the model does not return the tool call", async () => {
    await expect(
      scoreCreative(input, [], {
        createMessage: async () => ({ content: [{ type: "text", text: "no tool" }] }) as never,
        model: "test-model",
      }),
    ).rejects.toThrow();
  });
});
