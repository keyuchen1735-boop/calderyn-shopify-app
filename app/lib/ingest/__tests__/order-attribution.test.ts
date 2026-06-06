import { describe, it, expect } from "vitest";
import { parseOrderWebhook } from "../mappers.server";

const base = {
  admin_graphql_api_id: "gid://shopify/Order/1",
  name: "#1001",
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
  total_price: "100.00",
  currency: "USD",
  line_items: [],
};

describe("parseOrderWebhook attribution capture", () => {
  it("captures landing_site, referring_site and parses utm + click-ids", () => {
    const { order, clickRef } = parseOrderWebhook({
      ...base,
      landing_site: "/products/x?utm_source=facebook&utm_campaign=spring&fbclid=ABC",
      referring_site: "https://l.facebook.com/",
    });
    expect(order.landing_site).toBe("/products/x?utm_source=facebook&utm_campaign=spring&fbclid=ABC");
    expect(order.referring_site).toBe("https://l.facebook.com/");
    expect(order.utm_source).toBe("facebook");
    expect(order.utm_campaign).toBe("spring");
    expect(clickRef.clickIds).toEqual({ fbclid: "ABC" });
    expect(clickRef.utm).toMatchObject({ utm_source: "facebook", utm_campaign: "spring" });
    expect(clickRef.referringSite).toBe("https://l.facebook.com/");
  });

  it("defaults attribution fields to null when absent", () => {
    const { order, clickRef } = parseOrderWebhook(base);
    expect(order.landing_site).toBeNull();
    expect(order.utm_source).toBeNull();
    expect(clickRef.clickIds).toEqual({});
  });
});
