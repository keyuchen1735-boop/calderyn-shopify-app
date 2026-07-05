// app/routes/__tests__/storefront.home-experiment.test.ts
// D4 A/B serving on the home route: arm-b doc/vibe swap, arm-a exposure stamp,
// and lookup-failure isolation to the champion path.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fixtureCatalog } from "~/lib/storefront/catalog.stub.server";
import StorefrontHome, { loader } from "../storefront._index";

// vi.hoisted refs are wired before module eval (vitest hoists vi.mock to top of file at
// transform time), so the import order above is safe — mocks are applied before execution.
const {
  getCatalogMock,
  loadPublishedMock,
  getRunningExperimentMock,
  assignArmMock,
  trackStorefrontEventMock,
  loaderDataRef,
} = vi.hoisted(() => ({
  getCatalogMock: vi.fn(),
  loadPublishedMock: vi.fn(),
  getRunningExperimentMock: vi.fn(),
  assignArmMock: vi.fn(),
  trackStorefrontEventMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/storefront/catalog.server", () => ({ getCatalog: getCatalogMock }));
vi.mock("~/lib/storebuilder/page-document.server", () => ({ loadPublishedDoc: loadPublishedMock }));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  getRunningExperiment: getRunningExperimentMock,
  assignArm: assignArmMock,
}));
vi.mock("~/lib/storefront/events.server", () => ({
  trackStorefrontEvent: trackStorefrontEventMock,
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

beforeEach(() => {
  vi.clearAllMocks();
  getCatalogMock.mockReturnValue(fixtureCatalog);
  loadPublishedMock.mockResolvedValue(CHAMPION);
  trackStorefrontEventMock.mockResolvedValue(new Headers());
  loaderDataRef.current = null;
});

const req = () => new Request("https://demo.calderyncompany.com/storefront");

async function runLoader() {
  const res = await loader({ request: req(), params: {}, context: {} } as never);
  return res.json();
}

describe("home A/B serving", () => {
  it("arm b: swaps the published doc for the challenger and stamps the vibe override", async () => {
    getRunningExperimentMock.mockResolvedValue(RUNNING_EXPERIMENT);
    assignArmMock.mockReturnValue("b");

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHALLENGER");

    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: "exp-1", variantKey: "b" },
    );

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("CHALLENGER");
    // The override must NOT be stamped on the route's own subtree (it lands
    // on the layout root instead, where the token packs redeclare).
    expect(html).not.toContain("data-vibe=");
  });

  it("arm a: keeps serving the champion but still stamps exposure for the running test", async () => {
    getRunningExperimentMock.mockResolvedValue(RUNNING_EXPERIMENT);
    assignArmMock.mockReturnValue("a");

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");

    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: "exp-1", variantKey: "a" },
    );

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontHome));
    expect(html).toContain("CHAMPION");
    expect(html).not.toContain("data-vibe=");
  });

  it("no running experiment: renders the champion with no exposure stamp", async () => {
    getRunningExperimentMock.mockResolvedValue(null);

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");
    expect(assignArmMock).not.toHaveBeenCalled();
    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: null, variantKey: null },
    );
  });

  it("lookup failure: falls back to the champion instead of breaking the render", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getRunningExperimentMock.mockRejectedValue(new Error("supabase down"));

    const data = await runLoader();
    expect(data.doc.blocks[0].props.headline).toBe("CHAMPION");
    expect(trackStorefrontEventMock).toHaveBeenCalledWith(
      expect.any(Request),
      "demo-shop",
      "page_view",
      { experimentId: null, variantKey: null },
    );
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
