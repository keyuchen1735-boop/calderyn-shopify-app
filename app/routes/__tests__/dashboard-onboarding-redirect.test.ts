import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { loader } from "../app._index";

// Spies for the calderyn client + OAuth-handoff boundaries; the real loader
// control flow runs against them.
const {
  alertsListSpy,
  auditListSpy,
  campaignsListSpy,
  guardrailsGetSpy,
  getStateSpy,
} = vi.hoisted(() => ({
  alertsListSpy: vi.fn(),
  auditListSpy: vi.fn(),
  campaignsListSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
  getStateSpy: vi.fn(),
}));

// Importing the route module pulls its UI imports; stub them so no real UI lib
// or React-hook module is evaluated during a loader-only test.
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
    Tooltip: Stub,
  };
});
vi.mock("~/components/calderyn", () => {
  const Stub = () => null;
  return {
    AlertCard: Stub,
    AmbientAlertBanner: Stub,
    GuardrailMeter: Stub,
    Icon: Stub,
    StatTile: Stub,
  };
});
vi.mock("../../lib/embedded-nav", () => ({
  useEmbeddedNavigate: () => () => {},
  rememberEmbeddedParams: () => {},
  appendEmbeddedSearch: (to: string) => to,
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: async () => ({ session: { shop: "acme.myshopify.com" } }) },
}));

vi.mock("~/lib/calderyn.server", () => ({
  calderynClient: () => ({
    alerts: { list: (...a: unknown[]) => alertsListSpy(...a) },
    audit: { list: (...a: unknown[]) => auditListSpy(...a) },
    campaigns: { list: (...a: unknown[]) => campaignsListSpy(...a) },
    guardrails: { get: (...a: unknown[]) => guardrailsGetSpy(...a) },
    onboarding: { getState: (...a: unknown[]) => getStateSpy(...a) },
    calibration: { get: vi.fn().mockResolvedValue({ pct: null, updated_at: null }) },
  }),
}));

// app._index's loader now also fetches peer benchmarks; stub it so this
// loader-only test doesn't hit the real Supabase client.
vi.mock("~/lib/benchmarks/peer-benchmarks.server", () => ({
  getPeerBenchmarks: async () => ({
    niche: "cat:uncategorized",
    consented: false,
    kpis: [],
  }),
}));

function callLoader(url = "http://localhost/app?shop=acme.myshopify.com&host=abc&embedded=1") {
  return loader({ request: new Request(url) } as unknown as LoaderFunctionArgs);
}

beforeEach(() => {
  for (const spy of [alertsListSpy, auditListSpy, campaignsListSpy, guardrailsGetSpy, getStateSpy]) {
    spy.mockReset();
    spy.mockResolvedValue([]);
  }
  guardrailsGetSpy.mockResolvedValue(null);
});

describe("dashboard loader — onboarding redirect (no client-side flash)", () => {
  it("redirects a not-yet-onboarded merchant to /app/onboarding, server-side, before rendering", async () => {
    getStateSpy.mockResolvedValue({ step: 1, done: false });

    // The redirect is a thrown Response — capture it.
    const thrown = await callLoader().then(
      () => null,
      (e) => e,
    );

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    // shop/host/embedded must survive so the embedded document request re-auths.
    expect((thrown as Response).headers.get("Location")).toBe(
      "/app/onboarding?shop=acme.myshopify.com&host=abc&embedded=1",
    );
  });

  it("renders the dashboard (no redirect) once onboarding is done", async () => {
    getStateSpy.mockResolvedValue({ step: 7, done: true });

    const res = await callLoader();
    const body = (await (res as Response).json()) as Record<string, unknown>;

    expect((res as Response).status).toBe(200);
    expect(body.error).toBeNull();
    expect(body).not.toHaveProperty("onboardingDone");
  });

  it("redirects to onboarding when onboarding state is unreadable (e.g. shop not provisioned yet)", async () => {
    // An unreadable state almost always means the shops row isn't provisioned;
    // route to onboarding (which provisions defensively) instead of rendering a
    // broken dashboard with an error banner.
    getStateSpy.mockRejectedValue(
      Object.assign(new Error("Shop not found in Supabase"), { code: "ERROR", status: 500 }),
    );

    const thrown = await callLoader().then(
      () => null,
      (e) => e,
    );

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(
      "/app/onboarding?shop=acme.myshopify.com&host=abc&embedded=1",
    );
  });

  it("fails soft (error banner) when onboarding is done but dashboard data fails to load", async () => {
    // Once onboarding is confirmed complete, a transient data error must NOT
    // bounce the merchant back to the wizard — render the dashboard with its
    // error banner instead.
    getStateSpy.mockResolvedValue({ step: 8, done: true });
    alertsListSpy.mockRejectedValue(
      Object.assign(new Error("alerts query failed"), { code: "ERROR", status: 500 }),
    );

    const res = (await callLoader()) as Response;
    const body = (await res.json()) as { error: { message: string } | null };

    expect(res.status).toBe(200);
    expect(body.error).toEqual({ code: "ERROR", message: "alerts query failed" });
  });
});
