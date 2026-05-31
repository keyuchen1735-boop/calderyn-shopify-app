import { describe, it, expect } from "vitest";
import { canonicalTopic } from "../transform.server";

// Regression guard for the topic-format mismatch: Shopify's authenticate.webhook
// returns topics in storage form (e.g. "ORDERS_CREATE"), which is what lands in
// raw_shopify_webhook.topic. The transform dispatcher must match that, not the
// lowercase-slash form.
describe("canonicalTopic", () => {
  it("normalizes Shopify storage-form topics to themselves", () => {
    expect(canonicalTopic("ORDERS_CREATE")).toBe("ORDERS_CREATE");
    expect(canonicalTopic("INVENTORY_LEVELS_UPDATE")).toBe("INVENTORY_LEVELS_UPDATE");
  });

  it("normalizes the lowercase-slash form to storage form", () => {
    expect(canonicalTopic("orders/create")).toBe("ORDERS_CREATE");
    expect(canonicalTopic("inventory_levels/update")).toBe("INVENTORY_LEVELS_UPDATE");
  });

  it("normalizes the dotted form too", () => {
    expect(canonicalTopic("app.uninstalled")).toBe("APP_UNINSTALLED");
  });
});
