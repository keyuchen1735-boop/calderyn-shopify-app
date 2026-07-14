import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "./screenshot-manifest.json";

const RECIPE_IDS = [
  "custom-bench", "commons-index", "soft-chemistry", "companion-field-guide", "daily-protocol",
  "room-modes", "rep-rest", "diagnostic-deck", "ritual-almanac", "broadcast-patch-bay", "atelier-nine",
];

describe("committed storefront screenshot manifest", () => {
  it("contains all recipes plus representative custom and edit proofs at every viewport", () => {
    expect(manifest.viewports).toEqual(["390x844", "768x1024", "1440x1000"]);
    expect(manifest.recipes.map((entry) => entry.id)).toEqual([...RECIPE_IDS, "representative-custom", "representative-edit"]);
    for (const entry of manifest.recipes) {
      expect(entry.screenshots).toHaveLength(18);
      expect(new Set(entry.screenshots.map((shot) => shot.viewport))).toEqual(new Set(["mobile", "tablet", "desktop"]));
    }
  });

  it("uses rendered storefront screenshots rather than copied hero crops", () => {
    for (const id of RECIPE_IDS) {
      const preview = resolve(process.cwd(), `public/template-previews/${id}.webp`);
      const hero = resolve(process.cwd(), `public/storefront-recipes/${id}/hero.webp`);
      const desktop = resolve(process.cwd(), `public/storefront-recipes/${id}/baselines/v1-desktop.webp`);
      const mobile = resolve(process.cwd(), `public/storefront-recipes/${id}/baselines/v1-mobile.webp`);
      const tablet = resolve(process.cwd(), `public/storefront-recipes/${id}/baselines/v1-tablet.webp`);
      for (const path of [preview, desktop, mobile, tablet]) expect(statSync(path).size).toBeGreaterThan(10_000);
      const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
      expect(digest(preview)).not.toBe(digest(hero));
      expect(digest(desktop)).not.toBe(digest(hero));
    }
  });
});
