import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { STOREFRONT_RECIPES } from "../storefront-recipes";
import type { StoreIntent } from "../storefront-command/types";
import { createBrowserProofReport, mergeBrowserProofReports } from "./report";
import {
  createStorefrontProofCatalog,
  proveStorefrontBundle,
  type ProveStorefrontBundleInput,
} from "./browser.server";
import { createStoreCommandHarness } from "./command-harness.server";
import { storefrontProofContext } from "./fixtures";
import { createStorefrontFullStory } from "./full-story.server";

export interface VerifyStorefrontBundlesOptions {
  updateBaselines: boolean;
  filter?: string;
  onProgress?: (message: string) => void;
}

type VerificationEntry = Pick<
  ProveStorefrontBundleInput,
  "bundle" | "catalog" | "context" | "routes" | "catalogPagination" | "viewports" | "expectations"
> & {
  id: string;
  baseline: boolean;
  assetTemplateId: string | undefined;
};

type VerificationCandidate = Omit<VerificationEntry, "bundle"> & {
  bundle: VerificationEntry["bundle"] | (() => Promise<VerificationEntry["bundle"]>);
};

const LONG_COPY_HERO_TEXT = "W".repeat(500);
export const INVALID_SHADER_PROOF_SOURCE = "void main() {";

function followUpHeroText(recipe: (typeof STOREFRONT_RECIPES)[number]): string {
  return `Fidelity proof ${recipe.config.templateId}`;
}

function reorderedFeaturedProductIds(): string[] {
  return storefrontProofContext().products.slice(0, 12).map(({ id }) => id).reverse();
}

function homeExpectations(
  heroText: string,
  visualLayer: "canvas" | "fallback",
): NonNullable<ProveStorefrontBundleInput["expectations"]> {
  return { home: { heroText, featuredProductIds: reorderedFeaturedProductIds(), visualLayer } };
}

async function followUpBundle(
  recipe: (typeof STOREFRONT_RECIPES)[number],
  heroText: string,
  shaderSource: string,
) {
  const intents = new Map<string, StoreIntent>([
    ["Update the title", { kind: "update_text", slot: "heroTitle", value: heroText }],
    ["Feature the catalog", { kind: "update_merchandising", productIds: reorderedFeaturedProductIds() }],
    ["Add the visual effect", {
      kind: "update_visual_layer",
      visualLayer: {
        kind: "fragment_shader",
        source: shaderSource,
        colors: ["#102030", "#496070", "#d8c6a0"],
      },
    }],
  ]);
  const harness = createStoreCommandHarness({
    shopId: "11111111-1111-4111-8111-111111111111",
    context: storefrontProofContext(),
    initialBundle: recipe.bundle,
    classify: async ({ prompt }) => intents.get(prompt)
      ?? { kind: "unsupported", message: "Unsupported proof command." },
  });
  await harness.prompt("Update the title");
  await harness.prompt("Feature the catalog");
  await harness.prompt("Add the visual effect");
  const draft = harness.state().draft;
  if (!draft) throw new Error("follow-up proof did not produce a draft");
  return draft.bundle;
}

export function mergeRefreshedManifestEntries<T extends { id: string }>(
  committed: readonly T[],
  refreshed: readonly T[],
): T[] {
  const refreshedById = new Map(refreshed.map((entry) => [entry.id, entry]));
  const committedIds = new Set(committed.map((entry) => entry.id));
  return [
    ...committed.map((entry) => refreshedById.get(entry.id) ?? entry),
    ...refreshed.filter((entry) => !committedIds.has(entry.id)),
  ];
}

export async function verifyStorefrontBundles(options: VerifyStorefrontBundlesOptions) {
  const root = process.cwd();
  const reports = [];
  const manifestRecipes: Array<{
    id: string;
    sourceKind: "recipe" | "custom";
    screenshots: Awaited<ReturnType<typeof proveStorefrontBundle>>["screenshotManifest"];
  }> = [];
  const fullStory = !options.filter || options.filter === "full-story" || options.filter === "full-story-published"
    ? await createStorefrontFullStory()
    : null;
  const shaderSource = "void main(){gl_FragColor=vec4(mix(u_color1,u_color2,0.5),1.0);}";
  const candidates: VerificationCandidate[] = [
    ...STOREFRONT_RECIPES.map((recipe) => ({
      id: recipe.config.templateId,
      bundle: recipe.bundle,
      baseline: true,
      assetTemplateId: undefined,
      context: storefrontProofContext(27),
      catalogPagination: true,
    })),
    ...STOREFRONT_RECIPES.map((recipe) => ({
      id: `follow-up-${recipe.config.templateId}`,
      bundle: () => followUpBundle(recipe, followUpHeroText(recipe), shaderSource),
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(),
      routes: ["home"] as const,
      expectations: homeExpectations(followUpHeroText(recipe), "canvas"),
    })),
    ...STOREFRONT_RECIPES.map((recipe) => ({
      id: `long-copy-${recipe.config.templateId}`,
      bundle: () => followUpBundle(recipe, LONG_COPY_HERO_TEXT, shaderSource),
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(),
      routes: ["home"] as const,
      expectations: homeExpectations(LONG_COPY_HERO_TEXT, "canvas"),
    })),
    ...STOREFRONT_RECIPES.map((recipe) => ({
      id: `invalid-shader-${recipe.config.templateId}`,
      bundle: () => followUpBundle(recipe, followUpHeroText(recipe), INVALID_SHADER_PROOF_SOURCE),
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(),
      routes: ["home"] as const,
      expectations: homeExpectations(followUpHeroText(recipe), "fallback"),
    })),
    ...STOREFRONT_RECIPES.map((recipe) => ({
      id: `empty-${recipe.config.templateId}`,
      bundle: recipe.bundle,
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(0),
      routes: ["home", "collection", "search", "cart", "checkout"] as const,
    })),
    ...(fullStory ? [
      {
        id: "full-story-missing-images",
        bundle: fullStory.initial.bundle,
        baseline: false,
        assetTemplateId: undefined,
        context: fullStory.context,
        catalog: createStorefrontProofCatalog(fullStory.context),
        catalogPagination: true,
        routes: ["collection", "search"] as const,
        viewports: ["mobile", "desktop"] as const,
      },
      {
        id: "full-story",
        bundle: fullStory.published.bundle,
        baseline: false,
        assetTemplateId: undefined,
        context: fullStory.context,
        catalog: fullStory.catalog,
        catalogPagination: true,
        expectations: fullStory.expectations,
      },
    ] : []),
    {
      id: "full-story-invalid-shader",
      bundle: () => followUpBundle(
        STOREFRONT_RECIPES[0],
        followUpHeroText(STOREFRONT_RECIPES[0]),
        INVALID_SHADER_PROOF_SOURCE,
      ),
      baseline: false,
      assetTemplateId: undefined,
      context: storefrontProofContext(),
      routes: ["home"] as const,
      expectations: homeExpectations(followUpHeroText(STOREFRONT_RECIPES[0]), "fallback"),
    },
  ];
  const bundles: VerificationEntry[] = await Promise.all(candidates
    .filter((entry) => !options.filter || entry.id === options.filter
      || (options.filter === "full-story-published" && entry.id === "full-story")
      || (options.filter === "full-story" && entry.id === "full-story-missing-images"))
    .map(async (entry) => ({
      ...entry,
      bundle: typeof entry.bundle === "function" ? await entry.bundle() : entry.bundle,
    })));
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
        ...(entry.id.startsWith("full-story") ? { timeoutMs: 600_000 } : {}),
        ...(entry.catalog ? { catalog: entry.catalog } : {}),
        context: entry.context,
        persistedAssets,
        ...(entry.routes ? { routes: entry.routes } : {}),
        ...(entry.viewports ? { viewports: entry.viewports } : {}),
        ...(entry.catalogPagination ? { catalogPagination: true } : {}),
        ...(entry.expectations ? { expectations: entry.expectations } : {}),
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
      manifest = {
        ...committed,
        recipes: mergeRefreshedManifestEntries(committed.recipes, manifest.recipes),
      };
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { report: createBrowserProofReport(report), manifest };
}
