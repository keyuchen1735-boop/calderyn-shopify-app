import { describe, expect, it, vi } from "vitest";
import {
  combineFirstRunDirections,
  generateFirstRunImages,
} from "~/lib/screener/first-run-creatives.server";
import type {
  CreativeGenerator,
  GenerateRequest,
} from "~/lib/screener/generate.server";
import type { CreativeInput, GeneratedCandidate } from "~/lib/screener/types";

const original: CreativeInput = {
  imageUrl: "https://cdn.example/product.png",
  mediaKind: "image",
  headline: "Trail pack",
  primaryText: "Weather-ready day pack with balanced storage.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example/products/trail-pack",
  audience: "hikers",
};

const request: GenerateRequest = {
  input: original,
  weakMetrics: [],
  tips: [],
  styleRefs: [],
  count: 3,
};

function candidate(
  patch: Partial<CreativeInput>,
  rationale: string,
): GeneratedCandidate {
  return { input: { ...original, ...patch }, rationale };
}

describe("combineFirstRunDirections", () => {
  it("pairs each copy direction with its generated product visual", () => {
    const copy = [
      candidate({ headline: "Copy one" }, "copy one"),
      candidate({ headline: "Copy two" }, "copy two"),
    ];
    const images = [
      candidate({ imageUrl: "https://gen.example/one.png" }, "image one"),
      candidate({ imageUrl: "https://gen.example/two.png" }, "image two"),
    ];

    const combined = combineFirstRunDirections(original, copy, images, 3);

    expect(combined).toHaveLength(2);
    expect(combined.map((direction) => direction.input.headline)).toEqual([
      "Copy one",
      "Copy two",
    ]);
    expect(combined.map((direction) => direction.input.imageUrl)).toEqual([
      "https://gen.example/one.png",
      "https://gen.example/two.png",
    ]);
    expect(combined.every((direction) => direction.imageGenerated)).toBe(true);
    expect(combined[0].rationale).toContain("copy one");
    expect(combined[0].rationale).toContain("image one");
  });

  it("keeps the real product image when the image provider is unavailable", () => {
    const combined = combineFirstRunDirections(
      original,
      [candidate({ headline: "Copy one" }, "copy")],
      [],
      3,
    );

    expect(combined[0].input.imageUrl).toBe(original.imageUrl);
    expect(combined[0].imageGenerated).toBe(false);
  });
});

describe("generateFirstRunImages", () => {
  it("passes the product reference through, reserves quota, persists output, and releases unused slots", async () => {
    const generate = vi.fn(async () => [
      candidate({ imageUrl: "https://provider.example/new.png" }, "generated"),
    ]);
    const generator: CreativeGenerator = {
      mode: "image",
      available: () => true,
      generate,
    };
    const reserve = vi.fn(async () => ({
      ok: true as const,
      eventIds: ["evt-1", "evt-2", "evt-3"],
    }));
    const release = vi.fn(async (_eventId: string | null) => undefined);
    const persist = vi.fn(async () => ({
      persisted: true as const,
      url: "https://owned.example/new.png",
      assetId: "asset-1",
      storageKey: "shop/new.png",
    }));

    const result = await generateFirstRunImages(
      { shop: "shop.example", count: 3, generator, request },
      {
        reserve,
        release,
        resolveShop: async () => "11111111-1111-1111-1111-111111111111",
        persist,
      },
    );

    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ imageUrl: original.imageUrl }),
        count: 3,
      }),
    );
    expect(reserve).toHaveBeenCalledWith("shop.example", 3);
    expect(persist).toHaveBeenCalledWith(
      "11111111-1111-1111-1111-111111111111",
      "https://provider.example/new.png",
      "campaign-creative",
      "generated",
    );
    expect(result.providerAttempted).toBe(true);
    expect(result.candidates[0].input.imageUrl).toBe(
      "https://owned.example/new.png",
    );
    expect(release.mock.calls.map(([id]) => id)).toEqual(["evt-2", "evt-3"]);
  });

  it("does not reserve quota when the image provider is unavailable", async () => {
    const reserve = vi.fn();
    const result = await generateFirstRunImages(
      {
        shop: "shop.example",
        count: 3,
        generator: { mode: "image", available: () => false, generate: vi.fn() },
        request,
      },
      {
        reserve,
        release: vi.fn(),
        resolveShop: vi.fn(),
        persist: vi.fn(),
      },
    );

    expect(result).toEqual({ candidates: [], providerAttempted: false });
    expect(reserve).not.toHaveBeenCalled();
  });

  it("does not expose an expiring provider URL when owned persistence fails", async () => {
    const release = vi.fn(async (_eventId: string | null) => undefined);
    const result = await generateFirstRunImages(
      {
        shop: "shop.example",
        count: 1,
        generator: {
          mode: "image",
          available: () => true,
          generate: vi.fn(async () => [
            candidate(
              { imageUrl: "https://provider.example/temporary.png" },
              "generated",
            ),
          ]),
        },
        request,
      },
      {
        reserve: async () => ({ ok: true, eventIds: ["evt-1"] }),
        release,
        resolveShop: async () => "11111111-1111-1111-1111-111111111111",
        persist: async (_shopId, url) => ({
          persisted: false,
          url,
          error: "storage unavailable",
        }),
      },
    );

    expect(result).toEqual({ candidates: [], providerAttempted: true });
    expect(release).not.toHaveBeenCalledWith("evt-1");
  });
});
