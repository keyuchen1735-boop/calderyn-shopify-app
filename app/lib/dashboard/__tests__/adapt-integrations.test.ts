import { describe, it, expect } from "vitest";
import { adaptIntegrations } from "~/lib/dashboard/client";
import type { Integration } from "~/lib/types";

// Dashboard parity (contract C7/§7): the dashboard re-renders the EasyPost
// connector READ-ONLY (status pill only) via adaptIntegrations once the kind is
// in the integrations record + ordering. No connect/disconnect on the dashboard.

const rec = (over: Partial<Record<string, Integration>> = {}): Record<string, Integration> => ({
  shopify: { name: "Shopify", status: "connected", detail: "x.myshopify.com", logoCls: "logo-shopify" },
  easypost_ship: {
    name: "EasyPost",
    status: "connected",
    detail: "Connected 2026-06-16",
    logoCls: "logo-easypost",
  },
  ...over,
});

describe("adaptIntegrations — EasyPost parity", () => {
  it("surfaces the easypost_ship kind as an IntegrationVM the read-only pill renders", () => {
    const vms = adaptIntegrations(rec());
    const ep = vms.find((v) => v.key === "easypost_ship");
    expect(ep).toBeTruthy();
    expect(ep).toMatchObject({ name: "EasyPost", status: "connected", logoCls: "logo-easypost" });
  });

  it("orders EasyPost deterministically (in INTEGRATION_ORDER, not the alpha tail)", () => {
    // Provide all known kinds out of order; EasyPost must sort to its fixed slot
    // (after quickbooks), not get pushed to the alphabetical tail.
    const full = rec({
      meta_ads: { name: "Meta Ads", status: "disconnected", detail: "", logoCls: "logo-meta" },
      google_ads: { name: "Google Ads", status: "disconnected", detail: "", logoCls: "logo-google" },
      tiktok_ads: { name: "TikTok Ads", status: "disconnected", detail: "", logoCls: "logo-tiktok" },
      quickbooks: { name: "QuickBooks", status: "disconnected", detail: "", logoCls: "logo-quickbooks" },
    });
    const keys = adaptIntegrations(full).map((v) => v.key);
    expect(keys).toEqual([
      "shopify",
      "meta_ads",
      "google_ads",
      "tiktok_ads",
      "quickbooks",
      "easypost_ship",
    ]);
  });
});
