// app/routes/__tests__/storefront.home-experiment.test.ts
// D4 A/B serving on the home route: arm-b doc swap, arm-a exposure stamp, and
// champion passthrough when nothing is served. Bucketing (cookie-only ids,
// participation rules, failure isolation) is the shared resolver's contract,
// unit-tested in store-experiment.server.test.ts.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import StorefrontHome, { loader } from "../storefront._index";
import { requireLegacyLoaderData } from "./storefront-runtime-test-data";

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
}));
vi.mock("~/lib/storefront-runtime/release-resolution.server", () => ({
  resolveRuntime1Route: resolveRuntime1RouteMock,
}));
vi.mock("@remix-run/react", () => ({ useLoaderData: () => loaderDataRef.current }));

const CHAMPION = {
  kind: "singleton" as const,
  pageKey: "home" as const,
  blocks: [
    {
      id: "h",
      type: "hero" as const,
      layout: { x: 0, y: 0, w: 12, h: 2 },
      props: { headline: "CHAMPION", subhead: "" },
    },
  ],
};
const CHALLENGER = {
  kind: "singleton" as const,
  pageKey: "home" as const,
  blocks: [
    {
      id: "h2",
      type: "hero" as const,
      layout: { x: 0, y: 0, w: 12, h: 2 },
      props: { headline: "CHALLENGER", subhead: "" },
    },
  ],
};
const RUNNING_EXPERIMENT = {
  id: "exp-1",
  pageKey: "home" as const,
  name: "Sharper headline",
  why: "",
  startedAt: "2026-07-01T00:00:00.000Z",
  variantDoc: CHALLENGER,
  variantSettings: { vibe: "bold" as const },
};
const NOT_SERVED = { experiment: null, experimentId: null, variantKey: null };

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockResolvedValue(CHAMPION);
  trackStorefrontEventMock.mockResolvedValue(new Headers());
  ensureVisitorSessionMock.mockResolvedValue({ visitorId: "vid-1", sessionId: "sid-1", isReturning: true, headers: new Headers() });
  resolveServedMock.mockResolvedValue(NOT_SERVED);
  resolveRuntime1RouteMock.mockResolvedValue(null);
  loaderDataRef.current = null;
});

const req = () => new Request("https://demo.calderyncompany.com/storefront");

async function runLoader() {
  const res = await loader({ request: req(), params: {}, context: {} } as never);
  return requireLegacyLoaderData(await res.json());
}

describe("home A/B serving", () => {
  it("bypasses the legacy experiment and visitor path for one resolved runtime-1 bundle", async () => {
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
    expect(resolveServedMock).not.toHaveBeenCalled();
    expect(ensureVisitorSessionMock).not.toHaveBeenCalled();
    expect(loadPublishedMock).not.toHaveBeenCalled();
  });

  it("arm b: swaps the published doc for the challenger and stamps exposure", async () => {
    resolveServedMock.mockResolvedValue({ experiment: RUNNING_EXPERIMENT, experimentId: "exp-1", variantKey: "b" });

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHALLENGER");
    expect(resolveServedMock).toHaveBeenCalledWith("demo-shop", expect.any(Request), "home");

    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: "exp-1", variantKey: "b" },
      expect.objectContaining({ visitorId: expect.any(String), sessionId: expect.any(String) }),
    );

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("CHALLENGER");
    // The vibe override must NOT be stamped on the route's own subtree (it lands
    // on the layout root instead, where the token packs redeclare).
    expect(html).not.toContain("data-vibe=");
  });

  it("arm a: keeps serving the champion but still stamps exposure for the running test", async () => {
    resolveServedMock.mockResolvedValue({ experiment: RUNNING_EXPERIMENT, experimentId: "exp-1", variantKey: "a" });

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");

    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: "exp-1", variantKey: "a" },
      expect.objectContaining({ visitorId: expect.any(String), sessionId: expect.any(String) }),
    );

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("CHAMPION");
    expect(html).not.toContain("data-vibe=");
  });

  it("arm b of a NON-home experiment never swaps this page's doc (belt over the resolver's participation rule)", async () => {
    resolveServedMock.mockResolvedValue({
      experiment: { ...RUNNING_EXPERIMENT, pageKey: "pdp" as const },
      experimentId: "exp-1",
      variantKey: "b",
    });

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");
    // Still a treated view (the resolver said so) — exposure stamps.
    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: "exp-1", variantKey: "b" },
      expect.anything(),
    );
  });

  it("not served (no test / first visit / lookup failure inside the resolver): champion, no stamp", async () => {
    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");
    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: null, variantKey: null },
      expect.objectContaining({ visitorId: expect.any(String), sessionId: expect.any(String) }),
    );
  });
});
