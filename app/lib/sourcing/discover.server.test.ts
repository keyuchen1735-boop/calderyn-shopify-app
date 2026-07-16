import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickProduct } from "./discover.server";

const mocks = vi.hoisted(() => ({
  sourceMaybeSingle: vi.fn(),
  mediaInsert: vi.fn(),
  linkInsert: vi.fn(),
  createProduct: vi.fn(),
  rateLimit: vi.fn(),
  readPointers: vi.fn(),
  runCommand: vi.fn(),
}));

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => {
      if (table === "source_product") {
        return { select: () => ({ eq: () => ({ maybeSingle: mocks.sourceMaybeSingle }) }) };
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
  readStorefrontReleasePointers: mocks.readPointers,
}));
vi.mock("~/lib/storefront-command/command.server", () => ({
  runStoreCommand: mocks.runCommand,
  StoreCommandError: class StoreCommandError extends Error {
    constructor(public code: string, message: string, public status: number) { super(message); }
  },
}));

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
  mocks.readPointers.mockResolvedValue({ draftVersionId: null, publishedVersionId: null });
  mocks.runCommand.mockResolvedValue({ status: "installed", versionId: "version-1", undo: null });
});

describe("pickProduct Store command handoff", () => {
  it("builds a fresh no-draft store through the command boundary", async () => {
    await expect(pickProduct("shop-1", "source-1")).resolves.toEqual({
      productId: "product-1",
      storeRunId: "version-1",
    });
    expect(mocks.runCommand).toHaveBeenCalledWith({
      shopId: "shop-1",
      command: { kind: "prompt", prompt: "Build my store", expectedDraftVersionId: null },
    });
  });

  it("does not rebuild an existing live-bound catalog after a pick", async () => {
    mocks.readPointers.mockResolvedValue({ draftVersionId: "version-1", publishedVersionId: null });
    await expect(pickProduct("shop-1", "source-1")).resolves.toEqual({
      productId: "product-1",
      storeRunId: null,
      storeBuildSkipped: "existing_store",
    });
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("does not rebuild a published-only store after a pick", async () => {
    mocks.readPointers.mockResolvedValue({ draftVersionId: null, publishedVersionId: "version-1" });
    await expect(pickProduct("shop-1", "source-1")).resolves.toEqual({
      productId: "product-1",
      storeRunId: null,
      storeBuildSkipped: "existing_store",
    });
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });

  it("keeps the picked product when the command refuses the fresh build", async () => {
    mocks.runCommand.mockRejectedValue(Object.assign(new Error("Unavailable"), {
      code: "storefront_command_unavailable",
      status: 503,
    }));
    await expect(pickProduct("shop-1", "source-1")).resolves.toEqual({
      productId: "product-1",
      storeRunId: null,
      storeBuildSkipped: "storefront_command_unavailable",
    });
    expect(mocks.createProduct).toHaveBeenCalledOnce();
  });

  it("keeps the picked product and returns a safe skip when release pointers cannot be read", async () => {
    mocks.readPointers.mockRejectedValue(new Error("database unavailable"));
    await expect(pickProduct("shop-1", "source-1")).resolves.toEqual({
      productId: "product-1",
      storeRunId: null,
      storeBuildSkipped: "storefront_command_unavailable",
    });
    expect(mocks.createProduct).toHaveBeenCalledOnce();
    expect(mocks.runCommand).not.toHaveBeenCalled();
  });
});
