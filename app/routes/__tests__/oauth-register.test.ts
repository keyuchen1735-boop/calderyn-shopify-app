import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../lib/mcp_oauth.server", () => ({
  registerClient: vi.fn(),
}));

import { registerClient } from "../../lib/mcp_oauth.server";
import { action } from "../oauth.register";

beforeEach(() => {
  (registerClient as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe("/oauth/register POST", () => {
  it("404s when MCP_OAUTH_ENABLED is not true", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const res = await action({
      request: new Request("http://x/oauth/register", { method: "POST", body: "{}" }),
    } as never);
    expect(res.status).toBe(404);
  });

  it("400s on non-JSON body", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      }),
    } as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("invalid_client_metadata");
  });

  it("returns 201 with DCR response on valid body", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    (registerClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Claude",
          redirect_uris: ["https://claude.ai/cb"],
        }),
      }),
    } as never);
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.client_id).toBe("cal_client_x");
  });

  it("maps INVALID_REDIRECT_URI to 400 invalid_redirect_uri", async () => {
    process.env.MCP_OAUTH_ENABLED = "true";
    const err = Object.assign(new Error("bad"), { code: "INVALID_REDIRECT_URI" });
    (registerClient as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const res = await action({
      request: new Request("http://x/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_name: "x", redirect_uris: ["http://insecure/cb"] }),
      }),
    } as never);
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("invalid_redirect_uri");
  });
});
