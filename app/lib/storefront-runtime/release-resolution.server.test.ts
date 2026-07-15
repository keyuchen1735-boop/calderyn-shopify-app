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

const SHOP = "11111111-1111-1111-1111-111111111111";
const originalBundleRead = process.env.STOREFRONT_BUNDLE_READ;

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
  it("resolves one immutable bundle for shell, route artifact, and live data", async () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const live = {
      ...version("live", 1, "2026-07-02T00:00:00Z"),
      artifact: { sourceKind: "custom" as const, bundle },
    };
    const source = reader(live, []);
    const catalog = {
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
        catalog: { listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).toHaveBeenCalledWith({ shopId: SHOP, bundleId: "live-assets", manifest: bundle.assets });
    expect(result?.data.storefrontAssetUrls).toEqual({ hero: "https://assets.example.test/signed-hero" });
  });

  it("serves recipe-derived custom assets from same-origin only when provenance matches the registered recipe exactly", async () => {
    const bundle = structuredClone(ATELIER_GRID_BUNDLE);
    bundle.source = {
      kind: "custom",
      generationId: "edit-generation",
      promptHash: `sha256:${"c".repeat(64)}`,
      derivedFromVersionId: "recipe-version",
      derivedFromTemplateId: "atelier-nine",
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
        catalog: { listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    });

    expect(assetUrlLoader).not.toHaveBeenCalled();
    expect(result?.data.storefrontAssetUrls).toEqual({
      hero: "/storefront-recipes/atelier-nine/hero.webp",
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
    bundle.assets.entries[0] = { ...bundle.assets.entries[0]!, contentHash: "d".repeat(64) };
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
        catalog: { listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
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
        catalog: { listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
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
        catalog: { listProducts: vi.fn(async () => []), listCollections: vi.fn(async () => []), getProduct: vi.fn(async () => null) },
        settingsLoader: async () => ({ storeName: "Acme", logoUrl: null }) as never,
        policyLoader: async () => [],
      },
    })).resolves.toMatchObject({ runtime: 1, bundleId: "live-request" });
    expect(source.readPublished).toHaveBeenCalledTimes(1);
  });

  it("uses only STOREFRONT_BUNDLE_READ to select the immutable bundle", async () => {
    const legacy = version("legacy", 0, "2026-07-01T00:00:00Z");
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const source = reader(live, [event("publish", live, legacy)]);
    process.env.STOREFRONT_RUNTIME_1_READ = "1";
    process.env.STOREFRONT_BUNDLE_READ = "0";
    await expect(resolveStorefrontRelease({ shopId: SHOP, reader: source }))
      .resolves.toMatchObject({ kind: "runtime0-snapshot", version: legacy });
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

  it("accepts legacy capture only when it is the explicit predecessor of a publish", async () => {
    const live = version("live", 1, "2026-07-02T00:00:00Z");
    const publishedLegacy = version("legacy-published", 0, "2026-07-01T00:00:00Z");
    const neverPublishedCapture = version("legacy-unpublished", 0, "2026-07-03T00:00:00Z");
    const history = [
      event("capture_legacy", neverPublishedCapture, null, "2026-07-03T00:00:00Z"),
      event("publish", live, publishedLegacy, "2026-07-02T00:00:00Z"),
    ];
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: false,
      reader: reader(live, history),
    })).resolves.toMatchObject({ kind: "runtime0-snapshot", version: publishedLegacy });
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

  it("uses mutable runtime-0 only before any immutable published release exists", async () => {
    await expect(resolveStorefrontRelease({
      shopId: SHOP,
      bundleReadEnabled: true,
      reader: reader(null, []),
    })).resolves.toEqual({ kind: "runtime0-live" });
  });
});
