// app/routes/__tests__/oauth-authorize.test.ts
//
// /oauth/authorize validates the OAuth request and renders an interstitial that
// deep-links into the embedded /app/connect consent route. It must NOT write any
// consumable pending state (no DB row, no cookie) — that pre-seed was the High.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("../../lib/mcp_oauth.server")>();
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { getClient } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { loader } from "../oauth.authorize";

const VALID_PARAMS: Record<string, string> = {
  response_type: "code",
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  scope: "read",
  state: "abc",
};

const getClientMock = getClient as unknown as ReturnType<typeof vi.fn>;

function reqWith(params: Record<string, string>): { request: Request } {
  const url = new URL("http://x/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { request: new Request(url.toString()) };
}

function reqWithCookie(params: Record<string, string>, cookie: string): { request: Request } {
  const url = new URL("http://x/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { request: new Request(url.toString(), { headers: { Cookie: cookie } }) };
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
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  process.env.SHOPIFY_API_KEY = "apikey123";
  process.env.SHOPIFY_APP_URL = "https://app.calderyncompany.com";
  getClientMock.mockReset();
});

describe("/oauth/authorize loader", () => {
  it("404 when MCP_OAUTH_ENABLED is off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(404);
  });

  it("400 on missing required params (no redirect since redirect_uri unknown)", async () => {
    const r = await loader(reqWith({ ...VALID_PARAMS, response_type: "" }) as never);
    expect(r.status).toBe(400);
  });

  it("400 on missing code_challenge", async () => {
    const r = await loader(reqWith({ ...VALID_PARAMS, code_challenge: "" }) as never);
    expect(r.status).toBe(400);
  });

  it("400 on unknown client_id", async () => {
    getClientMock.mockResolvedValue(null);
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("400 when redirect_uri not in client whitelist (no redirect)", async () => {
    getClientMock.mockResolvedValue({ ...clientFixture(), redirect_uris: ["https://other.example/cb"] });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("302 to redirect_uri with error=invalid_request on bad code_challenge_method", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith({ ...VALID_PARAMS, code_challenge_method: "plain" }) as never);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(loc).toContain("error=invalid_request");
    expect(loc).toContain("state=abc");
  });

  it("302 to redirect_uri with error=unsupported_response_type when response_type != code", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith({ ...VALID_PARAMS, response_type: "token" }) as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("error=unsupported_response_type");
  });

  it("302 to redirect_uri with error=invalid_request on a non-read scope", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith({ ...VALID_PARAMS, scope: "write" }) as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("error=invalid_request");
  });

  it("renders the interstitial (200, signed token, no cookie) for a valid request", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(200);
    // Crucially: no consumable pre-seed state is written.
    expect(r.headers.get("set-cookie")).toBeNull();
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(typeof j.token).toBe("string");
    expect(j.token.length).toBeGreaterThan(20);
    expect(j.shop).toBeNull();
  });

  it("passes a validated ?shop= through as a deep-link hint (no /auth/login redirect)", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith({ ...VALID_PARAMS, shop: "MyShop.myshopify.com" }) as never);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toBeNull();
    const j = await r.json();
    expect(j.shop).toBe("myshop.myshopify.com");
    expect(j.apiKey).toBe("apikey123");
  });

  it("drops a malformed ?shop= hint rather than trusting it", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWith({ ...VALID_PARAMS, shop: "not-a-shop" }) as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.shop).toBeNull();
  });

  it("does not export an action (no direct-POST pre-seed surface)", async () => {
    const mod = await import("../oauth.authorize");
    expect((mod as Record<string, unknown>).action).toBeUndefined();
  });

  it("uses the __Host-cala_shop cookie as the shop when there is no ?shop= hint", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWithCookie(VALID_PARAMS, "__Host-cala_shop=cookieshop.myshopify.com") as never);
    expect(r.status).toBe(200);
    // Invariant: authorize never writes consumable pre-seed state.
    expect(r.headers.get("set-cookie")).toBeNull();
    const j = await r.json();
    expect(j.shop).toBe("cookieshop.myshopify.com");
  });

  it("prefers an explicit ?shop= hint over the remembered cookie", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(
      reqWithCookie({ ...VALID_PARAMS, shop: "hint.myshopify.com" }, "__Host-cala_shop=cookieshop.myshopify.com") as never,
    );
    const j = await r.json();
    expect(j.shop).toBe("hint.myshopify.com");
  });

  it("ignores a malformed __Host-cala_shop cookie", async () => {
    getClientMock.mockResolvedValue(clientFixture());
    const r = await loader(reqWithCookie(VALID_PARAMS, "__Host-cala_shop=not-a-shop") as never);
    const j = await r.json();
    expect(j.shop).toBeNull();
  });
});
