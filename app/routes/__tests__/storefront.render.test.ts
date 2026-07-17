import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StorefrontLayout, { links, loader } from "../storefront";

const { loaderDataRef } = vi.hoisted(() => ({
  loaderDataRef: { current: null as unknown },
}));

vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => null,
  useMatches: () => [],
}));

beforeEach(() => {
  loaderDataRef.current = null;
});

describe("storefront platform layout", () => {
  it("loads store settings without legacy navigation data", async () => {
    const response = await loader({
      request: new Request("https://demo.calderyncompany.com/storefront/account"),
      params: {},
      context: {},
    } as never);
    const data = await response.json();
    expect(data.settings.storeName.length).toBeGreaterThan(0);
    expect(data.settings.palette).toHaveProperty("primary");
    expect(data.collections).toEqual([]);
    expect(data.experimentVibe).toBeNull();
  });

  it("links the storefront stylesheet", () => {
    expect(JSON.stringify(links())).toContain("stylesheet");
  });

  it("renders the platform shell with brand and display settings", () => {
    loaderDataRef.current = {
      settings: {
        shopId: "demo-shop",
        storeName: "Demo Store",
        logoUrl: "https://img.example/logo.png",
        palette: { primary: "#0f766e", background: "#ffffff", text: "#111827" },
        typeStyle: "editorial",
        density: "roomy",
      },
      collections: [],
      experimentVibe: null,
    };
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
    expect(html).toContain("Demo Store");
    expect(html).toContain('data-type="editorial"');
    expect(html).toContain('data-density="roomy"');
    expect(html).not.toContain("cd-store__nav");
  });
});
