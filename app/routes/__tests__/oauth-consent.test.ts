// app/routes/__tests__/oauth-consent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as McpOauth from "../../lib/mcp_oauth.server";
import {
  signPendingOauth,
  PENDING_COOKIE_NAME,
  getClient,
} from "../../lib/mcp_oauth.server";

vi.mock("../../shopify.server", () => ({
  authenticate: {
    admin: vi.fn(),
  },
}));

// Mock getClient, issueAuthCode, and the pending-OAuth DB helpers on top of the
// real module so signPendingOauth/verifyPendingOauth still work for the cookie
// fallback path.
vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof McpOauth>();
  return {
    ...actual,
    getClient: vi.fn(),
    issueAuthCode: vi.fn().mockResolvedValue("calc_test_code"),
    getPendingOauth: vi.fn().mockResolvedValue(null),
    deletePendingOauth: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/supabase.server", () => ({
  resolveShopId: vi.fn(),
}));

// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { authenticate } from "../../shopify.server";
// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { resolveShopId } from "../../lib/supabase.server";
// eslint-disable-next-line import/first -- module under test must import after vi.mock() hoisting
import { loader, action } from "../oauth.consent";

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockReset();
  (getClient as unknown as ReturnType<typeof vi.fn>).mockReset();
  (resolveShopId as unknown as ReturnType<typeof vi.fn>).mockReset();
});

describe("/oauth/consent loader", () => {
  it("404s when flag off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({ request: new Request("http://x/oauth/consent") } as never);
    expect(r.status).toBe(404);
  });

  it("redirects to /app when no pending cookie", async () => {
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({ request: new Request("http://x/oauth/consent") } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("renders consent JSON when cookie + session match", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch",
      scope: "read",
      state: "abc",
      shop: "myshop.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });

    const r = await loader({
      request: new Request("http://x/oauth/consent", {
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.shop).toBe("myshop.myshopify.com");
    expect(j.scopes).toEqual(["read"]);
  });

  it("redirects to /app when shop in cookie != session.shop", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch",
      scope: "read",
      state: "abc",
      shop: "OTHER.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({
      request: new Request("http://x/oauth/consent", {
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
      }),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("redirects to /app on tampered cookie", async () => {
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    const r = await loader({
      request: new Request("http://x/oauth/consent", {
        headers: { cookie: `${PENDING_COOKIE_NAME}=not.a.valid.jwt` },
      }),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });
});

describe("/oauth/consent action", () => {
  beforeEach(() => {
    process.env.MCP_OAUTH_ENABLED = "true";
    process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  });

  it("Allow mints code and returns JSON redirect_url so UI navigates window.top", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch",
      scope: "read",
      state: "abc",
      shop: "myshop.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });
    (resolveShopId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("shopuuid");

    const form = new FormData();
    form.set("intent", "allow");
    const r = await action({
      request: new Request("http://x/oauth/consent", {
        method: "POST",
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
        body: form,
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(j.redirect_url ?? "").toContain("code=calc_test_code");
    expect(j.redirect_url ?? "").toContain("state=abc");
    const setCookie = r.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${PENDING_COOKIE_NAME}=;`);
    // Clear cookie must use SameSite=None to match the issue-time attribute.
    expect(setCookie).toContain("SameSite=None");
  });

  it("Deny returns JSON redirect_url with error=access_denied", async () => {
    const jwt = await signPendingOauth({
      client_id: "cal_client_x",
      redirect_uri: "https://claude.ai/cb",
      code_challenge: "ch",
      scope: "read",
      state: "abc",
      shop: "myshop.myshopify.com",
    });
    (authenticate.admin as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      session: { shop: "myshop.myshopify.com" },
    });

    const form = new FormData();
    form.set("intent", "deny");
    const r = await action({
      request: new Request("http://x/oauth/consent", {
        method: "POST",
        headers: { cookie: `${PENDING_COOKIE_NAME}=${jwt}` },
        body: form,
      }),
    } as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toContain("error=access_denied");
    expect(j.redirect_url ?? "").toContain("state=abc");
    expect(r.headers.get("set-cookie") ?? "").toContain(`${PENDING_COOKIE_NAME}=;`);
  });
});
