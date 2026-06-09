// app/routes/__tests__/oauth-authorize.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/mcp_oauth.server")>();
  return {
    ...actual,
    getClient: vi.fn(),
  };
});

import { getClient } from "../../lib/mcp_oauth.server";
import { loader, action } from "../oauth.authorize";

const VALID_PARAMS: Record<string, string> = {
  response_type: "code",
  client_id: "cal_client_x",
  redirect_uri: "https://claude.ai/cb",
  code_challenge: "challenge",
  code_challenge_method: "S256",
  scope: "read",
  state: "abc",
};

function reqWith(params: Record<string, string>): { request: Request } {
  const url = new URL("http://x/oauth/authorize");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return { request: new Request(url.toString()) };
}

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  (getClient as unknown as ReturnType<typeof vi.fn>).mockReset();
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

  it("400 on unknown client_id", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("400 when redirect_uri not in client whitelist (no redirect)", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://other.example/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(400);
  });

  it("302 to redirect_uri with error=invalid_request on bad code_challenge_method", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith({ ...VALID_PARAMS, code_challenge_method: "plain" }) as never);
    expect(r.status).toBe(302);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(loc).toContain("error=invalid_request");
    expect(loc).toContain("state=abc");
  });

  it("302 to redirect_uri with error=unsupported_response_type when response_type != code", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith({ ...VALID_PARAMS, response_type: "token" }) as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location") ?? "").toContain("error=unsupported_response_type");
  });

  it("renders the which-shop page when no ?shop= and all params are valid", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.phase).toBe("pick-shop");
    expect(j.client_name).toBe("Claude");
    expect(j.client_id).toBe("cal_client_x");
  });

  it("with ?shop=...: sets cookie and 302s to /auth/login", async () => {
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith({ ...VALID_PARAMS, shop: "myshop.myshopify.com" }) as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toContain("/auth/login?shop=myshop.myshopify.com");
    expect(r.headers.get("set-cookie") ?? "").toContain("__cal_pending_oauth=");
  });

  it("loader returns OAuth params alongside client info in pick-shop response", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader(reqWith(VALID_PARAMS) as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.phase).toBe("pick-shop");
    expect(j.client_name).toBe("Claude");
    expect(j.client_id).toBe("cal_client_x");
    expect(j.redirect_uri).toBe("https://claude.ai/cb");
    expect(j.code_challenge).toBe("challenge");
    expect(j.code_challenge_method).toBe("S256");
    expect(j.scope).toBe("read");
    expect(j.state).toBe("abc");
    expect(j.response_type).toBe("code");
  });
});

describe("/oauth/authorize POST (pick-shop)", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = "true";
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
  });

  it("400s when shop is empty", async () => {
    const form = new FormData();
    form.set("shop", "");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("400s on non-myshopify.com shop", async () => {
    const form = new FormData();
    form.set("shop", "not-shopify");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(400);
  });

  it("sets pending cookie and redirects to /auth/login on valid shop", async () => {
    const form = new FormData();
    form.set("shop", "myshop.myshopify.com");
    for (const [k, v] of Object.entries(VALID_PARAMS)) form.set(k, v);
    const res = await action({
      request: new Request("http://x/oauth/authorize", { method: "POST", body: form }),
    } as never);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/auth/login?shop=myshop.myshopify.com");
    const cookieHeader = res.headers.get("set-cookie") ?? "";
    expect(cookieHeader).toContain("__cal_pending_oauth=");
    expect(cookieHeader).toContain("HttpOnly");
    expect(cookieHeader).toContain("Secure");
  });
});
