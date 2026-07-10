// resolveHandleRedirect: shop-scoped miss-path lookup behind the PDP 301, one
// round-trip (redirect row + embedded target product over the product_id FK).
// Must resolve only to an ACTIVE target's current handle, never to itself
// (loop guard), and skip the DB entirely for non-uuid (demo/fixture) shops.
import { describe, it, expect, vi, beforeEach } from "vitest";

type Row = Record<string, unknown>;
let redirectRow: Row | null = null;
let listRows: Row[] = [];
let forcedError: { message: string } | null = null;
const queries: Array<{
  table: string;
  columns: string;
  filters: Record<string, unknown>;
}> = [];

function builder(table: string) {
  let columns = "";
  const filters: Record<string, unknown> = {};
  const b: Record<string, unknown> = {
    select(cols: string) {
      columns = cols;
      return b;
    },
    eq(col: string, val: unknown) {
      filters[col] = val;
      return b;
    },
    maybeSingle() {
      queries.push({ table, columns, filters });
      if (forcedError)
        return Promise.resolve({ data: null, error: forcedError });
      return Promise.resolve({ data: redirectRow, error: null });
    },
    then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) {
      queries.push({ table, columns, filters });
      if (forcedError)
        return Promise.resolve({ data: null, error: forcedError }).then(
          res,
          rej,
        );
      return Promise.resolve({ data: listRows, error: null }).then(res, rej);
    },
  };
  return b;
}

vi.mock("~/lib/supabase.server", () => ({
  getSupabase: () => ({ from: (t: string) => builder(t) }),
}));

// eslint-disable-next-line import/first -- imports must follow vi.mock
import {
  resolveHandleRedirect,
  listRedirectOldHandles,
} from "../handle-redirect.server";

const SHOP = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  redirectRow = null;
  listRows = [];
  forcedError = null;
  queries.length = 0;
});

describe("resolveHandleRedirect", () => {
  it("returns null when no redirect row (or no active target) matches — plain 404", async () => {
    expect(await resolveHandleRedirect(SHOP, "gone-handle")).toBeNull();
  });

  it("returns the target's current handle when the product is still active", async () => {
    redirectRow = {
      old_handle: "old-handle",
      product_dim: { handle: "new-handle" },
    };
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBe("new-handle");
  });

  it("tolerates an array-shaped embed", async () => {
    redirectRow = {
      old_handle: "old-handle",
      product_dim: [{ handle: "new-handle" }],
    };
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBe("new-handle");
  });

  it("is a single shop-scoped round-trip filtering the embedded target on active", async () => {
    redirectRow = {
      old_handle: "old-handle",
      product_dim: { handle: "new-handle" },
    };
    await resolveHandleRedirect(SHOP, "old-handle");
    expect(queries).toHaveLength(1);
    expect(queries[0].table).toBe("product_handle_redirect");
    expect(queries[0].columns).toContain("product_dim!inner");
    expect(queries[0].filters).toMatchObject({
      shop_id: SHOP,
      old_handle: "old-handle",
      "product_dim.status": "active",
    });
  });

  it("never redirects a handle to itself (loop guard on a stale row)", async () => {
    redirectRow = {
      old_handle: "old-handle",
      product_dim: { handle: "old-handle" },
    };
    expect(await resolveHandleRedirect(SHOP, "old-handle")).toBeNull();
  });

  it("skips the DB for non-uuid (demo) shops and empty handles", async () => {
    expect(await resolveHandleRedirect("demo-shop", "old-handle")).toBeNull();
    expect(await resolveHandleRedirect(SHOP, "")).toBeNull();
    expect(queries).toHaveLength(0);
  });

  it("surfaces a supabase error instead of swallowing it", async () => {
    forcedError = { message: "boom" };
    await expect(
      resolveHandleRedirect(SHOP, "old-handle"),
    ).rejects.toMatchObject({ message: "boom" });
  });
});

describe("listRedirectOldHandles", () => {
  it("returns the shop's recorded old handles", async () => {
    listRows = [{ old_handle: "a-old" }, { old_handle: "b-old" }];
    expect(await listRedirectOldHandles(SHOP)).toEqual(["a-old", "b-old"]);
    expect(queries).toHaveLength(1);
    expect(queries[0].filters).toMatchObject({ shop_id: SHOP });
  });

  it("skips the DB for non-uuid shops", async () => {
    expect(await listRedirectOldHandles("demo-shop")).toEqual([]);
    expect(queries).toHaveLength(0);
  });

  it("fails soft with a server log when the redirect table cannot be read", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    forcedError = { message: "boom" };
    expect(await listRedirectOldHandles(SHOP)).toEqual([]);
    expect(log).toHaveBeenCalledWith(
      "[storegen] product handle redirect listing failed",
      forcedError,
    );
    log.mockRestore();
  });
});
