// app/routes/__tests__/app-connect.test.ts
//
// /app/connect is the embedded, authenticated consent screen that closes the
// OAuth pre-seed High. The approving shop comes from authenticate.admin's
// session — NEVER from the signed token — so a merchant can only ever consent
// for their own shop. These tests pin that invariant.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { toResponse } from "../../lib/__tests__/_route-test-helpers";
import type * as McpOauth from "../../lib/mcp_oauth.server";

vi.mock("@shopify/polaris", () => {
  const Stub = () => null;
  return {
    AppProvider: Stub,
    Banner: Stub,
    BlockStack: Stub,
    Button: Stub,
    ButtonGroup: Stub,
    Card: Stub,
    Page: Stub,
    Text: Stub,
  };
});
vi.mock("@shopify/polaris/build/esm/styles.css?url", () => ({ default: "" }));
vi.mock("@shopify/polaris/locales/en.json", () => ({ default: {} }));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: vi.fn() },
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

vi.mock("../../lib/supabase.server", () => ({
  resolveShopId: vi.fn(),
}));

// eslint-disable-next-line import/first
import { authenticate } from "../../shopify.server";
// eslint-disable-next-line import/first
import { getClient, verifyPendingOauth, issueAuthCode } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first
import { resolveShopId } from "../../lib/supabase.server";
// eslint-disable-next-line import/first
import { loader, action } from "../app.connect";

const SHOP = "myshop.myshopify.com";
const TOKEN = "signed.jwt.token";

const adminMock = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;
const verifyMock = verifyPendingOauth as unknown as ReturnType<typeof vi.fn>;
const issueMock = issueAuthCode as unknown as ReturnType<typeof vi.fn>;
const resolveMock = resolveShopId as unknown as ReturnType<typeof vi.fn>;

function ctxFixture(overrides: Partial<McpOauth.PendingOauthCtx> = {}): McpOauth.PendingOauthCtx {
  // The token deliberately carries NO shop — issuance binds to the authenticated
  // session shop, which is what closes the pre-seed High.
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

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  adminMock.mockReset();
  getClientMock.mockReset();
  verifyMock.mockReset();
  issueMock.mockReset().mockResolvedValue("calc_test_code");
  resolveMock.mockReset();
  adminMock.mockResolvedValue({ session: { shop: SHOP } });
});

function loaderReq(token: string | null): { request: Request } {
  const url = new URL("http://x/app/connect");
  if (token !== null) url.searchParams.set("t", token);
  return { request: new Request(url.toString()) };
}

function actionReq(fields: Record<string, string>): { request: Request } {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return { request: new Request("http://x/app/connect", { method: "POST", body: form }) };
}

describe("/app/connect loader", () => {
  it("404s when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(404);
  });

  it("redirects to /app on an invalid/expired token", async () => {
    verifyMock.mockRejectedValue(new Error("bad jwt"));
    const r = toResponse(await loader(loaderReq("garbage") as never));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("redirects to /app when the client is unknown", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    getClientMock.mockResolvedValue(null);
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("renders consent data for a valid token + authenticated shop", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    getClientMock.mockResolvedValue(clientFixture());
    const r = toResponse(await loader(loaderReq(TOKEN) as never));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.destinationHost).toBe("claude.ai");
    expect(j.scopes).toEqual(["read"]);
    expect(j.token).toBe(TOKEN);
    expect(adminMock).toHaveBeenCalledOnce();
  });
});

describe("/app/connect action", () => {
  it("Allow issues a code bound to the SESSION shop", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    resolveMock.mockResolvedValue("session-shop-uuid");
    const r = toResponse(await action(actionReq({ intent: "allow", t: TOKEN }) as never));
    expect(r.status).toBe(200);
    // The shop_id passed to issueAuthCode must come from session.shop (SHOP),
    // never from the token's embedded shop field.
    expect(resolveMock).toHaveBeenCalledWith(SHOP);
    expect(issueMock).toHaveBeenCalledOnce();
    expect(issueMock.mock.calls[0][0]).toMatchObject({ shop_id: "session-shop-uuid" });
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(j.redirect_url ?? "").toContain("code=calc_test_code");
    expect(j.redirect_url ?? "").toContain("state=abc");
  });

  it("Deny returns an access_denied redirect and issues no code", async () => {
    verifyMock.mockResolvedValue(ctxFixture());
    const r = toResponse(await action(actionReq({ intent: "deny", t: TOKEN }) as never));
    expect(r.status).toBe(200);
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toContain("error=access_denied");
    expect(j.redirect_url ?? "").toContain("state=abc");
    expect(issueMock).not.toHaveBeenCalled();
  });

  it("400s on an invalid token without issuing a code", async () => {
    verifyMock.mockRejectedValue(new Error("bad jwt"));
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

  it("404s when the flag is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = toResponse(await action(actionReq({ intent: "allow", t: TOKEN }) as never));
    expect(r.status).toBe(404);
  });
});
