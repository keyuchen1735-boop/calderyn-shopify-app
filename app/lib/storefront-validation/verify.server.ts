import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { compileBundle, type StorefrontBundleSourceV1 } from "../storefront-compiler/compile";
import { createBrowserProofReport, mergeBrowserProofReports } from "./report";
import { proveStorefrontBundle } from "./browser.server";
import { storefrontProofContext } from "./fixtures";

export interface VerifyStorefrontBundlesOptions {
  updateBaselines: boolean;
  filter?: string;
  onProgress?: (message: string) => void;
}

function editedFixtureSource(): StorefrontBundleSourceV1 {
  const recipe = STOREFRONT_RECIPES[0];
  const source: StorefrontBundleSourceV1 = {
    source: {
      kind: "custom",
      generationId: "proof-edit-fixture",
      promptHash: "sha256:proof-edit-fixture",
      derivedFromVersionId: "proof-base-version",
      derivedFromTemplateId: recipe.config.templateId,
      derivedFromTemplateVersion: recipe.config.templateVersion,
    },
    concept: {
      ...recipe.config.concept,
      name: `${recipe.config.concept.name} — Merchant Edit`,
      rationale: "A representative prompt edit changes a safe visual token while preserving the complete route and commerce contract.",
    },
    designSystem: {
      ...recipe.config.designSystem,
      tokens: { ...recipe.config.designSystem.tokens, signal: "#6f1bc4" },
    },
    shell: recipe.config.surfaces.shell.source,
    routes: {
      home: recipe.config.surfaces.home.source,
      collection: recipe.config.surfaces.collection.source,
      product: recipe.config.surfaces.product.source,
      search: recipe.config.surfaces.search.source,
      cart: recipe.config.surfaces.cart.source,
      checkout: recipe.config.surfaces.checkout.source,
    },
    assets: recipe.config.assets,
  };
  return source;
}

function customFixtureSource(): StorefrontBundleSourceV1 {
  const recipe = (templateId: string) => STOREFRONT_RECIPES.find((entry) => entry.config.templateId === templateId)!;
  const home = recipe("diagnostic-deck");
  const search = recipe("daily-protocol").config.surfaces.search.source;
  return {
    source: { kind: "custom", generationId: "proof-custom-fixture", promptHash: "sha256:proof-custom-fixture" },
    concept: {
      name: "Original Orbit Store",
      rationale: "A cross-template AI remix used to prove that independently authored surfaces remain coherent and contained when combined.",
      noveltySignature: ["mixed surface grammar", "edge index", "direct manipulation"],
    },
    designSystem: {
      ...home.config.designSystem,
      tokens: {
        ...recipe("custom-bench").config.designSystem.tokens,
        ...recipe("commons-index").config.designSystem.tokens,
        ...recipe("soft-chemistry").config.designSystem.tokens,
        ...recipe("daily-protocol").config.designSystem.tokens,
        ...recipe("room-modes").config.designSystem.tokens,
        ...recipe("rep-rest").config.designSystem.tokens,
        ...home.config.designSystem.tokens,
        signal: recipe("custom-bench").config.designSystem.tokens.signal,
      },
    },
    shell: recipe("custom-bench").config.surfaces.shell.source,
    routes: {
      home: home.config.surfaces.home.source,
      collection: recipe("commons-index").config.surfaces.collection.source,
      product: recipe("soft-chemistry").config.surfaces.product.source,
      search: {
        ...search,
        css: `${search.css} .protocol-query input, .protocol-query button { background:#173f8f; border-color:#101820; color:#fff }`,
      },
      cart: recipe("room-modes").config.surfaces.cart.source,
      checkout: recipe("rep-rest").config.surfaces.checkout.source,
    },
    assets: home.config.assets,
  };
}

export async function verifyStorefrontBundles(options: VerifyStorefrontBundlesOptions) {
  const root = process.cwd();
  const reports = [];
  const manifestRecipes: Array<{
    id: string;
    sourceKind: "recipe" | "custom";
    screenshots: Awaited<ReturnType<typeof proveStorefrontBundle>>["screenshotManifest"];
  }> = [];
  const bundles = [
    ...STOREFRONT_RECIPES.map((recipe) => ({ id: recipe.config.templateId, bundle: recipe.bundle, baseline: true, assetTemplateId: undefined, context: storefrontProofContext(27) })),
    { id: "representative-custom", bundle: compileBundle(customFixtureSource()).bundle, baseline: false, assetTemplateId: "diagnostic-deck", context: storefrontProofContext() },
    { id: "representative-edit", bundle: compileBundle(editedFixtureSource()).bundle, baseline: false, assetTemplateId: STOREFRONT_RECIPES[0].config.templateId, context: storefrontProofContext(27) },
    {
      id: "representative-empty",
      bundle: STOREFRONT_RECIPES[0].bundle,
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(0),
      routes: ["home", "collection", "search", "cart", "checkout"] as const,
    },
  ].filter((entry) => !options.filter || entry.id === options.filter);
  for (const [bundleIndex, entry] of bundles.entries()) {
      options.onProgress?.(`[${bundleIndex + 1}/${bundles.length}] proving ${entry.id}`);
      const persistedAssets = entry.assetTemplateId
        ? await Promise.all(entry.bundle.assets.entries.map(async (asset) => ({
            ...asset,
            logicalKey: asset.key,
            bytes: new Uint8Array(await readFile(resolve(root, `public/storefront-recipes/${entry.assetTemplateId}/${asset.key}.webp`))),
          })))
        : undefined;
      const result = await proveStorefrontBundle({
        bundle: entry.bundle,
        context: entry.context,
        persistedAssets,
        ...("routes" in entry ? { routes: entry.routes } : {}),
        ...(entry.baseline ? {
          artifacts: {
            baselineDirectory: resolve(root, `public/storefront-recipes/${entry.id}/baselines`),
            previewFile: resolve(root, `public/template-previews/${entry.id}.webp`),
            updateBaselines: options.updateBaselines,
          },
        } : {}),
        onProgress: ({ routeId, viewport, completed, total }) => {
          options.onProgress?.(`  ${entry.id}: ${completed}/${total} ${routeId}@${viewport}`);
        },
      });
      reports.push({
        ...result,
        diagnostics: result.diagnostics.map((diagnostic) => ({ ...diagnostic, artifactId: entry.id })),
      });
      manifestRecipes.push({
        id: entry.id,
        sourceKind: entry.bundle.source.kind,
        screenshots: result.screenshotManifest.map((screenshot) => ({
          ...screenshot,
          ...(screenshot.baseline ? { baseline: relative(root, screenshot.baseline) } : {}),
        })),
      });
      options.onProgress?.(`  ${entry.id}: ${result.ok ? "PASS" : `FAIL (${result.diagnostics.length} diagnostics)`}`);
  }
  const report = mergeBrowserProofReports(reports);
  const manifest = {
    schemaVersion: 1,
    validationProfileVersion: 1,
    viewports: ["390x844", "768x1024", "1440x1000"],
    recipes: manifestRecipes,
  };
  if (options.updateBaselines && !options.filter) {
    const manifestPath = resolve(root, "app/lib/storefront-validation/screenshot-manifest.json");
    await mkdir(resolve(manifestPath, ".."), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { report: createBrowserProofReport(report), manifest };
}
