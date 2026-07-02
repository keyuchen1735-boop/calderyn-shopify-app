// app/routes/__tests__/dashboard-connect.test.ts
//
// Dashboard parity for the embedded /app/connect consent. Same invariant: the
// auth code is issued for the authenticated dashboard session's shop, NEVER for
// any shop carried inside the signed token.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type * as McpOauth from "../../lib/mcp_oauth.server";
import type * as SessionMod from "../../lib/dashboard/session.server";
import type * as HttpMod from "../../lib/dashboard/http.server";

const getSessionFromRequest = vi.fn();
const requireDashboardSession = vi.fn();
const requireSameOrigin = vi.fn();

vi.mock("../../lib/dashboard/session.server", async (importOriginal) => ({
  ...(await importOriginal<typeof SessionMod>()),
  getSessionFromRequest: (...a: unknown[]) => getSessionFromRequest(...a),
  requireDashboardSession: (...a: unknown[]) => requireDashboardSession(...a),
}));
vi.mock("../../lib/dashboard/http.server", async (importOriginal) => ({
  ...(await importOriginal<typeof HttpMod>()),
  requireSameOrigin: (...a: unknown[]) => requireSameOrigin(...a),
}));
vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof McpOauth>();
  return {
    ...actual,
    getClient: vi.fn(),
    verifyPendingOauth: vi.fn(),
    issueAuthCode: vi.fn().mockResolvedValue("calc_test_code"),
  };
});

// eslint-disable-next-line import/first
import { getClient, verifyPendingOauth, issueAuthCode } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first
import { loader, action } from "../dashboard.connect";

const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;
const verifyMock = verifyPendingOauth as unknown as ReturnType<typeof vi.fn>;
const issueMock = issueAuthCode as unknown as ReturnType<typeof vi.fn>;

const TOKEN = "signed.jwt.token";

function ctxFixture(overrides: Partial<McpOauth.PendingOauthCtx> = {}): McpOauth.PendingOauthCtx {
  // No shop in the token — issuance binds to the dashboard session's shop.
  return {
    client_id: "cal_client_x",
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "ch",
    scope: "read",
    state: "abc",
    ...overrides,
  };
}

function clientFixture() {
  return {
    client_id: "cal_client_x",
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
    token_endpoint_auth_method: "none",
  };
}

function loaderReq(token: string | null): { request: Request } {
  const url = new URL("http://x/dashboard/connect");
  if (token !== null) url.searchParams.set("t", token);
  return { request: new Request(url.toString()) };
}

function actionReq(fields: Record<string, string>): { request: Request } {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return { request: new Request("http://x/dashboard/connect", { method: "POST", body: form }) };
}

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  getSessionFromRequest.mockReset();
  requireDashboardSession.mockReset();
  requireSameOrigin.mockReset();
  getClientMock.mockReset();
  verifyMock.mockReset();
  issueMock.mockReset().mockResolvedValue("calc_test_code");
  getSessionFromRequest.mockResolvedValue({
    shopId: "session-shop-uuid",
    shopDomain: "myshop.myshopify.com",
    sessionId: "sess-1",
  });
  requireDashboardSession.mockResolvedValue({
    shopId: "session-shop-uuid",
    shopDomain: "myshop.myshopify.com",
    sessionId: "sess-1",
  });
});

describe("/dashboard/connect loader", () => {
  it("404s when the flag is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(404);
  });

  it("redirects to login, preserving the connect URL, when unauthenticated", async () => {
    getSessionFromRequest.mockResolvedValue(null);
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toContain("/dashboard/login");
    expect(loc).toContain("return_to=");
    // The token must survive the round-trip through login.
    expect(decodeURIComponent(loc)).toContain(`/dashboard/connect?t=${TOKEN}`);
  });

  it("redirects to /dashboard on an invalid token", async () => {
    verifyMock.mockRejectedValue(new Error("bad"));
    const r = toResponse(await loader(loaderReq("garbage") as never));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/dashboard");
  });

  it("renders consent data for a valid token + dashboard session", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    getClientMock.mockResolvedValue(clientFixture());
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.destinationHost).toBe("claude.ai");
    expect(j.scopes).toEqual(["read"]);
    expect(j.token).toBe(TOKEN);
  });
});

describe("/dashboard/connect action", () => {
  it("Allow issues a code bound to the dashboard SESSION shop, then 302s to the client", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    const r = toResponse(await action(actionReq({ intent: "allow", t: TOKEN }) as never));
    expect(requireSameOrigin).toHaveBeenCalledOnce();
    expect(issueMock).toHaveBeenCalledOnce();
    expect(issueMock.mock.calls[0][0]).toMatchObject({ shop_id: "session-shop-uuid" });
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(loc).toContain("code=calc_test_code");
    expect(loc).toContain("state=abc");
  });

  it("Deny 302s to the client with access_denied and issues no code", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    const r = toResponse(await action(actionReq({ intent: "deny", t: TOKEN }) as never));
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("error=access_denied");
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid token", async () => {
    verifyMock.mockRejectedValue(new Error("bad"));
    const r = toResponse(await action(actionReq({ intent: "allow", t: "garbage" }) as never));
    expect(r.status).toBe(400);
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("400s on an unrecognized intent", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    const r = toResponse(await action(actionReq({ intent: "sideways", t: TOKEN }) as never));
    expect(r.status).toBe(400);
    expect(issueMock).not.toHaveBeenCalled();
  });
});
