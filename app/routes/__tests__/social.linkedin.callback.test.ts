// app/routes/__tests__/social.linkedin.callback.test.ts
//
// TDD: tests written BEFORE implementation.
// Tests the social.linkedin.callback loader (GET route, public, no authenticate.admin).
// Mocks: exchangeCode, fetchMemberUrn, saveConnection, verifyState.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { exchangeCode, fetchMemberUrn, saveConnection, verifyState } = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  fetchMemberUrn: vi.fn(),
  saveConnection: vi.fn(),
  verifyState: vi.fn(),
}));

vi.mock("~/lib/social/linkedin.server", () => ({ exchangeCode, fetchMemberUrn }));
vi.mock("~/lib/social/linkedin-connection.server", () => ({ saveConnection, verifyState }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function callbackRequest(params: Record<string, string>): Request {
  const url = new URL("https://app.test/social/linkedin/callback");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  return new Request(url.toString());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("social.linkedin.callback — loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.LINKEDIN_CLIENT_ID = "test-client-id";
    process.env.LINKEDIN_CLIENT_SECRET = "test-client-secret";
    process.env.SOCIAL_DIGEST_BASE_URL = "https://app.test";
  });

  afterEach(() => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;
    delete process.env.SOCIAL_DIGEST_BASE_URL;
  });

  it("renders a cancelled page when the error query param is present (user denied)", async () => {
    const { loader } = await import("../social.linkedin.callback");
    const res = await loader({
      request: callbackRequest({ error: "access_denied" }),
      params: {},
      context: {},
    });
    const text = await res.text();
    expect(text).toMatch(/cancel/i);
    // Should NOT have called exchangeCode
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("renders an invalid/expired page when verifyState returns null", async () => {
    verifyState.mockReturnValue(null);

    const { loader } = await import("../social.linkedin.callback");
    const res = await loader({
      request: callbackRequest({ code: "auth-code", state: "bad-state" }),
      params: {},
      context: {},
    });
    const text = await res.text();
    expect(text).toMatch(/invalid|expired/i);
    expect(exchangeCode).not.toHaveBeenCalled();
  });

  it("happy path: calls exchangeCode, fetchMemberUrn, saveConnection and renders success with memberUrn and owner", async () => {
    verifyState.mockReturnValue({ owner: "founder@example.com" });
    exchangeCode.mockResolvedValue({
      accessToken: "new-access-token",
      expiresInSec: 7200,
      refreshToken: "rt-xyz",
      refreshExpiresInSec: 31536000,
      scope: "openid profile w_member_social",
    });
    fetchMemberUrn.mockResolvedValue("urn:li:person:FOUNDER1");
    saveConnection.mockResolvedValue(undefined);

    const { loader } = await import("../social.linkedin.callback");
    const res = await loader({
      request: callbackRequest({ code: "valid-code", state: "good-state" }),
      params: {},
      context: {},
    });
    const text = await res.text();

    // exchangeCode called with correct args
    expect(exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "valid-code",
        clientId: "test-client-id",
        clientSecret: "test-client-secret",
        redirectUri: "https://app.test/social/linkedin/callback",
      }),
    );

    // fetchMemberUrn called with the access token
    expect(fetchMemberUrn).toHaveBeenCalledWith("new-access-token");

    // saveConnection called with tokens + memberUrn + ownerEmail
    expect(saveConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        memberUrn: "urn:li:person:FOUNDER1",
        ownerEmail: "founder@example.com",
        tokens: expect.objectContaining({ accessToken: "new-access-token" }),
      }),
    );

    // Success page renders the memberUrn and owner email
    expect(text).toMatch(/urn:li:person:FOUNDER1/);
    expect(text).toMatch(/founder@example\.com/);
    expect(text).toMatch(/connect/i);
  });

  it("renders an error page when exchangeCode throws (does not throw past the loader)", async () => {
    verifyState.mockReturnValue({ owner: "founder@example.com" });
    exchangeCode.mockRejectedValue(new Error("HTTP 401 — invalid_client"));

    const { loader } = await import("../social.linkedin.callback");

    // Must not throw — rule 12: surface failures, never throw past a route loader
    const res = await loader({
      request: callbackRequest({ code: "bad-code", state: "good-state" }),
      params: {},
      context: {},
    });
    const text = await res.text();
    // Generic message shown on page; real detail goes to server logs only
    expect(text).toMatch(/error|fail/i);
    expect(text).not.toMatch(/HTTP 401/i);
    expect(text).toMatch(/retry/i);
  });

  it("renders an error page when saveConnection throws (does not throw past the loader)", async () => {
    verifyState.mockReturnValue({ owner: "founder@example.com" });
    exchangeCode.mockResolvedValue({
      accessToken: "tok",
      expiresInSec: 3600,
    });
    fetchMemberUrn.mockResolvedValue("urn:li:person:P1");
    saveConnection.mockRejectedValue(new Error("DB write failed: unique constraint"));

    const { loader } = await import("../social.linkedin.callback");
    const res = await loader({
      request: callbackRequest({ code: "c", state: "s" }),
      params: {},
      context: {},
    });
    const text = await res.text();
    // Generic message shown on page; real detail goes to server logs only
    expect(text).toMatch(/error|fail/i);
    expect(text).not.toMatch(/DB write failed/i);
    expect(text).toMatch(/retry/i);
  });
});
