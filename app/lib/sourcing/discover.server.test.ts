import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalderynError } from "~/lib/calderyn.server";
import { pickProduct } from "./discover.server";

const mocks = vi.hoisted(() => ({
  sourceMaybeSingle: vi.fn(),
  mediaInsert: vi.fn(),
  linkInsert: vi.fn(),
  createProduct: vi.fn(),
  rateLimit: vi.fn(),
  prepareBuild: vi.fn(),
  build: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "source_product") {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: mocks.sourceMaybeSingle }),
          }),
        };
      }
      if (table === "product_media") return { insert: mocks.mediaInsert };
      if (table === "sourced_product_link") return { insert: mocks.linkInsert };
      throw new Error(`Unexpected table ${table}`);
    },
  }),
}));

vi.mock("~/lib/catalog/catalog.server", () => ({ createProduct: mocks.createProduct }));
vi.mock("~/lib/dashboard/http.server", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("~/lib/storefront-bundle/build.server", () => ({
  buildStorefrontDesign: mocks.build,
  prepareStorefrontDesignBuild: mocks.prepareBuild,
  StorefrontBuildError: class StorefrontBuildError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));
vi.mock("~/lib/storefront-bundle/release.server", () => ({
  StorefrontReleaseError: class StorefrontReleaseError extends Error {
    constructor(public code: string, message: string, public status: number) {
      super(message);
    }
  },
}));
vi.mock("~/lib/calderyn.server", () => ({
  CalderynError: class CalderynError extends Error {
    code: string;
    status: number;
    details: unknown;

    constructor(opts: { code: string; status: number; message: string; details?: unknown }) {
      super(opts.message);
      this.name = "CalderynError";
      this.code = opts.code;
      this.status = opts.status;
      this.details = opts.details;
    }
  },
}));

describe("pickProduct runtime-1 build refusal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sourceMaybeSingle.mockResolvedValue({
      data: {
        id: "source-1",
        title: "Mini Blender",
        category: "Kitchen",
        image_urls: ["https://supplier.example/blender.webp"],
        unit_cost_cents: 800,
        moq: 1,
        lead_time_days: 9,
        provider: "fixture",
        external_id: "fx-1",
        supplier_id: "supplier-1",
        supplier: {
          provider: "fixture",
          external_supplier_id: "sup-a",
          name: "HomeGoods",
          reliability_score: 0.9,
        },
      },
      error: null,
    });
    mocks.createProduct.mockResolvedValue({ id: "product-1" });
    mocks.mediaInsert.mockResolvedValue({ error: null });
    mocks.linkInsert.mockResolvedValue({ error: null });
    mocks.rateLimit.mockResolvedValue(true);
  });

  it("returns the picked product when runtime-1 preflight refuses the paid AI quota", async () => {
    mocks.prepareBuild.mockRejectedValue(new CalderynError({
      code: "ai_daily_limit",
      status: 429,
      message: "Daily AI quota reached.",
    }));

    await expect(pickProduct("shop-1", "source-1", { trusted: false })).resolves.toEqual({
      productId: "product-1",
      storeRunId: null,
      storeBuildSkipped: "ai_daily_limit",
    });
    expect(mocks.createProduct).toHaveBeenCalledOnce();
    expect(mocks.prepareBuild).toHaveBeenCalledOnce();
    expect(mocks.build).not.toHaveBeenCalled();
  });
});
