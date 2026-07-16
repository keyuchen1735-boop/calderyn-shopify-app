import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StorefrontCollection from "../storefront.collections.$handle";
import { compileBundle } from "~/lib/storefront-compiler/compile";
import { VALID_BUNDLE_SOURCE } from "~/lib/storefront-compiler/__fixtures__/valid-bundle";

const { loaderData } = vi.hoisted(() => ({ loaderData: { current: null as unknown } }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderData.current }));

describe("storefront collection cards", () => {
  it("renders merchant descriptions as escaped text", () => {
    const description = `Built <strong>for daily use & travel</strong> ${"detail ".repeat(30)}complete ending`;
    loaderData.current = {
      handle: "apparel",
      title: "Apparel",
      products: [{
        id: "product-one",
        handle: "one",
        title: "Product one",
        description,
        images: [],
        variants: [],
        collections: ["apparel"],
      }],
      doc: null,
      data: null,
      record: { collection: { handle: "apparel", title: "Apparel" } },
    };

    const html = renderToStaticMarkup(createElement(StorefrontCollection));
    expect(html).toContain("Built &lt;strong&gt;for daily use &amp; travel&lt;/strong&gt;");
    expect(html).toContain("…");
    expect(html).not.toContain("Built <strong>for daily use & travel</strong>");
    expect(html).not.toContain("complete ending");
  });

  it("renders the platform next-page control after runtime collection output", () => {
    loaderData.current = {
      runtime: 1,
      nonce: "test-nonce",
      bundle: compileBundle(VALID_BUNDLE_SOURCE).bundle,
      nextPageHref: "?filter.tag=vegan&cursor=signed.cursor",
      data: {
        store: { name: "Store", logo: null }, policyLinks: [], product: null,
        collection: {
          id: "collection-apparel", handle: "apparel", title: "Apparel", description: "",
          image: null, productCount: 61, products: [], nextCursor: "signed.cursor",
        },
        featuredProducts: [], relatedProducts: [], search: null, cart: null, notFound: null,
      },
    };

    const html = renderToStaticMarkup(createElement(StorefrontCollection));
    expect(html).toContain('data-cd-bundle-runtime="1"');
    expect(html).toContain('rel="next"');
    expect(html).toContain('cursor=signed.cursor');
  });
});
