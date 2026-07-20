// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { CompiledNode, RouteArtifact } from "~/lib/storefront-bundle/types";
import { renderStorefrontRoute, type PublicPresentationData } from "~/lib/storefront-runtime/render.server";
import { VOLT_VIDEO_ASSET_KEYS, VOLT_VIDEO_ROLES } from "./assets";
import { VOLT_RECIPE, VOLT_RECIPE_CONFIG } from "./bundle";

function repeatsIn(nodes: readonly CompiledNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "text"
    ? []
    : [...(node.repeat ? [node.repeat.source] : []), ...repeatsIn(node.children)]);
}

function dataPaths(route: RouteArtifact): string[] {
  return route.bindings.flatMap((binding) => binding.ref.kind === "data" ? [binding.ref.path] : []);
}

function productData(facts: NonNullable<NonNullable<PublicPresentationData["product"]>["facts"]>): PublicPresentationData {
  return {
    store: { name: "Volt Test", logo: null },
    policyLinks: [],
    product: {
      id: "product-1",
      handle: "product-one",
      title: "Product one",
      description: "A merchant-supplied product description.",
      primaryImage: null,
      images: [],
      options: [],
      variants: [{
        id: "variant-1",
        title: "Default",
        price: { cents: 1200, currency: "USD" },
        compareAtPrice: null,
        availability: "In stock",
        available: true,
      }],
      price: { cents: 1200, currency: "USD" },
      compareAtPrice: null,
      availability: "In stock",
      facts,
    },
    collection: null,
    featuredProducts: [],
    relatedProducts: [],
    search: null,
    cart: null,
    notFound: null,
  };
}

describe("volt storefront recipe", () => {
  it("compiles a nine-route live-catalog system with honest conversion controls and safe motion fallback", () => {
    const { bundle, report } = VOLT_RECIPE;

    expect(report.profileVersion).toBe(1);
    expect(report.ok).toBe(false);
    expect(bundle.source).toEqual({ kind: "recipe", templateId: "volt", templateVersion: 1 });
    expect(Object.keys(bundle.routes)).toEqual([
      "home", "collection", "product", "search", "cart", "checkout", "collections", "story", "notFound",
    ]);
    expect(VOLT_RECIPE_CONFIG.archetype).toEqual({
      composition: "system-architecture",
      hero: "cinematic-rim-hero",
      scroll: "system-sequence",
      cards: "spec-modules",
      iconography: ["precision line diagrams", "channel and battery marks"],
    });
    expect(bundle.designSystem).toMatchObject({
      displayFontId: "space-grotesk",
      bodyFontId: "ibm-plex-mono",
    });

    expect(repeatsIn(bundle.routes.home.tree)).toContain("featured.products");
    expect(repeatsIn(bundle.routes.collection.tree)).toContain("collection.products");
    expect(dataPaths(bundle.routes.collection)).toEqual(expect.arrayContaining([
      "collection.title", "collection.description", "product.title", "product.price", "product.availability",
    ]));
    expect(dataPaths(bundle.routes.product)).toEqual(expect.arrayContaining([
      "product.title", "product.description", "product.price", "product.availability", "fact.label", "fact.value", "fact.url", "variant.title", "variant.price",
    ]));

    const homeHtml = bundle.routes.home.html;
    expect(homeHtml).toContain("Compare live products");
    expect(homeHtml).toContain("Build a three-piece setup");
    const routeCopy = Object.values(VOLT_RECIPE_CONFIG.surfaces).map(({ source }) => source.html).join(" ");
    expect(routeCopy).not.toMatch(/compatib|designed to work together|audio|headphone|speaker|listening/i);
    expect(bundle.routes.home.interactions.state).toEqual([]);
    const ecosystemBuilder = bundle.routes.home.trustedSlots.filter((slot) => slot.kind === "bundleBuilder");
    expect(ecosystemBuilder).toEqual([
      expect.objectContaining({ slotCount: 3, hostSize: "block" }),
    ]);
    expect(homeHtml).toContain("including the same product more than once");
    expect(homeHtml).toContain("data-cd-trusted-slot-id");
    expect(homeHtml).not.toContain("data-cd-slot");
    expect(repeatsIn(bundle.routes.product.tree)).toContain("product.facts");
    expect(bundle.routes.product.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["variantPicker", "addToCart"]),
    );
    expect(bundle.routes.product.trustedSlots.filter((slot) => slot.kind === "addToCart")).toHaveLength(1);
    expect(bundle.shell.trustedSlots.map((slot) => slot.kind)).toContain("cartDrawer");
    expect(repeatsIn(bundle.routes.cart.tree)).toContain("cart.lines");
    expect(bundle.routes.cart.trustedSlots.map((slot) => slot.kind)).toEqual(
      expect.arrayContaining(["cartLineControls", "cartSummary"]),
    );

    expect(VOLT_VIDEO_ROLES).toEqual(["hero", "hero-alt", "pdp-detail"]);
    expect(VOLT_VIDEO_ASSET_KEYS).toEqual([
      "hero-poster", "hero-webm", "hero-mp4",
      "hero-alt-poster", "hero-alt-webm", "hero-alt-mp4",
      "pdp-detail-poster", "pdp-detail-webm", "pdp-detail-mp4",
    ]);
    expect(VOLT_RECIPE_CONFIG.assets.entries).toEqual([]);
    expect(report.diagnostics.filter(({ code }) => code === "asset.reference_missing")).toHaveLength(9);
    for (const key of VOLT_VIDEO_ASSET_KEYS) {
      expect(report.diagnostics).toContainEqual(expect.objectContaining({
        code: "asset.reference_missing",
        path: `assets.references.${key}`,
      }));
    }
    expect(homeHtml).toContain('data-cd-poster-asset-key="hero-poster"');
    expect(bundle.routes.story?.html).toContain('data-cd-poster-asset-key="hero-alt-poster"');
    expect(bundle.routes.product.html).toContain('data-cd-poster-asset-key="pdp-detail-poster"');
    expect(homeHtml).toContain("volt-hero-fallback");
    expect(homeHtml).toContain('data-cd-motion="reveal"');
    expect(bundle.routes.home.css).toContain("prefers-reduced-motion:reduce");
    const videoCss = [bundle.routes.home.css, bundle.routes.story?.css ?? "", bundle.routes.product.css].join(" ");
    expect(videoCss).not.toMatch(/volt-(?:hero|story|detail)-film[^}]*display:none/);
    for (const attribute of ["data-cd-video", "autoplay", "loop", "muted", "playsinline"]) {
      expect(homeHtml).toContain(`${attribute}=""`);
    }
    expect(VOLT_RECIPE_CONFIG.surfaces.collections.source.html.match(/data-cd-route="collection"/g)).toHaveLength(1);
    expect(bundle.routes.collection.interactions.transitions.some(({ action }) => action.type === "collection.filter")).toBe(false);
    expect(bundle.routes.cart.html).not.toMatch(/shipping|threshold|order bump|progress/i);
  });

  it("keeps exactly three 8–12 second video briefs in the approved role format", () => {
    const briefs = readFileSync("app/lib/storefront-recipes/volt/video-brief.md", "utf8");
    expect(briefs.match(/^\[VIDEO BRIEF — volt \/ (?:hero|hero-alt|pdp-detail)\]$/gm)).toEqual([
      "[VIDEO BRIEF — volt / hero]",
      "[VIDEO BRIEF — volt / hero-alt]",
      "[VIDEO BRIEF — volt / pdp-detail]",
    ]);
    expect(briefs.match(/Duration: (?:8|9|10|11|12) seconds/g)).toHaveLength(3);
  });

  it("keeps protected purchase controls in the sticky product dossier and renders only supplied facts", () => {
    const source = document.createElement("div");
    source.innerHTML = VOLT_RECIPE_CONFIG.surfaces.product.source.html;
    const dossier = source.querySelector(".volt-product-dossier");
    expect(dossier?.querySelector('[data-cd-slot="variantPicker"]')).not.toBeNull();
    expect(dossier?.querySelector('[data-cd-slot="addToCart"]')).not.toBeNull();
    expect(dossier?.querySelector('.volt-facts [data-cd-empty-state]')).toBeNull();

    const factHtml = renderToStaticMarkup(renderStorefrontRoute({
      routeId: "product",
      artifact: VOLT_RECIPE.bundle.routes.product,
      data: productData([{
        id: "fact-1",
        kind: "reference",
        label: "Battery capacity",
        value: "5000",
        unit: "mAh",
        url: "https://merchant.example/specification",
      }]),
      nonce: "volt-test",
    }).element);
    expect(factHtml).toContain("Battery capacity");
    expect(factHtml).toContain("5000");
    expect(factHtml).toContain('href="https://merchant.example/specification"');

    const noFactHtml = renderToStaticMarkup(renderStorefrontRoute({
      routeId: "product",
      artifact: VOLT_RECIPE.bundle.routes.product,
      data: productData([]),
      nonce: "volt-test",
    }).element);
    expect(noFactHtml).not.toContain("No additional product facts");
  });

  it("records blocked media proof honestly and keeps mobile navigation targets thumb-safe", () => {
    const proof = JSON.parse(readFileSync("app/lib/storefront-recipes/volt/video-proof.json", "utf8")) as {
      templateId: string;
      status: string;
      records: unknown[];
    };
    expect(proof).toEqual(expect.objectContaining({ templateId: "volt", status: "blocked", records: [] }));
    expect(VOLT_RECIPE_CONFIG.surfaces.shell.source.css).toContain(".volt-masthead nav a{display:inline-flex;min-height:44px");
  });
});
