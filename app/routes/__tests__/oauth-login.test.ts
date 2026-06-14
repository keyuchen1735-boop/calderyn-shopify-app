// app/routes/__tests__/oauth-login.test.ts
//
// /oauth/login is the connector cold-path "Log in with Shopify" page. It captures
// the shop, remembers it (__Host-cala_shop), and 302s to the admin deep link that
// carries the signed ?t= token into /app/connect. No Shopify OAuth happens here.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../../lib/mcp_oauth.server")>();
  return { ...actual, getClient: vi.fn() };
});

// eslint-disable-next-line import/first
import { getClient, signPendingOauth } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first
import { loader, action } from "../oauth.login";

const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;

const CTX = {
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "challenge",
  scope: "read",
  state: "abc",
};

function clientFixture() {
  return {
    client_id: "cal_client_x",
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/cb"],
    token_endpoint_auth_method: "none",
  };
}

function postReq(body: Record<string, string>): { request: Request } {
  return {
    request: new Request("https://app.calderyncompany.com/oauth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    }),
  };
}

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  process.env.SHOPIFY_API_KEY = "apikey123";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  getClientMock.mockReset();
});

describe("/oauth/login loader", () => {
  it("404 when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = (await loader({
      request: new Request("https://app.calderyncompany.com/oauth/login?t=x"),
    } as never)) as Response;
    expect(r.status).toBe(404);
  });

  it("redirects to /app when the token is invalid", async () => {
    const r = (await loader({
      request: new Request("https://app.calderyncompany.com/oauth/login?t=garbage"),
    } as never)) as Response;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("https://app.calderyncompany.com/app");
  });

  it("renders (200) with the client name for a valid token", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const token = await signPendingOauth(CTX);
    const r = (await loader({
      request: new Request(`https://app.calderyncompany.com/oauth/login?t=${encodeURIComponent(token)}`),
    } as never)) as Response;
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.token).toBe(token);
  });
});

describe("/oauth/login action", () => {
  it("404 when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = (await action(postReq({ t: "x", shop: "s.myshopify.com" }) as never)) as Response;
    expect(r.status).toBe(404);
  });

  it("302s to the admin deep link and remembers the shop on a valid submit", async () => {
    const token = await signPendingOauth(CTX);
    const r = (await action(postReq({ t: token, shop: "MyShop.myshopify.com" }) as never)) as Response;
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe(
      `https://admin.shopify.com/store/myshop/apps/apikey123/app/connect?t=${encodeURIComponent(token)}`,
    );
    expect(r.headers.get("set-cookie") ?? "").toContain("__Host-cala_shop=myshop.myshopify.com");
  });

  it("422s without a cookie when the shop is invalid", async () => {
    const token = await signPendingOauth(CTX);
    const r = (await action(postReq({ t: token, shop: "evil.com" }) as never)) as Response;
    expect(r.status).toBe(422);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("location")).toBeNull();
    // The pending JWT must not be echoed back in the response body.
    expect(await r.text()).not.toContain(token);
  });

  it("400s when the token is invalid", async () => {
    const r = (await action(postReq({ t: "garbage", shop: "myshop.myshopify.com" }) as never)) as Response;
    expect(r.status).toBe(400);
    expect(r.headers.get("set-cookie")).toBeNull();
  });
});
