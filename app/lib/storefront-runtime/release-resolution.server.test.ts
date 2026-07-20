import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  StorefrontReleaseHistoryEntry,
  StorefrontReleaseReader,
  StorefrontReleaseResolutionError,
  StorefrontVersionRecord,
} from "./release-resolution.server";
import { hasRuntime1Storefront, resolveRuntime1Route, resolveStorefrontRelease } from "./release-resolution.server";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { ATELIER_GRID_BUNDLE } from "~/lib/storefront-recipes/atelier-nine/bundle";
import { CUSTOM_BENCH_BUNDLE } from "~/lib/storefront-recipes/custom-bench/bundle";

const SHOP = "11111111-1111-1111-1111-111111111111";
const originalBundleRead = process.env.STOREFRONT_BUNDLE_READ;
const emptySearchPage = async () => ({
  items: [], facets: { categories: [], tags: [], collections: [] }, total: 0, hasNextPage: false,
});

function version(id: string, runtimeVersion: number, createdAt: string): StorefrontVersionRecord {
  return {
    id,
    shopId: SHOP,
    sourceKind: runtimeVersion === 0 ? "legacy" : "custom",
    status: "validated",
    schemaVersion: 1,
    runtimeVersion,
    validationProfileVersion: runtimeVersion === 0 ? 0 : 1,
    artifactHash: `sha256:${id}`,
    artifact: runtimeVersion === 0
      ? { sourceKind: "legacy", snapshot: { schemaVersion: 1, runtimeVersion: 0, validationProfileVersion: 0 } }
      : { sourceKind: "custom", bundle: { schemaVersion: 1, runtimeVersion } },
    createdAt,
  } as StorefrontVersionRecord;
}

function event(
  operation: StorefrontReleaseHistoryEntry["operation"],
  toVersion: StorefrontVersionRecord,
  fromVersion: StorefrontVersionRecord | null = null,
  occurredAt = "2026-07-13T00:00:00Z",
): StorefrontReleaseHistoryEntry {
  return { operation, fromVersion, toVersion, occurredAt };
}

function reader(
  published: StorefrontVersionRecord | null,
  history: StorefrontReleaseHistoryEntry[],
): StorefrontReleaseReader {
  return {
    readPublished: vi.fn(async () => published),
    readReleaseHistory: vi.fn(async () => history),
  };
}

afterEach(() => {
  if (originalBundleRead === undefined) delete process.env.STOREFRONT_BUNDLE_READ;
  else process.env.STOREFRONT_BUNDLE_READ = originalBundleRead;
  delete process.env.STOREFRONT_RUNTIME_1_READ;
});

describe("storefront release resolution", () => {
  it("falls back to the platform home surface when an old bundle has no story route", async () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const live = { ...version("old-six-route", 1, "2026-07-02T00:00:00Z"), artifact: { sourceKind: "custom" as const, bundle } };
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "story" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });
    expect(result?.routeId).toBe("home");
  });

  it("resolves registered recipe video bytes from immutable public media paths", async () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "volt", templateVersion: 1 };
    source.assets.entries = [
      { key: "hero-poster", contentHash: "b".repeat(64), mediaType: "image/webp", byteSize: 42 },
      { key: "hero-mp4", contentHash: "a".repeat(64), mediaType: "video/mp4", byteSize: 42 },
    ];
    source.routes.home.html = `<main><video data-cd-video data-cd-poster-asset="hero-poster"><source data-cd-asset="hero-mp4" type="video/mp4"></video></main>`;
    const bundle = compileBundle(source).bundle;
    const live = { ...version("video-recipe", 1, "2026-07-02T00:00:00Z"), sourceKind: "recipe" as const, artifact: { sourceKind: "recipe" as const, bundle } };
    const result = await resolveRuntime1Route({
      shopId: SHOP, route: { kind: "home" }, reader: reader(live, []), bundleReadEnabled: true,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
      },
    });
    expect(result?.data.storefrontAssetUrls?.["hero-mp4"]).toContain(`/storage/v1/object/public/storefront-recipe-assets/volt/${"a".repeat(64)}.mp4`);
  });

  it("resolves one immutable bundle for shell, route artifact, and live data", async () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const live = {
      ...version("live", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const source = reader(live, []);
    const catalog = {
      searchProductPage: vi.fn(emptySearchPage),
      listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })),
      listProducts: vi.fn(async () => []),
      listCollections: vi.fn(async () => []),
      getProduct: vi.fn(async () => null),
    };
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "product", handle: "missing" },
      reader: source,
      bundleReadEnabled: true,
      dataDependencies: {
        catalog,
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(source.readPublished).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      runtime: 1,
      bundleId: "live",
      artifactHash: "sha256:live",
      bundle,
      routeId: "product",
      data: { notFound: { kind: "product", handle: "missing" } },
    });
    expect(catalog.getProduct).toHaveBeenCalledWith(SHOP, "missing");
  });

  it("passes immutable featured product ids into home public-data resolution", async () => {
    const bundle = structuredClone(ATELIER_GRID_BUNDLE);
    bundle.featuredProductIds = ["product-b", "product-a"];
    const live = {
      ...version("featured", 1, "2026-07-02T00:00:00Z"),
      sourceKind: "recipe" as const,
      artifact: { sourceKind: "recipe" as const, bundle },
    };
    const listProducts = vi.fn(async () => []);

    await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "home" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      dataDependencies: {
        catalog: {
          searchProductPage: vi.fn(emptySearchPage),
          listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })),
          listProducts,
          listCollections: vi.fn(async () => []),
          getProduct: vi.fn(async () => null),
        },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(listProducts).toHaveBeenCalledWith(SHOP, {
      ids: ["product-b", "product-a"],
      limit: 2,
    });
  });

  it("isolates persisted pre-boundary shell CSS without mutating the stored bundle", async () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    bundle.shell.css = `[data-cd-bundle=shell] a{color:red}`;
    const live = {
      ...version("live-pre-boundary-css", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "home" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      dataDependencies: {
        catalog: {
          searchProductPage: vi.fn(emptySearchPage),
          listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })),
          listProducts: vi.fn(async () => []),
          listCollections: vi.fn(async () => []),
          getProduct: vi.fn(async () => null),
        },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(result?.bundle.shell.css).toContain(":not([data-cd-bundle-route]):not([data-cd-bundle-route] *)");
    expect(bundle.shell.css).toBe(`[data-cd-bundle=shell] a{color:red}`);
    expect(result?.bundle.routes).toBe(bundle.routes);
  });

  it("loads only verified logical custom asset URLs into presentation data", async () => {
    const sourceBundle = structuredClone(VALID_BUNDLE_SOURCE);
    sourceBundle.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    const bundle = compileBundle(sourceBundle).bundle;
    const live = {
      ...version("live-assets", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const assetUrlLoader = vi.fn(async () => ({ hero: "https://assets.example.test/signed-hero" }));
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "product", handle: "missing" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      assetUrlLoader,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).toHaveBeenCalledWith({ shopId: SHOP, bundleId: "live-assets", manifest: bundle.assets });
    expect(result?.data.storefrontAssetUrls).toEqual({ hero: "https://assets.example.test/signed-hero" });
  });

  it("serves recipe-derived custom assets from same-origin only when provenance matches the registered recipe exactly", async () => {
    const bundle = structuredClone(CUSTOM_BENCH_BUNDLE);
    bundle.assets.entries = [{
      key: "hero",
      contentHash: "f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9",
      mediaType: "image/webp",
      byteSize: 132568,
    }];
    bundle.source = {
      kind: "custom",
      generationId: "edit-generation",
      promptHash: `sha256:${"c".repeat(64)}`,
      derivedFromVersionId: "recipe-version",
      derivedFromTemplateId: "custom-bench",
      derivedFromTemplateVersion: 2,
    };
    const live = {
      ...version("derived-assets", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const assetUrlLoader = vi.fn(async () => ({}));
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "product", handle: "missing" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      assetUrlLoader,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).not.toHaveBeenCalled();
    expect(result?.data.storefrontAssetUrls).toEqual({
      hero: "/storefront-recipes/custom-bench/f6f25c15de46bf6dd431ae685202f90fbbc3ba00e8051f6a6f4afaa8b89cdde9.webp",
    });
  });

  it("never treats a tampered derived asset manifest as a deploy-owned recipe asset", async () => {
    const bundle = structuredClone(ATELIER_GRID_BUNDLE);
    bundle.source = {
      kind: "custom",
      generationId: "edit-generation",
      promptHash: `sha256:${"c".repeat(64)}`,
      derivedFromTemplateId: "atelier-nine",
      derivedFromTemplateVersion: 2,
    };
    bundle.assets.entries = [{ ...bundle.assets.entries[0]!, contentHash: "d".repeat(64) }];
    const live = {
      ...version("tampered-assets", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const assetUrlLoader = vi.fn(async () => ({ hero: "https://assets.example.test/verified-tampered" }));
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "product", handle: "missing" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      assetUrlLoader,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).toHaveBeenCalledWith({ shopId: SHOP, bundleId: "tampered-assets", manifest: bundle.assets });
    expect(result?.data.storefrontAssetUrls).toEqual({ hero: "https://assets.example.test/verified-tampered" });
  });

  it("fails closed to verified owned storage for an unknown derived recipe id", async () => {
    const bundle = structuredClone(ATELIER_GRID_BUNDLE);
    bundle.source = {
      kind: "custom",
      generationId: "edit-generation",
      promptHash: `sha256:${"c".repeat(64)}`,
      derivedFromTemplateId: "unknown-recipe",
      derivedFromTemplateVersion: 1,
    } as unknown as typeof bundle.source;
    const live = {
      ...version("unknown-derived-assets", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const assetUrlLoader = vi.fn(async () => ({ hero: "https://assets.example.test/verified-fallback" }));
    const result = await resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "product", handle: "missing" },
      reader: reader(live, []),
      bundleReadEnabled: true,
      assetUrlLoader,
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).toHaveBeenCalledWith({
      shopId: SHOP,
      bundleId: "unknown-derived-assets",
      manifest: bundle.assets,
    });
    expect(result?.data.storefrontAssetUrls).toEqual({ hero: "https://assets.example.test/verified-fallback" });
  });

  it("memoizes the immutable release by Request so parent and child consume one pointer read", async () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const live = {
      ...version("live-request", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const changed = version("changed-to-legacy", 0, "2026-07-03T00:00:00Z");
    const source = reader(live, []);
    vi.mocked(source.readPublished).mockResolvedValueOnce(live).mockResolvedValueOnce(changed);
    const request = new Request("https://shop.example/storefront");
    const shared = { shopId: SHOP, reader: source, bundleReadEnabled: true, request };

    await expect(hasRuntime1Storefront(shared)).resolves.toBe(true);
    await expect(resolveRuntime1Route({
      ...shared,
      route: { kind: "home" },
      dataDependencies: {
        catalog: { searchProductPage: vi.fn(emptySearchPage), listProductPage: vi.fn(async () => ({ items: [], nextCursor: null })), listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    })).resolves.toMatchObject({ runtime: 1, bundleId: "live-request" });
    expect(source.readPublished).toHaveBeenCalledTimes(1);
  });

  it("never selects a retained runtime-0 snapshot when bundle reads are disabled", async () => {
    const legacy = version("legacy", 0, "2026-07-01T00:00:00Z");
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const source = reader(live, [event("publish", live, legacy)]);
    process.env.STOREFRONT_RUNTIME_1_READ = "1";
    process.env.STOREFRONT_BUNDLE_READ = "0";
    await expect(resolveStorefrontRelease({ shopId: SHOP, reader: source }))
      .rejects.toMatchObject({ code: "no_compatible_storefront_release", status: 503 });
    process.env.STOREFRONT_BUNDLE_READ = "1";
    await expect(resolveStorefrontRelease({ shopId: SHOP, reader: source }))
      .resolves.toMatchObject({ kind: "runtime1", version: live });
  });

  it("ignores newer unpublished installs and preserves publish/rollback event order", async () => {
    const unsupported = version("future", 2, "2026-07-13T00:00:00Z");
    const immediatePublishedPredecessor = version("published-old", 1, "2026-01-01T00:00:00Z");
    const createdLaterButPublishedEarlier = version("created-newer", 1, "2026-06-01T00:00:00Z");
    const unpublishedDraft = version("unpublished-draft", 1, "2026-07-14T00:00:00Z");
    const history = [
      event("install_draft", unpublishedDraft, unsupported, "2026-07-14T00:00:00Z"),
      event("publish", unsupported, immediatePublishedPredecessor, "2026-07-13T00:00:00Z"),
      event("rollback", createdLaterButPublishedEarlier, null, "2026-07-12T00:00:00Z"),
    ];
    const resolved = await resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(unsupported, history),
    });
    expect(resolved).toMatchObject({
      kind: "runtime1",
      version: immediatePublishedPredecessor,
      fallbackFromVersionId: "future",
    });
  });

  it("skips a published runtime-0 release and resolves the newest compatible runtime-1 history entry", async () => {
    const publishedLegacy = version("legacy-published", 0, "2026-07-03T00:00:00Z");
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const history = [
      event("rollback", publishedLegacy, live, "2026-07-03T00:00:00Z"),
      event("publish", live, null, "2026-07-02T00:00:00Z"),
    ];
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(publishedLegacy, history),
    })).resolves.toMatchObject({ kind: "runtime1", version: live, fallbackFromVersionId: "legacy-published" });
  });

  it("fails safely when a published pointer has no compatible immutable predecessor", async () => {
    const unsupported = version("future", 2, "2026-07-03T00:00:00Z");
    const capturedButUnpublished = version("capture-only", 0, "2026-07-02T00:00:00Z");
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(unsupported, [event("capture_legacy", capturedButUnpublished)]),
    })).rejects.toEqual(expect.objectContaining<Partial<StorefrontReleaseResolutionError>>({
      code: "no_compatible_storefront_release",
      status: 503,
    }));
  });

  it("fails closed before any immutable runtime-1 release exists", async () => {
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(null, []),
    })).rejects.toMatchObject({ code: "no_compatible_storefront_release", status: 503 });
  });

  it("route resolution returns null for an unpublished shop instead of throwing", async () => {
    await expect(resolveRuntime1Route({
      shopId: SHOP,
      route: { kind: "home" },
      bundleReadEnabled: true,
      reader: reader(null, []),
    })).resolves.toBeNull();
  });
});
