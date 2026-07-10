// resolveHandleRedirect: shop-scoped miss-path lookup behind the PDP 301.
// Must resolve only to an ACTIVE target's current handle, never to itself
// (loop guard), and skip the DB entirely for non-uuid (demo/fixture) shops.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let redirectRow: Row | null = null;
let productRow: Row | null = null;
let forcedError: { message: string } | null = null;
const queries: Array<{ table: string; filters: Record<string, unknown> }> = [];

function builder(table: string) {
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {
    select() { return b; },
    eq(col: string, val: unknown) { filters[col] = val; return b; },
    maybeSingle() {
      queries.push({ table, filters });
      if (forcedError) return Promise.resolve({ data: null, error: forcedError });
      const data = table === "product_handle_redirect" ? redirectRow : productRow;
      return Promise.resolve({ data, error: null });
    },
  };
  return b;
}

vi.mock("~/lib/supabase.server", () => ({ getSupabase: () => ({ from: (t: string) => builder(t) }) }));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import { resolveHandleRedirect } from "../handle-redirect.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  redirectRow = null;
  productRow = null;
  forcedError = null;
  queries.length = 0;
});

describe("resolveHandleRedirect", () => {
  it("returns null when no redirect row exists (plain 404)", async () => {
    expect(await resolveHandleRedirect(SHOP, "gone-handle")).toBeNull();
  });

  it("returns the target's current handle when the product is still active", async () => {
    redirectRow = { product_id: "p1" };
    productRow = { handle: "new-handle" };
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBe("new-handle");
  });

  it("shop-scopes BOTH lookups (service-role client, no RLS to lean on)", async () => {
    redirectRow = { product_id: "p1" };
    productRow = { handle: "new-handle" };
    await resolveHandleRedirect(SHOP, "old-handle");
    expect(queries).toHaveLength(2);
    for (const q of queries) expect(q.filters.shop_id).toBe(SHOP);
    expect(queries[1].filters.status).toBe("active");
  });

  it("returns null when the target product is no longer active", async () => {
    redirectRow = { product_id: "p1" };
    productRow = null; // status filter excluded it
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBeNull();
  });

  it("never redirects a handle to itself (loop guard on a stale row)", async () => {
    redirectRow = { product_id: "p1" };
    productRow = { handle: "old-handle" };
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBeNull();
  });

  it("skips the DB for non-uuid (demo) shops and empty handles", async () => {
    expect(await resolveHandleRedirect("demo-shop", "old-handle")).toBeNull();
    expect(await resolveHandleRedirect(SHOP, "")).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it("surfaces a supabase error instead of swallowing it", async () => {
    forcedError = { message: "boom" };
    await expect(resolveHandleRedirect(SHOP, "old-handle")).rejects.toMatchObject({ message: "boom" });
  });
});
