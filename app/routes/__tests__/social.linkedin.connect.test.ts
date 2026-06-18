// app/routes/__tests__/social.linkedin.connect.test.ts
//
// Tests the social.linkedin.connect loader (GET route, public, no authenticate.admin).
// Mocks: getAuthorizeUrl (linkedin.server), signState (linkedin-connection.server).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { getAuthorizeUrl, signState } = vi.hoisted(() => ({
  getAuthorizeUrl: vi.fn(),
  signState: vi.fn(),
}));

vi.mock("~/lib/social/linkedin.server", () => ({ getAuthorizeUrl }));
vi.mock("~/lib/social/linkedin-connection.server", () => ({ signState }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connectRequest(params: Record<string, string>): Request {
  const url = new URL("https://app.test/social/linkedin/connect");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("social.linkedin.connect — loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: CRON_SECRET set, LINKEDIN_CLIENT_ID set
    process.env.LINKEDIN_SETUP_KEY = "test-setup-key-abc";
    process.env.LINKEDIN_CLIENT_ID = "test-client-id";
    process.env.SOCIAL_DIGEST_BASE_URL = "https://app.test";
    // Default stubs
    signState.mockReturnValue("signed-state-value");
    getAuthorizeUrl.mockReturnValue("https://linkedin.com/oauth/authorize?client_id=test");
  });

  afterEach(() => {
    delete process.env.LINKEDIN_SETUP_KEY;
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.SOCIAL_DIGEST_BASE_URL;
  });

  // -------------------------------------------------------------------------
  // Auth gate
  // -------------------------------------------------------------------------

  it("returns 401 JSON when ?key is missing", async () => {
    const { loader } = await import("../social.linkedin.connect");
    const res = await loader({
      request: connectRequest({}),
      params: {},
      context: {},
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    expect(getAuthorizeUrl).not.toHaveBeenCalled();
    expect(signState).not.toHaveBeenCalled();
  });

  it("returns 401 JSON when ?key is wrong", async () => {
    const { loader } = await import("../social.linkedin.connect");
    const res = await loader({
      request: connectRequest({ key: "wrong-secret" }),
      params: {},
      context: {},
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    expect(getAuthorizeUrl).not.toHaveBeenCalled();
    expect(signState).not.toHaveBeenCalled();
  });

  it("returns 401 JSON when LINKEDIN_SETUP_KEY is unset (even with a ?key present)", async () => {
    delete process.env.LINKEDIN_SETUP_KEY;
    const { loader } = await import("../social.linkedin.connect");
    const res = await loader({
      request: connectRequest({ key: "any-value" }),
      params: {},
      context: {},
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "unauthorized" });
    expect(getAuthorizeUrl).not.toHaveBeenCalled();
    expect(signState).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Happy path — valid key + LINKEDIN_CLIENT_ID set
  // -------------------------------------------------------------------------

  it("redirects to the LinkedIn authorize URL when key is valid and LINKEDIN_CLIENT_ID is set", async () => {
    const { loader } = await import("../social.linkedin.connect");
    const res = await loader({
      request: connectRequest({ key: "test-setup-key-abc" }),
      params: {},
      context: {},
    });

    // Remix redirect() returns a 302 Response with a Location header
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(
      "https://linkedin.com/oauth/authorize?client_id=test",
    );
    expect(signState).toHaveBeenCalledTimes(1);
    expect(getAuthorizeUrl).toHaveBeenCalledTimes(1);
    expect(getAuthorizeUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: "test-client-id",
        state: "signed-state-value",
        redirectUri: "https://app.test/social/linkedin/callback",
      }),
    );
  });

  // -------------------------------------------------------------------------
  // Missing LINKEDIN_CLIENT_ID — renders info page (200, no redirect)
  // -------------------------------------------------------------------------

  it("renders a 200 info page when LINKEDIN_CLIENT_ID is missing (does not crash or redirect)", async () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    const { loader } = await import("../social.linkedin.connect");
    const res = await loader({
      request: connectRequest({ key: "test-setup-key-abc" }),
      params: {},
      context: {},
    });

    expect(res.status).toBe(200);
    // Must not have redirected
    expect(res.headers.get("Location")).toBeNull();
    const text = await res.text();
    expect(text).toMatch(/LINKEDIN_CLIENT_ID/i);
    // signState and getAuthorizeUrl must not be called when client ID is absent
    expect(signState).not.toHaveBeenCalled();
    expect(getAuthorizeUrl).not.toHaveBeenCalled();
  });
});
