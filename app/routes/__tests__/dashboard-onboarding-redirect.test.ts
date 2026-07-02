import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type { LoaderFunctionArgs } from "react-router";
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
    expect(toResponse(thrown).status).toBe(302);
    // shop/host/embedded must survive so the embedded document request re-auths.
    expect(toResponse(thrown).headers.get("Location")).toBe(
      "/app/onboarding?shop=acme.myshopify.com&host=abc&embedded=1",
    );
  });

  it("renders the dashboard (no redirect) once onboarding is done", async () => {
    getStateSpy.mockResolvedValue({ step: 7, done: true });

    const res = await callLoader();
    const body = (await toResponse(res).json()) as Record<string, unknown>;

    expect(toResponse(res).status).toBe(200);
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
    expect(toResponse(thrown).status).toBe(302);
    expect(toResponse(thrown).headers.get("Location")).toBe(
      "/app/onboarding?shop=acme.myshopify.com&host=abc&embedded=1",
    );
  });

  it("fails soft (error banner) when onboarding is done but dashboard data fails to load", async () => {
    // Once onboarding is confirmed complete, a transient data error must NOT
    // bounce the merchant back to the wizard — render the dashboard with its
    // error banner instead.
    getStateSpy.mockResolvedValue({ step: 8, done: true });
    // The home is now the Live Engine; a transient failure in any data the
    // loader pulls (here: guardrails, which backs autopilot-on-load) must render
    // the page with its error banner, not bounce the merchant to the wizard.
    guardrailsGetSpy.mockRejectedValue(
      Object.assign(new Error("guardrails query failed"), { code: "ERROR", status: 500 }),
    );

    const res = toResponse(await callLoader());
    const body = (await res.json()) as { error: { message: string } | null };

    expect(res.status).toBe(200);
    expect(body.error).toEqual({ code: "ERROR", message: "guardrails query failed" });
  });
});
