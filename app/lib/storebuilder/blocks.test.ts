// app/lib/storebuilder/blocks.test.ts
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { STARTER_BLOCKS, resolveMediaMarkers } from "./blocks";
import { getBlockMeta } from "./registry";
import { PREVIEW_LINKS } from "./links";
import type { RenderContext } from "./types";
import type { StoreProduct } from "~/lib/storefront/catalog";

const product = (id: string): StoreProduct => ({
  id, handle: `h-${id}`, title: `P${id}`, description: "", images: [{ url: `/i/${id}.jpg`, alt: null }],
  variants: [{ id: `v-${id}`, sku: null, title: "Default", priceCents: 1000, currency: "USD", available: true }],
  collections: ["summer"],
});
const ctx = (): RenderContext => ({
  data: {
    collections: [{ handle: "summer", title: "Summer" }],
    productsByCollection: { summer: [product("1")] },
    productsById: { "1": product("1") },
    allProducts: [product("1")],
  },
});

describe("starter blocks", () => {
  it("registers exactly the 8 starter types with stable flavors", () => {
    expect(STARTER_BLOCKS.map((b) => b.type).sort()).toEqual(
      ["button", "collectionList", "featureRow", "hero", "image", "productGrid", "rawHtml", "richText"],
    );
    const flavor = Object.fromEntries(STARTER_BLOCKS.map((b) => [b.type, b.flavor]));
    expect(flavor.hero).toBe("static");
    expect(flavor.featureRow).toBe("static");
    expect(flavor.rawHtml).toBe("static");
    expect(flavor.productGrid).toBe("dynamic");
  });

  it("collectionList renders category cards with live item counts", () => {
    const cl = STARTER_BLOCKS.find((b) => b.type === "collectionList")!;
    const html = renderToStaticMarkup(createElement(cl.Component, { props: cl.validateProps({ heading: "Browse" }), ctx: ctx() }));
    expect(html).toContain("cd-collection-card"); // a card, not a bare chip link
    expect(html).toContain("Summer");
    expect(html).toContain("1 item"); // live count from productsByCollection
  });

  it("collectionList omits the count when the collection has no loaded products", () => {
    const cl = STARTER_BLOCKS.find((b) => b.type === "collectionList")!;
    const bare: RenderContext = {
      data: { collections: [{ handle: "winter", title: "Winter" }], productsByCollection: {}, productsById: {}, allProducts: [] },
    };
    const html = renderToStaticMarkup(createElement(cl.Component, { props: cl.validateProps({ heading: "Browse" }), ctx: bare }));
    expect(html).toContain("Winter");
    expect(html).not.toContain("item");
  });

  it("featureRow renders a card per value prop (accepts text/body), and nothing when empty", () => {
    const fr = STARTER_BLOCKS.find((b) => b.type === "featureRow")!;
    const clean = fr.validateProps({
      heading: "Why us",
      items: [{ title: "Made to last", body: "Built well." }, { title: "Free shipping", text: "On every order." }],
    }) as { items: { title: string; body: string }[] };
    expect(clean.items).toHaveLength(2);
    expect(clean.items[1].body).toBe("On every order."); // `text` alias accepted
    const html = renderToStaticMarkup(createElement(fr.Component, { props: clean, ctx: ctx() }));
    expect(html).toContain("Made to last");
    expect(html).toContain("cd-feature");
    // No items → renders nothing, so a hollow/empty block never leaves a bare heading.
    const empty = renderToStaticMarkup(createElement(fr.Component, { props: fr.validateProps({ heading: "x", items: [] }), ctx: ctx() }));
    expect(empty).toBe("");
  });

  it("validateProps fills defaults and coerces bad input without throwing on recoverable shape", () => {
    const hero = STARTER_BLOCKS.find((b) => b.type === "hero")!;
    const clean = hero.validateProps({ headline: "Hi" });
    expect(clean).toMatchObject({ headline: "Hi" });
    expect(typeof (clean as { subhead: string }).subhead).toBe("string"); // default applied
  });

  it("productGrid.catalogRefs surfaces the collection handle it binds to", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "collection", handle: "summer" } });
    expect(grid.catalogRefs(props)).toEqual({ productIds: [], collectionHandles: ["summer"] });
  });

  it("renders productGrid against resolved data", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const props = grid.validateProps({ source: { kind: "all" } });
    const html = renderToStaticMarkup(createElement(grid.Component, { props, ctx: ctx() }));
    expect(html).toContain("P1");
    expect(html).toContain("/i/1.jpg");
  });

  it("validators tolerate null/undefined/non-object input without throwing", () => {
    for (const b of STARTER_BLOCKS) {
      expect(() => b.validateProps(null)).not.toThrow();
      expect(() => b.validateProps(undefined)).not.toThrow();
      expect(() => b.validateProps(42)).not.toThrow();
      expect(() => b.validateProps("x")).not.toThrow();
    }
  });

  it("button rejects a javascript: href, falling back to a safe default", () => {
    const button = STARTER_BLOCKS.find((b) => b.type === "button")!;
    const clean = button.validateProps({ label: "x", href: "javascript:alert(1)" }) as { href: string };
    expect(clean.href).toBe("/storefront");
    const ok = button.validateProps({ href: "/products" }) as { href: string };
    expect(ok.href).toBe("/products");
  });

  it("hero keeps a safe imageUrl and renders it as a background image; text-only when absent", () => {
    const hero = STARTER_BLOCKS.find((b) => b.type === "hero")!;
    const withImg = hero.validateProps({ headline: "Hi", subhead: "yo", imageUrl: "/i/hero.jpg" }) as { imageUrl: string };
    expect(withImg.imageUrl).toBe("/i/hero.jpg");
    // An unsafe src (data:/other schemes) is dropped — same allowlist as the image block.
    const junk = hero.validateProps({ headline: "Hi", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }) as { imageUrl: string };
    expect(junk.imageUrl).toBe("");

    const withImgHtml = renderToStaticMarkup(
      createElement(hero.Component, { props: hero.validateProps({ headline: "Hi", subhead: "yo", imageUrl: "/i/hero.jpg" }), ctx: ctx() }),
    );
    expect(withImgHtml).toContain("/i/hero.jpg"); // the hero renders the image
    expect(withImgHtml).toContain("data-has-image"); // flags itself so the CSS gives it the overlay treatment
    expect(withImgHtml).toContain("Hi"); // headline still present, layered over the image

    const textOnlyHtml = renderToStaticMarkup(
      createElement(hero.Component, { props: hero.validateProps({ headline: "Hi", subhead: "yo" }), ctx: ctx() }),
    );
    expect(textOnlyHtml).not.toContain("<img"); // no image → the classic text hero, unchanged
  });

  it("renders collectionList against resolved data", () => {
    const cl = STARTER_BLOCKS.find((b) => b.type === "collectionList")!;
    const html = renderToStaticMarkup(createElement(cl.Component, { props: cl.validateProps({}), ctx: ctx() }));
    expect(html).toContain("Summer");
  });

  it("routes catalog + CTA links through ctx.links (live storefront by default, preview when overridden)", () => {
    const grid = STARTER_BLOCKS.find((b) => b.type === "productGrid")!;
    const gridProps = grid.validateProps({ source: { kind: "all" } });
    const gridDefault = renderToStaticMarkup(createElement(grid.Component, { props: gridProps, ctx: ctx() }));
    expect(gridDefault).toContain('href="/storefront/products/h-1"'); // live storefront by default
    const gridPreview = renderToStaticMarkup(createElement(grid.Component, { props: gridProps, ctx: { ...ctx(), links: PREVIEW_LINKS } }));
    // & is HTML-escaped to &amp; in the markup, so assert the params separately.
    expect(gridPreview).toContain("/dashboard/store/preview?page=pdp"); // preview stays inside the iframe
    expect(gridPreview).toContain("handle=h-1");

    const cl = STARTER_BLOCKS.find((b) => b.type === "collectionList")!;
    const clPreview = renderToStaticMarkup(createElement(cl.Component, { props: cl.validateProps({}), ctx: { ...ctx(), links: PREVIEW_LINKS } }));
    expect(clPreview).toContain("/dashboard/store/preview?page=collection");
    expect(clPreview).toContain("handle=summer");

    const button = STARTER_BLOCKS.find((b) => b.type === "button")!;
    const btnPreview = renderToStaticMarkup(createElement(button.Component, { props: button.validateProps({ href: "/storefront" }), ctx: { ...ctx(), links: PREVIEW_LINKS } }));
    expect(btnPreview).toContain("/dashboard/store/preview?page=home"); // a /storefront CTA folds back into the preview home
  });
});

describe("resolveMediaMarkers (real product photography in generated HTML)", () => {
  const product = (id: string, url: string) => ({
    id, handle: `h-${id}`, title: `P${id}`, description: "",
    images: [{ url, alt: null }], variants: [], collections: [],
  });

  it("wires the product's live photo into a data-cd-media img and strips any smuggled src", () => {
    const html = '<section><img data-cd-media="p1" alt="The mug" src="https://evil.example/pixel.gif"></section>';
    const out = resolveMediaMarkers(html, { p1: product("p1", "https://cdn.example/mug.jpg?sig=a&b=c") } as never);
    expect(out).toContain('src="https://cdn.example/mug.jpg?sig=a&amp;b=c"');
    expect(out).toContain('alt="The mug"');
    expect(out).not.toContain("evil.example");
  });

  it("drops the img entirely when the product is gone or has no photo (never a broken frame)", () => {
    const html = '<section><img data-cd-media="ghost" alt="x"><p>copy</p></section>';
    expect(resolveMediaMarkers(html, {} as never)).toBe("<section><p>copy</p></section>");
    expect(resolveMediaMarkers(html, undefined)).toBe("<section><p>copy</p></section>");
  });

  it("leaves marker-free HTML untouched", () => {
    const html = "<section><h1>Hi</h1></section>";
    expect(resolveMediaMarkers(html, {} as never)).toBe(html);
  });
});

describe("rawHtml catalogRefs (photo markers drive data resolution)", () => {
  it("reports every referenced product id", () => {
    const meta = getBlockMeta("rawHtml")!;
    const refs = meta.catalogRefs({ html: '<img data-cd-media="a"><div><img data-cd-media="b" alt=""></div>' } as never);
    expect(refs.productIds).toEqual(["a", "b"]);
    expect(refs.collectionHandles).toEqual([]);
  });
});
