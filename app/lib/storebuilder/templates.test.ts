import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { recommendStoreTemplates, STORE_TEMPLATE_RECIPES, templateGenerationBrief } from "./templates";

describe("store template recipes", () => {
  it("keeps stable, unique ids and owned preview assets", () => {
    expect(new Set(STORE_TEMPLATE_RECIPES.map((recipe) => recipe.id)).size).toBe(STORE_TEMPLATE_RECIPES.length);
    for (const recipe of STORE_TEMPLATE_RECIPES) {
      expect(recipe.previewSrc).toMatch(/^\/template-previews\/[a-z-]+\.webp$/);
      expect(recipe.generationInstructions.length).toBeGreaterThan(100);
    }
  });

  it("recommends Atelier Grid for its matching visual vocabulary", () => {
    expect(recommendStoreTemplates("quiet luxury skincare studio")[0].id).toBe("atelier-nine");
  });

  it("combines merchant intent with recipe constraints", () => {
    const brief = templateGenerationBrief(STORE_TEMPLATE_RECIPES[0], "A monochrome fragrance shop");
    expect(brief).toContain("Merchant intent: A monochrome fragrance shop");
    expect(brief).toContain("Visual direction:");
  });

  it("forwards the complete template selection callback into the Store welcome flow", () => {
    const storeSource = readFileSync(
      new URL("../../components/dashboard/screens/Store.tsx", import.meta.url),
      "utf8",
    );
    expect(storeSource).toContain("onBuildWithVibe={onWelcomeBuildWithVibe}");
  });
});
