// app/routes/__tests__/oauth-consent.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as McpOauth from "../../lib/mcp_oauth.server";
import { signConsentAuth, getClient } from "../../lib/mcp_oauth.server";

// /oauth/consent verifies a signed _auth JWT bound to a shop, then reads the
// pending_oauth row keyed by that shop. No authenticate.admin in this route.
vi.mock("../../lib/mcp_oauth.server", async (importOriginal) => {
  const actual = await importOriginal<typeof McpOauth>();
  return {
    ...actual,
    getClient: vi.fn(),
    issueAuthCode: vi.fn().mockResolvedValue("calc_test_code"),
    getPendingOauth: vi.fn(),
    deletePendingOauth: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../lib/supabase.server", () => ({
  resolveShopId: vi.fn(),
}));

// eslint-disable-next-line import/first
import { resolveShopId } from "../../lib/supabase.server";
// eslint-disable-next-line import/first
import { getPendingOauth } from "../../lib/mcp_oauth.server";
// eslint-disable-next-line import/first
import { loader, action } from "../oauth.consent";

const SHOP = "myshop.myshopify.com";

beforeEach(() => {
  process.env.MCP_OAUTH_ENABLED = "true";
  process.env.MCP_OAUTH_COOKIE_SECRET = "a".repeat(64);
  (getClient as unknown as ReturnType<typeof vi.fn>).mockReset();
  (resolveShopId as unknown as ReturnType<typeof vi.fn>).mockReset();
  (getPendingOauth as unknown as ReturnType<typeof vi.fn>).mockReset();
});

function pendingRowFixture(overrides: Partial<McpOauth.PendingOauthRow> = {}): McpOauth.PendingOauthRow {
  return {
    shop_domain: SHOP,
    client_id: "cal_client_x",
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "ch",
    scope: "read",
    client_state: "abc",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

describe("/oauth/consent loader", () => {
  it("404s when flag off", async () => {
    process.env.MCP_OAUTH_ENABLED = "false";
    const r = await loader({
      request: new Request("http://x/oauth/consent"),
    } as never);
    expect(r.status).toBe(404);
  });

  it("redirects to /app when no _auth param", async () => {
    const r = await loader({
      request: new Request("http://x/oauth/consent"),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("redirects to /app on tampered _auth", async () => {
    const r = await loader({
      request: new Request("http://x/oauth/consent?_auth=not.a.valid.jwt"),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("redirects to /app when no pending row exists for the shop", async () => {
    const auth = await signConsentAuth({ shop: SHOP });
    (getPendingOauth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const r = await loader({
      request: new Request(`http://x/oauth/consent?_auth=${encodeURIComponent(auth)}`),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });

  it("renders consent JSON when _auth + pending row align", async () => {
    const auth = await signConsentAuth({ shop: SHOP });
    (getPendingOauth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      pendingRowFixture(),
    );
    (getClient as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      client_id: "cal_client_x",
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/cb"],
      token_endpoint_auth_method: "none",
    });
    const r = await loader({
      request: new Request(`http://x/oauth/consent?_auth=${encodeURIComponent(auth)}`),
    } as never);
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.client_name).toBe("Claude");
    expect(j.shop).toBe(SHOP);
    expect(j.scopes).toEqual(["read"]);
    expect(j.auth_token).toBe(auth);
  });
});

describe("/oauth/consent action", () => {
  it("Allow mints code and returns JSON redirect_url so UI navigates window.top", async () => {
    const auth = await signConsentAuth({ shop: SHOP });
    (getPendingOauth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      pendingRowFixture(),
    );
    (resolveShopId as unknown as ReturnType<typeof vi.fn>).mockResolvedValue("shopuuid");

    const form = new FormData();
    form.set("intent", "allow");
    form.set("_auth", auth);
    const r = await action({
      request: new Request("http://x/oauth/consent", { method: "POST", body: form }),
    } as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toMatch(/^https:\/\/claude\.ai\/cb\?/);
    expect(j.redirect_url ?? "").toContain("code=calc_test_code");
    expect(j.redirect_url ?? "").toContain("state=abc");
  });

  it("Deny returns JSON redirect_url with error=access_denied", async () => {
    const auth = await signConsentAuth({ shop: SHOP });
    (getPendingOauth as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      pendingRowFixture(),
    );

    const form = new FormData();
    form.set("intent", "deny");
    form.set("_auth", auth);
    const r = await action({
      request: new Request("http://x/oauth/consent", { method: "POST", body: form }),
    } as never);
    expect(r.status).toBe(200);
    const j = (await r.json()) as { redirect_url?: string };
    expect(j.redirect_url ?? "").toContain("error=access_denied");
    expect(j.redirect_url ?? "").toContain("state=abc");
  });

  it("redirects to /app when _auth is missing", async () => {
    const form = new FormData();
    form.set("intent", "allow");
    const r = await action({
      request: new Request("http://x/oauth/consent", { method: "POST", body: form }),
    } as never);
    expect(r.status).toBe(302);
    expect(r.headers.get("location")).toBe("/app");
  });
});
