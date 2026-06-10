import { describe, it, expect } from "vitest";
import { buildCreativeParams, pushIdempotencyKey } from "../meta-push.server";
import type { CreativeInput } from "../types";

const INPUT: CreativeInput = {
  imageUrl: "https://img.example/x.png",
  headline: "Glow serum",
  primaryText: "Hydrate overnight.",
  cta: "SHOP_NOW",
  destinationUrl: "https://shop.example/x",
  audience: "skincare 25-40",
};

describe("buildCreativeParams", () => {
  it("builds object_story_spec with page_id, copy, cta, and the picture URL", () => {
    const params = buildCreativeParams("My ad", INPUT, "page_1");
    expect(params.name).toBe("My ad");
    const spec = JSON.parse(params.object_story_spec);
    expect(spec.page_id).toBe("page_1");
    expect(spec.link_data.message).toBe("Hydrate overnight.");
    expect(spec.link_data.name).toBe("Glow serum");
    expect(spec.link_data.link).toBe("https://shop.example/x");
    expect(spec.link_data.picture).toBe("https://img.example/x.png");
    expect(spec.link_data.call_to_action).toEqual({
      type: "SHOP_NOW",
      value: { link: "https://shop.example/x" },
    });
  });

  it("omits picture when the variant has no image", () => {
    const spec = JSON.parse(
      buildCreativeParams("n", { ...INPUT, imageUrl: null }, "page_1").object_story_spec,
    );
    expect(spec.link_data.picture).toBeUndefined();
  });
});

describe("pushIdempotencyKey", () => {
  it("is deterministic per run + variant index", () => {
    expect(pushIdempotencyKey("run_1", 2)).toBe("screener_push:run_1:2");
  });
});
