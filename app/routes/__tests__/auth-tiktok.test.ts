import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists
// the vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../auth.tiktok.$";
import type * as OAuthStateModule from "~/lib/meta/oauth-state.server";

// Mock collaborators so the loader can run without network/db.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("~/lib/meta/oauth-state.server", async (importOriginal) => {
  // Keep the real pure helpers (parseOAuthState/embeddedReturnUrl); only the
  // db-backed nonce consumption is faked.
  const actual = await importOriginal<typeof OAuthStateModule>();
  return { ...actual, consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a) };
});
vi.mock("~/lib/tiktok/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { onboarding_step: "complete", onboarding_completed_at: "2026-06-10T00:00:00Z" },
              error: null,
            }),
        }),
      }),
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
  process.env.TIKTOK_APP_ID = "tt-app";
  process.env.TIKTOK_APP_SECRET = "tt-sec";
  process.env.SHOPIFY_API_KEY = "testapikey";
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/tiktok?${qs}`) } as Parameters<typeof loader>[0];
}

// The OAuth callback arrives top-level (outside the admin iframe). The packed
// state carries shop/host; the redirect must go through embeddedReturnUrl so
// the merchant lands back on the embedded settings page (admin deep link), not
// the app login page / app root.
const packedState = Buffer.from(
  JSON.stringify({ n: "nonce-1", h: "aG9zdA", s: "test.myshopify.com" }),
).toString("base64url");

describe("auth.tiktok loader", () => {
  it("rejects an invalid/expired state nonce", async () => {
    consumeOAuthState.mockResolvedValue(null);
    await expect(loader(req("auth_code=abc&state=bad"))).rejects.toMatchObject({ status: 400 });
  });

  it("stores the credential and returns via the admin deep link on success", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "tok", advertiserId: "adv-1", expiresInSec: 86400,
    });
    const res = await loader(req(`auth_code=abc&state=${packedState}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://admin.shopify.com/store/test/apps/testapikey/app/settings?tiktok=connected",
    );

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1", kind: "tiktok_ads", access_token_encrypted: "enc(tok)", external_account_id: "adv-1",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({ shop_id: "shop-1", kind: "tiktok_ads", sync_status: "pending" });
  });

  it("returns via the admin deep link on a user-declined error too", async () => {
    const res = await loader(req(`error=access_denied&state=${packedState}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://admin.shopify.com/store/test/apps/testapikey/app/settings?tiktok=error&reason=access_denied",
    );
  });
});
