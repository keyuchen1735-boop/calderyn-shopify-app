// app/routes/__tests__/storefront.layout-experiment.test.ts
// D4 arm-b vibe override at the LAYOUT root (not the home route): the vibe
// token packs redeclare on .cd-store, so a running vibe experiment restyles
// the whole page for a bucketed visitor. Failure-isolated to the champion look.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ensureVisitorSession } from "~/lib/storefront/visitor-cookie.server";
import StorefrontLayout, { loader } from "../storefront";

// The visitor-cookie helper stays REAL (pure, no DB) so the loader exercises the
// actual signed-cookie round-trip, mirroring storefront.checkout-experiment.test.ts.
const { getRunningExperimentMock, assignArmMock, loaderDataRef } = vi.hoisted(() => ({
  getRunningExperimentMock: vi.fn(),
  assignArmMock: vi.fn(),
  loaderDataRef: { current: null as unknown },
}));
vi.mock("~/lib/experiments/store-experiment.server", () => ({
  getRunningExperiment: getRunningExperimentMock,
  assignArm: assignArmMock,
}));
vi.mock("@remix-run/react", () => ({
  useLoaderData: () => loaderDataRef.current,
  Outlet: () => null,
}));

const RUNNING_EXPERIMENT = { id: "exp-1", variantSettings: { vibe: "bold" as const } };

beforeEach(() => {
  vi.clearAllMocks();
  loaderDataRef.current = null;
});

function req(cookie?: string): Request {
  return new Request("https://demo.calderyncompany.com/storefront", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

async function cdVidCookie(): Promise<string> {
  const session = await ensureVisitorSession(req());
  const vid = session.headers.getSetCookie().find((c) => c.startsWith("cd_vid="));
  if (!vid) throw new Error("cd_vid Set-Cookie missing");
  return vid.split(";")[0];
}

async function runLoader(cookie?: string) {
  const res = await loader({ request: req(cookie), params: {}, context: {} } as never);
  return res.json();
}

describe("storefront layout experiment vibe", () => {
  it("arm b with a cd_vid cookie: the layout loader surfaces the challenger vibe", async () => {
    getRunningExperimentMock.mockResolvedValue(RUNNING_EXPERIMENT);
    assignArmMock.mockReturnValue("b");

    const data = await runLoader(await cdVidCookie());
    expect(data.experimentVibe).toBe("bold");
  });

  it("no cd_vid cookie yet: never buckets an untracked visitor, experimentVibe is null", async () => {
    getRunningExperimentMock.mockResolvedValue(RUNNING_EXPERIMENT);

    const data = await runLoader();
    expect(data.experimentVibe).toBeNull();
    expect(assignArmMock).not.toHaveBeenCalled();
  });

  it("lookup failure: falls back to null instead of breaking the shell render", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    getRunningExperimentMock.mockRejectedValue(new Error("supabase down"));

    const data = await runLoader(await cdVidCookie());
    expect(data.experimentVibe).toBeNull();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    loaderDataRef.current = data;
    const html = renderToStaticMarkup(createElement(StorefrontLayout));
    expect(html).toContain("cd-store");
  });
});
