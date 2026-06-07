import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock collaborators so the loader can run without network/db.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("~/lib/meta/oauth-state.server", () => ({ consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a) }));
vi.mock("~/lib/quickbooks/oauth.server", () => ({
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

import { loader } from "../auth.quickbooks.$";

beforeEach(() => {
  upsertCalls.length = 0;
  consumeOAuthState.mockReset();
  exchangeCodeForToken.mockReset();
  process.env.QBO_CLIENT_ID = "cid";
  process.env.QBO_CLIENT_SECRET = "sec";
  process.env.SHOPIFY_APP_URL = "https://app.example";
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/quickbooks?${qs}`) } as Parameters<typeof loader>[0];
}

describe("auth.quickbooks loader", () => {
  it("rejects an invalid/expired state nonce", async () => {
    consumeOAuthState.mockResolvedValue(null);
    await expect(loader(req("code=abc&state=bad&realmId=9"))).rejects.toMatchObject({ status: 400 });
  });

  it("stores the encrypted refresh token + realmId and redirects to settings", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000,
    });
    const res = await loader(req("code=abc&state=ok&realmId=realm-9"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/settings?quickbooks=connected");

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1", kind: "quickbooks", access_token_encrypted: "enc(ref)", external_account_id: "realm-9",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({ shop_id: "shop-1", kind: "quickbooks", sync_status: "ready" });
  });
});
