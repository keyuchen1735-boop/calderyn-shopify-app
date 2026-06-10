import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists
// the vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../auth.google.$";

// Mock collaborators so the loader can run without network/db. Mirrors
// auth-quickbooks.test.ts.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("~/lib/meta/oauth-state.server", () => ({
  consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a),
  // Real parseOAuthState always returns this shape (host/shop null when the
  // state carries no embedded context) — never null itself.
  parseOAuthState: () => ({ nonce: "n", host: null, shop: null }),
  embeddedReturnUrl: (path: string, params: Record<string, string>) =>
    `${path}?${new URLSearchParams(params).toString()}`,
}));
vi.mock("~/lib/google/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => {
        upsertCalls.push({ table, row });
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));
vi.mock("~/lib/crypto.server", () => ({ encrypt: (s: string) => `enc(${s})` }));

beforeEach(() => {
  upsertCalls.length = 0;
  consumeOAuthState.mockReset();
  exchangeCodeForToken.mockReset();
  process.env.GOOGLE_ADS_CLIENT_ID = "cid";
  process.env.GOOGLE_ADS_CLIENT_SECRET = "sec";
  process.env.SHOPIFY_APP_URL = "https://app.example";
  // Unset so the loader skips the listAccessibleCustomers network call.
  delete process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/google?${qs}`) } as Parameters<
    typeof loader
  >[0];
}

describe("auth.google loader", () => {
  it("rejects an invalid/expired state nonce", async () => {
    consumeOAuthState.mockResolvedValue(null);
    await expect(loader(req("code=abc&state=bad"))).rejects.toMatchObject({ status: 400 });
  });

  it("clears a stale sync_error when the merchant reconnects", async () => {
    // A failed sync writes sync_error to shop_integrations; reconnecting resets
    // sync_status to 'pending' and must also clear the stale error so Settings
    // doesn't keep showing a failure for a fresh connection.
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({ refreshToken: "ref", expiresInSec: 3600 });

    const res = await loader(req("code=abc&state=ok"));
    expect(res.status).toBe(302);

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1",
      kind: "google_ads",
      access_token_encrypted: "enc(ref)",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({
      shop_id: "shop-1",
      kind: "google_ads",
      sync_status: "pending",
      sync_error: null,
    });
  });
});
