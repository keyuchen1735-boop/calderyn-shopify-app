import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as HttpMod from "~/lib/dashboard/http.server";

// ---------------------------------------------------------------------------
// Mocks: all declared before any module import so vi.mock hoisting works
// ---------------------------------------------------------------------------

vi.mock("~/lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpMod>()),
  rateLimit: vi.fn().mockResolvedValue(true),
  clientIpKey: () => "k",
  requireSameOrigin: vi.fn(),
  checkSameOrigin: vi.fn(() => null),
  wantsJson: (req: Request) => (req.headers.get("Accept") ?? "").includes("application/json"),
  jsonError: (s: number, e: string) => new Response(JSON.stringify({ error: e }), { status: s }),
}));

const mockBuildSigninAuthUrl = vi.fn().mockReturnValue("https://accounts.google.com/o/oauth2/v2/auth?client_id=cid&state=testnonce");
const mockExchangeCodeForIdToken = vi.fn();
const mockVerifyIdToken = vi.fn();
vi.mock("~/lib/auth/google-signin.server", () => ({
  buildSigninAuthUrl: (...args: unknown[]) => mockBuildSigninAuthUrl(...args),
  exchangeCodeForIdToken: (...args: unknown[]) => mockExchangeCodeForIdToken(...args),
  verifyIdToken: (...args: unknown[]) => mockVerifyIdToken(...args),
}));

const mockSignGoogleSignup = vi.fn().mockReturnValue("signed.token");
const mockVerifyGoogleSignup = vi.fn();
vi.mock("~/lib/auth/google-signup-token.server", () => ({
  signGoogleSignup: (...args: unknown[]) => mockSignGoogleSignup(...args),
  verifyGoogleSignup: (...args: unknown[]) => mockVerifyGoogleSignup(...args),
}));

const mockFindUserByGoogleSub = vi.fn();
const mockFindUserByEmail = vi.fn();
const mockSetGoogleSub = vi.fn().mockResolvedValue(undefined);
const mockCreateGoogleUser = vi.fn();
const mockDeleteUser = vi.fn().mockResolvedValue(undefined);
vi.mock("~/lib/auth/users.server", () => ({
  findUserByGoogleSub: (...args: unknown[]) => mockFindUserByGoogleSub(...args),
  findUserByEmail: (...args: unknown[]) => mockFindUserByEmail(...args),
  setGoogleSub: (...args: unknown[]) => mockSetGoogleSub(...args),
  createGoogleUser: (...args: unknown[]) => mockCreateGoogleUser(...args),
  deleteUser: (...args: unknown[]) => mockDeleteUser(...args),
}));

const mockProvisionOwnedShop = vi.fn().mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" });
const mockLinkMembership = vi.fn().mockResolvedValue(undefined);
const mockResolveShopForUser = vi.fn();
vi.mock("~/lib/auth/tenant.server", () => ({
  provisionOwnedShop: (...args: unknown[]) => mockProvisionOwnedShop(...args),
  linkMembership: (...args: unknown[]) => mockLinkMembership(...args),
  resolveShopForUser: (...args: unknown[]) => mockResolveShopForUser(...args),
}));

const mockCreateSessionForUser = vi.fn().mockResolvedValue({ raw: "dash_live_abc" });
vi.mock("~/lib/dashboard/session.server", () => ({
  createSessionForUser: (...args: unknown[]) => mockCreateSessionForUser(...args),
  sessionCookieHeader: () => "__Host-calderyn_dash=dash_live_abc; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax",
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a GET request to the callback route with optional cookie header. */
function callbackRequest(params: Record<string, string>, cookieNonce?: string) {
  const url = new URL("https://app.calderyncompany.com/dashboard/auth/google/callback");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (cookieNonce !== undefined) {
    headers["Cookie"] = `__Host-calderyn_goauth=${cookieNonce}`;
  }
  return new Request(url.toString(), { headers });
}

/** Build a POST form request for the store route (JSON contract variant). */
function storePost(fields: Record<string, string>) {
  return new Request("https://app.calderyncompany.com/dashboard/auth/google/store", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "https://app.calderyncompany.com",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields).toString(),
  });
}

beforeEach(() => {
  vi.resetModules();
  mockFindUserByGoogleSub.mockReset();
  mockFindUserByEmail.mockReset();
  mockSetGoogleSub.mockReset().mockResolvedValue(undefined);
  mockCreateGoogleUser.mockReset();
  mockDeleteUser.mockReset().mockResolvedValue(undefined);
  mockResolveShopForUser.mockReset();
  mockProvisionOwnedShop.mockReset().mockResolvedValue({ shopId: "shop1", orgSlug: "acme-x" });
  mockLinkMembership.mockReset().mockResolvedValue(undefined);
  mockCreateSessionForUser.mockReset().mockResolvedValue({ raw: "dash_live_abc" });
  mockVerifyGoogleSignup.mockReset();
  mockExchangeCodeForIdToken.mockReset();
  mockVerifyIdToken.mockReset();
});

// ---------------------------------------------------------------------------
// Start route (dashboard.auth.google)
// ---------------------------------------------------------------------------

describe("google start loader", () => {
  it("redirects to /dashboard/signin?error=google_unavailable when GOOGLE_SIGNIN_CLIENT_ID is unset", async () => {
    const saved = process.env.GOOGLE_SIGNIN_CLIENT_ID;
    delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
    try {
      const { loader } = await import("../dashboard.auth.google");
      const res = await loader({ request: new Request("https://app.calderyncompany.com/dashboard/auth/google"), params: {}, context: {} } as never);
      expect((res as Response).status).toBe(302);
      expect((res as Response).headers.get("Location")).toContain("google_unavailable");
    } finally {
      if (saved !== undefined) process.env.GOOGLE_SIGNIN_CLIENT_ID = saved;
    }
  });

  it("redirects to Google and sets the goauth cookie when GOOGLE_SIGNIN_CLIENT_ID is set", async () => {
    process.env.GOOGLE_SIGNIN_CLIENT_ID = "test-client-id";
    process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
    try {
      const { loader } = await import("../dashboard.auth.google");
      const res = await loader({ request: new Request("https://app.calderyncompany.com/dashboard/auth/google"), params: {}, context: {} } as never);
      expect((res as Response).status).toBe(302);
      expect((res as Response).headers.get("Location")).toContain("accounts.google.com");
      expect((res as Response).headers.get("Set-Cookie")).toContain("__Host-calderyn_goauth=");
    } finally {
      delete process.env.GOOGLE_SIGNIN_CLIENT_ID;
    }
  });
});

// ---------------------------------------------------------------------------
// Callback route (dashboard.auth.google.callback)
// ---------------------------------------------------------------------------

describe("google callback loader", () => {
  describe("CSRF state mismatch", () => {
    it("redirects to /dashboard/signin?error=google_oauth_failed when state does not match cookie", async () => {
      // state=wrongnonce, cookie=correctnonce - mismatch must be rejected without
      // touching any OAuth or user-lookup code.
      const { loader } = await import("../dashboard.auth.google.callback");
      const req = callbackRequest(
        { code: "authcode", state: "wrongnonce" },
        "correctnonce",
      );
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/dashboard/signin?error=google_oauth_failed");
      // Confirm we never called the OAuth libraries
      expect(mockExchangeCodeForIdToken).not.toHaveBeenCalled();
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
      // Cookie must be cleared
      const setCookie = res.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain("__Host-calderyn_goauth=");
      expect(setCookie).toContain("Max-Age=0");
    });

    it("redirects to /dashboard/signin?error=google_oauth_failed when goauth cookie is absent", async () => {
      const { loader } = await import("../dashboard.auth.google.callback");
      // No cookie at all
      const req = callbackRequest({ code: "authcode", state: "somenonce" });
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("google_oauth_failed");
      expect(mockExchangeCodeForIdToken).not.toHaveBeenCalled();
    });
  });

  describe("unverified email", () => {
    it("redirects to /dashboard/signin?error=google_unverified_email when emailVerified is false", async () => {
      const nonce = "testnonce123";
      mockExchangeCodeForIdToken.mockResolvedValue("id_token_value");
      mockVerifyIdToken.mockResolvedValue({ sub: "google-sub", email: "user@example.com", emailVerified: false });

      const { loader } = await import("../dashboard.auth.google.callback");
      const req = callbackRequest({ code: "authcode", state: nonce }, nonce);
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("google_unverified_email");
      // Cookie must be cleared
      const setCookie = res.headers.get("Set-Cookie") ?? "";
      expect(setCookie).toContain("Max-Age=0");
      // No user should have been looked up or created
      expect(mockFindUserByGoogleSub).not.toHaveBeenCalled();
    });
  });

  describe("known user with shop (path 1)", () => {
    it("creates a session and redirects to /dashboard", async () => {
      const nonce = "testnonce";
      mockExchangeCodeForIdToken.mockResolvedValue("id_token_value");
      mockVerifyIdToken.mockResolvedValue({ sub: "gsub", email: "u@e.com", emailVerified: true });
      mockFindUserByGoogleSub.mockResolvedValue({ id: "u1", shopId: "shop1" });

      const { loader } = await import("../dashboard.auth.google.callback");
      const req = callbackRequest({ code: "code", state: nonce }, nonce);
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie") ?? ""];
      const joined = cookies.join("; ");
      expect(joined).toContain("__Host-calderyn_dash=");
    });

    it("honours a validated return_to carried in the goauth cookie", async () => {
      const nonce = "testnonce";
      mockExchangeCodeForIdToken.mockResolvedValue("id_token_value");
      mockVerifyIdToken.mockResolvedValue({ sub: "gsub", email: "u@e.com", emailVerified: true });
      mockFindUserByGoogleSub.mockResolvedValue({ id: "u1", shopId: "shop1" });

      const { loader } = await import("../dashboard.auth.google.callback");
      // Cookie format is `nonce:enc(returnTo)` — see dashboard.auth.google.
      const req = callbackRequest(
        { code: "code", state: nonce },
        `${nonce}:${encodeURIComponent("/dashboard/connect?t=abc")}`,
      );
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard/connect?t=abc");
    });
  });

  describe("email-link user (path 2)", () => {
    it("links Google sub, creates a session, and redirects to /dashboard", async () => {
      const nonce = "testnonce";
      mockExchangeCodeForIdToken.mockResolvedValue("id_token_value");
      mockVerifyIdToken.mockResolvedValue({ sub: "gsub", email: "existing@e.com", emailVerified: true });
      mockFindUserByGoogleSub.mockResolvedValue(null);
      mockFindUserByEmail.mockResolvedValue({ id: "u-existing", email: "existing@e.com" });
      mockResolveShopForUser.mockResolvedValue("shop-existing");

      const { loader } = await import("../dashboard.auth.google.callback");
      const req = callbackRequest({ code: "code", state: nonce }, nonce);
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/dashboard");
      expect(mockSetGoogleSub).toHaveBeenCalledWith("u-existing", "gsub");
      expect(mockCreateSessionForUser).toHaveBeenCalledWith("u-existing", "shop-existing");
      const cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get("Set-Cookie") ?? ""];
      const joined = cookies.join("; ");
      expect(joined).toContain("__Host-calderyn_dash=");
    });
  });

  describe("new user (path 3)", () => {
    it("redirects to /dashboard/auth/google/store with a signed token", async () => {
      const nonce = "testnonce";
      mockExchangeCodeForIdToken.mockResolvedValue("id_token_value");
      mockVerifyIdToken.mockResolvedValue({ sub: "gsub", email: "new@e.com", emailVerified: true });
      mockFindUserByGoogleSub.mockResolvedValue(null);
      mockFindUserByEmail.mockResolvedValue(null);
      mockSignGoogleSignup.mockReturnValue("signed.tok");

      const { loader } = await import("../dashboard.auth.google.callback");
      const req = callbackRequest({ code: "code", state: nonce }, nonce);
      const res = (await loader({ request: req, params: {}, context: {} } as never)) as Response;
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toContain("/dashboard/auth/google/store?t=");
    });
  });
});

// ---------------------------------------------------------------------------
// Store route (dashboard.auth.google.store)
// ---------------------------------------------------------------------------

describe("google store action", () => {
  it("returns 400 when the signup token is invalid or missing", async () => {
    mockVerifyGoogleSignup.mockReturnValue(null);
    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: storePost({ t: "bad.token", store: "My Shop" }), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_or_expired_token" });
  });

  it("returns 422 when the store name is missing", async () => {
    mockVerifyGoogleSignup.mockReturnValue({ sub: "gsub", email: "u@e.com" });
    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: storePost({ t: "valid.token", store: "" }), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "missing_store" });
  });

  it("creates user+shop+membership+session and redirects to /dashboard on success", async () => {
    mockVerifyGoogleSignup.mockReturnValue({ sub: "gsub", email: "u@e.com" });
    mockCreateGoogleUser.mockResolvedValue({ id: "u1" });

    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({ request: storePost({ t: "valid.token", store: "Acme Store" }), params: {}, context: {} } as never)) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
    expect(res.headers.get("Set-Cookie")).toContain("__Host-calderyn_dash=");
    expect(mockCreateGoogleUser).toHaveBeenCalledWith("u@e.com", "gsub");
    expect(mockProvisionOwnedShop).toHaveBeenCalledWith("Acme Store");
    expect(mockLinkMembership).toHaveBeenCalledWith("u1", "shop1", "owner");
  });

  it("deletes the created user and returns a retryable error when provisionOwnedShop fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockVerifyGoogleSignup.mockReturnValue({ sub: "gsub", email: "u@e.com" });
    mockCreateGoogleUser.mockResolvedValue({ id: "u2" });
    mockProvisionOwnedShop.mockRejectedValue(new Error("shop insert failed"));

    const { action } = await import("../dashboard.auth.google.store");
    const res = (await action({
      request: storePost({ t: "valid.token", store: "Acme" }),
      params: {},
      context: {},
    } as never)) as Response;
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: "account_creation_failed" });
    expect(mockDeleteUser).toHaveBeenCalledWith("u2");
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
