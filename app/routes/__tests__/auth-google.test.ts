import { describe, it, expect, vi, beforeEach } from "vitest";
// Subject under test. Hoisted to the top to satisfy import/first; Vitest hoists
// the vi.mock calls below above all imports, so the mocks still apply.
import { loader } from "../auth.google.$";

// Mock collaborators so the loader can run without network/db. Mirrors
// auth-quickbooks.test.ts.
const consumeOAuthState = vi.fn();
const exchangeCodeForToken = vi.fn();
// Configurable per test: a mid-onboarding shop returns "/app/onboarding", a
// finished one "/app/settings". The error/decline redirects must honor this the
// same way the success redirect does, so a failed connect doesn't strand a
// merchant on Settings mid-wizard.
const postOAuthPath = vi.fn();
const upsertCalls: Array<{ table: string; row: Record<string, unknown> }> = [];

vi.mock("~/lib/meta/oauth-state.server", () => ({
  consumeOAuthState: (...a: unknown[]) => consumeOAuthState(...a),
  // Real parseOAuthState always returns this shape (host/shop null when the
  // state carries no embedded context) — never null itself.
  parseOAuthState: () => ({ nonce: "n", host: null, shop: null }),
  embeddedReturnUrl: (path: string, params: Record<string, string>) =>
    `${path}?${new URLSearchParams(params).toString()}`,
  postOAuthPath: (...a: unknown[]) => postOAuthPath(...a),
}));
vi.mock("~/lib/google/oauth.server", () => ({
  exchangeCodeForToken: (...a: unknown[]) => exchangeCodeForToken(...a),
  // The connect-failure path maps the raw lookup-error body to a short reason.
  googleConnectErrorReason: (raw: string) => (raw.includes("NOT_ADS_USER") ? "not_ads_user" : "google_error"),
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
  postOAuthPath.mockReset();
  // Default fixture: a shop that finished onboarding -> Settings. Tests that
  // exercise the mid-wizard case override this with "/app/onboarding".
  postOAuthPath.mockResolvedValue("/app/settings");
  vi.unstubAllGlobals();
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

  it("returns a declined consent back to onboarding (not Settings) when mid-wizard", async () => {
    // Google sends ?error=access_denied&state=... with no code when the merchant
    // clicks Cancel. Mid-onboarding that must land back on the wizard step.
    consumeOAuthState.mockResolvedValue("shop-1");
    postOAuthPath.mockResolvedValue("/app/onboarding");

    const res = await loader(req("error=access_denied&state=ok"));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/app/onboarding");
    expect(location).toContain("google=error");
    expect(location).toContain("reason=access_denied");
    expect(location).not.toContain("/app/settings");
  });

  it("falls back to Settings (no 500) when the onboarding-state lookup fails on a decline", async () => {
    // The decline handler exists to fail gracefully; a transient shops-table
    // error while resolving onboarding state must not turn it into a 500.
    consumeOAuthState.mockResolvedValue("shop-1");
    postOAuthPath.mockRejectedValue(new Error("db down"));

    const res = await loader(req("error=access_denied&state=ok"));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location") ?? "").toContain("/app/settings");
  });

  it("returns a failed connect back to onboarding (not Settings) when the merchant is mid-wizard", async () => {
    // Repro: during onboarding the merchant signs into Google, but the account
    // has no usable Ads account (NOT_ADS_USER). The connect-failure redirect must
    // land them back on the onboarding step, not eject them to Settings.
    consumeOAuthState.mockResolvedValue("shop-1");
    exchangeCodeForToken.mockResolvedValue({ refreshToken: "ref", expiresInSec: 3600 });
    postOAuthPath.mockResolvedValue("/app/onboarding");
    process.env.GOOGLE_ADS_DEVELOPER_TOKEN = "devtok";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("oauth2.googleapis.com/token")) {
          return { ok: true, json: async () => ({ access_token: "atk" }) } as unknown as Response;
        }
        // listAccessibleCustomers fails with NOT_ADS_USER.
        return { ok: false, status: 403, text: async () => "NOT_ADS_USER" } as unknown as Response;
      }),
    );

    const res = await loader(req("code=abc&state=ok"));
    expect(res.status).toBe(302);
    const location = res.headers.get("Location") ?? "";
    expect(location).toContain("/app/onboarding");
    expect(location).toContain("google=error");
    expect(location).not.toContain("/app/settings");
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
