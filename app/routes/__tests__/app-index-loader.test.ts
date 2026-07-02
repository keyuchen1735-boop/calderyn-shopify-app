import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { LoaderFunctionArgs } from "react-router";
// vitest hoists the vi.mock() calls below above this import, so the route module
// loads with every boundary already mocked.
import { loader } from "../app._index";

const { buildEngineSpy } = vi.hoisted(() => ({
  buildEngineSpy: vi.fn(),
}));

// Stub the UI deps so importing the route module doesn't pull the real libs.
vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    Banner: Stub,
    BlockStack: Stub,
    Box: Stub,
    Button: Stub,
    Card: Stub,
    InlineGrid: Stub,
    InlineStack: Stub,
    Layout: Stub,
    Page: Stub,
    Text: Stub,
  };
});
vi.mock("~/components/calderyn/LiveEngineView", () => ({
  default: () => null,
  LiveBadge: () => null,
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

// The home now renders the Live Engine: its loader builds LiveEnginePageData.
vi.mock("~/lib/calibration/live-engine-page.server", () => ({
  buildLiveEnginePageData: (...a: unknown[]) => buildEngineSpy(...a),
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    onboarding: { getState: async () => ({ done: true }) },
    guardrails: { get: async () => ({ autopilot_enabled: false }) },
    campaigns: { list: async () => [] },
  }),
}));

const EMPTY_ENGINE = {
  autopilotEnabled: false,
  moneyProtectedWeekCents: 0,
  features: [],
  pipeline: [],
  trace: [],
  pending: [],
  predictions: [],
  calibrationPct: null,
  nearGraduation: 0,
};

function args(): LoaderFunctionArgs {
  return {
    request: new Request("https://app.example.com/app"),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

describe("app._index (Live Engine home) loader dashboardLoginUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    buildEngineSpy.mockReset();
  });

  it("points at the public dashboard login for the session shop", async () => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://calderyncompany.com");
    buildEngineSpy.mockResolvedValue(EMPTY_ENGINE);
    const res = await loader(args());
    const payload = await toResponse(res).json();
    expect(payload.error).toBeNull();
    expect(payload.dashboardLoginUrl).toBe(
      "https://calderyncompany.com/dashboard/login?shop=acme.myshopify.com",
    );
  });

  it("is present on the error payload too, with the error code propagated", async () => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://calderyncompany.com");
    buildEngineSpy.mockRejectedValue(Object.assign(new Error("boom"), { code: "DOWN" }));
    const res = await loader(args());
    const payload = await toResponse(res).json();
    expect(payload.error?.code).toBe("DOWN");
    expect(payload.dashboardLoginUrl).toContain("/dashboard/login?shop=acme.myshopify.com");
  });
});
