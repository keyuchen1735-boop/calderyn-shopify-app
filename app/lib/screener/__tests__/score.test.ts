import { describe, it, expect } from "vitest";
import {
  buildScoreCardMetrics,
  buildUserContent,
  parseTips,
  scoreCreative,
  toImageBlock,
  SCORE_TOOL_NAME,
} from "../score.server";
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
        input: {
        summary: "ok",
        dimensions: dims,
        tips: [{ title: "fix the hook", detail: "rewrite the opening line" }],
        ...overrides,
      },
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

describe("toImageBlock", () => {
  it("turns a data URL into a base64 source block", () => {
    expect(toImageBlock("data:image/webp;base64,QUJD")).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/webp", data: "QUJD" },
    });
  });
  it("turns an https URL into a url source block", () => {
    expect(toImageBlock("https://cdn.test/x.jpg")).toEqual({
      type: "image",
      source: { type: "url", url: "https://cdn.test/x.jpg" },
    });
  });
  it("rejects non-image data URLs and other schemes", () => {
    expect(toImageBlock("data:text/html;base64,QUJD")).toBeNull();
    expect(toImageBlock("file:///tmp/x.png")).toBeNull();
    expect(toImageBlock("")).toBeNull();
  });
});

describe("buildUserContent media handling", () => {
  it("returns plain text when there is no media", () => {
    expect(typeof buildUserContent(input, [])).toBe("string");
  });

  it("sends one image block for an uploaded (data URL) image", () => {
    const content = buildUserContent(
      { ...input, mediaKind: "image", imageUrl: "data:image/webp;base64,QUJD" },
      [],
    );
    expect(Array.isArray(content)).toBe(true);
    const blocks = content as Array<{ type: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(1);
  });

  it("sends a video preamble plus one block per frame, with the duration", () => {
    const content = buildUserContent(
      {
        ...input,
        mediaKind: "video",
        imageUrl: "data:image/webp;base64,QUJD",
        videoFrameUrls: ["data:image/webp;base64,QUJD", "data:image/webp;base64,REVG"],
        videoDurationSec: 12.4,
      },
      [],
    );
    const blocks = content as Array<{ type: string; text?: string }>;
    expect(blocks.filter((b) => b.type === "image")).toHaveLength(2);
    expect(blocks[0]?.type).toBe("text");
    expect(blocks[0]?.text).toMatch(/VIDEO creative \(~12s\)/);
    // The copy/audience text block still arrives last.
    expect(blocks[blocks.length - 1]?.text).toMatch(/Headline:/);
  });

  it("keeps the Meta https imageUrl path as a url source block", () => {
    const content = buildUserContent({ ...input, imageUrl: "https://cdn.test/x.jpg" }, []);
    const blocks = content as Array<{ type: string; source?: { type: string } }>;
    expect(blocks[0]?.source?.type).toBe("url");
  });
});

describe("buildUserContent caching breakpoint", () => {
  it("image case: marks the image block ephemeral and leaves the trailing copy text uncached", () => {
    const content = buildUserContent(
      { ...input, mediaKind: "image", imageUrl: "data:image/webp;base64,QUJD" },
      [],
    );
    const blocks = content as Array<{ type: string; cache_control?: unknown }>;
    const image = blocks.find((b) => b.type === "image");
    const text = blocks[blocks.length - 1];
    // Breakpoint on the media → cached prefix is tools + system + image.
    expect(image?.cache_control).toEqual({ type: "ephemeral" });
    // Trailing creative-copy text varies per re-score → must stay after the breakpoint.
    expect(text?.type).toBe("text");
    expect(text?.cache_control).toBeUndefined();
  });

  it("video case: only the last frame is ephemeral; earlier frames and trailing text are not", () => {
    const content = buildUserContent(
      {
        ...input,
        mediaKind: "video",
        imageUrl: "data:image/webp;base64,QUJD",
        videoFrameUrls: [
          "data:image/webp;base64,QUJD",
          "data:image/webp;base64,REVG",
          "data:image/webp;base64,R0hJ",
        ],
        videoDurationSec: 8,
      },
      [],
    );
    const blocks = content as Array<{ type: string; cache_control?: unknown }>;
    const images = blocks.filter((b) => b.type === "image");
    expect(images).toHaveLength(3);
    // Caches intro + all frames: only the LAST frame carries the breakpoint.
    expect(images[0].cache_control).toBeUndefined();
    expect(images[1].cache_control).toBeUndefined();
    expect(images[2].cache_control).toEqual({ type: "ephemeral" });
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe("text");
    expect(last.cache_control).toBeUndefined();
  });

  it("text-only fallback: returns a plain string (no block to carry a breakpoint)", () => {
    const content = buildUserContent({ ...input, imageUrl: null }, ["Ad A"]);
    expect(typeof content).toBe("string");
  });
});

describe("parseTips", () => {
  it("keeps structured {title, detail} tips, trimming whitespace", () => {
    expect(parseTips([{ title: "  Add a headline ", detail: " do it " }])).toEqual([
      { title: "Add a headline", detail: "do it" },
    ]);
  });

  it("normalizes legacy string tips to title-only (back-compat)", () => {
    expect(parseTips(["front-load the offer"])).toEqual([
      { title: "front-load the offer", detail: "" },
    ]);
  });

  it("drops tips with no usable title and handles non-arrays", () => {
    expect(parseTips([{ detail: "no title" }, "", { title: "  " }, 42])).toEqual([]);
    expect(parseTips(undefined)).toEqual([]);
  });
});

describe("scoreCreative", () => {
  it("calls the forced tool and returns metrics + summary + tips", async () => {
    const res = await scoreCreative(input, ["Top Ad A"], {
      createMessage: async () => fakeToolResult() as never,
      model: "test-model",
    });
    expect(res.summary).toBe("ok");
    expect(res.tips).toEqual([{ title: "fix the hook", detail: "rewrite the opening line" }]);
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
