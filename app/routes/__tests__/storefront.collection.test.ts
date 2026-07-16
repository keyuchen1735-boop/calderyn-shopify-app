import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import StorefrontCollection from "../storefront.collections.$handle";

const { loaderData } = vi.hoisted(() => ({ loaderData: { current: null as unknown } }));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderData.current }));

describe("storefront collection cards", () => {
  it("renders merchant descriptions as escaped text", () => {
    loaderData.current = {
      handle: "apparel",
      title: "Apparel",
      products: [{
        id: "product-one",
        handle: "one",
        title: "Product one",
        description: "Built <strong>for daily use</strong>",
        images: [],
        variants: [],
        collections: ["apparel"],
      }],
      doc: null,
      data: null,
      record: { collection: { handle: "apparel", title: "Apparel" } },
    };

    const html = renderToStaticMarkup(createElement(StorefrontCollection));
    expect(html).toContain("Built &lt;strong&gt;for daily use&lt;/strong&gt;");
    expect(html).not.toContain("Built <strong>for daily use</strong>");
  });
});
