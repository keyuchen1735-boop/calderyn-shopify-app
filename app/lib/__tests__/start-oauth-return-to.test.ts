import { describe, it, expect, vi, beforeEach } from "vitest";
import { calderynClient } from "../calderyn.server";
import { parseOAuthState } from "../meta/oauth-state.server";

// Every dashboard-native OAuth connect must pack the caller's returnTo into the
// provider state so the callback lands the merchant back on the exact screen
// they connected from (meta got this in "Fix Meta return to campaign setup";
// these pin the remaining providers to the same contract).

const { insert } = vi.hoisted(() => ({
  insert: vi.fn(async () => ({ error: null })),
}));

vi.mock("../supabase.server", () => ({
  getSupabase: () => ({ from: () => ({ insert }) }),
  resolveShopId: async () => "shop-1",
}));

const ENV: Record<string, string> = {
  SHOPIFY_APP_URL: "https://app.calderyncompany.com",
  META_APP_ID: "meta-id",
  META_APP_SECRET: "meta-secret",
  GOOGLE_ADS_CLIENT_ID: "google-id",
  GOOGLE_ADS_CLIENT_SECRET: "google-secret",
  TIKTOK_APP_ID: "tiktok-id",
  TIKTOK_APP_SECRET: "tiktok-secret",
  QBO_CLIENT_ID: "qbo-id",
  QBO_CLIENT_SECRET: "qbo-secret",
  SHIPPO_CLIENT_ID: "shippo-id",
  SHIPPO_CLIENT_SECRET: "shippo-secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, ENV);
});

const PROVIDERS = ["meta", "google", "tiktok", "quickbooks", "shippo"] as const;

describe("startOAuth packs the dashboard returnTo for every provider", () => {
  it.each(PROVIDERS)("%s", async (provider) => {
    const { redirectUrl } = await calderynClient("shop-1").integrations.startOAuth(
      provider,
      null,
      false,
      true,
      "/dashboard/settings/connectors",
    );
    const state = new URL(redirectUrl).searchParams.get("state");
    expect(state).toBeTruthy();
    const ctx = parseOAuthState(state as string);
    expect(ctx.dashboard).toBe(true);
    expect(ctx.returnTo).toBe("/dashboard/settings/connectors");
  });
});
