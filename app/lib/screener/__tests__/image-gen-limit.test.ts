import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { decideImageGenLimit, imageGenLimits } from "../image-gen-limit.server";

describe("decideImageGenLimit", () => {
  const limits = { perShopDaily: 20, globalDaily: 300 };

  it("allows when both counts are under their limits", () => {
    expect(
      decideImageGenLimit({ shopCount: 5, globalCount: 100, ...limits }),
    ).toEqual({ ok: true });
  });

  it("blocks with scope 'shop' when the per-shop count has reached the limit", () => {
    expect(
      decideImageGenLimit({ shopCount: 20, globalCount: 100, ...limits }),
    ).toEqual({
      ok: false,
      scope: "shop",
      limit: 20,
    });
  });

  it("blocks with scope 'global' when the global count has reached the limit", () => {
    expect(
      decideImageGenLimit({ shopCount: 5, globalCount: 300, ...limits }),
    ).toEqual({
      ok: false,
      scope: "global",
      limit: 300,
    });
  });

  it("reports the shop limit first when both are exceeded", () => {
    expect(
      decideImageGenLimit({ shopCount: 25, globalCount: 400, ...limits }),
    ).toEqual({
      ok: false,
      scope: "shop",
      limit: 20,
    });
  });
});

describe("imageGenLimits", () => {
  const KEYS = ["IMAGE_GEN_DAILY_PER_SHOP", "IMAGE_GEN_DAILY_GLOBAL"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults to 9 per shop and 30 global", () => {
    expect(imageGenLimits()).toEqual({ perShopDaily: 9, globalDaily: 30 });
  });

  it("reads positive integer env overrides", () => {
    process.env.IMAGE_GEN_DAILY_PER_SHOP = "5";
    process.env.IMAGE_GEN_DAILY_GLOBAL = "50";
    expect(imageGenLimits()).toEqual({ perShopDaily: 5, globalDaily: 50 });
  });

  it("ignores non-positive / non-numeric overrides and uses defaults", () => {
    process.env.IMAGE_GEN_DAILY_PER_SHOP = "0";
    process.env.IMAGE_GEN_DAILY_GLOBAL = "abc";
    expect(imageGenLimits()).toEqual({ perShopDaily: 9, globalDaily: 30 });
  });
});
