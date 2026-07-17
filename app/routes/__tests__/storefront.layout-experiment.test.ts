import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import StorefrontLayout, { loader } from "../storefront";

const { resolveServedMock, loaderDataRef, matchesRef } = vi.hoisted(() => ({
  resolveServedMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
  matchesRef: { current: [] as unknown[] },
}));

vi.mock("~/lib/experiments/store-experiment.server", () => ({
  resolveServedExperiment: resolveServedMock,
}));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => createElement("span", null, "child"),
  useMatches: () => matchesRef.current,
}));

beforeEach(() => {
  vi.clearAllMocks();
  loaderDataRef.current = null;
  matchesRef.current = [];
});

describe("storefront layout cutover", () => {
  it("does not read or expose legacy experiments or catalog navigation", async () => {
    const response = await loader({
      request: new Request("https://demo.calderyncompany.com/storefront"),
      params: {},
      context: {},
    } as never);
    const data = await response.json();

    expect(data.experimentVibe).toBeNull();
    expect(data.collections).toEqual([]);
    expect(resolveServedMock).not.toHaveBeenCalled();
  });

  it("renders a runtime-1 child without the platform shell", () => {
    loaderDataRef.current = {
      settings: {},
      experimentVibe: null,
      collections: [],
    };
    matchesRef.current = [{ data: { runtime: 1 } }];
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toBe("<span>child</span>");
  });

  it("keeps the platform shell for account and other non-generated routes", async () => {
    const response = await loader({
      request: new Request("https://demo.calderyncompany.com/storefront/account"),
      params: {},
      context: {},
    } as never);
    loaderDataRef.current = await response.json();
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
    expect(html).toContain("child");
  });
});
