/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake supabase for transform integration tests */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { canonicalTopic, transformPendingWebhooks } from "../transform.server";

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

// ---------------------------------------------------------------------------
// Integration tests for transformPendingWebhooks — fake Supabase harness
// ---------------------------------------------------------------------------

const SHOP_ID = "00000000-0000-0000-0000-000000000001";
const ORDER_UUID = "00000000-0000-0000-0000-000000000099";

// Tables seeded per test; extended to include attribution tables.
type Row = Record<string, any>;
const store: Record<string, Row[]> = {};
// Records upserts made during a test run.
const upserts: Array<{ table: string; rows: unknown; opts?: unknown }> = [];
// Records inserts (e.g. attribution_fact) made during a test run.
const inserts: Array<{ table: string; rows: unknown }> = [];
// Records deletes (e.g. attribution_fact replace) made during a test run.
const deletes: Array<{ table: string }> = [];
// Records updates (e.g. processed_at stamps) made during a test run.
const updates: Array<{ table: string; set: unknown }> = [];

// Tables whose SELECT should resolve with an error (simulate a transient read
// failure). Cleared each test.
const failReadTables = new Set<string>();

function makeBuilder(table: string): any {
  const filters: Array<[string, any]> = [];
  const matches = () => (store[table] ?? []).filter((r) => filters.every(([k, v]) => r[k] === v));
  const readErr = () => (failReadTables.has(table) ? new Error(`read failed: ${table}`) : null);

  const api: any = {
    select: (_cols?: string) => api,
    order: () => api,
    limit: () => api,
    is: () => api,
    eq: (k: string, v: any) => { filters.push([k, v]); return api; },
    maybeSingle: async () => ({ data: matches()[0] ?? null, error: readErr() }),
    single: async () => ({ data: store[table + "_upsert_result"]?.[0] ?? { id: ORDER_UUID }, error: null }),
    upsert: (rows: unknown, opts?: unknown) => {
      upserts.push({ table, rows, opts });
      // Return a chainable object that also supports .select().single()
      const upsertChain: any = {
        select: (_cols?: string) => upsertChain,
        single: async () => ({ data: { id: ORDER_UUID }, error: null }),
        then: (resolve: (r: { data: unknown; error: null }) => unknown) =>
          resolve({ data: [], error: null }),
      };
      return upsertChain;
    },
    update: (set: unknown) => {
      updates.push({ table, set });
      return api;
    },
    insert: (rows: unknown) => {
      inserts.push({ table, rows });
      return api;
    },
    delete: () => {
      deletes.push({ table });
      return api;
    },
    then: (resolve: (r: { data: any; error: any }) => unknown) =>
      resolve({ data: matches(), error: readErr() }),
  };
  return api;
}

vi.mock("../../supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => makeBuilder(t) }),
}));

vi.mock("../dlq.server", () => ({
  writeDlq: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  // Clear store, upserts, updates between tests.
  for (const k of Object.keys(store)) delete store[k];
  upserts.length = 0;
  inserts.length = 0;
  deletes.length = 0;
  updates.length = 0;
  failReadTables.clear();
});

describe("transformPendingWebhooks — order write ordering", () => {
  function seedOrderWithLines() {
    store["raw_shopify_webhook"] = [
      {
        id: "wh-ord",
        shop_id: SHOP_ID,
        topic: "ORDERS_CREATE",
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/9",
          name: "#1009",
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
          total_price: "50.00",
          currency: "USD",
          line_items: [
            { admin_graphql_api_id: "gid://shopify/LineItem/1", quantity: 1, price: "50.00", variant_id: 200 },
          ],
        },
      },
    ];
    store["sku_dim"] = [{ id: "sku-1", shop_id: SHOP_ID, external_id: "gid://shopify/ProductVariant/200" }];
  }

  it("does not write the order header when the sku_dim read fails (no revenue-without-lines)", async () => {
    seedOrderWithLines();
    failReadTables.add("sku_dim");

    await transformPendingWebhooks();

    // Reads happen before any write, so a transient sku_dim read failure aborts
    // before the order_fact header is committed — no partial order is left behind.
    expect(upserts.some((u) => u.table === "order_fact")).toBe(false);
    expect(upserts.some((u) => u.table === "order_line_fact")).toBe(false);
  });

  it("writes header and lines together on the happy path", async () => {
    seedOrderWithLines();

    await transformPendingWebhooks();

    expect(upserts.some((u) => u.table === "order_fact")).toBe(true);
    expect(upserts.some((u) => u.table === "order_line_fact")).toBe(true);
  });
});

describe("transformPendingWebhooks — attribution", () => {
  it("writes attribution_fact when an order carries a matching utm_campaign", async () => {
    // Arrange: one pending ORDERS_CREATE webhook with a matching landing_site.
    store["raw_shopify_webhook"] = [
      {
        id: "wh-1",
        shop_id: SHOP_ID,
        topic: "ORDERS_CREATE",
        payload: {
          admin_graphql_api_id: "gid://shopify/Order/1",
          name: "#1001",
          created_at: "2026-06-01T00:00:00Z",
          updated_at: "2026-06-01T00:00:00Z",
          total_price: "100.00",
          subtotal_price: "90.00",
          total_tax: "5.00",
          total_discounts: "0.00",
          currency: "USD",
          financial_status: "paid",
          // utm_campaign matches the campaign in ad_campaign_dim
          landing_site: "/products/x?utm_campaign=Spring%20Sale&utm_source=facebook",
          line_items: [],
        },
      },
    ];
    // ad_campaign_dim returns a campaign named "Spring Sale"
    store["ad_campaign_dim"] = [
      { id: "u-meta", shop_id: SHOP_ID, external_id: "1", name: "Spring Sale", platform: "meta" },
    ];
    // sku_dim empty (no line items)
    store["sku_dim"] = [];

    await transformPendingWebhooks();

    // Assert: an insert to attribution_fact occurred with the matched campaign
    // (one-row-per-order: prior row deleted, then inserted).
    expect(deletes.some((d) => d.table === "attribution_fact")).toBe(true);
    const af = inserts.find((u) => u.table === "attribution_fact");
    expect(af, "expected an attribution_fact insert").toBeDefined();
    expect((af?.rows as Record<string, unknown>)).toMatchObject({
      shop_id: SHOP_ID,
      order_id: ORDER_UUID,
      campaign_id: "u-meta",
      attribution_method: "utm_exact",
    });
  });
});
