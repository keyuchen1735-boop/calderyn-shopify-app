// app/routes/__tests__/storefront.home-experiment.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../storefront._index";

// vi.hoisted refs are wired before module eval (vitest hoists vi.mock to top of file at
// transform time), so the import order above is safe — mocks are applied before execution.
const {
  getCatalogMock,
  loadPublishedMock,
  resolveServedMock,
  trackStorefrontEventMock,
  ensureVisitorSessionMock,
  resolveRuntime1RouteMock,
  loaderDataRef,
} = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loadPublishedMock: vi.fn(),
  resolveServedMock: vi.fn(),
  trackStorefrontEventMock: vi.fn(),
  ensureVisitorSessionMock: vi.fn(),
  resolveRuntime1RouteMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  resolveServedExperiment: resolveServedMock,
}));
vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: trackStorefrontEventMock,
}));
vi.mock("~/lib/storefront/visitor-cookie.server", () => ({
  ensureVisitorSession: ensureVisitorSessionMock,
  appendStorefrontTrackingCookies: (target: Headers, source: Headers) => {
    for (const cookie of source.getSetCookie()) target.append("Set-Cookie", cookie);
  },
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: resolveRuntime1RouteMock,
}));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

const NOT_SERVED = { experiment: null, experimentId: null, variantKey: null };

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(null);
  loadPublishedMock.mockResolvedValue(null);
  trackStorefrontEventMock.mockResolvedValue(new Headers());
  ensureVisitorSessionMock.mockResolvedValue({ visitorId: "vid-1", sessionId: "sid-1", isReturning: true, headers: new Headers() });
  resolveServedMock.mockResolvedValue(NOT_SERVED);
  resolveRuntime1RouteMock.mockResolvedValue(null);
  loaderDataRef.current = null;
});

const req = () => new Request("https://demo.calderyncompany.com/storefront");

describe("storefront home runtime cutover", () => {
  it("fails closed when no runtime-1 release exists instead of rendering legacy generated HTML", async () => {
    loadPublishedMock.mockResolvedValue({
      kind: "singleton",
      pageKey: "home",
      blocks: [{
        id: "legacy-html",
        type: "rawHtml",
        layout: { x: 0, y: 0, w: 12, h: 12 },
        props: { html: "<main>legacy generated html</main>" },
      }],
    });
    await expect(loader({ request: req(), params: {}, context: {} } as never))
      .rejects.toMatchObject({ status: 503 });
    expect(resolveServedMock).not.toHaveBeenCalled();
    expect(ensureVisitorSessionMock).not.toHaveBeenCalled();
    expect(loadPublishedMock).not.toHaveBeenCalled();
  });

  it("bypasses legacy experiment setup while tracking one runtime-1 page view", async () => {
    resolveRuntime1RouteMock.mockResolvedValue({
      runtime: 1,
      bundleId: "bundle-1",
      artifactHash: "sha256:bundle",
      routeId: "home",
      bundle: { source: { kind: "custom" } },
      data: { store: { name: "Acme", logo: null } },
    });

    const response = await loader({ request: req(), params: {}, context: {} } as never);
    const result: unknown = await response.json();
    expect(result).toBeTruthy();
    if (!result || typeof result !== "object" || !("nonce" in result)) throw new Error("runtime-1 payload missing nonce");
    expect(result).toMatchObject({ runtime: 1, bundleId: "bundle-1", routeId: "home" });
    expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(response.headers.get("X-Calderyn-Storefront-Renderer")).toBe("bundle-v1");
    expect(response.headers.get("X-Calderyn-Storefront-Nonce")).toBe(result.nonce);
    expect(trackStorefrontEventMock).toHaveBeenCalledWith(req(), "demo-shop", "page_view");
    expect(resolveServedMock).not.toHaveBeenCalled();
    expect(ensureVisitorSessionMock).not.toHaveBeenCalled();
    expect(loadPublishedMock).not.toHaveBeenCalled();
  });

});
