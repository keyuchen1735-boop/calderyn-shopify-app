// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { hydrateStorefront } from "~/lib/storefront-runtime/hydrate";
import { createRuntimeAdapters } from "~/lib/storefront-runtime/storefront-hydrator";

const repeats = (nodes: readonly CompiledNode[]): string[] => nodes.flatMap((node) =>
  node.kind === "text" ? [] : [...(node.repeat ? [node.repeat.source] : []), ...repeats(node.children)]
);
const actions = (route: RouteArtifact) => route.interactions.transitions.map((transition) => transition.action.type);
const dataPaths = (route: RouteArtifact) => route.bindings.flatMap(({ ref }) => ref.kind === "data" ? [ref.path] : []);

describe("Forge storefront recipe", () => {
  it("compiles a nine-route jobsite blueprint from live merchant facts", async () => {
    const module = await import("./bundle").catch(() => null);
    expect(module, "Forge recipe source must exist").not.toBeNull();
    if (!module) return;

    const { FORGE_RECIPE, FORGE_RECIPE_CONFIG } = module;
    const { bundle, config } = FORGE_RECIPE;

    expect(config).toMatchObject({
      templateId: FORGE_RECIPE_CONFIG.templateId,
      templateVersion: FORGE_RECIPE_CONFIG.templateVersion,
      concept: FORGE_RECIPE_CONFIG.concept,
    });
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "forge", templateVersion: 1 });
    expect(config.archetype).toMatchObject({
      composition: "jobsite-blueprint",
      hero: "exploded-tool-hero",
      scroll: "blueprint-flow",
      cards: "tool-diagrams",
    });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(new Set(Object.values(config.surfaces).map((surface) => surface.signature)).size).toBe(10);

    expect(bundle.designSystem).toMatchObject({ displayFontId: "oswald", bodyFontId: "dm-mono" });
    expect(bundle.designSystem.tokens).toMatchObject({ steel: "#24313a", orange: "#c94f18", parchment: "#efe4ce" });
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    for (const route of ["home", "collections", "collection", "story", "search", "cart"] as const) {
      expect(config.surfaces.shell.source.html).toContain(`data-cd-route="${route}"`);
    }

    expect(repeats(bundle.routes.home.tree)).toContain("featured.products");
    expect(dataPaths(bundle.routes.home)).toEqual(expect.arrayContaining([
      "product.primaryImage", "product.title", "product.description", "product.price", "product.availability",
    ]));
    expect(bundle.routes.home.html).toContain("Build a three-line project kit");
    expect(bundle.routes.home.trustedSlots).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "bundleBuilder", slotCount: 3 }),
      expect.objectContaining({ kind: "quickViewCommerce" }),
    ]));

    expect(repeats(bundle.routes.collection.tree)).toContain("collection.products");
    expect(actions(bundle.routes.collection)).toEqual(expect.arrayContaining(["collection.filter", "collection.sort"]));
    expect(bundle.routes.collection.interactions.transitions.filter((item) => item.action.type === "collection.filter"))
      .toSatisfy((items: RouteArtifact["interactions"]["transitions"]) => items.length >= 5);
    expect(bundle.routes.collection.html).toContain("Project filters / live catalog tags");
    expect(bundle.routes.collection.html).toContain("Only live products carrying the selected catalog tag appear");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.primaryImage", "product.title", "product.description",
      "product.price", "product.availability",
    ]));
    expect(bundle.routes.collection.trustedSlots.map((slot) => slot.kind)).toContain("quickViewCommerce");

    expect(repeats(bundle.routes.product.tree)).toEqual(expect.arrayContaining(["product.images", "product.facts", "product.variants"]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.primaryImage", "product.title", "product.description", "product.price", "product.availability",
      "fact.label", "fact.value", "fact.url", "variant.title", "variant.price", "variant.availability",
    ]));
    expect(bundle.routes.product.html).toContain("Merchant compatibility record");
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );

    const routeMarkup = Object.values(bundle.routes)
      .map((route) => "html" in route ? route.html : route.decorativeHtml)
      .join(" ");
    expect(routeMarkup.toLowerCase()).not.toContain("download");
    expect(routeMarkup).not.toMatch(/href=["'][^"']+\.pdf/i);
    expect(routeMarkup).not.toMatch(/\b(?:ansi|osha|ip\d\d|\d+\s*(?:nm|rpm|psi))\b/i);

    expect(repeats(bundle.routes.search.tree)).toContain("search.results");
    expect(actions(bundle.routes.search)).toEqual(expect.arrayContaining(["search.update", "search.submit", "search.clear"]));
    expect(repeats(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );
  });

  it("clicks accepted sort and project-filter controls into public collection URLs", async () => {
    const module = await import("./bundle");
    const route = module.FORGE_RECIPE.bundle.routes.collection;
    const assign = vi.fn();
    window.history.replaceState({}, "", "/storefront/collections/tools?cursor=stale");
    document.body.innerHTML = `<div id="forge-runtime">${route.html}</div>`;
    const root = document.getElementById("forge-runtime") as HTMLElement;
    const intentArtifact: RouteArtifact = {
      ...route,
      bindings: [],
      trustedSlots: [],
      interactions: { ...route.interactions, state: [], bindings: [] },
    };
    const runtime = hydrateStorefront({
      root,
      artifact: intentArtifact,
      adapters: createRuntimeAdapters({ mode: "public", locationAssign: assign }),
    });
    expect(runtime.hydrated).toBe(true);

    const sortControls = route.interactions.transitions
      .filter((transition) => transition.action.type === "collection.sort")
      .map((transition) => document.getElementById(transition.sourceId) as HTMLButtonElement | null);
    expect(sortControls).toHaveLength(3);
    sortControls.forEach((control) => control?.click());

    const framingControl = [...root.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent === "Framing");
    expect(framingControl).toBeTruthy();
    framingControl?.click();
    const compatibilityControl = root.querySelector<HTMLInputElement>('input[name="compatibility"]');
    expect(compatibilityControl).toBeTruthy();
    if (compatibilityControl) {
      compatibilityControl.value = "Model X";
      compatibilityControl.dispatchEvent(new Event("change", { bubbles: true }));
    }

    expect(assign.mock.calls.map(([href]) => href)).toEqual([
      "/storefront/collections/tools?sort=relevance",
      "/storefront/collections/tools?sort=price_asc",
      "/storefront/collections/tools?sort=price_desc",
      "/storefront/collections/tools?filter.tag=framing",
      "/storefront/collections/tools?filter.fact-compatibility=Model+X",
    ]);
    for (const [href] of assign.mock.calls) {
      const url = new URL(href, window.location.origin);
      expect([...url.searchParams.keys()].every((key) => key === "sort" || key === "filter.tag" || key === "filter.fact-compatibility")).toBe(true);
    }
    runtime.teardown();
  });

  it("fails media closed while preserving exactly three trusted video roles", async () => {
    const module = await import("./bundle").catch(() => null);
    const assetsModule = await import("./assets").catch(() => null);
    expect(module).not.toBeNull();
    expect(assetsModule).not.toBeNull();
    if (!module || !assetsModule) return;

    const { FORGE_RECIPE } = module;
    const { FORGE_ASSETS, FORGE_VIDEO_ROLES } = assetsModule;
    expect(FORGE_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(FORGE_ASSETS).toEqual({ entries: [] });
    expect(FORGE_RECIPE.report.ok).toBe(false);
    expect(FORGE_RECIPE.report.diagnostics).toHaveLength(18);
    expect([...new Set(FORGE_RECIPE.report.diagnostics.map((diagnostic) => diagnostic.code))])
      .toEqual(["asset.media_mismatch", "asset.reference_missing"]);
    expect(FORGE_RECIPE.report.diagnostics.filter((diagnostic) => diagnostic.code === "asset.media_mismatch"))
      .toHaveLength(9);
    expect(FORGE_RECIPE.report.diagnostics.filter((diagnostic) => diagnostic.code === "asset.reference_missing"))
      .toHaveLength(9);

    const videoMarkup = Object.values(FORGE_RECIPE.config.surfaces)
      .map((surface) => surface.source.html)
      .join(" ");
    for (const role of FORGE_VIDEO_ROLES) {
      expect(videoMarkup).toContain(`data-cd-poster-asset="${role}-poster"`);
      expect(videoMarkup).toContain(`data-cd-asset="${role}-webm"`);
      expect(videoMarkup).toContain(`data-cd-asset="${role}-mp4"`);
    }
    expect(videoMarkup.match(/data-cd-video/g)).toHaveLength(3);
    expect(FORGE_RECIPE.bundle.designSystem.globalCss).toContain("prefers-reduced-motion");
  });

  it("ships a self-contained static blueprint prototype and exactly three briefs", () => {
    const prototypePath = resolve(process.cwd(), "docs/superpowers/prototypes/storefront-recipes/forge.html");
    const briefPath = resolve(process.cwd(), "app/lib/storefront-recipes/forge/video-brief.md");
    const prototype = readFileSync(prototypePath, "utf8");
    const brief = readFileSync(briefPath, "utf8");

    expect(prototype).toContain("<!doctype html>");
    expect(prototype).toContain("Merchant compatibility record");
    expect(prototype).toContain("Project filters / live catalog tags");
    expect(prototype).toContain("Only live products carrying the selected catalog tag appear");
    expect(prototype).not.toMatch(/https?:\/\//);
    expect(brief.match(/^## Video brief:/gm)).toHaveLength(3);
    const durations = [...brief.matchAll(/^- Duration: (\d+) seconds/gm)].map((match) => Number(match[1]));
    expect(durations).toHaveLength(3);
    expect(durations.every((duration) => duration >= 8 && duration <= 12)).toBe(true);
  });
});
