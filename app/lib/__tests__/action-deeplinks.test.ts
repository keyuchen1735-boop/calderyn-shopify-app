import { describe, it, expect } from "vitest";
import { shopifyAdminUrl, actionDeepLink } from "../action-deeplinks";

describe("shopifyAdminUrl", () => {
  it("builds a shop-scoped Shopify admin URL from the myshopify domain", () => {
    expect(shopifyAdminUrl("acme.myshopify.com", "settings/shipping")).toBe(
      "https://acme.myshopify.com/admin/settings/shipping",
    );
  });
  it("tolerates a leading slash on the path", () => {
    expect(shopifyAdminUrl("acme.myshopify.com", "/settings/shipping")).toBe(
      "https://acme.myshopify.com/admin/settings/shipping",
    );
  });
});

describe("actionDeepLink", () => {
  it("maps free-shipping kinds to the Shipping settings page (no one-click executor exists)", () => {
    const raise = actionDeepLink("raise_free_ship_threshold", "acme.myshopify.com");
    expect(raise?.href).toMatch(/\/admin\/settings\/shipping$/);
    expect(raise?.label).toBeTruthy();
    expect(actionDeepLink("exclude_sku_free_ship", "acme.myshopify.com")?.href).toMatch(
      /\/admin\/settings\/shipping$/,
    );
  });
  it("maps exclude_geo to Meta Ads Manager (no per-region exclusion API; merchant adjusts targeting)", () => {
    const geo = actionDeepLink("exclude_geo", "acme.myshopify.com");
    expect(geo?.href).toMatch(/adsmanager\.facebook\.com/);
    expect(geo?.label).toBeTruthy();
  });

  it("returns null for kinds that have a real one-click executor", () => {
    expect(actionDeepLink("pause_campaign", "acme.myshopify.com")).toBeNull();
    expect(actionDeepLink("snooze_alert", "acme.myshopify.com")).toBeNull();
  });
});
