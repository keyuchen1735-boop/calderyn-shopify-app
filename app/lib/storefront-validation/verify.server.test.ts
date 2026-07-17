import { describe, expect, it, vi } from "vitest";
import type * as BrowserServerModule from "./browser.server";
import * as commandServer from "../storefront-command/command.server";
import type { RunStoreCommandInput } from "../storefront-command/command.server";
import { createStorefrontFullStory } from "./full-story.server";
import { mergeRefreshedManifestEntries, verifyStorefrontBundles } from "./verify.server";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";

const proveStorefrontBundle = vi.hoisted(() => vi.fn(async (_input: unknown) => ({
  ok: true,
  diagnostics: [],
  screenshots: [],
  browserMs: 0,
  metrics: {
    domNodes: {}, routeHtmlCssBytes: {}, interactionBytes: {}, fullBundleBytes: 0,
  },
  screenshotManifest: [],
})));

vi.mock("./browser.server", async (importOriginal) => ({
  ...await importOriginal<typeof BrowserServerModule>(),
  proveStorefrontBundle,
}));

describe("storefront full-story fixture", () => {
  it("publishes the command-produced artifact restored by Undo", async () => {
    const story = await createStorefrontFullStory();

    expect(story.assetGeneration).toEqual({ claimed: 10, ready: 10, failed: 0, skipped: 0 });
    expect(story.initialMissingProductIds).toHaveLength(10);
    expect(story.assetGenerationState.claimed.map(({ productId }) => productId).sort())
      .toEqual([...story.initialMissingProductIds].sort());
    expect(story.assetGenerationState.generated.map(({ productId }) => productId).sort())
      .toEqual([...story.initialMissingProductIds].sort());
    expect(story.assetGenerationState.updated).toHaveLength(10);
    expect(story.assetGenerationState.updated.every(({ status, url }) => status === "ready" && url)).toBe(true);
    expect(story.assetGenerationState.readyAssetQueries.length).toBeGreaterThan(0);
    expect(story.assetGenerationState.readyAssetQueries.every(({ shopId, status, productIds }) =>
      shopId === SHOP_ID
      && status === "ready"
      && productIds.length <= 100)).toBe(true);
    expect([...new Set(story.assetGenerationState.readyAssetQueries.flatMap(({ productIds }) => productIds))].sort())
      .toEqual([...story.initialMissingProductIds].sort());
    const generatedImageUrls = story.assetGenerationState.generated.map(({ url }) => url).sort();
    expect(story.context.products
      .filter(({ id }) => story.initialMissingProductIds.includes(id))
      .flatMap(({ images }) => images.map(({ assetKey }) => assetKey))
      .sort()).toEqual([]);
    const readyCatalogUrls = await Promise.all(story.context.products
      .filter(({ id }) => story.initialMissingProductIds.includes(id))
      .map(async ({ handle }) => (await story.catalog.getProduct(SHOP_ID, handle))?.images[0]?.url));
    expect(readyCatalogUrls.sort()).toEqual(generatedImageUrls);
    expect([...story.expectations.generatedImageUrls].sort()).toEqual(generatedImageUrls);
    expect(story.unsupported.versionCountChanged).toBe(false);
    expect(story.startedOverVersionId).not.toBe(story.beforeStartOver.versionId);
    expect(story.published.versionId).not.toBe(story.beforeStartOver.versionId);
    expect(story.published.artifactHash).toBe(story.beforeStartOver.artifactHash);
    expect(story.published.bundle).toEqual(story.beforeStartOver.bundle);
    expect(story.published.bundle.routes.home.html).toContain(story.expectations.home.heroText);
    expect(story.published.bundle.featuredProductIds).toEqual(story.expectations.home.featuredProductIds);
    expect(story.published.bundle.visualLayer).toMatchObject({
      kind: "fragment_shader",
      source: story.merchantShaderSource,
    });
    expect(story.protectedAssetsAfterEdits).toEqual(story.protectedAssetsBeforeEdits);
  });

  it("proves the missing-image draft before the ready-asset published artifact", async () => {
    const story = await createStorefrontFullStory();
    proveStorefrontBundle.mockClear();

    await verifyStorefrontBundles({ updateBaselines: false, filter: "full-story" });

    expect(proveStorefrontBundle).toHaveBeenCalledTimes(2);
    expect(proveStorefrontBundle.mock.calls[0]?.[0]).toMatchObject({
      bundle: story.initial.bundle,
      context: story.context,
      catalogPagination: true,
      routes: ["collection", "search"],
      viewports: ["mobile", "desktop"],
    });
    const finalProof = proveStorefrontBundle.mock.calls[1]?.[0] as BrowserServerModule.ProveStorefrontBundleInput;
    expect(finalProof).toMatchObject({
      bundle: story.published.bundle,
      context: story.context,
      expectations: story.expectations,
      catalogPagination: true,
    });
    const firstMissing = story.context.products.find(({ id }) => story.initialMissingProductIds.includes(id))!;
    expect((await finalProof.catalog?.getProduct(SHOP_ID, firstMissing.handle))?.images[0]?.url)
      .toBe(story.assetGenerationState.generated.find(({ productId }) => productId === firstMissing.id)?.url);
  });

  it("constructs follow-up proof artifacts through CAS prompt commands", async () => {
    proveStorefrontBundle.mockClear();
    const runStoreCommand = vi.spyOn(commandServer, "runStoreCommand");

    await verifyStorefrontBundles({ updateBaselines: false, filter: "follow-up-custom-bench" });

    const commands = runStoreCommand.mock.calls.map(([call]) => (call as RunStoreCommandInput).command);
    expect(commands).toHaveLength(3);
    expect(commands.map(({ kind }) => kind)).toEqual(["prompt", "prompt", "prompt"]);
    expect(commands.map(({ expectedDraftVersionId }) => expectedDraftVersionId)).toHaveLength(3);
    expect(new Set(commands.map(({ expectedDraftVersionId }) => expectedDraftVersionId)).size).toBe(3);
    expect(proveStorefrontBundle).toHaveBeenCalledOnce();
    expect(proveStorefrontBundle.mock.calls[0]?.[0]).toMatchObject({
      bundle: {
        source: { kind: "recipe", templateId: "custom-bench" },
        visualLayer: { kind: "fragment_shader" },
      },
    });
    runStoreCommand.mockRestore();
  });
});

describe("storefront verification manifest refresh", () => {
  it("keeps committed order and appends a newly filtered proof entry", () => {
    expect(mergeRefreshedManifestEntries(
      [{ id: "base", value: 1 }, { id: "existing", value: 2 }],
      [{ id: "existing", value: 3 }, { id: "new-proof", value: 4 }],
    )).toEqual([
      { id: "base", value: 1 },
      { id: "existing", value: 3 },
      { id: "new-proof", value: 4 },
    ]);
  });
});
