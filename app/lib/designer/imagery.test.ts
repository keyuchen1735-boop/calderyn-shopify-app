// Reserved first-build image budget (spec D4): the designer's first build
// raises its own per-shop ceiling through a limits override into the shared
// reservation meter — never by changing the RPC's counting semantics, and
// never touching the global daily backstop.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock calls are hoisted above imports, so importing the module under test
// here still sees the mocked seams.
import { designerFirstBuildImageLimits, generateDesignerAsset } from "./imagery.server";

const { generateGeminiImages, persistExternalImage, upsert } = vi.hoisted(() => ({
  generateGeminiImages: vi.fn(),
  persistExternalImage: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("~/lib/storegen/imagery/gemini.server", () => ({
  generateGeminiImages,
  geminiImageGenerationEnabled: () => true,
  ImageGenerationQuotaError: class ImageGenerationQuotaError extends Error {},
}));
vi.mock("~/lib/assets/persist.server", () => ({ persistExternalImage }));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ upsert }) }),
  resolveShopId: vi.fn(async (value: string) => value),
}));

const SHOP = "00000000-0000-0000-0000-000000000010";

beforeEach(() => {
  vi.clearAllMocks();
  generateGeminiImages.mockResolvedValue(["data:image/png;base64,aGVsbG8="]);
  persistExternalImage.mockResolvedValue({ persisted: true, url: "https://owned.example/hero.png" });
  upsert.mockResolvedValue({ error: null });
});

afterEach(() => {
  delete process.env.DESIGNER_FIRST_BUILD_IMAGE_RESERVE;
  delete process.env.IMAGE_GEN_DAILY_PER_SHOP;
  delete process.env.IMAGE_GEN_DAILY_GLOBAL;
});

describe("designerFirstBuildImageLimits", () => {
  it("adds the default reserve (4) to the per-shop cap and never raises the global cap", () => {
    expect(designerFirstBuildImageLimits()).toEqual({ perShopDaily: 13, globalDaily: 30 });
  });

  it("is tunable via DESIGNER_FIRST_BUILD_IMAGE_RESERVE", () => {
    process.env.DESIGNER_FIRST_BUILD_IMAGE_RESERVE = "2";
    expect(designerFirstBuildImageLimits()).toEqual({ perShopDaily: 11, globalDaily: 30 });
    process.env.DESIGNER_FIRST_BUILD_IMAGE_RESERVE = "0";
    expect(designerFirstBuildImageLimits()).toEqual({ perShopDaily: 9, globalDaily: 30 });
  });

  it("falls back to the default reserve on a junk env value", () => {
    process.env.DESIGNER_FIRST_BUILD_IMAGE_RESERVE = "lots";
    expect(designerFirstBuildImageLimits()).toEqual({ perShopDaily: 13, globalDaily: 30 });
  });

  it("layers on top of the env-derived shared cap", () => {
    process.env.IMAGE_GEN_DAILY_PER_SHOP = "5";
    expect(designerFirstBuildImageLimits()).toEqual({ perShopDaily: 9, globalDaily: 30 });
  });
});

describe("generateDesignerAsset limits plumbing", () => {
  it("threads a limits override into the shared image pipeline", async () => {
    await generateDesignerAsset({
      shopId: SHOP,
      key: "hero",
      prompt: "hero photo",
      limits: { perShopDaily: 13 },
    });
    expect(generateGeminiImages).toHaveBeenCalledWith(
      expect.objectContaining({ limits: { perShopDaily: 13 }, purpose: "storefront_design" }),
    );
  });

  it("passes no override when the caller does not hold a reserve", async () => {
    await generateDesignerAsset({ shopId: SHOP, key: "hero", prompt: "hero photo" });
    expect(generateGeminiImages).toHaveBeenCalledWith(
      expect.objectContaining({ limits: undefined }),
    );
  });
});
