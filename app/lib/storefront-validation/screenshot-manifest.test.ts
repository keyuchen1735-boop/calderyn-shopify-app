import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getStoreTemplate } from "../storefront-bundle/registry";
import manifest from "./screenshot-manifest.json";

const RECIPE_IDS = [
  "custom-bench", "commons-index", "soft-chemistry", "companion-field-guide", "daily-protocol",
  "room-modes", "rep-rest", "diagnostic-deck", "ritual-almanac", "broadcast-patch-bay", "atelier-nine",
];
const BAYMARD_RECIPE_IDS = ["volt", "atelier", "gilt", "ember", "roast", "fizz", "forge", "haven", "glow"];
const ROUTE_IDS = ["home", "collection", "product", "search", "cart", "checkout"] as const;
const EMPTY_ROUTE_IDS = ["home", "collection", "search", "cart", "checkout"] as const;
const VIEWPORTS = ["mobile", "tablet", "desktop"] as const;

type ScreenshotKeyInput = { routeId: string; viewport: string; catalogOffset?: number };

function screenshotKey(shot: ScreenshotKeyInput) {
  return `${shot.routeId}:${shot.viewport}:${shot.catalogOffset ?? "-"}`;
}

function expectedScreenshots(
  routes: readonly string[],
  catalogOffsets: readonly number[] = [0],
  viewports: readonly string[] = VIEWPORTS,
) {
  return routes.flatMap((routeId) =>
    (routeId === "collection" || routeId === "search" ? catalogOffsets : [undefined])
      .flatMap((catalogOffset) => viewports.map((viewport) =>
        ({ routeId, viewport, ...(catalogOffset === undefined ? {} : { catalogOffset }) }),
      )),
  );
}

describe("committed storefront screenshot manifest", () => {
  it("contains every baseline, follow-up edit, long-copy edit, shader fallback, full story, and empty-catalog proof", () => {
    expect(manifest.viewports).toEqual(["390x844", "768x1024", "1440x1000"]);
    expect(manifest.recipes.map((entry) => entry.id)).toEqual([
      ...RECIPE_IDS,
      ...RECIPE_IDS.map((id) => `follow-up-${id}`),
      ...RECIPE_IDS.map((id) => `long-copy-${id}`),
      ...RECIPE_IDS.map((id) => `invalid-shader-${id}`),
      ...RECIPE_IDS.map((id) => `empty-${id}`),
      "full-story-missing-images",
      "full-story",
      "full-story-invalid-shader",
      ...BAYMARD_RECIPE_IDS,
    ]);
    expect(manifest.recipes.every((entry) => entry.sourceKind === "recipe")).toBe(true);
    for (const entry of manifest.recipes) {
      const expectedKeys = entry.id === "full-story-missing-images"
        ? expectedScreenshots(["collection", "search"], [0, 24, 48], ["mobile", "desktop"]).map(screenshotKey)
        : entry.id === "full-story"
        ? expectedScreenshots(ROUTE_IDS, [0, 24, 48]).map(screenshotKey)
        : entry.id.startsWith("empty-")
          ? expectedScreenshots(EMPTY_ROUTE_IDS).map(screenshotKey)
          : RECIPE_IDS.includes(entry.id) || BAYMARD_RECIPE_IDS.includes(entry.id)
            ? expectedScreenshots(ROUTE_IDS, [0, 24]).map(screenshotKey)
            : expectedScreenshots(["home"]).map(screenshotKey);
      const actualKeys = entry.screenshots.map(screenshotKey);
      expect(actualKeys).toHaveLength(expectedKeys.length);
      expect(new Set(actualKeys).size).toBe(actualKeys.length);
      expect(new Set(actualKeys)).toEqual(new Set(expectedKeys));
    }
  });

  it("uses rendered storefront screenshots rather than copied hero crops", () => {
    for (const id of RECIPE_IDS) {
      const activeVersion = getStoreTemplate(id as Parameters<typeof getStoreTemplate>[0]).activeVersion;
      const preview = resolve(process.cwd(), `public/template-previews/${id}.webp`);
      const hero = resolve(process.cwd(), `public/storefront-recipes/${id}/hero.webp`);
      const entry = manifest.recipes.find((candidate) => candidate.id === id)!;
      for (const expectedShot of expectedScreenshots(ROUTE_IDS, [0, 24])) {
        const pageSuffix = expectedShot.catalogOffset && expectedShot.catalogOffset > 0
          ? `-${expectedShot.catalogOffset}` : "";
        const expectedBaseline = `public/storefront-recipes/${id}/baselines/v${activeVersion}${expectedShot.routeId === "home" ? "" : `-${expectedShot.routeId}`}${pageSuffix}-${expectedShot.viewport}.webp`;
        const baseline = resolve(process.cwd(), expectedBaseline);
        expect(existsSync(baseline), `${expectedBaseline} is missing`).toBe(true);
        const shot = entry.screenshots.find((candidate) => screenshotKey(candidate) === screenshotKey(expectedShot));
        expect(shot, `manifest is missing ${screenshotKey(expectedShot)}`).toBeDefined();
        if (!shot) continue;
        expect("baseline" in shot ? shot.baseline : undefined).toBe(expectedBaseline);
        expect(statSync(baseline).isFile()).toBe(true);
        expect(statSync(baseline).size).toBeGreaterThan(shot.routeId === "home" ? 10_000 : 1_000);
        expect(shot.sha256).toBe(createHash("sha256").update(readFileSync(baseline)).digest("hex"));
      }
      expect(statSync(preview).size).toBeGreaterThan(10_000);
      const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(digest(preview)).not.toBe(digest(hero));
      expect(digest(resolve(process.cwd(), `public/storefront-recipes/${id}/baselines/v${activeVersion}-desktop.webp`)))
        .not.toBe(digest(hero));
    }
  });
});
