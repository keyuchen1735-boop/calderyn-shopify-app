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
  getPendingOauthSpy,
} = vi.hoisted(() => ({
  alertsListSpy: vi.fn(),
  auditListSpy: vi.fn(),
  campaignsListSpy: vi.fn(),
  guardrailsGetSpy: vi.fn(),
  getStateSpy: vi.fn(),
  getPendingOauthSpy: vi.fn(),
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
  }),
}));

vi.mock("~/lib/mcp_oauth.server", () => ({
  PENDING_COOKIE_NAME: "cdn_pending_oauth",
  getPendingOauth: (...a: unknown[]) => getPendingOauthSpy(...a),
  verifyPendingOauth: vi.fn(),
  signConsentAuth: vi.fn(),
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
  getPendingOauthSpy.mockReset();
  getPendingOauthSpy.mockResolvedValue(null);
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

  it("does NOT redirect to onboarding on a data-load error — renders the dashboard with its error banner", async () => {
    // A getState failure must not bounce into onboarding (which could itself be
    // failing); the dashboard renders soft with the error instead.
    getStateSpy.mockRejectedValue(
      Object.assign(new Error("shops lookup failed"), { code: "ERROR", status: 500 }),
    );

    const res = await callLoader();
    const body = (await (res as Response).json()) as { error: { message: string } | null };

    expect((res as Response).status).toBe(200);
    expect(body.error).toEqual({ code: "ERROR", message: "shops lookup failed" });
  });

  it("lets the Claude.ai pending-OAuth handoff take priority over the onboarding redirect", async () => {
    getPendingOauthSpy.mockResolvedValue({ shop: "acme.myshopify.com" });
    getStateSpy.mockResolvedValue({ step: 1, done: false });

    // The handoff RETURNS its redirect (vs. the onboarding path which throws),
    // so it resolves rather than rejects.
    const res = (await callLoader()) as Response;

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/oauth/consent");
    // Onboarding state is never consulted when a handoff is pending.
    expect(getStateSpy).not.toHaveBeenCalled();
  });
});
