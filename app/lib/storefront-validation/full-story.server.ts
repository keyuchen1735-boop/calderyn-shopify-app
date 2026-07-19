import { generateMissingProductImages } from "../assets/generate-missing.server";
import {
  withAssetOverrides,
  type StoreAssetOverrideQuery,
} from "../storegen/imagery/asset.server";
import { createStorefrontProofCatalog, createStorefrontProofDataForBundle } from "./browser.server";
import { createStoreCommandHarness } from "./command-harness.server";
import { storefrontProofContext } from "./fixtures";
import { getStoreTemplate } from "../storefront-bundle/registry";
import { readStoreTextSlot } from "../storefront-command/apply";

const SHOP_ID = "11111111-1111-4111-8111-111111111111";
const FINAL_HERO_TEXT = "Made for long summer days";
const MERCHANT_SHADER_SOURCE = "void main(){gl_FragColor=vec4(u_color2,1.0);}";

export async function createStorefrontFullStory() {
  const context = storefrontProofContext();
  const featuredProductIds = context.products.slice(0, 12).map(({ id }) => id).reverse();

  const missingProducts = context.products.filter(({ images }) => images.length === 0);
  const initialMissingProductIds = missingProducts.map(({ id }) => id);

  const harness = createStoreCommandHarness({
    shopId: SHOP_ID,
    context,
    classify: async (input) => {
      if (input.prompt === "Update the title") {
        return { kind: "update_text", slot: "heroTitle", value: FINAL_HERO_TEXT };
      }
      if (input.prompt === "Feature the collection") {
        return { kind: "update_merchandising", productIds: featuredProductIds };
      }
      if (input.prompt === "Generate an effect") {
        return {
          kind: "update_visual_layer",
          visualLayer: {
            kind: "fragment_shader",
            source: "void main(){gl_FragColor=vec4(u_color1,1.0);}",
            colors: ["#112233", "#445566", "#778899"],
          },
        };
      }
      if (input.prompt === "Use the merchant shader") {
        const attachment = input.attachments?.find(({ kind }) => kind === "fragment_shader");
        if (!attachment || attachment.kind !== "fragment_shader") throw new Error("shader attachment missing");
        return {
          kind: "update_visual_layer",
          visualLayer: {
            kind: "fragment_shader",
            source: attachment.source,
            colors: ["#0a0a0a", "#1b1b1b", "#2c2c2c"],
          },
        };
      }
      if (input.prompt === "Unsupported structure") {
        return { kind: "unsupported", message: "Structure is protected." };
      }
      if (input.prompt === "Start over") return { kind: "start_over", prompt: input.prompt };
      return {
        kind: "select_design",
        prompt: input.prompt,
        excludedTemplateIds: [...new Set([
          ...(input.excludedTemplateIds ?? []),
          ...(input.currentTemplateId ? [input.currentTemplateId] : []),
        ])],
      };
    },
  });
  const currentDraft = () => {
    const draft = harness.state().draft;
    if (!draft) throw new Error("full-story proof has no draft");
    return draft;
  };

  await harness.prompt("Build the store");
  const initial = currentDraft();
  const claims = missingProducts.map((product) => ({
    shop_id: SHOP_ID,
    product_id: product.id,
    title: product.title,
    description: `Complete merchant description for ${product.title}`,
    attempt_count: 1,
    lease_expires_at: "2026-07-16T00:05:00.000Z",
  }));
  const storeAssets = claims.map((claim) => ({
    shop_id: claim.shop_id,
    product_id: claim.product_id,
    source: "gemini",
    url: null as string | null,
    status: "pending" as "pending" | "ready" | "failed",
    created_at: "2026-07-16T00:00:00.000Z",
    lease_expires_at: claim.lease_expires_at as string | null,
  }));
  const assetGenerationState = {
    claimed: [] as Array<{ productId: string }>,
    generated: [] as Array<{ productId: string; url: string }>,
    updated: [] as Array<{ productId: string; status: "ready" | "failed"; url: string | null }>,
    storeAssets,
    readyAssetQueries: [] as StoreAssetOverrideQuery[],
  };
  const assetGeneration = await generateMissingProductImages(missingProducts.length, {
    rpc: async (limit) => {
      const selected = claims.slice(0, limit);
      assetGenerationState.claimed.push(...selected.map(({ product_id }) => ({ productId: product_id })));
      return { data: selected, error: null };
    },
    generate: async ({ product_id }) => {
      const url = `https://assets.example.test/shop-assets/${SHOP_ID}/${product_id}.webp`;
      assetGenerationState.generated.push({ productId: product_id, url });
      return { url };
    },
    update: async ({ product_id }, patch) => {
      const row = storeAssets.find((candidate) => candidate.shop_id === SHOP_ID
        && candidate.product_id === product_id
        && candidate.source === "gemini"
        && candidate.status === "pending");
      if (!row) return { data: [], error: null };
      row.status = patch.status;
      row.url = patch.url;
      row.lease_expires_at = patch.lease_expires_at;
      assetGenerationState.updated.push({ productId: product_id, status: patch.status, url: patch.url });
      return { data: [{ shop_id: SHOP_ID }], error: null };
    },
  });
  const catalog = withAssetOverrides(createStorefrontProofCatalog(context), {
    queryReadyAssets: async (query) => {
      assetGenerationState.readyAssetQueries.push(structuredClone(query));
      const productIds = new Set(query.productIds);
      const data = storeAssets
        .filter((row) => row.shop_id === query.shopId
          && row.status === query.status
          && productIds.has(row.product_id))
        .sort((left, right) => left.product_id.localeCompare(right.product_id)
          || right.created_at.localeCompare(left.created_at)
          || left.source.localeCompare(right.source))
        .slice(query.from, query.to + 1);
      return { data: structuredClone(data), error: null };
    },
  });
  const readyProducts = await catalog.listProducts(SHOP_ID);
  const readyById = new Map(readyProducts.map((product) => [product.id, product]));
  const generatedImageUrls = initialMissingProductIds.map((productId) => {
    const url = readyById.get(productId)?.images[0]?.url;
    if (!url) throw new Error(`ready store asset did not reach the proof catalog for ${productId}`);
    return url;
  });
  const protectedAssetsBeforeEdits = structuredClone(currentDraft().bundle.assets);
  await harness.prompt("Update the title");
  await harness.prompt("Feature the collection");
  await harness.prompt("Generate an effect");
  await harness.prompt("Use the merchant shader", [{ kind: "fragment_shader", source: MERCHANT_SHADER_SOURCE }]);
  const protectedAssetsAfterEdits = structuredClone(currentDraft().bundle.assets);
  await harness.prompt("Switch design");

  const unsupportedVersionId = currentDraft().versionId;
  const versionCountBeforeUnsupported = harness.versionCount();
  const unsupportedReceipt = await harness.run({
    kind: "prompt",
    prompt: "Unsupported structure",
    expectedDraftVersionId: unsupportedVersionId,
  });
  if (unsupportedReceipt.status !== "unchanged") throw new Error("unsupported proof command changed the draft");
  const unsupported = {
    versionId: unsupportedVersionId,
    versionCountChanged: harness.versionCount() !== versionCountBeforeUnsupported,
  };

  await harness.prompt("Try another");
  const beforeStartOver = currentDraft();
  const startedOver = await harness.prompt("Start over");
  const restored = await harness.run({
    kind: "undo",
    targetVersionId: beforeStartOver.versionId,
    expectedDraftVersionId: startedOver.versionId,
  });
  if (restored.status !== "installed") throw new Error("full-story proof did not restore an immutable draft");
  await harness.run({ kind: "publish", expectedDraftVersionId: restored.versionId });

  const finalState = harness.state();
  if (!finalState.draft || finalState.publishedVersionId !== finalState.draft.versionId) {
    throw new Error("full-story proof did not publish its restored draft");
  }
  const publishedBundle = finalState.draft.bundle;
  if (publishedBundle.source.kind !== "recipe") throw new Error("full-story proof did not publish a recipe");
  const publishedHeroText = readStoreTextSlot(
    publishedBundle,
    getStoreTemplate(publishedBundle.source.templateId),
    "heroTitle",
  );
  if (!publishedHeroText) throw new Error("full-story proof has no published hero title");
  const publishedFeaturedProductIds = createStorefrontProofDataForBundle(
    "home",
    publishedBundle,
    context,
  ).featuredProducts.map(({ id }) => id);
  return {
    context,
    catalog,
    initial,
    assetGeneration,
    assetGenerationState,
    initialMissingProductIds,
    merchantShaderSource: MERCHANT_SHADER_SOURCE,
    protectedAssetsBeforeEdits,
    protectedAssetsAfterEdits,
    unsupported,
    beforeStartOver,
    startedOverVersionId: startedOver.versionId,
    published: structuredClone(finalState.draft),
    expectations: {
      generatedImageUrls,
      home: {
        heroText: publishedHeroText,
        featuredProductIds: publishedFeaturedProductIds,
        visualLayer: "fallback" as const,
      },
    },
  };
}
