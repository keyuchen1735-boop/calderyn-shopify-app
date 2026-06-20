// app/lib/actions/__tests__/discontinue-flag.test.ts
import { describe, it, expect, vi } from "vitest";
import { resolveSkuForDiscontinue, setDoNotReorder } from "../discontinue.server";

// Minimal Supabase chain mock: from().select().eq().eq().maybeSingle() and
// from().update().eq().eq().eq().
function sbWith(skuRow: Record<string, unknown> | null) {
  const update = vi.fn(() => ({ eq: () => ({ eq: () => ({ eq: () => ({ error: null }) }) }) }));
  return {
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: skuRow, error: null }) }) }),
      }),
      update,
    })),
    _update: update,
  } as never;
}

describe("resolveSkuForDiscontinue", () => {
  it("returns the sku id + product GID for a shop-owned sku code", async () => {
    const sb = sbWith({ id: "sku-1", product_id: "gid://shopify/Product/9", do_not_reorder: false });
    const res = await resolveSkuForDiscontinue(sb, "shop-1", "SUMMIT-TEE-M");
    expect(res).toEqual({ skuId: "sku-1", productGid: "gid://shopify/Product/9", alreadyFlagged: false });
  });

  it("returns null when the sku code is not found for the shop", async () => {
    const sb = sbWith(null);
    expect(await resolveSkuForDiscontinue(sb, "shop-1", "NOPE")).toBeNull();
  });

  it("returns null product GID when the sku has no product_id (can't archive)", async () => {
    const sb = sbWith({ id: "sku-1", product_id: null, do_not_reorder: false });
    const res = await resolveSkuForDiscontinue(sb, "shop-1", "SUMMIT-TEE-M");
    expect(res).toEqual({ skuId: "sku-1", productGid: null, alreadyFlagged: false });
  });
});

describe("setDoNotReorder", () => {
  it("writes the flag scoped to shop + sku id", async () => {
    const sb = sbWith({ id: "sku-1" });
    await setDoNotReorder(sb, "shop-1", "sku-1", true);
    expect((sb as never as { _update: ReturnType<typeof vi.fn> })._update).toHaveBeenCalledWith({
      do_not_reorder: true,
    });
  });
});
