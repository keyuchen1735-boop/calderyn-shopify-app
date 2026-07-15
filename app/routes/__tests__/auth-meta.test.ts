import { describe, it, expect, vi, beforeEach } from "vitest";
import { loader } from "../auth.meta.$";

// Mock collaborators so the loader runs without network/db. Mirrors
// auth-google.test.ts.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
const parseOAuthState = vi.fn();

vi.mock("~/lib/meta/oauth-state.server", () => ({
  consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a),
  parseOAuthState: (...a: unknown[]) => parseOAuthState(...a),
  embeddedReturnUrl: (path: string, params: Record<string, string>, ctx: { returnTo?: string | null }) =>
    `${ctx.returnTo ?? path}?${new URLSearchParams(params).toString()}`,
  popupResultUrl: (args: { provider: string; status: string; reason?: string }) =>
    `/auth/connected?${new URLSearchParams({ provider: args.provider, status: args.status, ...(args.reason ? { reason: args.reason } : {}) }).toString()}`,
  postOAuthPath: async () => "/app/settings",
}));
vi.mock("~/lib/meta/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ upsert: () => Promise.resolve({ error: null }) }) }),
}));
vi.mock("~/lib/crypto.server", () => ({ encrypt: (s: string) => `enc(${s})` }));

beforeEach(() => {
  consumeOAuthState.mockReset();
  exchangeCodeForToken.mockReset();
  parseOAuthState.mockReset();
  parseOAuthState.mockReturnValue({ nonce: "n", host: null, shop: null });
  process.env.META_APP_ID = "aid";
  process.env.META_APP_SECRET = "sec";
  process.env.SHOPIFY_APP_URL = "https://app.example";
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/meta?${qs}`) } as Parameters<
    typeof loader
  >[0];
}

describe("auth.meta loader", () => {
  it("redirects cleanly to settings when the user declines consent", async () => {
    // Facebook sends ?error=access_denied&state=... with no code on cancel. This
    // must redirect to Settings with a friendly notice, not throw a raw 400.
    const res = await loader(req("error=access_denied&error_reason=user_denied&state=ok"));
    expect(res.status).toBe(302);
    const loc = res.headers.get("location") ?? "";
    expect(loc).toContain("meta=error");
    expect(loc).toContain("reason=access_denied");
    expect(consumeOAuthState).not.toHaveBeenCalled();
    expect(exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("still 400s when code and state are both missing (not a decline)", async () => {
    await expect(loader(req("foo=bar"))).rejects.toMatchObject({ status: 400 });
  });

  it("returns a valid callback failure to the campaign wizard with its reason", async () => {
    parseOAuthState.mockReturnValue({
      nonce: "n",
      host: null,
      shop: null,
      dashboard: true,
      returnTo: "/dashboard/campaigns/new",
    });
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({ accessToken: "token", expiresInSec: 3600 });
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );

    const res = await loader(req("code=code-1&state=packed-state"));
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/dashboard/campaigns/new?meta=error");
    expect(location).toContain("no+ad+account");
  });
});
