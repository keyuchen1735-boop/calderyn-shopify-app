/* eslint-disable @typescript-eslint/no-explicit-any -- in-memory fake mirrors supabase-js's loosely-typed query builder */
//
// UUID fast-path regression guard for resolveShopId.
//
// resolveShopId accepts either a Shopify shop domain OR a shops.id UUID.
// When a UUID is passed, it returns immediately without any DB round-trip.
// When a domain is passed, it queries shops.shop_domain and returns the id.
//
// Both tests call the REAL resolveShopId. @supabase/supabase-js is mocked so
// getSupabase() returns a fake client whose .from() is interceptable.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoist the mock factory so we can reconfigure it per-test.
const mockFrom = vi.fn();
const mockClient = { from: mockFrom };

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => mockClient),
}));

// ── (a) UUID fast-path ───────────────────────────────────────────────────────
// The real resolveShopId is used. The UUID regex guard returns before
// getSupabase() is ever called.

describe("resolveShopId UUID fast-path (real implementation)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide credentials so getSupabase() can initialise without throwing.
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key-" + "x".repeat(40);
  });

  it("returns the UUID directly without querying the DB", async () => {
    const { resolveShopId } = await import("../supabase.server");

    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const result = await resolveShopId(uuid);

    expect(result).toBe(uuid);
    // from() must not have been called for a UUID input.
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// ── (b) Domain lookup path ────────────────────────────────────────────────────
// Calls the REAL resolveShopId with a domain input. The @supabase/supabase-js
// mock returns a fake client so from("shops") is interceptable. Asserts the
// real function queries from("shops") and returns the row id.

describe("resolveShopId domain lookup contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = "https://test.supabase.co";
    process.env.SUPABASE_SECRET_KEY = "test-key-" + "x".repeat(40);
  });

  it("queries shops.shop_domain and returns the matching row id", async () => {
    const maybeSingle = vi.fn();
    maybeSingle.mockResolvedValue({ data: { id: "shop-db-uuid" }, error: null });
    const builder: any = { select: () => builder, eq: () => builder, maybeSingle };
    mockFrom.mockReturnValue(builder);

    const { resolveShopId } = await import("../supabase.server");
    const DOMAIN = "test-lookup-2.myshopify.com";
    const result = await resolveShopId(DOMAIN);

    expect(result).toBe("shop-db-uuid");
    expect(mockFrom).toHaveBeenCalledWith("shops");
    expect(maybeSingle).toHaveBeenCalled();
  });

  it("a UUID input passes the regex guard and never reaches the DB", () => {
    const SHOP_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(SHOP_ID_RE.test("a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toBe(true);
    expect(SHOP_ID_RE.test("test.myshopify.com")).toBe(false);
    expect(SHOP_ID_RE.test("AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE")).toBe(true);
  });
});
