// app/routes/__tests__/storefront.track-wiring.test.ts
// Live-analytics wiring: storefront loaders/actions emit exactly one event and
// forward the visitor/session Set-Cookie headers on their responses.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader as homeLoader } from "../storefront._index";
import { loader as collectionLoader } from "../storefront.collections.$handle";
import { action as pdpAction, loader as productLoader } from "../storefront.products.$handle";
import { loader as searchLoader } from "../storefront.search";

const track = vi.fn(async (..._a: unknown[]) => {
  const h = new Headers();
  h.append("Set-Cookie", "cd_sid=test.n; Path=/");
  return h;
});
const resolveStorefrontShop = vi.fn(async (..._a: unknown[]) => "11111111-2222-3333-4444-555555555555");
const resolveRuntime1Route = vi.fn();
interface ServedFake {
  experiment: { id: string; pageKey: string } | null;
  experimentId: string | null;
  variantKey: string | null;
}
const resolveServedExperiment = vi.fn(
  async (..._a: unknown[]): Promise<ServedFake> => ({
    experiment: null,
    experimentId: null,
    variantKey: null,
  }),
);

vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: (...a: unknown[]) => track(...a),
}));
vi.mock("~/lib/storefront/shop.server", () => ({
  resolveStorefrontShop: (...a: unknown[]) => resolveStorefrontShop(...a),
  DEMO_SHOP_ID: "demo-shop",
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: (...a: unknown[]) => resolveRuntime1Route(...a),
}));
vi.mock("~/lib/storefront/catalog.server", () => ({
  getCatalog: () => ({
    getProduct: vi.fn(async () => ({
      id: "p1",
      handle: "mug",
      title: "Mug",
      description: "",
      variants: [],
    })),
  }),
}));
vi.mock("~/lib/storebuilder/page-document.server", () => ({
  loadPublishedDoc: vi.fn(async () => null),
}));
vi.mock("~/lib/storebuilder/resolve-data.server", () => ({
  resolveRenderData: vi.fn(async () => null),
}));
vi.mock("~/lib/order/cart.server", () => ({
  buildCart: vi.fn(async () => ({ id: "cart-1" })),
  addCartLine: vi.fn(async () => ({ id: "line-1", productId: "p1" })),
  priceCart: vi.fn(async () => null),
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  resolveServedExperiment: (...a: unknown[]) => resolveServedExperiment(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  resolveRuntime1Route.mockImplementation(async ({ route }: { route: { kind: string } }) => ({
    runtime: 1,
    bundleId: "bundle-1",
    artifactHash: "sha256:bundle-1",
    routeId: route.kind,
    bundle: {},
    visualLayerPlacement: null,
    data: {
      store: { name: "Store", logo: null },
      notFound: null,
      product: { id: "p1", title: "Mug" },
      collection: { title: "Featured", nextCursor: null },
      search: { nextCursor: null },
    },
  }));
});

describe("storefront live-analytics wiring", () => {
  it.each([
    ["home", homeLoader, "https://x.example/storefront", {}, true, null],
    ["product", productLoader, "https://x.example/storefront/products/mug", { handle: "mug" }, true, "p1"],
    ["collection", collectionLoader, "https://x.example/storefront/collections/featured", { handle: "featured" }, true, null],
    ["search", searchLoader, "https://x.example/storefront/search?q=mug", {}, false, null],
  ] as const)("%s loader emits page_view while preserving tracking and cache headers", async (
    _route,
    loader,
    url,
    params,
    publiclyCached,
    productId,
  ) => {
    const res = await loader({ request: new Request(url), params, context: {} } as never);

    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("page_view");
    if (productId) expect(track.mock.calls[0][3]).toMatchObject({ productId });
    expect(res.headers.getSetCookie().some((cookie) => cookie.startsWith("cd_sid="))).toBe(true);
    expect(res.headers.get("X-Calderyn-Storefront-Renderer")).toBe("bundle-v1");
    expect(res.headers.get("Cache-Control")).toBe(publiclyCached
      ? "public, max-age=0, s-maxage=300, stale-while-revalidate=60"
      : "private, no-store");
  });

  it("PDP action emits cart_add and still redirects to the cart", async () => {
    const res = (await pdpAction({
      request: new Request("https://x.example/storefront/products/mug", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ variantId: "v1" }),
      }),
      params: { handle: "mug" },
      context: {},
    })) as Response;
    expect(track).toHaveBeenCalledTimes(1);
    expect(track.mock.calls[0][2]).toBe("cart_add");
    // cart_add records the owning PRODUCT id (same id kind as page_view), not the variant id.
    expect((track.mock.calls[0][3] as { productId?: string }).productId).toBe("p1");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/storefront/cart");
    expect(res.headers.getSetCookie().some((c) => c.startsWith("cd_sid="))).toBe(true);
  });

  it("PDP action does not consult the removed legacy experiment path", async () => {
    await pdpAction({
      request: new Request("https://x.example/storefront/products/mug", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ variantId: "v1" }),
      }),
      params: { handle: "mug" },
      context: {},
    });
    expect(resolveServedExperiment).not.toHaveBeenCalled();
    expect(track.mock.calls[0][3]).toMatchObject({ productId: "p1" });
  });
});
