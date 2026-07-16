import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StorefrontProduct from "../storefront.products.$handle";

const { loaderData } = vi.hoisted(() => ({ loaderData: { current: null as unknown } }));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderData.current,
  Form: ({ children }: { children?: unknown }) => createElement("form", null, children as never),
}));

describe("storefront product descriptions", () => {
  it("renders the complete merchant description as escaped text", () => {
    loaderData.current = {
      product: {
        id: "product-one",
        handle: "one",
        title: "Product one",
        description: "First line <em>and every detail</em> through the end.",
        images: [],
        variants: [],
        collections: [],
      },
      doc: null,
      data: null,
      record: {},
      demo: true,
      unavailable: false,
    };

    const html = renderToStaticMarkup(createElement(StorefrontProduct));
    expect(html).toContain("First line &lt;em&gt;and every detail&lt;/em&gt; through the end.");
    expect(html).not.toContain("First line <em>and every detail</em> through the end.");
  });
});
