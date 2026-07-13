import { beforeEach, describe, expect, it, vi } from "vitest";
import { loader as collectionLoader } from "../storefront.collections.$handle";
import { loader as searchLoader } from "../storefront.search";

const { resolveRuntime1RouteMock } = vi.hoisted(() => ({ resolveRuntime1RouteMock: vi.fn() }));

vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: (...args: unknown[]) => resolveRuntime1RouteMock(...args),
  hasRuntime1Storefront: vi.fn(async () => true),
}));

const runtimeData = {
  runtime: 1,
  bundleId: "bundle-1",
  artifactHash: "sha256:bundle-1",
  bundle: {},
  data: { notFound: null, collection: { title: "Featured" } },
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveRuntime1RouteMock.mockResolvedValue(runtimeData);
});

async function thrownResponse(run: () => Promise<unknown>): Promise<Response> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("loader did not throw");
}

describe("runtime-1 search route grammar", () => {
  it("passes the validated Task 6 query, facets, sort, and cursor to release data resolution", async () => {
    const request = new Request("https://demo.calderyncompany.com/storefront/search?q=vegan&category=Beauty&sort=price_desc&limit=1");
    await searchLoader({ request, params: {}, context: {} } as never);
    expect(resolveRuntime1RouteMock).toHaveBeenCalledWith(expect.objectContaining({
      request,
      route: expect.objectContaining({
        kind: "search",
        searchInput: expect.objectContaining({ query: "vegan", category: "Beauty", sort: "price_desc", limit: 1 }),
      }),
    }));
  });

  it("returns a structured 422 for invalid search input", async () => {
    const response = await thrownResponse(() => searchLoader({
      request: new Request("https://demo.calderyncompany.com/storefront/search?unknown=1"), params: {}, context: {},
    } as never));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "invalid_search_request" } });
    expect(resolveRuntime1RouteMock).not.toHaveBeenCalled();
  });
});

describe("runtime-1 collection route grammar", () => {
  it("translates only allowlisted collection facets plus sort/cursor", async () => {
    const request = new Request("https://demo.calderyncompany.com/storefront/collections/featured?filter.tag=vegan&filter.available=true&sort=price_asc");
    await collectionLoader({ request, params: { handle: "featured" }, context: {} } as never);
    expect(resolveRuntime1RouteMock).toHaveBeenCalledWith(expect.objectContaining({
      request,
      route: expect.objectContaining({
        kind: "collection",
        handle: "featured",
        searchInput: expect.objectContaining({ collection: "featured", tag: "vegan", available: true, sort: "price_asc" }),
      }),
    }));
  });

  it("returns a structured 422 for an invented collection facet", async () => {
    const response = await thrownResponse(() => collectionLoader({
      request: new Request("https://demo.calderyncompany.com/storefront/collections/featured?filter.color=red"),
      params: { handle: "featured" }, context: {},
    } as never));
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: { code: "invalid_search_request" } });
    expect(resolveRuntime1RouteMock).not.toHaveBeenCalled();
  });
});
