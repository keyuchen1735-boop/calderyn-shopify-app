// app/routes/__tests__/oauth-token.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

import { consumeAuthCode, getClient } from "../../lib/mcp_oauth.server";
import { mintAccessToken, rotateRefreshToken } from "../../lib/mcp_tokens.server";
import { action } from "../oauth.token";

vi.mock("../../lib/mcp_oauth.server", () => ({
  consumeAuthCode: vi.fn(),
  getClient: vi.fn(),
}));
vi.mock("../../lib/mcp_tokens.server", () => ({
  mintAccessToken: vi.fn(),
  rotateRefreshToken: vi.fn(),
}));

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockReset();
  (getClient as unknown as ReturnType<typeof vi.fn>).mockReset();
  (mintAccessToken as unknown as ReturnType<typeof vi.fn>).mockReset();
});

function form(body: Record<string, string>): Request {
  const f = new URLSearchParams(body);
  return new Request("http://x/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: f.toString(),
  });
}

describe("/oauth/token POST (authorization_code)", () => {
  it("404 when flag off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = await action({ request: form({ grant_type: "authorization_code" }) } as never);
    expect(r.status).toBe(404);
  });

  it("400s when grant_type missing", async () => {
    const r = await action({ request: form({}) } as never);
    expect(r.status).toBe(400);
  });

  it("400s on unsupported grant_type", async () => {
    const r = await action({ request: form({ grant_type: "password" }) } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("unsupported_grant_type");
  });

  it("400 invalid_request when required code params missing", async () => {
    const r = await action({ request: form({ grant_type: "authorization_code", code: "x" }) } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("invalid_request");
  });

  it("401 invalid_client on unknown client_id", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await action({
      request: form({
        grant_type: "authorization_code",
        code: "calc_zzz",
        code_verifier: "v".repeat(43),
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_unknown",
      }),
    } as never);
    expect(r.status).toBe(401);
    const j = await r.json();
    expect(j.error).toBe("invalid_client");
  });

  it("exchanges code + verifier for access + refresh", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      shop_id: "s1",
      scopes: ["read"],
    });
    (mintAccessToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "cala_x",
      refresh_token: "calr_x",
      expires_in: 7776000,
      token_type: "Bearer",
      scope: "read",
    });
    const r = await action({
      request: form({
        grant_type: "authorization_code",
        code: "calc_zzz",
        code_verifier: "v".repeat(43),
        redirect_uri: "https://claude.ai/cb",
        client_id: "cal_client_x",
      }),
    } as never);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const j = await r.json();
    expect(j.access_token).toBe("cala_x");
    expect(j.refresh_token).toBe("calr_x");
    expect(j.token_type).toBe("Bearer");
    expect(j.expires_in).toBe(7776000);
  });

  it("400 invalid_grant on bad code", async () => {
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const err = Object.assign(new Error("nope"), { code: "invalid_grant" });
    (consumeAuthCode as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const r = await action({
      request: form({
        grant_type: "authorization_code",
        code: "x",
        code_verifier: "v".repeat(43),
        redirect_uri: "u",
        client_id: "cal_client_x",
      }),
    } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("invalid_grant");
  });
});

describe("/oauth/token POST (refresh_token)", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = "true";
    (rotateRefreshToken as unknown as ReturnType<typeof vi.fn>).mockReset();
  });

  it("rotates refresh and returns new pair", async () => {
    (rotateRefreshToken as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      access_token: "cala_new",
      refresh_token: "calr_new",
      expires_in: 7776000,
      token_type: "Bearer",
      scope: "read",
    });
    const r = await action({
      request: form({
        grant_type: "refresh_token",
        refresh_token: "calr_old",
        client_id: "cal_client_x",
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.access_token).toBe("cala_new");
    expect(j.refresh_token).toBe("calr_new");
  });

  it("400 invalid_grant on rotation failure", async () => {
    const err = Object.assign(new Error("revoked"), { code: "invalid_grant" });
    (rotateRefreshToken as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const r = await action({
      request: form({
        grant_type: "refresh_token",
        refresh_token: "x",
        client_id: "c",
      }),
    } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("invalid_grant");
  });

  it("400 invalid_request on missing refresh_token", async () => {
    const r = await action({
      request: form({ grant_type: "refresh_token", client_id: "c" }),
    } as never);
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.error).toBe("invalid_request");
  });
});
