import { describe, expect, it, vi } from "vitest";
import { compileBundle } from "../storefront-compiler/compile";
import { createFullSource } from "./__fixtures__/deterministic";
import { materializeOwnedAssets } from "./assets.server";
import { proveAndRepairBundle } from "./proof.server";

describe("materializeOwnedAssets", () => {
  it("persists immutable owned bytes and returns logical manifest keys without URLs", async () => {
    const result = await materializeOwnedAssets({
      shopId: "11111111-1111-4111-8111-111111111111",
      requests: [{ key: "hero", purpose: "editorial hero", required: true }],
      produce: async () => ({ bytes: new Uint8Array([1, 2, 3]), provenance: "generated:fixture" }),
      persist: async () => ({ assetKey: "owned/sha256/abc.webp", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }),
    });
    expect(result.manifest.entries).toEqual([{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 3 }]);
    expect(result.persisted[0]).toMatchObject({ logicalKey: "hero", assetKey: "owned/sha256/abc.webp", provenance: "generated:fixture" });
    expect(JSON.stringify(result.manifest)).not.toContain("http");
  });

  it("fails a required asset instead of installing a dangling reference", async () => {
    await expect(materializeOwnedAssets({
      shopId: "11111111-1111-4111-8111-111111111111",
      requests: [{ key: "hero", purpose: "hero", required: true }],
      produce: async () => null,
      persist: vi.fn(),
    })).rejects.toThrow(/required asset/i);
  });
});

describe("proveAndRepairBundle", () => {
  it("repairs only the failing route and preserves every untouched artifact", async () => {
    const initial = createFullSource();
    const originalHome = structuredClone(initial.routes.home);
    let proofCalls = 0;
    const repair = vi.fn(async () => ({
      routeId: "product" as const,
      route: { ...initial.routes.product, html: `<main><h1 data-cd-text="product.title"></h1><div data-cd-slot="addToCart" data-cd-host-size="block"></div><p>Repaired</p></main>` },
    }));
    const result = await proveAndRepairBundle({
      source: initial,
      compile: compileBundle,
      proof: async () => ++proofCalls === 1
        ? { ok: false, diagnostics: [{ routeId: "product", regionId: "purchase", code: "hit-test", message: "covered" }], screenshots: [], browserMs: 20 }
        : { ok: true, diagnostics: [], screenshots: ["proof.webp"], browserMs: 20 },
      repair,
      maxRepairs: 2,
    });
    expect(result.repairs).toBe(1);
    expect(result.source.routes.home).toEqual(originalHome);
    expect(result.source.routes.product.html).toContain("Repaired");
    expect(repair).toHaveBeenCalledWith(expect.objectContaining({ routeId: "product", regionId: "purchase" }));
  });

  it("stops after the targeted repair budget without substituting fallback routes", async () => {
    const source = createFullSource();
    await expect(proveAndRepairBundle({
      source,
      compile: compileBundle,
      proof: async () => ({ ok: false, diagnostics: [{ routeId: "cart", code: "keyboard", message: "inert" }], screenshots: [], browserMs: 1 }),
      repair: async () => ({ routeId: "cart", route: source.routes.cart }),
      maxRepairs: 2,
    })).rejects.toThrow(/browser proof failed/i);
  });
});
