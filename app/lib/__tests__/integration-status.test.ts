/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake mirrors supabase-js's loosely-typed query builder */
//
// Regression guard for the "paired integration shows as Not connected" bug.
//
// A successful OAuth pairing writes shop_integrations with sync_status in
// {pending (fresh), live (Google sync ok), ready/ok (Meta/backfill ok)}. The
// settings UI must treat ALL of those as paired — previously only ready/ok were,
// so a freshly-paired Google account (pending) and a successfully-synced one
// (live) both rendered as "Not connected". These tests lock the data mapping
// (integrations.list) and the pure view helpers the card renders from.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { isPaired, integrationBadge, connectionNotice, providerPaired } from "../integrations";

// --- Pure view helpers (no DB) -------------------------------------------

describe("integration pairing view", () => {
  it("treats a freshly-paired (pending) integration as paired, like connected", () => {
    expect(isPaired("pending")).toBe(true);
    expect(isPaired("connected")).toBe(true);
    expect(isPaired("disconnected")).toBe(false);
  });

  it("labels a pending integration as Connected — it IS paired, just syncing", () => {
    expect(integrationBadge("pending").label).toBe("Connected");
    expect(integrationBadge("connected").label).toBe("Connected");
    expect(integrationBadge("disconnected").label).toBe("Not connected");
  });

  it("tones a still-syncing pending pairing differently from an active one", () => {
    expect(integrationBadge("connected").tone).toBe("success");
    expect(integrationBadge("pending").tone).toBe("info");
  });

  it("surfaces a dead-token integration as 'Reconnect needed', not paired", () => {
    // A reauth integration HAS a stored credential but it's expired/revoked, so
    // it must read as not-paired (the card shows Connect again, not Disconnect)
    // and badge an attention-tone "Reconnect needed".
    expect(isPaired("reauth")).toBe(false);
    expect(integrationBadge("reauth")).toEqual({ label: "Reconnect needed", tone: "attention" });
  });
});

// --- Post-OAuth confirmation notice (the pairing confirmation UI) ----------

describe("post-OAuth connection notice", () => {
  it("turns a successful provider redirect param into a confirmation", () => {
    const n = connectionNotice(new URLSearchParams("google=connected"));
    expect(n).toEqual({ provider: "Google Ads", ok: true, reason: undefined });
  });

  it("turns an error redirect into a failure notice carrying the reason", () => {
    const n = connectionNotice(new URLSearchParams("meta=error&reason=access_denied"));
    expect(n).toMatchObject({ provider: "Meta Ads", ok: false, reason: "access_denied" });
  });

  it("returns null when no connection param is present", () => {
    expect(connectionNotice(new URLSearchParams("foo=bar"))).toBeNull();
  });
});

// --- providerPaired: bridge OAuth provider short-name -> kind-keyed map ----
// Onboarding/settings ask "is provider X paired?" but the integrations map is
// keyed by kind (google_ads), not provider short-name (google). This helper
// must bridge that gap AND apply isPaired, or google/meta read as never-paired.

describe("providerPaired", () => {
  it("resolves an OAuth provider short-name to its _ads kind before checking", () => {
    expect(providerPaired({ google_ads: { status: "pending" } }, "google")).toBe(true);
    expect(providerPaired({ meta_ads: { status: "connected" } }, "meta")).toBe(true);
  });

  it("is false when the provider's integration is disconnected or absent", () => {
    expect(providerPaired({ google_ads: { status: "disconnected" } }, "google")).toBe(false);
    expect(providerPaired({}, "google")).toBe(false);
  });

  it("treats a non-_ads provider (quickbooks) as its own kind", () => {
    expect(providerPaired({ quickbooks: { status: "connected" } }, "quickbooks")).toBe(true);
  });
});

// --- Data mapping: integrations.list status derivation --------------------

const store: Record<string, any[]> = {};
function makeBuilder(table: string) {
  const filters: Array<[string, any]> = [];
  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const api: any = {
    select: () => api,
    eq: (k: string, v: any) => {
      filters.push([k, v]);
      return api;
    },
    then: (resolve: (v: { data: any; error: null }) => void) => resolve({ data: matches(), error: null }),
  };
  return api;
}

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
  resolveShopId: async () => "shop-X",
}));

// eslint-disable-next-line import/first -- must follow vi.mock so the fake registers before the module loads
import { calderynClient } from "../calderyn.server";

describe("integrations.list status derivation", () => {
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
  });

  it("maps a 'live' sync_status (a successful Google sync) to connected", async () => {
    store["shop_integrations"] = [
      { shop_id: "shop-X", kind: "google_ads", sync_status: "live", connected_at: "2026-06-07T04:26:07Z", external_account_id: "7526998186", sync_error: null },
    ];
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.google_ads.status).toBe("connected");
  });

  it("maps a 'pending' sync_status (a fresh pairing) to pending, not disconnected", async () => {
    store["shop_integrations"] = [
      { shop_id: "shop-X", kind: "google_ads", sync_status: "pending", connected_at: "2026-06-07T04:26:07Z", external_account_id: "7526998186", sync_error: null },
    ];
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.google_ads.status).toBe("pending");
  });

  it("leaves a shop with no integration row disconnected", async () => {
    store["shop_integrations"] = [];
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.google_ads.status).toBe("disconnected");
  });

  it("maps a 'reauth' sync_status (dead refresh token) to reauth, not disconnected", async () => {
    store["shop_integrations"] = [
      { shop_id: "shop-X", kind: "google_ads", sync_status: "reauth", connected_at: "2026-06-07T04:26:07Z", external_account_id: "7526998186", sync_error: "Google OAuth token exchange failed (invalid_grant): Token has been expired or revoked." },
    ];
    const out = await calderynClient("x.myshopify.com").integrations.list();
    expect(out.google_ads.status).toBe("reauth");
    // Merchant-facing detail is a friendly prompt, not the raw OAuth error string.
    expect(out.google_ads.detail).toBe("Connection expired — reconnect to resume syncing");
  });

  it("shows a plain-language detail for a CUSTOMER_NOT_ENABLED sync error, not the raw API string", async () => {
    store["shop_integrations"] = [
      {
        shop_id: "shop-X",
        kind: "google_ads",
        sync_status: "error",
        connected_at: "2026-06-20T17:30:24Z",
        external_account_id: "5673422352",
        sync_error:
          "Google Ads API error: The caller does not have permission — CUSTOMER_NOT_ENABLED: The customer account can't be accessed because it is not yet enabled or has been deactivated.",
      },
    ];
    const out = await calderynClient("x.myshopify.com").integrations.list();
    // The errored row is still not paired (Connect button shows), but the detail
    // the merchant reads explains the problem instead of dumping the API string.
    expect(out.google_ads.status).toBe("disconnected");
    expect(out.google_ads.detail).toMatch(/google ads account/i);
    expect(out.google_ads.detail).not.toMatch(/CUSTOMER_NOT_ENABLED|does not have permission/i);
  });
});
