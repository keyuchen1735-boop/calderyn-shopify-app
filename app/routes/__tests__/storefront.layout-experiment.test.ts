// app/routes/__tests__/storefront.layout-experiment.test.ts
// D4 arm-b vibe override at the LAYOUT root (not the home route): the vibe
// token packs redeclare on .cd-store, so a running vibe experiment restyles
// the whole page for a bucketed visitor. Bucketing itself (cookie-only ids,
// failure isolation) is the shared resolver's contract, unit-tested in
// store-experiment.server.test.ts — these tests cover the route's use of it.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import StorefrontLayout, { loader } from "../storefront";

const { resolveServedMock, loaderDataRef } = vi.hoisted(() => ({
  resolveServedMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  resolveServedExperiment: resolveServedMock,
}));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => null,
}));

const RUNNING_EXPERIMENT = { id: "exp-1", pageKey: "home" as const, variantSettings: { vibe: "bold" as const } };
const NOT_SERVED = { experiment: null, experimentId: null, variantKey: null };

beforeEach(() => {
  vi.clearAllMocks();
  resolveServedMock.mockResolvedValue(NOT_SERVED);
  loaderDataRef.current = null;
});

async function runLoader() {
  const request = new Request("https://demo.calderyncompany.com/storefront");
  const res = await loader({ request, params: {}, context: {} } as never);
  return res.json();
}

describe("storefront layout experiment vibe", () => {
  it("arm b: the layout loader surfaces the challenger vibe from the shared resolver", async () => {
    resolveServedMock.mockResolvedValue({ experiment: RUNNING_EXPERIMENT, experimentId: "exp-1", variantKey: "b" });
    const data = await runLoader();
    expect(data.experimentVibe).toBe("bold");
    expect(resolveServedMock).toHaveBeenCalledWith("demo-shop", expect.any(Request), "layout");
  });

  it("arm a: keeps the champion vibe (null override)", async () => {
    resolveServedMock.mockResolvedValue({ experiment: RUNNING_EXPERIMENT, experimentId: "exp-1", variantKey: "a" });
    const data = await runLoader();
    expect(data.experimentVibe).toBeNull();
  });

  it("not served (no test / first visit / lookup failure inside the resolver): renders the champion shell", async () => {
    const data = await runLoader();
    expect(data.experimentVibe).toBeNull();

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
  });
});
