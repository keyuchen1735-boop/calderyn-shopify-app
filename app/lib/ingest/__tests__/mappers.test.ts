import { describe, it, expect } from "vitest";
import {
  gidToId,
  moneyToCents,
  mapLocation,
  mapVariantToSku,
  mapOrder,
  mapOrderLines,
  parseInventoryWebhook,
  parseOrderWebhook,
} from "../mappers.server";

describe("gidToId", () => {
  it("extracts the trailing id from a Shopify GID", () => {
    expect(gidToId("gid://shopify/ProductVariant/12345")).toBe("12345");
  });
  it("returns the input unchanged when no slash segment", () => {
    expect(gidToId("12345")).toBe("12345");
  });
});

describe("moneyToCents", () => {
  it("converts decimal strings to integer cents", () => {
    expect(moneyToCents("19.99")).toBe(1999);
  });
  it("treats null/undefined as 0", () => {
    expect(moneyToCents(null)).toBe(0);
    expect(moneyToCents(undefined)).toBe(0);
  });
});

const SHOP = "00000000-0000-0000-0000-000000000001";

describe("mapLocation", () => {
  it("maps a location node", () => {
    expect(
      mapLocation(SHOP, { id: "gid://shopify/Location/7", name: "Main", isActive: true }),
    ).toEqual({ shop_id: SHOP, external_id: "gid://shopify/Location/7", name: "Main", active: true });
  });
});

describe("mapVariantToSku", () => {
  it("maps a variant + product into a sku row with unit cost in cents", () => {
    const product = { id: "gid://shopify/Product/100", title: "Widget" };
    const variant = {
      id: "gid://shopify/ProductVariant/200",
      sku: "WID-1",
      title: "Small",
      inventoryItem: { id: "gid://shopify/InventoryItem/300", unitCost: { amount: "4.50" } },
    };
    expect(mapVariantToSku(SHOP, product, variant)).toEqual({
      shop_id: SHOP,
      external_id: "gid://shopify/ProductVariant/200",
      product_id: "gid://shopify/Product/100",
      inventory_item_id: "gid://shopify/InventoryItem/300",
      sku: "WID-1",
      title: "Widget — Small",
      unit_cost_cents: 450,
      currency: "USD",
      tags: [],
    });
  });
  it("tolerates missing unit cost and sku", () => {
    const product = { id: "gid://shopify/Product/100", title: "Widget" };
    const variant = { id: "gid://shopify/ProductVariant/200", title: "Default Title", inventoryItem: { id: null } };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.unit_cost_cents).toBeNull();
    expect(row.sku).toBeNull();
    expect(row.title).toBe("Widget");
  });
});

describe("mapOrder / mapOrderLines", () => {
  const orderNode = {
    id: "gid://shopify/Order/900",
    name: "#1001",
    createdAt: "2026-05-01T12:00:00Z",
    updatedAt: "2026-05-01T12:00:00Z",
    displayFinancialStatus: "PAID",
    currentTotalPriceSet: { shopMoney: { amount: "59.97", currencyCode: "USD" } },
    currentSubtotalPriceSet: { shopMoney: { amount: "54.00" } },
    totalShippingPriceSet: { shopMoney: { amount: "5.00" } },
    currentTotalTaxSet: { shopMoney: { amount: "0.97" } },
    currentTotalDiscountsSet: { shopMoney: { amount: "0.00" } },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          quantity: 3,
          variant: { id: "gid://shopify/ProductVariant/200" },
          originalUnitPriceSet: { shopMoney: { amount: "18.00" } },
        },
      ],
    },
  };

  it("maps the order header", () => {
    expect(mapOrder(SHOP, orderNode)).toEqual({
      shop_id: SHOP,
      external_id: "gid://shopify/Order/900",
      order_number: "#1001",
      created_at_source: "2026-05-01T12:00:00Z",
      total_cents: 5997,
      subtotal_cents: 5400,
      shipping_cents: 500,
      tax_cents: 97,
      discount_cents: 0,
      currency: "USD",
      financial_status: "PAID",
      source_version: Date.parse("2026-05-01T12:00:00Z"),
    });
  });

  it("maps order lines, carrying the variant GID", () => {
    expect(mapOrderLines(orderNode)).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
      },
    ]);
  });
});

describe("parseInventoryWebhook", () => {
  it("normalizes an inventory_levels/update payload", () => {
    const payload = {
      inventory_item_id: 300,
      location_id: 7,
      available: 12,
      updated_at: "2026-05-10T00:00:00Z",
    };
    expect(parseInventoryWebhook(payload)).toEqual({
      inventory_item_external_id: "gid://shopify/InventoryItem/300",
      location_external_id: "gid://shopify/Location/7",
      available: 12,
      observed_at: "2026-05-10T00:00:00Z",
      source_version: Date.parse("2026-05-10T00:00:00Z"),
    });
  });
});

describe("parseOrderWebhook", () => {
  it("normalizes an orders/create payload", () => {
    const payload = {
      admin_graphql_api_id: "gid://shopify/Order/900",
      name: "#1001",
      created_at: "2026-05-01T12:00:00Z",
      updated_at: "2026-05-01T12:00:00Z",
      financial_status: "paid",
      currency: "USD",
      total_price: "59.97",
      subtotal_price: "54.00",
      total_tax: "0.97",
      total_discounts: "0.00",
      total_shipping_price_set: { shop_money: { amount: "5.00" } },
      line_items: [
        {
          admin_graphql_api_id: "gid://shopify/LineItem/1",
          quantity: 3,
          price: "18.00",
          variant_id: 200,
        },
      ],
    };
    const parsed = parseOrderWebhook(payload);
    expect(parsed.order).toEqual({
      external_id: "gid://shopify/Order/900",
      order_number: "#1001",
      created_at_source: "2026-05-01T12:00:00Z",
      total_cents: 5997,
      subtotal_cents: 5400,
      shipping_cents: 500,
      tax_cents: 97,
      discount_cents: 0,
      currency: "USD",
      financial_status: "paid",
      source_version: Date.parse("2026-05-01T12:00:00Z"),
    });
    expect(parsed.lines).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
      },
    ]);
  });

  it("falls back to a current timestamp when updated_at is missing", () => {
    const before = Date.now();
    const parsed = parseInventoryWebhook({ inventory_item_id: 1, location_id: 2, available: 0 });
    expect(Number.isFinite(parsed.source_version)).toBe(true);
    expect(parsed.source_version).toBeGreaterThanOrEqual(before);
    expect(Number.isNaN(Date.parse(parsed.observed_at))).toBe(false);
  });

  it("returns no lines for an order with no line_items", () => {
    const parsed = parseOrderWebhook({
      admin_graphql_api_id: "gid://shopify/Order/901",
      name: "#1002",
      created_at: "2026-05-02T00:00:00Z",
      updated_at: "2026-05-02T00:00:00Z",
      total_price: "0.00",
      subtotal_price: "0.00",
      total_tax: "0.00",
      total_discounts: "0.00",
      currency: "USD",
    });
    expect(parsed.lines).toEqual([]);
  });

  it("maps a line with no variant to a null sku reference", () => {
    const parsed = parseOrderWebhook({
      admin_graphql_api_id: "gid://shopify/Order/902",
      name: "#1003",
      created_at: "2026-05-03T00:00:00Z",
      updated_at: "2026-05-03T00:00:00Z",
      total_price: "5.00",
      line_items: [{ admin_graphql_api_id: "gid://shopify/LineItem/9", quantity: 1, price: "5.00" }],
    });
    expect(parsed.lines[0].sku_external_id).toBeNull();
  });
});

describe("moneyToCents empty string", () => {
  it("treats empty string as 0", () => {
    expect(moneyToCents("")).toBe(0);
  });
});
