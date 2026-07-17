import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import { getStoreTemplate } from "../storefront-bundle/registry";
import { applyStoreIntent } from "../storefront-command/apply";
import { createBrowserProofReport, mergeBrowserProofReports } from "./report";
import { proveStorefrontBundle } from "./browser.server";
import { storefrontProofContext } from "./fixtures";

export interface VerifyStorefrontBundlesOptions {
  updateBaselines: boolean;
  filter?: string;
  onProgress?: (message: string) => void;
}

function fullStoryBundle(invalidShader = false) {
  const recipe = STOREFRONT_RECIPES[0];
  const template = getStoreTemplate(recipe.config.templateId);
  let bundle = applyStoreIntent(structuredClone(recipe.bundle), template, {
    kind: "update_text",
    slot: "heroTitle",
    value: "Made for long summer days",
  }).bundle;
  bundle = applyStoreIntent(bundle, template, {
    kind: "update_merchandising",
    productIds: storefrontProofContext().products.slice(0, 12).map(({ id }) => id),
  }).bundle;
  bundle = applyStoreIntent(bundle, template, {
    kind: "update_visual_layer",
    visualLayer: {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(mix(u_color1,u_color2,0.5),1.0);}",
      colors: ["#102030", "#496070", "#d8c6a0"],
    },
  }).bundle;
  if (invalidShader && bundle.visualLayer?.kind === "fragment_shader") {
    bundle.visualLayer.source = "x".repeat(4_001);
  }
  return bundle;
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
    { id: "full-story", bundle: fullStoryBundle(), baseline: false, assetTemplateId: undefined, context: storefrontProofContext(), catalogPagination: true },
    { id: "full-story-invalid-shader", bundle: fullStoryBundle(true), baseline: false, assetTemplateId: undefined, context: storefrontProofContext(), routes: ["home"] as const },
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
        ...("catalogPagination" in entry ? { catalogPagination: entry.catalogPagination } : {}),
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
  let manifest = {
    schemaVersion: 1,
    validationProfileVersion: 1,
    viewports: ["390x844", "768x1024", "1440x1000"],
    recipes: manifestRecipes,
  };
  if (options.updateBaselines) {
    const manifestPath = resolve(root, "app/lib/storefront-validation/screenshot-manifest.json");
    await mkdir(resolve(manifestPath, ".."), { recursive: true });
    if (options.filter) {
      const committed = JSON.parse(await readFile(manifestPath, "utf8")) as typeof manifest;
      const refreshed = new Map(manifest.recipes.map((entry) => [entry.id, entry]));
      manifest = {
        ...committed,
        recipes: committed.recipes.map((entry) => refreshed.get(entry.id) ?? entry),
      };
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { report: createBrowserProofReport(report), manifest };
}
