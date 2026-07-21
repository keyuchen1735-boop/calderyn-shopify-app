import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists
// the vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../auth.quickbooks.$";
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
vi.mock("~/lib/quickbooks/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
}));
// Onboarding state drives where the success redirect lands: back into the
// wizard while setup is incomplete, Settings once it's done.
const shopsRow: { onboarding_step: string | null; onboarding_completed_at: string | null } = {
  onboarding_step: "quickbooks",
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
  shopsRow.onboarding_step = "quickbooks";
  shopsRow.onboarding_completed_at = null;
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

  // A merchant who lingers on Intuit's screens past the nonce TTL should get a
  // dashboard toast + retry, not a bare 400 page. The packed (non-secret)
  // return context still parses even though the nonce is dead.
  it("redirects an expired dashboard-started connect back with an error notice", async () => {
    consumeOAuthState.mockResolvedValue(null);
    process.env.DASHBOARD_PUBLIC_URL = "https://calderyncompany.com";
    const { packOAuthState } = await vi.importActual<typeof OAuthStateModule>(
      "~/lib/meta/oauth-state.server",
    );
    const state = packOAuthState("deadnonce", { dashboard: true, returnTo: "/dashboard/settings" });
    const res = await loader(req(`code=abc&state=${state}&realmId=9`));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location")!;
    expect(location).toContain("https://calderyncompany.com/dashboard/settings");
    expect(location).toContain("quickbooks=error");
    delete process.env.DASHBOARD_PUBLIC_URL;
  });

  it("stores the encrypted refresh token + realmId and returns to onboarding mid-setup", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000,
    });
    const res = await loader(req("code=abc&state=ok&realmId=realm-9"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/app/onboarding?quickbooks=connected");

    const cred = upsertCalls.find((c) => c.table === "integration_credentials")!;
    expect(cred.row).toMatchObject({
      shop_id: "shop-1", kind: "quickbooks", access_token_encrypted: "enc(ref)", external_account_id: "realm-9",
    });
    const integ = upsertCalls.find((c) => c.table === "shop_integrations")!;
    expect(integ.row).toMatchObject({ shop_id: "shop-1", kind: "quickbooks", sync_status: "ready" });
  });

  // The OAuth callback arrives top-level (outside the admin iframe). The packed
  // state carries shop/host; the redirect must forward them so authenticate.admin
  // can re-embed and the settings page actually receives ?quickbooks=connected.
  const packedState = Buffer.from(
    JSON.stringify({ n: "nonce-1", h: "aG9zdA", s: "test.myshopify.com" }),
  ).toString("base64url");

  it("carries shop/host from the packed state through the success redirect", async () => {
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000,
    });
    const res = await loader(req(`code=abc&state=${packedState}&realmId=realm-9`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app/onboarding?quickbooks=connected&shop=test.myshopify.com&host=aG9zdA",
    );
  });

  it("redirects to settings once onboarding is complete", async () => {
    shopsRow.onboarding_completed_at = "2026-06-10T00:00:00Z";
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({
      accessToken: "acc", refreshToken: "ref", expiresInSec: 3600, refreshExpiresInSec: 8640000,
    });
    const res = await loader(req("code=abc&state=ok&realmId=realm-9"));
    expect(res.headers.get("location")).toBe("/app/settings?quickbooks=connected");
  });

  it("carries shop/host through the user-declined error redirect", async () => {
    const res = await loader(req(`error=access_denied&state=${packedState}`));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "/app/settings?quickbooks=error&reason=access_denied&shop=test.myshopify.com&host=aG9zdA",
    );
  });
});
