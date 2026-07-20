import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime1RouteData } from "~/lib/storefront-runtime/release-resolution.server";
import { loader as collectionsLoader } from "../storefront.collections._index";
import { loader as storyLoader } from "../storefront.story";
import { loader as notFoundLoader } from "../storefront.$";

const mocks = vi.hoisted(() => ({ resolveRuntime1Route: vi.fn() }));
vi.mock("~/lib/storefront/shop.server", () => ({ resolveStorefrontShop: vi.fn(async () => "11111111-1111-1111-1111-111111111111") }));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({ resolveRuntime1Route: mocks.resolveRuntime1Route }));
vi.mock("~/lib/storefront-runtime/csp.server", () => ({ markStorefrontBundleRendered: vi.fn() }));

function runtime(routeId: Runtime1RouteData["routeId"]): Runtime1RouteData {
  return { routeId } as Runtime1RouteData;
}

beforeEach(() => mocks.resolveRuntime1Route.mockReset());

describe("optional storefront route loaders", () => {
  it("redirects an old bundle from collections index to the platform collection fallback", async () => {
    mocks.resolveRuntime1Route.mockResolvedValue(runtime("home"));
    const response = await collectionsLoader({ request: new Request("https://shop.test/storefront/collections"), params: {}, context: {} });
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/storefront/collections/all");
  });

  it("serves the optional story route when the saved bundle provides it", async () => {
    mocks.resolveRuntime1Route.mockResolvedValue(runtime("story"));
    const response = await storyLoader({ request: new Request("https://shop.test/storefront/story"), params: {}, context: {} });
    expect(response.status).toBe(200);
  });

  it("keeps the catch-all HTTP status platform-owned at 404", async () => {
    mocks.resolveRuntime1Route.mockResolvedValue(runtime("notFound"));
    const response = await notFoundLoader({ request: new Request("https://shop.test/storefront/missing"), params: { "*": "missing" }, context: {} });
    expect(response.status).toBe(404);
  });
});
