import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists the
// vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../auth.shippo.$";
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
vi.mock("~/lib/shippo/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
// Onboarding state drives where the success redirect lands: back into the wizard
// while setup is incomplete, Settings once it's done.
const shopsRow: { onboarding_step: string | null; onboarding_completed_at: string | null } = {
  onboarding_step: "shippo",
  onboarding_completed_at: null,
};

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({
    from: (table: string) => ({
      upsert: (row: Record<string, unknown>) => {
        upsertCalls.push({ table, row });
        return Promise.resolve({ error: null });
      },
      select: () => ({
        eq: () => ({ maybeSingle: () => Promise.resolve({ data: shopsRow, error: null }) }),
      }),
    }),
  }),
}));
vi.mock("~/lib/crypto.server", () => ({ encrypt: (s: string) => `enc(${s})` }));

beforeEach(() => {
  upsertCalls.length = 0;
  shopsRow.onboarding_step = "shippo";
  shopsRow.onboarding_completed_at = "2026-06-10T00:00:00Z"; // default: onboarding done → Settings.
  consumeOAuthState.mockReset();
  exchangeCodeForToken.mockReset();
  process.env.SHIPPO_CLIENT_ID = "cid";
  process.env.SHIPPO_CLIENT_SECRET = "sec";
  process.env.SHOPIFY_APP_URL = "https://app.example";
});

function req(qs: string) {
  return { request: new Request(`https://app.example/auth/shippo?${qs}`) } as Parameters<typeof loader>[0];
}

describe("auth.shippo loader", () => {
  it("rejects an invalid/expired state nonce", async () => {
    consumeOAuthState.mockResolvedValue(null);
    await expect(loader(req("code=abc&state=bad"))).rejects.toMatchObject({ status: 400 });
  });

  it("stores the encrypted NON-EXPIRING access token and flips status to ready", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "oauth.tok123", scope: "*", accountId: "acct-9",
    });
    const res = await loader(req("code=abc&state=ok"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/settings?shippo=connected");

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1",
      kind: "shippo_ship",
      access_token_encrypted: "enc(oauth.tok123)",
      token_expires_at: null, // Shippo tokens never expire (no refresh token).
      external_account_id: "acct-9",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({
      shop_id: "shop-1", kind: "shippo_ship", sync_status: "ready", sync_error: null,
    });
  });

  // The OAuth callback arrives top-level (outside the admin iframe). The packed state
  // carries shop/host; the redirect must forward them so authenticate.admin can
  // re-embed and the settings page actually receives ?shippo=connected.
  const packedState = Buffer.from(
    JSON.stringify({ n: "nonce-1", h: "aG9zdA", s: "test.myshopify.com" }),
  ).toString("base64url");

  it("returns to onboarding mid-setup, carrying shop/host from the packed state", async () => {
    shopsRow.onboarding_completed_at = null; // mid-onboarding → wizard.
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({ accessToken: "oauth.t", scope: "*", accountId: null });
    const res = await loader(req(`code=abc&state=${packedState}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app/onboarding?shippo=connected&shop=test.myshopify.com&host=aG9zdA",
    );
  });

  it("carries shop/host through the user-declined error redirect, writing no credential", async () => {
    const res = await loader(req(`error=access_denied&state=${packedState}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app/settings?shippo=error&reason=access_denied&shop=test.myshopify.com&host=aG9zdA",
    );
    expect(upsertCalls).toHaveLength(0); // no token exchange, no DB write on decline.
  });
});
