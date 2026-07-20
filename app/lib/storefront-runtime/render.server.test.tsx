import { createElement } from "react";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RouteArtifact, StorefrontBundleV1 } from "~/lib/storefront-bundle/types";
import { CURATED_FONT_IDS } from "~/lib/storefront-bundle/types";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";
import { SOFT_CHEMISTRY_BUNDLE } from "~/lib/storefront-recipes/soft-chemistry/bundle";
import { resolveStorefrontVisualPlacement } from "./visual-layer.server";
import { CURATED_STOREFRONT_FONTS } from "./curated-fonts";
import {
  renderStorefrontSurface,
  renderCheckoutRoute,
  renderStorefrontRoute,
  type PublicPresentationData,
} from "./render.server";

const emptyInteractions = { version: 1 as const, state: [], bindings: [], transitions: [] };
const publicProduct: NonNullable<PublicPresentationData["product"]> = {
  id: "product-1",
  handle: "product-one",
  title: "Product one",
  description: "",
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
};
const data: PublicPresentationData = {
  store: { name: `</h1><script>alert("x")</script>`, logo: null },
  policyLinks: [],
  product: null,
  collection: null,
  featuredProducts: [],
  relatedProducts: [],
  search: null,
  cart: null,
  notFound: null,
};

function artifact(overrides: Partial<RouteArtifact> = {}): RouteArtifact {
  return {
    html: `<script>whole-route source must never render</script>`,
    tree: [{
      kind: "element",
      id: "cd-home-title",
      tag: "h1",
      attributes: { title: `Pinned "attribute"` },
      children: [{ kind: "text", value: "fallback" }],
    }],
    bindings: [{
      id: "binding-title",
      targetId: "cd-home-title",
      kind: "text",
      ref: { kind: "data", scopeId: "root", path: "store.name" },
    }],
    css: "",
    requiredData: [{ kind: "storeIdentity" }],
    requiredCapabilities: [],
    interactions: emptyInteractions,
    trustedSlots: [],
    ...overrides,
  };
}

describe("compiled-node server renderer", () => {
  it("renders an isolated unregistered volt v1 recipe", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "volt", templateVersion: 1 };
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle: compileBundle(source).bundle,
      routeId: "home",
      data,
      nonce: "volt-nonce",
      mode: "public",
    }));

    expect(html).toContain('data-cd-bundle="home"');
  });

  it("renders poster-first video with manifest-resolved sources only", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.assets.entries = [
      { key: "hero-poster", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 },
      { key: "hero-webm", contentHash: "b".repeat(64), mediaType: "video/webm", byteSize: 84 },
      { key: "hero-mp4", contentHash: "c".repeat(64), mediaType: "video/mp4", byteSize: 84 },
    ];
    source.routes.home.html = `<main><video data-cd-video data-cd-poster-asset="hero-poster" muted autoplay playsinline loop preload="metadata"><source data-cd-asset="hero-webm" type="video/webm"><source data-cd-asset="hero-mp4" type="video/mp4"></video></main>`;
    const bundle = compileBundle(source).bundle;
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "video-nonce", mode: "public",
      customAssetUrls: { "hero-poster": "/poster.webp", "hero-webm": "/hero.webm", "hero-mp4": "/hero.mp4" },
    }));

    expect(html).toContain('poster="/poster.webp"');
    expect(html).toContain('src="/hero.webm"');
    expect(html).toContain('src="/hero.mp4"');
    expect(html).toContain("autoplay");
    expect(html).toContain("playsinline");
  });

  it("does not treat persisted autoplay false as enabled", () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const root = bundle.routes.home.tree[0];
    if (root.kind !== "element") throw new Error("Expected home root");
    root.tag = "video";
    root.attributes.autoplay = "false";
    const html = renderToStaticMarkup(renderStorefrontSurface({ bundle, routeId: "home", data, nonce: "video-false", mode: "public" }));
    expect(html).not.toContain("autoplay");
  });
  it("emits validated design tokens and every curated self-hosted font beneath the bundle root", () => {
    for (const fontId of CURATED_FONT_IDS) {
      const source = structuredClone(VALID_BUNDLE_SOURCE);
      source.designSystem.displayFontId = fontId;
      source.designSystem.bodyFontId = fontId;
      source.designSystem.tokens = { ink: "#123456", rhythm: "clamp(1rem, 2vw, 2rem)", "space-4": "16px", surface: "#ffffff" };
      const html = renderToStaticMarkup(renderStorefrontSurface({
        bundle: compileBundle(source).bundle,
        routeId: "home",
        data,
        nonce: "font-nonce",
        mode: "public",
      }));
      const definition = CURATED_STOREFRONT_FONTS[fontId];
      const family = definition.family.startsWith("CD ") ? definition.family : `'${definition.family}'`;

      expect(html).toContain('data-cd-bundle-style="tokens"');
      expect(html).not.toContain("width:min(450px,calc(48% - 68px))");
      expect(html).toContain("--ink:#123456");
      expect(html).toContain("--rhythm:clamp(1rem, 2vw, 2rem)");
      expect(html).toContain(`--font-display:${family}`);
      expect(html).toContain(`--font-body:${family}`);
      expect(html).not.toContain("fonts.googleapis.com");
      expect(html).not.toContain("fonts.gstatic.com");
      for (const { file } of definition.faces) {
        const fontPath = resolve(process.cwd(), `public/storefront-fonts/${file}-latin.woff2`);
        expect(html).toContain(`/storefront-fonts/${file}-latin.woff2`);
        expect(existsSync(fontPath)).toBe(true);
        expect(existsSync(fontPath) ? statSync(fontPath).size : 0).toBeGreaterThan(1_000);
      }
    }
  });

  it("fails closed when a mutated bundle contains an unsafe design token", () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    bundle.designSystem.tokens.ink = `red; background-image:url(https://evil.example/pixel)`;

    expect(() => renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "token-nonce", mode: "public",
    }))).toThrow(/token|unsafe|forbidden/i);

    bundle.designSystem.tokens.ink = String.raw`u\72l("https://evil.example/pixel")`;
    expect(() => renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "token-nonce", mode: "public",
    }))).toThrow(/token|unsafe|forbidden/i);
  });

  it("resolves declared recipe image keys only inside the owned recipe asset directory", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><img data-cd-asset="hero" alt="Editorial look" width="1800" height="1200"></main>`;
    const bundle = compileBundle(source).bundle;

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "asset-nonce", mode: "public",
    }));

    expect(html).toContain(`src="/storefront-recipes/atelier-nine/${"a".repeat(64)}.webp"`);
    expect(html).toContain('data-cd-asset-key="hero"');
  });

  it("emits no visual host for immutable bundles without an active shader", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><figure><img data-cd-asset="hero" alt="Editorial look"></figure></main>`;
    const bundle = compileBundle(source).bundle;
    const absentHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));
    expect(absentHtml).not.toContain("data-cd-visual-host");

    bundle.visualLayer = { kind: "none" };
    const noneHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));
    expect(noneHtml).not.toContain("data-cd-visual-host");
  });

  it("renders one template-neutral visual host at the registered recipe fallback", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><figure><img data-cd-asset="hero" alt="Editorial look"></figure></main>`;
    const bundle = compileBundle(source).bundle;
    bundle.visualLayer = {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    };

    const unresolvedHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
    }));
    expect(unresolvedHtml).not.toContain("data-cd-visual-host");

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));

    expect(html.match(/data-cd-visual-host=/g)).toHaveLength(1);
    expect(html).not.toContain("data-cd-visual-slot");
    expect(html).not.toContain("visual:atelier-nine:v1");
    expect(html).toContain('data-cd-asset-key="hero"');

    bundle.source = { kind: "custom", generationId: "generation", promptHash: "hash" };
    const customHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));
    expect(customHtml).not.toContain("data-cd-visual-host");
  });

  it("keeps repeated recipe fallbacks static instead of declaring multiple visual hosts", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><section data-cd-repeat="featured.products"><figure data-cd-key="product.id"><img data-cd-asset="hero" alt="Editorial look"></figure></section></main>`;
    const bundle = compileBundle(source).bundle;
    bundle.visualLayer = {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    };
    const products = [
      { ...publicProduct, id: "product-a", handle: "a" },
      { ...publicProduct, id: "product-b", handle: "b" },
    ];

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data: { ...data, featuredProducts: products },
      nonce: "visual-nonce",
      mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));

    expect(html).not.toContain("data-cd-visual-host");
    expect(html.match(/data-cd-asset-key="hero"/g)).toHaveLength(2);
  });

  it("uses the first static fallback when source-faithful editorial layouts reuse the hero asset", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><figure><img data-cd-asset="hero" alt="Primary editorial look"></figure><figure><img data-cd-asset="hero" alt="Secondary editorial look"></figure></main>`;
    const bundle = compileBundle(source).bundle;
    bundle.visualLayer = {
      kind: "fragment_shader",
      source: "void main(){gl_FragColor=vec4(1.0);}",
      colors: ["#000000", "#111111", "#222222"],
    };

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "visual-nonce", mode: "public",
      visualLayerPlacement: resolveStorefrontVisualPlacement(bundle, "home"),
    }));

    expect(html.match(/data-cd-visual-host=/g)).toHaveLength(1);
    expect(html.match(/data-cd-asset-key="hero"/g)).toHaveLength(2);
  });

  it("uses a server-resolved recipe asset URL when the preview host does not serve deploy assets", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><img data-cd-asset="hero" alt="Editorial look" width="1800" height="1200"></main>`;
    const bundle = compileBundle(source).bundle;

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "asset-nonce", mode: "preview",
      customAssetUrls: { hero: "https://app.example.test/storefront-recipes/atelier-nine/hero.webp" },
    }));

    expect(html).toContain('src="https://app.example.test/storefront-recipes/atelier-nine/hero.webp"');
  });

  it("keeps custom assets fail-closed unless the caller supplies a separately verified URL", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/webp", byteSize: 42 }];
    source.routes.home.html = `<main><img data-cd-asset="hero" alt="Merchant campaign" width="1200" height="800"></main>`;
    const bundle = compileBundle(source).bundle;
    const scriptUrl = ["java", "script:alert(1)"].join("");
    const closed = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "asset-nonce", mode: "public",
    }));
    const resolved = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "asset-nonce", mode: "public",
      customAssetUrls: { hero: "https://cdn.example.test/verified/hero.webp" },
    }));
    const unsafe = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data, nonce: "asset-nonce", mode: "public",
      customAssetUrls: { hero: scriptUrl, ghost: "https://cdn.example.test/ghost.webp" },
    }));

    expect(closed).not.toContain("<img src=");
    expect(resolved).toContain('src="https://cdn.example.test/verified/hero.webp"');
    expect(unsafe).not.toContain(scriptUrl);
    expect(unsafe).not.toContain("ghost.webp");
  });

  it("keeps protected design assets separate from generated catalog media", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.assets.entries = [{ key: "hero", contentHash: "a".repeat(64), mediaType: "image/png", byteSize: 42 }];
    source.routes.home.html = `<main><img data-cd-asset="hero" alt="Merchant campaign" width="1200" height="800"><section data-cd-repeat="featured.products"><img data-cd-key="product.id" data-cd-src="product.primaryImage" data-cd-alt="product.title"></section></main>`;
    const bundle = compileBundle(source).bundle;
    const generatedProduct = {
      ...publicProduct,
      primaryImage: { url: "https://assets.example.test/generated-product", alt: "Generated product" },
      images: [{ url: "https://assets.example.test/generated-product", alt: "Generated product" }],
    };
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data: {
        ...data,
        featuredProducts: [generatedProduct],
        storefrontAssetUrls: { hero: "https://assets.example.test/signed-hero" },
      },
      nonce: "asset-nonce",
      mode: "public",
    }));

    expect(html).toContain('src="https://assets.example.test/signed-hero"');
    expect(html).toContain('src="https://assets.example.test/generated-product"');
  });

  it("renders shell and route artifacts from one immutable bundle with identical compiled keys", () => {
    const compiled = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const bundle: StorefrontBundleV1 = {
      ...compiled,
      shell: {
        ...compiled.shell,
        tree: [{
          kind: "element",
          id: "cd-shell-home-link",
          tag: "a",
          attributes: {},
          routeTarget: { routeId: "home", params: {} },
          children: [{ kind: "text", value: "Home" }],
        }, ...compiled.shell.tree],
      },
    };
    const publicHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data,
      nonce: "same-request-nonce",
      mode: "public",
    }));
    const previewHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data,
      nonce: "same-request-nonce",
      mode: "preview",
    }));

    expect(publicHtml).toContain('data-cd-bundle-shell="home"');
    expect(publicHtml).toContain('data-cd-bundle-route="home"');
    expect(publicHtml).toContain('data-cd-bundle="shell"');
    expect(publicHtml).toContain('data-cd-bundle="home"');
    expect(publicHtml).toContain('data-cd-bundle="global"');
    expect(publicHtml).toContain('nonce="same-request-nonce"');
    expect(previewHtml.match(/id="cd-[^"]+"/g)).toEqual(publicHtml.match(/id="cd-[^"]+"/g));
    expect(previewHtml).toContain("/dashboard/store/preview?route=home");
    expect(publicHtml).toContain('href="/storefront"');
    expect(publicHtml).toContain('data-cd-compiler-id="cd-shell-home-link"');
    expect(publicHtml).toContain('data-cd-compiler-id="cd-home-');
  });

  it("keeps the selected recipe while navigating its interactive preview", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.source = { kind: "recipe", templateId: "atelier-nine", templateVersion: 1 };
    source.shell.html = `<a data-cd-route="collection">Shop</a>`;

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle: compileBundle(source).bundle,
      routeId: "home",
      data,
      nonce: "recipe-preview-nonce",
      mode: "preview",
    }));

    expect(html).toContain("/dashboard/store/preview?route=collection&amp;template=atelier-nine");
  });

  it("routes bare collection navigation to the virtual all-products collection", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.shell.html = `<a data-cd-route="collection">Shop</a>`;
    const bundle = compileBundle(source).bundle;
    const collection = {
      id: "collection-featured",
      handle: "featured",
      title: "Featured",
      description: "",
      image: null,
      productCount: 0,
      products: [],
      nextCursor: null,
    };

    const collectionHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "collection",
      data: { ...data, collection },
      nonce: "collection-link-nonce",
      mode: "public",
    }));
    const fallbackHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data,
      nonce: "collection-fallback-nonce",
      mode: "public",
    }));

    expect(collectionHtml).toContain('href="/storefront/collections/featured"');
    expect(fallbackHtml).toContain('href="/storefront/collections/all"');
    expect(`${collectionHtml}${fallbackHtml}`).not.toContain('href="/storefront/collections"');
  });

  it("renders the global shell footer after the active route", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.shell.html = `<header class="global-header">Global header</header><footer>Global footer</footer>`;
    source.shell.css = `a{color:red}.global-header~footer{color:green}`;
    source.routes.home.html = `<main>Home content<a data-cd-route="search">Route action</a></main>`;
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle: compileBundle(source).bundle,
      routeId: "home",
      data,
      nonce: "shell-order-nonce",
      mode: "public",
    }));

    expect(html.indexOf("Global header")).toBeLessThan(html.indexOf("Home content"));
    expect(html.indexOf("Home content")).toBeLessThan(html.indexOf("Global footer"));
    expect(html.match(/data-cd-bundle="shell"/g)).toHaveLength(1);
    expect(html).toContain("[data-cd-bundle=shell] a:not([data-cd-bundle-route]):not([data-cd-bundle-route] *)");
    expect(html).toContain("[data-cd-bundle=shell] .global-header~footer:not([data-cd-bundle-route]):not([data-cd-bundle-route] *)");
    expect(html).not.toContain("@scope");
  });

  it("keeps the canonical compiler ID on repeated DOM instances", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.html = `<main><section data-cd-repeat="featured.products"><article id="card" data-cd-key="product.id"><h2 id="title" data-cd-text="product.title"></h2></article></section></main>`;
    const bundle = compileBundle(source).bundle;
    const products = [
      { ...publicProduct, id: "product-a", handle: "a", title: "A" },
      { ...publicProduct, id: "product-b", handle: "b", title: "B" },
    ];
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data: { ...data, featuredProducts: products }, nonce: "repeat", mode: "preview",
    }));

    expect(html.match(/data-cd-compiler-id="cd-home-card"/g)).toHaveLength(2);
    expect(html.match(/id="cd-home-card-i-[^"]+"/g)).toHaveLength(2);
    expect(html.match(/data-cd-repeat-owner="true"/g)).toHaveLength(2);
  });

  it("excerpts repeated product descriptions while preserving the complete PDP description", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.html = `<main><section data-cd-repeat="featured.products"><p class="card-description" data-cd-key="product.id" data-cd-text="product.description"></p></section></main>`;
    source.routes.collection.html = `<main><section data-cd-repeat="collection.products"><p class="card-description" data-cd-key="product.id" data-cd-text="product.description"></p></section></main>`;
    source.routes.search.html = `<main><section data-cd-repeat="search.results"><p class="card-description" data-cd-key="product.id" data-cd-text="product.description"></p></section></main>`;
    source.routes.product.html = `<main><p class="pdp-description" data-cd-text="product.description"></p><section data-cd-repeat="related.products"><p class="card-description" data-cd-key="product.id" data-cd-text="product.description"></p></section></main>`;
    const bundle = compileBundle(source).bundle;
    const description = `<strong>Merchant & field notes</strong> ${"detail ".repeat(30)}complete ending`;
    const product = { ...publicProduct, description };
    const routeData: Array<["home" | "collection" | "search" | "product", PublicPresentationData]> = [
      ["home", { ...data, featuredProducts: [product] }],
      ["collection", { ...data, collection: { id: "collection-1", handle: "all", title: "All", description: "", image: null, productCount: 1, products: [product], nextCursor: null } }],
      ["search", { ...data, search: { query: "field", results: [product], facets: { categories: [], tags: [], collections: [] }, total: 1, nextCursor: null } }],
      ["product", { ...data, product, relatedProducts: [product] }],
    ];

    for (const [routeId, routeDataValue] of routeData) {
      const html = renderToStaticMarkup(renderStorefrontSurface({
        bundle, routeId, data: routeDataValue, nonce: `${routeId}-description`, mode: "public",
      }));
      const cardDescription = html.match(/class="card-description"[^>]*>([^<]*)<\/p>/)?.[1];
      expect(cardDescription).toContain("&lt;strong&gt;Merchant &amp; field notes&lt;/strong&gt;");
      expect(cardDescription).toContain("…");
      expect(cardDescription).not.toContain("complete ending");
      expect(html).not.toContain("<strong>Merchant & field notes</strong>");
    }

    const pdpHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "product", data: { ...data, product }, nonce: "pdp-description", mode: "public",
    }));
    const pdpDescription = pdpHtml.match(/class="pdp-description"[^>]*>([^<]*)<\/p>/)?.[1];
    expect(pdpDescription).toContain("&lt;strong&gt;Merchant &amp; field notes&lt;/strong&gt;");
    expect(pdpDescription).toContain("complete ending");
  });

  it("resolves each product.images repeat binding to that media item's URL and alt text", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.product.html = `<main><div data-cd-repeat="product.images"><img data-cd-key="product.primaryImage" data-cd-src="product.primaryImage" data-cd-alt="product.title"></div></main>`;
    const bundle = compileBundle(source).bundle;
    const product = {
      ...publicProduct,
      primaryImage: { url: "https://cdn.example.test/primary.webp", alt: "Primary view" },
      images: [
        { url: "https://cdn.example.test/front.webp", alt: "Front view" },
        { url: "https://cdn.example.test/back.webp", alt: "Back view" },
      ],
    };

    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "product", data: { ...data, product }, nonce: "media-nonce", mode: "public",
    }));

    expect(html).toContain('src="https://cdn.example.test/front.webp"');
    expect(html).toContain('alt="Front view"');
    expect(html).toContain('src="https://cdn.example.test/back.webp"');
    expect(html).toContain('alt="Back view"');
    expect(html).not.toContain("primary.webp");
  });

  it("expands policy placeholders into allowlisted platform routes and ignores supplied URLs", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.html = `<main><footer data-cd-policy-links><span>Generated content is replaced</span></footer></main>`;
    const bundle = compileBundle(source).bundle;
    const scriptProtocol = ["java", "script:"].join("");
    const policyData: PublicPresentationData = {
      ...data,
      policyLinks: [
        { id: "privacy", title: "Privacy policy", href: `${scriptProtocol}alert(1)` },
        { id: "shipping", title: "Shipping policy", href: "https://attacker.example/redirect" },
        { id: "admin", title: "Admin", href: "/admin" },
      ],
    };

    const publicHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data: policyData, nonce: "policy-nonce", mode: "public",
    }));
    const previewHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle, routeId: "home", data: policyData, nonce: "policy-nonce", mode: "preview",
    }));

    expect(publicHtml).toContain('<a href="/storefront/policies/privacy">Privacy policy</a>');
    expect(publicHtml).toContain('<a href="/storefront/policies/shipping">Shipping policy</a>');
    expect(publicHtml).not.toContain(scriptProtocol);
    expect(publicHtml).not.toContain("attacker.example");
    expect(publicHtml).not.toContain("Admin");
    expect(publicHtml).not.toContain("Generated content is replaced");
    expect(previewHtml).toContain('<a href="#">Privacy policy</a>');
  });

  it("composes deterministic collision-resistant instance IDs across nested repeats", () => {
    const repeatedArtifact = artifact({
      tree: [{
        kind: "element", id: "cd-home-outer", tag: "div", attributes: {},
        repeat: { scopeId: "cd-home-scope-outer", source: "featured.products", itemKind: "product", keyPath: "product.id" },
        children: [{
          kind: "element", id: "cd-home-inner", tag: "section", attributes: {},
          repeat: { scopeId: "cd-home-scope-inner", source: "featured.products", itemKind: "product", keyPath: "product.id" },
          children: [{ kind: "element", id: "cd-home-leaf", tag: "span", attributes: {}, children: [] }],
        }],
      }],
    });
    const repeatedData = {
      ...data,
      featuredProducts: [
        { ...publicProduct, id: "parent-a", handle: "parent-a" },
        { ...publicProduct, id: "parent-b", handle: "parent-b" },
      ],
    };
    const render = () => renderToStaticMarkup(createElement(() => renderStorefrontRoute({
      routeId: "home", artifact: repeatedArtifact, data: repeatedData, nonce: "route-nonce",
    }).element));
    const first = render();
    const second = render();
    const leafIds = [...first.matchAll(/id="(cd-home-leaf-[^"]+)"/g)].map((match) => match[1]);
    expect(leafIds).toHaveLength(4);
    expect(new Set(leafIds).size).toBe(4);
    expect(first).toBe(second);
  });

  it("renders a zero cart count for visitors without a cart", () => {
    const countArtifact = artifact({
      tree: [{
        kind: "element",
        id: "cd-home-bag",
        tag: "span",
        attributes: {},
        children: [],
      }],
      bindings: [{
        id: "binding-bag",
        targetId: "cd-home-bag",
        kind: "text",
        ref: { kind: "data", scopeId: "root", path: "cart.count" },
      }],
      requiredData: [],
    });
    const html = renderToStaticMarkup(createElement(() => renderStorefrontRoute({
      routeId: "home", artifact: countArtifact, data: { ...data, cart: null }, nonce: "route-nonce",
    }).element));
    expect(html).toMatch(/<span[^>]*id="cd-home-bag"[^>]*>0<\/span>/);
  });

  it("does not collide repeat IDs that only differ after a long shared prefix", () => {
    const prefix = "x".repeat(80);
    const repeatedArtifact = artifact({
      tree: [{
        kind: "element", id: "cd-home-item", tag: "div", attributes: {}, children: [],
        repeat: { scopeId: "cd-home-scope-items", source: "featured.products", itemKind: "product", keyPath: "product.id" },
      }],
    });
    const result = renderStorefrontRoute({
      routeId: "home",
      artifact: repeatedArtifact,
      data: {
        ...data,
        featuredProducts: [
          { ...publicProduct, id: `${prefix}-a`, handle: "a" },
          { ...publicProduct, id: `${prefix}-b`, handle: "b" },
        ],
      },
      nonce: "route-nonce",
    });
    const html = renderToStaticMarkup(createElement(() => result.element));
    const ids = [...html.matchAll(/id="(cd-home-item-[^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("renders authoritative CompiledNode trees with React-escaped text and attributes", () => {
    const result = renderStorefrontRoute({ routeId: "home", artifact: artifact({ css: ".title{color:red}" }), data, nonce: "route-nonce" });
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(result.status).toBe(200);
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).toContain('title="Pinned &quot;attribute&quot;"');
    expect(html).not.toContain("whole-route source must never render");
    expect(html).not.toContain("dangerouslySetInnerHTML");
    expect(html).toContain('<style nonce="route-nonce"');
    expect(html).toContain(".title{color:red}");
    expect(html).toContain('data-cd-bundle="home"');
  });

  it("emits compiler-validated CSS as raw style text so quoted selectors hydrate exactly", () => {
    const result = renderStorefrontRoute({
      routeId: "home",
      artifact: artifact({ css: `[data-state="ready"]{display:grid}` }),
      data,
      nonce: "route-nonce",
    });
    const html = renderToStaticMarkup(createElement(() => result.element));

    expect(html).toContain(`[data-state="ready"]{display:grid}`);
    expect(html).not.toContain("[data-state=&quot;ready&quot;]");
  });

  it("fails closed when a persisted artifact contains a raw style terminator", () => {
    const compromised = artifact({ css: `[data-cd-bundle="home"] main{/*</style><form>*/color:red}` });

    expect(() => {
      const result = renderStorefrontRoute({
        routeId: "home",
        artifact: compromised,
        data,
        nonce: "route-nonce",
      });
      renderToStaticMarkup(createElement(() => result.element));
    }).toThrow(/style end tag/i);
  });

  it("renders a stable decorative placeholder when catalog media is missing", () => {
    const source = structuredClone(VALID_BUNDLE_SOURCE);
    source.routes.home.html = `<main><section data-cd-repeat="featured.products"><img data-cd-key="product.id" data-cd-src="product.primaryImage" data-cd-alt="product.title"></section></main>`;
    const bundle = compileBundle(source).bundle;
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle,
      routeId: "home",
      data: { ...data, featuredProducts: [publicProduct] },
      nonce: "media-fallback-nonce",
      mode: "public",
    }));

    expect(html).toContain('data-cd-media-fallback="true"');
    expect(html).toContain('src="data:image/svg+xml,');
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain('alt="Product one"');
  });

  it("uses the selected design's owned product placeholder before generated media is ready", () => {
    const html = renderToStaticMarkup(renderStorefrontSurface({
      bundle: SOFT_CHEMISTRY_BUNDLE,
      routeId: "collection",
      data: {
        ...data,
        collection: {
          id: "collection-1",
          handle: "formulas",
          title: "Formulas",
          description: "Live formulas",
          image: { url: "https://cdn.example.test/collection.webp", alt: "Formula shelf" },
          productCount: 1,
          products: [publicProduct],
          nextCursor: null,
        },
      },
      nonce: "recipe-media-fallback",
      mode: "public",
    }));

    expect(html).toContain('data-cd-media-fallback="true"');
    expect(html).toContain("width:min(450px,calc(48vw - 68px))");
    expect(html).toContain(`src="/storefront-recipes/soft-chemistry/${SOFT_CHEMISTRY_BUNDLE.assets.entries[0]!.contentHash}.webp"`);
    expect(html).not.toContain('src="data:image/svg+xml,');
  });

  it("keeps published Soft Chemistry v5 commerce geometry while v6 uses the overlay controls", () => {
    const legacyBundle = structuredClone(SOFT_CHEMISTRY_BUNDLE);
    if (legacyBundle.source.kind !== "recipe") throw new Error("Expected recipe bundle");
    legacyBundle.source.templateVersion = 5;
    const legacyHtml = renderToStaticMarkup(renderStorefrontSurface({
      bundle: legacyBundle,
      routeId: "home",
      data,
      nonce: "legacy-soft-chemistry",
      mode: "public",
    }));

    expect(legacyHtml).toContain("width:min(450px,calc(48% - 68px))");
    expect(legacyHtml).not.toContain('main.overlay{position:fixed}');
  });

  it("shows design empty copy only when the route repeat is actually empty", () => {
    const collection = {
      id: "collection-1",
      handle: "formulas",
      title: "Formulas",
      description: "Live formulas",
      image: null,
      productCount: 1,
      products: [publicProduct],
      nextCursor: null,
    };
    const render = (products: typeof collection.products) => renderToStaticMarkup(renderStorefrontSurface({
      bundle: SOFT_CHEMISTRY_BUNDLE,
      routeId: "collection",
      data: { ...data, collection: { ...collection, productCount: products.length, products } },
      nonce: "empty-state",
      mode: "public",
    }));

    expect(render([publicProduct])).not.toContain("No formulas found.");
    expect(render([])).toContain("No formulas found.");
  });

  it("returns a platform-owned 404 instead of rendering a generated missing-record route", () => {
    const result = renderStorefrontRoute({
      routeId: "product",
      artifact: artifact(),
      data: { ...data, notFound: { kind: "product", handle: "gone" } },
      nonce: "route-nonce",
    });
    expect(result.status).toBe(404);
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(html).toContain("Product not found");
    expect(html).not.toContain("whole-route source must never render");
  });

  it("replaces compiler-authorized slot nodes with platform-owned closed-shadow hosts", () => {
    const bundle = compileBundle(VALID_BUNDLE_SOURCE).bundle;
    const result = renderStorefrontRoute({
      routeId: "product",
      artifact: bundle.routes.product,
      data: { ...data, product: publicProduct },
      nonce: "route-nonce",
    });
    const html = renderToStaticMarkup(createElement(() => result.element));
    expect(html).toContain('data-cd-trusted-slot="addToCart"');
    expect(html).toContain('data-cd-shadow-mode="closed"');
    expect(html).toContain('data-cd-authority-key="product:product-1"');
    expect(html).not.toContain("hide me");
  });

  it("refuses cart-line controls without the exact repeated cart-line scope", () => {
    const cartData: PublicPresentationData = {
      ...data,
      cart: {
        id: "cart-1", count: 1,
        lines: [{
          id: "line-1", title: "Line", quantity: 1,
          unitPrice: { cents: 1200, currency: "USD" }, total: { cents: 1200, currency: "USD" },
        }],
        subtotal: { cents: 1200, currency: "USD" }, discounts: { cents: 0, currency: "USD" },
        total: { cents: 1200, currency: "USD" },
      },
    };
    const invalid = artifact({
      tree: [{
        kind: "element", id: "cd-cart-slot-1", tag: "div", attributes: {}, children: [], trustedSlotId: "cd-cart-slot-1",
      }],
      trustedSlots: [{ id: "cd-cart-slot-1", kind: "cartLineControls", hostSize: "block", themeTokenIds: [] }],
    });
    expect(() => renderStorefrontRoute({ routeId: "cart", artifact: invalid, data: cartData, nonce: "route-nonce" }))
      .toThrow(/cartLine|authority/i);
  });

  it("renders checkout decoration and platform checkout controls as sibling roots", () => {
    const checkout: StorefrontBundleV1["routes"]["checkout"] = compileBundle(VALID_BUNDLE_SOURCE).bundle.routes.checkout;
    const html = renderToStaticMarkup(renderCheckoutRoute({ artifact: checkout, data, nonce: "checkout-nonce" }));
    expect(html).toMatch(/data-cd-checkout-decoration[\s\S]*<\/div><div data-cd-checkout-islands/);
    expect(html).toContain('data-cd-checkout-section="payment"');
    expect(html).toContain('<style nonce="checkout-nonce"');
    expect(html).toContain('data-cd-bundle="checkout"');
  });
});
