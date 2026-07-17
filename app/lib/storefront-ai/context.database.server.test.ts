import { beforeEach, describe, expect, it, vi } from "vitest";

let tableRows: Record<string, Array<Record<string, unknown>>> = {};
const ranges: Record<string, Array<[number, number]>> = {};

function builder(table: string) {
  let range: [number, number] | null = null;
  let limit: number | null = null;
  const query: Record<string, unknown> = {};
  const chain = () => query;
  Object.assign(query, {
    select: chain,
    eq: chain,
    in: chain,
    not: chain,
    order: chain,
    limit: (value: number) => { limit = value; return query; },
    range: (from: number, to: number) => {
      range = [from, to];
      (ranges[table] ??= []).push(range);
      return query;
    },
    maybeSingle: () => Promise.resolve({
      data: table === "store_settings"
        ? { store_name: "Store", logo_url: null }
        : table === "shops" ? { display_name: "Store" } : null,
      error: null,
    }),
    then: (resolve: (value: unknown) => unknown) => {
      const rows = tableRows[table] ?? [];
      const selected = range
        ? rows.slice(range[0], range[1] + 1)
        : rows.slice(0, Math.min(limit ?? 1_000, 1_000));
      return Promise.resolve({ data: selected, error: null }).then(resolve);
    },
  });
  return query;
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: (table: string) => builder(table) }),
}));

beforeEach(() => {
  tableRows = {};
  for (const key of Object.keys(ranges)) delete ranges[key];
});

describe("database storefront context source", () => {
  it("counts collection memberships beyond the PostgREST page boundary", async () => {
    const collectionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    tableRows.collection_dim = [{ id: collectionId, handle: "complete", title: "Complete" }];
    tableRows.product_collection = Array.from({ length: 1_001 }, (_, index) => ({
      collection_id: collectionId,
      product_id: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    }));

    const { assembleStorefrontContext } = await import("./context.server");
    const context = await assembleStorefrontContext({
      shopId: "11111111-1111-4111-8111-111111111111",
      prompt: "Build a store",
    });

    expect(context.collections).toEqual([
      expect.objectContaining({ id: "collection-001", handle: "complete", productCount: 1_001 }),
    ]);
    expect(ranges.product_collection).toEqual([[0, 999], [1_000, 1_999]]);
  });

  it("pages every child row needed by the bounded product sample", async () => {
    const productId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    tableRows.product_dim = [{ id: productId, handle: "product", title: "Product", category: null, tags: [] }];
    tableRows.variant_dim = Array.from({ length: 1_001 }, (_, index) => ({
      id: `variant-${index}`,
      product_id: productId,
      retail_price_cents: index + 1,
      currency: "USD",
      inventory_tracked: false,
      inventory_on_hand: 0,
    }));

    const { assembleStorefrontContext } = await import("./context.server");
    const context = await assembleStorefrontContext({
      shopId: "11111111-1111-4111-8111-111111111111",
      prompt: "Build a store",
    });

    expect(context.products[0]).toMatchObject({ priceMin: 1, priceMax: 1_001 });
    expect(ranges.variant_dim).toEqual([[0, 999], [1_000, 1_999]]);
    expect(ranges.product_option).toEqual([[0, 999]]);
    expect(ranges.product_media).toEqual([[0, 999]]);
    expect(ranges.product_collection).toEqual([[0, 999]]);
  });
});
