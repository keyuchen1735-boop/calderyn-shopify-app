import { describe, it, expect } from "vitest";
import {
  gidToId,
  moneyToCents,
  mapLocation,
  mapVariantToSku,
  mapOrder,
  mapOrderLines,
  parseInventoryWebhook,
  parseProductWebhook,
  parseOrderWebhook,
  parseRefundWebhook,
  minimizeOrderWebhook,
  minimizeRefundWebhook,
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
      inventoryPolicy: "DENY",
    };
    expect(mapVariantToSku(SHOP, product, variant)).toEqual({
      shop_id: SHOP,
      external_id: "gid://shopify/ProductVariant/200",
      product_id: "gid://shopify/Product/100",
      inventory_item_id: "gid://shopify/InventoryItem/300",
      sku: "WID-1",
      title: "Widget — Small",
      unit_cost_cents: 450,
      retail_price_cents: null,
      product_status: null,
      currency: "USD",
      category: null,
      vendor: null,
      tags: [],
      collections: [],
      inventory_policy: "deny",
      inventory_tracked: false,
    });
  });

  it("maps Shopify inventory policy and tracking state", () => {
    const row = mapVariantToSku(
      SHOP,
      { id: "gid://shopify/Product/100", title: "Widget" },
      {
        id: "gid://shopify/ProductVariant/200",
        inventoryPolicy: "CONTINUE",
        inventoryItem: {
          id: "gid://shopify/InventoryItem/300",
          tracked: true,
          unitCost: null,
        },
      },
    );
    expect(row.inventory_policy).toBe("continue");
    expect(row.inventory_tracked).toBe(true);
  });

  it("maps product facets: productType→category, vendor, tags, collections (trimmed)", () => {
    const product = {
      id: "gid://shopify/Product/100",
      title: "Widget",
      vendor: "  Acme  ",
      productType: " Gadgets ",
      tags: [" new ", "sale", ""],
      collections: { nodes: [{ title: "Best Sellers" }, { title: " " }, { title: null }] },
    };
    const variant = { id: "gid://shopify/ProductVariant/200", title: "Default Title", inventoryItem: { id: null } };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.category).toBe("Gadgets");
    expect(row.vendor).toBe("Acme");
    expect(row.tags).toEqual(["new", "sale"]);
    expect(row.collections).toEqual(["Best Sellers"]);
  });
  it("tolerates missing unit cost and sku", () => {
    const product = { id: "gid://shopify/Product/100", title: "Widget" };
    const variant = { id: "gid://shopify/ProductVariant/200", title: "Default Title", inventoryItem: { id: null } };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.unit_cost_cents).toBeNull();
    expect(row.sku).toBeNull();
    expect(row.title).toBe("Widget");
  });

  it("captures retail price in cents and lowercased product status", () => {
    const product = { id: "gid://shopify/Product/1", title: "Tee", status: "ACTIVE" };
    const variant = {
      id: "gid://shopify/ProductVariant/9",
      sku: "TEE-1",
      title: "S",
      price: "24.00",
      inventoryPolicy: "DENY",
      inventoryItem: { id: "gid://shopify/InventoryItem/3", tracked: true, unitCost: { amount: "9.00" } },
    };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.retail_price_cents).toBe(2400);
    expect(row.product_status).toBe("active");
  });

  it("nulls retail price when absent", () => {
    const product = { id: "gid://shopify/Product/1", title: "Tee", status: "ACTIVE" };
    const variant = { id: "gid://shopify/ProductVariant/9", title: "S", inventoryItem: { id: null } };
    const row = mapVariantToSku(SHOP, product, variant);
    expect(row.retail_price_cents).toBeNull();
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
          variant: {
            id: "gid://shopify/ProductVariant/200",
            inventoryItem: {
              measurement: { weight: { value: 250, unit: "GRAMS" } },
            },
          },
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
      landing_site: null,
      referring_site: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    });
  });

  it("maps order lines, carrying the variant GID and computed grams", () => {
    // Fixture has weight: 250 g/unit × 3 qty = 750 g total.
    expect(mapOrderLines(orderNode)).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
        grams: 750,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// grams: line-item weight ingestion
// ---------------------------------------------------------------------------

describe("mapOrderLines — grams", () => {
  // Derive the node element type from mapOrderLines' parameter so this helper
  // stays in sync with the function signature without requiring an extra export.
  type OrderParam = Parameters<typeof mapOrderLines>[0];
  type LineNode = NonNullable<NonNullable<OrderParam["lineItems"]>["nodes"]>[number];

  // Shared order scaffold — only lineItems.nodes changes per case.
  function makeOrder(nodes: LineNode[]) {
    return {
      id: "gid://shopify/Order/901",
      name: "#1002",
      createdAt: "2026-05-02T00:00:00Z",
      updatedAt: "2026-05-02T00:00:00Z",
      lineItems: { nodes },
    };
  }

  it("stores total line grams (unit_grams × qty) when variant weight is in GRAMS", () => {
    // 250 g/unit × 3 qty = 750 g total
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/10",
        quantity: 3,
        variant: {
          id: "gid://shopify/ProductVariant/200",
          inventoryItem: {
            measurement: { weight: { value: 250, unit: "GRAMS" } },
          },
        },
        originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBe(750);
  });

  it("converts KILOGRAMS to grams (×1000) before multiplying by quantity", () => {
    // 0.5 kg/unit × 2 qty = 1000 g total
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/11",
        quantity: 2,
        variant: {
          id: "gid://shopify/ProductVariant/201",
          inventoryItem: {
            measurement: { weight: { value: 0.5, unit: "KILOGRAMS" } },
          },
        },
        originalUnitPriceSet: { shopMoney: { amount: "20.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBe(1000);
  });

  it("converts POUNDS to grams (×453.592) and rounds to nearest integer", () => {
    // 1 lb/unit × 1 qty ≈ 454 g
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/12",
        quantity: 1,
        variant: {
          id: "gid://shopify/ProductVariant/202",
          inventoryItem: {
            measurement: { weight: { value: 1, unit: "POUNDS" } },
          },
        },
        originalUnitPriceSet: { shopMoney: { amount: "30.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBe(454);
  });

  it("converts OUNCES to grams (×28.3495) and rounds to nearest integer", () => {
    // 16 oz/unit × 1 qty ≈ 454 g
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/13",
        quantity: 1,
        variant: {
          id: "gid://shopify/ProductVariant/203",
          inventoryItem: {
            measurement: { weight: { value: 16, unit: "OUNCES" } },
          },
        },
        originalUnitPriceSet: { shopMoney: { amount: "40.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBe(454);
  });

  it("yields null grams when variant is null (e.g. deleted product)", () => {
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/14",
        quantity: 1,
        variant: null,
        originalUnitPriceSet: { shopMoney: { amount: "5.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBeNull();
  });

  it("yields null grams when inventoryItem is missing", () => {
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/15",
        quantity: 1,
        variant: { id: "gid://shopify/ProductVariant/204", inventoryItem: null },
        originalUnitPriceSet: { shopMoney: { amount: "5.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBeNull();
  });

  it("yields null grams when measurement weight value is 0", () => {
    // A variant with 0 weight is treated as unknown (not weighing nothing).
    const order = makeOrder([
      {
        id: "gid://shopify/LineItem/16",
        quantity: 2,
        variant: {
          id: "gid://shopify/ProductVariant/205",
          inventoryItem: {
            measurement: { weight: { value: 0, unit: "GRAMS" } },
          },
        },
        originalUnitPriceSet: { shopMoney: { amount: "5.00" } },
      },
    ]);
    expect(mapOrderLines(order)[0].grams).toBeNull();
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

describe("parseProductWebhook", () => {
  it("normalizes variant inventory settings from products/update", () => {
    expect(
      parseProductWebhook({
        id: 100,
        admin_graphql_api_id: "gid://shopify/Product/100",
        title: "Widget",
        vendor: "Acme",
        product_type: "Gadgets",
        tags: "new, sale",
        variants: [
          {
            id: 200,
            admin_graphql_api_id: "gid://shopify/ProductVariant/200",
            inventory_item_id: 300,
            sku: "WID-1",
            title: "Small",
            inventory_policy: "continue",
            inventory_management: "shopify",
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        external_id: "gid://shopify/ProductVariant/200",
        product_id: "gid://shopify/Product/100",
        inventory_item_id: "gid://shopify/InventoryItem/300",
        inventory_policy: "continue",
        inventory_tracked: true,
      }),
    ]);
  });

  it("captures variant price and product status from products/update", () => {
    const [row] = parseProductWebhook({
      admin_graphql_api_id: "gid://shopify/Product/100",
      title: "Widget",
      status: "active",
      variants: [
        { admin_graphql_api_id: "gid://shopify/ProductVariant/200", price: "24.00" },
      ],
    });
    expect(row.retail_price_cents).toBe(2400);
    expect(row.product_status).toBe("active");
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
      landing_site: null,
      referring_site: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      utm_content: null,
      utm_term: null,
    });
    expect(parsed.lines).toEqual([
      {
        sku_external_id: "gid://shopify/ProductVariant/200",
        external_line_id: "gid://shopify/LineItem/1",
        quantity: 3,
        price_cents: 1800,
        total_cents: 5400,
        // REST webhook has no variant weight data; grams is always null.
        grams: null,
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

  // A missing admin_graphql_api_id (malformed payload) must fail loudly so the
  // webhook is retried/DLQ'd — not coerced to the string "undefined", which
  // collapses every such order/line onto one sentinel external id (silent loss).
  it("throws when the order has no admin_graphql_api_id", () => {
    expect(() =>
      parseOrderWebhook({
        name: "#1004",
        created_at: "2026-05-04T00:00:00Z",
        total_price: "5.00",
      } as never),
    ).toThrow();
  });

  it("throws when a line item has no admin_graphql_api_id", () => {
    expect(() =>
      parseOrderWebhook({
        admin_graphql_api_id: "gid://shopify/Order/903",
        name: "#1005",
        created_at: "2026-05-05T00:00:00Z",
        total_price: "5.00",
        line_items: [{ quantity: 1, price: "5.00" } as never],
      }),
    ).toThrow();
  });
});

describe("parseRefundWebhook", () => {
  it("normalizes a refunds/create payload", () => {
    const parsed = parseRefundWebhook({
      admin_graphql_api_id: "gid://shopify/Refund/500",
      id: 500,
      order_id: 900,
      created_at: "2026-05-10T10:00:00Z",
      processed_at: "2026-05-10T12:00:00Z",
      refund_line_items: [
        {
          id: 7001,
          quantity: 2,
          subtotal_set: { shop_money: { amount: "36.00" } },
          line_item: { variant_id: 200 },
        },
      ],
    });
    expect(parsed).toEqual({
      external_id: "gid://shopify/Refund/500",
      order_external_id: "gid://shopify/Order/900",
      processed_at: "2026-05-10T12:00:00Z",
      source_version: Date.parse("2026-05-10T12:00:00Z"),
      lines: [
        {
          sku_external_id: "gid://shopify/ProductVariant/200",
          external_line_id: "gid://shopify/RefundLineItem/7001",
          quantity: 2,
          subtotal_cents: 3600,
        },
      ],
    });
  });

  it("falls back to the bare `subtotal` when subtotal_set is absent", () => {
    const parsed = parseRefundWebhook({
      id: 501,
      order_id: 901,
      processed_at: "2026-05-11T00:00:00Z",
      refund_line_items: [{ id: 7002, quantity: 1, subtotal: "12.50", line_item: { variant_id: 5 } }],
    });
    expect(parsed.lines[0].subtotal_cents).toBe(1250);
    // No admin_graphql_api_id → external_id constructed from the numeric id.
    expect(parsed.external_id).toBe("gid://shopify/Refund/501");
  });

  it("maps a refund line with no variant to a null sku reference", () => {
    const parsed = parseRefundWebhook({
      id: 502,
      order_id: 902,
      processed_at: "2026-05-12T00:00:00Z",
      refund_line_items: [{ id: 7003, quantity: 1, subtotal: "5.00" }],
    });
    expect(parsed.lines[0].sku_external_id).toBeNull();
  });

  it("falls back to created_at when processed_at is missing", () => {
    const parsed = parseRefundWebhook({
      id: 503,
      order_id: 903,
      created_at: "2026-05-13T00:00:00Z",
      refund_line_items: [],
    });
    expect(parsed.processed_at).toBe("2026-05-13T00:00:00Z");
  });

  it("nulls the order reference when order_id is absent", () => {
    const parsed = parseRefundWebhook({
      id: 504,
      processed_at: "2026-05-14T00:00:00Z",
      refund_line_items: [],
    });
    expect(parsed.order_external_id).toBeNull();
  });

  it("throws when the refund has no id (malformed payload must be retried)", () => {
    expect(() =>
      parseRefundWebhook({ order_id: 905, processed_at: "2026-05-15T00:00:00Z" } as never),
    ).toThrow();
  });

  it("throws when a refund line item has no id", () => {
    expect(() =>
      parseRefundWebhook({
        id: 506,
        order_id: 906,
        processed_at: "2026-05-16T00:00:00Z",
        refund_line_items: [{ quantity: 1, subtotal: "5.00" } as never],
      }),
    ).toThrow();
  });

  it("minimizeRefundWebhook drops unused fields and parses identically", () => {
    const full = {
      admin_graphql_api_id: "gid://shopify/Refund/700",
      id: 700,
      order_id: 950,
      created_at: "2026-05-20T00:00:00Z",
      processed_at: "2026-05-20T01:00:00Z",
      note: "internal note — not stored",
      user_id: 42,
      transactions: [{ id: 1, gateway: "shopify_payments", amount: "36.00" }],
      refund_line_items: [
        {
          id: 7100,
          quantity: 2,
          line_item_id: 1,
          subtotal: "36.00",
          subtotal_set: { shop_money: { amount: "36.00", currency_code: "USD" } },
          line_item: { id: 1, variant_id: 200, title: "X", sku: "X-1" },
        },
      ],
    };
    expect(parseRefundWebhook(minimizeRefundWebhook(full))).toEqual(parseRefundWebhook(full));
  });
});

describe("moneyToCents empty string", () => {
  it("treats empty string as 0", () => {
    expect(moneyToCents("")).toBe(0);
  });
});

describe("minimizeOrderWebhook", () => {
  // A realistic orders/create REST webhook body: the order fields the pipeline
  // reads, PLUS the customer PII Shopify always includes (and we must not store).
  const fullPayload = {
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
    total_shipping_price_set: { shop_money: { amount: "5.00", currency_code: "USD" } },
    landing_site: "/?utm_source=meta",
    referring_site: "https://l.facebook.com/",
    line_items: [
      { admin_graphql_api_id: "gid://shopify/LineItem/1", quantity: 3, price: "18.00", variant_id: 200, title: "Widget" },
    ],
    // --- customer PII that must never be stored ---
    email: "jane@example.com",
    phone: "+1-555-0100",
    customer: { id: 1, first_name: "Jane", last_name: "Doe", email: "jane@example.com" },
    billing_address: { name: "Jane Doe", address1: "1 Main St", city: "Springfield", zip: "00000" },
    shipping_address: { name: "Jane Doe", address1: "1 Main St", city: "Springfield", zip: "00000" },
    note: "leave at the door",
    browser_ip: "203.0.113.7",
  };

  it("drops every customer-PII field", () => {
    const min = minimizeOrderWebhook(fullPayload) as Record<string, unknown>;
    for (const k of ["email", "phone", "customer", "billing_address", "shipping_address", "note", "browser_ip"]) {
      expect(min[k]).toBeUndefined();
    }
    // line items keep only the read fields — no titles or other extras
    expect(Object.keys((min.line_items as Record<string, unknown>[])[0]).sort()).toEqual(
      ["admin_graphql_api_id", "price", "quantity", "variant_id"],
    );
  });

  it("is lossless: the stripped body parses to exactly the same result", () => {
    expect(parseOrderWebhook(minimizeOrderWebhook(fullPayload))).toEqual(parseOrderWebhook(fullPayload));
  });
});
