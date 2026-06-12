import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";
// vitest hoists the vi.mock() calls below above this import, so the route module
// loads with every boundary already mocked.
import { loader } from "../app._index";

const { listAlertsSpy } = vi.hoisted(() => ({
  listAlertsSpy: vi.fn(),
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
vi.mock("~/components/calderyn", () => ({
  AlertCard: () => null,
  AmbientAlertBanner: () => null,
  GuardrailMeter: () => null,
  Icon: () => null,
  StatTile: () => null,
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    alerts: { list: (...a: unknown[]) => listAlertsSpy(...a) },
    audit: { list: async () => [] },
    campaigns: { list: async () => [] },
    guardrails: { get: async () => null },
    onboarding: { getState: async () => ({ done: true }) },
  }),
}));

function args(): LoaderFunctionArgs {
  return {
    request: new Request("https://app.example.com/app"),
    params: {},
    context: {},
  } as LoaderFunctionArgs;
}

describe("app._index loader dashboardLoginUrl", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    listAlertsSpy.mockReset();
  });

  it("points at the public dashboard login for the session shop", async () => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://calderyncompany.com");
    listAlertsSpy.mockResolvedValue([]);
    const res = await loader(args());
    const payload = await (res as Response).json();
    expect(payload.dashboardLoginUrl).toBe(
      "https://calderyncompany.com/dashboard/login?shop=acme.myshopify.com",
    );
  });

  it("is present on the error payload too", async () => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://calderyncompany.com");
    listAlertsSpy.mockRejectedValue(Object.assign(new Error("boom"), { code: "DOWN" }));
    const res = await loader(args());
    const payload = await (res as Response).json();
    expect(payload.error?.code).toBe("DOWN");
    expect(payload.dashboardLoginUrl).toContain("/dashboard/login?shop=acme.myshopify.com");
  });
});
